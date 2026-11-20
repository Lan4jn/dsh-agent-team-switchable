/**
 * 客户端半侧的离线测试：用 node:vm 在假 window/document 里真跑一遍 lib/client.js。
 *
 * 为什么必须有它：客户端半侧的 bug 全部是"页面能打开但不对"这一类，肉眼只能靠用户截图发现。
 * 0.2.1 就漏了样式注入——CSS 字符串定义了却从没 append 到 document，
 * 页面渲染成一排挤在一起、模型 id 与显示名粘连。这条测试专门钉住那件事。
 * 0.3.0 起还多一条：页面自己那份 describeRule 摘要必须与 Host 半侧 lib/rules.js 逐字一致，
 * 否则「列表上写的规则」和「真正生效的规则」会对不上。
 *
 * 运行：node test/client.mjs
 * 作者：hwj
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { describeRule as hostDescribeRule, normalizeRule } from '../lib/rules.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 跨 realm 的结构比较。
 *
 * 为什么不用 deepStrictEqual：`mod._*` 返回的对象/数组是在 vm 里创建的，原型与本文件
 * 不是同一个，deepStrictEqual 会因为「结构相同但引用不等」直接报错（0.2.1 注释里踩过）。
 * JSON 往返只比结构与值，正好是这里要的语义。
 */
function sameValue(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
}

/**
 * 造一个假浏览器环境并执行客户端半侧。
 *
 * @returns {{ definition: object, styles: string[], queried: string[] }} 捕获到的 ModuleLoader 定义、
 *   注入的样式文本，以及 querySelector 收到过的选择器。
 */
function runClient(options = {}) {
  const styles = []
  const queried = []
  const appended = []
  const sandbox = {
    console,
    ...(options.globals || {}),
    document: {
      head: {
        appendChild(node) {
          appended.push(node)
          styles.push(node.textContent)
        },
      },
      // 第一次返回 null（未注入），之后返回已存在——用来同时验证去重逻辑。
      querySelector(selector) {
        queried.push(selector)
        return appended.length === 0 ? null : appended[0]
      },
      createElement(tag) {
        return { tag, dataset: {}, textContent: '' }
      },
    },
  }
  sandbox.window = {
    __ModuleLoader__: {
      loaded: undefined,
      load(definition) {
        sandbox.window.__ModuleLoader__.loaded = definition
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  return { definition: sandbox.window.__ModuleLoader__.loaded, styles, queried }
}

/** 假 react：factory 阶段只会用到 createElement。 */
function fakeRequire(name) {
  if (name === 'react') return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({}) }
  throw new Error(`未预期的 require：${name}`)
}

const { definition, styles } = runClient()

check('ModuleLoader 收到定义，id 与包名一致', () => {
  assert.ok(definition, 'window.__ModuleLoader__.load 没有被调用')
  assert.equal(definition.id, 'dsh-team-member-model')
  assert.equal(typeof definition.factory, 'function')
})

const mod = definition.factory(fakeRequire)

check('样式被注入 document.head（0.2.1 首版漏掉的那一步）', () => {
  assert.equal(styles.length, 1, `期望注入 1 份样式，实际 ${styles.length}`)
  assert.match(styles[0], /\.tmm-section\{/)
  assert.match(styles[0], /\.tmm-panel\{/)
})

check('重做后的排版契约在位：摘要行省略、动作按需出现、粘性保存栏、键盘焦点环', () => {
  // 长 key / 摘要必须能省略，否则窄侧栏里会把布局撑破。
  assert.match(styles[0], /\.tmm-key\{min-width:0;overflow:hidden;text-overflow:ellipsis/)
  assert.match(styles[0], /\.tmm-sum\{flex:1;min-width:0;overflow:hidden/)
  // 行内动作默认透明，hover / 键盘聚焦（focus-within）才出现 —— 这是「不再密密麻麻」的关键。
  assert.match(styles[0], /\.tmm-actions\{display:flex;[^}]*opacity:0/)
  assert.match(styles[0], /\.tmm-item:focus-within \.tmm-actions\{opacity:1\}/)
  // 保存栏粘底，状态文字右对齐。
  assert.match(styles[0], /\.tmm-bar\{position:sticky;bottom:0/)
  // 焦点环不能省（键盘可用性）。
  assert.match(styles[0], /\.tmm-section :focus-visible\{outline:2px solid var\(--dsw-alias-state-business-primary\)/)
  // 只用主题 token 里真实存在的变量：不出现自造的 token 名。
  assert.ok(styles[0].indexOf('--dsw-alias-state-warning-primary') === -1, '用了不存在的 token（真实名是 state-warn-primary）')
})

check('重复执行 factory 不会叠第二份样式（data-plugin-css 去重）', () => {
  const before = styles.length
  definition.factory(fakeRequire)
  assert.equal(styles.length, before, '样式被重复注入')
})

check('插件契约：apply 与 inject 齐备（slots + 官方 connection）', () => {
  assert.equal(typeof mod.apply, 'function')
  // 逐元素比较而不是 deepEqual：vm 里创建的数组属于另一个 realm，
  // deepStrictEqual 会因原型不同而报 "same structure but not reference-equal"。
  assert.equal(mod.inject.length, 2)
  assert.equal(mod.inject[0], 'slots')
  assert.equal(mod.inject[1], 'connection')
})

check('apply 把设置页与团队菜单分别注册进 settings.section 与 header.actions 槽位', () => {
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injections.push(name)
        registrations.push(factory())
      },
      register(options, component) {
        return { options, component }
      },
    },
    // 生产环境一定有官方连接通道；缺它时 apply 仍要能注册（只出诊断警告，见 client-transport）。
    connection: { rpc: { call: async () => ({ ok: true, value: { status: 200, body: { ok: true } } }) } },
  }
  mod.apply(ctx)
  assert.deepEqual(injections, ['settings.section', 'conversation.session.header.actions'])
  assert.equal(registrations.length, 2)
  const [s0, s1] = registrations
  assert.equal(s0.options.name, 'settings.section')
  assert.equal(s0.options.id, 'team-member-model')
  assert.equal(s0.options.label, '模型路由')
  assert.equal(typeof s0.component, 'function')
  assert.equal(s1.options.name, 'conversation.session.header.actions')
  assert.equal(s1.options.id, 'team-model-settings')
  assert.equal(s1.options.order, -19)
  assert.equal(typeof s1.component, 'function')
})

check('保存响应不含目录时沿用已加载目录（0.2.1 保存一次候选就全消失）', () => {
  const catalog = [{ id: 'zai-coding-cn', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'glm-4.6v', name: 'GLM-4.6V' }] }]
  const next = mod._applyPayload(
    { policy: { members: [{ name: 'glm', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] }], rules: [] } },
    catalog,
  )
  assert.equal(next.catalog.length, 1, '目录被清空了')
  assert.equal(next.catalog[0].models.length, 2)
  assert.equal(next.members.length, 1)
})

check('GET 响应带目录时用响应里的；策略字段逐个落进草稿', () => {
  const next = mod._applyPayload({
    policy: {
      members: [{ name: 'flash', weight: 3, bindings: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] }],
      rules: [{ use: 'opencode-go/deepseek-v4.1-flash', channel: 'fork' }],
      match: ['zai-coding-cn/*'],
      pick: 'opencode-go/deepseek-v4.1-flash',
      off: ['zai-coding-cn/glm-5.3'],
      routing: 'weight',
      allowFork: true,
      failover: { enabled: false, patience: 4 },
      classifier: { enabled: true, provider: 'zai-coding-cn', model: 'glm-5.3' },
    },
    catalog: [{ id: 'opencode-go', models: [{ id: 'deepseek-v4.1-flash' }] }],
    trace: [{ outcome: 'injected' }],
  })
  assert.equal(next.catalog.length, 1)
  assert.equal(next.routing, 'weight')
  assert.equal(next.allowFork, true)
  assert.equal(next.pick, 'opencode-go/deepseek-v4.1-flash')
  sameValue(next.off, ['zai-coding-cn/glm-5.3'])
  sameValue(next.match, ['zai-coding-cn/*'])
  sameValue(next.failover, { enabled: false, patience: 4 })
  sameValue(next.classifier, { enabled: true, provider: 'zai-coding-cn', model: 'glm-5.3' })
  assert.equal(next.trace.length, 1)
})

check('识别 Host 半侧版本：老响应（只有 routes）要当混合状态报出来', () => {
  // 2026-10-16 用户踩到的就是这个：客户端半侧刷新即新版，Host 半侧只在进程启动时加载。
  assert.equal(mod._hostSupport({ routes: [{ provider: 'a', model: 'x' }] }), 'legacy')
  assert.equal(mod._hostSupport({ routes: [], catalog: [] }), 'legacy')
  assert.equal(mod._hostSupport({ policy: { members: [] }, catalog: [] }), 'v3')
  // 出错时没有这两个字段：不误报成 legacy。
  assert.equal(mod._hostSupport({}), 'v3')

  const next = mod._applyPayload({ routes: [{ provider: 'a', model: 'x' }] }, [])
  assert.equal(next.host, 'legacy')
  // routes 不进成员表：老接口的字段只用于兼容展示，权威值永远是 policy.members。
  sameValue(next.members, [])
  sameValue(next.routes, [{ provider: 'a', model: 'x' }])

  const modern = mod._applyPayload({ policy: { members: [{ name: 'x', bindings: [{ provider: 'a', model: 'x' }] }] } }, [])
  assert.equal(modern.host, 'v3')
  assert.equal(modern.members.length, 1)
})

check('草稿 → 请求体：空值不送、weight/effort 按需带上', () => {
  const body = mod._policyFromDraft({
    members: [
      { name: 'glm-max', weight: '2', bindings: [
        { provider: 'a', model: '1', reasoningEffort: 'high' },
        { provider: 'b', model: '1', reasoningEffort: 'high', off: true, time: { from: '09:00', to: '12:00' } },
      ] },
      { name: 'cheap', bindings: [{ provider: 'b', model: '2' }] },
    ],
    rules: [{ use: 'glm-max' }],
    match: ['c/*'],
    pick: null,
    off: [],
    routing: 'order',
    allowFork: false,
    failover: { enabled: true, patience: '3' },
    classifier: { enabled: false, provider: '', model: '' },
  })
  sameValue(body.members, [
    // 键序就是序列化顺序：name → bindings → weight
    { name: 'glm-max', bindings: [
      { provider: 'a', model: '1', reasoningEffort: 'high' },
      { provider: 'b', model: '1', reasoningEffort: 'high', off: true, time: { from: '09:00', to: '12:00' } },
    ], weight: 2 },
    { name: 'cheap', bindings: [{ provider: 'b', model: '2' }] },
  ])
  sameValue(body.rules, [{ use: 'glm-max' }])
  sameValue(body.match, ['c/*'])
  assert.equal(body.pick, null)
  sameValue(body.failover, { enabled: true, patience: 3 })
  sameValue(body.classifier, { enabled: false }, '分类器的空串不该送出去（否则 Host 会拒整份配置）')
  assert.equal('match' in body, true, '非空的 match 要照送')
})

check('空值不送字段：match 为空时不能送 []（用户实报的保存失败就是这个）', () => {
  const base = {
    members: [{ name: 'one', bindings: [{ provider: 'a', model: '1' }] }], rules: [], off: [],
    routing: 'order', allowFork: false,
    failover: { enabled: true, patience: 2 },
    classifier: { enabled: false, provider: '', model: '' },
  }
  const empty = mod._policyFromDraft({ ...base, match: [], pick: null })
  assert.equal('match' in empty, false, '空 match 必须整个字段不送')

  const filled = mod._policyFromDraft({ ...base, match: ['opencode-go/*', ''], pick: null })
  sameValue(filled.match, ['opencode-go/*'], '过滤掉空项后仍要送')

  // pick 是契约里的显式值：null 要照送（表示「不指定」）。
  assert.equal('pick' in empty, true)
  assert.equal(empty.pick, null)
})

/**
 * 极简交互测试台：真实执行组件体，按标签找到按钮并触发 onClick，然后重渲染。
 *
 * 为什么必须有：2026-10-19 用户报「点新增就白屏」，根因是渲染期 ReferenceError
 * （抽取编辑器时残留 `ruleItems.push(`）。纯静态断言抓不到这类崩溃——
 * 必须在假 React 里真跑一次组件体。这不是「渲染出画面」，只判断有没有异常。
 */
function clickHarness() {
  const holder = { state: null }
  const rpcCalls = []
  const pageFetches = []
  const reactStub = {
    createElement(type, props) {
      const flat = []
      const push = (v) => {
        if (Array.isArray(v)) v.forEach(push)
        else if (v !== null && v !== undefined && v !== false) flat.push(v)
      }
      Array.prototype.slice.call(arguments, 2).forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(init) {
      if (holder.state === null) holder.state = init
      return [holder.state, function (next) {
        const upd = typeof next === 'function' ? next : function () { return next }
        Object.assign(holder.state, upd(holder.state))
      }]
    },
    // 立刻跑一次：设置页挂载时的 state / usage 读取也要真走连接通道（不是页面 fetch）。
    useEffect(fn) { fn() },
  }
  const source2 = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sandbox = {
    console,
    fetch: (url) => {
      pageFetches.push(String(url))
      throw new Error(`模型设置不得使用页面 fetch：${url}`)
    },
    document: { head: { appendChild() {} }, querySelector: () => ({}), createElement: () => ({ dataset: {}, textContent: '' }) },
  }
  sandbox.window = { __ModuleLoader__: { load: (d) => { sandbox.window.__ModuleLoader__.loaded = d } } }
  vm.createContext(sandbox)
  vm.runInContext(source2, sandbox, { filename: 'lib/client.js' })
  const def = sandbox.window.__ModuleLoader__.loaded
  const mod2 = def.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('require ' + name)
  })
  const regs = []
  const hostBodies = {
    'team-member-model/state': (payload) => ({ ok: true, policy: {}, catalog: [], trace: [], rests: [], sink: [] }),
    'team-member-model/usage': () => ({ ok: true, startedAt: '', totals: {}, members: [], rules: [], sources: [], hours: [] }),
    'team-member-model/resetUsage': () => ({ ok: true, startedAt: '', totals: {}, members: [], rules: [], sources: [], hours: [] }),
    'team-member-model/savePolicy': (payload) => ({ ok: true, policy: payload.policy }),
    'team-member-model/efforts': () => ({ ok: true, efforts: [], supported: true }),
  }
  mod2.apply({
    slots: { inject: (n, f) => regs.push(f()), register: (o, c) => ({ options: o, component: c }) },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload })
          const body = hostBodies[endpoint]
          if (!body) throw new Error(`未模拟的端点：${endpoint}`)
          return { ok: true, value: { status: 200, body: body(payload || {}) } }
        },
      },
    },
  })
  const Component = regs[0].component

  holder.state = null
  let tree = Component()
  // 造出真实感的数据：成员 + 关键词规则 + 兜底规则 + 条件规则
  Object.assign(holder.state, {
    loading: false,
    hostVersion: 'v4',
    members: [
      { name: 'workhorse', weight: 12, bindings: [{ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }] },
      { name: 'glm-max', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }] },
    ],
    rules: [
      { use: 'glm-max', label: '*review*' },
      { use: 'glm-max', images: true },
      { use: 'workhorse', continuable: false },
    ],
    catalog: [{ id: 'dsh-opencode-go', models: [{ id: 'deepseek-v4.1-flash' }] }, { id: 'zai-coding-cn', models: [{ id: 'glm-5.3' }] }],
  })
  tree = Component()

  const walk = (node, out = []) => {
    if (node && node.type) {
      out.push(node)
      ;(node.children || []).forEach((c) => walk(c, out))
    }
    return out
  }
  const textOf = (node) => (node.children || []).map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
  return {
    click(label) {
      const btn = walk(tree).find((n) => n.type === 'button' && textOf(n).includes(label))
      assert.ok(btn, `找不到按钮：${label}`)
      btn.props.onClick()
      tree = Component()
    },
    clickTitle(title) {
      const btn = walk(tree).find((n) => n.type === 'button' && n.props.title === title)
      assert.ok(btn, `找不到按钮（title=${title}）`)
      btn.props.onClick()
      tree = Component()
    },
    clickChip(word) {
      const btn = walk(tree).find((n) => n.type === 'button' && n.props.className === 'tmm-kw-main' && textOf(n) === word)
      assert.ok(btn, `找不到关键词胶囊：${word}`)
      btn.props.onClick()
      tree = Component()
    },
    change(type, value) {
      const node2 = walk(tree).find((n) => n.type === type)
      assert.ok(node2, `找不到 ${type}`)
      node2.props.onChange({ target: { value } })
      tree = Component()
    },
    state: () => holder.state,
    tree: () => tree,
    calls: () => rpcCalls,
    pageFetches: () => pageFetches,
    hasInput: (hint) => walk(tree).some((n) => n.type === 'input' && String(n.props.placeholder || '').indexOf(hint) !== -1),
    text: () => walk(tree).map((n) => (typeof n === 'string' ? n : '')).join(' ') + walk(tree).filter((n) => n.type === 'div' || n.type === 'span').map((n) => textOf(n)).join(' '),
    clickMemberRow(name) {
      const row = walk(tree).find((n) => n.type === 'div' && n.props.className && String(n.props.className).indexOf('tmm-ubar') !== -1 && textOf(n).indexOf(name) !== -1)
      assert.ok(row, `找不到用量行：${name}`)
      row.props.onClick()
      tree = Component()
    },
    hasSelect: () => walk(tree).some((n) => n.type === 'select'),
    render() { tree = Component(); return tree },
  }
}

check('分类器提示：不拦保存，但把后果说清（填不全 / 有意图规则却没开）', () => {
  assert.match(mod._classifierNotice({ enabled: true, provider: 'x', model: '' }, []).text, /没填全.*不会命中.*正常保存/)
  assert.equal(mod._classifierNotice({ enabled: true, provider: 'x', model: 'y' }, []).level, 'info')
  assert.match(mod._classifierNotice({ enabled: false }, [{ use: 'a/1', intent: '写测试' }]).text, /1 条规则带「意图」条件/)
  assert.equal(mod._classifierNotice({ enabled: false }, [{ use: 'a/1' }]), null)
})

check('合并建议：同模型多渠道的单绑定成员才建议合并；多绑定成员不碰', () => {
  const members = [
    { name: 'zai-glm', bindings: [{ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }] },
    { name: 'oc-glm', bindings: [{ provider: 'opencode-go', model: 'glm-5.3', reasoningEffort: 'max' }] },
    { name: 'multi', bindings: [{ provider: 'a', model: 'same' }, { provider: 'b', model: 'same' }] },
    { name: 'solo', bindings: [{ provider: 'c', model: 'solo' }] },
  ]
  const suggestions = mod._mergeSuggestions(members)
  assert.equal(suggestions.length, 1, '只有 glm-5.3:max 那一组该被建议')
  sameValue(suggestions[0].names, ['zai-glm', 'oc-glm'])
  assert.equal(suggestions[0].name, 'glm-5.3:max', '合并后的名字按模型+档位起，不带渠道')

  const merged = mod._applyMerge(
    [{ ...members[0], weight: 2 }, members[1]],
    [{ use: 'zai-glm', label: '*review*' }, { use: 'oc-glm' }],
    'oc-glm', ['zai-glm'],
    suggestions[0],
  )
  assert.equal(merged.members.length, 1)
  assert.equal(merged.members[0].weight, 2)
  assert.equal(merged.members[0].bindings.length, 2)
  sameValue(merged.rules.map((r) => r.use), [suggestions[0].name, suggestions[0].name])
  assert.equal(merged.pick, suggestions[0].name)
  sameValue(merged.off, [suggestions[0].name])
})

check('成员校验：名字必填/唯一、绑定必填、规则必须指向存在的成员', () => {
  assert.match(mod._validateDraft({ members: [{ name: '', bindings: [{ provider: 'a', model: '1' }] }], rules: [] }), /没有名字/)
  assert.match(mod._validateDraft({
    members: [
      { name: 'x', bindings: [{ provider: 'a', model: '1' }] },
      { name: 'x', bindings: [{ provider: 'b', model: '2' }] },
    ], rules: [],
  }), /重复/)
  assert.match(mod._validateDraft({ members: [{ name: 'x', bindings: [] }], rules: [] }), /至少要有/)
  assert.match(mod._validateDraft({ members: [{ name: 'x', bindings: [{ provider: 'a' }] }], rules: [] }), /缺少 provider/)
  assert.match(mod._validateDraft({
    members: [{ name: 'x', bindings: [{ provider: 'a', model: '1' }] }],
    rules: [{ use: 'nope' }],
  }), /不在成员表里/)
  assert.equal(mod._validateDraft({ members: [{ name: 'x', bindings: [{ provider: 'a', model: '1' }] }], rules: [{ use: 'x' }] }), '')
})

check('用量图表纯函数：token 格式化、条宽、排序', () => {
  assert.equal(mod._formatTokens(0), '0')
  assert.equal(mod._formatTokens(999), '999')
  assert.equal(mod._formatTokens(1500), '1.5K')
  assert.equal(mod._formatTokens(45000), '45K')
  assert.equal(mod._formatTokens(1234567), '1.23M')
  assert.equal(mod._formatTokens(undefined), '0')

  assert.equal(mod._barPercent(50, 100), 50)
  assert.equal(mod._barPercent(0, 100), 0)
  assert.equal(mod._barPercent(5, 0), 0, '最大值缺失时不该算出 Infinity')
  assert.equal(mod._barPercent(1, 100000), 1, '极小但非零要看得见')
  assert.equal(mod._barPercent(200, 100), 100, '不超过 100%')

  const rows = [{ member: 'b', totalTokens: 10, calls: 5 }, { member: 'a', totalTokens: 99, calls: 1 }, { member: 'c', totalTokens: 10, calls: 9 }]
  sameValue(mod._sortUsageRows(rows, 'totalTokens').map((r) => r.member), ['a', 'b', 'c'])
  sameValue(mod._sortUsageRows(rows, 'calls').map((r) => r.member), ['c', 'b', 'a'])
  sameValue(rows.map((r) => r.member), ['b', 'a', 'c'], '排序不该改原数组')
})

check('样式回归：编辑器内的操作按钮必须常显（渠道绑定行不在 .tmm-item 里）', () => {
  // 2026-10-20 用户实报「成员渠道没办法删除」：按钮在 DOM 里、逻辑也对，
  // 但 .tmm-actions 默认 opacity:0 且只由 .tmm-item:hover 打开，绑定行永远透明。
  const css = mod._styles()
  assert.match(css, /\.tmm-editor \.tmm-actions\{opacity:1\}/)
  assert.match(css, /\.tmm-binding:hover/)
})

check('交互回归：点新增/展开/点关键词胶囊都不许崩（白屏）', () => {
  const ui = clickHarness()
  // 用户实报的三个白屏入口，逐个真点一遍。
  ui.click('添加成员')
  ui.click('新增条件规则')
  ui.clickChip('review')
  assert.ok(ui.state().openRule !== -1, '点胶囊应当展开该规则的完整编辑器')
  ui.clickTitle('展开编辑')
  // 成员编辑器：名字输入 + 渠道绑定（provider/model 下拉）
  assert.ok(ui.hasInput('glm-max'), '展开成员后要能看到成员名输入（占位符带示例名）')
  assert.ok(ui.hasSelect(), '成员编辑器里要有渠道 select')

  // 用量面板：喂真实形状的数据再渲染一遍（图表的空数组/缺字段最容易在渲染期炸）
  Object.assign(ui.state(), {
    usageOpen: {},
    usage: {
      startedAt: '2026-10-19T10:00:00.000Z',
      totals: { runs: 12, calls: 34, inputTokens: 12345, outputTokens: 678, cacheReadTokens: 90000, cacheWriteTokens: 0, totalTokens: 103023 },
      members: [
        { member: 'workhorse', runs: 7, calls: 20, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100, bindings: [{ binding: 'dsh-opencode-go/deepseek-v4.1-flash', runs: 7, calls: 20, totalTokens: 1100 }] },
        { member: 'glm-max', runs: 5, calls: 14, inputTokens: 900, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 980, bindings: [{ binding: 'zai-coding-cn/glm-5.3:max', runs: 5, calls: 14, totalTokens: 980 }] },
      ],
      bindings: [],
      rules: [{ rule: '#2 *review*', hits: 5 }, { rule: '#19 兜底', hits: 4 }],
      sources: [{ reason: 'rule', count: 10 }, { reason: 'unmanaged', count: 2 }],
      hours: Array.from({ length: 24 }, (_, i) => ({ hour: '2026-10-19T' + String(i).padStart(2, '0'), calls: i % 3, totalTokens: i * 100 })),
    },
  })
  ui.render()
  // 成员行点开 → 出现渠道明细（用户要求「按成员聚合但细分到渠道」）
  ui.clickMemberRow('workhorse')
  assert.ok(ui.text().includes('opencode-go/deepseek-v4.1-flash'), '展开成员后要能看到渠道明细行')
  assert.ok(ui.text().includes('1 渠道') || ui.text().includes('渠道'), '成员行要标出渠道数')
  ui.click('刷新')
  ui.click('清零')
  // 空数据 + 读不到接口两种边界也要能渲染
  Object.assign(ui.state(), { usage: { startedAt: '', totals: {}, members: [], rules: [], sources: [], hours: [] } })
  ui.render()
  Object.assign(ui.state(), { usage: null })
  ui.render()

  // 回归：分类器只填一半（开了但没选 model）也必须能保存——
  // 之前的硬拦截会让整次 PUT 一个字节都不发，刷新后所有改动一起丢。
  Object.assign(ui.state(), {
    usage: undefined,
    // 回到一份完整合法的 v4 草稿（前面点「添加成员」留下了一个未命名成员）+ 分类器只填一半
    members: [{ name: 'workhorse', bindings: [{ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }] }],
    rules: [],
    off: [],
    pick: null,
    classifier: { enabled: true, provider: 'dsh-opencode-go', model: '' },
  })
  ui.render()
  ui.click('保存更改')
  const save = ui.calls().find((c) => c.endpoint === 'team-member-model/savePolicy')
  assert.ok(save, '分类器填不全时保存必须真的经连接通道写策略')
  assert.equal(save.channel, '/dsh-team-member-model')
  sameValue(save.payload.policy.classifier, { enabled: true, provider: 'dsh-opencode-go' })

  // 设置页的读 / 刷新 / 清零也全在连接通道上：页面 fetch 一次都不许发生。
  const endpoints = ui.calls().map((c) => c.endpoint)
  assert.ok(endpoints.includes('team-member-model/state'), '挂载时要读 state')
  assert.ok(endpoints.includes('team-member-model/usage'), '挂载与刷新都要读 usage')
  assert.ok(endpoints.includes('team-member-model/resetUsage'), '清零要走同一条通道')
  assert.equal(ui.pageFetches().length, 0, `页面 fetch 调用：${ui.pageFetches().join(', ')}`)
})

check('规则分组视图：纯关键词规则进胶囊组，带条件的走 specialRules', () => {
  const rules = [
    { use: 'glm/max', label: '*review*' },
    { use: 'glm/max', label: '*审查*' },
    { use: 'glm/max', images: true },                       // 带图片条件 → special
    { use: 'v41', label: '*排查*', channel: 'spawn' },       // 带通道 → special
    { use: 'v41', continuable: false },                     // 兜底 → special
    { use: 'v41', label: '排查' },                           // 没有整词通配 → special（不能当胶囊，会改语义）
    { use: 'lite', label: '*翻译*' },
  ]
  const groups = mod._groupRules(rules)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].use, 'glm/max')
  sameValue(groups[0].labelRules.map((e) => e.word), ['review', '审查'])
  assert.equal(groups[0].specialRules.length, 1)
  assert.equal(groups[1].use, 'v41')
  // *排查* 带 channel、'排查' 不是整词通配 —— 两条都进 specialRules，不进胶囊。
  assert.equal(groups[1].labelRules.length, 0)
  assert.equal(groups[1].specialRules.length, 3)
  assert.equal(mod._isLabelRule(rules[3]), false, '带通道的不是纯关键词规则')
  assert.equal(mod._isLabelRule(rules[0]), true)
  assert.equal(mod._isLabelRule(rules[5]), false, 'label 不是 *整词* 通配的不进胶囊')
  assert.equal(mod._isLabelRule(rules[4]), false, '兜底规则不是关键词规则')
})

check('关键词插入位置：必须落在兜底规则之前、同组关键词之后', () => {
  const rules = [
    { use: 'glm/max', label: '*review*' },
    { use: 'lite', label: '*翻译*' },
    { use: 'glm/max', label: '*审查*' },      // 故意不连续：同组也能找到末尾
    { use: 'v41', continuable: false },       // 兜底在最后
    { use: 'pause/m', pause: true },
  ]
  // 给 glm/max 加词：应插在 index 2（*审查*）之后
  assert.equal(mod._keywordInsertIndex(rules, 'glm/max'), 3)
  // 给没有关键词组的成员加词：插在第一个兜底（index 3）之前
  assert.equal(mod._keywordInsertIndex(rules, 'mimo'), 3)
  // 没有兜底时追加到末尾
  assert.equal(mod._keywordInsertIndex([{ use: 'a', label: '*x*' }], 'b'), 1)
  // 插入后兜底仍在最后（顺序 = 命中优先级，不能被新词挤到后面）
  const grown = rules.slice()
  grown.splice(mod._keywordInsertIndex(rules, 'glm/max'), 0, { use: 'glm/max', label: '*审核*' })
  const catchallAt = grown.findIndex((r) => r.continuable === false)
  assert.equal(catchallAt, grown.length - 2, '兜底规则必须仍在 pause 之前、所有关键词之后')
})

check('成员身份键与模型身份键分开（档位进身份后）', () => {
  assert.equal(mod._memberKeyOf({ provider: 'zai', model: 'glm-5.3' }), 'zai/glm-5.3')
  assert.equal(mod._memberKeyOf({ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' }), 'zai/glm-5.3:low')
  // 同一模型两档并存时，成员行 / 规则 use 选项 / off 都按这个键记，互不覆盖。
  const keys = [{ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' }, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' }].map(mod._memberKeyOf)
  sameValue(keys, ['zai/glm-5.3:max', 'zai/glm-5.3:low'])
})

check('目录下拉（分类器 provider/model 用）：当前值不在目录里不许被清空', () => {
  const catalog = [{ value: 'zai-coding-cn', label: 'zai-coding-cn' }, { value: 'opencode-go', label: 'opencode-go' }]
  // 常规：空选项 + 目录项。
  sameValue(mod._catalogOptions(catalog, '', '选择…').map((o) => o.value), ['', 'zai-coding-cn', 'opencode-go'])
  // 当前值在目录里：不重复追加。
  sameValue(mod._catalogOptions(catalog, 'opencode-go', '选择…').map((o) => o.value), ['', 'zai-coding-cn', 'opencode-go'])
  // 当前值不在目录里（适配器没公布/手填过）：保留成一项，否则 select 一渲染就把值清了。
  const keep = mod._catalogOptions(catalog, 'ghost-provider', '选择…')
  sameValue(keep.map((o) => o.value), ['', 'zai-coding-cn', 'opencode-go', 'ghost-provider'])
  assert.match(keep[3].label, /当前值，目录未列出/)
  // 目录为空 + 没有当前值：只剩空选项。
  sameValue(mod._catalogOptions([], '', '选择…').map((o) => o.value), [''])
  // 连 list 都没给也不许抛。
  sameValue(mod._catalogOptions(undefined, '', '选择…').map((o) => o.value), [''])
})

check('保存成功后的回填不能再炸（真机实报：undefined join）', () => {
  // 2026-10-16 真机：match 为空时 policyFromDraft 不送该字段，save() 回调里
  // body.match.join(", ") 当场抛「Cannot read properties of undefined (reading 'join')」。
  const draft = {
    members: [{ name: 'one', bindings: [{ provider: 'a', model: '1' }] }], rules: [], off: [],
    routing: 'order', allowFork: false,
    failover: { enabled: true, patience: 2 },
    classifier: { enabled: false, provider: '', model: '' },
  }
  const emptyBody = mod._policyFromDraft({ ...draft, match: [], pick: null })
  assert.equal('match' in emptyBody, false)
  assert.equal(mod._matchTextOf(emptyBody), '')

  const filledBody = mod._policyFromDraft({ ...draft, match: ['opencode-go/*', 'zai-coding-cn/glm-*'], pick: null })
  assert.equal(mod._matchTextOf(filledBody), 'opencode-go/*, zai-coding-cn/glm-*')
  // 兜底：连 body 本身缺失也不该抛。
  assert.equal(mod._matchTextOf(undefined), '')
})

check('保存前本地校验：能在页面上说清的问题不要推给 Host', () => {
  // v4：规则必须指向存在的成员，所以合法样例要带上成员表。
  const ok = mod._validateDraft({
    members: [{ name: 'a-1', bindings: [{ provider: 'a', model: '1' }] }],
    rules: [{ use: 'a-1' }],
    classifier: { enabled: false },
  })
  assert.equal(ok, '')

  // pause 规则必须点名成员（否则 Host 的报错是「规则第 N 条：use 必须是非空字符串」，看不懂）。
  assert.match(mod._validateDraft({ rules: [{ use: '', pause: true }], classifier: {} }), /第 1 条规则/)
  assert.match(mod._validateDraft({ rules: [{ use: 'a1', pause: true }], classifier: {} }), /仅摘除该成员.*provider\/model/)

  // 分类器填不全**不许拦保存**：拦的是整份策略，别处的改动会跟着一起丢。
  // （2026-10-19 用户实报「分类器无法保存、刷新全丢」就是这条硬拦截造成的。）
  assert.equal(mod._validateDraft({ rules: [], classifier: { enabled: true, provider: 'x', model: '' } }), '',
    '分类器填不全时保存必须照发')
})

check('规则草稿 → 请求体：文本列表切分、time 由 from/to 组装、空串不送', () => {
  const rule = mod._ruleToPayload({
    use: 'a/1',
    label: '  ',
    folders: '~/proj , D:\\work',
    exceptFolders: ['~/big'],
    tokens: '50000',
    effort: 'high',
    from: '22:00',
    to: '08:00',
    days: ['fri', 'sat'],
    images: false,
  })
  sameValue(rule, {
    use: 'a/1',
    folders: ['~/proj', 'D:\\work'],
    exceptFolders: ['~/big'],
    tokens: 50000,
    effort: 'high',
    images: false,
    time: { from: '22:00', to: '08:00', days: ['fri', 'sat'] },
  })
})

check('pause 规则照样带 use（它点名的是「被摘出去的那个成员」）', () => {
  const rule = mod._ruleToPayload({ use: 'a/1', pause: true, channel: 'fork' })
  sameValue(rule, { pause: true, use: 'a/1', channel: 'fork' })
  // 纯空白的输入一律当没填：Host 把空串当非法输入，会整份拒绝保存。
  sameValue(mod._ruleToPayload({ use: '  a/1  ', label: '   ', effort: '  ', channel: '  ' }), { use: 'a/1' })
})

check('页面摘要与 Host 半侧的 describeRule 逐字一致（防漂移）', () => {
  const samples = [
    { use: 'a/1', channel: 'fork' },
    { use: 'a/1', label: '*review*', folders: ['~/proj'], tokens: 1000, effort: 'high', images: true },
    { use: 'a/1', time: { from: '22:00', to: '08:00', days: ['fri'] } },
    { use: 'a/1', pause: true, channel: 'spawn', time: { from: '09:00', to: '12:00' } },
    { use: 'a/1', pause: true },
  ]
  for (const sample of samples) {
    const normalized = normalizeRule(sample).rule
    assert.equal(mod._describeRule(normalized), hostDescribeRule(normalized), `摘要不一致：${JSON.stringify(sample)}`)
  }
})

check('推理档下拉：以模型公布的档位为准，默认档标出，未公布的手工值不丢', () => {
  const bank = { status: 'ok', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] }
  // 真机实测：zai-coding-cn/glm-5.3 就是 low/high/max，且没有默认 —— 手填等于让人猜。
  const options = mod._effortOptions(bank, '')
  sameValue(options.map((o) => o.value), ['', 'low', 'high', 'max'])
  assert.equal(options[0].label, '用模型默认（未公布默认）')

  const withDefault = mod._effortOptions({ ...bank, defaultEffort: 'high' }, '')
  assert.equal(withDefault[0].label, '用模型默认（high）')
  assert.equal(withDefault[2].label, 'high（默认） · High')

  // 当前值是模型没公布的档位：必须留成选项，否则一打开编辑器就被清空。
  const keepCurrent = mod._effortOptions(bank, 'ultra')
  sameValue(keepCurrent.map((o) => o.value), ['', 'low', 'high', 'max', 'ultra'])
  assert.match(keepCurrent[4].label, /当前值，模型未公布/)

  // 模型一个档位都没公布：只剩「用模型默认」。
  sameValue(mod._effortOptions({ status: 'ok', efforts: [] }, '').map((o) => o.value), [''])
  sameValue(mod._effortOptions(undefined, '').map((o) => o.value), [''])
})

check('推理档说明文案：把「为什么是这几项」说清，失败时说清原因与出路', () => {
  assert.match(mod._effortHint(undefined), /正在读取/)
  assert.match(mod._effortHint({ status: 'loading' }), /正在读取/)
  assert.match(mod._effortHint({ status: 'ok', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' }), /low \/ high（默认）/)
  assert.match(mod._effortHint({ status: 'ok', efforts: [] }), /没有公布推理档.*可手工填/)
  assert.match(mod._effortHint({ status: 'ok', efforts: [], error: 'model not found' }), /model not found/)
  assert.match(mod._effortHint({ status: 'error', error: 'HTTP 500' }), /HTTP 500.*手工填/)
  assert.match(mod._effortHint({ status: 'ok', efforts: [], supported: false }), /LLM 服务不可用/)
})

check('textList：逗号/分号/换行都认，去空项', () => {
  sameValue(mod._textList('a, b;c\n d ,,'), ['a', 'b', 'c', 'd'])
  sameValue(mod._textList(['a', 'b']), ['a', 'b'])
  sameValue(mod._textList(undefined), [])
})

console.log(`\n${passed} 项通过`)
