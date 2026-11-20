/**
 * 客户端远程通道：模型设置的全部请求必须走官方 connection.rpc，不许碰页面 fetch。
 *
 * 为什么要专门钉这一层：设置页/团队菜单跑在浏览器里，页面 origin 可能已经是远端反代
 * （或就是本机），而「哪台 Host 该收到这次写」只有当前 DSH 会话的连接通道知道。
 * 一旦某条路径偷偷 fetch 本页 /api，写操作就落到错误的进程上——本地看着成功、远端没变。
 *
 * 契约（公开 SDK @deepseek-ai/dsh-client-connection）：
 *   inject: ['connection', 'slots'] → ctx.connection.rpc
 *   rpc.call('/dsh-team-member-model', 'team-member-model/<op>', payload, signal?)
 *     → { ok: true, value: { status, body } } | { ok: false, error: { code, message, details } }
 *   传输层失败由官方 throw。
 *
 * 运行：node --test test/client-transport.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 页面 origin 的 fetch：只要被调用就记一笔并当场炸——模型设置没有任何理由用它。 */
function loadClient(options = {}) {
  const pageFetches = []
  const warnings = []
  const sandbox = {
    console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
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
      // 故意是本机 origin：远端由 connection 通道决定，不能用它推导请求地址。
      location: { origin: 'http://127.0.0.1:55340', hostname: '127.0.0.1' },
      __ModuleLoader__: { load(def) { sandbox.window.__ModuleLoader__.loaded = def } },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

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
    connection: options.connection,
  }
  if ('connection' in options) mod.apply(ctx)
  return { mod, ctx, pageFetches, warnings }
}

/** 记录调用的假 connection.rpc。 */
function recorder(reply) {
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, endpoint, payload, signal) {
        calls.push({ channel, endpoint, payload, signal })
        return reply({ channel, endpoint, payload })
      },
    },
  }
}

const OK = () => ({ ok: true, value: { status: 200, body: { ok: true } } })

/** 七个冻结端点：名字、payload、以及是否写操作。 */
const OPS = [
  ['state', {}, false],
  ['efforts', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, false],
  ['usage', {}, false],
  ['teams', { sessionId: 'lead-1' }, false],
  ['savePolicy', { policy: { members: [], rules: [] } }, true],
  ['saveTeam', { sessionId: 'lead-1', target: 'mem-1', selection: { provider: 'a', model: 'b' }, revision: 3 }, true],
  ['resetUsage', {}, true],
]

test('插件契约为 connection + slots，不再只有 slots', () => {
  const { mod } = loadClient()
  assert.equal(mod.inject.length, 2)
  assert.equal(mod.inject[0], 'slots')
  assert.equal(mod.inject[1], 'connection')
})

test('七个端点全部打到当前连接的 /api 通道，页面 fetch 一次都不发', async () => {
  const { rpc, calls } = recorder(OK)
  const { mod, pageFetches } = loadClient({ connection: { rpc } })

  for (const [endpoint, payload] of OPS) {
    const body = await mod._request(endpoint, payload)
    assert.equal(JSON.stringify(body), JSON.stringify({ ok: true }))
  }

  assert.equal(calls.length, OPS.length, '每个端点各一次 RPC')
  OPS.forEach(([endpoint, payload], i) => {
    assert.equal(calls[i].channel, '/dsh-team-member-model')
    assert.equal(calls[i].endpoint, `team-member-model/${endpoint}`)
    assert.equal(JSON.stringify(calls[i].payload), JSON.stringify(payload))
  })
  assert.equal(pageFetches.length, 0, `页面 fetch 调用记录：${pageFetches.join(', ')}`)
})

test('同一 ctx 换掉 connection：后续请求打到新连接，旧连接不再收到写', async () => {
  const a = recorder(OK)
  const b = recorder(OK)
  const { mod, ctx, pageFetches } = loadClient({ connection: { rpc: a.rpc } })

  await mod._request('usage', {})
  assert.equal(a.calls.length, 1)

  // 官方 service 换了一台 Host：同一个插件 ctx，connection 句柄被换掉。
  ctx.connection = { rpc: b.rpc }

  await mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 })
  assert.equal(a.calls.length, 1, '旧连接不许再收到请求')
  assert.equal(b.calls.length, 1, '新连接必须收到这次写')
  assert.equal(b.calls[0].channel, '/dsh-team-member-model')
  assert.equal(b.calls[0].endpoint, 'team-member-model/saveTeam')
  assert.equal(pageFetches.length, 0)

  // 连接被撤掉：清楚报错，绝不偷偷沿用上一个连接。
  ctx.connection = null
  await assert.rejects(mod._request('state', {}), /connection\.rpc/)
})

test('返回值是原 HTTP JSON（value.body），不是官方 envelope', async () => {  const { rpc } = recorder(() => ({ ok: true, value: { status: 200, body: { ok: true, revision: 7, view: { members: [] } } } }))
  const { mod } = loadClient({ connection: { rpc } })
  const body = await mod._request('teams', { sessionId: 'lead-1' })
  assert.equal(body.revision, 7)
  assert.equal(body.view.members.length, 0)
})

test('业务错误按 value.status/body 抛：409 保留 code，且不暗地重试', async () => {
  const { rpc, calls } = recorder(() => ({
    ok: true,
    value: { status: 409, body: { ok: false, code: 'stale-revision', error: '并发修改冲突：版本已滞后，请重新读取' } },
  }))
  const { mod, pageFetches } = loadClient({ connection: { rpc } })

  await assert.rejects(
    mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 }),
    (err) => {
      assert.equal(err.code, 'stale-revision')
      assert.equal(err.status, 409)
      assert.match(err.message, /版本已滞后/)
      assert.equal(err.unknown, undefined, '业务拒绝不是「未确认」')
      return true
    },
  )
  assert.equal(calls.length, 1, '409 不许自动重发')
  assert.equal(pageFetches.length, 0)
})

test('业务错误：401/403 一样只抛一次，写操作不假称成功', async () => {
  for (const status of [401, 403]) {
    const { rpc, calls } = recorder(() => ({ ok: true, value: { status, body: { ok: false, error: `拒绝 ${status}` } } }))
    const { mod } = loadClient({ connection: { rpc } })
    await assert.rejects(mod._request('savePolicy', { policy: { members: [] } }), (err) => {
      assert.equal(err.status, status)
      assert.match(err.message, new RegExp(String(status)))
      return true
    })
    assert.equal(calls.length, 1)
  }
})

test('官方 outer error（传输层失败）：写操作标记未确认，读操作不冒充已提交', async () => {
  const failure = () => ({
    ok: false,
    error: { code: 'gateway/internal', message: 'transport failure for /api/team-member-model/saveTeam: HTTP 502', details: {} },
  })
  const { rpc, calls } = recorder(failure)
  const { mod, pageFetches } = loadClient({ connection: { rpc } })

  await assert.rejects(mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 }), (err) => {
    assert.equal(err.code, 'NETWORK_ERROR')
    assert.equal(err.rpcCode, 'gateway/internal')
    assert.match(err.message, /HTTP 502/)
    assert.equal(err.unknown, true, '写操作结果未确认')
    return true
  })

  await assert.rejects(mod._request('teams', { sessionId: 'lead-1' }), (err) => {
    assert.equal(err.code, 'NETWORK_ERROR')
    assert.notEqual(err.unknown, true, '读操作不标成「已写入/未确认」')
    return true
  })

  assert.equal(calls.length, 2, '传输失败同样不重试')
  assert.equal(pageFetches.length, 0, '传输失败不许回落到本页 fetch')
})

test('官方 outer 明确拒绝（401/403 / unauthorized / forbidden）：已知失败，不标未确认', async () => {
  const cases = [
    { code: 'unauthorized', message: '远程连接未通过官方认证', details: { status: 403 } },
    { code: 'gateway/internal', message: 'connection rejected', details: { status: 401 } },
    { code: 'forbidden', message: '连接访问被拒绝', details: {} },
  ]
  for (const error of cases) {
    const { rpc, calls } = recorder(() => ({ ok: false, error }))
    const { mod, pageFetches } = loadClient({ connection: { rpc } })
    await assert.rejects(mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 }), (err) => {
      assert.equal(err.code, error.code === 'gateway/internal' ? 'gateway/internal' : error.code, '官方 code 不能藏')
      assert.notEqual(err.code, 'NETWORK_ERROR', '认证被否不是网络失联')
      assert.equal(err.unknown, false, '认证没过 = 写确定没发生，不能标成未确认')
      assert.match(err.message, new RegExp(error.message))
      return true
    })
    assert.equal(calls.length, 1, '认证被否不重试')
    assert.equal(pageFetches.length, 0, '认证被否也不许回落到页面 fetch')
  }
})

test('官方 outer 取消（code=aborted）：标 cancelled，不算「可能已写入」', async () => {
  const { rpc, calls } = recorder(() => ({
    ok: false,
    error: { code: 'aborted', message: '请求已取消', details: {} },
  }))
  const { mod, pageFetches } = loadClient({ connection: { rpc } })

  await assert.rejects(mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 }), (err) => {
    assert.equal(err.code, 'aborted')
    assert.equal(err.cancelled, true)
    assert.equal(err.unknown, false, '取消发生在执行前，不能标成未确认')
    assert.match(err.message, /已取消/)
    return true
  })
  assert.equal(calls.length, 1, '取消不重试')
  assert.equal(pageFetches.length, 0)
})

test('rpc.call 直接 throw 也算传输失败：写操作未确认，读操作不标', async () => {
  const rpc = { async call() { throw new Error('connection closed') } }
  const { mod, pageFetches } = loadClient({ connection: { rpc } })

  await assert.rejects(mod._request('saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: 1 }), (err) => {
    assert.equal(err.code, 'NETWORK_ERROR')
    assert.equal(err.unknown, true, '断连时写操作结果未确认')
    assert.match(err.message, /connection closed/)
    return true
  })
  await assert.rejects(mod._request('state', {}), (err) => {
    assert.equal(err.code, 'NETWORK_ERROR')
    assert.notEqual(err.unknown, true, '读操作不标未确认')
    return true
  })
  assert.equal(pageFetches.length, 0)
})

test('HTTP 404 仍要说清「Host 半侧可能没加载」', async () => {
  const { rpc } = recorder(() => ({ ok: false, error: { code: 'gateway/internal', message: 'transport failure for /api/team-member-model/state: HTTP 404' } }))
  const { mod } = loadClient({ connection: { rpc } })
  await assert.rejects(mod._request('state', {}), /Host 半侧可能未加载/)
})

test('未知端点当场拒绝，一个 RPC 都不发', async () => {
  const { rpc, calls } = recorder(OK)
  const { mod, pageFetches } = loadClient({ connection: { rpc } })
  await assert.rejects(mod._request('policy', { members: [] }), (err) => {
    assert.equal(err.code, 'UNKNOWN_ENDPOINT')
    return true
  })
  assert.equal(calls.length, 0)
  assert.equal(pageFetches.length, 0)
})

test('没有 connection.rpc 时给出明确的 SDK 错误，而不是改走页面 fetch', async () => {
  for (const connection of [undefined, null, {}, { rpc: {} }]) {
    const { mod, pageFetches, warnings } = loadClient({ connection })
    await assert.rejects(mod._request('state', {}), (err) => {
      assert.equal(err.code, 'NO_CONNECTION')
      assert.match(err.message, /connection\.rpc/)
      assert.match(err.message, /重新打开页面|升级 DSH/)
      return true
    })
    assert.equal(pageFetches.length, 0)
    if (connection === undefined) assert.equal(warnings.length, 1, '缺服务要留下可诊断的警告')
  }
})

test('apply 不因为没有 connection 而抛错（设置页仍要渲染）', () => {
  const { mod } = loadClient({ connection: undefined })
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod._request, 'function')
})
