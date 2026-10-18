import { describe, expect, it } from 'vitest'
import { createPairingCode, verifyPairingCode } from '../../src/protocol/codes.ts'

describe('pairing code', () => {
  it('generates exactly six digits, including leading zeros', () => {
    const random = (size: number): Uint8Array => {
      expect(size).toBe(6)
      return Uint8Array.from([0, 0, 0, 0, 1, 5])
    }
    expect(createPairingCode(random)).toBe('000015')
  })

  it('rejects wrong text and wrong-length input in constant time', () => {
    const record = { code: '839201', expiresAt: 1_000, failures: 0, blockedUntil: 0 }
    expect(verifyPairingCode(record, '839201', 999).ok).toBe(true)
    expect(verifyPairingCode(record, '839202', 999).ok).toBe(false)
    expect(verifyPairingCode(record, '83920', 999).ok).toBe(false)
    expect(verifyPairingCode(record, '839201', 1_000).ok).toBe(false)
  })

  it('blocks after five consecutive failures for fifteen minutes', () => {
    const record = { code: '839201', expiresAt: 10_000, failures: 0, blockedUntil: 0 }
    for (let i = 0; i < 4; i += 1) expect(verifyPairingCode(record, '000000', 1).blockedUntil).toBe(0)
    const blocked = verifyPairingCode(record, '000000', 1)
    expect(blocked.blockedUntil).toBe(1 + 15 * 60_000)
    expect(verifyPairingCode(record, '839201', 2).ok).toBe(false)
  })
})
