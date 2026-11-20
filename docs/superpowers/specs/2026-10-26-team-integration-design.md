# 团队模型能力合并（dsh-team-member-model 0.7.0）设计规格

**日期：** 2026-10-26  
**目标代码库：** `/Users/mewcapoo/Projects/dsh-team-member-model`（版本 0.6.1 → 0.7.0）  
**参考代码库：** `/Users/mewcapoo/Projects/dsh-agent-team-switchable`（0.2.4，只读参照）  
**状态：** 用户已批准实施；本设计规范锁定架构、契约接缝与执行范围，不包含实际业务实现代码。

---

## 1. 架构目标与合并背景

### 1.1 背景与核心痛点
目前系统中存在两个模型路由插件：
- `dsh-team-member-model`（主干 0.6.1）：提供基于 magpie 语义的 Group/Rule 自动规则路由、408/429/5xx 运行期候选回退、用量统计及设置页，但在团队成员创建后缺乏针对特定成员的运行时动态换模与默认模型维护界面。
- `dsh-agent-team-switchable`（0.2.4）：提供团队 header 操作栏弹出菜单、单模型草稿 + 双主按钮（应用到当前队员 / 设为新队员默认）、成员卡片内逐行独立自动保存、以及下一轮生效与持久化恢复。但其通过独立 `installModelSelection` waterfall 与 `agent/request` 双重覆写，两者并存时会产生事件监听器顺序竞争、静默覆盖和状态分裂。

### 1.2 架构目标
1. **单一 Host 决策入口（Single Decision Point）**：彻底消除双 waterfall 覆写竞争。所有模型路由决策收敛至 `dsh-team-member-model` 内部的统一决策逻辑，不再引入外部 `installModelSelection`。
2. **严格 5 级路由优先级**：确立清晰的分层覆盖逻辑。
3. **回退行为隔离**：手动指定的路由严格固定、永不自动回退；仅自动规则支持候选链失败回退。
4. **Lead 绝对保护**：Lead 自身模型绝不参与任何拦截、修改或路由。
5. **完整保留既有能力**：保留现有设置页（`settings.section` order: 19）、自动规则引擎（`lib/rules.js`）及用量统计（`lib/usage.js`）。
6. **无缝复用 WebServer**：团队前后端交互直接复用 `dsh-team-member-model` 已有的 `ctx.webServer` HTTP 路由，不引入重型 RPC 协议栈。

---

## 2. 核心路由决策体系（5 级优先级）

在子 agent 或团队成员发起调用（`agent/request`）时，统一按以下严格优先级自顶向下解析，一旦命中即行确定：

```
┌─────────────────────────────────────────────────────────────┐
│ 1. memberoverride  已存成员显式覆盖 (choices[member.id])       │ ──► 手动固定：无回退 (candidates=[route])
├─────────────────────────────────────────────────────────────┤
│ 2. createexplicit  创建期显式指派 (request.agentOptions)       │ ──► 手动固定：无回退 (candidates=[route])
├─────────────────────────────────────────────────────────────┤
│ 3. captureddefault 团队默认创建快照 (initials[member.id])      │ ──► 手动固定：无回退 (candidates=[route])
├─────────────────────────────────────────────────────────────┤
│ 4. auto            自动规则引擎 (planRoute matching)         │ ──► 动态候选：允许 failover (408/429/5xx)
├─────────────────────────────────────────────────────────────┤
│ 5. inherit         官方继承兜底 (parent / official default)  │ ──► 官方默认：无额外插件回退
└─────────────────────────────────────────────────────────────┘
```

### 2.1 各级语义详细约束
1. **Level 1: `memberoverride`（已存成员显式覆盖）**
   - 来源：通过团队菜单保存的成员覆盖记录（`choices[member.id] = { selection, effectiveAfterTurn }`）。
   - 生效时机：仅当成员当前轮次 `turn > effectiveAfterTurn` 时生效（即**下一轮生效**）。
   - **当轮保护**：成员变更保存时，当前运行中的轮次不受打断，且不重置当前轮次的已执行状态。
   - **回退策略**：手动固定路由，`candidates = [selection]`，`failover.enabled = false`。遇到任何错误（包含 408/429/5xx）均直接抛回官方流程，绝不自动切换为其它模型。
2. **Level 2: `createexplicit`（创建期显式指派）**
   - 来源：创建子代理/团队成员时通过参数显式指定的模型（如工具调用 `agentOptions` 或暂存路由）。
   - **防误判守卫（Critical Guard）**：**严禁将任意不包含模型字段的 `agentOptions` 空对象（例如 `{}`）误判为显式路由**！必须严格判定 `typeof request.agentOptions?.model === 'string' && request.agentOptions.model.length > 0 && typeof request.agentOptions?.provider === 'string' && request.agentOptions.provider.length > 0`。
   - **回退策略**：手动固定路由，无自动回退。
3. **Level 3: `captureddefault`（团队默认创建快照）**
   - 来源：团队成员在创建时刻（`provisioning`），从所属团队当时的 `defaultModel` 快照捕获并持久化到 `initials[member.id] = { selection, source: 'captureddefault' }`。若创建时团队无默认，持久化记录 `initials[member.id] = null`，明确终结快照，严禁后续套用新默认。
   - **时序与稳定性**：后续若团队修改了 `defaultModel`，该修改仅影响未来新创建的成员，已创建成员的 `initials` 快照保持不变。
   - **回退策略**：手动固定路由，无自动回退。
4. **Level 4: `auto`（自动规则引擎）**
   - 来源：未被前三级手动命中的子 agent / 团队成员，交由 `lib/rules.js` 的 `planRoute(policy, context, ...)` 计算。
   - **原语义保留（重要）**：规则未命中并不直接走向 `inherit`！当 `policy.members` 非空时，规则未命中默认取排序首项成员作为首选（`planRoute` 的既有 magpie 行为）。即使 `policy.failover.enabled === false`，依然使用规则/首项模型生成单一候选（`candidates = [member]`）替换路由，仅关闭失败自动重试，绝不绕过已配成员回退到 `inherit`。
   - **回退策略**：动态候选链。仅在开启 `failover.enabled` 且遇到可重试失败（408、429、5xx、网络中断）时，按候选列表顺序进行故障转移，最多重试 `failover.patience` 次（默认 2 次）。400/401/403/404 等请求本身拒绝绝不回退。
5. **Level 5: `inherit`（官方继承兜底）**
   - 来源：仅当路由器未配置（`policy.members` 为空且无 `match`）或通道显式关闭（如 `fork` 未开启 `allowFork`）时，才回退到官方原生默认行为。
   - **回退策略**：无插件干预。

### 2.2 Lead 绝对保护原则
- 在任何拦截点（`agent/request`、`agent/request-error`、创建包装），首要检查：
  ```js
  if (!isChildAgent(agent)) return config; // Lead 永不参与路由
  ```
- Lead 自身的模型、推理档位及请求头透传不受任何修改，严防管理会话被篡改。

---

## 3. Host 架构设计与状态生命周期

### 3.1 消除双重拦截与单一决策点
- 旧 switchable 使用 `installModelSelection` 挂载独立 waterfall，与 `dsh-team-member-model` 的 `installFailover`（`agent/request`）并存造成竞争。
- **重构方案**：在 `dsh-team-member-model` 的 `agent/request` 监听器中完成统一裁决。
  ```js
  // 伪代码执行逻辑（lib/index.js 统一入口）
  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    if (!isChildAgent(payload.agent)) return config;

    const childId = sessionIdOf(payload.agent);
    const turn = currentTurnOf(payload.agent);

    // 1. 检查 Level 1: memberoverride
    const memberChoice = state.teamStore.getEffectiveChoice(childId, turn);
    if (memberChoice) {
      return applyFixedManualRoute(state, childId, config, memberChoice.selection, 'memberoverride');
    }

    // 2. 检查 Level 2 & 3: createexplicit / captureddefault
    const initialChoice = state.teamStore.getInitialRoute(childId);
    if (initialChoice) {
      return applyFixedManualRoute(state, childId, config, initialChoice.selection, initialChoice.source);
    }

    // 3. 检查 Level 4: auto 规则路由 (policy.members 非空时必有首选路由，无论 failover.enabled 是否开启)
    const autoChild = claimAutoChild(state, payload.agent, config);
    if (autoChild) {
      return applyAutoRoute(state, childId, config, autoChild, state.policy.failover?.enabled === true);
    }

    // 4. Level 5: inherit 官方继承
    return config;
  });
  ```

### 3.2 团队成员生命周期与快照预约时序
1. **公开事件观测**：
   - 监听 `session/event`：当收到 `team/member` 事件且 `version === 2`、`member.phase === 'provisioning'` 时，获取所属 `teamId`（即 Lead SessionId）。
   - 若团队存在有效的 `defaultModel`，立即在内存中预约捕获：`teamStore.stageInitial(member.id, team.defaultModel)`。
2. **串行代理初始化**：
   - 挂载 `agent/created` 串行钩子（`mode: 'serial'`）：
   - 当 `agentTeams.tryMembership(agent)` 返回 `role === 'teammate'` 时：
     - 判定成员初始快照：**仅允许使用明确在创建边界捕获的快照**（如 `stagedInitial`）。若创建期团队无默认或未捕获，**持久化显式标记为 `null`（`initials[member.id] = null`）**，绝不回退至 `agent/created` 触发时团队当时最新的 `defaultModel`，严防晚预约与后续新默认污染已创建的旧成员。
     - 记录成员稳定映射：`memberId ↔ { name, teamId }`。
3. **架构安全边界**：
   - 团队成员关联与快照完全依赖公开的 `session/event` 和 `agentTeams.tryMembership`，**严禁再次复制私有反射穿透代码（`reflect._getImpl` / `reflect.store`）来处理团队逻辑**。

### 3.3 数据持久化与并发控制
1. **存储物理路径**：
   - 存放在 `~/.dsh/team-member-model/teams.json`。
   - **严禁扫描或自动导入**旧 switchable 插件的 `~/.dsh/storages/agent_team_model_settings.json`；保持完全隔离，原有配置不破坏、不修改。
2. **并发写队列与原子落盘**：
   - **全文件全局串行队列（Global Queue）**：由于多个 Team 的数据存放在同一个 `teams.json` 物理文件中，写操作必须由**全局单一的 Promise 队列**（`writeQueue = writeQueue.then(...)`）串行化，严禁采用每个 Team 独立的 Promise 链并发写同一 `teams.json.tmp` 临时文件，杜绝跨团队并发覆写丢失及 rename ENOENT 竞态。
   - 单次写操作执行：内存快照原子读改 → 业务变换（校验）→ 生成不可变深拷贝（`immutable`）→ 原子写入临时文件（`teams.json.tmp`）后 rename 覆盖 → 更新内存快照。
   - 每次写操作单调递增所在团队的 `revision`，杜绝乱序写回与并发写破坏。

---

## 4. 前后端通信契约（基于 `webServer`）

为避免引入繁重的 Typert RPC 依赖，充分复用 `dsh-team-member-model` 现有的 `ctx.webServer`，统一收敛至单个 `/api/dsh-team-member-model/teams` 端点（GET 与 PUT）：

### 4.1 接口清单
所有写操作必须携带请求头 `x-dsh-team-member-model: 1`，且仅允许本机回环（loopback）访问。

1. **`GET /api/dsh-team-member-model/teams?sessionId=<id>`**
   - 鉴权与校验：调用 `sessionController.resolveAgent(sessionId)` 获取 Agent，并通过 `agentTeams.membership(agent)` 或 `tryMembership` 验证其所属团队的有效 Lead，不直接将请求参数当作可信身份。
   - 响应格式：
     ```json
     {
       "ok": true,
       "view": {
         "teamId": "session-xxx",
         "revision": 4,
         "defaultModel": { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "low" },
         "members": [
           {
             "id": "member-session-1",
             "name": "worker-1",
             "description": "代码实现员",
             "phase": "active",
             "status": "running",
             "currentModel": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" },
             "nextModel": { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "low" }
           }
         ]
       }
     }
     ```
   - 字段说明：
     - `currentModel`：来自该成员自身最近真实的 `request/header` 中的 config（真实生效路由）。
     - `nextModel`：来自插件已提交的持久化选择（下一轮将要运行的模型）。
2. **`PUT /api/dsh-team-member-model/teams`**
   - 请求体（统一单入口，target 必须使用不可变的成员 ID，通过 target 区分队员覆盖与默认模型）：
     ```json
     {
       "sessionId": "session-xxx",
       "target": "member-session-1", // 必须为不可变成员 ID (string) 或 null (表示设置未来团队默认)
       "selection": { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "low" }, // 或 null (当 target 为 null 时恢复继承)
       "revision": 4 // 乐观锁版本号
     }
     ```
   - 校验逻辑：
     - 鉴权 Lead 身份：通过 `sessionController.resolveAgent(sessionId)` 获取发起方 Agent，验证其为合法存活团队 Lead。
     - 校验 `selection` 合法性：必须在当前 `llm` 目录中真实可用。
     - 校验乐观并发：检查传入的 `revision === team.revision`，若版本滞后则返回 409 Conflict。
     - 若 `target` 为非空字符串（即不可变成员 ID）：
       - 通过 `agentTeams.listMembers(leadAgent)` 查找该成员。
       - 严格依据解析后的实体属性校验：必须存在且 `member.role === 'teammate'`，且 `member.id !== leadAgent.id`（绝不能以 `target !== 'lead'` 字符串字面判断），且 `member.phase === 'active'`。
       - 写入 `choices[target] = { selection, effectiveAfterTurn: lastOwnTurn(memberAgent) }`。
     - 若 `target === null`：更新团队 `defaultModel`（若 `selection === null` 则清空默认，恢复继承）。
   - 响应：返回更新后的完整 `{ ok: true, view }`。

---

## 5. 客户端 UI 交互设计（Header Action Slot）

### 5.1 插槽挂载与布局结构
- 注册公共插槽：`conversation.session.header.actions`，`order: -19`，紧邻官方 Agent Teams 菜单。
- 依赖注入声明：`inject = ['slots']`（目录与推理档复用已有 HTTP `/state` 与 `/efforts`，无需额外私有解析器与多余服务依赖）。
- 弹出菜单内部结构：
  ```
  ┌────────────────────────────────────────────────────────┐
  │ [Region: 统一模型设置]                                  │
  │  · 提示：修改草稿不自动保存                               │
  │  · <BulkModelPicker> (共享 Provider/Model/Effort 选择器)│
  │  · [状态提示: 成员设置不一致 / 目录失效清空提示]           │
  │  · [按钮 1] 「应用到当前队员」 (Scope: 显式逐人覆盖)      │
  │  · [按钮 2] 「设为新队员默认」 (Scope: 仅设未建成员默认)  │
  │  · 批量操作执行进度与结果反馈 (saved/failed/skipped/...)   │
  ├────────────────────────────────────────────────────────┤
  │ [Region: 之后新增成员默认] (只读展示 + 恢复继承)        │
  │  · 已保存的新成员默认：provider/model · effort           │
  │  · [链接按钮] 「恢复继承」 (同锁调用 default: null)      │
  ├────────────────────────────────────────────────────────┤
  │ [Region: 团队成员列表] (逐人独立自动保存)               │
  │  · 成员卡片 (name, status, description)                │
  │  · 路由对比：最近已使用 (actualheader) vs 下轮选择 (next)│
  │  · <TeamModelEditor> 内联下拉 (变更立即自动保存单成员)   │
  └────────────────────────────────────────────────────────┘
  ```

### 5.2 共享选择器（`BulkModelPicker`）回填规则
打开菜单时，草稿初值的回填严格按照以下状态机推导，杜绝误导用户：
1. **成员完全一致**：可执行成员（`phase === 'active'` 且在官方活动名单内）的下轮预期模型完全一致，且该模型在当前有效目录中可用 → **回填该一致模型**。
2. **成员设置分散（Mixed）**：成员间设置不同 → **保持空白草稿**，并显式展示提示：*“成员设置不一致，请选择要统一的模型”*，绝不预填默认模型制造假象。
3. **无可执行成员但有有效默认**：团队尚无活跃队员，但已配置合法未来默认 → **回填该默认模型**；此时按钮 1（应用到当前）禁用，按钮 2（设为新默认）可用。
4. **完全无数据**：成员为空且默认未设置 → 初始为空白草稿，两主按钮均禁用（仅针对草稿未选有效模型，一旦用户手动选择有效模型，按钮 2「设为新队员默认」即刻变为可用）。
5. **用户编辑保护（Pristine Guard）**：用户一旦在界面上进行了手动修改，后续后台数据轮询绝不覆盖用户正在输入的草稿。目录模型下架时，清空草稿并给出失效提示。

### 5.3 双主按钮与恢复继承行为规范
1. **主按钮 1：「应用到当前队员」**
   - 作用域：严格限定为点击时刻快照中所有 `active` 非 Lead 队员，逐人显式发起写入；**绝对不改动未来默认（`defaultModel` 0 调用）**。
   - 提交期间锁定全菜单控件，防止重复点击。
2. **主按钮 2：「设为新队员默认」**
   - 作用域：仅将当前草稿设置为团队未来的 `defaultModel`；**绝对不改动任何当前已有的队员设置**。
3. **轻量链接：「恢复继承」**
   - 独立入口：位于只读默认摘要行旁，调用 `PUT /team/default` 传入 `selection: null`。
   - 独立可用性：只要当前已存默认非空且处于空闲态即可点击，不依赖顶部共享草稿的有效性（即便草稿模型下架也能清除旧默认）。

### 5.4 并发互斥锁体系（`writeGate`）
- 采用单层全局所有权互斥闸门：`busy = writeGate.current || store.getSnapshot().saving`。
- 同一 tick 内，按钮 1、按钮 2、恢复继承、成员行内 autosave 之间绝对互斥，只有一个操作能够成功发起。
- 写入中或网络重试期间，严格拦截弹出菜单关闭、Escape 键与外部点击，避免状态丢失。

---

## 6. 模块拆分与并行 TDD 规划

为保证工程整洁，杜绝大单体文件堆砌，按以下清晰边界拆解模块，支持并行实现与自测：

| 模块范围 | 涉及文件 | 职责与测试边界 |
| --- | --- | --- |
| **Scope 1: Host 数据持久化与并发队列** | `lib/team-state.js`<br>`test/team-host.mjs` | 负责 `teams.json` 在 `DSH_HOME` 下的原子落盘、Promise 串行链、不可变深拷贝、`initials` 与 `choices` 存取及版本自增。 |
| **Scope 2: 团队 HTTP 服务与鉴权** | `lib/index.js`<br>`lib/team-state.js`<br>`test/team-host.mjs` | 负责 `/api/dsh-team-member-model/team/*` 路由处理、防跨团队冒名与 Lead 校验（`sessionController`）、模型目录验证、入参严格校验、视图模型投影。 |
| **Scope 3: 单一路由决策引擎集成** | `lib/index.js`<br>`lib/team-routing.js`<br>`test/team-host.mjs` | 负责将 5 级优先级接入 `agent/request`，接入 `session/event` (team/member) 与 `agent/created` 快照，严格隔离手动固定与规则回退，记录 fixed 来源状态。 |
| **Scope 4: Client 弹出菜单与插槽 UI** | `lib/client.js`<br>`lib/team-client.js`<br>`test/team-client.mjs` | 负责注入 `conversation.session.header.actions` 插槽，实现共享选择器、双主按钮、恢复继承、逐行自动保存及 `writeGate` 并发锁。 |
| **Scope 5: 交付收尾与集成验证** | `package.json`<br>`README.md` | 升级版本号至 0.7.0，更新配置说明与文档，执行全量自动化回归测试。 |
