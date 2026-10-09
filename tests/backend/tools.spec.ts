import { describe, expect, it } from 'vitest'
import { apply as officialTools } from '@deepseek-ai/dsh-experimental-tool-agent-team'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SettingsDomain, type TeamSettingsRecord } from '../../src/domain.ts'
import { ModelRouting } from '../../src/model-routing.ts'
import { ModelTools, shortSystemPrompt } from '../../src/tools.ts'
import { backendFixture, deferred } from '../support/backend-fixtures.ts'

function fixture() {
  const f = backendFixture(); const lead = f.agent('lead'); const child = f.agent('child', lead.live)
  const rootEvents = new Map<string, Array<(...args: any[]) => any>>()
  const allTools = new Map<string, Map<string, ToolDefinition>>()
  const prompts = new Map<string, string[]>()
  Object.assign(f.ctx, {
    on: (name: string, callback: (...args: any[]) => any) => {
      const callbacks = rootEvents.get(name) ?? []; callbacks.push(callback); rootEvents.set(name, callbacks)
      return () => { callbacks.splice(callbacks.indexOf(callback), 1) }
    },
    effect: (factory: () => unknown) => factory(),
  })
  const prepare = (candidate: typeof lead) => {
    const tools = new Map<string, ToolDefinition>(); const text: string[] = []
    allTools.set(candidate.live.id, tools); prompts.set(candidate.live.id, text)
    Object.assign(candidate.live.ctx, {
      tools: { register: (definition: ToolDefinition) => { if (tools.has(definition.name)) throw new Error('duplicate tool'); tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
      systemPrompt: { getSectionOrder: () => 0, section: (section: { text: string }) => { text.push(section.text); return () => { text.splice(text.indexOf(section.text), 1) } } },
    })
  }
  prepare(lead); prepare(child)
  const rows = new Map<string, TeamSettingsRecord>(); const domain = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { rows.set(id, value) } })
  const routing = new ModelRouting(f.ctx, domain)
  return { ...f, lead, child, prepare, allTools, prompts, rootEvents, domain, routing }
}

describe('纯新增 tools + 公开 around-dispatch', () => {
  it('真实原版 official tool definitions/schema/execute 完全不变，只新增 Lead scope 工具和自己的短提示', async () => {
    const f = fixture(); officialTools(f.ctx)
    const original = new Map(f.allTools.get('lead'))
    const serialized = [...original.values()].map(tool => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    const addon = new ModelTools(f.ctx, f.routing, { freshProvider: 'spawn', forkProvider: 'fork' })
    addon.install(f.lead.live); addon.install(f.lead.live); addon.install(f.child.live)
    const tools = f.allTools.get('lead')!
    expect(tools.size).toBe(original.size + 2)
    for (const [name, value] of original) expect(tools.get(name)).toBe(value)
    expect([...original.values()].map(tool => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))).toEqual(serialized)
    expect(f.allTools.get('child')!.has('spawn_teammate_with_model')).toBe(false)
    expect(f.prompts.get('lead')).toContain(shortSystemPrompt)
    expect(f.prompts.get('child')).not.toContain(shortSystemPrompt)
    addon.dispose()
    expect(f.allTools.get('lead')!.size).toBe(original.size)
    await f.routing.dispose()
  })

  it('official tools/execute span freeze default，调用 next 不改变 exec identity/arguments/signal', async () => {
    const f = fixture(); officialTools(f.ctx)
    const addon = new ModelTools(f.ctx, f.routing, { freshProvider: 'spawn', forkProvider: 'fork' }); addon.install(f.lead.live)
    await f.domain.transform('lead', old => ({ ...old, defaultModel: { provider: 'p', model: 'old' } }))
    const gate = deferred(); let created!: ReturnType<typeof f.agent>
    Object.assign(f.ctx.agentTeams, { spawnTeammate: async (_caller: unknown, request: any) => {
      expect(request.signal).toBe(exec.signal)
      const event = f.lead.event('team/member', { version: 2, teamId: 'lead', member: { id: 'created', name: 'worker2', phase: 'provisioning' } })
      f.routing.observe(f.lead.live.session, event)
      created = f.agent('created', f.lead.live, 'worker2'); f.prepare(created)
      await f.routing.attach(created.live)
      return { member: { id: 'created', name: 'worker2', role: 'teammate', status: 'inactive', diagnostics: [], provider: 'spawn', context: 'fresh' } }
    } })
    const args = Object.freeze({ name: 'worker2', description: 'job', prompt: 'task' })
    const exec = Object.freeze({ name: 'spawn_teammate', arguments: args, agent: f.lead.live, signal: new AbortController().signal })
    const middleware = f.rootEvents.get('tools/execute')![0]!
    const official = f.allTools.get('lead')!.get('spawn_teammate')!
    const call = middleware(exec, async () => { await gate.promise; return official.execute(exec.arguments, exec as never) })
    await f.domain.transform('lead', old => ({ ...old, defaultModel: { provider: 'q', model: 'new' } }))
    gate.resolve(); await call
    expect(exec.arguments).toBe(args)
    expect(exec.name).toBe('spawn_teammate')
    expect((await f.assemble(created.live)).config).toEqual({ provider: 'p', model: 'old' })
    addon.dispose(); await f.routing.dispose()
  })

  it('独立工具显式 model 胜过 default；fresh/fork transport 使用各自 Config，不把 LLM provider 当 transport', async () => {
    const f = fixture(); const addon = new ModelTools(f.ctx, f.routing, { freshProvider: 'custom-spawn', forkProvider: 'custom-fork' }); addon.install(f.lead.live)
    await f.domain.transform('lead', old => ({ ...old, defaultModel: { provider: 'default-llm', model: 'default' } }))
    const requests: any[] = []
    Object.assign(f.ctx.agentTeams, { spawnTeammate: async (_caller: unknown, request: any) => {
      requests.push(request)
      const id = `child-${requests.length}`
      f.routing.observe(f.lead.live.session, f.lead.event('team/member', { version: 2, teamId: 'lead', member: { id, name: request.name, phase: 'provisioning' } }))
      const child = f.agent(id, f.lead.live, request.name); f.prepare(child); await f.routing.attach(child.live)
      return { member: { id, name: request.name, status: 'inactive' } }
    } })
    for (const [index, name] of ['spawn_teammate_with_model', 'fork_teammate_with_model'].entries()) {
      const tool = f.allTools.get('lead')!.get(name)!
      await tool.execute({ name: `worker-${index}`, description: 'job', prompt: 'task', model: { provider: 'llm-provider', model: 'explicit' } }, { agent: f.lead.live, signal: new AbortController().signal } as never)
    }
    expect(requests.map(request => [request.context, request.provider])).toEqual([['fresh', 'custom-spawn'], ['fork', 'custom-fork']])
    expect(f.domain.read('lead').initials['child-1']).toEqual({ provider: 'llm-provider', model: 'explicit' })
    expect(f.domain.read('lead').initials['child-2']).toEqual({ provider: 'llm-provider', model: 'explicit' })
    addon.dispose(); await f.routing.dispose()
  })
})
