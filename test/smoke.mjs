// dsh-team-member-model 冒烟测试：只覆盖纯函数契约，不加载宿主。
//
// 重点锁死三类容易悄悄漂移的东西：
//   1. 身份前缀（插件生成）与成员名解析（插件解析）必须永远对得上 —— 对不上就是
//      「插件正常但模型不生效」的静默失效；
//   2. 与 magpie 对齐的路由语义：规则首命中、候选不排他、时间窗跨午夜、目录边界、
//      失败分类白名单 —— 这些错了不会崩，只会「路由到错的模型」；
//   3. 历史配置形状（0.2.1 的 routes）必须读得进、不报错。
//
// 运行：node test/smoke.mjs
// 作者：hwj

import assert from 'node:assert/strict'
import {
  describeRule,
  identityPrefix,
  isRetryableFailure,
  memberKey,
  normalizeMembers,
  normalizePolicy,
  normalizeRoute,
  normalizeRoutes,
  parseIntent,
  planRoute,
  restDelayMs,
  shouldSink,
  teammateNameFromPrompt,
  withAgentOptions,
  withRequestAgentOptions,
} from '../lib/index.js'
import { expandMembers, folderMatches, globMatches, inTimeWindow, matchRule, normalizeFolderPath, normalizeMemberV4, resolveMember } from '../lib/rules.js'

let passed = 0

/** 跑一个断言块并计入总数；失败直接冒泡（进程退出码非零）。 */
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** 造一份与官方运行时调用形状一致的 startContinuable 入参。 */
function officialSpec(memberName, description, task = 'do the thing') {
  return {
    childId: 'child-uuid',
    provider: 'spawn',
    label: description,
    request: {
      prompt: [
        { type: 'text', text: identityPrefix(memberName) },
        { type: 'text', text: task },
      ],
      parent: { id: 'lead-session' },
    },
    signal: undefined,
  }
}

/** 一份最小的 v3 策略。 */
function policy(overrides = {}) {
  return normalizePolicy({
    members: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ],
    ...overrides,
  }).policy
}

const baseContext = {
  channel: 'spawn',
  continuable: false,
  label: 'review the diff',
  member: '',
  cwd: `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/proj`,
  tokens: 12000,
  effort: 'high',
  images: false,
  intent: null,
}

console.log('team-member-model smoke')

check('identityPrefix ↔ teammateNameFromPrompt 往返一致', () => {
  for (const name of ['reviewer', 'front-end-2', 'a']) {
    assert.equal(teammateNameFromPrompt([{ type: 'text', text: identityPrefix(name) }]), name)
  }
})

check('身份前缀使用当前 send_message agent 参数', () => {
  assert.equal(
    identityPrefix('reviewer'),
    '<system-reminder>\n' +
      'You are teammate "reviewer".\n' +
      'Your Team Lead is named "lead".\n' +
      'Use list_agents({}) or the start receipt to find the exact agent name or path.\n' +
      'To message another agent, pass its listed name, path, or known historical Session id: send_message({ agent: "<name-path-or-session-id>", message: "..." }).\n' +
      '</system-reminder>\n\n',
  )
})

check('取不到名字时返回 null，而不是空串或抛错', () => {
  assert.equal(teammateNameFromPrompt(undefined), null)
  assert.equal(teammateNameFromPrompt([]), null)
  assert.equal(teammateNameFromPrompt([{ type: 'text', text: 'no identity here' }]), null)
  assert.equal(teammateNameFromPrompt([{ type: 'image', text: identityPrefix('x') }]), null)
})

check('normalizeRoute（=绑定）：provider/model 必须成对，effort/off/time 逐条校验', () => {
  assert.match(normalizeRoute({ provider: 'zai-coding-cn' }).error, /model/)
  assert.match(normalizeRoute({ model: 'glm-5.3' }).error, /provider/)
  assert.match(normalizeRoute('nope').error, /对象/)
  assert.match(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: ' ' }).error, /reasoningEffort/)
  assert.match(normalizeRoute({ provider: 'p', model: 'm', off: 'yes' }).error, /off/)
  assert.match(normalizeRoute({ provider: 'p', model: 'm', time: { from: 'x', to: '08:00' } }).error, /time.from/)
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ' }).route, { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }).route, {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
})

check('normalizeMembers：v3 扁平路由自动迁移成「名字=旧身份、单绑定」的 v4 成员', () => {
  assert.equal(normalizeMembers('nope').errors.length, 1)
  assert.equal(normalizeMembers([{ provider: 'p' }]).errors.length, 1)
  // 迁移：名字就是 provider/model[:effort]，规则引用零改动
  const migrated = normalizeMembers([
    { provider: 'b', model: 'y', reasoningEffort: 'max', weight: 3 },
    { provider: 'a', model: 'x' },
  ]).members
  assert.deepEqual(migrated.map((m) => m.name), ['b/y:max', 'a/x'])
  assert.deepEqual(migrated[0].bindings, [{ provider: 'b', model: 'y', reasoningEffort: 'max' }])
  assert.equal(migrated[0].weight, 3)
  // 同名成员（v4 重复）拒绝
  assert.equal(normalizeMembers([
    { name: 'same', bindings: [{ provider: 'a', model: '1' }] },
    { name: 'same', bindings: [{ provider: 'a', model: '2' }] },
  ]).errors.length, 1)
})

check('normalizeMemberV4：名字固定、绑定非空、绑定键去重', () => {
  assert.match(normalizeMemberV4({ name: 'a b', bindings: [{ provider: 'p', model: 'm' }] }).error, /不含空白/)
  assert.match(normalizeMemberV4({ name: 'x' }).error, /bindings/)
  const member = normalizeMemberV4({
    name: 'glm-max', weight: 2, off: true,
    bindings: [
      { provider: 'a', model: '1' },
      { provider: 'a', model: '1' },
      { provider: 'b', model: '2', reasoningEffort: 'high', time: { from: '09:00', to: '12:00' } },
    ],
  }).member
  assert.deepEqual(member.bindings.map(memberKey), ['a/1', 'b/2:high'])
  assert.equal(member.off, true)
  assert.equal(member.weight, 2)
})

check('normalizeRoutes：0.2.1 的别名仍然可用（返回 v4 成员）', () => {
  const result = normalizeRoutes([{ provider: 'a', model: 'x' }])
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.routes[0].name, 'a/x')
})

check('normalizePolicy：读到 0.2.1 的 {version:1, routes} 自动迁移成成员表 + 空规则', () => {
  const migrated = normalizePolicy({ version: 1, routes: [{ provider: 'zai-coding-cn', model: 'glm-5.3' }] })
  assert.deepEqual(migrated.errors, [])
  assert.deepEqual(migrated.policy.members.map((m) => m.name), ['zai-coding-cn/glm-5.3'])
  assert.deepEqual(migrated.policy.members[0].bindings, [{ provider: 'zai-coding-cn', model: 'glm-5.3' }])
  assert.deepEqual(migrated.policy.rules, [])
  assert.equal(migrated.policy.routing, 'order')
  assert.deepEqual(migrated.policy.failover, { enabled: true, patience: 2 })
  assert.equal(migrated.policy.allowFork, false)
})

check('normalizePolicy：裸数组（组合行 config 的种子）也可读', () => {
  const seeded = normalizePolicy([{ provider: 'a', model: 'x' }])
  assert.deepEqual(seeded.errors, [])
  assert.equal(seeded.policy.members.length, 1)
  assert.equal(seeded.policy.members[0].name, 'a/x')
})

check('normalizePolicy：规则逐条校验，错误里带定位；整套非法时整份拒绝', () => {
  // v4 里 use 是成员名，任意不含空白的字符串都合法；带空白才算非法。
  assert.match(normalizePolicy({ rules: [{ use: 'bad name' }] }).errors[0], /规则第 1 条/)
  assert.match(normalizePolicy({ rules: [{ use: 'a/b', channel: 'nope' }] }).errors[0], /channel/)
  assert.match(normalizePolicy({ rules: [{ use: 'a/b', time: { from: '25:00', to: '08:00' } }] }).errors[0], /time.from/)
  // "9:00" 是宽容接受并规范化成 "09:00"（不因为少个前导零就拒绝用户）。
  assert.deepEqual(normalizePolicy({ rules: [{ use: 'a/b', time: { from: '9:00', to: '08:00' } }] }).policy.rules[0].time, {
    from: '09:00',
    to: '08:00',
  })
  assert.match(normalizePolicy({ routing: 'smart' }).errors[0], /routing/)
  assert.match(normalizePolicy({ failover: { patience: 99 } }).errors[0], /patience/)
  assert.deepEqual(normalizePolicy({ rules: [{ use: 'a/b', channel: 'fork', folders: ['~/x'], tokens: 100 }] }).errors, [])
  assert.deepEqual(normalizePolicy({ rules: [{ use: 'a/b', pause: true, channel: 'fork' }] }).errors, [])
  // pause 也必须点名成员：它的语义是「摘下 Use 这个成员」，不是「全停用」。
  assert.match(normalizePolicy({ rules: [{ pause: true }] }).errors[0], /use/)
})

check('空值 = 没给这个条件：match:[] / folders:[] / 分类器空串都不该报错', () => {
  // 用户实报：设置页在「目录通配」为空时送了 match: []，Host 回「策略：match 若给出必须是非空数组」。
  // 清空一格是正常操作，两边都必须按「没给」处理。
  const cleared = normalizePolicy({ match: [], rules: [], members: [], classifier: { enabled: false, provider: '', model: '' } })
  assert.deepEqual(cleared.errors, [])
  assert.deepEqual(cleared.policy.match, [])
  assert.deepEqual(cleared.policy.classifier, { enabled: false, provider: '', model: '' })

  // 规则里的 folders / exceptFolders 同理：空数组不写入该条件。
  const rule = normalizePolicy({ rules: [{ use: 'a/1', folders: [], exceptFolders: [] }] })
  assert.deepEqual(rule.errors, [])
  assert.equal('folders' in rule.policy.rules[0], false)
  assert.equal('exceptFolders' in rule.policy.rules[0], false)

  // 非数组、含空串仍然拒绝（宽容不等于不校验）。
  assert.match(normalizePolicy({ match: 'a/*' }).errors[0], /match.*必须是数组/)
  assert.match(normalizePolicy({ match: [''] }).errors[0], /每一项都必须是非空字符串/)
  assert.match(normalizePolicy({ classifier: { provider: 123 } }).errors[0], /classifier.provider/)
})

check('时间窗：全天 / 普通区间 / 跨午夜（days 归窗口开始的那一天）', () => {
  const fridayLate = new Date('2026-10-16T23:30:00') // 周五
  const saturdayEarly = new Date('2026-10-17T07:30:00') // 周六凌晨
  const saturdayNoon = new Date('2026-10-17T12:00:00')
  const window = { from: '22:00', to: '08:00', days: ['fri'] }
  assert.equal(inTimeWindow(window, fridayLate), true)
  assert.equal(inTimeWindow(window, saturdayEarly), true, '周五 22:00–08:00 必须含周六凌晨')
  assert.equal(inTimeWindow(window, saturdayNoon), false)
  assert.equal(inTimeWindow({ from: '09:00', to: '12:00' }, new Date('2026-10-17T10:00:00')), true)
  assert.equal(inTimeWindow({ from: '09:00', to: '12:00', days: ['mon'] }, new Date('2026-10-17T10:00:00')), false)
  assert.equal(inTimeWindow({ from: '09:00', to: '09:00' }, new Date('2026-10-17T03:00:00')), true, '起止相同 = 全天')
})

check('目录匹配：边界、~ 展开、Windows 盘符 ↔ WSL 挂载互认', () => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  assert.equal(folderMatches(['/a/b'], '/a/b/c'), true)
  assert.equal(folderMatches(['/a/b'], '/a/b'), true)
  assert.equal(folderMatches(['/a/b'], '/a/bc'), false, '/a/b 不能吃掉 /a/bc')
  assert.equal(folderMatches(['D:\\work\\acme'], '/mnt/d/work/acme/sub'), true)
  assert.equal(folderMatches(['/mnt/d/work'], 'D:/work/acme'), true)
  // "~" 展开成真实家目录：用显式 home 参数断言语义，别假设本机家目录长什么样。
  assert.equal(normalizeFolderPath('~/proj', '/home/me'), '/home/me/proj')
  assert.equal(folderMatches(['~/proj'], `${home}/proj/x`), true)
  assert.equal(folderMatches(['/a/b'], undefined), false, '不知道目录 ≠ 命中')
})

check('通配符：* 任意长度、整体锚定、忽略大小写', () => {
  assert.equal(globMatches('*review*', 'please REVIEW the diff'), true)
  assert.equal(globMatches('review*', 'review the diff'), true)
  assert.equal(globMatches('review*', 'pre review'), false)
  assert.equal(globMatches('opencode-go/*', 'opencode-go/deepseek-v4.1-flash'), true)
  assert.equal(globMatches('*', 'anything'), true)
})

check('matchRule：每个条件单独生效、未给的条件不参与', () => {
  const now = new Date('2026-10-16T10:00:00')
  assert.equal(matchRule({ use: 'a/b' }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', channel: 'fork' }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', channel: 'spawn' }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', continuable: true }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', label: '*review*' }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', label: '*deploy*' }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', folders: ['~/proj'] }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', exceptFolders: ['~/proj'] }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', tokens: 50000 }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', tokens: 1000 }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', effort: 'high' }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', effort: 'none' }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', effort: 'on' }, baseContext, now), true)
  assert.equal(matchRule({ use: 'a/b', images: true }, baseContext, now), false)
  assert.equal(matchRule({ use: 'a/b', intent: '写测试' }, baseContext, now), false, '没开分类器时 intent 不命中')
  assert.equal(matchRule({ use: 'a/b', intent: '写测试' }, { ...baseContext, intent: '写测试' }, now), true)
})

check('planRoute：首条命中决定首选，命中不排他（其余成员仍是候选）', () => {
  const built = policy({
    rules: [
      { use: 'zai-coding-cn/glm-5.3', channel: 'fork' },
      { use: 'opencode-go/deepseek-v4.1-flash', label: '*review*' },
    ],
  })
  const plan = planRoute(built, baseContext, {})
  assert.equal(memberKey(plan.route), 'opencode-go/deepseek-v4.1-flash')
  assert.equal(plan.reason, 'rule')
  assert.equal(plan.ruleIndex, 1)
  assert.deepEqual(plan.candidates.map(memberKey), ['opencode-go/deepseek-v4.1-flash', 'zai-coding-cn/glm-5.3'])
})

check('planRoute：没有成员 = 路由器关闭', () => {
  assert.equal(planRoute(normalizePolicy({}).policy, baseContext, {}), null)
})

check('planRoute：pick（一键换）跳过全部规则', () => {
  const built = policy({ pick: 'opencode-go/deepseek-v4.1-flash', rules: [{ use: 'zai-coding-cn/glm-5.3' }] })
  const plan = planRoute(built, baseContext, {})
  assert.equal(plan.reason, 'pick')
  assert.equal(memberKey(plan.route), 'opencode-go/deepseek-v4.1-flash')
})

check('planRoute：off 的成员不会被选中；规则命中的成员被 off 时继续找下一条', () => {
  const off = policy({ off: ['zai-coding-cn/glm-5.3'] })
  assert.equal(memberKey(planRoute(off, baseContext, {}).route), 'opencode-go/deepseek-v4.1-flash')
  const ruleOff = policy({ off: ['opencode-go/deepseek-v4.1-flash'], rules: [{ use: 'opencode-go/deepseek-v4.1-flash' }] })
  const plan = planRoute(ruleOff, baseContext, {})
  assert.equal(memberKey(plan.route), 'zai-coding-cn/glm-5.3', '命中被摘除的成员时按 magpie 语义「组按没有它路由」')
})

check('planRoute：pause 规则把「它命名的那个」成员摘出候选', () => {
  const built = policy({ rules: [{ use: 'zai-coding-cn/glm-5.3', pause: true, channel: 'fork' }] })
  // fork 通道命中 → glm-5.3 被摘，只剩 opencode 那一个。
  assert.equal(memberKey(planRoute(built, { ...baseContext, channel: 'fork' }, {}).route), 'opencode-go/deepseek-v4.1-flash')
  // spawn 通道不命中 → 两个都还在，默认仍是第一个。
  assert.equal(memberKey(planRoute(built, baseContext, {}).route), 'zai-coding-cn/glm-5.3')
})

check('planRoute：亲和（同一父会话粘住上次成员）', () => {
  const plan = planRoute(policy(), baseContext, { affinity: 'opencode-go/deepseek-v4.1-flash' })
  assert.equal(plan.reason, 'affinity')
  assert.equal(memberKey(plan.route), 'opencode-go/deepseek-v4.1-flash')
  const offed = planRoute(policy({ off: ['opencode-go/deepseek-v4.1-flash'] }), baseContext, { affinity: 'opencode-go/deepseek-v4.1-flash' })
  assert.equal(memberKey(offed.route), 'zai-coding-cn/glm-5.3')
})

check('planRoute：rotate 轮转、weight 按权重，rest 的排最后', () => {
  const rotated = normalizePolicy({
    members: [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }, { provider: 'c', model: '3' }],
    routing: 'rotate',
  }).policy
  assert.equal(memberKey(planRoute(rotated, baseContext, { cursor: 0 }).route), 'a/1')
  assert.equal(memberKey(planRoute(rotated, baseContext, { cursor: 1 }).route), 'b/2')
  assert.equal(memberKey(planRoute(rotated, baseContext, { cursor: 4 }).route), 'b/2')

  const weighted = normalizePolicy({
    members: [{ provider: 'a', model: '1', weight: 3 }, { provider: 'b', model: '2', weight: 1 }],
    routing: 'weight',
  }).policy
  assert.equal(memberKey(planRoute(weighted, baseContext, { cursor: 0 }).route), 'a/1')
  assert.equal(memberKey(planRoute(weighted, baseContext, { cursor: 3 }).route), 'b/2')

  const plan = planRoute(policy(), baseContext, { resting: new Set(['zai-coding-cn/glm-5.3']) })
  assert.deepEqual(plan.candidates.map(memberKey), ['opencode-go/deepseek-v4.1-flash', 'zai-coding-cn/glm-5.3'])
})

check('档位是绑定身份：同一模型两档可作两个成员并精确引用', () => {
  const twoEfforts = normalizeMembers([
    { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
    { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
  ])
  assert.deepEqual(twoEfforts.errors, [])
  assert.equal(twoEfforts.members.length, 2, '同一模型不同档位是两个成员')
  assert.deepEqual(twoEfforts.members.map((m) => m.name), ['zai/glm-5.3:max', 'zai/glm-5.3:low'])
})

check('resolveMember：按成员名解析；名字不存在时按「某成员的绑定等于该键」兜底', () => {
  const members = normalizeMembers([
    { name: 'glm-max', bindings: [{ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' }] },
    { name: 'glm-low', bindings: [{ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' }] },
  ]).members
  assert.equal(resolveMember('glm-max', members).name, 'glm-max')
  // 手写旧键也能落到包含该绑定的成员
  assert.equal(resolveMember('zai/glm-5.3:low', members).name, 'glm-low')
  assert.equal(resolveMember('不存在', members), null)
  assert.equal(resolveMember('  ', members), null)
})

check('裸引用自动升级（0.3.2 之前语义的等价迁移，不升级会静默丢档位）', () => {
  // 用户现有配置的形状：成员带档位、规则用裸 use —— 升级后 review 规则仍指 max 档。
  const migrated = normalizePolicy({
    members: [
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'opencode', model: 'flash' },
    ],
    rules: [{ use: 'zai/glm-5.3', label: '*review*' }],
    pick: 'zai/glm-5.3',
    off: ['zai/glm-5.3'],
  })
  assert.deepEqual(migrated.errors, [])
  assert.equal(migrated.policy.rules[0].use, 'zai/glm-5.3:max')
  assert.equal(migrated.policy.pick, 'zai/glm-5.3:max')
  assert.deepEqual(migrated.policy.off, ['zai/glm-5.3:max'])

  // 歧义：同模型两个档位变体时不动，交给用户显式写（升级成哪个都是替用户做错决定）。
  const ambiguous = normalizePolicy({
    members: [
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
    ],
    rules: [{ use: 'zai/glm-5.3' }],
  })
  assert.equal(ambiguous.policy.rules[0].use, 'zai/glm-5.3')

  // 表里本来就有裸身份成员：引用照旧命中它，不升级。
  const hasBare = normalizePolicy({
    members: [
      { provider: 'zai', model: 'glm-5.3' },
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
    ],
    rules: [{ use: 'zai/glm-5.3' }],
  })
  assert.equal(hasBare.policy.rules[0].use, 'zai/glm-5.3')
})

check('planRoute：规则点名档位成员；pause/off 也按完整身份', () => {
  const built = normalizePolicy({
    members: [
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
    ],
    rules: [{ use: 'zai/glm-5.3:low', label: '*quick*' }],
  }).policy
  const quick = planRoute(built, { ...baseContext, label: 'quick lookup' }, {})
  assert.equal(memberKey(quick.route), 'zai/glm-5.3:low', '规则点名 :low 就用 :low')
  assert.deepEqual(quick.candidates.map(memberKey), ['zai/glm-5.3:low', 'zai/glm-5.3:max'],
    '回退链：先降档（同模型）再换模型')
  // 默认（无规则命中）仍是第一个成员。
  assert.equal(memberKey(planRoute(built, baseContext, {}).route), 'zai/glm-5.3:max')
  // off 只摘点名的那一档。
  const offed = normalizePolicy({
    members: [
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' },
    ],
    rules: [{ use: 'zai/glm-5.3:low', label: '*quick*' }],
    off: ['zai/glm-5.3:low'],
  }).policy
  assert.equal(memberKey(planRoute(offed, { ...baseContext, label: 'quick lookup' }, {}).route), 'zai/glm-5.3:max',
    '规则命中的成员被摘除时按 magpie 语义继续找下一条（这里退到默认）')
})

check('planRoute：sink 的成员退到候选末尾', () => {
  const plan = planRoute(policy(), baseContext, { sunk: new Set(['zai-coding-cn/glm-5.3']) })
  assert.deepEqual(plan.candidates.map(memberKey), ['opencode-go/deepseek-v4.1-flash', 'zai-coding-cn/glm-5.3'])
})

check('expandMembers：目录通配自动追加「单绑定成员」，已在表内不重复', () => {
  const expanded = expandMembers(
    [{ name: 'a-one', bindings: [{ provider: 'a', model: '1' }] }],
    ['b/*'],
    [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }, { provider: 'c', model: '3' }],
  )
  assert.deepEqual(expanded.map((member) => member.name), ['a-one', 'b/2'])
  assert.deepEqual(expanded[1].bindings, [{ provider: 'b', model: '2' }])
})

check('v4 成员：候选阶梯 = 目标成员的全部渠道 → 其它成员（跨渠道优先回退）', () => {
  const built = normalizePolicy({
    members: [
      { name: 'glm-max', bindings: [
        { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' },
        { provider: 'opencode', model: 'glm-5.3', reasoningEffort: 'max' },
      ] },
      { name: 'cheap', bindings: [{ provider: 'opencode', model: 'flash' }] },
    ],
    rules: [{ use: 'glm-max', label: '*review*' }],
  }).policy
  const plan = planRoute(built, { ...baseContext, label: 'review it' }, {})
  assert.equal(plan.member, 'glm-max')
  assert.deepEqual(plan.candidates.map(memberKey), ['zai/glm-5.3:max', 'opencode/glm-5.3:max', 'opencode/flash'])
  assert.deepEqual(plan.candidateMembers, ['glm-max', 'cheap'])
})

check('v4 绑定级时间窗：窗口内该渠道被跳过，落到同成员的另一个渠道', () => {
  const built = normalizePolicy({
    members: [
      { name: 'glm-max', bindings: [
        { provider: 'zai', model: 'glm-5.3', time: { from: '09:00', to: '18:00' } },
        { provider: 'opencode', model: 'glm-5.3' },
      ] },
    ],
  }).policy
  const workHours = new Date('2026-10-20T10:00:00')
  const night = new Date('2026-10-20T23:00:00')
  assert.equal(memberKey(planRoute(built, baseContext, { now: workHours }).route), 'opencode/glm-5.3',
    '渠道在停用窗口内 → 用同成员的下一个渠道')
  assert.equal(memberKey(planRoute(built, baseContext, { now: night }).route), 'zai/glm-5.3',
    '窗口外 → 恢复到首选渠道')
})

check('v4 规则引用成员名；写成旧绑定键也能解析（兜底）', () => {
  const built = normalizePolicy({
    members: [
      { name: 'glm-max', bindings: [{ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' }] },
      { name: 'cheap', bindings: [{ provider: 'opencode', model: 'flash' }] },
    ],
    rules: [
      { use: 'zai/glm-5.3:max', label: '*audit*' },
      { use: 'cheap', label: '*chat*' },
    ],
  }).policy
  assert.equal(planRoute(built, { ...baseContext, label: 'audit it' }, {}).member, 'glm-max', '旧绑定键解析到成员')
  assert.equal(planRoute(built, { ...baseContext, label: 'chat it' }, {}).member, 'cheap', '成员名直接命中')
})

check('失败分类：请求本身的拒绝绝不回退，408/429/5xx 与网络类才回退', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableFailure({ status, message: 'x', code: 'X' }), true, `status ${status} 应可重试`)
  }
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryableFailure({ status, message: 'x', code: 'X' }), false, `status ${status} 不该回退`)
  }
  assert.equal(isRetryableFailure({ message: 'request timed out', code: 'ETIMEDOUT' }), true)
  assert.equal(isRetryableFailure({ message: 'upstream overloaded', code: 'OVERLOADED' }), true)
  assert.equal(isRetryableFailure({ message: 'invalid model id', code: 'BAD_REQUEST' }), false)
  assert.equal(isRetryableFailure(null), false)
})

check('rest 阶梯（对齐 magpie）：Retry-After 优先；限流 60s 起翻倍封顶 30 分钟；其余封顶 10 分钟', () => {
  assert.equal(restDelayMs({ status: 429, providerRetryAfterMs: 5000 }, 1), 5000, 'vendor 给的 Retry-After 优先')
  assert.equal(restDelayMs({ status: 429, providerRetryAfterMs: 99999999 }, 1), 30 * 60_000, 'Retry-After 也封顶 30 分钟')
  assert.equal(restDelayMs({ status: 429 }, 1), 60_000, '限流从 1 分钟起（不是固定 30 秒）')
  assert.equal(restDelayMs({ status: 429 }, 2), 120_000, '限流同样翻倍')
  assert.equal(restDelayMs({ status: 429 }, 9), 30 * 60_000, '限流封顶 30 分钟（longestRateRest）')
  assert.equal(restDelayMs({ status: 503 }, 1), 60_000)
  assert.equal(restDelayMs({ status: 503 }, 2), 120_000)
  assert.equal(restDelayMs({ status: 503 }, 9), 10 * 60_000, '普通失败封顶 10 分钟（longestRetry）')
  assert.equal(restDelayMs({ status: 502, code: 'INSUFFICIENT_QUOTA', message: 'quota exhausted' }, 1), 30 * 60_000, '额度用尽直接 30 分钟')
  assert.equal(restDelayMs({ status: 503, code: 'OVERLOADED', message: 'upstream overloaded' }, 1), 60_000, '过载归限流一档')
})

check('sink：429 与限流/额度类码要退队尾，普通 5xx 不退', () => {
  assert.equal(shouldSink({ status: 429 }), true)
  assert.equal(shouldSink({ status: 500, code: 'RATE_LIMIT_EXCEEDED' }), true)
  assert.equal(shouldSink({ status: 503, code: 'OVERLOADED' }), false)
  assert.equal(shouldSink(null), false)
})

check('parseIntent：唯一命中才算数，含糊一律不命中', () => {
  assert.equal(parseIntent('写作或修改测试', ['写作或修改测试', '快速问答']), '写作或修改测试')
  assert.equal(parseIntent(' 快速问答 ', ['写作或修改测试', '快速问答']), '快速问答')
  assert.equal(parseIntent('不知道', ['写作或修改测试', '快速问答']), null)
  assert.equal(parseIntent('', ['写作或修改测试']), null)
  assert.equal(parseIntent('写作或修改测试（不是快速问答）', ['写作或修改测试', '快速问答']), '写作或修改测试')
  assert.equal(parseIntent('甲 乙', ['甲', '乙']), null)
})

check('describeRule：能一句话说清规则（pause 也用同一套文案）', () => {
  assert.match(describeRule({ use: 'a/b', channel: 'fork', label: '*x*', time: { from: '22:00', to: '08:00', days: ['fri'] } }), /→ a\/b · 通道 fork · 标签 \*x\* · 时段 22:00–08:00 fri/)
  assert.match(describeRule({ use: 'a/b', pause: true, channel: 'spawn' }), /^停用 a\/b · 通道 spawn$/)
})

check('withAgentOptions / withRequestAgentOptions：不改入参、两层都是新对象', () => {
  const spec = officialSpec('reviewer', 'check the diff')
  const patched = withAgentOptions(spec, { provider: 'p', model: 'm' })
  assert.equal(spec.request.agentOptions, undefined)
  assert.notEqual(patched, spec)
  assert.notEqual(patched.request, spec.request)
  assert.deepEqual(patched.request.agentOptions, { provider: 'p', model: 'm' })
  const request = { prompt: [], parent: {} }
  const patchedRequest = withRequestAgentOptions(request, { provider: 'p', model: 'm' })
  assert.equal(request.agentOptions, undefined)
  assert.equal(patchedRequest.prompt, request.prompt)
})

console.log(`\n${passed} 项通过`)
