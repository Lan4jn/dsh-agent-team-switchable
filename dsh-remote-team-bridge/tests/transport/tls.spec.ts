import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createSelfSignedIdentity, fingerprintOf } from '../../src/transport/tls.ts'

describe('TLS identity and fingerprint', () => {
  it('creates a certificate whose pinned fingerprint verifies', async () => {
    const tmpDir = path.join(os.tmpdir(), `bridge-tls-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      const identity = await createSelfSignedIdentity('bridge.local', { dir: tmpDir })
      expect(identity.cert).toContain('BEGIN CERTIFICATE')
      expect(identity.key).toContain('BEGIN PRIVATE KEY')
      expect(identity.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(fingerprintOf(identity.cert)).toBe(identity.fingerprintSha256)

      // Verify file permissions: 0o600 (only read/write for owner)
      const keyStat = fs.statSync(identity.keyPath)
      expect(keyStat.mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
