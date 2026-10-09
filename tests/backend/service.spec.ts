import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SettingsDomain, type TeamSettingsRecord } from '../../src/domain.ts'
import { TeamModelSettingsService } from '../../src/service.ts'
import { backendFixture, deferred } from '../support/backend-fixtures.ts'

async function fixture() {
  const f = backendFixture(); const lead = f.agent('lead'); const child = f.agent('child', lead.live)
  child.event('turn/start', { turn: 3 }); child.request({ provider: 'p', model: 'old' })
  const rows = new Map<string, TeamSettingsRecord>(); const domain = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { rows.set(id, value) } })
  const ctx = new Context()
  ctx.provide('agents', f.ctx.agents)
  ctx.provide('agentTeams', f.ctx.agentTeams)
  ctx.provide('llm', f.ctx.llm)
  const resolveAgent = vi.fn(async (id: string) => ({ agent: f.registry.get(id)! }))
  ctx.provide('sessionController', { resolveAgent } as never)
  const service = new TeamModelSettingsService(ctx, { domain })
  return { f, ctx, lead, child, service, domain, resolveAgent, rows }
}

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
