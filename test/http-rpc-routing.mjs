/**
 * test/http-rpc-routing.mjs
 * 真实 HTTP socket 端到端：生产 lib/client.js → 真 node:http server（WebServer 的
 * exact/最长 prefix 规则）→ 本插件独立 RPC channel 路由 → 真 Host 业务。
 *
 * 为什么还要这一层：85/86 的测试直接桥 handler，不经过 HTTP；0.7.6 线上因此漏掉
 * 「自注册 HTTP prefix 把 RPC POST 截成 405」。0.7.7 又暴露第二个问题：官方 `/api`
 * 是单槽 interceptor，被 api-gateway 占用（见 test/rpc-lifecycle.mjs 的真实 SDK 回归）。
 *
 * 当前设计：RPC 走独立 channel `/dsh-team-member-model`（plugin 自己挂 prefix 路由 +
 * 官方 `connection.admit()` 鉴权），HTTP 设置页仍在 `/api/dsh-team-member-model`。
 * 这里用真实 socket 验证两者互不遮挡，并保证旧 HTTP 接口语义不变。
 *
 * 运行：node --test test/http-rpc-routing.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'

import { apply } from '../lib/index.js'
import { createIntegrationHost, createLeadAgent, createTeammateAgent } from './integration-support.mjs'

const HTTP_BASE = '/api/dsh-team-member-model'
const RPC_CHANNEL = '/dsh-team-member-model'
const RPC = 'team-member-model'
const RPC_OPS = ['state', 'efforts', 'usage', 'teams', 'savePolicy', 'saveTeam', 'resetUsage']
const PAYLOADS = {
  state: {},
  efforts: { provider: 'zai-coding-cn', model: 'glm-5.3' },
  usage: {},
  teams: { sessionId: 'lead-1' },
  savePolicy: { policy: { members: [], rules: [] } },
  saveTeam: { sessionId: 'lead-1', target: null, selection: null, revision: 0 },
  resetUsage: {},
}
const PEER = { id: 'peer-owner', principal: { kind: 'owner' } }
const nodeFetch = globalThis.fetch.bind(globalThis)
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * WebServer 的匹配规则（dsh-host-webserver/lib/index.js:495-504）：exact 优先，
 * 其次最长 prefix（pathname === prefix 或 prefix + '/'）。这里只复刻**测试服务器**的
 * 路由分发，RPC envelope/鉴权/业务全部由真实插件与真实 Host 代码处理。
 */
function matchRoute(routes, pathname) {
  const exact = routes.find(route => route.kind === 'exact' && route.path === pathname)
  if (exact !== undefined) return exact
  let best
  for (const route of routes) {
    if (route.kind !== 'prefix') continue
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
    if (best === undefined || route.path.length > best.path.length) best = route
  }
  return best
}

/** 真 node:http server：只挂本插件 apply() 真正注册的 route。 */
async function startRouter(host) {
  const routes = host.captured.routes.map(route => ({ kind: route.kind, path: route.path, handler: route.handler }))
  const seen = []
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const route = matchRoute(routes, pathname)
    seen.push({ method: req.method, pathname, route: route?.path })
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, routes, close: () => new Promise(resolve => server.close(resolve)) }
}

/** 生产 Client（真跑 lib/client.js）；rpc.call 走真实 HTTP POST（官方 wire）。 */
function loadClient(origin) {
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

  const wire = []
  let rpcId = 0
  const connection = {
    rpc: {
      async call(channel, endpoint, payload, signal) {
        const url = `${origin}${channel}/${endpoint}`
        const response = await nodeFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${++rpcId}`, method: endpoint, payload }),
          ...(signal === undefined ? {} : { signal }),
        })
        wire.push({ url, status: response.status })
        if (response.status !== 200) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
        const message = await response.json()
        return message.result
      },
    },
  }
  const ctx = {
    slots: { inject: (name, fn) => fn(), register: () => ({ options: {}, component: null }) },
    connection,
  }
  mod.apply(ctx)
  return { mod, ctx, pageFetches, wire }
}

async function startHost() {
  const connection = {
    requestRejection: () => undefined,
    admit: () => ({ peer: PEER }),
  }
  const host = await createIntegrationHost({ connection })
  const lead = host.registerLead(createLeadAgent('lead-1'))
  host.registerTeammate(lead, createTeammateAgent('member-1', 'lead-1', 'worker-1'), 'worker-1')
  await apply(host.ctx, {})
  return { host }
}

test('独立 RPC channel 与旧 HTTP prefix 分离：POST 不再被 HTTP 路由截获', async () => {
  const { host } = await startHost()
  const router = await startRouter(host)
  try {
    const route = matchRoute(router.routes, `${RPC_CHANNEL}/${RPC}/teams`)
    assert.equal(route.path, RPC_CHANNEL, 'RPC POST 由独立 channel 路由接住')
    assert.equal(router.routes.some(entry => entry.path === HTTP_BASE), true, '旧 HTTP 路由仍在')
    assert.equal(RPC_CHANNEL.startsWith(HTTP_BASE), false)
    assert.equal(HTTP_BASE.startsWith(`${RPC_CHANNEL}/`), false, '两个路由不得互为前缀')
  } finally {
    await router.close()
    await host.cleanup()
  }
})

test('旧 HTTP prefix 收到 RPC POST 仍然 405（不 fallback、不绕 guard）', async () => {
  const { host } = await startHost()
  const router = await startRouter(host)
  try {
    const response = await nodeFetch(`${router.origin}${HTTP_BASE}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-old', method: `${RPC}/teams`, payload: {} }),
    })
    assert.equal(response.status, 405)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.match(body.error, /method not allowed/)
  } finally {
    await router.close()
    await host.cleanup()
  }
})

test('生产 Client → 真实 HTTP socket → 独立 channel → Host 业务：7 端点全通', async () => {
  const { host } = await startHost()
  const router = await startRouter(host)
  try {
    const client = loadClient(router.origin)
    for (const endpoint of RPC_OPS) {
      const body = await client.mod._request(endpoint, PAYLOADS[endpoint] ?? {})
      assert.equal(body.ok, true, `${endpoint} 必须返回业务 JSON`)
    }
    assert.equal(client.wire.length, RPC_OPS.length)
    for (const call of client.wire) {
      assert.equal(call.status, 200)
      assert.ok(call.url.includes(`${RPC_CHANNEL}/${RPC}/`), `实际请求：${call.url}`)
    }
    const rpcSeen = router.seen.filter(entry => entry.method === 'POST' && entry.pathname.startsWith(`${RPC_CHANNEL}/`))
    assert.ok(rpcSeen.length >= RPC_OPS.length)
    for (const entry of rpcSeen) assert.equal(entry.route, RPC_CHANNEL, `${entry.pathname} 被 ${entry.route} 接走`)
    assert.equal(client.pageFetches.length, 0)
  } finally {
    await router.close()
    await host.cleanup()
  }
})

test('RPC 写与旧 HTTP 读同一份状态；旧 HTTP GET/PUT 语义不变', async () => {
  const { host } = await startHost()
  const router = await startRouter(host)
  try {
    const client = loadClient(router.origin)
    await client.mod._request('savePolicy', { policy: { members: [], rules: [] } })
    const state = await (await nodeFetch(`${router.origin}${HTTP_BASE}/state`)).json()
    assert.equal(state.ok, true)
    assert.deepEqual(state.policy.members, [])
    assert.equal(state.policy.routing, 'order')

    const readPolicy = await (await nodeFetch(`${router.origin}${HTTP_BASE}/teams?sessionId=lead-1`)).json()
    assert.equal(readPolicy.ok, true)
    const saved = await client.mod._request('saveTeam', { sessionId: 'lead-1', target: 'member-1', selection: { provider: 'zai-coding-cn', model: 'glm-5.3' }, revision: 0 })
    assert.equal(saved.view.members.find(m => m.id === 'member-1').nextModel.provider, 'zai-coding-cn')

    const noHeader = await nodeFetch(`${router.origin}${HTTP_BASE}/policy`, { method: 'PUT', body: JSON.stringify({ members: [] }) })
    assert.equal(noHeader.status, 403, 'HTTP 写操作仍然需要标记头')
    const withHeader = await nodeFetch(`${router.origin}${HTTP_BASE}/policy`, {
      method: 'PUT',
      headers: { 'x-dsh-team-member-model': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ members: [] }),
    })
    assert.equal(withHeader.status, 200)
  } finally {
    await router.close()
    await host.cleanup()
  }
})
