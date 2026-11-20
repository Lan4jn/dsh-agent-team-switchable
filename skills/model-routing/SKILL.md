---
name: model-routing
description: 配置 DSH 子 agent 的模型路由（成员表、规则、意图、用法）。当用户说「改模型路由」「这类活交给某个模型」「省钱」「看哪个模型用得多/为什么跑错模型」时使用。
whenToUse: 用户要调整子 agent（subagent / subagent_fork / 团队成员 / workflow 的 agent()）跑哪个模型、按任务分流、或核对路由是否生效时。
---

# 配置 DSH 模型路由

这个插件把**子 agent 的模型**变成可路由的：在 `subagents.start` / `startContinuable` 这个创建缝隙上注入
`agentOptions`，按「成员表 + 规则」决定它跑哪个 provider/model/档位，运行期失败按候选顺序回退。
**Lead 自己的模型永不参与路由**——用户改 Lead 模型请用界面的模型选择器，与本技能无关。

## 0. 铁律：只走 HTTP 接口，不要直接改文件

- 直接编辑 `<DSH_HOME>/team-member-model/policy.json` **不会生效**：宿主只在**进程启动**时读它。
- 唯一生效路径：`GET /state` → 改 JSON → `PUT /policy`（**全量替换**，省略的字段会回到默认值，所以务必先读回来再改）。
- 接口由 **DSH 官方连接鉴权**把关：插件的 HTTP 路由在动作前调用官方 `connection.requestRejection({headers})`，
  官方回 401/403 就照原样拒绝（插件不另造 token、不开 CORS 白名单、不信任 `X-Forwarded-*`）。
  本机回环照旧可用；**远程 / 反代能不能访问，由用户在 DSH 官方 `trustedHosts` 与凭据里决定**，不是本插件的配置项。
- 写操作必须带请求头 `x-dsh-team-member-model: 1`（HTTP 载体的 CSRF 防护；界面走连接通道时不经过这个头）。
- 默认基址：`http://127.0.0.1:<DSH 端口>/api/dsh-team-member-model`（Web 界面地址同端口，常见 19388）。
  远程 Host 换成那台 Host 的地址，并且**那台 Host 上也要装本插件**；旧版 DSH 缺连接 API 时接口返回
  `503 连接鉴权服务不可用，请升级 DSH`（这不是「插件没装」）。
- 界面/远程调用层走本插件自己的官方 RPC channel **`/dsh-team-member-model`** + endpoint
  **`team-member-model/<op>`**（`state`/`efforts`/`usage`/`teams`/`savePolicy`/`saveTeam`/`resetUsage`）。
  **不要用 `/api`**：官方 api-gateway 独占它的单槽 interceptor（0.7.6 的 405、0.7.7 的 404 都源于此，0.7.8 改用独立 channel）。
  它与下面的 HTTP 地址不是同一套路径；升级后要刷新页面重载 Client。
- 命令行 `curl` 要用 DSH 自己的凭据（浏览器会话 cookie 或 API token）。**不要把凭据贴进对话、脚本或日志**；
  能用界面就用界面——界面走当前 DSH 会话的连接通道，天然对准真正连着的那台 Host。

## 1. 接口清单

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/state` | 当前策略 `policy` + 模型目录 `catalog` + 决策记录 `trace`（最近 60 条）+ `rests`/`sink` |
| GET | `/efforts?provider=&model=` | 该模型**公布的推理档** `efforts[]` + `defaultEffort` |
| GET | `/usage` | 用量（只统计子 agent）：`members[]` / `rules[]` / `hours[]` / `totals` |
| PUT | `/policy` | 写入整份策略（body 即策略文档） |
| PUT | `/usage/reset` | 用量清零 |

## 2. 策略文档（v4：成员 = 固定名字 + 若干渠道绑定）

```jsonc
{
  "members": [                                  // 有序候选；第一项 = 没命中规则时的默认
    {
      "name": "glm-max",                        // 固定名字：规则/一键换/摘除都引用它
      "weight": 2,                              // 可选，weight 策略用
      "off": false,                             // 可选：整个成员停用
      "bindings": [                             // 渠道×模型，按顺序 = 渠道优先级
        { "provider": "zai-coding-cn", "model": "glm-5.3", "reasoningEffort": "max" },
        { "provider": "dsh-opencode-go", "model": "glm-5.3", "reasoningEffort": "max",
          "off": false,                          // 可选：只停用这个渠道
          "time": { "from": "09:00", "to": "12:00", "days": ["mon","tue"] } }  // 可选：该渠道在此窗口内停用
      ]
    },
    { "name": "cheap", "weight": 12, "bindings": [{ "provider": "dsh-opencode-go", "model": "deepseek-v4.1-flash" }] }
  ],
  "rules": [                                    // 按序匹配，**首条命中**决定首选成员
    { "use": "glm-max", "intent": "代码审查与质量把关" },
    { "use": "cheap", "continuable": false }
  ],
  "pick": null,                                 // 手动指定成员名；填了就跳过全部规则
  "off": [],                                    // 临时摘除的成员名
  "routing": "weight",                          // order | rotate | weight（成员之间）
  "allowFork": false,
  "failover": { "enabled": true, "patience": 2 },
  "classifier": { "enabled": true, "provider": "gemnin", "model": "gemini-3.8-flash" },
  "match": []
}
```

**两层身份**：
- **成员名**（逻辑级）：规则 `use`、`pick`、`off`、亲和、成员权重都按它；
- **绑定键 `provider/model[:effort]`**（渠道级）：`rest`/`sink`/用量归属按它。绑定内部用 `reasoningEffort` 字段（不是写在 model 里的 `:effort` 后缀）。

**兼容**：v3 的扁平成员（`{provider, model, reasoningEffort, weight}`）会被自动迁移成「名字 = `provider/model[:effort]`、内含一个绑定」的成员，所以**旧规则不用改**；规则 `use` 也可以直接写某个绑定键，会解析到包含它的成员。

### 规则条件（全部可选，多个条件之间是 AND）

| 字段 | 含义 |
| --- | --- |
| `use` | 命中后用哪个**成员名**（必填） |
| `label` | 创建请求的 `description` 通配，`*review*` 这种 |
| `intent` | 分类器判定的意图（需 `classifier.enabled` 且规则声明了意图） |
| `channel` | `spawn` 或 `fork` |
| `continuable` | `true` = 团队成员/后台子代理；`false` = 一次性子代理（常作兜底） |
| `member` | 团队成员名通配 |
| `folders` / `exceptFolders` | 父会话工作目录（`~/proj`、`D:\work` 与 `/mnt/d/work` 互认） |
| `tokens` | 父会话规模阈值 |
| `effort` | 父会话当前推理档 |
| `images` | 创建请求是否带图 |
| `time` | 任务级时段条件（规则层；渠道可用性时段是**绑定**的 `time`） |
| `pause` | **摘除** `use` 命名的成员（只配 `use` + 条件） |

## 3. 语义要点（改之前必须知道）

1. **命中顺序**：规则数组从前到后，第一条全条件成立的赢。所以「精确关键词规则」放前面、「意图规则」放中间、「兜底」（`continuable:false`）放**最后**。
2. **优先级**：调用方显式指定 `agentOptions` > 命中规则 > 亲和（仅 fork 通道）> `routing` 策略轮转。
3. **候选阶梯（v4 关键）**：目标成员的**全部绑定**按顺序在前 → 其余成员的绑定按策略顺序在后；
   运行期回退因此是「**先同模型换渠道，再换成员**」。`patience` 是最大切换次数。
   休息中（rest）/被 429 沉底（sink）的绑定整体排到候选末尾。
4. **运行期只对可重试失败回退**（408/429/5xx、超时/过载/网络）；400/401/403/404/413 这类请求本身的拒绝不回退。
5. **意图分类只在** `classifier.enabled` **且至少一条规则带 `intent` 时**才会调用（否则零开销）；结果按任务文本缓存；判不清 → 不命中 → 退回规则/默认。
6. **成员表为空 = 路由器关闭**，子 agent 完全继承 Lead 的模型。
7. 运行时校验：成员引用必须能在 `catalog` 里找到 provider；不注入会写一条 `trace`（`provider-unregistered` 等）。

## 4. 改配置的标准流程

```
1) GET /state            → 存下 policy（作为备份，别写回文件）
2) 在内存里改 policy     （只改要改的字段，其余原样带回）
3) PUT /policy           （header: x-dsh-team-member-model: 1）
4) GET /state            → 回读核对，确认 200 且字段符合预期
5) 告诉用户：刷新设置页可看到新配置；跑一个子任务后看 trace 的 reason / ruleIndex / intent 是否命中预期
```

**不要**：删掉最后那条 `continuable:false` 兜底规则（那会改变所有普通一次性子代理的默认行为）、
在 `members` 为空时写规则（规则会命中但没候选）、引用 `catalog` 里不存在的 provider。

## 5. 常用配方

**A. 某类任务换模型（推荐：用意图）**
先 `GET /state` 看现有 `intent` 词表（分类器只从已声明的意图里选），再改对应规则的 `use`；
要**新增**一类任务，加一条 `{ "use": "...", "intent": "新类别名" }`（名字用短词，不要带括号——分类器回半句也能匹配）。

**B. 同模型多渠道 → 合成一个成员**
`members` 里同一个模型出现在多个单绑定成员时，界面会给「合并」建议；也可以手工合并：建一个成员，
把各渠道放进 `bindings`（顺序 = 优先级），再把规则的 `use` 改成新成员名。合并后同模型跨渠道自动互相兜底。

**B2. 渠道高峰限速**
把时间窗写在**绑定的 `time`** 上（不是规则）：`{"from":"09:00","to":"12:00"}` 表示该渠道在这个时段停用，
路由自动落到同成员的其它渠道；规则层的时间窗表示「这类任务只在该时段走这个成员」，两者不同。

**C. 一个类别的活拆给两档模型**
拆成两条互斥意图，例如前端：`前端功能开发` → 强档、`前端样式微调` → 便宜档。

**D. 省钱**
删掉高消耗意图（保留判断类）、把贵成员的 `weight` 调低、或把 `pick` 指向便宜成员（手动指定会跳过全部规则）。

**E. 一键全换**
`pick: "provider/model"` → 所有子 agent 都跑它；置 `null` 恢复规则路由。

**F. 查为什么跑错模型**
`GET /state` 看 `trace[]`：`outcome=injected` 看 `reason`（rule/weight/affinity/explicit）与 `ruleIndex`；
`outcome=skipped` 看 `why`（如 `fork-disabled`、`provider-unregistered`）；`failover` 行看回退链。

**G. 看用量**
`GET /usage` 或让用户看「设置 → 模型路由 → 用量」：按成员横条、最近 24 小时、规则命中分布。

## 6. 边界

- 只统计/路由**子 agent**；Lead 的模型不在管辖内。
- `routing` 只影响「没被规则命中」的创建；被规则派走的流量不看权重。
- `fork` 通道默认不纳管；开 `allowFork` 前提醒用户：改了路由会丢父会话前缀的 KV cache 复用。
- 无成本估算：DSH 不提供模型单价，`usage` 只有 token 数。
- 远程只是「同一个 owner 的连接通路能到另一台 Host」，不是多用户隔离系统：能通过官方鉴权的连接就是 owner。
- 界面的读写走当前会话的官方连接通道（`connection.rpc`），不再用页面自己拼 `/api`；所以「页面能打开」不代表
  「写到了你以为的那台 Host」——远程场景请以目标 Host 上的状态/用量为准。
