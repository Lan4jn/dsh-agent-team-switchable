/**
 * 团队模型菜单与设置前端单元及集成测试。
 * 直接对标生产 lib/client.js 单一源头真理（Single Source of Truth）。
 * 运行方式：node --test test/team-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function sameValue(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
}

/**
 * 严格模拟真实生产环境的 ModuleLoader 沙箱：
 * 仅允许解析环境已注册的包（如 'react'），绝不伪造相对文件路径 require。
 *
 * customRpc = 官方 connection.rpc.call 的替身；真跑一次 apply 把它装进 ctx.connection，
 * 与生产同一条读取路径（而不是另开一个测试旁路）。页面 fetch 一律不允许——模型设置
 * 必须走连接通道，否则写会落到错误 origin。
 */
function loadClient(customReact, customRpc) {
  let definition
  const styles = []
  const docListeners = []
  const pageFetches = []
  const sandbox = {
    console,
    fetch: (url) => {
      pageFetches.push(String(url))
      throw new Error(`模型设置不得使用页面 fetch：${url}`)
    },
    document: {
      head: {
        appendChild(node) {
          styles.push(node.textContent)
        },
      },
      querySelector() {
        return null
      },
      createElement(tag) {
        return { tag, dataset: {}, textContent: '' }
      },
      addEventListener(ev, fn) {
        docListeners.push({ ev, fn })
      },
      removeEventListener(ev, fn) {
        const idx = docListeners.findIndex((l) => l.ev === ev && l.fn === fn)
        if (idx !== -1) docListeners.splice(idx, 1)
      },
    },
    window: {
      location: { origin: 'http://127.0.0.1:55340', hostname: '127.0.0.1' },
      __ModuleLoader__: {
        load(def) {
          definition = def
        },
      },
    },
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  assert.ok(definition, 'window.__ModuleLoader__.load 必须被调用')
  assert.equal(definition.id, 'dsh-team-member-model')

  const fakeRequire = (name) => {
    if (name === 'react') {
      return customReact || {
        createElement: (type, props, ...children) => ({ type, props, children }),
        Fragment: 'Fragment',
        useState: (init) => [init, () => {}],
        useEffect: () => {},
        useRef: (init) => ({ current: init }),
      }
    }
    throw new Error(`严格生产沙箱：未允许的 require：${name}`)
  }

  const mod = definition.factory(fakeRequire)
  // 允许直接给 rpc.call 函数，也允许给 { call } 对象（teamServer 返回的形状）。
  const rpcCall = typeof customRpc === 'function' ? customRpc : customRpc && customRpc.call
  if (typeof rpcCall === 'function') {
    mod.apply({
      slots: { inject: (name, fn) => fn(), register: () => ({}) },
      connection: { rpc: { call: rpcCall } },
    })
  }
  return { mod, styles, docListeners, pageFetches }
}

const { mod, styles: injectedStyles } = loadClient()

const deriveBackfill = mod._deriveBackfill
const checkDraftValidity = mod._checkDraftValidity
const createWriteGate = mod._createWriteGate
const formatSummary = mod._formatSummary
const sameSelection = mod._sameSelection
const TeamController = mod._TeamController
const applyBulkMembers = mod._applyBulkMembers
const TeamAction = mod._TeamAction
const TeamTrigger = mod._TeamTrigger
const TeamPopup = mod._TeamPopup
const teamStyles = mod._styles()

// 真实 GET /state 的目录只有 id / name —— 档位不在目录里（实测 0.7.1：catalog.models[].efforts 不存在）。
const mockCatalog = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', reasoning: false },
    ],
  },
]

test('deriveBackfill: 共享选择器回填状态机', () => {
  // 1. 全员一致且在活目录中 -> 回填该值
  const r1 = deriveBackfill({
    members: [
      { id: 'm1', name: 'worker-1', phase: 'active', nextModel: { provider: 'openai', model: 'gpt-4o' } },
      { id: 'm2', name: 'worker-2', phase: 'active', currentModel: { provider: 'openai', model: 'gpt-4o' } },
    ],
    activeNames: ['worker-1', 'worker-2'],
    defaultModel: null,
    catalog: mockCatalog,
  })
  sameValue(r1.selection, { provider: 'openai', model: 'gpt-4o', reasoningEffort: '' })
  assert.equal(r1.mixed, false)
  assert.equal(r1.defaultOnly, false)

  // 2. 成员不一致 (mixed) -> selection 为 null，mixed 为 true，不暗示默认
  const r2 = deriveBackfill({
    members: [
      { id: 'm1', name: 'worker-1', phase: 'active', nextModel: { provider: 'openai', model: 'gpt-4o' } },
      { id: 'm2', name: 'worker-2', phase: 'active', nextModel: { provider: 'deepseek', model: 'deepseek-chat' } },
    ],
    activeNames: ['worker-1', 'worker-2'],
    defaultModel: { provider: 'openai', model: 'gpt-4o' },
    catalog: mockCatalog,
  })
  assert.equal(r2.selection, null)
  assert.equal(r2.mixed, true)
  assert.equal(r2.defaultOnly, false)

  // 3. 无可执行成员但有有效默认 -> 回填默认，标记 defaultOnly
  const r3 = deriveBackfill({
    members: [],
    activeNames: [],
    defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
    catalog: mockCatalog,
  })
  sameValue(r3.selection, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' })
  assert.equal(r3.mixed, false)
  assert.equal(r3.defaultOnly, true)

  // 4. 完全无数据 -> selection 为 null
  const r4 = deriveBackfill({
    members: [],
    activeNames: [],
    defaultModel: null,
    catalog: mockCatalog,
  })
  assert.equal(r4.selection, null)
  assert.equal(r4.mixed, false)
  assert.equal(r4.defaultOnly, false)

  // 5. 非 active (provisioning/failed) 或不在 activeNames 中的成员不参与共识计算
  const r5 = deriveBackfill({
    members: [
      { id: 'm1', name: 'worker-1', phase: 'active', nextModel: { provider: 'openai', model: 'gpt-4o' } },
      { id: 'm2', name: 'worker-starting', phase: 'provisioning', nextModel: { provider: 'deepseek', model: 'deepseek-chat' } },
      { id: 'm3', name: 'worker-failed', phase: 'failed', nextModel: { provider: 'deepseek', model: 'deepseek-chat' } },
    ],
    activeNames: ['worker-1'],
    defaultModel: null,
    catalog: mockCatalog,
  })
  sameValue(r5.selection, { provider: 'openai', model: 'gpt-4o', reasoningEffort: '' })
  assert.equal(r5.mixed, false)

  // 6. 模型已从目录退休 -> 返回 null，不可回填
  const r6 = deriveBackfill({
    members: [
      { id: 'm1', name: 'worker-1', phase: 'active', nextModel: { provider: 'unknown', model: 'legacy' } },
    ],
    activeNames: ['worker-1'],
    defaultModel: null,
    catalog: mockCatalog,
  })
  assert.equal(r6.selection, null)
})

test('checkDraftValidity: 草稿有效性校验（档位以 /efforts 的 bank 为准）', () => {
  const banks = {
    'openai/o3-mini': { status: 'ok', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' },
  }

  // 基础合法
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'gpt-4o' }, mockCatalog, banks), true)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: 'high' }, mockCatalog, banks), true)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: '' }, mockCatalog, banks), true)

  // 空选或不存在模型
  assert.equal(checkDraftValidity(null, mockCatalog, banks), false)
  assert.equal(checkDraftValidity({ provider: '', model: '' }, mockCatalog, banks), false)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'non-existent' }, mockCatalog, banks), false)

  // 严格拦截 invalid effort，阻止非法推理档位入站
  assert.equal(checkDraftValidity({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }, mockCatalog, banks), false)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: 'invalid-effort' }, mockCatalog, banks), false)

  // 还没读到 metadata（loading / error / 缺失）时，不许把未知档位写下去
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: 'high' }, mockCatalog, {}), false)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: 'high' }, mockCatalog, { 'openai/o3-mini': { status: 'loading' } }), false)
  assert.equal(checkDraftValidity({ provider: 'openai', model: 'o3-mini', reasoningEffort: 'high' }, mockCatalog, { 'openai/o3-mini': { status: 'error', efforts: [] } }), false)
})

test('createWriteGate: 互斥锁控制与防重入', async () => {
  const gate = createWriteGate()
  assert.equal(gate.isBusy(), false)

  let releasePromise
  const p1 = new Promise((resolve) => { releasePromise = resolve })

  const run1 = gate.run(async () => {
    assert.equal(gate.isBusy(), true)
    await p1
    return 'done1'
  })

  // 同 tick / 并发第二个操作必须被拒绝
  assert.equal(gate.isBusy(), true)
  await assert.rejects(
    async () => {
      await gate.run(async () => 'done2')
    },
    /BUSY/
  )

  releasePromise()
  const res1 = await run1
  assert.equal(res1, 'done1')
  assert.equal(gate.isBusy(), false)
})

test('formatSummary: 摘要格式化', () => {
  assert.equal(formatSummary(null), '继承原设置')
  assert.equal(formatSummary({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(formatSummary({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m · high')
})

test('TeamController: teams 读写经官方 RPC 通道，CAS revision 逐次递增', async () => {
  const server = teamServer({
    revision: 3,
    view: {
      defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
      members: [
        { id: 'mem-1', name: 'worker-1', phase: 'active', status: 'running', currentModel: { provider: 'openai', model: 'gpt-4o' }, nextModel: null },
      ],
    },
  })
  const { mod: localMod, pageFetches } = loadClient(undefined, server.rpc)
  const controller = new localMod._TeamController({ sessionId: 'lead-1' })

  // 1. fetchView
  const view = await controller.fetchView()
  assert.equal(view.teamId, 'lead-1')
  assert.equal(view.revision, 3)
  assert.equal(server.calls[0].channel, '/dsh-team-member-model')
  assert.equal(server.calls[0].endpoint, 'team-member-model/teams')
  assert.deepEqual(server.calls[0].payload, { sessionId: 'lead-1' })

  // 2. saveDefault
  const update1 = await controller.saveDefault({ provider: 'openai', model: 'gpt-4o' })
  assert.equal(update1.revision, 4)
  assert.equal(server.calls[1].method, 'PUT')
  assert.equal(server.calls[1].endpoint, 'team-member-model/saveTeam')
  assert.deepEqual(server.calls[1].payload, {
    sessionId: 'lead-1',
    target: null,
    selection: { provider: 'openai', model: 'gpt-4o' },
    revision: 3,
  })

  // 3. restoreInheritance (target: null, selection: null)
  const update2 = await controller.restoreInheritance()
  assert.equal(update2.revision, 5)
  assert.deepEqual(server.calls[2].payload, {
    sessionId: 'lead-1',
    target: null,
    selection: null,
    revision: 4,
  })

  // 4. saveMember (target: 'mem-1' 是 immutable ID)
  const update3 = await controller.saveMember('mem-1', { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(update3.revision, 6)
  assert.deepEqual(server.calls[3].payload, {
    sessionId: 'lead-1',
    target: 'mem-1',
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
    revision: 5,
  })

  assert.equal(pageFetches.length, 0, '全程不许用页面 fetch')
})

test('TeamController: CAS 409 stale-revision 显式抛出 code 并阻止静默覆盖重发', async () => {
  const calls = []
  const rpc = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload })
    return { ok: true, value: { status: 409, body: { ok: false, code: 'stale-revision', error: '版本冲突：该团队设置已被其他操作更新 (传入 rev 2，实际 rev 3)' } } }
  }

  const { mod: localMod } = loadClient(undefined, rpc)
  const controller = new localMod._TeamController({ sessionId: 'lead-1' })
  controller.lastView = { revision: 2 }

  await assert.rejects(
    async () => {
      await controller.saveMember('mem-1', { provider: 'openai', model: 'gpt-4o' })
    },
    (err) => {
      assert.equal(err.code, 'stale-revision')
      assert.equal(err.status, 409)
      assert.match(err.message, /版本冲突/)
      return true
    }
  )
  assert.equal(controller.lastView.revision, 2)
  assert.equal(calls.length, 1, 'stale 不许自动重发')
})

test('TeamController: 传输层失联标记「未确认」，不假称成功且不篡改 revision', async () => {
  const rpc = async () => ({
    ok: false,
    error: { code: 'gateway/internal', message: 'transport failure for /api/team-member-model/saveTeam: HTTP 502', details: {} },
  })

  const { mod: localMod, pageFetches } = loadClient(undefined, rpc)
  const controller = new localMod._TeamController({ sessionId: 'lead-1' })
  controller.lastView = { revision: 5 }

  await assert.rejects(
    async () => {
      await controller.saveDefault({ provider: 'deepseek', model: 'deepseek-chat' })
    },
    (err) => {
      assert.equal(err.code, 'NETWORK_ERROR')
      assert.equal(err.unknown, true, '写操作结果未确认')
      assert.match(err.message, /HTTP 502/)
      return true
    }
  )
  assert.equal(controller.lastView.revision, 5)
  assert.equal(pageFetches.length, 0, '传输失败也不许回落到页面 fetch')
})

test('applyBulkMembers: 批量显式逐人覆盖与异常隔离', async () => {
  const steps = []
  let rev = 10
  const mockSaveMember = async (memberId, selection, currentRev) => {
    steps.push({ memberId, selection, currentRev })
    if (memberId === 'mem-fail') {
      throw new Error('RPC 400 Bad Request')
    }
    if (memberId === 'mem-lost') {
      const err = new Error('Failed to fetch')
      err.code = 'NETWORK_ERROR'
      throw err
    }
    rev += 1
    return { revision: rev }
  }

  const members = [
    { id: 'mem-1', name: 'worker-1', phase: 'active' },
    { id: 'mem-fail', name: 'worker-fail', phase: 'active' },
    { id: 'mem-lost', name: 'worker-lost', phase: 'active' },
    { id: 'mem-2', name: 'worker-2', phase: 'active' },
    { id: 'mem-skip', name: 'worker-starting', phase: 'provisioning' },
  ]

  const results = await applyBulkMembers({
    members,
    activeNames: ['worker-1', 'worker-fail', 'worker-lost', 'worker-2'],
    selection: { provider: 'openai', model: 'gpt-4o' },
    initialRevision: rev,
    saveMember: mockSaveMember,
  })

  assert.equal(results['mem-1'].status, 'saved')
  assert.equal(results['mem-fail'].status, 'failed')
  assert.equal(results['mem-lost'].status, 'unknown')
  assert.equal(results['mem-2'].status, 'saved')
  assert.equal(results['mem-skip'].status, 'skipped')

  assert.equal(steps.length, 4)
  assert.equal(steps[0].memberId, 'mem-1')
  assert.equal(steps[0].currentRev, 10)
  assert.equal(steps[1].memberId, 'mem-fail')
  assert.equal(steps[1].currentRev, 11)
  assert.equal(steps[2].memberId, 'mem-lost')
  assert.equal(steps[2].currentRev, 11)
  assert.equal(steps[3].memberId, 'mem-2')
  assert.equal(steps[3].currentRev, 11)
})

test('TeamAction 通过新版 catalog 按 ID 寻根并对不完整图 fail closed', () => {
  const row = (subagent, subagentCatalog = []) => ({ values: { subagent, subagentCatalog } })
  const identity = { mode: 'continuable', label: 'worker', seq: 1 }
  function render(id, current, rows) {
    return TeamAction({ sessionId: id, useSession: fn => fn(current), useSessions: fn => fn({ projectionsBySession: rows }) })
  }
  const root = row(null, [{ id: 'child', mode: 'continuable', name: 'same' }])
  const child = row(identity, [{ id: 'nested', mode: 'continuable', name: 'same' }])
  const nested = row(identity)
  for (const [id, current, rows] of [['root', { subagent: null }, { root }], ['child', { subagent: identity }, { root, child }], ['nested', { subagent: identity }, { root, child, nested }]]) {
    const rendered = render(id, current, rows)
    assert.ok(rendered)
    assert.equal(rendered.props.leadSessionId, 'root')
    assert.equal(rendered.props.activeNames, undefined)
  }
  assert.equal(render('child', { subagent: identity }, {}), null)
  assert.equal(render('child', {}, { root, child }), null)
  assert.equal(render('child', { subagent: identity }, { child: row(identity, [{ id: 'nested' }]), nested: row(identity, [{ id: 'child' }]) }), null)
  assert.equal(render('child', { subagent: identity }, { root, other: row(null, [{ id: 'child' }]), child }), null)
})

test('TeamAction: 门控层遵守 React Hooks 规则，状态变更不抛 Hook 计数异常', () => {
  // 验证父门控组件 TeamAction 的无条件 Hook 调用契约：
  // 无论会话是否合格，TeamAction 自身仅固定调用 useSession 与 useSessions，绝不在 early return 后调用 useState/useRef！
  let hooksCalled = []

  const propsIneligible = {
    sessionId: 'child-1',
    useSession: (fn) => {
      hooksCalled.push('useSession')
      return fn({ subagent: { mode: 'continuable', label: 'child', seq: 1 } })
    },
    useSessions: (fn) => {
      hooksCalled.push('useSessions')
      return fn({ projectionsBySession: { 'parent-1': { values: { agentTeam: { members: [] } } } } })
    },
  }

  // 1. 不合格会话：返回 null，严格只执行 2 个 Hook
  hooksCalled = []
  const resIneligible = TeamAction(propsIneligible)
  assert.equal(resIneligible, null)
  assert.deepEqual(hooksCalled, ['useSession', 'useSessions'])

  // 2. 合格会话：返回 TeamTrigger，自身依然严格只执行同顺序、同数量的 2 个 Hook（不突增 Hook 计数）
  const propsEligible = {
    sessionId: 'lead-1',
    useSession: (fn) => {
      hooksCalled.push('useSession')
      return fn({ subagent: null })
    },
    useSessions: (fn) => {
      hooksCalled.push('useSessions')
      return fn({ projectionsBySession: {} })
    },
  }

  hooksCalled = []
  const resEligible = TeamAction(propsEligible)
  assert.ok(resEligible)
  assert.equal(resEligible.type, TeamTrigger)
  assert.deepEqual(hooksCalled, ['useSession', 'useSessions'])
})

test('TeamTrigger: 渲染齿轮按钮并响应 onClick 触发状态切换打开 Popup', () => {
  let stateVal = false
  const customReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (init) => [stateVal, (next) => { stateVal = typeof next === 'function' ? next(stateVal) : next }],
    useRef: (init) => ({ current: init }),
  }
  const { mod: localMod } = loadClient(customReact)
  const LocalTrigger = localMod._TeamTrigger

  // 1. 未打开状态
  stateVal = false
  const v1 = LocalTrigger({ leadSessionId: 'lead-1', currentSessionId: 'lead-1', activeNames: [] })
  assert.equal(v1.children.length, 2)
  const btn = v1.children[0]
  assert.equal(btn.props['aria-label'], '团队模型设置')
  assert.equal(btn.props['aria-expanded'], false)
  assert.equal(v1.children[1], null)

  // 2. 模拟真实用户点击：调用 button 的 onClick
  btn.props.onClick()
  assert.equal(stateVal, true, '点击齿轮按钮必须将 open 状态置为 true')

  // 3. 打开状态重新渲染：浮层真实出现
  const v2 = LocalTrigger({ leadSessionId: 'lead-1', currentSessionId: 'lead-1', activeNames: [] })
  assert.equal(v2.children[0].props['aria-expanded'], true)
  assert.ok(v2.children[1], '弹窗在 open=true 时正确挂载')
  assert.equal(v2.children[1].type, localMod._TeamPopup)
})

test('TeamPopup: 挂载时经连接通道拉 view，卸载清理事件监听与丢弃晚到响应', async () => {
  const rpcCalls = []
  let effectCleanups = []

  const mockRpc = async (channel, endpoint, payload) => {
    rpcCalls.push({ channel, endpoint, payload })
    if (endpoint === 'team-member-model/teams') {
      return { ok: true, value: { status: 200, body: { ok: true, view: { revision: 1, members: [] } } } }
    }
    return { ok: true, value: { status: 200, body: { ok: true, catalog: [] } } }
  }

  const customReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (init) => [init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: (fn) => {
      const cln = fn()
      if (typeof cln === 'function') effectCleanups.push(cln)
    },
  }

  const { mod: localMod, docListeners, pageFetches } = loadClient(customReact, mockRpc)
  const LocalPopup = localMod._TeamPopup

  LocalPopup({
    sessionId: 'lead-1',
    currentSessionId: 'lead-1',
    activeNames: [],
    onClose: () => {},
  })

  assert.ok(
    rpcCalls.some((c) => c.channel === '/dsh-team-member-model' && c.endpoint === 'team-member-model/teams' && c.payload.sessionId === 'lead-1'),
    'TeamPopup 必须经 /api 通道读 teams',
  )
  assert.equal(pageFetches.length, 0, '弹窗不许多开一条页面 fetch')
  assert.ok(docListeners.length >= 2, '必须在 document 上注册 keydown 与 pointerdown 监听')

  // 卸载与跨会话切换清理
  for (const cln of effectCleanups) cln()
  assert.equal(docListeners.length, 0, '卸载时必须注销所有按键和点击监听')
})

test('样式契约：包含必须的 DSH 主题 CSS 变量', () => {
  assert.match(teamStyles, /--dsw-alias-bg-overlay/)
  assert.match(teamStyles, /--dsw-alias-border-l1/)
  assert.match(teamStyles, /--dsw-alias-brand-primary/)
  assert.match(teamStyles, /\.tmm-team-trigger\{/)
  assert.match(teamStyles, /\.tmm-team-popup\{/)
})

// ---------------------------------------------------------------------------
// 共享模型设置的思考档位：唯一数据源是 GET /efforts（目录里没有档位元数据）
// ---------------------------------------------------------------------------

/** 忠实的小型 Hooks 运行时：槽位按调用顺序固定，effect 按 deps 决定是否重跑。 */
function createHooks() {
  const slots = []
  const cleanups = []
  let index = 0
  let dirty = false
  let pendingEffects = []
  let pass = 0

  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  const react = {
    // 函数子组件按 React 语义就地展开：Hook 顺序 = 父组件 → 其子组件，与真实渲染一致。
    createElement: (type, props, ...children) => {
      const node = { type, props: props || {}, children }
      return typeof type === 'function' ? type(node.props) : node
    },
    Fragment: 'Fragment',
    useState(init) {
      const i = index++
      if (slots[i] === undefined) slots[i] = { value: init, queue: [] }
      const slot = slots[i]
      if (slot.queue.length > 0) {
        slot.value = slot.queue.reduce((value, next) => (typeof next === 'function' ? next(value) : next), slot.value)
        slot.queue = []
      }
      return [slot.value, (next) => { slot.queue.push(next); dirty = true }]
    },
    useRef(init) {
      const i = index++
      if (slots[i] === undefined) slots[i] = { ref: { current: init } }
      return slots[i].ref
    },
    useEffect(fn, deps) {
      const i = index++
      const prev = slots[i]
      const changed = prev === undefined || !deps || deps.some((value, k) => value !== prev.deps[k])
      if (changed) pendingEffects.push({ index: i, fn, deps })
    },
  }

  return {
    react,
    settle,
    async render(Component, props) {
      pass = 0
      while (pass++ < 10) {
        index = 0
        dirty = false
        pendingEffects = []
        const tree = Component(props)
        for (const effect of pendingEffects) {
          const prev = slots[effect.index]
          if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup()
          const cleanup = effect.fn()
          slots[effect.index] = { ...(prev || {}), deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
          cleanups.push(cleanup)
        }
        await settle()
        if (!dirty) return tree
      }
      throw new Error('渲染未收敛：状态更新没有停下')
    },
    unmount() {
      for (const slot of slots) if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
    },
  }
}

function jsonReply(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

/**
 * 模拟「官方 connection.rpc + Host 的 7 个端点」，记录每次 RPC 调用。
 * 内部仍按原来的 HTTP 形状回放（url/method/body），所以既有断言继续看同一件事；
 * 新增的 channel/endpoint/payload 则用来钉住「请求确实走了当前连接通道」。
 */
function teamServer(config) {
  const calls = []
  let view = { teamId: 'lead-1', revision: config.revision ?? 1, ...config.view }

  const fetchImpl = async (url, opts) => {
    const method = (opts && opts.method) || 'GET'
    if (url.includes('/efforts?')) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
      const key = `${query.get('provider')}/${query.get('model')}`
      const reply = (config.efforts || {})[key]
      if (typeof reply === 'function') return reply(key)
      if (reply === undefined) {
        return jsonReply({ ok: true, provider: query.get('provider'), model: query.get('model'), efforts: [], supported: true })
      }
      return jsonReply({ ok: true, ...reply })
    }
    if (url.includes('/state')) return jsonReply({ ok: true, catalog: config.catalog || [] })
    if (url.includes('/usage/reset')) {
      return jsonReply({ ok: true, startedAt: '', totals: {}, members: [], rules: [], sources: [], hours: [] })
    }
    if (url.includes('/usage')) {
      return jsonReply({ ok: true, startedAt: '', totals: {}, members: [], rules: [], sources: [], hours: [] })
    }
    if (url.includes('/policy') && method === 'PUT') return jsonReply({ ok: true, policy: JSON.parse(opts.body) })
    if (url.includes('/teams') && method === 'GET') return jsonReply({ ok: true, view })
    if (url.includes('/teams') && method === 'PUT') {
      const body = JSON.parse(opts.body)
      view = {
        ...view,
        revision: view.revision + 1,
        defaultModel: body.target === null ? body.selection : view.defaultModel,
        members: view.members.map((m) => (m.id === body.target ? { ...m, nextModel: body.selection } : m)),
      }
      return jsonReply({ ok: true, view })
    }
    return jsonReply({ ok: false, error: `no route ${url}` }, 404)
  }

  // endpoint → 等价的 HTTP 请求：payload 的字段/编码本身就是契约，测试里直接看得见。
  const routes = {
    state: () => ({ method: 'GET', url: '/api/team-member-model/state' }),
    usage: () => ({ method: 'GET', url: '/api/team-member-model/usage' }),
    resetUsage: () => ({ method: 'PUT', url: '/api/team-member-model/usage/reset', body: {} }),
    efforts: (p) => ({ method: 'GET', url: `/api/team-member-model/efforts?provider=${encodeURIComponent(p.provider)}&model=${encodeURIComponent(p.model)}` }),
    teams: (p) => ({ method: 'GET', url: `/api/team-member-model/teams?sessionId=${encodeURIComponent(p.sessionId)}` }),
    savePolicy: (p) => ({ method: 'PUT', url: '/api/team-member-model/policy', body: p.policy }),
    saveTeam: (p) => ({ method: 'PUT', url: '/api/team-member-model/teams', body: p }),
  }

  const rpc = {
    async call(channel, endpoint, payload) {
      assert.equal(channel, '/dsh-team-member-model', `RPC 通道固定为 /dsh-team-member-model，实际 ${channel}`)
      const name = String(endpoint).replace(/^team-member-model\//, '')
      const route = routes[name]
      assert.ok(route, `未模拟的 RPC 端点：${endpoint}`)
      const req = route(payload || {})
      // 记录穿过 JSON 边界的副本：与真实传输一致，跨 realm 的 deepEqual 也稳。
      const wire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
      calls.push({ channel, endpoint, payload: wire(payload || {}), method: req.method, url: req.url, body: wire(req.body) })
      const reply = await fetchImpl(req.url, { method: req.method, body: req.body === undefined ? undefined : JSON.stringify(req.body) })
      const body = await reply.json()
      // Host 半侧把业务状态放进 outer ok 的 value；只有传输/认证失败才是 outer error。
      return { ok: true, value: { status: reply.status, body } }
    },
  }

  return { rpc, calls, view: () => view }
}

function findAll(node, match) {
  const out = []
  const walk = (item) => {
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item)) return item.forEach(walk)
    if (match(item)) out.push(item)
    ;(item.children || []).forEach(walk)
  }
  walk(node)
  return out
}

/** React 会把数组 children 摊平：这里同样摊平，个数才等于真实渲染出来的节点数。 */
function kids(node) {
  const out = []
  ;((node && node.children) || []).forEach((child) => {
    if (Array.isArray(child)) out.push(...child)
    else out.push(child)
  })
  return out
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

function byClass(tree, cls) {
  return findAll(tree, (n) => n && n.type !== undefined && String((n.props || {}).className || '').split(' ').includes(cls))
}

function byLabel(tree, label, type) {
  return findAll(tree, (n) => n && n.type !== undefined && (n.props || {})['aria-label'] === label && (type === undefined || n.type === type))[0]
}

function buttonNamed(tree, text) {
  return findAll(tree, (n) => n && n.type === 'button' && textOf(n) === text)[0]
}

function optionValues(select) {
  return findAll(select, (n) => n && n.type === 'option').map((o) => ({ value: o.props.value, label: textOf(o) }))
}

const EFFORTS_4 = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

async function renderPopup(server, props) {
  const hooks = createHooks()
  const { mod: localMod } = loadClient(hooks.react, server.rpc)
  const panelProps = {
    sessionId: 'lead-1',
    currentSessionId: 'lead-1',
    // 未显式给出 = 官方投影还没有结论（unknown）；显式 [] = 官方明确说当前没有活动队员。
    activeNames: props ? props.activeNames : undefined,
    onClose: () => {},
  }
  const hooksRender = () => hooks.render(localMod._TeamPopup, panelProps)
  const tree = await hooksRender()
  return { tree, hooks, mod: localMod, rerender: hooksRender }
}

test('布局：提供方全宽，模型和档位以专用网格对齐，按钮位于底部', async () => {
  const server = teamServer({
    catalog: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }],
    view: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, members: [] },
    efforts: { 'deepseek-official/deepseek-flash': { efforts: EFFORTS_4, supported: true, defaultEffort: 'high' } },
  })
  const { tree } = await renderPopup(server)
  const region = findAll(tree, (n) => n.props && n.props['aria-label'] === '统一模型设置')[0]
  const rows = byClass(region, 'tmm-team-row')
  assert.equal(rows.length, 2, '统一模型设置是两行：提供方 / 模型+档位')

  // 第一行只有提供方，并铺满统一表单宽度。
  const row1 = kids(rows[0])
  assert.equal(row1.length, 1)
  assert.ok(byLabel(row1[0], '服务提供方', 'select'), '第一行是服务提供方')
  assert.ok(rows[0].props.className.includes('tmm-shared-provider'), '提供方行全宽')
  assert.notEqual(rows[0].props.style && rows[0].props.style.justifyContent, 'flex-end')
  assert.ok(rows[1].props.className.includes('tmm-shared-models'), '模型档位网格')
  assert.match(teamStyles, /\.tmm-shared-models\{[^}]*grid-template-columns:minmax\(0,3fr\) minmax\(0,2fr\)/)
  assert.match(teamStyles, /@container[^{}]*max-width:360px\)\{\.tmm-shared-models\{grid-template-columns:minmax\(0,1fr\)/)
  assert.match(teamStyles, /\.tmm-shared-provider[^}]*width:100%/)
  assert.match(teamStyles, /\.tmm-shared-models \.tmm-team-field\{min-width:0;width:100%/)
  assert.match(teamStyles, /\.tmm-shared-picker \.tmm-team-select\{min-width:0;text-overflow:ellipsis/)
  assert.doesNotMatch(teamStyles, /\.tmm-team-row-note\{/)
  assert.doesNotMatch(textOf(region), /选择模型草稿/, '草稿提示已移除')

  const row2 = kids(rows[1])
  assert.equal(row2.length, 2)
  assert.ok(byLabel(row2[0], '模型', 'select'), '第二行左侧是模型')
  const effort = byLabel(row2[1], '思考档位', 'select')
  assert.ok(effort, '第二行右侧是思考档位')
  assert.equal(effort.props.disabled, false, '真公布了档位就该可选')
  const options = optionValues(effort)
  sameValue(options.map((o) => o.value), ['', 'off', 'low', 'high', 'max'])
  assert.match(options[0].label, /用模型默认（high）/)

  const btns = byClass(tree, 'tmm-team-btns')[0]
  sameValue(kids(btns).map(textOf), ['应用到当前队员', '设为新队员默认'], '底部只有两个按钮')
  assert.ok(server.calls.some((c) => c.url === '/api/team-member-model/efforts?provider=deepseek-official&model=deepseek-flash'))
})

test('思考档位：没公布档位时仍常驻占位，但置灰 disabled（不再隐藏）', async () => {
  const server = teamServer({
    catalog: [{ id: 'gemini', name: 'Gemini', models: [{ id: 'gemini-3.8-flash-high', name: 'gemini-3.8-flash-high' }] }],
    view: { defaultModel: { provider: 'gemini', model: 'gemini-3.8-flash-high' }, members: [] },
    efforts: { 'gemini/gemini-3.8-flash-high': { efforts: [], supported: true } },
  })
  const { tree } = await renderPopup(server)
  const effort = byLabel(tree, '思考档位', 'select')
  assert.ok(effort, '没有档位也要占位')
  assert.equal(effort.props.disabled, true, '没公布就必须 disabled')
  const options = optionValues(effort)
  assert.equal(options.length, 1)
  assert.match(options[0].label, /未公布/)
  assert.ok(server.calls.some((c) => c.url === '/api/team-member-model/efforts?provider=gemini&model=gemini-3.8-flash-high'), '仍要真问 metadata 才决定禁用')
  assert.equal(buttonNamed(tree, '设为新队员默认').props.disabled, false, '点击按钮不该因为没档位被禁')
})

test('思考档位：A 的迟到响应不能污染切换后的 B 档位', async () => {
  let releaseA
  const server = teamServer({
    catalog: [
      { id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] },
      { id: 'pb', name: 'PB', models: [{ id: 'mb', name: 'MB' }] },
    ],
    view: { defaultModel: { provider: 'pa', model: 'ma' }, members: [] },
    efforts: {
      'pa/ma': () => new Promise((resolve) => { releaseA = () => resolve(jsonReply({ ok: true, efforts: [{ id: 'off' }, { id: 'max' }], supported: true })) }),
      'pb/mb': { efforts: [{ id: 'low' }, { id: 'high' }], supported: true },
    },
  })
  const { tree, rerender } = await renderPopup(server)
  const loadingSelect = byLabel(tree, '思考档位', 'select')
  assert.equal(loadingSelect.props.disabled, true, 'loading 期间占位但禁用，不伪造档位')
  assert.match(textOf(loadingSelect), /正在读取/)

  byLabel(tree, '服务提供方', 'select').props.onChange({ target: { value: 'pb' } })
  let next = await rerender()
  byLabel(next, '模型', 'select').props.onChange({ target: { value: 'mb' } })
  next = await rerender()
  sameValue(optionValues(byLabel(next, '思考档位', 'select')).map((o) => o.value), ['', 'low', 'high'])

  releaseA()
  next = await rerender()
  sameValue(optionValues(byLabel(next, '思考档位', 'select')).map((o) => o.value), ['', 'low', 'high'], 'A 的迟到响应只能写自己的 key')
})

test('思考档位：读取失败不伪造档位、不发任何 PUT', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: { defaultModel: { provider: 'pa', model: 'ma', reasoningEffort: 'high' }, members: [] },
    efforts: { 'pa/ma': () => jsonReply({ ok: false, error: 'adapter 未注册' }, 500) },
  })
  const { tree, hooks } = await renderPopup(server)
  const effort = byLabel(tree, '思考档位', 'select')
  assert.ok(effort, '读取失败也占位，只是禁用')
  assert.equal(effort.props.disabled, true, '没有 metadata 不许选')
  assert.match(String(effort.props.title), /读取失败/, '禁用原因要写在控件上')
  assert.match(textOf(effort), /high（模型未公布）/, '旧值仍可见，不被静默吞掉')
  assert.equal(buttonNamed(tree, '设为新队员默认').props.disabled, true)
  assert.equal(buttonNamed(tree, '应用到当前队员').props.disabled, true)
  buttonNamed(tree, '设为新队员默认').props.onClick()
  buttonNamed(tree, '应用到当前队员').props.onClick()
  await hooks.settle()
  assert.equal(server.calls.filter((c) => c.method === 'PUT').length, 0)
})

test('思考档位：继承来的旧档位不在公布列表时不静默发送，换模型即清理', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }, { id: 'mb', name: 'MB' }] }],
    view: { defaultModel: { provider: 'pa', model: 'ma', reasoningEffort: 'ultra' }, members: [] },
    efforts: {
      'pa/ma': { efforts: EFFORTS_4, supported: true, defaultEffort: 'high' },
      'pa/mb': { efforts: [{ id: 'low' }, { id: 'high' }], supported: true },
    },
  })
  const { tree, rerender } = await renderPopup(server)
  const options = optionValues(byLabel(tree, '思考档位', 'select'))
  sameValue(options.map((o) => o.value), ['', 'off', 'low', 'high', 'max', 'ultra'], '旧值看得见，不被静默清空')
  assert.match(options[5].label, /当前值，模型未公布/)
  assert.equal(buttonNamed(tree, '设为新队员默认').props.disabled, true, '未知档位不许入站')

  byLabel(tree, '模型', 'select').props.onChange({ target: { value: 'mb' } })
  const next = await rerender()
  assert.equal(byLabel(next, '思考档位', 'select').props.value, '', '换模型即清旧档位')
  assert.equal(buttonNamed(next, '设为新队员默认').props.disabled, false)
})

test('思考档位：默认项省略 reasoningEffort，选中档位随 selection 提交', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: { defaultModel: { provider: 'pa', model: 'ma' }, members: [] },
    efforts: { 'pa/ma': { efforts: EFFORTS_4, supported: true, defaultEffort: 'high' } },
  })
  const { tree, hooks, rerender } = await renderPopup(server)

  buttonNamed(tree, '设为新队员默认').props.onClick()
  await hooks.settle()
  assert.deepEqual(server.calls.filter((c) => c.method === 'PUT')[0].body.selection, { provider: 'pa', model: 'ma' }, '空档位必须省略字段')

  let next = await rerender()
  byLabel(next, '思考档位', 'select').props.onChange({ target: { value: 'max' } })
  next = await rerender()
  assert.equal(byLabel(next, '思考档位', 'select').props.value, 'max')
  buttonNamed(next, '设为新队员默认').props.onClick()
  await hooks.settle()
  assert.deepEqual(server.calls.filter((c) => c.method === 'PUT')[1].body.selection, { provider: 'pa', model: 'ma', reasoningEffort: 'max' })
})

test('思考档位：两个按钮都带 reasoningEffort 提交', async () => {
  const activeNames = ['w1', 'w2']
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: {
      defaultModel: null,
      members: [
        { id: 'm1', name: 'w1', phase: 'active', currentModel: null, nextModel: { provider: 'pa', model: 'ma' } },
        { id: 'm2', name: 'w2', phase: 'active', currentModel: null, nextModel: { provider: 'pa', model: 'ma' } },
      ],
    },
    efforts: { 'pa/ma': { efforts: [{ id: 'low' }, { id: 'high' }], supported: true } },
  })
  const { tree, hooks, rerender } = await renderPopup(server, { activeNames })
  byLabel(tree, '思考档位', 'select').props.onChange({ target: { value: 'high' } })
  const next = await rerender()
  buttonNamed(next, '应用到当前队员').props.onClick()
  await hooks.settle()
  const puts = server.calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 2)
  assert.deepEqual(puts.map((c) => c.body.target), ['m1', 'm2'])
  for (const put of puts) {
    assert.deepEqual(put.body.selection, { provider: 'pa', model: 'ma', reasoningEffort: 'high' })
  }
})

test('逐成员推理强度：复用同一 effort bank，改档立即 PUT 且回填一致', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: {
      defaultModel: null,
      members: [{ id: 'm1', name: 'w1', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: null }],
    },
    efforts: { 'pa/ma': { efforts: [{ id: 'low' }, { id: 'high' }], supported: true, defaultEffort: 'low' } },
  })
  const { tree, hooks, rerender } = await renderPopup(server, { activeNames: ['w1'] })
  const member = byClass(tree, 'tmm-team-member')[0]
  const select = byLabel(member, '思考档位', 'select')
  assert.ok(select, '成员行必须显示思考档位')
  sameValue(optionValues(select).map((o) => o.value), ['', 'low', 'high'])
  assert.equal(server.calls.filter((c) => c.method === 'GET' && c.url.includes('/efforts?')).length, 1, '草稿与成员行同 model 只问一次')

  select.props.onChange({ target: { value: 'high' } })
  await hooks.settle()
  const put = server.calls.filter((c) => c.method === 'PUT')[0]
  assert.equal(put.body.target, 'm1')
  assert.deepEqual(put.body.selection, { provider: 'pa', model: 'ma', reasoningEffort: 'high' })

  const next = await rerender()
  assert.equal(byLabel(byClass(next, 'tmm-team-member')[0], '思考档位', 'select').props.value, 'high', '回填与显示读同一份 bank')
})

// ---------------------------------------------------------------------------
// 「应用到当前队员」真实链路：onClick → 过滤 → PUT payload → 读回 state.view
// ---------------------------------------------------------------------------

/** 造一份 Host 视图：成员默认 phase=active（Host 用 status 折算，见 buildTeamView）。 */
function memberView(members, extra) {
  return { defaultModel: null, members, ...(extra || {}) }
}

test('应用到当前队员：官方投影未知（activeNames undefined）时按 Host 成员状态应用，不排空', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: memberView([
      { id: 'm1', name: 'w1', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
      { id: 'm2', name: 'w2', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
    ]),
    efforts: { 'pa/ma': { efforts: [{ id: 'low' }, { id: 'high' }], supported: true } },
  })
  const { tree, hooks, rerender } = await renderPopup(server)
  assert.match(textOf(tree), /活动名单由 Host 实时核验/, '明确由 Host 核验名单')

  const modelSelect = findAll(byClass(tree, 'tmm-team-row')[1], (n) => n.type === 'select')[0]
  modelSelect.props.onChange({ target: { value: 'ma' } })
  const next = await rerender()
  assert.equal(buttonNamed(next, '应用到当前队员').props.disabled, false)

  buttonNamed(next, '应用到当前队员').props.onClick()
  await hooks.settle()
  const puts = server.calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 2, '空名单不能把所有人排空')
  assert.deepEqual(puts.map((c) => c.body.target), ['m1', 'm2'])
  for (const put of puts) assert.deepEqual(put.body.selection, { provider: 'pa', model: 'ma' })
})

test('应用到当前队员：成功后读回 state.view，成员行立刻显示新的下轮选择', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }, { id: 'mb', name: 'MB' }] }],
    view: memberView([
      { id: 'm1', name: 'w1', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
    ]),
    efforts: {
      'pa/ma': { efforts: [], supported: true },
      'pa/mb': { efforts: [], supported: true },
    },
  })
  const { tree, hooks, rerender } = await renderPopup(server, { activeNames: ['w1'] })
  const modelSelect = findAll(byClass(tree, 'tmm-team-row')[1], (n) => n.type === 'select')[0]
  modelSelect.props.onChange({ target: { value: 'mb' } })
  const next = await rerender()

  assert.match(textOf(byClass(next, 'tmm-team-route-info')[0]), /下轮选择：pa\/ma/)
  buttonNamed(next, '应用到当前队员').props.onClick()
  await hooks.settle()

  const after = await rerender()
  assert.match(textOf(byClass(after, 'tmm-team-route-info')[0]), /下轮选择：pa\/mb/, '保存成功后页面必须回读，不能看起来没生效')
  assert.match(textOf(byClass(after, 'tmm-team-ok')[0] || { children: [] }), /已保存 1 名/)
})

test('应用到当前队员：传输层失联标「未确认」，不假称已保存也不动 revision', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }, { id: 'mb', name: 'MB' }] }],
    view: memberView([
      { id: 'm1', name: 'w1', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
    ]),
    efforts: { 'pa/ma': { efforts: [], supported: true }, 'pa/mb': { efforts: [], supported: true } },
  })
  // 读接口照常，写接口模拟官方连接层失败（outer error）——响应没回来，不能断言写没发生。
  const lossy = {
    calls: server.calls,
    rpc: async (channel, endpoint, payload) => {
      if (endpoint === 'team-member-model/saveTeam') {
        return { ok: false, error: { code: 'gateway/internal', message: 'transport failure for /api/team-member-model/saveTeam: HTTP 502', details: {} } }
      }
      return server.rpc.call(channel, endpoint, payload)
    },
  }

  const { tree, hooks, rerender } = await renderPopup(lossy, { activeNames: ['w1'] })
  const modelSelect = findAll(byClass(tree, 'tmm-team-row')[1], (n) => n.type === 'select')[0]
  modelSelect.props.onChange({ target: { value: 'mb' } })
  const next = await rerender()
  buttonNamed(next, '应用到当前队员').props.onClick()
  await hooks.settle()

  const after = await rerender()
  const text = textOf(after)
  assert.match(text, /未确认 1 名/, '响应丢失只能说未确认')
  assert.doesNotMatch(text, /已保存 1 名/, '不许假称已写入')
  assert.match(textOf(byClass(after, 'tmm-team-route-info')[0]), /下轮选择：pa\/ma/, '没确认的写不能改回读到的 view')
  assert.equal(server.view().revision, 1, '未确认的写不许推进 CAS revision')
})

test('应用到当前队员：零合格成员时明确提示，不发 PUT', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: memberView([
      { id: 'm1', name: 'w1', phase: 'provisioning', currentModel: null, nextModel: null },
      { id: 'm2', name: 'w2', phase: 'failed', currentModel: null, nextModel: null },
      { id: 'm3', name: 'w3', phase: 'unavailable', currentModel: null, nextModel: null },
    ], { defaultModel: { provider: 'pa', model: 'ma' } }),
    efforts: { 'pa/ma': { efforts: [], supported: true } },
  })
  const { tree, hooks, rerender } = await renderPopup(server, { activeNames: ['w1', 'w2', 'w3'] })
  assert.match(textOf(tree), /未激活（只读）/)
  buttonNamed(tree, '应用到当前队员').props.onClick()
  await hooks.settle()
  assert.equal(server.calls.filter((c) => c.method === 'PUT').length, 0)
  const after = await rerender()
  assert.match(textOf(after), /没有可应用的队员/, '零合格要说人话，不能只写跳过 2 名')
})

test('思考档位：还没选模型时占位写「先选模型」并禁用', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: { defaultModel: null, members: [] },
    efforts: {},
  })
  const { tree } = await renderPopup(server)
  const effort = byLabel(tree, '思考档位', 'select')
  assert.ok(effort, '控件常驻')
  assert.equal(effort.props.disabled, true)
  assert.match(textOf(effort), /先选模型/)
})

test('应用到当前队员：官方明确空名单（activeNames []）零写入，并说明没有活动队员', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: memberView([
      { id: 'm1', name: 'w1', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
      { id: 'm2', name: 'w2', phase: 'active', currentModel: { provider: 'pa', model: 'ma' }, nextModel: { provider: 'pa', model: 'ma' } },
    ], { defaultModel: { provider: 'pa', model: 'ma' } }),
    efforts: { 'pa/ma': { efforts: [], supported: true } },
  })
  const { tree, hooks, rerender } = await renderPopup(server, { activeNames: [] })
  assert.match(textOf(tree), /当前没有活动队员/, '已知空名单要讲成结论，不是「未知」')

  buttonNamed(tree, '应用到当前队员').props.onClick()
  await hooks.settle()
  assert.equal(server.calls.filter((c) => c.method === 'PUT').length, 0, '明确空名单不许拿 Host phase 顶替写下去')
  const after = await rerender()
  assert.match(textOf(after), /当前没有活动队员，未写入任何设置/)
})

test('应用到当前队员：Lead 永不作为目标，已有名单时严格按名单过滤', async () => {
  const server = teamServer({
    catalog: [{ id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'MA' }] }],
    view: memberView([
      { id: 'lead-1', name: 'lead', phase: 'active', currentModel: null, nextModel: null },
      { id: 'm1', name: 'w1', phase: 'active', currentModel: null, nextModel: { provider: 'pa', model: 'ma' } },
      { id: 'm2', name: 'w2', phase: 'active', currentModel: null, nextModel: { provider: 'pa', model: 'ma' } },
    ], { defaultModel: { provider: 'pa', model: 'ma' } }),
    efforts: { 'pa/ma': { efforts: [], supported: true } },
  })

  // unknown 名单：Host phase 兜底，但 Lead 必须被挡掉
  const first = await renderPopup(server)
  buttonNamed(first.tree, '应用到当前队员').props.onClick()
  await first.hooks.settle()
  assert.deepEqual(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body.target), ['m1', 'm2'])

  // 已知名单只含 w1：严格过滤，w2 不再被写
  server.calls.length = 0
  const second = await renderPopup(server, { activeNames: ['w1'] })
  buttonNamed(second.tree, '应用到当前队员').props.onClick()
  await second.hooks.settle()
  assert.deepEqual(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body.target), ['m1'])
})
