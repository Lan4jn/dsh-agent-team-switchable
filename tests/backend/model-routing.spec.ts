import { describe, expect, it } from 'vitest'
import { SettingsDomain, type TeamSettingsRecord } from '../../src/domain.ts'
import { ModelRouting, assertFreshTeam, currentModel, validateSelection } from '../../src/model-routing.ts'
import { backendFixture, deferred } from '../support/backend-fixtures.ts'

const oldRoute = { provider: 'p', model: 'old', reasoningEffort: 'high' }
const routeA = { provider: 'p', model: 'a' }
const routeB = { provider: 'q', model: 'b', reasoningEffort: 'low' }
function store(put?: (id: string, value: TeamSettingsRecord) => Promise<void>) {
  const rows = new Map<string, TeamSettingsRecord>()
  return { rows, domain: new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { await put?.(id, value); rows.set(id, value) } }) }
}
function provisioning(root: ReturnType<ReturnType<typeof backendFixture>['agent']>, id: string, name: string) {
  return root.event('team/member', { version: 2, teamId: root.live.id, member: { id, name, phase: 'provisioning' } })
}

describe('纯增强成员路由', () => {
  it('explicit 优先，首轮 queued input 等待 durable initial，真实 helper request 与 promptvars 一致', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const gate = deferred()
    const s = store(async (_id, value) => { if (Object.hasOwn(value.initials, 'child')) await gate.promise })
    await s.domain.transform('lead', old => ({ ...old, defaultModel: routeB }))
    const routing = new ModelRouting(f.ctx, s.domain)
    let child!: ReturnType<typeof f.agent>
    const creation = routing.creation(lead.live, 'worker', routeA, new AbortController().signal, async () => {
      routing.observe(lead.live.session, provisioning(lead, 'child', 'worker'))
      child = f.agent('child', lead.live)
      await routing.attach(child.live)
    })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(child.listeners.size).toBe(0)
    expect(s.domain.read('lead').initials.child).toBeUndefined()
    gate.resolve()
    await creation
    const first = await f.assemble(child.live)
    expect(first.prompt.variables).toMatchObject(routeA)
    expect(first.config).toEqual(routeA)
    expect(s.domain.read('lead').initials.child).toEqual(routeA)
    await routing.dispose()
  })

  it('冻结 default 跨 await，直接 API 调用只使用 v2 provisioning 时的 committed default', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const s = store(); const routing = new ModelRouting(f.ctx, s.domain)
    await s.domain.transform('lead', old => ({ ...old, defaultModel: routeA }))
    const gate = deferred(); let child!: ReturnType<typeof f.agent>
    const creation = routing.creation(lead.live, 'worker', undefined, new AbortController().signal, async () => {
      await gate.promise
      routing.observe(lead.live.session, provisioning(lead, 'child', 'worker'))
      child = f.agent('child', lead.live); await routing.attach(child.live)
    })
    await s.domain.transform('lead', old => ({ ...old, defaultModel: routeB }))
    gate.resolve(); await creation
    expect((await f.assemble(child.live)).config).toEqual(routeA)
    routing.observe(lead.live.session, provisioning(lead, 'direct', 'direct'))
    await s.domain.transform('lead', old => ({ ...old, defaultModel: null }))
    const direct = f.agent('direct', lead.live, 'direct'); await routing.attach(direct.live)
    expect((await f.assemble(direct.live)).config).toEqual(routeB)
    await routing.dispose()
  })

  it('RPC durable choice 不修改当前整个 turn 的多个 steps，reasoning 省略清除 inherited effort', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const child = f.agent('child', lead.live); const s = store(); const routing = new ModelRouting(f.ctx, s.domain)
    child.request(oldRoute); child.event('turn/start', { turn: 1 })
    await s.domain.transform('lead', old => ({ ...old, initials: { child: oldRoute } }))
    await routing.attach(child.live)
    await s.domain.transform('lead', old => ({ ...old, choices: { child: { selection: routeA, effectiveAfterTurn: 1 } } }))
    expect((await f.assemble(child.live)).config).toEqual(oldRoute)
    expect((await f.assemble(child.live)).config).toEqual(oldRoute)
    routing.observe(child.live.session, child.event('turn/start', { turn: 2 }))
    expect((await f.assemble(child.live)).config).toEqual(routeA)
    expect((await f.assemble(child.live)).config).toEqual(routeA)
    await routing.dispose()
  })

  it('old/new 同名 ALS 请求与多 Team 并发按 UUID 精确隔离', async () => {
    const f = backendFixture(); const a = f.agent('a'); const b = f.agent('b'); const s = store(); const routing = new ModelRouting(f.ctx, s.domain)
    const oldGate = deferred(); const controller = new AbortController()
    const old = routing.creation(a.live, 'worker', routeA, controller.signal, async () => {
      await oldGate.promise
      routing.observe(a.live.session, provisioning(a, 'old-id', 'worker'))
      controller.signal.throwIfAborted()
    })
    await Promise.resolve()
    controller.abort(new Error('cancel old'))
    const create = (root: typeof a, id: string, selected: typeof routeA) => routing.creation(root.live, 'worker', selected, new AbortController().signal, async () => {
      routing.observe(root.live.session, provisioning(root, id, 'worker'))
      const child = f.agent(id, root.live); await routing.attach(child.live); return child
    })
    const [next, other] = await Promise.all([create(a, 'new-id', routeB), create(b, 'b-id', routeA)])
    oldGate.resolve(); await expect(old).rejects.toThrow('cancel old')
    expect((await f.assemble(next.live)).config).toEqual(routeB)
    expect((await f.assemble(other.live)).config).toEqual(routeA)
    expect(s.domain.read('a').initials['new-id']).toEqual(routeB)
    expect(s.domain.read('a').initials['old-id']).toBeUndefined()
    expect(s.domain.read('b').initials['b-id']).toEqual(routeA)
    await routing.dispose()
  })

  it('cold resume 只重装 initial/choice，不误套最新 default；fork inherited prefix 不是真当前', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const s = store()
    await s.domain.transform('lead', old => ({ ...old, defaultModel: routeB, initials: { child: null }, choices: { child: { selection: routeA, effectiveAfterTurn: 1 } } }))
    const child = f.agent('child', lead.live); child.request(oldRoute); child.event('turn/start', { turn: 1 })
    const routing = new ModelRouting(f.ctx, s.domain); await routing.attach(child.live)
    expect((await f.assemble(child.live)).config).toEqual(oldRoute)
    routing.observe(child.live.session, child.event('turn/start', { turn: 2 }))
    expect((await f.assemble(child.live)).config).toEqual(routeA)
    const fork = f.agent('fork', lead.live, 'fork', [{ type: 'request/header', data: {} } as any]); fork.inheritRequest(routeB)
    await routing.attach(fork.live)
    expect(currentModel(fork.live)).toBeUndefined()
    expect((await f.assemble(fork.live)).config).toEqual(fork.live.options)
    expect(s.domain.read('lead').initials.fork).toBeNull()
    await routing.dispose()
  })

  it('Lead/普通 worker/hostfork 零影响，duplicate/dispose 不重复 helper', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const normal = f.agent('normal', lead.live); f.roles.delete(normal.live)
    const fork = f.agent('hostfork'); const child = f.agent('child', lead.live); const s = store(); const routing = new ModelRouting(f.ctx, s.domain)
    await Promise.all([routing.attach(lead.live), routing.attach(normal.live), routing.attach(fork.live), routing.attach(child.live), routing.attach(child.live)])
    expect(lead.listeners.size).toBe(0); expect(normal.listeners.size).toBe(0); expect(fork.listeners.size).toBe(0)
    expect(child.listeners.get('agent/request')).toHaveLength(1)
    await routing.dispose()
    expect(child.listeners.get('agent/request')).toHaveLength(0)
    expect(() => routing.creation(lead.live, 'later', routeA, new AbortController().signal, async () => {})).toThrow('unavailable')
  })

  it('write 失败关闭但已经安装的 current route 不变', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const child = f.agent('child', lead.live); const rows = new Map<string, TeamSettingsRecord>(); let fail = false
    const domain = new SettingsDomain({ get: id => rows.get(id), put: async (id, value) => { rows.set(id, value); if (fail) throw new Error('fsync') } })
    child.request(oldRoute); child.event('turn/start', { turn: 1 })
    await domain.transform('lead', old => ({ ...old, initials: { child: oldRoute } }))
    const routing = new ModelRouting(f.ctx, domain); await routing.attach(child.live)
    fail = true
    await expect(domain.transform('lead', old => ({ ...old, choices: { child: { selection: routeA, effectiveAfterTurn: 1 } } }))).rejects.toThrow('fsync')
    routing.observe(child.live.session, child.event('turn/start', { turn: 2 }))
    expect((await f.assemble(child.live)).config).toEqual(oldRoute)
    await routing.dispose()
  })

  it('same-Team v3/v4 fail closed；不同 Team / inherited records 不误拒绝', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const s = store(); const routing = new ModelRouting(f.ctx, s.domain)
    lead.event('team/member', { version: 3, teamId: 'lead' })
    expect(() => assertFreshTeam(lead.live)).toThrow('fresh Team')
    expect(() => routing.creation(lead.live, 'worker', routeA, new AbortController().signal, async () => {})).toThrow('fresh Team')
    const fork = f.agent('fork', undefined, 'lead', lead.own); fork.event('team/member', { version: 4, teamId: 'lead' })
    expect(() => assertFreshTeam(fork.live)).not.toThrow()
    await routing.dispose()
  })

  it('initial durable failure 或取消时不安装 helper、不发布成功；dispose drain 取消后的 token 资源', async () => {
    for (const mode of ['failure', 'cancel'] as const) {
      const f = backendFixture(); const lead = f.agent('lead'); const gate = deferred(); const controller = new AbortController()
      const s = store(async () => { await gate.promise; if (mode === 'failure') throw new Error('initial fsync failure') })
      const routing = new ModelRouting(f.ctx, s.domain)
      let child!: ReturnType<typeof f.agent>
      const operation = routing.creation(lead.live, 'worker', routeA, controller.signal, async () => {
        routing.observe(lead.live.session, provisioning(lead, 'child', 'worker'))
        child = f.agent('child', lead.live)
        await routing.attach(child.live)
      })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      if (mode === 'cancel') controller.abort(new Error('cancel initialization'))
      gate.resolve()
      await expect(operation).rejects.toThrow(mode === 'failure' ? 'initial fsync failure' : 'cancel initialization')
      expect(child.listeners.size).toBe(0)
      if (mode === 'failure') expect(() => s.domain.read('lead')).toThrow('unavailable')
      await routing.dispose()
    }
  })

  it('cold initial route/null 记录不被最近 default 重新解释', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const s = store()
    await s.domain.transform('lead', old => ({ ...old, defaultModel: routeB, initials: { selected: routeA, inherited: null } }))
    const routing = new ModelRouting(f.ctx, s.domain)
    const selected = f.agent('selected', lead.live, 'selected'); const inherited = f.agent('inherited', lead.live, 'inherited')
    await routing.attach(selected.live); await routing.attach(inherited.live)
    expect((await f.assemble(selected.live)).config).toEqual(routeA)
    expect((await f.assemble(inherited.live)).config).toEqual(inherited.live.options)
    await routing.dispose()
  })

  it('未配置或 initial=null 的恢复成员保持官方继承，不强制上轮请求模型', async () => {
    const f = backendFixture(); const lead = f.agent('lead'); const s = store()
    await s.domain.transform('lead', old => ({ ...old, initials: { inherited: null } }))
    const routing = new ModelRouting(f.ctx, s.domain)
    for (const id of ['unconfigured', 'inherited']) {
      const child = f.agent(id, lead.live, id)
      child.request(oldRoute)
      await routing.attach(child.live)
      expect((await f.assemble(child.live)).config).toEqual(child.live.options)
    }
    await routing.dispose()
  })

  it('宽松 resolveCallConfig 不能让未列出的 provider/model 绕过目录', async () => {
    const f = backendFixture()
    await expect(validateSelection(f.ctx, { provider: 'missing', model: 'a' })).rejects.toThrow('catalog')
    await expect(validateSelection(f.ctx, { provider: 'p', model: 'not-advertised' })).rejects.toThrow('catalog')
    expect(f.validations).toHaveLength(0)
  })

  it('目录读取失败时拒绝，不调用 resolver 或保存路线', async () => {
    const f = backendFixture()
    const failed = new Error('catalog offline')
    f.ctx.llm.listModels = async () => { throw failed }
    await expect(validateSelection(f.ctx, routeA)).rejects.toBe(failed)
    expect(f.validations).toHaveLength(0)
  })

  it('真实 requestHeader adapter-default effort 不伪造为用户设置', () => {
    const f = backendFixture(); const child = f.agent('child')
    child.request(oldRoute, true)
    expect(currentModel(child.live)).toEqual({ provider: 'p', model: 'old' })
  })
})
