import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SettingsDomain, type TeamSettingsRecord } from '../../src/domain.ts'
import { TeamModelSettingsService } from '../../src/service.ts'
import { backendFixture, deferred } from '../support/backend-fixtures.ts'

async function fixture() {
  const f = backendFixture(); const lead = f.agent('lead'); const child = f.agent('child', lead.live)
  child.event('turn/start', { turn: 3 }); child.request({ provider: 'p', model: 'old' })
  const rows = new Map<string, TeamSettingsRecord>()
  const put = vi.fn(async (id: string, value: TeamSettingsRecord) => { rows.set(id, value) })
  const domain = new SettingsDomain({ get: id => rows.get(id), put })
  const ctx = new Context()
  ctx.provide('agents', f.ctx.agents)
  ctx.provide('agentTeams', f.ctx.agentTeams)
  ctx.provide('llm', f.ctx.llm)
  const resolveAgent = vi.fn(async (id: string) => ({ agent: f.registry.get(id)! }))
  ctx.provide('sessionController', { resolveAgent } as never)
  const service = new TeamModelSettingsService(ctx, { domain })
  return { f, ctx, lead, child, service, domain, resolveAgent, rows, put }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const staleLeadModes = ['removed', 'replaced', 'missing-membership', 'teammate-role', 'different-root', 'different-team'] as const

function invalidateLead(f: Fixture, mode: typeof staleLeadModes[number]): void {
  if (mode === 'removed') f.f.registry.delete('lead')
  else if (mode === 'replaced') f.f.agent('lead')
  else if (mode === 'missing-membership') f.f.roles.delete(f.lead.live)
  else {
    const membership = f.f.roles.get(f.lead.live)!
    f.f.roles.set(f.lead.live, { ...membership,
      ...mode === 'teammate-role' ? { role: 'teammate' as const } : {},
      ...mode === 'different-root' ? { root: f.child.live } : {},
      ...mode === 'different-team' ? { id: 'other-team' } : {},
    })
  }
}

function select(f: Fixture, kind: 'default' | 'member' | 'clear') {
  const selection = { provider: 'q', model: 'next' }
  return kind === 'member'
    ? f.service.selectMemberModel({ leadSessionId: f.lead.live.id, target: 'worker', selection })
    : f.service.selectTeamDefaultModel({ leadSessionId: f.lead.live.id, selection: kind === 'clear' ? null : selection })
}

describe.each(['default', 'member'] as const)('%s 提交时的 Lead 生命周期', kind => {
  it.each(staleLeadModes)('模型异步验证中 Lead %s，拒绝且不写入', async mode => {
    const f = await fixture(); const entered = deferred(); const release = deferred()
    vi.spyOn(f.f.ctx.llm, 'resolveCallConfig').mockImplementation(async config => {
      entered.resolve(); await release.promise; return config
    })
    const before = f.domain.read('lead')
    const pending = select(f, kind)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'team-model-settings/lead-required' })
    await entered.promise
    invalidateLead(f, mode)
    release.resolve(); await rejection
    expect(f.put).not.toHaveBeenCalled()
    expect(f.rows.has('lead')).toBe(false)
    expect(f.domain.read('lead')).toBe(before)
  })
})

describe.each(['default', 'member', 'clear'] as const)('%s 排队后的 Lead 生命周期', kind => {
  it.each(staleLeadModes)('已入队等待持久化时 Lead %s，仅前序写入提交', async mode => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); const enqueued = deferred()
    const accepted = { ...f.domain.read('lead'), revision: 1, defaultModel: { provider: 'p', model: 'a' } }
    f.put.mockImplementationOnce(async (id, value) => {
      entered.resolve(); await release.promise; f.rows.set(id, value)
    })
    const first = f.domain.transform('lead', () => accepted)
    await entered.promise
    const transform = f.domain.transform.bind(f.domain)
    vi.spyOn(f.domain, 'transform').mockImplementation((id, change) => {
      const operation = transform(id, change)
      enqueued.resolve(); return operation
    })
    const pending = select(f, kind)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'team-model-settings/lead-required' })
    await enqueued.promise
    expect(f.put).toHaveBeenCalledTimes(1)
    invalidateLead(f, mode)
    release.resolve(); await first; await rejection
    expect(f.put).toHaveBeenCalledTimes(1)
    expect(f.rows.get('lead')).toEqual(accepted)
    expect(f.domain.read('lead')).toEqual(accepted)
  })
})

describe('真正 Typert Remote RPC', () => {
  it('真实 key/namespace 与共享 view；每次都走 resolveAgent，即使 live 已缓存', async () => {
    const f = await fixture()
    expect(f.service.typertRemote.serviceKey).toBe('teamModelSettings')
    expect(f.service.typertRemote.namespace).toBe('team-model-settings')
    const view = await f.service.getSettings({ leadSessionId: f.lead.live.id })
    expect(f.resolveAgent).toHaveBeenCalledWith('lead')
    expect(view.members).toHaveLength(1)
    expect(view.members[0]).toMatchObject({ id: 'child', name: 'worker', phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' } })
    expect(Object.isFrozen(view.members[0])).toBe(true)
    await f.service.getSettings({ leadSessionId: f.lead.live.id })
    expect(f.resolveAgent).toHaveBeenCalledTimes(2)
  })

  it('权限拒绝不能通过 live registry 绕过，teammate 不能冒充 Lead', async () => {
    const f = await fixture(); const denied = new Error('access denied')
    f.resolveAgent.mockResolvedValueOnce({ error: denied } as never)
    await expect(f.service.getSettings({ leadSessionId: f.lead.live.id })).rejects.toBe(denied)
    await expect(f.service.getSettings({ leadSessionId: f.child.live.id })).rejects.toThrow('Team Lead')
  })

  it('resolveAgent 返回被替换旧 Agent 时拒绝，不绕回新 registry 身份', async () => {
    const f = await fixture()
    f.resolveAgent.mockImplementationOnce(async () => {
      f.f.agent('lead')
      return { agent: f.lead.live }
    })
    await expect(f.service.getSettings({ leadSessionId: f.lead.live.id })).rejects.toMatchObject({ code: 'team-model-settings/lead-required' })
    expect(f.put).not.toHaveBeenCalled()
  })

  it('授权通过后 await 的微任务间隙 Lead 被替换，get 不返回成功 view', async () => {
    const f = await fixture()
    const tryMembership = f.f.ctx.agentTeams.tryMembership.bind(f.f.ctx.agentTeams)
    vi.spyOn(f.f.ctx.agentTeams, 'tryMembership').mockImplementationOnce(agent => {
      const membership = tryMembership(agent)
      queueMicrotask(() => f.f.agent('lead'))
      return membership
    })
    await expect(f.service.getSettings({ leadSessionId: f.lead.live.id })).rejects.toMatchObject({ code: 'team-model-settings/lead-required' })
  })

  it.each(['default', 'member'] as const)('%s put 已开始后 Lead 失效，保留确认写入但拒绝成功 view', async kind => {
    const f = await fixture(); const entered = deferred(); const release = deferred()
    f.put.mockImplementationOnce(async (id, value) => {
      entered.resolve(); await release.promise; f.rows.set(id, value)
    })
    const pending = select(f, kind)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'team-model-settings/lead-required' })
    await entered.promise
    invalidateLead(f, 'replaced')
    release.resolve(); await rejection
    expect(f.put).toHaveBeenCalledTimes(1)
    expect(f.domain.read('lead').revision).toBe(1)
    expect(f.domain.read('lead')).toEqual(f.rows.get('lead'))
    expect(kind === 'default' ? f.domain.read('lead').defaultModel : f.domain.read('lead').choices.child.selection).toEqual({ provider: 'q', model: 'next' })
  })

  it('选择只写 choices UUID 与最后 own turn，返回 view 不使用官方 options.model', async () => {
    const f = await fixture()
    const view = await f.service.selectMemberModel({ leadSessionId: f.lead.live.id, target: 'worker', selection: { provider: 'q', model: 'next' } })
    expect(f.domain.read('lead').choices).toEqual({ child: { selection: { provider: 'q', model: 'next' }, effectiveAfterTurn: 3 } })
    expect(view.members[0].currentModel?.model).toBe('old')
    expect(view.members[0].nextModel?.model).toBe('next')
    await expect(f.service.selectMemberModel({ leadSessionId: f.lead.live.id, target: 'lead', selection: { provider: 'p', model: 'x' } })).rejects.toThrow('Lead')
    const cleared = await f.service.selectTeamDefaultModel({ leadSessionId: f.lead.live.id, selection: null })
    expect(cleared.defaultModel).toBeNull()
  })

  it('cold provider-owned 成员只存 UUID 下次激活选择，不调用 child resolveAgent', async () => {
    const f = await fixture()
    f.f.registry.delete('child')
    const view = await f.service.selectMemberModel({ leadSessionId: f.lead.live.id, target: 'worker', selection: { provider: 'q', model: 'next' } })
    expect(f.resolveAgent.mock.calls.map(call => call[0])).toEqual(['lead'])
    expect(f.domain.read('lead').choices.child).toEqual({ selection: { provider: 'q', model: 'next' }, effectiveAfterTurn: 0 })
    expect(view.members[0].nextModel?.model).toBe('next')
    expect(view.members[0].currentModel).toBeUndefined()
  })

  it('default durable 未成功不 publish view；失败后 get/edit 全 fail closed', async () => {
    const f = await fixture(); const gate = deferred(); const failure = new Error('durable failure')
    const domain = new SettingsDomain({ get: () => undefined, put: async () => { await gate.promise; throw failure } })
    const ctx = new Context(); ctx.provide('agents', f.ctx.agents); ctx.provide('agentTeams', f.ctx.agentTeams); ctx.provide('llm', f.ctx.llm); ctx.provide('sessionController', { resolveAgent: f.resolveAgent } as never)
    const service = new TeamModelSettingsService(ctx, { domain })
    const write = service.selectTeamDefaultModel({ leadSessionId: f.lead.live.id, selection: { provider: 'p', model: 'a' } })
    await Promise.resolve(); await Promise.resolve()
    expect((await service.getSettings({ leadSessionId: f.lead.live.id })).defaultModel).toBeNull()
    gate.resolve(); await expect(write).rejects.toBe(failure)
    await expect(service.getSettings({ leadSessionId: f.lead.live.id })).rejects.toThrow('unavailable')
    await expect(service.selectTeamDefaultModel({ leadSessionId: f.lead.live.id, selection: null })).rejects.toThrow('unavailable')
  })

  it('同 team v4 get/edit failclosed，不反写历史；inherited 不误判', async () => {
    const f = await fixture(); f.lead.event('team/default-model', { version: 4, teamId: 'lead' })
    const original = [...f.lead.own]
    await expect(f.service.getSettings({ leadSessionId: f.lead.live.id })).rejects.toThrow('fresh Team')
    await expect(f.service.selectTeamDefaultModel({ leadSessionId: f.lead.live.id, selection: null })).rejects.toThrow('fresh Team')
    expect(f.lead.own).toEqual(original)
  })
})
