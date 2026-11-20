import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTeamRoute, isManualFixedRoute, extractExplicitRoute } from '../lib/team-routing.js'
import { TeamStateStore } from '../lib/team-state.js'

test('resolveTeamRoute: 5 级路由优先级解析与 source', () => {
  const teamRecord = {
    teamId: 'lead-1',
    revision: 1,
    defaultModel: { provider: 'p-default', model: 'm-default' },
    initials: {
      'worker-1': { selection: { provider: 'p-snap', model: 'm-snap' }, source: 'default' },
      'worker-explicit': { selection: { provider: 'p-explicit', model: 'm-explicit' }, source: 'explicit' },
    },
    choices: {
      'worker-1': {
        selection: { provider: 'p-override', model: 'm-override' },
        effectiveAfterTurn: 1,
      },
    },
  }

  // 1. turn > effectiveAfterTurn 命中 Level 1: memberoverride
  const r1 = resolveTeamRoute({
    agentId: 'worker-1',
    turn: 2,
    teamRecord,
    agentOptions: { model: 'm-explicit', provider: 'p-explicit' },
  })
  assert.equal(r1.level, 'memberoverride')
  assert.equal(r1.route.model, 'm-override')
  assert.equal(r1.isManualFixed, true)

  // 2. turn <= effectiveAfterTurn 时 override 未生效，若有 explicit agentOptions 命中 Level 2: createexplicit
  const r2 = resolveTeamRoute({
    agentId: 'worker-explicit',
    turn: 1,
    teamRecord,
    agentOptions: { model: 'm-explicit', provider: 'p-explicit' },
  })
  assert.equal(r2.level, 'createexplicit')
  assert.equal(r2.route.model, 'm-explicit')
  assert.equal(r2.isManualFixed, true)

  // 3. 仅有空 agentOptions {} 时，不能误判为 explicit，退至 Level 3: captureddefault
  const r3 = resolveTeamRoute({
    agentId: 'worker-1',
    turn: 1,
    teamRecord,
    agentOptions: {}, // 空对象守卫
  })
  assert.equal(r3.level, 'captureddefault')
  assert.equal(r3.route.model, 'm-snap')
  assert.equal(r3.source, 'default')
  assert.equal(r3.isManualFixed, true)

  // 4. 自注入的 agentOptions (__tmmInjected: true) 不算显式创建
  const r3Injected = resolveTeamRoute({
    agentId: 'worker-1',
    turn: 1,
    teamRecord,
    agentOptions: { provider: 'auto-p', model: 'auto-m', __tmmInjected: true },
  })
  assert.equal(r3Injected.level, 'captureddefault')
  assert.equal(r3Injected.route.model, 'm-snap')

  // 5. 无 manual 时返回 null，留给 Level 4 (auto) / Level 5 (inherit)
  const r4 = resolveTeamRoute({
    agentId: 'worker-untracked',
    turn: 1,
    teamRecord: { initials: {}, choices: {}, defaultModel: null },
    agentOptions: undefined,
  })
  assert.equal(r4, null)
})

test('resolveTeamRoute: 当轮保护与清除覆盖 (choice 设为 null) 下轮生效', () => {
  const teamRecord = {
    teamId: 'lead-1',
    revision: 2,
    defaultModel: { provider: 'p-default', model: 'm-default' },
    initials: { 'worker-1': { selection: { provider: 'p-snap', model: 'm-snap' }, source: 'default' } },
    choices: {
      'worker-1': {
        selection: null, // 清除覆盖
        heldSelection: { provider: 'p-old-override', model: 'm-old-override' },
        effectiveAfterTurn: 3,
      },
    },
  }

  // 当前轮次 turn 3 <= effectiveAfterTurn 3：保持原已固定的 heldSelection
  const rCurrent = resolveTeamRoute({
    agentId: 'worker-1',
    turn: 3,
    teamRecord,
  })
  assert.equal(rCurrent.level, 'memberoverride')
  assert.equal(rCurrent.route.model, 'm-old-override')

  // 下一轮 turn 4 > effectiveAfterTurn 3：清除生效，退回 Level 3 captureddefault
  const rNext = resolveTeamRoute({
    agentId: 'worker-1',
    turn: 4,
    teamRecord,
  })
  assert.equal(rNext.level, 'captureddefault')
  assert.equal(rNext.route.model, 'm-snap')
})

test('isManualFixedRoute: 手动路由标记禁止进入 candidate failover', () => {
  assert.equal(isManualFixedRoute({ level: 'memberoverride' }), true)
  assert.equal(isManualFixedRoute({ level: 'createexplicit' }), true)
  assert.equal(isManualFixedRoute({ level: 'captureddefault' }), true)
  assert.equal(isManualFixedRoute({ level: 'auto' }), false)
  assert.equal(isManualFixedRoute(null), false)
})

test('Host Endpoints & Routing: 完整集成测试 (GET/PUT teams, 鉴权, 乐观锁, 路由优先级, manual fixed 无 fallback)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tmm-host-test-'))
  process.env.DSH_HOME = home

  const { apply } = await import('../lib/index.js')

  // 假代理与团队成员模拟
  const leadAgent = {
    id: 'lead-session-1',
    session: {
      id: 'lead-session-1',
      header: { id: 'lead-session-1' }, // not subagent
      ownEvents: () => [],
    },
  }

  let currentTurn = 1
  let currentSelection = { provider: 'actual-p', model: 'actual-m' }
  const memberAgent = {
    id: 'member-agent-1',
    session: {
      id: 'member-agent-1',
      header: { id: 'member-agent-1', origin: 'subagent', delegationDepth: 1, parentSession: 'lead-session-1' },
      ownEvents: () => [
        { type: 'turn/start', data: { turn: currentTurn } },
        { type: 'request/header', data: {} }
      ],
      requestHeader: () => ({ config: { provider: 'actual-p', model: 'actual-m' } }),
    },
    // 模拟真实的 agent.model.select() 实现
    model: {
      current: () => currentSelection,
      select: (sel) => { currentSelection = { ...sel } }
    }
  }

  const rawSubagents = {
    async startContinuable(spec) { return { childId: 'c1' } },
    async start(name, req) { return { localAgent: {} } },
    getProvider(name) { return { capabilities: { agentOptions: true } } }
  }
  let routeHandlers = new Map()
  let eventListeners = new Map()

  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(names, cb) {
      cb(fakeCtx)
      return () => {}
    },
    tools: { register() { return () => {} } },
    skills: { register() { return () => {} } },
    llm: {
      listProviders: () => [{ id: 'prov-1', name: 'P1' }],
      listModels: async (p) => [{ id: 'mod-1', name: 'M1' }, { id: 'mod-2', name: 'M2' }],
      resolveModelInfo: async () => ({ id: 'mod-1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
    },
    subagents: rawSubagents,
    reflect: {
      store: {},
      _getImpl: (name) => name === 'subagents' ? { name, value: rawSubagents } : undefined,
    },
    webServer: {
      register: (desc) => {
        routeHandlers.set(desc.path, desc.handler)
        return () => {}
      },
    },
    sessionController: {
      resolveAgent: async (sid) => {
        if (sid === 'lead-session-1') return { agent: leadAgent }
        if (sid === 'member-agent-1') return { agent: memberAgent }
        return { error: new Error('not found') }
      },
    },
    agentTeams: {
      tryMembership: (agent) => {
        if (agent === leadAgent) return { role: 'lead', root: leadAgent, id: 'lead-session-1', name: 'lead' }
        if (agent === memberAgent) return { role: 'teammate', root: leadAgent, id: 'lead-session-1', name: 'worker-1' }
        return undefined
      },
      membership: (agent) => {
        const m = fakeCtx.agentTeams.tryMembership(agent)
        if (!m) throw new Error('not member')
        return m
      },
      listMembers: (root) => [
        { id: 'member-agent-1', name: 'worker-1', role: 'teammate', status: 'running' }
      ]
    },
    agents: {
      get: (id) => {
        if (id === 'lead-session-1') return leadAgent
        if (id === 'member-agent-1') return memberAgent
        return undefined
      },
      list: () => [leadAgent, memberAgent],
    },
    on(event, handler) {
      if (!eventListeners.has(event)) eventListeners.set(event, [])
      eventListeners.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      return () => {}
    },
    // 83 起设置接口按官方契约读 ctx.get('connection').requestRejection；
    // 旧桩缺这两个成员会让所有请求 500，这里最小补齐（不删任何既有断言）。
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return fakeCtx[name]
    }
  }

  rawSubagents.rootOf = (agent) => { if (agent === leadAgent || agent === memberAgent) return leadAgent; throw new Error('UNAUTHORIZED') }
  rawSubagents.listDescendants = async (rootId) => {
    if (rootId !== leadAgent.id) throw new Error('UNAUTHORIZED')
    return [{ kind: 'child', id: memberAgent.id, name: 'worker-1', path: 'worker-1', mode: 'continuable', activity: 'running', parentId: rootId, depth: 1, hasChildren: false }]
  }
  fakeCtx.agentTeams.isEnabled = (agent) => agent === leadAgent
  try {
    await apply(fakeCtx, {})

    const handler = routeHandlers.get('/api/dsh-team-member-model')
    assert.ok(handler, 'webServer 路由必须被注册')

    // 辅助调用 HTTP 路由
    async function request(method, path, body = null, headers = {}) {
      let resData = null
      let statusCode = 200
      const res = {
        writeHead(code, h) { statusCode = code },
        end(data) { resData = data },
        setHeader() {},
        get statusCode() { return statusCode },
        set statusCode(code) { statusCode = code },
      }
      const req = {
        method,
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost', ...headers },
        async *[Symbol.asyncIterator]() {
          if (body) yield Buffer.from(JSON.stringify(body))
        }
      }
      await handler(req, res)
      return { status: statusCode, json: resData ? JSON.parse(resData) : null }
    }

    // 1. GET /api/dsh-team-member-model/teams 鉴权与视图
    const getRes = await request('GET', '/api/dsh-team-member-model/teams?sessionId=lead-session-1')
    assert.equal(getRes.status, 200)
    assert.equal(getRes.json.ok, true)
    assert.equal(getRes.json.view.teamId, 'lead-session-1')
    assert.equal(getRes.json.view.revision, 0)
    assert.equal(getRes.json.view.members.length, 1)
    assert.equal(getRes.json.view.members[0].id, 'member-agent-1')
    assert.equal(getRes.json.view.members[0].name, 'worker-1')
    assert.deepEqual(getRes.json.view.members[0].currentModel, { provider: 'actual-p', model: 'actual-m' })

    // 2. PUT /teams 缺少安全标记头返回 403
    const putNoHeader = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-session-1',
      target: null,
      selection: { provider: 'prov-1', model: 'mod-1' },
      revision: 0
    })
    assert.equal(putNoHeader.status, 403)

    // 3. PUT /teams target 为 lead 自身被拒绝
    const putLeadTarget = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-session-1',
      target: 'lead-session-1',
      selection: { provider: 'prov-1', model: 'mod-1' },
      revision: 0
    }, { 'x-dsh-team-member-model': '1' })
    assert.equal(putLeadTarget.status, 400)
    assert.match(putLeadTarget.json.error, /Lead/i)

    // 4. PUT /teams target: null 设置未来默认模型
    const putDefault = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-session-1',
      target: null,
      selection: { provider: 'prov-1', model: 'mod-1', reasoningEffort: 'high' },
      revision: 0
    }, { 'x-dsh-team-member-model': '1' })
    assert.equal(putDefault.status, 200)
    assert.equal(putDefault.json.ok, true)
    assert.equal(putDefault.json.view.revision, 1)
    assert.deepEqual(putDefault.json.view.defaultModel, { provider: 'prov-1', model: 'mod-1', reasoningEffort: 'high' })

    // 5. 乐观锁冲突：传入旧 revision 0 应当返回 409
    const putConflict = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-session-1',
      target: null,
      selection: { provider: 'prov-1', model: 'mod-2' },
      revision: 0
    }, { 'x-dsh-team-member-model': '1' })
    assert.equal(putConflict.status, 409)
    assert.equal(putConflict.json.code, 'stale-revision')

    // 6. PUT /teams target: memberId 成员覆盖 (下轮生效)
    const putMember = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-session-1',
      target: 'member-agent-1',
      selection: { provider: 'prov-1', model: 'mod-2' },
      revision: 1
    }, { 'x-dsh-team-member-model': '1' })
    assert.equal(putMember.status, 200)
    assert.equal(putMember.json.view.revision, 2)
    assert.deepEqual(putMember.json.view.members[0].nextModel, { provider: 'prov-1', model: 'mod-2' })

    // 7. 路由拦截与优先级验证：
    const reqListeners = eventListeners.get('agent/request') || []
    assert.ok(reqListeners.length > 0)
    const reqHandler = reqListeners[0]

    // 正式模型选择发生于 claim，request 必须保持准备时配置。
    for (const handler of eventListeners.get('agent/inbox/claimed') || []) handler({ agent: memberAgent, turn: 1 })
    const config1 = await reqHandler({ agent: memberAgent }, async () => memberAgent.model.current())
    currentTurn = 2
    for (const handler of eventListeners.get('agent/inbox/claimed') || []) handler({ agent: memberAgent, turn: 2 })
    const config2 = await reqHandler({ agent: memberAgent }, async () => memberAgent.model.current())
    assert.equal(config2.provider, 'prov-1')
    assert.equal(config2.model, 'mod-2')

    // 8. 手动固定路由在 request-error 中放行 next()，不接管 fallback
    const errListeners = eventListeners.get('agent/request-error') || []
    const errHandler = errListeners[0]
    let nextCalled = false
    const errRes = await errHandler({
      agent: memberAgent,
      failure: { status: 500, message: 'Server Error' }
    }, async () => {
      nextCalled = true
      return { kind: 'unhandled' }
    })
    assert.equal(nextCalled, true, 'manual fixed 发生错误时必须直接 await next()，严禁 fallback')

  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P1-RED 1: agent/created 必须真实持久化 initials 到磁盘，冷重开不丢失且不受后改 default 污染', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tmm-p1-initials-'))
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/index.js')

  const lead = {
    id: 'lead-cold-1',
    session: { id: 'lead-cold-1', header: { id: 'lead-cold-1' }, ownEvents: () => [] }
  }
  const member = {
    id: 'mem-cold-1',
    session: {
      id: 'mem-cold-1',
      header: { id: 'mem-cold-1', origin: 'subagent', delegationDepth: 1, parentSession: 'lead-cold-1' },
      ownEvents: () => [],
      requestHeader: () => undefined,
    }
  }

  const rawSubagents = {
    async startContinuable(spec) { return { childId: 'c1' } },
    async start(name, req) { return { localAgent: {} } },
    getProvider(name) { return { capabilities: { agentOptions: true } } }
  }
  let routeHandlers = new Map()
  let eventListeners = new Map()

  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(names, cb) { cb(fakeCtx); return () => {} },
    tools: { register() { return () => {} } },
    skills: { register() { return () => {} } },
    llm: {
      listProviders: () => [{ id: 'p-snap', name: 'Snap P' }, { id: 'p-new', name: 'New P' }],
      listModels: async () => [{ id: 'm-snap' }, { id: 'm-new' }],
      resolveModelInfo: async () => ({ id: 'm-snap' }),
    },
    subagents: rawSubagents,
    reflect: { store: {}, _getImpl: (n) => n === 'subagents' ? { name: n, value: rawSubagents } : undefined },
    webServer: { register: (desc) => { routeHandlers.set(desc.path, desc.handler); return () => {} } },
    sessionController: { resolveAgent: async (sid) => ({ agent: sid === 'lead-cold-1' ? lead : member }) },
    agentTeams: {
      tryMembership: (agent) => {
        if (agent === lead) return { role: 'lead', root: lead, id: 'lead-cold-1', name: 'lead' }
        if (agent === member) return { role: 'teammate', root: lead, id: 'lead-cold-1', name: 'worker-cold' }
        return undefined
      },
      membership: (agent) => fakeCtx.agentTeams.tryMembership(agent),
      listMembers: () => [{ id: 'mem-cold-1', name: 'worker-cold', role: 'teammate', status: 'running' }]
    },
    agents: { get: (id) => id === 'lead-cold-1' ? lead : (id === 'mem-cold-1' ? member : undefined), list: () => [lead, member] },
    on(event, handler) {
      if (!eventListeners.has(event)) eventListeners.set(event, [])
      eventListeners.get(event).push(handler)
      return () => {}
    },
    effect() { return () => {} },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return fakeCtx[name]
    }
  }

  rawSubagents.rootOf = (agent) => { if (agent === lead || agent === member) return lead; throw new Error('UNAUTHORIZED') }
  rawSubagents.listDescendants = async (rootId) => {
    if (rootId !== lead.id) throw new Error('UNAUTHORIZED')
    return [{ kind: 'child', id: member.id, name: 'worker-cold', path: 'worker-cold', mode: 'continuable', activity: 'running', parentId: rootId, depth: 1, hasChildren: false }]
  }
  fakeCtx.agentTeams.isEnabled = (agent) => agent === lead
  try {
    await apply(fakeCtx, {})
    const handler = routeHandlers.get('/api/dsh-team-member-model')
    async function request(method, path, body = null, headers = {}) {
      let statusCode = 200, resData = null
      const res = { writeHead(c) { statusCode = c }, end(d) { resData = d }, setHeader() {}, get statusCode() { return statusCode }, set statusCode(c) { statusCode = c } }
      const req = { method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', ...headers }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
      await handler(req, res)
      return { status: statusCode, json: resData ? JSON.parse(resData) : null }
    }

    // 1. 设置默认模型为 p-snap/m-snap
    const putDef = await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-cold-1', target: null, selection: { provider: 'p-snap', model: 'm-snap' }, revision: 0
    }, { 'x-dsh-team-member-model': '1' })
    assert.equal(putDef.status, 200)

    // 2. 模拟触发 team/member provisioning 预约与 agent/created 实例化
    const sessEvt = eventListeners.get('session/event').find(fn => fn.length === 2)
    sessEvt({ id: 'lead-cold-1' }, { type: 'team/member', data: { version: 2, teamId: 'lead-cold-1', member: { id: 'mem-cold-1', name: 'worker-cold', phase: 'provisioning' } } })

    const agentCreatedHandler = eventListeners.get('agent/created')[0]
    await agentCreatedHandler({ agent: member })

    // 3. 修改 defaultModel 为 p-new/m-new
    const curV = await request('GET', '/api/dsh-team-member-model/teams?sessionId=lead-cold-1')
    await request('PUT', '/api/dsh-team-member-model/teams', {
      sessionId: 'lead-cold-1', target: null, selection: { provider: 'p-new', model: 'm-new' }, revision: curV.json.view.revision
    }, { 'x-dsh-team-member-model': '1' })

    // 4. 读取磁盘上的 teams.json 验证 initials 真实持久化
    const storeFile = new TeamStateStore(join(home, 'team-member-model'))
    await storeFile.init()
    const diskTeam = storeFile.getTeam('lead-cold-1')
    assert.ok(diskTeam.initials['mem-cold-1'], 'initials 必须在 agent/created 时写入磁盘文件 teams.json！')
    assert.equal(diskTeam.initials['mem-cold-1'].selection.model, 'm-snap', '磁盘上的快照绝不受后续改动的 defaultModel 污染！')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P1-RED 2: sessionController.resolveAgent 鉴权返回错误时必须拒绝，严禁 fallback 到 agents.get 越权', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tmm-p1-sec-'))
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/index.js')

  const lead = { id: 'lead-auth-1', session: { id: 'lead-auth-1', header: { id: 'lead-auth-1' }, ownEvents: () => [] } }
  const rawSubagents = { async startContinuable() {}, async start() {}, getProvider() {} }
  let routeHandlers = new Map()

  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(names, cb) { cb(fakeCtx); return () => {} },
    tools: { register() { return () => {} } },
    skills: { register() { return () => {} } },
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    subagents: rawSubagents,
    reflect: { store: {}, _getImpl: (n) => n === 'subagents' ? { name: n, value: rawSubagents } : undefined },
    webServer: { register: (desc) => { routeHandlers.set(desc.path, desc.handler); return () => {} } },
    sessionController: {
      resolveAgent: async (sid) => {
        // 模拟官方鉴权拒绝（跨租户或非所有权会话）
        return { error: { message: 'apiSessionSubagentOwnershipError', status: 403 } }
      }
    },
    agentTeams: {
      tryMembership: (agent) => {
        if (agent === lead) return { role: 'lead', root: lead, id: 'lead-auth-1', name: 'lead' }
        return undefined
      },
    },
    agents: {
      // 内存里确实存在此 agent，但 sessionController 明确鉴权拒绝了
      get: (id) => id === 'lead-auth-1' ? lead : undefined,
    },
    on() { return () => {} },
    effect() { return () => {} },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return fakeCtx[name]
    }
  }

  try {
    await apply(fakeCtx, {})
    const handler = routeHandlers.get('/api/dsh-team-member-model')
    async function request(method, path) {
      let statusCode = 200, resData = null
      const res = { writeHead(c) { statusCode = c }, end(d) { resData = d }, setHeader() {}, get statusCode() { return statusCode }, set statusCode(c) { statusCode = c } }
      const req = { method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() {} }
      await handler(req, res)
      return { status: statusCode, json: resData ? JSON.parse(resData) : null }
    }

    const res = await request('GET', '/api/dsh-team-member-model/teams?sessionId=lead-auth-1')
    assert.equal(res.status, 403, 'sessionController 返回错误时必须直接拒绝 403，绝不能 fallback 到 agents.get')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
