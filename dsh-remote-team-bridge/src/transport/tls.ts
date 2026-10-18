import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)

export interface TlsIdentity {
  cert: string
  key: string
  certPath: string
  keyPath: string
  fingerprintSha256: string
}

export function fingerprintOf(pemCertificate: string): string {
  const der = Buffer.from(
    pemCertificate.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64',
  )
  return createHash('sha256').update(der).digest('hex')
}

export async function createSelfSignedIdentity(
  san = 'bridge.local',
  options: { dir?: string } = {},
): Promise<TlsIdentity> {
  const targetDir = options.dir ?? path.join(os.homedir(), '.dsh/storages/remote_team_bridge/tls')
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })

  const keyPath = path.join(targetDir, 'key.pem')
  const certPath = path.join(targetDir, 'cert.pem')

  const isIp = san.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(san)
  const sanEntry = isIp ? `IP:${san}` : `DNS:${san}`
  const sanExt = `subjectAltName=${sanEntry},IP:::1,IP:127.0.0.1,DNS:localhost`

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '3650',
    '-subj',
    `/CN=${san}`,
    '-addext',
    sanExt,
  ]

  try {
    await execFileAsync('openssl', args)
  } catch (err) {
    const error = new Error(`Failed to generate self-signed certificate: ${String(err)}`)
    ;(error as any).code = 'certificate-unavailable'
    throw error
  }

  fs.chmodSync(keyPath, 0o600)
  fs.chmodSync(certPath, 0o644)

  const cert = fs.readFileSync(certPath, 'utf8')
  const key = fs.readFileSync(keyPath, 'utf8')
  const fingerprintSha256 = fingerprintOf(cert)

  return {
    cert,
    key,
    certPath,
    keyPath,
    fingerprintSha256,
  }
}
