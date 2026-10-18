import { describe, expect, it } from 'vitest'
import { bridgeTeamName, withinQuota, isSafeRelativePath } from '../../src/protocol/slug.ts'

describe('team naming and paths', () => {
  it('sanitizes hostile input and adds a random suffix', () => {
    const name = bridgeTeamName('../../Host A', 'task/../x', () => Uint8Array.from([0x7f, 0x2a]))
    expect(name).toBe('bridge-host-a-task-x-7f2a')
    expect(name.length).toBeLessThanOrEqual(32)
  })

  it('truncates cleanly within 32 chars when input is very long', () => {
    const longHost = 'a'.repeat(50)
    const longTask = 'b'.repeat(50)
    const name = bridgeTeamName(longHost, longTask, () => Uint8Array.from([0xab, 0xcd]))
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name.endsWith('-abcd')).toBe(true)
    expect(name.startsWith('bridge-')).toBe(true)
  })

  it('rejects a sixth concurrent bridge team', () => {
    expect(withinQuota(4, 5)).toBe(true)
    expect(withinQuota(5, 5)).toBe(false)
  })

  it('rejects escaping artifact paths', () => {
    expect(isSafeRelativePath('dist/app.exe')).toBe(true)
    expect(isSafeRelativePath('../secret')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\Windows\\x')).toBe(false)
  })
})
