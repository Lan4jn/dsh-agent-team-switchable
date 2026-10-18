import * as https from 'node:https'
import * as http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { TlsIdentity } from './tls.ts'
import { verifyPairingCode, type PairingCodeRecord } from '../protocol/codes.ts'

export interface BridgeServerOptions {
  port?: number
  host?: string
  pairing?: string
  identity: TlsIdentity
  delayMs?: number
  clock?: () => number
}

export interface BridgeServerHandle {
  readonly url: string
  readonly port: number
  confirmPairing(
    requestId: string,
    accept: boolean,
  ): Promise<{ token: string; serverFp: string }>
  revokeToken(token: string): void
  revokeTokenHash(tokenHash: string): void
  close(): Promise<void>
}

interface PendingConfirmation {
  requestId: string
  hostId: string
  createdAt: number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export async function startBridgeServer(
  options: BridgeServerOptions,
): Promise<BridgeServerHandle> {
  const clock = options.clock ?? (() => Date.now())
  const delayMs = options.delayMs ?? 1_000
  const host = options.host ?? '::'

  const pairingRecord: PairingCodeRecord = {
    code: options.pairing ?? '000000',
    expiresAt: clock() + 10 * 60_000,
    failures: 0,
    blockedUntil: 0,
  }

  const ipFailureRecords = new Map<string, PairingCodeRecord>()
  const pendingRequests = new Map<string, PendingConfirmation>()
  const activeTokenHashes = new Set<string>()

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  const server = https.createServer(
    {
      cert: options.identity.cert,
      key: options.identity.key,
    },
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Only handle /bridge endpoint
      const url = new URL(req.url ?? '/', 'https://localhost')
      if (url.pathname !== '/bridge') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not-found' }))
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method-not-allowed' }))
        return
      }

      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        let payload: any
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          payload = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid-json' }))
          return
        }

        const clientIp = req.socket.remoteAddress || 'unknown'

        if (payload?.op === 'pair') {
          // Pairing operation with mandatory delay
          if (delayMs > 0) {
            await sleep(delayMs)
          }

          const now = clock()
          let ipRecord = ipFailureRecords.get(clientIp)
          if (!ipRecord) {
            ipRecord = {
              code: pairingRecord.code,
              expiresAt: pairingRecord.expiresAt,
              failures: 0,
              blockedUntil: 0,
            }
            ipFailureRecords.set(clientIp, ipRecord)
          }

          // Use the more restrictive block between global pairing code and IP-based record
          if (ipRecord.blockedUntil > now || pairingRecord.blockedUntil > now) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'pairing-blocked' }))
            return
          }

          const verdict = verifyPairingCode(pairingRecord, String(payload.code ?? ''), now)
          if (!verdict.ok) {
            ipRecord.failures += 1
            if (ipRecord.failures >= 5 || verdict.blockedUntil > 0) {
              const blockedUntil = Math.max(ipRecord.blockedUntil, verdict.blockedUntil, now + 15 * 60_000)
              ipRecord.blockedUntil = blockedUntil
              pairingRecord.blockedUntil = blockedUntil
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'pairing-blocked' }))
              return
            }
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'unauthorized' }))
            return
          }

          // Success: reset failures and create pending confirmation
          ipRecord.failures = 0
          const requestId = randomUUID()
          pendingRequests.set(requestId, {
            requestId,
            hostId: String(payload.hostId ?? 'unknown'),
            createdAt: now,
          })

          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              state: 'pending-confirmation',
              requestId,
              hostId: payload.hostId,
            }),
          )
          return
        }

        // Token authenticated operations
        const authHeader = req.headers.authorization
        if (!authHeader?.startsWith('Bearer ')) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        const token = authHeader.slice(7)
        const tokenHash = sha256Hex(token)
        if (!activeTokenHashes.has(tokenHash)) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        // Authenticated request handler
        if (payload?.op === 'ping') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, now: clock() }))
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, op: payload?.op }))
      })
    },
  )

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    try {
      server.listen(
        {
          host,
          port: options.port ?? 0,
          ipv6Only: false,
        },
        () => resolve(),
      )
    } catch {
      server.listen(options.port ?? 0, () => resolve())
    }
  })

  const addr = server.address()
  let assignedPort = 0
  if (typeof addr === 'object' && addr !== null) {
    assignedPort = addr.port
  }

  const url = `https://localhost:${assignedPort}`

  return {
    url,
    port: assignedPort,
    async confirmPairing(
      requestId: string,
      accept: boolean,
    ): Promise<{ token: string; serverFp: string }> {
      const pending = pendingRequests.get(requestId)
      if (!pending) {
        throw new Error(`No pending confirmation found for requestId: ${requestId}`)
      }
      pendingRequests.delete(requestId)
      if (!accept) {
        throw new Error('Pairing rejected by receiver')
      }

      // Generate 32 bytes base64url token (43 characters)
      const token = randomBytes(32).toString('base64url')
      activeTokenHashes.add(sha256Hex(token))

      // Immediately invalidate pairing code
      pairingRecord.expiresAt = 0

      return {
        token,
        serverFp: options.identity.fingerprintSha256,
      }
    },
    revokeToken(token: string): void {
      activeTokenHashes.delete(sha256Hex(token))
    },
    revokeTokenHash(tokenHash: string): void {
      activeTokenHashes.delete(tokenHash)
    },
    async close(): Promise<void> {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    },
  }
}

export async function bridgeRequest(
  baseUrl: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL('/bridge', baseUrl)
    const data = Buffer.from(JSON.stringify(body), 'utf8')

    const req = https.request(
      parsedUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(data.length),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        rejectUnauthorized: false, // In test environments self-signed cert is used
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            parsed = null
          }
          resolve({
            status: res.statusCode ?? 500,
            body: parsed,
          })
        })
      },
    )

    req.once('error', reject)
    req.write(data)
    req.end()
  })
}
