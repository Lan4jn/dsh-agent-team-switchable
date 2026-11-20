import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamStateStore } from '../lib/team-state.js'

test('TeamStateStore: 团队数据原子落盘与冷恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-team-state-'))
  try {
    const store1 = new TeamStateStore(dir)
    await store1.init()

    // 写入默认模型
    const v1 = await store1.updateTeam('lead-1', (team) => {
      team.defaultModel = { provider: 'p1', model: 'm1' }
      return team
    })
    assert.equal(v1.revision, 1)
    assert.deepEqual(v1.defaultModel, { provider: 'p1', model: 'm1' })

    // 记录成员覆盖
    const v2 = await store1.updateTeam('lead-1', (team) => {
      team.choices['worker-1'] = {
        selection: { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
        effectiveAfterTurn: 2,
      }
      return team
    })
    assert.equal(v2.revision, 2)
    assert.equal(v2.choices['worker-1'].effectiveAfterTurn, 2)

    // 新实例冷载入
    const store2 = new TeamStateStore(dir)
    await store2.init()
    const loaded = store2.getTeam('lead-1')
    assert.equal(loaded.revision, 2)
    assert.deepEqual(loaded.defaultModel, { provider: 'p1', model: 'm1' })
    assert.deepEqual(loaded.choices['worker-1'].selection, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TeamStateStore: 全局文件锁保证跨 team 并发排队写不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-team-cross-'))
  try {
    const store = new TeamStateStore(dir)
    await store.init()

    // 交替并发写两个不同的 team
    const p1 = store.updateTeam('team-A', (team) => {
      team.defaultModel = { provider: 'pA', model: 'mA' }
      return team
    })
    const p2 = store.updateTeam('team-B', (team) => {
      team.defaultModel = { provider: 'pB', model: 'mB' }
      return team
    })
    const p3 = store.updateTeam('team-A', (team) => {
      team.choices['member-1'] = { selection: { provider: 'pA2', model: 'mA2' }, effectiveAfterTurn: 0 }
      return team
    })

    await Promise.all([p1, p2, p3])

    // 验证冷载入时两队均完好无损
    const store2 = new TeamStateStore(dir)
    await store2.init()
    const teamA = store2.getTeam('team-A')
    const teamB = store2.getTeam('team-B')
    assert.equal(teamA.revision, 2)
    assert.equal(teamB.revision, 1)
    assert.deepEqual(teamA.defaultModel, { provider: 'pA', model: 'mA' })
    assert.deepEqual(teamB.defaultModel, { provider: 'pB', model: 'mB' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TeamStateStore: 写入异常时内存回滚且 revision 不递增', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-team-fail-'))
  try {
    const store = new TeamStateStore(dir)
    await store.init()

    await store.updateTeam('lead-1', (team) => {
      team.defaultModel = { provider: 'p1', model: 'm1' }
      return team
    })
    assert.equal(store.getTeam('lead-1').revision, 1)

    // 变异写入使其抛出错误
    await assert.rejects(async () => {
      await store.updateTeam('lead-1', () => {
        throw new Error('mutator failure')
      })
    }, /mutator failure/)

    assert.equal(store.getTeam('lead-1').revision, 1)
    assert.deepEqual(store.getTeam('lead-1').defaultModel, { provider: 'p1', model: 'm1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
