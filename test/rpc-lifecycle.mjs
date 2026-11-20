/**
 * test/rpc-lifecycle.mjs
 * 真实 Cordis + 真实官方 Connection 的生命周期/路由回归：0.7.7 线上 404 的根因。
 *
 * 根因（91 现场+源码证据）：官方 `/api` 是**单槽 interceptor**——`interceptors` Map
 * （dsh-client-connection lib/index.js:700），重复注册直接 throw（:873-886）。
 * 官方 api-gateway 先占了 `/api` 槽，本插件 0.7.6/0.7.7 的 `rpc.intercept('/api', …)`
 * 必然抛 "already has an interceptor"，又被旧代码 warn 吞掉 → carrier 对
 * `team-member-model/*` 只回 404（`createSharedFetchHandler` :820-838）。
 * 只补 required `connection` inject 没用：槽位冲突与启动顺序无关。
 *
 * 修复后：Host 用官方 `connection.rpc.handle('/dsh-team-member-model', handler)` 自挂
 * 独立 prefix 路由（同文件 :855-872：admit + rpcFetchHandler + owner.effect disposer），
 * Client `rpc.call('/dsh-team-member-model', 'team-member-model/<op>', …)`。
 *
 * 本测试跑**真实框架与真实 carrier**：真实 @deepseek-ai/cordis 4.0.5、
 * 真实 @deepseek-ai/dsh-client-connection 0.2.1-rc.2、真实 @deepseek-ai/dsh-host-webserver
 * 0.2.1-rc.2，真 node:http socket + 官方路由/envelope，不复制任何 resolver。
 * 依赖装在工作区外（不碰 profile/core），可用 DSH_REAL_SDK_DIR 指定；找不到就显式跳过。
 *
 * 运行：node --test test/rpc-lifecycle.mjs
 * 准备：mkdir -p ~/.cache/dsh-tmm-lifecycle-sdk && cd 该目录 && npm init -y &&
 *       npm i @deepseek-ai/cordis@4.0.5 @deepseek-ai/dsh-client-connection@0.2.1-rc.2 \
 *             @deepseek-ai/dsh-host-webserver@0.2.1-rc.2
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const SDK_ROOTS = [
  process.env.DSH_REAL_SDK_DIR,
  join(homedir(), '.cache', 'dsh-tmm-lifecycle-sdk'),
  '/tmp/dsh-real-sdk',
].filter(Boolean)

function resolveSdk() {
  for (const root of SDK_ROOTS) {
    const of = (...segments) => join(root, 'node_modules', '@deepseek-ai', ...segments)
    if (existsSync(of('cordis', 'lib', 'index.js')) &&
        existsSync(of('dsh-client-connection', 'lib', 'index.js')) &&
        existsSync(of('dsh-host-webserver', 'lib', 'index.js'))) {
      return { cordis: of('cordis', 'lib', 'index.js'), connection: of('dsh-client-connection', 'lib', 'index.js'), webserver: of('dsh-host-webserver', 'lib', 'index.js') }
    }
  }
  return undefined
}

const sdk = resolveSdk()
if (sdk === undefined) {
  console.error(
    '[rpc-lifecycle] 缺少真实 SDK，跳过（不是通过）。安装命令：\n' +
      '  mkdir -p ~/.cache/dsh-tmm-lifecycle-sdk && cd ~/.cache/dsh-tmm-lifecycle-sdk && npm init -y &&\n' +
      '  npm i @deepseek-ai/cordis@4.0.5 @deepseek-ai/dsh-client-connection@0.2.1-rc.2 @deepseek-ai/dsh-host-webserver@0.2.1-rc.2\n' +
      '或用 DSH_REAL_SDK_DIR 指向该目录。',
  )
}

const lifecycleTest = sdk === undefined ? test.skip : test

let Context
let HostConnectionService
let WebServer
if (sdk !== undefined) {
  ;({ Context } = await import(pathToFileURL(sdk.cordis).href))
  ;({ HostConnectionService } = await import(pathToFileURL(sdk.connection).href))
  ;({ WebServer } = await import(pathToFileURL(sdk.webserver).href))
}

const CHANNEL = '/dsh-team-member-model'
/** 本插件只验证 RPC 生命周期；browserAuth 用最小替身（真实 cookie 流程不在本测试范围）。 */
const browserAuth = { isAuthenticated: () => true, authenticateApi: () => undefined }

function agent(id) {
  return { id, session: { id, header: { id, cwd: '/' }, ownEvents: () => [], snapshotEvents: () => [] } }
}

/** 插件 inject 需要的服务替身；webServer 用真实实现。 */
const stubs = {
  tools: { register: () => () => {} },
  subagents: {
    start: async () => ({ localAgent: {} }),
    startContinuable: async () => ({ childId: 'c' }),
    startLocal: async () => ({}),
    startExternal: async () => ({}),
    startActivation: async () => ({}),
    rootOf: (a) => a,
    listDescendants: async () => [],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
  },
  sessionController: { resolveAgent: async (id) => ({ agent: agent(id) }) },
  agentTeams: {
    isEnabled: () => true,
    tryMembership: (a) => ({ role: 'lead', root: a, id: a?.id, name: 'lead' }),
    membership: (a) => ({ role: 'lead', root: a, id: a?.id, name: 'lead' }),
    listMembers: () => [],
  },
  llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
}

const pluginModule = await import('../lib/index.js')
const PLUGIN = { name: 'team-member-model', inject: pluginModule.inject, apply: pluginModule.apply }

/** 官方 api-gateway 的最小替身：先占住 `/api` 单槽（只 claim 自己的 2 段 typert 端点）。 */
const GATEWAY = {
  name: 'gateway-occupant',
  inject: ['connection'],
  apply(ctx) {
    ctx.connection.rpc.intercept('/api', (endpoint) => /^[a-z]+\/[a-zA-Z]+$/.test(endpoint) && !endpoint.startsWith('team-member-model/'), async () => ({ ok: true, value: { status: 200, body: { ok: true, gateway: true } } }))
  },
}

function provideConnection(ctx, trustedHosts = []) {
  return ctx.plugin({
    name: 'connection-provider',
    apply: (c) => { new HostConnectionService(c, trustedHosts, browserAuth) },
  })
}

function provideWeb(ctx) {
  return ctx.plugin({
    name: 'web-server',
    // WebServer 作为普通实例创建时不会自动 listen：官方 loader 会调用 Service.init，这里显式调用。
    apply: async (c) => { const web = new WebServer(c, { host: '127.0.0.1', port: 0, compression: 'none' }); await web[WebServer.init]() },
  })
}

async function withRuntime(run) {
  const home = await mkdtemp(join(tmpdir(), 'tmm-lifecycle-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const disposers = []
  try {
    const web = provideWeb(ctx)
    await web
    disposers.push(() => web.dispose())
    const stubFiber = ctx.plugin({ name: 'stub-services', apply: (c) => { for (const [name, value] of Object.entries(stubs)) c.provide(name, value) } })
    await stubFiber
    disposers.push(() => stubFiber.dispose())
    const origin = ctx.get('webServer').getOrigin()
    await run({ ctx, origin, disposers })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

function envelope(endpoint, payload = {}) {
  return JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload })
}

async function post(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { status: response.status, text: await response.text() }
}

const TEAMS_PATH = `${CHANNEL}/team-member-model/teams`

async function waitFor(check, message, timeoutMs = 3000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last !== undefined && last !== false) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${message}（超时 ${timeoutMs}ms，最后一次：${JSON.stringify(last)}）`)
}

lifecycleTest('真实 Cordis+Connection：/api 单槽被 gateway 占住时，本插件走独立 channel 仍 200', async () => {
  await withRuntime(async ({ ctx, origin, disposers }) => {
    // 插件先于 connection 加载（真实启动顺序 race），随后 gateway 占 /api 槽，最后 connection 就绪。
    const pluginFiber = ctx.plugin(PLUGIN)
    await pluginFiber
    disposers.push(() => pluginFiber.dispose())
    const gatewayFiber = ctx.plugin(GATEWAY)
    await gatewayFiber
    disposers.push(() => gatewayFiber.dispose())
    assert.equal(ctx.get('connection'), undefined, '复现 race：apply 时 connection 尚未就绪')

    const connectionFiber = provideConnection(ctx)
    await connectionFiber
    disposers.push(() => connectionFiber.dispose())

    // 91 的证据在真实实现上复现：/api 槽只能有一个 interceptor，重复注册即 throw。
    const connection = ctx.get('connection')
    assert.throws(
      () => connection.rpc.intercept('/api', () => false, async () => ({ ok: true, value: undefined })),
      /already has an interceptor/,
      '/api 是单槽 interceptor',
    )

    const result = await waitFor(async () => {
      const probe = await post(origin, TEAMS_PATH, envelope('team-member-model/teams', { sessionId: 'lead-1' }))
      return probe.status === 200 ? probe : undefined
    }, '独立 channel 的 RPC 没有注册成功')
    const body = JSON.parse(result.text)
    assert.equal(body.type, 'server-response')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.status, 200)
    assert.equal(body.result.value.body.view.teamId, 'lead-1')

    // 我们没抢 /api：那是 gateway 的槽位，本测试里 connection 的 /api 路由并未由测试
    // 装配（真实 apply 才注册），所以只断言「单槽仍被 gateway 占着」这一事实本身。
    // 非本插件 endpoint 在自己的 channel 上是业务 404，不会落到别的插件。
    const unknown = await post(origin, `${CHANNEL}/team-member-model/unknown`, envelope('team-member-model/unknown'))
    assert.equal(JSON.parse(unknown.text).result.value.status, 404)
  })
})

lifecycleTest('真实 Cordis+Connection：connection 替换后，独立 channel 在新实例上重新注册', async () => {
  await withRuntime(async ({ ctx, origin, disposers }) => {
    const pluginFiber = ctx.plugin(PLUGIN)
    await pluginFiber
    disposers.push(() => pluginFiber.dispose())
    const first = provideConnection(ctx)
    await first
    await waitFor(async () => (await post(origin, TEAMS_PATH, envelope('team-member-model/teams', { sessionId: 'lead-1' }))).status === 200, '首个 connection 未注册成功')

    await first.dispose()
    const second = provideConnection(ctx)
    await second
    disposers.push(() => second.dispose())
    const again = await waitFor(async () => {
      const probe = await post(origin, TEAMS_PATH, envelope('team-member-model/teams', { sessionId: 'lead-2' }))
      return probe.status === 200 ? probe : undefined
    }, '替换后未重新注册（旧 prefix 路由可能没注销）')
    assert.equal(JSON.parse(again.text).result.value.body.view.teamId, 'lead-2')
  })
})

lifecycleTest('真实 Cordis+Connection：插件卸载后独立 channel 彻底注销', async () => {
  await withRuntime(async ({ ctx, origin, disposers }) => {
    const pluginFiber = ctx.plugin(PLUGIN)
    await pluginFiber
    const connectionFiber = provideConnection(ctx)
    await connectionFiber
    disposers.push(() => connectionFiber.dispose())
    await waitFor(async () => (await post(origin, TEAMS_PATH, envelope('team-member-model/teams', { sessionId: 'lead-1' }))).status === 200, '卸载前应可用')

    await pluginFiber.dispose()
    await waitFor(async () => (await post(origin, TEAMS_PATH, envelope('team-member-model/teams', { sessionId: 'lead-1' }))).status === 404, '卸载后路由必须已移除')
  })
})
