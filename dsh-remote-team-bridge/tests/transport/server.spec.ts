import { describe, expect, it, afterEach } from 'vitest'
import {
  startBridgeServer,
  bridgeRequest,
  type BridgeServerHandle,
} from '../../src/transport/server.ts'
import { createSelfSignedIdentity } from '../../src/transport/tls.ts'

describe('bridge server and handshake rate limiting', () => {
  let server: BridgeServerHandle | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('holds the first handshake until the receiver confirms', async () => {
    const identity = await createSelfSignedIdentity('localhost')
    server = await startBridgeServer({
      port: 0,
      pairing: '839201',
      identity,
      delayMs: 10, // speed up in tests
      clock: () => 1_000,
    })

    const first = await bridgeRequest(server.url, {
      op: 'pair',
      code: '839201',
      hostId: 'host-a',
    })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ state: 'pending-confirmation', hostId: 'host-a' })

    const requestId = (first.body as any).requestId
    expect(requestId).toBeTruthy()

    const accepted = await server.confirmPairing(requestId, true)
    expect(accepted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(accepted.serverFp).toBe(identity.fingerprintSha256)

    // Code is now destroyed / invalid
    const second = await bridgeRequest(server.url, {
      op: 'pair',
      code: '839201',
      hostId: 'host-a',
    })
    expect(second.status).toBe(401)
    expect(second.body).toEqual({ error: 'unauthorized' })
  })

  it('rejects wrong code with unauthorized without leaking code', async () => {
    const identity = await createSelfSignedIdentity('localhost')
    server = await startBridgeServer({
      port: 0,
      pairing: '839201',
      identity,
      delayMs: 10,
      clock: () => 1_000,
    })

    const res = await bridgeRequest(server.url, {
      op: 'pair',
      code: '000000',
      hostId: 'host-a',
    })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(JSON.stringify(res.body)).not.toContain('839201')
  })

  it('blocks pairing attempts after 5 consecutive failures for 15 minutes', async () => {
    let currentTime = 1_000
    const identity = await createSelfSignedIdentity('localhost')
    server = await startBridgeServer({
      port: 0,
      pairing: '839201',
      identity,
      delayMs: 5,
      clock: () => currentTime,
    })

    for (let i = 0; i < 4; i++) {
      const res = await bridgeRequest(server.url, {
        op: 'pair',
        code: '111111',
        hostId: 'host-bad',
      })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }

    // 5th failure triggers block
    const fifth = await bridgeRequest(server.url, {
      op: 'pair',
      code: '111111',
      hostId: 'host-bad',
    })
    expect(fifth.status).toBe(403)
    expect(fifth.body).toEqual({ error: 'pairing-blocked' })

    // Even with the correct code, it remains blocked
    const blocked = await bridgeRequest(server.url, {
      op: 'pair',
      code: '839201',
      hostId: 'host-bad',
    })
    expect(blocked.status).toBe(403)
    expect(blocked.body).toEqual({ error: 'pairing-blocked' })
  })

  it('allows authenticated requests with token and rejects revoked token', async () => {
    const identity = await createSelfSignedIdentity('localhost')
    server = await startBridgeServer({
      port: 0,
      pairing: '839201',
      identity,
      delayMs: 5,
      clock: () => 1_000,
    })

    const pairRes = await bridgeRequest(server.url, {
      op: 'pair',
      code: '839201',
      hostId: 'host-a',
    })
    const requestId = (pairRes.body as any).requestId
    const { token } = await server.confirmPairing(requestId, true)

    // Authenticated request
    const authRes = await bridgeRequest(server.url, { op: 'ping' }, token)
    expect(authRes.status).toBe(200)
    expect(authRes.body).toMatchObject({ ok: true })

    // Revoke token
    server.revokeToken(token)

    const revokedRes = await bridgeRequest(server.url, { op: 'ping' }, token)
    expect(revokedRes.status).toBe(401)
    expect(revokedRes.body).toEqual({ error: 'unauthorized' })
  })
})
