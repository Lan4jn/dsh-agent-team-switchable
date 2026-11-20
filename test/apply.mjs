/**
 * 端到端离线验证：用忠实模拟官方调用形状的假 ctx，把整条链路跑通。
 *
 * 为什么需要它：真正的运行时验证必须重启 DSH，而重启会中断会话。这里用一个
 * 「按官方源码形状搭出来的」ctx 覆盖最关键的事实：
 *   1. 组合行不写 config 时 apply 不抛（0.2.1 首版 bug 的回归）；
 *   2. 工具、设置路由、两个包装、两个事件监听器都注册上了；
 *   3. 设置页接口 GET/PUT 真的能读目录、写策略（含 0.2.1 的 /routes 兼容）；
 *   4. 创建期注入真的发生在**两条通道**上（startContinuable 与 start），
 *      fork 默认不纳管、显式优先于规则、未命中规则时用成员表第一个；
 *   5. 运行期回退状态机真的按 magpie 的语义工作：可重试失败换候选（返回 {kind:'retry'}），
 *      请求本身的拒绝（400 等）一律放手，patience 用尽放手，Lead 的请求完全不碰。
 *
 * 它不是运行时替代品（真宿主的行为以重启实测为准），但能把「写完就等着重启踩雷」
 * 变成「重启前先证明机制成立」。
 *
 * 运行：node test/apply.mjs
 * 作者：hwj
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// 必须在 import 之前改：policyPath()/statusPath() 读的是环境变量，但它们是在调用时求值的，
// 所以这里改完再 import 也成立——写成两段只是为了表明意图。
const home = await mkdtemp(join(tmpdir(), 'tmm-test-'))
process.env.DSH_HOME = home

const { apply, identityPrefix } = await import('../lib/index.js')
const { loadUsage } = await import('../lib/usage.js')

let passed = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ok  ${label}`)
    })
}

/**
 * 忠实复刻 cordis `createTraceable` 的两个陷阱（cordis `src/utils.ts:165-218`）。
 *
 * 为什么必须复刻：0.2.1 首版假宿主用了一个"善良"的普通对象，于是测试全绿、真机启动失败。
 * 真宿主的两条行为必须被复现出来，测试才有意义：
 *   1. `set` 把写入落到派生的 shadow 上（`Reflect.set(target, prop, value, shadow)`），target 不变；
 *   2. `get` 对每个函数属性**重新包一层**代理，并把 thisArg 换成 shadow——
 *      所以「读回比对函数身份」永远不相等，包装实现也绝不能依赖 `this`。
 *
 * @param {object} service - 服务本体。
 * @returns {object} 形如真宿主的 traceable 代理。
 */
function makeTraceable(service) {
  const shadowLike = Object.create(service)
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      const value = Reflect.get(target, prop, target)
      if (typeof value === 'function') {
        return new Proxy(value, {
          apply: (_t, _thisArg, args) => Reflect.apply(value, shadowLike, args),
        })
      }
      return value
    },
    set(target, prop, value) {
      const shadow = Object.create(target)
      return Reflect.set(target, prop, value, shadow)
    },
  })
}

/**
 * 造一个假宿主：只实现本插件真正会碰的那些面。
 *
 * @param {{ withReflect?: boolean }} [options] - withReflect=false 用来验证「取不到服务本体」
 *   时的报错路径（真宿主里对应 cordis 内部结构变化）。
 */
function makeHost(options = {}) {
  const captured = { specs: [], starts: [], locals: [], externals: [], tools: [], routes: [], effects: [], listeners: {}, disposers: [], effortLookups: 0 }

  const llm = {
    listProviders: () => [
      { id: 'zai-coding-cn', name: 'ZAI' },
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'no-catalog-provider', name: 'No Catalog' },
    ],
    listModels: async (providerId) => {
      if (providerId === 'zai-coding-cn') return [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'glm-4.6v', name: 'GLM-4.6V' }]
      if (providerId === 'opencode-go') return [{ id: 'deepseek-v4.1-flash', name: 'DS V4.1 Flash' }]
      throw new Error('provider 不公布目录')
    },
    // 分类器调用（默认关，测试里只在需要时打开）：吐一段文本增量。
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '写作或修改测试' }
    },
    // 推理档解析：形状与官方一致（`reasoning.efforts[].id/name`、`reasoning.defaultEffort`）。
    resolveModelInfo: async (provider, model) => {
      captured.effortLookups += 1
      if (provider === 'zai-coding-cn' && model === 'glm-5.3') {
        return { id: model, name: 'GLM-5.3', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }
      }
      if (provider === 'opencode-go') return { id: model, name: model }
      throw new Error('model not found')
    },
  }

  // 服务本体：方法在原型上（真宿主也是这样），再套一层 traceable 代理暴露给 ctx.subagents。
  class FakeSubagents {
    rootOf(agent) { return agent }
    async listDescendants() { return [] }
    async startActivation(spec) { captured.specs.push(spec); return { childId: spec.childId, name: spec.name, messageId: 'msg-x' } }
    async startContinuable(spec) {
      captured.specs.push(spec)
      return { childId: spec === null || typeof spec !== 'object' ? undefined : spec.childId, messageId: 'msg-x' }
    }
    async start(name, request) {
      captured.starts.push({ name, request })
      return { localAgent: { session: { id: `child-${captured.starts.length}` } } }
    }
    getProvider(name) {
      // 与官方两个内置 provider 的能力声明一致（都支持 agentOptions）。
      if (name === 'spawn' || name === 'fork') return { name, capabilities: { agentOptions: true } }
      if (name === 'legacy') return { name, capabilities: { agentOptions: false } }
      return undefined
    }
  }
  // 0.2.1-rc.2 的真实服务只有 startLocal(spec) / startExternal(spec)（Windows 宿主实报过这个差异），
  // 用 v021 选项换成一个「只有新 API」的服务对象，验证兼容层真的能包住它。
  const raw021 = {
    async startLocal(spec) {
      captured.locals.push(spec)
      return { childId: spec === null || typeof spec !== 'object' ? undefined : spec.childId, messageId: 'msg-local' }
    },
    async startExternal(spec) {
      captured.externals.push(spec)
      return { localAgent: { session: { id: 'external-child' } } }
    },
    getProvider(name) {
      if (name === 'spawn' || name === 'fork') return { name, capabilities: { agentOptions: true } }
      return undefined
    },
  }
  const raw = options.v021 === true ? raw021 : new FakeSubagents()
  // 真实 0.2.1-rc.2 宿主：服务上只有 startActivation(spec)，按 provider.prepareContinuable 分派。
  const rawActivation = {
    async startActivation(spec) {
      captured.locals.push(spec)
      return { childId: spec.childId ?? 'generated', messageId: 'msg-activation' }
    },
    getProvider(name) {
      if (name === 'spawn') return { name, capabilities: { agentOptions: true }, prepareContinuable: async () => ({ seed: [] }) }
      if (name === 'ext') return { name, capabilities: { agentOptions: true } }
      return undefined
    },
  }
  const rawFinal = options.v021Activation === true ? rawActivation : raw
  captured.raw = rawFinal

  // 技能注册（可选依赖：用 ctx.inject(['skills'], …) 等技能服务就绪）
  captured.skills = []
  const skills = {
    register(skill) {
      assert.equal(typeof skill.source, 'string', 'skill registration requires string source')
      assert.ok(skill.source.trim().length > 0, 'skill source must not be empty')
      captured.skills.push(skill)
      return () => { captured.skillDisposed = (captured.skillDisposed ?? 0) + 1 }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    // cordis 的可选依赖注入：假宿主里服务都在，直接同步回调。
    inject(names, callback) {
      callback(ctx)
      return () => {}
    },
    skills,
    tools: {
      register(definition) {
        captured.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        captured.routes.push(route)
        return () => {}
      },
    },
    subagents: makeTraceable(rawFinal),
    on(event, handler) {
      captured.listeners[event] = captured.listeners[event] ?? []
      captured.listeners[event].push(handler)
      const dispose = () => {
        const list = captured.listeners[event] ?? []
        const at = list.indexOf(handler)
        if (at !== -1) list.splice(at, 1)
      }
      captured.disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      captured.effects.push(fn)
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'llm') return llm
      if (name === 'agentTeams') return agentTeams
      if (name === 'subagents') return rawFinal
      if (name === 'tokenMeter') return tokenMeter
      return undefined
    },
  }

  const tokenMeter = { measure: () => ({ totalTokens: 42000 }) }

  // agentTeams 的 spawnTeammate：逐字复刻官方运行时的调用形状
  // （dsh-experimental-agent-team lib/index.js:573-582：只传 prompt/parent，label 取 description）。
  const agentTeams = {
    isEnabled: () => true,
    async spawnTeammate(caller, request) {
      await ctx.subagents.startContinuable({
        childId: 'child-x',
        provider: request.provider,
        label: request.description,
        request: { prompt: request.prompt, parent: caller },
        signal: undefined,
      })
      return {
        member: {
          id: 'child-x',
          name: request.name,
          description: request.description,
          provider: request.provider,
          context: request.context,
          phase: 'active',
        },
      }
    },
  }

  // 反射服务：本插件靠它拿服务本体（cordis src/reflect.ts:208-211 的实现表）。
  // store 的键是 symbol——真宿主如此，所以实现里必须用 getOwnPropertySymbols 扫描。
  if (options.withReflect !== false) {
    const store = Object.create(null)
    store[Symbol('isolate:subagents')] = { name: 'subagents', fiber: {}, value: rawFinal }
    ctx.reflect = {
      store,
      _getImpl(name) {
        return name === 'subagents' ? { name, value: rawFinal } : undefined
      },
    }
  }

  return { ctx, captured }
}

/** 假响应：记录状态码与响应体，供断言。 */
function makeRes() {
  return {
    statusCode: undefined,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/** 假请求：method/url/headers + 可异步迭代的 body（Handler 用 for await 读体）。 */
function makeReq(method, url, headers = {}, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:19387', ...headers }
  return stream
}

/** 父会话（Lead）与子会话（delegated child）的 agent 形状，按官方 SessionHeader 字段搭。 */
function leadAgent(cwd = '/home/me/proj', effort = 'high', sessionId = 'lead-session') {
  return {
    session: {
      id: sessionId,
      header: { id: sessionId, cwd },
      requestHeader: () => ({ config: { reasoningEffort: effort } }),
    },
    options: {},
  }
}

function childAgent(id = 'child-x', parentSession = 'lead-session') {
  let selection
  return {
    id,
    model: { current: () => selection, select: (next) => { selection = { ...next } } },
    session: {
      id,
      header: { id, parentSession, origin: 'subagent', delegationDepth: 1, cwd: '/home/me/proj' },
      requestHeader: () => ({ config: { provider: 'zai-coding-cn', model: 'glm-5.3' } }),
    },
    options: {},
  }
}

/**
 * 跑一次 waterfall：先注册的先包在外层，`next()` 走到下一个监听器或终止实现。
 *
 * @param {object} host - 假宿主。
 * @param {string} name - 事件名。
 * @param {object} payload - 事件负载。
 * @param {Function} terminal - 官方默认实现（一定要记录它有没有被调到）。
 */
async function emit(host, name, payload, terminal) {
  if (name === 'agent/request' && payload.agent?.model) {
    const initial = await terminal()
    if (!payload.agent.model.current()) payload.agent.model.select(initial)
    if (!Object.hasOwn(payload.agent, '_preparedTurn') || payload.agent._preparedTurn !== payload.turn) {
      for (const handler of host.captured.listeners['agent/inbox/claimed'] ?? []) handler(payload)
      payload.agent._preparedTurn = payload.turn
    }
    const prepared = { ...initial, ...payload.agent.model.current() }
    terminal = async () => prepared
  }
  const handlers = host.captured.listeners[name] ?? []
  const run = (index) =>
    index >= handlers.length ? Promise.resolve().then(terminal) : Promise.resolve(handlers[index](payload, () => run(index + 1)))
  return await run(0)
}

const host = makeHost()

await check('组合行不写 config 时 apply 不抛（0.2.1 bug 回归）', async () => {
  await apply(host.ctx, {})
})

await check('工具、设置路由、两条包装、两个监听器都注册上了', () => {
  assert.equal(host.captured.tools.length, 1)
  assert.equal(host.captured.tools[0].name, 'spawn_modeled_teammate')
  assert.equal(host.captured.routes.length, 1)
  assert.equal(host.captured.routes[0].path, '/api/dsh-team-member-model')
  // 包装必须落在**服务本体**的自有属性上（遮蔽原型方法），而不是 ctx.subagents 这个代理上。
  assert.equal(Object.hasOwn(host.captured.raw, 'startContinuable'), true)
  assert.equal(Object.hasOwn(host.captured.raw, 'start'), true)
  assert.deepEqual(Object.keys(host.captured.listeners).sort(), ['agent/created', 'agent/inbox/claimed', 'agent/request', 'agent/request-error', 'session/event', 'subagent/start'])
  assert.equal(Object.hasOwn(host.captured.raw, 'startActivation'), true)
  assert.equal(host.captured.effects.length, 7, '工具 + 设置路由 + 三条包装 + 用量冲刷 + 技能注册')
})

await check('随包技能：注册进 skills，内容含铁律与接口清单（让 AI 能自己配路由）', () => {
  const registered = host.captured.skills
  assert.equal(registered.length, 1, '应当注册一个技能')
  const skill = registered[0]
  assert.equal(skill.name, 'model-routing')
  assert.equal(skill.source, 'team-member-model')
  assert.ok(skill.description.length > 10, 'description 是 Agent 发现技能的唯一线索')
  assert.ok(skill.whenToUse !== undefined)
  assert.match(skill.content, /不要直接改文件/)
  assert.match(skill.content, /PUT \/policy/)
  assert.match(skill.content, /成员名/) 
  assert.match(skill.content, /绑定键 `provider\/model\[:effort\]`/)
  // 技能正文里不许出现「直接改 policy.json 就生效」这种会误导 Agent 的说法
  assert.ok(!/直接编辑.*policy\.json.*生效/.test(skill.content) || /不会生效/.test(skill.content),
    '必须写明直接改文件不生效')
})

await check('宿主行为记录：对 traceable 代理的写入会被吞掉（0.2.1 就是栽在这）', () => {
  const probe = () => {}
  host.ctx.subagents.startContinuable = probe
  host.ctx.subagents.start = probe
  assert.notEqual(host.captured.raw.startContinuable, probe)
  assert.notEqual(host.captured.raw.start, probe)
})

await check('成功时写了 status.json（区分「页面能开」与「真的注册上了」）', async () => {
  const status = JSON.parse(await readFile(join(home, 'team-member-model', 'status.json'), 'utf8'))
  assert.equal(status.mode, 'ok')
  assert.equal(status.members, 0)
  assert.deepEqual(status.wrapped, ['startContinuable', 'start', 'startActivation'])
  assert.deepEqual(status.listeners.sort(), ['agent/created', 'agent/inbox/claimed', 'agent/request', 'agent/request-error', 'session/event', 'session/event(team/member)', 'subagent/start'])
  assert.equal(status.skill, 'model-routing', 'status.json 里记下技能是否注册成功')
})

const routeHandler = host.captured.routes[0].handler
const tool = host.captured.tools[0]

/** 写一次策略（带标记头）。 */
async function putPolicy(policy, expectStatus = 200) {
  const res = makeRes()
  await routeHandler(makeReq('PUT', '/api/dsh-team-member-model/policy', { 'x-dsh-team-member-model': '1' }, JSON.stringify(policy)), res)
  // 静默失败会让后续用例拿着「上一份策略」继续跑，断言错位、极难排查——这里直接喊出来。
  assert.equal(res.statusCode, expectStatus, `PUT /policy 期望 ${expectStatus}，实际 ${res.statusCode}：${res.body}`)
  return res
}

/** 读一次状态。 */
async function getState() {
  const res = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/state'), res)
  return JSON.parse(res.body)
}

await check('GET /state 返回策略、目录、trace（含不公布 models 的 provider）', async () => {
  const payload = await getState()
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.catalog.map((p) => p.id), ['zai-coding-cn', 'opencode-go', 'no-catalog-provider'])
  assert.equal(payload.catalog[2].models.length, 0)
  assert.deepEqual(payload.policy.members, [])
  assert.deepEqual(payload.trace, [])
})

await check('PUT /policy 缺标记头被拒（跨站页面发不出自定义头）', async () => {
  const res = makeRes()
  await routeHandler(makeReq('PUT', '/api/dsh-team-member-model/policy', {}, JSON.stringify({ members: [] })), res)
  assert.equal(res.statusCode, 403)
})

await check('PUT /policy 拒绝非法规则，且不落盘', async () => {
  const res = await putPolicy({ members: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }], rules: [{ use: 'bad name' }] }, 400)
  assert.equal(res.statusCode, 400)
  const state = await getState()
  assert.deepEqual(state.policy.members, [], '整份被拒时不能留下半份配置')
})

await check('PUT /policy 写入并落盘（成员 + 规则 + 策略字段）', async () => {
  const res = await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', channel: 'spawn', label: '*review*' }],
    routing: 'order',
    allowFork: false,
    failover: { enabled: true, patience: 1 },
  })
  assert.equal(res.statusCode, 200)
  const policy = JSON.parse(await readFile(join(home, 'team-member-model', 'policy.json'), 'utf8'))
  assert.equal(policy.version, 4, 'v4（0.6.0）起落盘版本号要跟着成员模型走')
  assert.equal(policy.members.length, 2)
  assert.equal(policy.rules.length, 1)
  assert.equal(policy.failover.patience, 1)
})

await check('PUT /routes：0.2.1 的老接口仍可写（只动成员表）', async () => {
  const res = makeRes()
  await routeHandler(
    makeReq('PUT', '/api/dsh-team-member-model/routes', { 'x-dsh-team-member-model': '1' }, JSON.stringify({
      routes: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }],
    })),
    res,
  )
  assert.equal(res.statusCode, 200)
  const state = await getState()
  assert.deepEqual(state.policy.members, [{ name: 'zai-coding-cn/glm-5.3', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] }])
  assert.equal(state.policy.rules.length, 1, '老接口不该顺手清掉规则')
  // 复原成两条成员，后面的用例要用。
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', channel: 'spawn', label: '*review*' }],
    failover: { enabled: true, patience: 1 },
  })
})

await check('GET /efforts 返回该模型公布的推理档（设置页下拉的数据源）', async () => {
  const res = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/efforts?provider=zai-coding-cn&model=glm-5.3'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.supported, true)
  // 真机实测 zai-coding-cn/glm-5.3 就是这三档，且没有 default。
  assert.deepEqual(payload.efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.equal(payload.defaultEffort, undefined)
})

await check('GET /efforts 命中缓存（同一个模型不重复问 adapter）', async () => {
  const before = host.captured.effortLookups
  const res = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/efforts?provider=zai-coding-cn&model=glm-5.3'), res)
  assert.equal(JSON.parse(res.body).efforts.length, 3)
  assert.equal(host.captured.effortLookups, before, '第二次应走缓存')
})

await check('GET /efforts 缺参数 400；模型解析失败降级成「没公布」而不是报错', async () => {
  const missing = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/efforts?provider=zai-coding-cn'), missing)
  assert.equal(missing.statusCode, 400)

  const broken = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/efforts?provider=zai-coding-cn&model=ghost-model'), broken)
  const payload = JSON.parse(broken.body)
  assert.equal(broken.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.efforts, [])
  assert.match(payload.error, /model not found/)

  // 有 provider 但没声明 reasoning：合法结果，不是错误。
  const noReasoning = makeRes()
  await routeHandler(makeReq('GET', '/api/dsh-team-member-model/efforts?provider=opencode-go&model=deepseek-v4.1-flash'), noReasoning)
  const plain = JSON.parse(noReasoning.body)
  assert.deepEqual(plain.efforts, [])
  assert.equal(plain.error, undefined)
})

await check('创建期 · fork 通道默认不纳管（保父会话前缀的 KV 复用）', async () => {
  const before = host.captured.starts.length
  await host.captured.raw.start('fork', { label: 'forked work', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent() })
  const call = host.captured.starts[before]
  assert.equal(call.request.agentOptions, undefined, '默认不该注入 fork')
  const state = await getState()
  assert.equal(state.trace[0].outcome, 'skipped')
  assert.equal(state.trace[0].reason, 'fork-disabled')
})

await check('创建期 · spawn 通道按规则命中注入（不是成员表第一个）', async () => {
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'please review the diff', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent() })
  const call = host.captured.starts[before]
  assert.deepEqual(call.request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  const state = await getState()
  assert.equal(state.trace[0].outcome, 'injected')
  assert.equal(state.trace[0].reason, 'rule')
  assert.equal(state.trace[0].ruleIndex, 0)
  assert.equal(state.trace[0].route, 'opencode-go/deepseek-v4.1-flash')
})

await check('创建期 · 档位成员：规则点名 :low 注入的就是 low 档，回退候选先降档再换模型', async () => {
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'low' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'zai-coding-cn/glm-5.3:low', label: '*quick*' }],
    failover: { enabled: true, patience: 2 },
  })
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'quick lookup', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-effort') })
  assert.deepEqual(host.captured.starts[before].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'low' })
  const state = await getState()
  assert.equal(state.trace[0].route, 'zai-coding-cn/glm-5.3:low', 'trace 按完整身份记账')
  // 一次性子代理的回退认领：冻结配置带档位，必须认领到带档位的计划（修过的坑）。
  const child = childAgent('child-effort', 'lead-effort')
  const config = await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 },
    async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'low' }))
  assert.deepEqual(config, { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'low' })
  const action = await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { status: 503, message: 'busy', code: 'OVERLOADED' },
  }, async () => undefined)
  assert.equal(action, undefined, 'deferred failover 交回官方循环处理')
  const next = await emit(host, 'agent/request', { agent: child, turn: 2, step: 1 },
    async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'low' }))
  assert.deepEqual(next, { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' },
    '回退链先降档（同模型 max 变体），下轮生效')
})

await check('创建期 · 规则不命中时用成员表第一个（顺序即语义）', async () => {
  // 自带策略：不依赖前一条用例残留（档位成员测试会把成员表换成带 effort 的版本）。
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', channel: 'spawn', label: '*review*' }],
  })
  // 用一个全新的父会话：否则会被上面的亲和（同一父会话粘住上次成员）接管。
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'deploy the thing', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-fresh') })
  const call = host.captured.starts[before]
  assert.deepEqual(call.request.agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' })
  const state = await getState()
  assert.equal(state.trace[0].reason, 'order')
})

await check('创建期 · 亲和只对 fork 通道生效（子会话共享父前缀时才值得粘）', async () => {
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', label: '*review*' }],
    allowFork: true,
  })
  const parent = leadAgent('/home/me/proj', 'high', 'lead-affinity')
  const before = host.captured.starts.length
  // 第一次：fork 通道 + 规则命中 → 非首位的 opencode。
  await host.captured.raw.start('fork', { label: 'please review the diff', prompt: [{ type: 'text', text: 'x' }], parent })
  assert.deepEqual(host.captured.starts[before].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  // 第二次：规则不再命中，但 fork 的亲和把它留在 opencode 上（父前缀的 cache 还能复用）。
  await host.captured.raw.start('fork', { label: 'deploy the thing', prompt: [{ type: 'text', text: 'x' }], parent })
  assert.deepEqual(host.captured.starts[before + 1].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  const state = await getState()
  assert.equal(state.trace[0].reason, 'affinity')
})

await check('创建期 · weight 真的会轮转（用户实报：weight 全部没生效）', async () => {
  // 同一个父会话、同一个通道，连续创建：修复前全被亲和粘死在第一个成员上。
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3', weight: 1 },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', weight: 1 },
    ],
    rules: [],
    routing: 'weight',
  })
  const parent = leadAgent('/home/me/proj', 'high', 'lead-rotate')
  const before = host.captured.starts.length
  const seen = []
  for (let i = 0; i < 4; i += 1) {
    await host.captured.raw.start('spawn', { label: 'plain job', prompt: [{ type: 'text', text: 'x' }], parent })
    seen.push(host.captured.starts[before + i].request.agentOptions.model)
  }
  // 锁「交替」这个不变量而不是具体序列：起始成员取决于全局创建序号的奇偶，
  // 在本用例前面增删任何一条会创建子代理的用例都会翻转它。
  assert.equal(new Set(seen).size, 2, '两个成员都被用到（不是粘在第一个上）')
  assert.ok(seen.every((model, i) => i === 0 || model !== seen[i - 1]),
    `应当逐次交替，实际 ${seen.join(' -> ')}`)
  const state = await getState()
  assert.equal(state.trace[0].reason, 'weight')
})

await check('创建期 · 目录条件按父会话 cwd 命中（Windows 写法也能配）', async () => {
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', folders: ['/home/me'] }],
  })
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'anything', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj/sub', 'high', 'lead-folder-in') })
  assert.deepEqual(host.captured.starts[before].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  // 不在该目录下的父会话 → 规则不命中 → 退回成员表第一个（用另一个新父会话，避开亲和）。
  const beforeOutside = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'anything', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/srv/other', 'high', 'lead-folder-out') })
  assert.deepEqual(host.captured.starts[beforeOutside].request.agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' })
})

await check('创建期 · 调用方自带 agentOptions 时一律不覆盖（显式优先）', async () => {
  const traceBefore = (await getState()).trace.length
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', {
    label: 'anything',
    prompt: [{ type: 'text', text: 'x' }],
    parent: leadAgent(),
    agentOptions: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  })
  assert.deepEqual(host.captured.starts[before].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal((await getState()).trace.length, traceBefore, '显式指定的那一次不该产生「我路由了」的记录')
})

await check('创建期 · 咨询器不支持 agentOptions 的 provider 不注入（避免官方直接抛）', async () => {
  const before = host.captured.starts.length
  await host.captured.raw.start('legacy', { label: 'anything', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent() })
  assert.equal(host.captured.starts[before].request.agentOptions, undefined)
  const state = await getState()
  assert.equal(state.trace[0].reason, 'provider-no-agent-options')
})

await check('创建期 · 团队成员（startContinuable）也走同一套规则', async () => {
  const before = host.captured.specs.length
  await host.captured.raw.startContinuable({
    childId: 'child-rule',
    provider: 'spawn',
    label: 'review the member work',
    request: {
      prompt: [{ type: 'text', text: identityPrefix('reviewer') }, { type: 'text', text: 'do it' }],
      parent: leadAgent(),
    },
  })
  const spec = host.captured.specs[before]
  assert.deepEqual(spec.request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  const state = await getState()
  assert.equal(state.trace[0].continuable, true)
})

await check('创建期 · 工具显式路由优先于规则（0.2.1 的暂存机制保持不变）', async () => {
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', label: '*' }],
  })
  const result = await tool.execute(
    { name: 'frontend', description: '负责前端', prompt: '做页面', context: 'fresh', provider: 'zai-coding-cn', model: 'glm-5.3' },
    { agent: leadAgent() },
  )
  const spec = host.captured.specs[host.captured.specs.length - 1]
  assert.deepEqual(spec.agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' }, '显式点名的路由不该被 label=* 的规则抢走')
  assert.equal(spec.name, 'frontend')
  assert.equal(spec.prompt[0].text, '做页面')
  assert.equal(result.llmProvider, 'zai-coding-cn')
  const state = await getState()
  assert.equal(state.trace[0].reason, 'explicit')
})

await check('工具 · 成员表非空时表外路由被拒（且不消耗成员名）', async () => {
  await putPolicy({ members: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] })
  const before = host.captured.specs.length
  await assert.rejects(
    () => tool.execute({ name: 'x', description: 'd', prompt: 'p', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, { agent: leadAgent() }),
    /不在任何成员的绑定内/,
  )
  assert.equal(host.captured.specs.length, before)
})

await check('工具 · provider/model 必须成对；非法成员名先于任何副作用被拒', async () => {
  const before = host.captured.specs.length
  await assert.rejects(() => tool.execute({ name: 'a', description: 'd', prompt: 'p', provider: 'zai-coding-cn' }, { agent: leadAgent() }), /成对/)
  await assert.rejects(() => tool.execute({ name: 'effort-only', description: 'd', prompt: 'p', reasoning_effort: 'high' }, { agent: leadAgent() }), /reasoning_effort.*provider.*model/)
  assert.equal(host.captured.specs.length, before, '仅档位不得创建成员或消耗名称')
  await assert.rejects(() => tool.execute({ name: 'Not_Kebab', description: 'd', prompt: 'p' }, { agent: leadAgent() }), /lower-kebab-case/)
})

// ---------------------------------------------------------------------------
// 运行期回退：magpie 的候选人循环
// ---------------------------------------------------------------------------

await check('回退 · 子 agent 的请求被替换成候选路由；Lead 的请求完全不碰', async () => {
  const child = childAgent('child-failover')
  const config = await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => ({
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    reasoningEffort: 'high',
  }))
  // 子 agent 没被本插件路由过（没有认领到计划）→ 原样返回。
  assert.deepEqual(config, { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high' })

  const lead = leadAgent()
  const leadConfig = await emit(host, 'agent/request', { agent: lead, turn: 1, step: 1 }, async () => ({
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
  }))
  assert.deepEqual(leadConfig, { provider: 'zai-coding-cn', model: 'glm-5.3' }, 'Lead 的模型永不参与路由')

  let delegated = false
  const leadAction = await emit(host, 'agent/request-error', {
    agent: lead, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { status: 503, message: 'busy', code: 'OVERLOADED' },
  }, async () => {
    delegated = true
    return undefined
  })
  assert.equal(delegated, true, 'Lead 的失败必须原样交回官方循环')
  assert.equal(leadAction, undefined)
})

await check('回退 · 可重试失败：换下一个候选并返回 {kind:"retry"}', async () => {
  // 用 startContinuable 创建（创建时就知道 childId，回退状态立即登记）。
  await putPolicy({
    members: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
    ],
    failover: { enabled: true, patience: 2 },
  })
  await host.captured.raw.startContinuable({
    childId: 'child-fo-1',
    provider: 'spawn',
    label: 'job',
    request: { prompt: [{ type: 'text', text: identityPrefix('worker') }], parent: leadAgent() },
  })
  const child = childAgent('child-fo-1')

  const first = await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => ({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  }))
  assert.deepEqual(first, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, '首选成员原样通过')

  let delegated = false
  const action = await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'opencode-go', failure: { status: 503, message: 'upstream overloaded', code: 'OVERLOADED' },
  }, async () => {
    delegated = true
    return undefined
  })
  assert.equal(delegated, true, '可重试失败交回官方循环处理')
  assert.equal(action, undefined)

  const retry = await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => first)
  assert.deepEqual(retry, first, '同一步骤重试仍使用准备时的模型')
  const second = await emit(host, 'agent/request', { agent: child, turn: 2, step: 1 }, async () => ({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  }))
  assert.deepEqual(second, { provider: 'zai-coding-cn', model: 'glm-5.3' }, '下一次请求必须换到第二个候选（并清掉继承的 effort）')

  const state = await getState()
  const switchTrace = state.trace.find((row) => row.outcome === 'deferred')
  assert.equal(switchTrace.from, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(switchTrace.to, 'zai-coding-cn/glm-5.3')
  // 按身份断言而不是数总数：rest 是跨用例的宿主状态，前面的用例可能已让别的成员在歇。
  assert.ok(state.rests.some((entry) => entry.route === 'opencode-go/deepseek-v4.1-flash'),
    '失败的成员要在 rest 里')
})

await check('回退 · patience 用尽后交回官方循环（不再换候选）', async () => {
  const child = childAgent('child-fo-1')
  let delegated = false
  const action = await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { status: 503, message: 'busy', code: 'OVERLOADED' },
  }, async () => {
    delegated = true
    return undefined
  })
  assert.equal(delegated, true)
  assert.equal(action, undefined)
  const state = await getState()
  const gaveUp = state.trace.find((row) => row.outcome === 'gave-up')
  assert.equal(gaveUp.reason, 'no-more-candidates')
})

await check('回退 · 请求本身的拒绝（400）绝不换候选', async () => {
  await putPolicy({
    members: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
    ],
    failover: { enabled: true, patience: 2 },
  })
  await host.captured.raw.startContinuable({
    childId: 'child-400',
    provider: 'spawn',
    label: 'job',
    request: { prompt: [{ type: 'text', text: identityPrefix('worker400') }], parent: leadAgent() },
  })
  const child = childAgent('child-400')
  await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }))
  let delegated = false
  const action = await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'opencode-go', failure: { status: 400, message: 'invalid request', code: 'BAD_REQUEST' },
  }, async () => {
    delegated = true
    return undefined
  })
  assert.equal(delegated, true, '400 必须原样交回官方（换模型也答不对）')
  assert.equal(action, undefined)
  const state = await getState()
  assert.equal(state.trace[0].reason, 'not-retryable')
})

await check('回退 · 429 的成员被 sink 到候选末尾', async () => {
  // 不假设「哪个成员先被选中」：前面的用例会留下 rest（magpie 的 restLast 会把休息中的
  // 候选整体排后），所以这里读回**实际注入的绑定**，再对它制造 429。
  await putPolicy({
    members: [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
    ],
    rules: [{ use: 'opencode-go/deepseek-v4.1-flash', label: 'job' }],
    failover: { enabled: true, patience: 2 },
  })
  const before = host.captured.specs.length
  await host.captured.raw.startContinuable({
    childId: 'child-429',
    provider: 'spawn',
    label: 'job',
    request: { prompt: [{ type: 'text', text: identityPrefix('worker429') }], parent: leadAgent('/home/me/proj', 'high', 'lead-429') },
  })
  const injected = host.captured.specs[before].request.agentOptions
  const failedBinding = `${injected.provider}/${injected.model}` + (injected.reasoningEffort ? `:${injected.reasoningEffort}` : '')
  const child = childAgent('child-429', 'lead-429')
  await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => ({ ...injected }))
  await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: injected.provider,
    failure: { status: 429, message: 'rate limited', code: 'RATE_LIMITED' },
  }, async () => undefined)
  const state = await getState()
  assert.ok(state.sink.includes(failedBinding), `429 的绑定必须进 sink（实际 sink: ${JSON.stringify(state.sink)}）`)
})

await check('回退 · 成员答上一次就清掉它的 rest（magpie 的 served）', async () => {
  // 构造：先用一个子 agent 把 zai 打进 rest，再让另一个子 agent 在 zai 上「答上」。
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    failover: { enabled: true, patience: 2 },
  })
  await host.captured.raw.startContinuable({
    childId: 'child-served-a',
    provider: 'spawn',
    label: 'job a',
    request: { prompt: [{ type: 'text', text: identityPrefix('worker-a') }], parent: leadAgent('/home/me/proj', 'high', 'lead-served') },
  })
  const childA = childAgent('child-served-a')
  await emit(host, 'agent/request', { agent: childA, turn: 1, step: 1 }, async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }))
  await emit(host, 'agent/request-error', {
    agent: childA, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { status: 503, message: 'busy', code: 'OVERLOADED' },
  }, async () => undefined)
  assert.ok(
    (await getState()).rests.some((entry) => entry.route === 'zai-coding-cn/glm-5.3'),
    'zai 应当已经进 rest',
  )

  // 手动指定 zai：即使它正在 rest，pick 也会把它排在首位（magpie 的 Manual 组同理）。
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    pick: 'zai-coding-cn/glm-5.3',
    failover: { enabled: true, patience: 2 },
  })
  await host.captured.raw.startContinuable({
    childId: 'child-served-b',
    provider: 'spawn',
    label: 'job b',
    request: { prompt: [{ type: 'text', text: identityPrefix('worker-b') }], parent: leadAgent('/home/me/proj', 'high', 'lead-served') },
  })
  const childB = childAgent('child-served-b')
  // 只有成功提交 assistant/message 才算 served；同一步骤重试不能清除 rest。
  await emit(host, 'agent/request', { agent: childB, turn: 1, step: 1 }, async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }))
  const served = { type: 'assistant/message', data: { turn: 1, step: 1 } }
  childB.session.snapshotEvents = () => [served]
  for (const handler of host.captured.listeners['session/event'] ?? []) await handler(childB.session, served)
  const state = await getState()
  assert.ok(
    !state.rests.some((entry) => entry.route === 'zai-coding-cn/glm-5.3'),
    'zai 答上了，它的 rest 应当被清掉',
  )
})

await check('回退 · 一次性子 agent 也能认领（父会话 + 当前路由）并参与回退', async () => {
  await putPolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    failover: { enabled: true, patience: 2 },
  })
  // 专用父会话：避免被别的用例留下的亲和影响，也让计划的键唯一。
  const lead = leadAgent('/home/me/proj', 'high', 'lead-oneshot')
  const before = host.captured.starts.length
  await host.captured.raw.start('spawn', { label: 'one shot job', prompt: [{ type: 'text', text: 'x' }], parent: lead })
  const injected = host.captured.starts[before].request.agentOptions
  assert.deepEqual(injected, { provider: 'zai-coding-cn', model: 'glm-5.3' })
  // 官方铸出的子会话 id 只有创建后才知道；用父会话 id + 当前路由认领。
  const child = childAgent('child-oneshot', 'lead-oneshot')
  const config = await emit(host, 'agent/request', { agent: child, turn: 1, step: 1 }, async () => ({ ...injected }))
  assert.deepEqual(config, injected)
  const action = await emit(host, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { status: 502, message: 'bad gateway', code: 'UPSTREAM_5XX' },
  }, async () => undefined)
  assert.equal(action, undefined, '一次性子 agent 回退计划推进至下一个候选且交官方')
})

await check('卸载时还原服务本体（插件可随时关掉）', () => {
  const raw = host.captured.raw
  const originalContinuable = Object.getOwnPropertyDescriptor(raw, 'startContinuable')
  assert.ok(originalContinuable, '包装应当是本体的自有属性')
  for (const effect of host.captured.effects) {
    const disposer = effect()
    if (typeof disposer === 'function') disposer()
  }
  for (const dispose of host.captured.disposers) dispose()
  // 还原判据看**本体**：代理每次读取都会重新包装函数，比身份没有意义。
  assert.equal(Object.hasOwn(raw, 'startContinuable'), false)
  assert.equal(Object.hasOwn(raw, 'start'), false)
  assert.equal(typeof raw.startContinuable, 'function')
  assert.equal(typeof raw.start, 'function')
  assert.equal((host.captured.listeners['agent/request'] ?? []).length, 0)
  assert.equal(host.captured.skillDisposed, 1, '卸载必须调用技能注册返回的 disposer 一次')
})

await check('0.2.1 的策略文件（version:1 / routes）能被读进来并迁移', async () => {
  const legacy = makeHost()
  const legacyHome = await mkdtemp(join(tmpdir(), 'tmm-legacy-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = legacyHome
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(legacyHome, 'team-member-model'), { recursive: true }))
    await writeFile(
      join(legacyHome, 'team-member-model', 'policy.json'),
      JSON.stringify({ version: 1, routes: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] }),
      'utf8',
    )
    await apply(legacy.ctx, {})
    const res = makeRes()
    await legacy.captured.routes[0].handler(makeReq('GET', '/api/dsh-team-member-model/state'), res)
    const payload = JSON.parse(res.body)
    assert.deepEqual(payload.policy.members, [{ name: 'opencode-go/deepseek-v4.1-flash', bindings: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] }])
    assert.deepEqual(payload.policy.rules, [])
  } finally {
    process.env.DSH_HOME = previous
  }
})

await check('组合行 config 的种子（0.2.1 的 allowedModels）仍然被接受', async () => {
  const seeded = makeHost()
  const seededHome = await mkdtemp(join(tmpdir(), 'tmm-seed-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = seededHome
  try {
    await apply(seeded.ctx, { allowedModels: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] })
    const res = makeRes()
    await seeded.captured.routes[0].handler(makeReq('GET', '/api/dsh-team-member-model/state'), res)
    assert.deepEqual(JSON.parse(res.body).policy.members, [{ name: 'zai-coding-cn/glm-5.3', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] }])
  } finally {
    process.env.DSH_HOME = previous
  }
})

// 放在最后：这条用例会故意让 apply 失败并把 status.json 写成 error，
// 排在状态断言之前会把它们污染掉（踩过一次）。
// 用量统计用**自己的宿主**：前面的用例跑过「卸载还原」，会把主宿主的监听器摘掉。
function makeUsageHost() {
  const usageHost = makeHost()
  return {
    host: usageHost,
    async ready(policy) {
      await apply(usageHost.ctx, {})
      const handler = usageHost.captured.routes[0].handler
      const put = async (body) => {
        const res = makeRes()
        await handler(makeReq('PUT', '/api/dsh-team-member-model/policy', { 'x-dsh-team-member-model': '1' }, JSON.stringify(body)), res)
        assert.equal(res.statusCode, 200, res.body)
      }
      await put(policy)
      const reset = makeRes()
      await handler(makeReq('PUT', '/api/dsh-team-member-model/usage/reset', { 'x-dsh-team-member-model': '1' }, '{}'), reset)
      assert.equal(reset.statusCode, 200)
      return handler
    },
  }
}

await check('用量统计：子会话的 assistant/message 按成员累计，且同一 (turn,step) 不重复计', async () => {
  const env = makeUsageHost()
  const handler = await env.ready({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    rules: [{ use: 'zai-coding-cn/glm-5.3:max', label: '*review*' }],
  })
  // 被规则命中的 continuable 子代理：创建时就登记归属
  await env.host.captured.raw.startContinuable({
    childId: 'child-usage',
    provider: 'spawn',
    label: 'review the usage wiring',
    request: { prompt: [{ type: 'text', text: identityPrefix('usage-probe') }], parent: leadAgent('/home/me/proj', 'high', 'lead-usage') },
  })
  const events = [
    { type: 'user/message', data: {} },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5 } } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 2, step: 1 } },
  ]
  const childSession = {
    id: 'child-usage',
    header: { id: 'child-usage', origin: 'subagent', delegationDepth: 1, parentSession: 'lead-usage' },
    snapshotEvents: () => events,
  }
  env.host.captured.listeners['session/event'][0](childSession, events[1])

  const res = makeRes()
  await handler(makeReq('GET', '/api/dsh-team-member-model/usage'), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  const row = payload.members.find((m) => m.member === 'zai-coding-cn/glm-5.3:max')
  assert.ok(row !== undefined, '归属应落在规则命中的成员上')
  assert.equal(row.runs, 1, '一次创建 = 一次 run')
  // 5 条事件里：1 条非 assistant、1 条无 usage 不计、2 条同 (turn,step) 只算一条 → 实际 2 次调用
  assert.equal(row.calls, 2, '同 (turn,step) 去重 + 无 usage 的那条不计')
  assert.equal(row.totalTokens, 420 + 55, '四项互不重叠：100+20+300 = 420，再加 50+5')
  assert.equal(payload.hours.length, 24, '时间轴固定 24 个桶（缺的补 0）')
  assert.equal(payload.totals.runs, 1)
  assert.equal((payload.rules.find((r) => r.rule.includes('#1')) ?? {}).hits, 1, '图 3 要记到具体规则')

  // Lead 的会话完全不计
  const leadSession = {
    id: 'lead-session',
    header: { id: 'lead-session' },
    snapshotEvents: () => [{ type: 'assistant/message', time: Date.now(), data: { turn: 9, step: 9, usage: { inputTokens: 9999, outputTokens: 9999 } } }],
  }
  env.host.captured.listeners['session/event'][0](leadSession, {})
  const after = makeRes()
  await handler(makeReq('GET', '/api/dsh-team-member-model/usage'), after)
  assert.equal(JSON.parse(after.body).totals.totalTokens, payload.totals.totalTokens, 'Lead 的用量不该进统计')
})

await check('用量统计：清零接口可用且立即落盘（重启不清零）', async () => {
  const env = makeUsageHost()
  const handler = await env.ready({ members: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] })
  await env.host.captured.raw.startContinuable({
    childId: 'child-usage-2',
    provider: 'spawn',
    label: 'plain job',
    request: { prompt: [{ type: 'text', text: identityPrefix('usage-probe-2') }], parent: leadAgent('/home/me/proj', 'high', 'lead-usage-2') },
  })
  const events = [{ type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } }]
  env.host.captured.listeners['session/event'][0]({ id: 'child-usage-2', header: { id: 'child-usage-2', origin: 'subagent' }, snapshotEvents: () => events }, events[0])
  const seen = makeRes()
  await handler(makeReq('GET', '/api/dsh-team-member-model/usage'), seen)
  assert.equal(JSON.parse(seen.body).totals.runs, 1)

  const reset = makeRes()
  await handler(makeReq('PUT', '/api/dsh-team-member-model/usage/reset', { 'x-dsh-team-member-model': '1' }, '{}'), reset)
  const payload = JSON.parse(reset.body)
  assert.equal(payload.totals.runs, 0)
  assert.deepEqual(payload.members, [])
  const usage = JSON.parse(await readFile(join(home, 'team-member-model', 'usage.json'), 'utf8'))
  assert.equal(usage.version, 1)
  assert.deepEqual(usage.members, {})

  // 重启不清零：把刚才的数据读回来
  const reloaded = loadUsage({ version: 1, members: { 'a/b': { runs: 2, calls: 3, totalTokens: 99 } }, rules: { '#1 *x*': 2 }, hours: {} })
  assert.equal(reloaded.members['a/b'].runs, 2)
  assert.equal(reloaded.members['a/b'].totalTokens, 99)
  assert.equal(reloaded.rules['#1 *x*'], 2)
})

// v4 用例要**自己的宿主**：上面的「卸载还原」用例已经把主宿主的包装摘掉了。
async function makeAppliedHost(policy) {
  const fresh = makeHost()
  await apply(fresh.ctx, {})
  const handler = fresh.captured.routes[0].handler
  const res = makeRes()
  await handler(makeReq('PUT', '/api/dsh-team-member-model/policy', { 'x-dsh-team-member-model': '1' }, JSON.stringify(policy)), res)
  assert.equal(res.statusCode, 200, res.body)
  const state = async () => {
    const r = makeRes()
    await handler(makeReq('GET', '/api/dsh-team-member-model/state'), r)
    return JSON.parse(r.body)
  }
  return { fresh, state }
}

await check('v4 成员：规则命中成员后注入它的第一个绑定；失败换到**同成员的另一个渠道**', async () => {
  const { fresh, state } = await makeAppliedHost({
    members: [
      {
        name: 'glm-max',
        bindings: [
          { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' },
          { provider: 'opencode-go', model: 'glm-5.3', reasoningEffort: 'max' },
        ],
      },
      { name: 'cheap', bindings: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] },
    ],
    rules: [{ use: 'glm-max', label: '*review*' }],
    failover: { enabled: true, patience: 2 },
  })
  const before = fresh.captured.starts.length
  await fresh.captured.raw.start('spawn', { label: 'review please', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-v4') })
  assert.deepEqual(fresh.captured.starts[before].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })
  const snapshot = await state()
  const create = snapshot.trace.find((row) => row.outcome === 'injected')
  assert.equal(create.member, 'glm-max', 'trace 记逻辑成员名')
  assert.equal(create.route, 'zai-coding-cn/glm-5.3:max', 'trace 同时记绑定键')

  // 一次性子代理认领计划后，第一次失败应换到**同成员的另一个渠道**（不是换模型）
  const child = childAgent('child-v4', 'lead-v4')
  await emit(fresh, 'agent/request', { agent: child, turn: 1, step: 1 },
    async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }))
  const action = await emit(fresh, 'agent/request-error', {
    agent: child, turn: 1, step: 1, provider: 'zai-coding-cn',
    failure: { status: 503, message: 'busy', code: 'OVERLOADED' },
  }, async () => undefined)
  assert.equal(action, undefined, '跨渠道 deferred failover 放行交官方')
  const next = await emit(fresh, 'agent/request', { agent: child, turn: 2, step: 1 },
    async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }))
  assert.deepEqual(next, { provider: 'opencode-go', model: 'glm-5.3', reasoningEffort: 'max' },
    '跨渠道回退：同模型换渠道，而不是跳去别的模型')
})

await check('v4 成员：成员级 off / policy.off 摘除整个成员', async () => {
  const { fresh } = await makeAppliedHost({
    members: [
      { name: 'a', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] },
      { name: 'b', bindings: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] },
    ],
    off: ['a'],
  })
  const before = fresh.captured.starts.length
  await fresh.captured.raw.start('spawn', { label: 'plain', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-off') })
  assert.deepEqual(fresh.captured.starts[before].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })

  const second = await makeAppliedHost({
    members: [
      { name: 'a', off: true, bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] },
      { name: 'b', bindings: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] },
    ],
  })
  const at = second.fresh.captured.starts.length
  await second.fresh.captured.raw.start('spawn', { label: 'plain2', prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-off2') })
  assert.deepEqual(second.fresh.captured.starts[at].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
})

await check('0.2.1-rc.2 的 startLocal / startExternal 也能包装并注入（Windows 宿主实报）', async () => {
  const fresh = makeHost({ v021: true })
  await apply(fresh.ctx, {})
  const handler = fresh.captured.routes[0].handler
  const res = makeRes()
  await handler(makeReq('PUT', '/api/dsh-team-member-model/policy', { 'x-dsh-team-member-model': '1' }, JSON.stringify({
    members: [{ name: 'glm-max', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }] }],
    rules: [{ use: 'glm-max', label: '*review*' }],
  })), res)
  assert.equal(res.statusCode, 200, res.body)

  // continuable：startLocal(spec)，注入点 spec.request.agentOptions
  await fresh.ctx.subagents.startLocal({
    provider: 'spawn', childId: 'child-local', label: 'review the diff',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-local') },
  })
  assert.equal(fresh.captured.locals.length, 1, 'startLocal 必须被包装')
  assert.deepEqual(fresh.captured.locals[0].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })

  // one-shot：startExternal(spec)，注入点同样是 spec.request.agentOptions
  await fresh.ctx.subagents.startExternal({
    provider: 'spawn', label: 'review this too',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-ext') },
  })
  assert.equal(fresh.captured.externals.length, 1, 'startExternal 必须被包装')
  assert.deepEqual(fresh.captured.externals[0].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })
})

await check('0.2.1-rc.2 的唯一入口 startActivation：按 provider 分派 continuable / 一次性', async () => {
  const fresh = makeHost({ v021Activation: true })
  await apply(fresh.ctx, {})
  const handler = fresh.captured.routes[0].handler
  const res = makeRes()
  await handler(makeReq('PUT', '/api/dsh-team-member-model/policy', { 'x-dsh-team-member-model': '1' }, JSON.stringify({
    members: [{ name: 'glm-max', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }] }],
    rules: [
      { use: 'glm-max', continuable: true },
      { use: 'glm-max', continuable: false },
    ],
  })), res)
  assert.equal(res.statusCode, 200, res.body)

  // provider 有 prepareContinuable → 团队成员（startLocal 语义）
  await fresh.ctx.subagents.startActivation({
    provider: 'spawn', childId: 'child-act', label: 'team member task',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-act') },
  })
  assert.equal(fresh.captured.locals.length, 1, 'startActivation 必须被包装')
  assert.deepEqual(fresh.captured.locals[0].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })

  // provider 没有 prepareContinuable → 外部/一次性，同一入口也要注入
  await fresh.ctx.subagents.startActivation({
    provider: 'ext', label: 'one shot task',
    request: { prompt: [{ type: 'text', text: 'x' }], parent: leadAgent('/home/me/proj', 'high', 'lead-ext2') },
  })
  assert.equal(fresh.captured.locals.length, 2)
  assert.deepEqual(fresh.captured.locals[1].request.agentOptions,
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })
})

await check('取不到服务本体时给出明确报错，而不是静默不生效', async () => {
  const bare = makeHost({ withReflect: false })
  await assert.rejects(() => apply(bare.ctx, {}), /取不到 ctx\.subagents 的服务本体/)
})

// 刻意不清理临时目录（删除红线：脚本里不做永久删除），只打印路径；$TEMP 由系统自行回收。
console.log(`\n${passed} 项通过`)
console.log(`临时 DSH_HOME（可留可清）：${home}`)
