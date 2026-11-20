# 团队模型能力合并（dsh-team-member-model 0.7.0）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 dsh-agent-team-switchable 的团队模型管理能力无缝整合入 dsh-team-member-model（升级至 0.7.0），构建单一决策入口的 5 级路由解析体系与双主按钮弹出菜单，实现零覆写冲突的平滑合并。

**架构：**
- **Host 端**：通过 `lib/team-state.js`（原子队列持久化）与 `lib/team-routing.js`（5 级优先级判定）在 `lib/index.js` 的 `agent/request` 监听器建立统一裁决入口，隔离手动固定（无 fallback）与自动规则（动态回退），通过 `session/event` 与 `agent/created` 公开生命周期捕获快照。
- **前后端通道**：复用 `ctx.webServer` 在 `/api/dsh-team-member-model/team/*` 暴露 RESTful HTTP 接口，携带 `x-dsh-team-member-model: 1` 防跨站，严密校验 Lead 与模型目录。
- **Client 端**：在 `lib/team-client.js` 与 `lib/client.js` 注册 `conversation.session.header.actions` 插槽，实现单一共享草稿选择器、双主按钮、只读默认摘要与恢复继承、成员行内自动保存及 `writeGate` 并发互斥锁。

**技术栈：** 原生 Node.js（`node:test`、`node:fs/promises`、`node:crypto`）、Cordis 4.0.0+、React（CJS factory `react.createElement`）。

---

## 文件结构与职责划分

| 文件路径 | 状态 | 职责与设计边界 |
| --- | --- | --- |
| `lib/team-state.js` | 新建 | 团队状态持久化管理器。管理 `teams.json` 的原子落盘（tmp+rename）、每团队 Promise 串行排队链、`revision` 递增、`initials`（快照）与 `choices`（覆盖）存取。 |
| `lib/team-routing.js` | 新建 | 5 级路由解析纯函数与判定器。实现 `memberoverride` > `createexplicit` > `captureddefault` > `auto` > `inherit` 优先级解析，标注 fixed 来源阻止 automatic failover，管理 `turn > effectiveAfterTurn` 判定。 |
| `lib/index.js` | 修改 | Host 入口装配。扩展 `webServer` 的 `/team/*` 路由；在 `agent/request` 接入统一裁决；通过 `session/event` 与 `agent/created` 捕获成员；注入 `agentTeams` 与 `sessionController` 依赖。 |
| `lib/team-client.js` | 新建 | 团队菜单 UI 与业务状态机。提供 `conversation.session.header.actions` 插槽组件、共享 `BulkModelPicker`、双主按钮、恢复继承、`writeGate` 并发锁与 HTTP API 通信控制器。 |
| `lib/client.js` | 修改 | 扩展 Client 插件导出与装配。在 `apply(ctx)` 中并列注册 `settings.section`（模型路由）与 `conversation.session.header.actions`（团队设置菜单），声明所需注入项。 |
| `package.json` | 修改 | 升级版本号至 `0.7.0`；在 `dsh.client.inject` 补充团队模型目录所需的客户端依赖项；在 `files` 补充新增的 lib 文件。 |
| `test/team-host.mjs` | 新建 | Host 侧自动化测试。覆盖团队持久化、串行写队列、冷启动恢复、HTTP 鉴权与模型校验、5 级路由解析及手动固定无 fallback 边界。 |
| `test/team-client.mjs` | 新建 | Client 侧自动化测试。覆盖插槽挂载、共享草稿回填（全等/mixed/仅default/空）、双主按钮与恢复继承行为、`writeGate` 并发互斥。 |
| `README.md` | 修改 | 更新 0.7.0 功能特性、团队模型弹出菜单操作说明、5 级路由决策顺序与回退边界。 |

---

## 任务拆解与 TDD 实施步骤

### 任务 1：Host 团队状态持久化与并发队列 (`lib/team-state.js`)

**文件：**
- 创建：`lib/team-state.js`
- 测试：`test/team-host.mjs`

- [ ] **步骤 1：编写持久化与排队链的失败测试**

在 `test/team-host.mjs` 中编写测试用例：
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamStateStore } from '../lib/team-state.js'

test('TeamStateStore: 团队数据原子落盘与冷恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-team-state-'))
  try {
    const store1 = new TeamStateStore(dir)
    await store1.init()
    
    // 写入默认模型
    const v1 = await store1.updateTeam('lead-1', (team) => {
      team.defaultModel = { provider: 'p1', model: 'm1' }
      return team
    })
    assert.equal(v1.revision, 1)
    assert.deepEqual(v1.defaultModel, { provider: 'p1', model: 'm1' })

    // 记录成员覆盖
    const v2 = await store1.updateTeam('lead-1', (team) => {
      team.choices['worker-1'] = {
        selection: { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
        effectiveAfterTurn: 2,
      }
      return team
    })
    assert.equal(v2.revision, 2)
    assert.equal(v2.choices['worker-1'].effectiveAfterTurn, 2)

    // 新实例冷载入
    const store2 = new TeamStateStore(dir)
    await store2.init()
    const loaded = store2.getTeam('lead-1')
    assert.equal(loaded.revision, 2)
    assert.deepEqual(loaded.defaultModel, { provider: 'p1', model: 'm1' })
    assert.deepEqual(loaded.choices['worker-1'].selection, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TeamStateStore: 并发写操作严格按全局 Promise 队列串行执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-team-queue-'))
  try {
    const store = new TeamStateStore(dir)
    await store.init()

    // 跨团队并发发起 10 个写操作（验证全局单队列防并发写坏 teams.json.tmp）
    const promises = Array.from({ length: 10 }, (_, i) => 
      store.updateTeam(`lead-${i % 2}`, (team) => {
        team.choices[`worker-${i}`] = { selection: { provider: 'p', model: `m-${i}` }, effectiveAfterTurn: 0 }
        return team
      })
    )
    const results = await Promise.all(promises)
    const team0 = store.getTeam('lead-0')
    const team1 = store.getTeam('lead-1')
    assert.equal(team0.revision + team1.revision, 10)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/team-host.mjs`  
预期：FAIL，`Cannot find module '../lib/team-state.js'`。

- [ ] **步骤 3：实现 `lib/team-state.js`**

实现 `TeamStateStore`：
- 使用 `node:fs/promises` 的 `writeFile`（写临时文件 `teams.json.tmp`）加 `rename` 实现原子替换。
- 使用单一全局 Promise 串行队列（`this.writeQueue = this.writeQueue.then(...)`）管理全文件写操作，杜绝跨团队并发覆写丢失。
- 单条 Team 记录结构：`{ teamId, revision, defaultModel, initials: {}, choices: {} }`。
- `initials` 记录带 source 的快照：`{ selection, source: 'createexplicit' | 'captureddefault' }`，或显式 `null`（终结快照，防后套）。
- 深拷贝冻结（`structuredClone` + `Object.freeze`），防止内存引用污染。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/team-host.mjs`  
预期：PASS（2 项测试全部通过）。

---

### 任务 2：5 级路由优先级解析与固定路由保护 (`lib/team-routing.js`)

**文件：**
- 创建：`lib/team-routing.js`
- 测试：`test/team-host.mjs`

- [ ] **步骤 1：编写 5 级路由解析与固定路由禁止回退的测试**

在 `test/team-host.mjs` 追加测试：
```js
import { resolveTeamRoute, isManualFixedRoute } from '../lib/team-routing.js'

test('resolveTeamRoute: 5 级路由优先级解析', () => {
  const teamRecord = {
    teamId: 'lead-1',
    revision: 1,
    defaultModel: { provider: 'p-default', model: 'm-default' },
    initials: { 'worker-1': { provider: 'p-snap', model: 'm-snap' } },
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
    agentId: 'worker-1',
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
  assert.equal(r3.isManualFixed, true)

  // 4. 无 manual 时返回 null，留给 Level 4 (auto) / Level 5 (inherit)
  const r4 = resolveTeamRoute({
    agentId: 'worker-untracked',
    turn: 1,
    teamRecord: { initials: {}, choices: {}, defaultModel: null },
    agentOptions: undefined,
  })
  assert.equal(r4, null)
})

test('isManualFixedRoute: 手动路由标记禁止进入 candidate failover', () => {
  assert.equal(isManualFixedRoute({ level: 'memberoverride' }), true)
  assert.equal(isManualFixedRoute({ level: 'createexplicit' }), true)
  assert.equal(isManualFixedRoute({ level: 'captureddefault' }), true)
  assert.equal(isManualFixedRoute({ level: 'auto' }), false)
  assert.equal(isManualFixedRoute(null), false)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/team-host.mjs`  
预期：FAIL，`Cannot find module '../lib/team-routing.js'`。

- [ ] **步骤 3：实现 `lib/team-routing.js`**

导出 `resolveTeamRoute` 与 `isManualFixedRoute`：
- 严格判定 `typeof agentOptions?.model === 'string' && agentOptions.model.length > 0 && typeof agentOptions?.provider === 'string' && agentOptions.provider.length > 0`。
- 校验 `turn > choice.effectiveAfterTurn`。
- 确定 `isManualFixed: true`。
- Level 4 `auto` 保持现有 magpie 行为：规则未命中且 `policy.members` 非空时，默认选择排序首项（`auto` 路由），即使 `failover.enabled === false` 亦选择首项（单一候选，不 failover），不直接落入 `inherit`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/team-host.mjs`  
预期：PASS。

---

### 任务 3：Host HTTP 端点与团队生命周期事件装配 (`lib/index.js`)

**文件：**
- 修改：`lib/index.js`
- 测试：`test/team-host.mjs`

- [ ] **步骤 1：编写团队 HTTP 端点与生命周期捕获测试**

在 `test/team-host.mjs` 中构建模拟 Host 测试环境：
```js
test('Host HTTP: GET /api/dsh-team-member-model/teams?sessionId=... 鉴权与视图投影', async () => {
  // 模拟 ctx.webServer 与 sessionController
  // 验证 GET /teams 接口：
  // 1. 无 sessionId 参数返回 400
  // 2. 非法 Lead 返回 403/404
  // 3. 正确返回包含 teamId, revision, defaultModel, members 的 view 结构
})

test('Host HTTP: PUT /api/dsh-team-member-model/teams (队员覆盖) 必须带 x-dsh-team-member-model 头且只影响下一轮', async () => {
  // 验证无标记头返回 403
  // 验证 target 必须为不可变成员 ID（非 display name）
  // 验证解析目标实体若 role !== 'teammate' 或 member.id === lead.id 返回 400 (严防修改 Lead)
  // 验证传入 revision 校验（CAS 乐观并发），版本不符返回 409
  // 验证修改成功后返回的新 view revision 递增
})

test('Host HTTP: PUT /api/dsh-team-member-model/teams (默认模型 target: null) 允许设置与清空恢复继承', async () => {
  // 传入 target: null, selection: { provider, model } 成功设置团队未来默认
  // 传入 target: null, selection: null 成功恢复默认继承
})

test('Host Lifecycle: team/member 事件预约快照并在 agent/created 持久化', async () => {
  // 模拟发出 team/member provisioning 事件预约快照
  // 模拟触发 agent/created serial 钩子：成功持久化 initials[member.id] = { selection, source: 'captureddefault' }
  // 负例验证：若无预约快照，持久化为 null（明确终结，绝不套用 agent/created 时的新默认）
})

test('Host Router: agent/request 单决策入口对 memberoverride 正确换模且 request-error 不回退', async () => {
  // 模拟 agent/request：命中 memberoverride 替换调用配置
  // 模拟 agent/request-error：由于是 manual fixed，直接执行 next()，不产生重试 candidates
})
```

- [ ] **步骤 2：在 `lib/index.js` 扩展 `inject` 与路由装配**

- 更新 `export const inject = ['tools', 'subagents', 'webServer', 'sessionController', 'agentTeams', 'llm']`。
- 初始化 `TeamStateStore`（放置于 `dshHome/team-member-model/teams.json`）。
- 在 `installRoutes` 增加：
  - `GET ${API_BASE}/teams` (查询团队状态与视图模型)
  - `PUT ${API_BASE}/teams` (统一写入队员覆盖或默认模型，通过 target 区分)
- 在 `installFailover` 的 `agent/request` 前置接入 `resolveTeamRoute`：
  - 若命中 manual fixed 路由，设置单候选 `candidates = [route]`，标记 `child.isManualFixed = true`，直接 `replaceRoute` 返回。
  - 在 `agent/request-error` 中检查 `if (child.isManualFixed) return await next()`，彻底阻断手动路由的自动回退。
- 监听 `session/event` 的 `team/member`（v2）事件与 `agent/created` 钩子，完成成员捕获。

- [ ] **步骤 3：运行测试验证通过**

运行：`node --test test/team-host.mjs test/apply.mjs`  
预期：PASS（既有测试 43 项 + 新增 Host 团队测试全部通过）。

---

### 任务 4：Client 团队模型弹出菜单与双主按钮交互 (`lib/team-client.js`, `lib/client.js`)

**文件：**
- 创建：`lib/team-client.js`
- 修改：`lib/client.js`
- 测试：`test/team-client.mjs`

- [ ] **步骤 1：编写 Client 端组件交互与回填逻辑测试**

在 `test/team-client.mjs` 中构建测试：
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveBackfill, checkDraftValidity } from '../lib/team-client.js'

test('deriveBackfill: 共享选择器回填状态机', () => {
  const catalog = { groups: [{ id: 'p1', models: [{ id: 'm1' }] }] }
  
  // 1. 全员一致且在目录中 -> 回填该值
  const r1 = deriveBackfill({
    members: [{ phase: 'active', name: 'w1', nextModel: { provider: 'p1', model: 'm1' } }],
    activeNames: ['w1'],
    defaultModel: null,
    catalog,
  })
  assert.deepEqual(r1.selection, { provider: 'p1', model: 'm1' })
  assert.equal(r1.mixed, false)

  // 2. 成员不一致 -> 空草稿 + mixed: true
  const r2 = deriveBackfill({
    members: [
      { phase: 'active', name: 'w1', nextModel: { provider: 'p1', model: 'm1' } },
      { phase: 'active', name: 'w2', nextModel: { provider: 'p1', model: 'm2' } },
    ],
    activeNames: ['w1', 'w2'],
    defaultModel: null,
    catalog,
  })
  assert.equal(r2.selection, null)
  assert.equal(r2.mixed, true)

  // 3. 无可执行成员但有有效默认 -> 回填默认
  const r3 = deriveBackfill({
    members: [],
    activeNames: [],
    defaultModel: { provider: 'p1', model: 'm1' },
    catalog,
  })
  assert.deepEqual(r3.selection, { provider: 'p1', model: 'm1' })
  assert.equal(r3.defaultOnly, true)
})

test('writeGate: 同 tick 跨操作互斥锁', () => {
  // 验证按钮 1、按钮 2 与成员行保存之间的互斥
})
```

- [ ] **步骤 2：实现 `lib/team-client.js` 与接入 `lib/client.js`**

1. 在 `lib/team-client.js` 导出：
   - `deriveBackfill(view, activeNames, catalog)`
   - `TeamAction` 组件（挂载在 `conversation.session.header.actions` 插槽，`order: -19`）。
   - 弹出菜单：包含 `BulkModelPicker`、双主按钮、只读 `data-committed-default` 摘要行、恢复继承链接按钮、以及每成员 `TeamModelEditor`。
   - `writeGate` 互斥保护与 HTTP 通信封装（`fetch('/api/dsh-team-member-model/teams')` 带 `x-dsh-team-member-model: 1`）。
2. 在 `lib/client.js` 的 `apply(ctx)` 中并列注册两个插槽：
   - 原有 `settings.section`（模型路由）保持不变。
   - 新增 `ctx.slots.inject('conversation.session.header.actions', ...)`。
3. 保持 `lib/client.js` 的模块级 `inject`：
   - `module.exports.inject = ['slots'];`（目录与推理档复用已有 HTTP `/state` 与 `/efforts`，无需额外私有解析器与服务依赖）。

- [ ] **步骤 3：运行测试验证通过**

运行：`node --test test/team-client.mjs test/client.mjs`  
预期：PASS（既有 client 测试 29 项 + 新增 team-client 测试全部通过）。

---

### 任务 5：包清单、文档更新与全链回归验证 (`package.json`, `README.md`)

**文件：**
- 修改：`package.json`
- 修改：`README.md`

- [ ] **步骤 1：更新 `package.json`**

- 提升版本号：`"version": "0.7.0"`。
- 保持 `dsh.client.inject` 精简（无需引入多余依赖）：
  ```json
  "inject": [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-ui-slots"
  ]
  ```
- 在 `files` 字段加入新增文件：
  `"lib/team-state.js"`, `"lib/team-routing.js"`, `"lib/team-client.js"`。

- [ ] **步骤 2：更新 `README.md`**

- 详细阐明 0.7.0 的核心能力：
  1. 团队模型设置弹出菜单：双主按钮（「应用到当前队员」与「设为新队员默认」）与只读继承恢复。
  2. 5 级路由解析优先级及其确定性（手动固定无 fallback，自动规则动态 failover）。
  3. 强调 Lead 模型绝对不受影响、成员改动下一轮生效的语义保证。

- [ ] **步骤 3：全量串行自动化回归测试**

运行：
```bash
node --test test/smoke.mjs test/client.mjs test/apply.mjs test/team-host.mjs test/team-client.mjs
```
预期输出：所有测试文件全部 pass，退出码 0，无任何失败或未捕获异常。

---

## 自检检查清单

1. **规格覆盖度：**
   - 5 级优先级（memberoverride > createexplicit > captureddefault > auto > inherit）？在任务 2、3 中有明确用例与实现。
   - 手动固定无 fallback、自动规则有 fallback？在任务 2、3 中通过 `isManualFixed` 阻断。
   - Lead 绝对保护？在任务 3 中通过 `!isChildAgent` 保证。
   - 成员变更下一轮生效、当轮不打断？在任务 2、3 中通过 `effectiveAfterTurn` 保证。
   - 统一 WebServer HTTP 通信（无 Typert 强依赖）？在任务 3、4 中落地。
   - 统一单决策入口（无双 waterfall 竞争）？在任务 3 中收敛至 `agent/request`。
   - 共享选择器回填状态机（一致/mixed/仅默认/空）与双主按钮？在任务 4 中完全落地。
2. **占位符扫描：** 无任何 TODO、TBD、占位代码，测试与实现均给出完整可编译代码段。
3. **类型与命名一致性：** `TeamStateStore`、`resolveTeamRoute`、`isManualFixedRoute`、`deriveBackfill`、`writeGate` 命名在各模块中严格对齐。
