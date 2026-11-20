/**
 * test/remote-integration.mjs
 * 远程链路端到端：真实 lib/client.js（生产 VM）→ 真实 lib/index.js 注册的官方 RPC 拦截器 → 真实业务 dispatch。
 *
 * 为什么还要这一层：85/86 各自的测试各自证明了一半——Host 侧只证明「handler 被这样调用会返回什么」，
 * Client 侧只证明「请求被这样发出去」。两边都绿，仍可能一方发 `savePolicy` 裸文档、另一方要求 `{policy}`，
 * 或者 Client 把 page origin 当成目标 Host。这里把两半接在一条线上，并且用隔离的 tmp DSH_HOME 观察
 * 「哪台 Host 的状态真的变了」。
 *
 * 边界（不夸大）：
 *   - 认证判定是官方 connection.requestRejection / rpc 的**委托点**（本测试注入 verdict），
 *     不是重写官方 Host/Origin/凭据算法，也不是浏览器真实 cookie 流程。
 *   - 生产 Client 的沙箱 fetch 一律抛错并计数：模型设置不应再走页面 origin 的 fetch。
 *
 * 运行：node --test test/remote-integration.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { apply } from '../lib/index.js'
import { createIntegrationHost, createLeadAgent, createTeammateAgent, makeReq, makeRes } from './integration-support.mjs'

const NAME = 'dsh-team-member-model'
const RPC_CHANNEL = '/dsh-team-member-model'
/** RPC endpoint namespace：必须与 HTTP prefix 分离（最长 prefix 优先）。 */
const RPC = 'team-member-model'
const BASE = `/api/${NAME}`
const PEER = { id: 'peer-owner', principal: { kind: 'owner' } }
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 官方 Connection 桩：只提供本插件用到的 requestRejection + rpc.intercept，返回真 disposer。 */
function officialConnection(verdict) {
  const channels = []
  const connection = {
    requestRejection: (request) => {
      connection.seen.push(request.headers)
      return verdict
    },
    seen: [],
    admit: () => ({ peer: PEER }),
    rpc: {
      intercept(channel, matches, handler) {
        const entry = { channel, matches, handler, disposed: 0 }
        channels.push(entry)
        return async () => { entry.disposed += 1 }
      },
    },
  }
  return { connection, channels }
}

/** 起一台 Host：register 团队 → apply → 拿到真注册的 RPC 路由。 */
async function startHost(verdict) {
  const { connection } = officialConnection(verdict)
  const host = await createIntegrationHost({ connection })
  const lead = host.registerLead(createLeadAgent('lead-1'))
  host.registerTeammate(lead, createTeammateAgent('member-1', 'lead-1', 'worker-1'), 'worker-1')
  await apply(host.ctx, {})
  const route = host.captured.routes.find(entry => entry.path === RPC_CHANNEL)
  assert.ok(route, `Host 必须注册 ${RPC_CHANNEL} RPC 路由`)
  return { host, channel: route }
}

/** 生产 Client：真跑 lib/client.js，页面 fetch 一律炸并计数。 */
function loadClient(connection) {
  const pageFetches = []
  const sandbox = {
    console,
    fetch: (url) => {
      pageFetches.push(String(url))
      throw new Error(`模型设置不得使用页面 fetch：${url}`)
    },
    document: {
      head: { appendChild() {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      addEventListener() {},
      removeEventListener() {},
    },
    // 故意写成「本机页面」：目标 Host 只能由 connection 决定。
    window: {
      location: { origin: 'http://127.0.0.1:55340', hostname: '127.0.0.1' },
      __ModuleLoader__: { load(def) { sandbox.window.__ModuleLoader__.loaded = def } },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })

  const definition = sandbox.window.__ModuleLoader__.loaded
  const noop = () => {}
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState: (init) => [init, noop],
    useEffect: noop,
    useRef: (init) => ({ current: init }),
  }
  const mod = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`严格沙箱：未允许的 require：${name}`)
  })
  const ctx = {
    slots: { inject: (name, fn) => fn(), register: () => ({ options: {}, component: null }) },
    connection,
  }
  mod.apply(ctx)
  return { mod, ctx, pageFetches }
}

/** 把 Client 的 rpc.call 桥到真 Host 路由：POST channel/<endpoint> + 官方 envelope。 */
function bridgeTo(route) {
  const calls = []
  return {
    calls,
    connection: {
      rpc: {
        async call(usedChannel, endpoint, payload, signal) {
          calls.push({ channel: usedChannel, endpoint, payload })
          assert.equal(usedChannel, RPC_CHANNEL)
          const req = makeReq('POST', `${RPC_CHANNEL}/${endpoint}`, { 'content-type': 'application/json' }, JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload: payload || {} }))
          const res = makeRes()
          await route.handler(req, res)
          if (res.statusCode >= 400) return { ok: false, error: { code: 'gateway/internal', message: `HTTP ${res.statusCode} ${res.body}`, details: {} } }
          return JSON.parse(res.body).result
        },
      },
    },
  }
}

async function teams(host, sessionId = 'lead-1') {
  return host.apiRequest('GET', `${BASE}/teams?sessionId=${sessionId}`)
}

test('生产 Client → 真 Host 拦截器：7 个端点全通，页面 fetch 为 0', async () => {
  const { host, channel } = await startHost(undefined)
  try {
    const { mod, pageFetches } = loadClient(bridgeTo(channel).connection)
    const state = await mod._request('state', {})
    assert.equal(state.ok, true, 'state 必须返回原 HTTP JSON')
    assert.ok(Array.isArray(state.catalog), 'catalog 与 HTTP 同源')

    const efforts = await mod._request('efforts', { provider: 'zai-coding-cn', model: 'glm-5.3' })
    assert.equal(efforts.provider, 'zai-coding-cn')

    const usage = await mod._request('usage', {})
    assert.equal(typeof usage.totals.totalTokens, 'number')

    const view = await mod._request('teams', { sessionId: 'lead-1' })
    assert.equal(view.view.teamId, 'lead-1')

    const policy = await mod._request('savePolicy', { policy: { members: [], rules: [] } })
    assert.equal(policy.policy.members.length, 0)
    assert.deepEqual((await host.apiRequest('GET', `${BASE}/state`)).body.policy, policy.policy, 'RPC 与 HTTP 读同一份策略')

    await mod._request('resetUsage', {})
    assert.equal((await mod._request('usage', {})).totals.totalTokens, 0)

    assert.equal(pageFetches.length, 0, `页面 fetch 调用：${pageFetches.join(', ')}`)
  } finally { await host.cleanup() }
})

test('写到「连接的」那台 Host：remote 状态变、页面本机不变，切到另一台后旧 Host 不再收到写', async () => {
  const remote = await startHost(undefined)
  let local
  try {
    local = await startHost(undefined)
    const remoteBridge = bridgeTo(remote.channel)
    const localBridge = bridgeTo(local.channel)
    const { mod, ctx, pageFetches } = loadClient(remoteBridge.connection)

    const before = await mod._request('teams', { sessionId: 'lead-1' })
    // 生产路径：菜单打开时先 fetchView 拿到 revision，写操作才带正确的 CAS 版本。
    const controller = new mod._TeamController({ sessionId: 'lead-1' })
    await controller.fetchView()
    const view = await controller.saveDefault({ provider: 'zai-coding-cn', model: 'glm-5.3' })
    assert.deepEqual(view.defaultModel, { provider: 'zai-coding-cn', model: 'glm-5.3' })
    assert.notEqual(view.revision, before.view.revision, 'remote revision 必须前进')

    assert.equal((await teams(local.host)).body.view.revision, 0, '页面本机 Host 的团队状态必须没动')
    assert.equal(existsSync(join(local.host.dshHome, 'team-member-model', 'teams.json')), false, '本机不得落盘团队状态')

    const remoteRevision = view.revision
    ctx.connection = localBridge.connection // 同一次 apply 内换连接（重连/换远端）
    const switched = await mod._request('teams', { sessionId: 'lead-1' })
    assert.equal(switched.view.revision, 0, '换连接后读到的是新 Host 的状态')
    const switchedController = new mod._TeamController({ sessionId: 'lead-1' })
    await switchedController.fetchView()
    await switchedController.saveMember('member-1', { provider: 'p-real', model: 'm-real' })
    assert.equal(remoteBridge.calls.filter(c => c.endpoint.endsWith('/saveTeam')).length, 1, '旧连接只收到切换前那一次写')
    assert.equal((await teams(remote.host)).body.view.revision, remoteRevision, '切换后旧 Host 不再被写')
    assert.equal(pageFetches.length, 0)
  } finally {
    if (local) await local.host.cleanup()
    await remote.host.cleanup()
  }
})

test('selection 语义与 HTTP 一致：默认/成员/继承，空档位不上送', async () => {
  const { host, channel } = await startHost(undefined)
  try {
    const { mod } = loadClient(bridgeTo(channel).connection)
    // 生产路径：先 fetchView 取 revision，再写（CAS 依赖它）。
    const controller = async (sessionId = 'lead-1') => {
      const fresh = new mod._TeamController({ sessionId })
      await fresh.fetchView()
      return fresh
    }

    let view = await (await controller()).saveMember('member-1', { provider: 'zai-coding-cn', model: 'glm-5.3' })
    let member = view.members.find(m => m.id === 'member-1')
    assert.deepEqual(member.nextModel, { provider: 'zai-coding-cn', model: 'glm-5.3' }, '未选档位时不得凭空造 reasoningEffort')
    assert.equal(Object.hasOwn(member.nextModel, 'reasoningEffort'), false)

    view = await (await controller()).saveMember('member-1', { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high' })
    assert.equal(view.members.find(m => m.id === 'member-1').nextModel.reasoningEffort, 'high')

    // 清成员覆盖 = 对同一成员写 selection:null（不是 restoreInheritance：那条只清未来默认）。
    view = await (await controller()).saveMember('member-1', null)
    assert.equal(view.members.find(m => m.id === 'member-1').nextModel, undefined, '清空成员覆盖后回继承')

    view = await (await controller()).saveDefault({ provider: 'p-default', model: 'm-default' })
    assert.deepEqual(view.defaultModel, { provider: 'p-default', model: 'm-default' })
    const inherit = await (await controller()).restoreInheritance()
    assert.equal(inherit.defaultModel, null)

    const refused = await (await controller()).saveMember('lead-1', { provider: 'p-real', model: 'm-real' })
      .then(() => undefined, (error) => error)
    assert.equal(refused.status, 400, 'Lead 不可作为队员被改')
    assert.match(refused.message, /Lead 不可/)
  } finally { await host.cleanup() }
})

test('业务错误原样上抛且不重试：stale 409 / 跨 session 403 / 未知成员 404', async () => {
  const { host, channel } = await startHost(undefined)
  try {
    const bridge = bridgeTo(channel)
    const { mod } = loadClient(bridge.connection)

    const stale = await mod._request('saveTeam', { sessionId: 'lead-1', target: 'member-1', selection: null, revision: 99 })
      .then(() => undefined, (error) => error)
    assert.equal(stale.status, 409)
    assert.equal(stale.code, 'stale-revision')
    assert.equal(bridge.calls.length, 1, '409 不得暗地重试')

    const cross = await mod._request('teams', { sessionId: 'member-1' }).then(() => undefined, (error) => error)
    assert.equal(cross.status, 403, '队员 session 不能读 Lead 的团队')

    const unknownMember = await mod._request('saveTeam', {
      sessionId: 'lead-1', target: 'ghost-1', selection: null, revision: 0,
    }).then(() => undefined, (error) => error)
    assert.equal(unknownMember.status, 404)
  } finally { await host.cleanup() }
})

test('官方 outer 拒绝：认证失败是「已知失败」，断连才是「未确认」，都不退回页面 fetch', async () => {
  const { host, channel } = await startHost(undefined)
  try {
    const denied = {
      rpc: { async call() { return { ok: false, error: { code: 'unauthorized', message: '远程连接未通过官方认证', details: { status: 401 } } } } },
    }
    const deniedClient = loadClient(denied)
    const authError = await deniedClient.mod._request('savePolicy', { policy: { members: [], rules: [] } })
      .then(() => undefined, (error) => error)
    assert.equal(authError.code, 'unauthorized')
    assert.equal(authError.unknown, false, '认证没过 = 写入确定没发生，不能标未确认')
    assert.equal(deniedClient.pageFetches.length, 0)

    const lost = { rpc: { async call() { throw new Error('socket closed') } } }
    const lostClient = loadClient(lost)
    const writeError = await lostClient.mod._request('savePolicy', { policy: { members: [], rules: [] } })
      .then(() => undefined, (error) => error)
    assert.equal(writeError.code, 'NETWORK_ERROR')
    assert.equal(writeError.unknown, true, '传输断在写操作上 = 结果未确认')
    const readError = await lostClient.mod._request('state', {}).then(() => undefined, (error) => error)
    assert.equal(readError.code, 'NETWORK_ERROR')
    assert.equal(readError.unknown, undefined, '读操作不冒充「已提交」')
    assert.equal(lostClient.pageFetches.length, 0, 'RPC 故障也绝不 fallback 本页 fetch')
  } finally { await host.cleanup() }
})

test('未知端点与缺失 connection：当场拒绝，一个请求都不发', async () => {
  let calls = 0
  const counting = { rpc: { async call() { calls += 1; return { ok: true, value: { status: 200, body: { ok: true } } } } } }
  const { mod, pageFetches } = loadClient(counting)
  const unknown = await mod._request('routes', { routes: [] }).then(() => undefined, (error) => error)
  assert.equal(unknown.code, 'UNKNOWN_ENDPOINT')
  assert.equal(calls, 0)
  assert.equal(pageFetches.length, 0)

  const bare = loadClient(undefined)
  const noConnection = await bare.mod._request('state', {}).then(() => undefined, (error) => error)
  assert.equal(noConnection.code, 'NO_CONNECTION')
  assert.match(noConnection.message, /connection\.rpc/)
  assert.equal(bare.pageFetches.length, 0)

  const { host, channel } = await startHost(undefined)
  try {
    // 未知 endpoint 仍被 Host 的 7-op 白名单拒绝（路由只按 channel 前缀命中）。
    const unknown = await bridgeTo(channel).connection.rpc.call(RPC_CHANNEL, `${RPC}/routes`, {})
    assert.equal(unknown.ok, true)
    assert.equal(unknown.value.status, 404)
    const known = await bridgeTo(channel).connection.rpc.call(RPC_CHANNEL, `${RPC}/state`, {})
    assert.equal(known.ok, true)
    assert.equal(known.value.status, 200)
  } finally { await host.cleanup() }
})

test('HTTP 侧：官方 verdict 委托 + 缺服务 fail-closed（RPC 不替代、不放宽）', async () => {
  // 这一条只测「是否把官方判定前置到全部 HTTP API」，官方 Host/Origin/凭据算法本身不在本仓复刻。
  for (const [name, verdict, expected] of [['通过', undefined, 200], ['未认证', 401, 401], ['跨来源', 403, 403]]) {
    const verdictHost = await startHost(verdict)
    try {
      const state = await verdictHost.host.apiRequest('GET', `${BASE}/state`, { host: 'remote.example:443', origin: 'https://remote.example' })
      assert.equal(state.status, expected, `${name}：官方判定必须原样透传`)
      assert.equal(verdictHost.host.ctx.get('connection').seen.length, 1)
      if (verdict === undefined) {
        const write = await verdictHost.host.apiRequest('PUT', `${BASE}/policy`, { 'x-dsh-team-member-model': '1' }, { members: [], rules: [] })
        assert.equal(write.status, 200)
        const noHeader = await verdictHost.host.apiRequest('PUT', `${BASE}/policy`, {}, { members: [], rules: [] })
        assert.equal(noHeader.status, 403, 'HTTP 写操作标记头仍然保留（RPC 不需要它不是放宽 HTTP）')
      }
    } finally { await verdictHost.host.cleanup() }
  }

  const bare = await createIntegrationHost({ connection: {} })
  try {
    await apply(bare.ctx, {})
    for (const [method, path] of [['GET', '/state'], ['GET', '/efforts'], ['GET', '/usage'], ['GET', '/teams'], ['PUT', '/policy'], ['PUT', '/teams'], ['PUT', '/usage/reset']]) {
      const result = await bare.apiRequest(method, BASE + path)
      assert.equal(result.status, 503, `${method} ${path} 缺 connection 必须 fail-closed`)
    }
  } finally { await bare.cleanup() }
})
