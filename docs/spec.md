# dsh-team-member-model —— 子 agent 模型路由与团队模型管理

> 版本以 `package.json` 为准（当前 0.7.12）；目标 DSH `0.2.2-rc.3` 及以上，完整验证待完成。
> 日期：2026-10-26；本节包含历史架构背景。
> 架构参考：[yetone/magpie](https://github.com/yetone/magpie) 的 Group/Rule 路由 + `dsh-agent-team-switchable` 团队模型设置合并。

## 1. 它解决什么

0.2.1 只在**团队成员创建时**能把模型传进去（`spawn_modeled_teammate` 的显式参数）。
0.3.0 把这件事升级成 magpie 式的**路由**：一处配置「谁跑哪个模型」，在**子 agent 创建时刻**按规则命中决定路由，并且在**运行期失败时按候选顺序回退**。

Lead 自己的模型**永不参与路由**（用户明确要求，且由 `session.header.origin` 硬隔离，见 §4）。

## 2. magpie 思路 → 本插件的 1:1 映射

| magpie | 本插件 | 说明 |
| --- | --- | --- |
| `Group.Members`（`provider/model[:effort]`） | `policy.members` | 档位是成员身份：同一模型可两档并存，回退链可先降档再换模型 |
| `Group.Rules`（按序，首命中） | `policy.rules` | 命中决定**首选**成员，不是白名单 |
| `Group.Pick` | `policy.pick` | 一键换（手动模式，跳过规则） |
| `Group.Off` | `policy.off` | 临时摘除成员，保留其位置 |
| `Group.Routing` = `order`/`rotate`/`weight` | `policy.routing` | 候选排序策略 |
| `Group.Routing` = `smart`/`usage`/`pace` | — | **不搬**：DSH 拿不到配额窗口（`allowances`）数据 |
| `Group.Sink` | 内存 `sink` 集合 | 429 的成员退到候选末尾，重启清空（与 magpie 同） |
| `Group.Affinity` | 父会话 → 成员（**仅 fork 通道**） | 子会话共享父前缀时才值得粘；spawn 系子代理各自独立，交给排序策略轮转 |
| `Group.Match`（glob/regex 从目录收成员） | `policy.match` | 目录里匹配的模型自动追加进候选 |
| `Rule.Use` | `rule.use` | `"provider/model"` |
| `Rule.Time{From,To,Days}` | `rule.time` | 跨午夜、days 归于窗口**开始**那一天 |
| `Rule.Folders` / `ExceptFolders` | `rule.folders` / `rule.exceptFolders` | cwd 取自 `parent.session.header.cwd`；`/a/b` 不吃 `/a/bc`；`C:\x` ↔ `/mnt/c/x` 互认 |
| `Rule.Agents` | `rule.channel`（`spawn`/`fork`）+ `rule.continuable` | 只到这一级，见 §5 |
| `Rule.Tokens` | `rule.tokens` | `tokenMeter.measure(parent.session).totalTokens` |
| `Rule.Effort` | `rule.effort` | 父会话当前推理档（`none`/`on`/具体档位） |
| `Rule.Images` | `rule.images` | 扫创建请求的内容块 |
| `Rule.Pause` | `rule.pause` | 按时间/目录/通道把成员摘出候选（不发送） |
| `Rule.Intent` + Classifier | `policy.classifier` + `rule.intent` | 开启且**至少有一条意图规则**时才会调用分类器（没有意图规则就直接跳过，不花冤枉钱）；结果按任务文本缓存；判不清则不命中、退回默认行为 |
| `Rule.Compact` | — | **不适用**：压缩不经子 agent |
| 候选人循环 + `failure()` + rest 阶梯 | `agent/request` + `agent/request-error` | 见 §4 |
| `FirstToken` | — | **v2**：要挂 `llm/stream` 判首字超时 |
| `Patience` | `policy.failover.patience` | 简化为有界重试次数 |
| Route trace + Routing 页 | trace 环形缓冲 + 设置页 | 决策留痕 |
| 网关 / 四协议翻译 / 端口 / 账号池 | — | **不搬**：DSH 在进程内调模型，没有协议面 |

## 3. 契约：policy v3

```jsonc
{
  "version": 3,
  "members": [ { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "max" },
                { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "low", "weight": 3 } ],
  "rules": [
    { "use": "opencode-go/deepseek-v4.1-flash", "channel": "fork", "label": "*review*",
      "folders": ["~/proj"], "exceptFolders": ["~/proj/legacy"], "tokens": 60000,
      "effort": "high", "images": true, "intent": "写作或修改测试",
      "time": { "from": "22:00", "to": "08:00", "days": ["fri", "sat"] } },
    { "use": "zai-coding-cn/glm-5.3", "pause": true, "time": { "from": "09:00", "to": "12:00" } }
  ],
  "match": ["opencode-go/*"],
  "pick": null,
  "off": [],
  "routing": "order",
  "allowFork": false,
  "failover": { "enabled": true, "patience": 2 },
  "classifier": { "enabled": false, "provider": "zai-coding-cn", "model": "glm-5.3" }
}
```

**兼容**：读到 0.2.1 的 `{version:1, routes:[...]}` 或组合行 config 里的裸数组，自动迁移成 `members` + 空规则（不丢配置、不报错）。

## 4. 机制（均已从官方包实体核实，非类型猜测）

| 环节 | 契约 | 出处 |
| --- | --- | --- |
| 创建期注入（团队成员 / 后台子代理） | `subagents.startContinuable(spec)` 读 `spec.request.agentOptions` | `dsh-subagent/lib/index.js:1671-1683` |
| 创建期注入（一次性 / fork / workflow） | `subagents.start(name, request)` 读 `request.agentOptions` | `dsh-tool-subagent/lib/index.js:495-520` |
| **fork 通道也能换模型** | `fork` 与 `spawn` 的 provider 都声明 `capabilities.agentOptions: true` | `dsh-subagent-fork-in-process:37`、`dsh-subagent-spawn-in-process:23` |
| 准备前模型选择 | `agent/inbox/claimed` / `agent/created`：在 preStep 步骤准备前（带 per-turn guard）调用 `agent.model.select(selection)` 确立模型，`agent/request` 严格保持一致 | `@deepseek-ai/dsh-agent/lib/types/model-selection.js:88`、`dsh-agent-loop:1000` |
| 运行期延迟回退 | `agent/request-error`：记录 `trace deferred`，推进 rest/sink 候选状态，错误放行交给官方 `next()`；下轮选择下一候选 | 官方 AgentLoop retry 契约（同 step 仅同模型） |
| 失败分类 | `LlmFailure{message, code, status?, providerRetryAfterMs?}`（「policy decides whether they are retryable」） | `dsh-llm/lib/types/types.d.ts:26-44` |
| Lead 硬隔离 | `session.header.origin === 'subagent'`、`delegationDepth`（持久化字段） | `dsh-session/lib/types/types.d.ts:81-87` |
| 父会话目录 | `parent.session.header.cwd` | `dsh-subagent/lib/index.js:470-481` |
| 上下文规模 | `tokenMeter.measure(session).totalTokens` | `dsh-token-meter/lib/types/types.d.ts:24-37` |
| 分类器调用 | `llm.stream({provider, model, messages, maxTokens, signal})` | `dsh-llm/lib/index.d.ts:412` |
| 模型可配的推理档 | `llm.resolveModelInfo(provider, model).reasoning.{efforts[].id/name, defaultEffort}` | `dsh-llm/lib/types/types.d.ts:341-358` |
| 注入不被工具层改写 | `tools/pre-execute` 只能 allow/deny/cancel/ask；`tools/execute`「call identity remains immutable」 | `dsh-tools/lib/types/index.d.ts:445-460` |

### 回退语义（0.7.10 延迟回退与「never for a refusal of the request itself」）

- **宿主重试契约限制**：官方 SDK 的 AgentLoop 仅支持「同 step 同模型 retry」。0.7.10 废弃了在同一 step 内强行偷换 config 欺骗官方的行为（那会破坏官方在 preStep 锁定的 selection 并触发报错），改用**延迟回退（Deferred Failover）**。
- **只回退可重试失败**：`status` ∈ {408, 429, 5xx}，或 `code` 命中超时/过载/网络/限流/额度类。
  **400/401/403/404/413/422 这类「请求本身的拒绝」一律不回退**——换模型也答不对，只会掩盖错误。
- **rest 阶梯与沉底**（照 magpie `failure()` 对齐）：vendor 给的 `providerRetryAfterMs` 优先（封顶 30 分钟）；
  额度/余额用尽 → 30 分钟（magpie 是「rest 到重置时刻」，DSH 拿不到重置时刻）；限流/过载/busy →
  60 秒起每次翻倍、封顶 30 分钟（`longestRateRest`）；其余失败 → 60 秒起每次翻倍、封顶 10 分钟（`longestRetry`）。
  429 的成员退到候选末尾（`sink`，内存态，重启清空）。
- **延迟生效与官方放行**：遇到可重试失败时，插件在决策记录中标记 `trace deferred`，并将当前 step 的错误**如实交给官方 AgentLoop 处理（调用 `next()`）**。插件不拦截当前 step 强行切模、不自动重发、不伪造合成消息。当进入**下一个 turn** 时，插件在 `agent/inbox/claimed` 步骤准备前按已更新的阶梯自动切换到下一可用候选生效。
- **明确边界：这不是旧版同 step 跨模型自动恢复**。
- **served 清 rest**：某成员下一次调用到来时，若它上一次尝试没有紧跟 `request-error`，说明它答上了 → 清掉它的 rest。
- **有界**：每个子 agent 最多追加 `failover.patience` 次候选切换（默认 2），用完即把失败原样抛回官方循环。手动固定（前 3 级）不参与这套回退。

## 5. 命中的边界（诚实写清，别指望它做不到的事）

路由点在 `subagents.start` / `startContinuable` **服务缝隙**上，那里没有工具名：

- `channel` 只能到「哪个 subagent provider（`spawn` / `fork`）+ 是否 continuable」；
  **区分不出 `subagent` 与 `workflow`**（两者都走 provider `spawn`）。要更细，用 `label` 通配。
- 拿不到 magpie 的 `Tokens`（请求体估算）语义，改用父会话当前 `totalTokens`——**语义是「这个会话已经多大了」，不是「这次请求多长」**，配置时按前者理解。
- `images` 扫的是创建请求的内容块，不是父会话历史里的图。
- Intent 分类器分类的是**子任务文本（label + 提示）**，不是「用户那句话」——DSH 的子 agent 创建没有对应的用户消息。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 回退挂在 agent 循环上，写坏会污染 Lead | 只处理 `header.origin === 'subagent'` 的 agent；Lead 的 `agent/request` 原样返回 `next()`，且不注册任何子状态 |
| 重试风暴 | 可重试失败白名单 + `patience` 上界 + 受 `payload.signal` 约束 |
| 注入绕过官方 `subagent-model-selection` 白名单 | 显式路由优先级最高且仍受官方白名单管；本插件的 `members` 是它自己的授权面，设置页同时展示两者 |
| 路由到不可用 provider | 注入前查 `llm.listProviders()`；未注册则**不注入**并记 trace（退回继承 Lead，不消耗创建） |
| 官方升级改了契约 | `start`/`startContinuable` 取不到本体时 `apply` 直接抛（插件显示启动失败）；`agent/*` 事件按名字注册，取不到就是没有回退，不影响创建期路由 |

## 6.4 成员与绑定（0.6.0 / schema v4）

| 层 | 装什么 | 为什么 |
| --- | --- | --- |
| **成员**（`name`，逻辑级） | 规则 `use`、`pick`、`off`、亲和、`weight`、成员级 `off` | 规则不该绑死渠道；换渠道/换模型 id 不动规则 |
| **绑定**（`provider/model[:effort]`，渠道级） | 推理档、渠道停用时段 `time`、单独停用 `off`；`rest`/`sink`/用量归属按它 | 档位是渠道能力；限速/高峰是渠道事实 |
| **规则** | 任务类条件（label/intent/channel/continuable/member/folders/tokens/effort/images/time） | 「什么样的任务」与「哪个渠道」正交 |

**解析顺序**：pause 摘成员 → `pick` → 规则首条命中 → 亲和（成员名）→ 策略排序。
**候选阶梯**：目标成员的绑定（按顺序）→ 其余成员的绑定（按策略顺序）；rest/sink 的绑定整体排末尾。
**运行期回退**：先同成员换渠道，再换成员。
**迁移**：v3 扁平成员 → 「名字 = `provider/model[:effort]`、单绑定」成员，规则零改动；
规则的 `use` 也可写绑定键，解析到包含它的成员；`upgradeRefs` 仅在无歧义时把裸 `provider/model` 升级成成员名。

## 6.5 用量统计（0.4.0）

| 口径 | 规则 |
| --- | --- |
| 统计对象 | **只统计子 agent**（`session.header.origin === 'subagent'` 或 `delegationDepth ≥ 1`）；Lead 不计 |
| 计数锚点 | 只在 `assistant/message` 这种成功提交的锚点计数（与官方 `dsh-token-usage-counter` 一致），失败/重试不计 |
| usage 缺席 | 适配器没报用量时**不算一次调用**（否则调用次数虚高） |
| 去重 | 同一 `(turn, step)` 只算一次 |
| token 字段 | `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` 四项互不重叠，总量取和 |
| 归属 | 子会话 → 它**实际跑的绑定**（创建时记录；插件重启后由 `session.requestHeader().config` 兜底） |
| 两层报告 | `GET /usage` 同时返回 `members[]`（按逻辑成员聚合）与 `members[].bindings[]`（渠道明细，含四项 token）；界面成员行可展开看渠道——「按成员看总量、点开看哪个渠道在干活」 |
| 规则命中 | 规则驱动的创建按 `#N *关键词*` 计数（图 3）；权重轮转/显式/未纳管分开记 |
| 落盘 | `<DSH_HOME>/team-member-model/usage.json`，写完节流 15s，**重启不清零**；`PUT /usage/reset` 清零 |
| 不做成本 | DSH 不提供每模型单价表，所以不给金额估算 |

## 6.6 随包技能（0.5.0）

| 项 | 约定 |
| --- | --- |
| 事实源 | `skills/model-routing/SKILL.md`（frontmatter: name / description / whenToUse） |
| 注册时机 | Host `apply()` 里 `ctx.inject(['skills'], cb)` → `skills.register(...)`；**可选依赖**，服务缺席不报错 |
| 读不到文件 | 视为「没有技能」，返回 undefined，插件照常启动 |
| 可移植 | 同一文件可直接复制到 `~/.agents/skills/model-routing/`，给没装插件的环境用 |
| 内容边界 | 只讲本插件能做的事：接口、schema、语义、配方、红线；不复述 DSH 通用工具 |

## 7. 验收与回归

1. `node test/smoke.mjs` —— 引擎纯函数（37 项）：规则匹配（含边界/跨午夜/days/exceptFolders/glob）、策略排序、pick/off、v1→v3 迁移、失败分类白名单。
2. `node test/apply.mjs` —— 假宿主端到端（43 项，**复刻 cordis traceable 两个陷阱**）：两条创建通道都注入、fork 默认不注、显式优先、回退状态机（可重试→换候选、不可重试→放手、patience 用尽→放手）、rest/sink/served 清 rest、卸载还原。
3. `node test/client.mjs` —— 设置页客户端半侧（29 项，node:vm 真跑）：样式注入、草稿↔策略往返、槽位注册。
4. `node test/team-state.mjs` —— 团队状态持久化（3 项）：全局单队列 Promise 串行落盘、文件原子替换、版本号自增与冷启动恢复。
5. `node test/team-host.mjs` —— Host 团队路由裁决（6 项）：5 级优先级判定、手动固定禁止回退、HTTP 端点鉴权与模型目录严格校验。
6. `node test/team-client.mjs` —— 团队顶栏菜单前端（12 项）：插槽注册、共享草稿回填状态机（全等/mixed/仅默认/空）、双主按钮与恢复继承、`writeGate` 并发锁。
7. `node test/team-integration.mjs` —— 全链路集成测试（12 项）：5 级优先级端到端生效、预约快照隔离、当轮保护次轮生效、immutableId 隔离、CAS 乐观锁。
全量运行：`node --test test/smoke.mjs test/apply.mjs test/client.mjs test/team-state.mjs test/team-host.mjs test/team-client.mjs test/team-integration.mjs`（142 项原生断言，全部通过，exit 0）。

## 8. 团队模型管理与单决策入口契约（0.7.0）

### 8.1 5 级路由解析优先级与回退边界

| 优先级 | 来源类型 | 生效时机 | 回退策略 (Failover) | 说明 |
| --- | --- | --- | --- | --- |
| 1. `memberoverride` | 团队菜单成员覆盖 (`choices[member.id]`) | `turn > effectiveAfterTurn` (次轮) | **手动固定：无回退** (`candidates=[route]`) | 当轮受保护不打断；修改不重置当前状态 |
| 2. `createexplicit` | 创建期传参显式指定 (`agentOptions`) | 创建首轮生效 | **手动固定：无回退** (`candidates=[route]`) | 严格判定 `provider` 与 `model` 非空，防空 `{}` 误判 |
| 3. `captureddefault` | 成员创建时捕获的团队默认快照 (`initials`) | 创建首轮生效 | **手动固定：无回退** (`candidates=[route]`) | 创建时团队无默认则记录 `null`，防后套新默认 |
| 4. `auto` | 自动规则引擎 (`policy.rules` 匹配) | 动态计算（`agent/inbox/claimed` 准备前选择） | **允许延迟故障转移** (Deferred Failover：可重试错误推 rest/sink，错误交官方，下轮生效) | 明确无同 step 伪重试；规则未命中且成员表非空时取首项 |
| 5. `inherit` | 官方原生默认 (父会话 / official default) | 兜底 | **官方原生行为** | 路由器未开启或通道关闭时生效 |

- **Lead 绝对隔离**：`!isChildAgent(agent)` 直接放行，绝不修改 Lead 模型。
- **单决策入口**：在 `lib/index.js` 的 `agent/created` 与 `agent/inbox/claimed` 准备前调用 `agent.model.select()` 统一确立（避开 `turn/start` 重入风险），`agent/request` 严格保持一致，彻底消除双 waterfall 覆写竞争与 prepareRequest 冲突。

### 8.2 数据持久化与生命周期契约

- 存储路径：`<DSH_HOME>/team-member-model/teams.json`。
- 全局写队列：单物理文件必须由全局单 Promise 链（`writeQueue = writeQueue.then(...)`）串行落盘，以 `teams.json.tmp` 写完后原子 `rename` 覆盖，杜绝跨团队丢写与 rename ENOENT 冲突。
- 隔离性：旧 `dsh-agent-team-switchable` 存储不自动迁移，完全独立。
- 团队寻根与成员发现：目标 rc.3 使用公开 `subagents.rootOf` 与 `listDescendants`；创建入口为 `startActivation`。以不可变会话 ID 作为身份，Host 校验归属。创建预约记录当时的默认快照或 null，不把后来的默认应用到已有成员。
- Client 从已加载的 `subagentCatalog` 按 ID 反向寻根；缺失、循环或多父冲突时关闭入口，活动名单以 Host 校验为准。

### 8.3 WebServer HTTP REST 契约

- 路由前缀：`/api/dsh-team-member-model/teams`（支持 GET 与 PUT，要求 `x-dsh-team-member-model: 1` 与本机回环鉴权）。
- `GET /teams?sessionId=<id>`：由 Host 确认会话根与成员归属，返回标准 `view` 模型。
- `PUT /teams`：请求体 `{ sessionId, target, selection, revision }`：
  - `target`：为不可变成员 ID（非 display name）时写队员覆盖（下轮生效）；为 `null` 时写团队未来默认（`selection: null` 恢复继承）。
  - 鉴权：Host 通过公开子代理关系核验团队根与成员身份；队员必须属于该团队且非 Lead。
  - 并发保护：`revision` 不符返回 409 Conflict。

### 8.4 客户端顶栏菜单与交互架构

- 插槽挂载：`conversation.session.header.actions`（order: -19），内联实现于 `lib/client.js`，依赖精简为 `inject = ['slots']`。
- 单共享草稿（`BulkModelPicker`）：选择模型不发 RPC；目录失效清空草稿并提示 `bulk.reselect`；用户编辑后不被轮询冲掉。
- 双主按钮：
  - 「应用到当前队员」：逐人调用 PUT 覆盖当前 active 队员，**不改未来默认**。
  - 「设为新队员默认」：单次 PUT 设置团队 `defaultModel`，**不改已有队员**。
- 默认摘要与恢复继承：只读行展示 `data-committed-default`，旁设「恢复继承」链接按钮（即使草稿非法也可清空旧默认）。
- 全局互斥锁（`createWriteGate`）：双主按钮、恢复继承、成员行内保存及关闭拦截共用单层锁，同 tick 严格互斥防重入，网络重试期间保持锁定。
- 弹窗 Portal 逃逸（0.7.9）：`TeamPopup` 改用 `react-dom.createPortal` 挂载至 `document.body`，彻底逃逸 DSH 0.2.2-rc.1 顶栏祖先容器的 `overflow: clip` 与 `mask-image` 裁切。
