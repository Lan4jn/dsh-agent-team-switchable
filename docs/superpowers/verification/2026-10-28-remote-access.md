# 0.7.6 远程模型设置（官方连接 RPC + 官方鉴权）验证

日期：2026-10-28。任务：87（独立验证与发布）。83 = HTTP 官方鉴权，85 = Host RPC，86 = Client 传输；本文件只记录独立验证。

## 一、结论

- Client 生产代码（真 `lib/client.js`）经官方 `connection.rpc.call('/api', 'dsh-team-member-model/<op>', payload)` 打到 Host
  真注册的 `rpc.intercept('/api', matches, handler(endpoint, payload, signal, peer))`，7 个端点在隔离 tmp `DSH_HOME` 上全部可用；
  页面 `fetch` 调用数为 **0**（沙箱里它被写成「一调用就抛错并计数」）。
- 写操作落到「当前连接的」那台 Host：remote 的 revision 前进、页面本机 Host 的 revision 仍为 0 且没有 `teams.json`；
  同一次 `apply` 内把 `ctx.connection` 换成另一台后，后续请求打到新 Host，旧 Host 不再收到写。
- HTTP 侧所有 API 在动作前调用官方 `connection.requestRejection({ headers })`，官方 verdict 原样透传（401/403）；
  缺连接鉴权服务时 7 条 HTTP 路径全部 503（fail-closed，没有「本机回环 fallback」）。
- 未发现需要作者返工的缺陷；85/86 的契约（payload 形状、`{status, body}` envelope、peer owner-only、无 root fetch fallback）一致。

## 二、契约核对（读源码，不靠猜）

- Host：`lib/index.js` 的 `RPC_ENDPOINTS` 只有 7 个名字；`normalizeRpcRequest` 逐端点做字段白名单 + 类型/长度/体积校验
  （`state`/`usage`/`resetUsage` 只接受 `{}`；`efforts{provider,model}`；`teams{sessionId}`；`savePolicy{policy}`；
  `saveTeam{sessionId,target,selection,revision}`，`target` 允许 `null`）。
- 业务不复制两套：RPC 与 HTTP 共用同一份 `executeApi`，因此团队 CAS（`stale-revision`）、角色/session 授权、
  Lead 保护、模型目录校验、策略归一化全部同源。
- peer：`handleRpc` 只接受 `peer.principal.kind === 'owner'`；认证失败用官方 outer error，业务错误仍放在
  `{ ok: true, value: { status, body } }`（外层 ok 只表达传输/认证）。
- 生命周期：`rpc.intercept` 返回的 async disposer 挂在 `ctx.effect` 上，dispose 时调用（85 用例覆盖）。
- Client：`module.exports.inject = ['slots', 'connection']`；`currentRpc()` 每次请求现读 `ctx.connection`（不缓存首个连接）；
  未知端点/无连接当场抛（0 次 RPC），业务失败抛带 `status`/`code`，传输失败 `NETWORK_ERROR`。
- 官方 SDK：`ctx.connection.requestRejection({headers}) → 401 | 403 | undefined`、`rpc.intercept(...) → Promise<disposer>`、
  handler 返回 `{ok:true,value}|{ok:false,error:{code,message,details}}` 均以 Host Inspect 的实时契约核对。
  `@deepseek-ai/dsh-client-connection` 真实存在（Config entry `include:connection`，包内 0.2.1-rc.2）。

## 三、新增集成测试（test/remote-integration.mjs，7 例，全绿）

1. 生产 Client → 真 Host 拦截器：`state`/`efforts`/`usage`/`teams`/`savePolicy`/`resetUsage` 走通，策略读写与 HTTP 同源，页面 fetch = 0。
2. 目标 Host 正确性：remote 写后 revision 前进；本机 Host revision 0 且无 `teams.json`；`ctx.connection` 切到 B 后新写落 B。
3. selection 语义：成员未选档位时 payload 不带 `reasoningEffort`（Host 视图也不凭空生成）；带 `high` 则有；
   成员 `selection: null` 清覆盖回继承；`target: null` 改未来默认并可恢复；Lead 作 target 回 400。
4. 业务错误不重试：陈旧 revision → 409 `stale-revision` 且 RPC 只发 1 次；队员 session 读团队 → 403；未知成员 → 404。
5. 官方 outer 拒绝：认证被否（`code: unauthorized`, `details.status: 401`）→ 客户端 `unknown=false`（写确定没发生）；
   传输 throw → `NETWORK_ERROR` 且写操作 `unknown=true`、读操作不标「已提交」；两条路径页面 fetch 仍为 0。
6. 未知端点 `UNKNOWN_ENDPOINT`（0 次 RPC）、缺 connection `NO_CONNECTION`；Host 的 `matches` 对 7 个端点全 true、`routes` 为 false。
7. HTTP 边界：verdict `undefined/401/403` → HTTP `200/401/403`（委托官方判定，headers 原样交给官方一次）；
   写操作标记头缺失仍 403；缺 `connection` 服务时 7 条 HTTP 路径全 503。

说明（RED 归属）：本文件首轮 2 例失败是**我的**调用顺序错误（`TeamController` 生产路径要先 `fetchView()` 拿 revision 再写；
清成员覆盖要用 `saveMember(id, null)` 而不是 `restoreInheritance()`），修正测试后即绿，不是产品缺陷。

## 四、全量一轮（真实输出）

- 7 个 `lib` 文件逐文件 `node --check`：**7/7 exit 0**。
- 9 个 `node:test` 文件一次：**TAP 91/91 pass, 0 fail, exit 0**（含新增 remote-integration 7、remote-rpc 11、remote-access 5、
  client-transport 14、package 6、team-client、team-host、team-integration、team-state）。
- 3 个 `check()` 脚本一次：`test/apply.mjs` 43 项、`test/client.mjs` 29 项、`test/smoke.mjs` 37 项，各 exit 0（合计 109 项）。
- 版本契约 RED→GREEN：先改 `test/package.mjs` 期望 0.7.6 + `dsh.client.inject` 含官方连接包 → 2 fail；
  改 `package.json`（version 0.7.6、inject 追加 `@deepseek-ai/dsh-client-connection`）→ **6/6 pass**。
- `files` 未变（12 项；85 的 guard 内联在 `lib/index.js`，没有新增 lib 模块），归档仍是 13 个文件（含 `package.json`）。

## 五、产物与包内核对

- `artifacts/remote-access-2026-10-28/dsh-team-member-model-0.7.6.tgz`
- 大小 **140730 字节**；SHA256 `47cd756ff3f9a87aa9b07173a5c51c8529a6f1a266f4e10822d426e7c8fa2d0e`。
- 解包 13 个文件，与冻结工作区逐一 `cmp`：**13/13 一致**（README、cordis.patch.yml、docs×2、lib×7、package.json、skills/SKILL.md）。
- 包内断言：`version=0.7.6`；`dsh.client.inject` 含 `@deepseek-ai/dsh-client-connection`；`files` 12 项；
  `source: 'team-member-model'` 存在；`saveTeam` 端点存在；客户端紧凑表单样式（容器查询 / 右对齐移除）标记仍在。
- 包内可加载性：解包目录里 `import('./lib/index.js')` 得到 `apply`/name；Client 走 `window.__ModuleLoader__` 真跑 factory，
  `inject=["slots","connection"]`、`apply({slots, connection})` 正常，`_request`/`_TeamController` 存在。
- 旧包未覆盖（哈希未变）：0.7.5 `e7b14a97…`、0.7.4 `481d551a…`、0.7.3 `95b97d60…`、0.7.2 `9bfb28fe…`、0.7.1 `f88bf6ac…`、0.7.0 两份。

## 六、历史缺口（2026-10-29 补记，不改上文结论）

0.7.6 上线后真实浏览器报 `transport failure for /api/dsh-team-member-model/teams: HTTP 405`。上文第三节的集成验证是
`_request`/`rpc.call` 直接桥到 Host 拦截器，**没有经过官方 HTTP 路由层**，因此漏掉了「RPC endpoint URL 与插件自己的
HTTP prefix 重叠、被最长 prefix 接走」这一层。0.7.7 已把 RPC namespace 改为 `team-member-model/<op>` 并补了真 socket
的 wire 测试；详见 `2026-10-29-rpc-405.md`。上文其余结论（payload/peer/CAS/无 root fetch fallback）仍然成立。

## 七、边界（不夸大）

- 认证是**官方委托点**：测试注入 `requestRejection`/peer 的 verdict，用来证明「插件把官方判定前置到所有 API 并原样透传」，
  不重写官方 Host/Origin/凭据算法，也没有使用任何真实 cookie、token 或用户配置。
- 未安装到 profile、未重启、未在真实浏览器点按；本轮不做 profile 部署（85 消息里的「安装验证」只是建议）。
- 未在真实公网 / SSH 远端链路端到端跑过；`trustedHosts`、凭据、反代前缀都由用户既有官方配置决定，本插件不改它们。
- 取消边界：Host 只在进入业务前返回 outer `code: 'aborted'`（明确未执行）；客户端将这一明确响应标为
  `cancelled=true`、`unknown=false`。普通传输 throw（包括尚不能确认服务端是否执行的断连）仍对写操作标 `unknown=true`，不将任意 AbortError 一律视为未执行。
- Lead 交付复核：归档 SHA256、140730 字节及 13/13 源文件一致性通过；`remote-access` 5 + `client-transport` 14 合计 **19/19 pass, exit 0**，含明确取消与网络结果未知的区分。
