import { timingSafeEqual } from 'node:crypto'
import type { CodeRandom, PairingCodeRecord, PairingVerdict } from './types.ts'

export type { CodeRandom, PairingCodeRecord, PairingVerdict }

export function createPairingCode(random: CodeRandom): string {
  return Array.from(random(6), value => String(value % 10)).join('')
}

export function verifyPairingCode(
  record: PairingCodeRecord,
  input: string,
  now: number,
): PairingVerdict {
  if (record.blockedUntil > now) return { ok: false, blockedUntil: record.blockedUntil }
  const expected = Buffer.from(record.code, 'utf8')
  const actual = Buffer.from(input, 'utf8')
  const sameLength = expected.length === actual.length
  const same = sameLength ? timingSafeEqual(expected, actual) : (timingSafeEqual(expected, expected), false)

  if (same && now < record.expiresAt) {
    record.failures = 0
    return { ok: true, blockedUntil: 0 }
  }
  record.failures += 1
  record.blockedUntil = record.failures >= 5 ? now + 15 * 60_000 : 0
  return { ok: false, blockedUntil: record.blockedUntil }
}
