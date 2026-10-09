import { describe, expect, it } from 'vitest'
import { SettingsDomain } from '../../src/domain.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('插件独立持久域', () => {
  it('put 持久化成功以前不发布 default 或 revision', async () => {
    const gate = deferred()
    const rows = new Map()
    const store = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { await gate.promise; rows.set(id, value) } })
    const write = store.transform('team', old => ({ ...old, revision: old.revision + 1, defaultModel: { provider: 'p', model: 'm' } }))
    await Promise.resolve()
    expect(store.read('team').revision).toBe(0)
    expect(store.read('team').defaultModel).toBeNull()
    gate.resolve()
    await write
    expect(store.read('team').revision).toBe(1)
    expect(Object.isFrozen(store.read('team').defaultModel)).toBe(true)
  })

  it('写入结果不确定时 fail closed，既不 rollback 也不继续读写', async () => {
    const rows = new Map()
    const store = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { rows.set(id, value); throw new Error('fsync failed after rename') } })
    await expect(store.transform('team', old => ({ ...old, revision: 1 }))).rejects.toThrow('fsync failed')
    expect(rows.get('team').revision).toBe(1)
    expect(() => store.read('team')).toThrow('unavailable')
    await expect(store.transform('team', old => old)).rejects.toThrow('unavailable')
    const reopened = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { rows.set(id, value) } })
    expect(reopened.read('team').revision).toBe(1)
  })

  it('同 Team transform 串行，多 Team 不互相阻塞', async () => {
    const rows = new Map()
    const gate = deferred()
    const store = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { if (id === 'a') await gate.promise; rows.set(id, value) } })
    const a = store.transform('a', old => ({ ...old, revision: old.revision + 1 }))
    const a2 = store.transform('a', old => ({ ...old, revision: old.revision + 1 }))
    await store.transform('b', old => ({ ...old, revision: 1 }))
    expect(store.read('b').revision).toBe(1)
    gate.resolve()
    await Promise.all([a, a2])
    expect(store.read('a').revision).toBe(2)
  })
})
