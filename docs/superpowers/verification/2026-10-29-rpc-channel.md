# 0.7.8 独立 channel 与官方 Gateway 共存验证（真实 dsh 启动实例）

日期：2026-10-29。任务：92（独立验证 + 发布）。90 = 修复作者（Host/Client/测试），92 只做真框架验收与打包。

## 一、根因（0.7.7 仍 404，不是重名也不是鉴权）

- 官方 `@deepseek-ai/dsh-client-connection` Host 半侧：`interceptors` 是**单值 map**（asar `lib/index.js:700`），
  `rpc.intercept` → `registerInterceptor` 在已有 `/api` 时**直接抛**
  `connection: shared RPC channel "/api" already has an interceptor`（`:873-886`）。
- 官方 `@deepseek-ai/dsh-api-gateway` 在 `ctx.inject(['connection'])` 里先占这一槽（profile `lib/index.js:624`），
  `claimsEndpoint` 只认 typert 两段端点，不含我们的 `team-member-model/*`（`:698-705`）。
- 因此 0.7.7 的 `rpc.intercept('/api', …)` 必然抛错 → 被 `installRpc` 的 catch 吞成 warn → carrier 无归属 →
  `createSharedFetchHandler` 返回 `not found` 404（`:820-838`）。页面那句「Host 半侧可能未加载」只是客户端对 404 的附加文案。
- 0.7.6 的 405 掩盖了同一件事：当时请求先被本插件更长的 HTTP prefix 接走，RPC 注册其实从未成功。

## 二、验证方式：真实 dsh 启动实例（不是 shim）

- 用已装的 Electron CLI（`~/.local/bin/dsh` → `ELECTRON_RUN_AS_NODE` + `app.asar` 内 `dsh-desktop-host/lib/cli.js`），
  `DSH_HOME=/tmp/tmm92-*`（全新临时家）、`dsh rpctest --from-default-profile web` 建独立 profile、
  `--no-open --port 0`（随机 loopback 端口）。插件以 bundle + `node_modules` 符号链接接入（**没有 npm 安装**）。
- 该实例自带 Cordis 4.0.5 + `dsh-client-connection` 0.2.1-rc.2 + `dsh-host-webserver` 0.2.1-rc.2 + 官方 api-gateway +
  官方 webServer，全部来自 asar 真包；认证用**该实例自己打印的 launch token**（不读用户 cookie/key/log）。
- 依赖可 import 性（如实记录）：官方包只存在于 `app.asar`，node 无法 `import`；`app.asar.unpacked` 只有原生库，
  `runtime/primary-runtime/dependencies` 只有 node/pnpm/python，profile `node_modules` 只有插件副本 →
  所以走「真进程」而不是「import 真包」。90 另有本地 `~/.cache/dsh-tmm-lifecycle-sdk` 的真包单测作补充（3/3）。

## 三、RED（0.7.7 归档，同实例真进程）

- `GET /api/dsh-team-member-model/state` → **200**（插件已加载、HTTP 业务与官方鉴权均正常）。
- `POST /api/team-member-model/teams`（官方 envelope）→ **404 `not found`**，与用户现场一致。
- 同实例官方 gateway 端点 `POST /api/$events/result`、`/api/agentPresets/list`、`/api/session/list` → **200**
  server-response（业务层报 payload 形状错，但证明 `/api` 槽被 gateway 正常服务）⇒ 共存失败仅发生在我们的通道。

## 四、GREEN（0.7.8 源码，同实例真进程，重新启动）

- `POST /dsh-team-member-model/team-member-model/{state,usage,efforts,resetUsage}` → **200**，`result.ok:true`，
  `value.status/body` 与原 HTTP JSON 一致。
- `savePolicy` 写带标记的策略（`fixture-member` / `routing: weight`）→ RPC 读回一致，**旧 HTTP `GET /api/dsh-team-member-model/state`
  也读到同一份** ⇒ 真写 + 真读回，落盘在隔离 tmp DSH_HOME。
- 团队 fixture：用官方 gateway `POST /api/session/create`（`{args:{request:{cwd:…}}}`）建**空 session，无 prompt、无 LLM 调用**；
  再 `teams` 读 → `revision 0`；`saveTeam`（CAS rev 0）→ `revision 1`；重读 `revision 1`；用旧 rev 再写 → **409 `stale-revision`**。
- 共存：同实例 `/api/agentPresets/list` 等 gateway 端点仍 **200**；旧 `/api/team-member-model/teams` 仍 **404**（没有抢回 `/api`）；
  旧 HTTP 接口语义不变（`PUT /policy` 无标记头 → 403，带 `x-dsh-team-member-model: 1` → 200）。
- 生命周期：真实实例上做的是**重启级**证据（重新启动后通道自动注册、无重复注册报错）；connection 被禁时整个 Web 应用
  起不来（index 无响应/无 URL），故 fail-closed 503 分支在该组合下不可达——如实记录，不冒充运行期证据。
  「connection 晚到/替换/卸载」由 90 的 `test/rpc-lifecycle.mjs` 用真包单测覆盖（3/3，见第五节）。

## 五、测试与产物

- 11 个 `node:test` 文件一次：**TAP 96/96 pass，0 fail，exit 0**（含 `rpc-lifecycle` 3/3 真实 SDK 用例，非 skip）。
- 3 个 `check()` 脚本：`test/apply.mjs` 43、`test/client.mjs` 29、`test/smoke.mjs` 37（合计 109），各 exit 0。
- 7 个 `lib` 文件逐文件 `node --check`：**7/7 exit 0**。
- 版本契约 RED→GREEN：先改 `test/package.mjs` 期望 0.7.8（1 fail）→ 改 `package.json` → **6/6 pass**。
  `files` 仍 12 项（无新增生产模块）⇒ 归档 13 个文件。
- `artifacts/rpc-channel-2026-10-29/dsh-team-member-model-0.7.8.tgz`；**145605 字节**；
  SHA256 `6e3b8bb1949a4e8c1193c01936754275c0e6b926fcbbbcb337d4797b0f310dc6`。
- 解包 13 文件与冻结工作区 `cmp`：**13/13 一致**；包内 `version=0.7.8`、`dsh.client.inject` 仍含
  `@deepseek-ai/dsh-client-connection`、Host/Client 均为 `RPC_CHANNEL='/dsh-team-member-model'`；Host ESM import 与
  Client VM `apply` 均可加载。
- 旧包未覆盖：0.7.7 `f27ac87a…`、0.7.6 `47cd756f…`、0.7.5 `e7b14a97…`。

## 六、边界

- 只在本机隔离实例验证：**未**在真实 SSH/公网远端、未在用户的桌面 profile 上安装或重启（当前仍装 0.7.7）。
- 无 LLM 调用、无 prompt；只创建空 session 与团队 fixture；未读用户 cookie/token/log/trustedHosts。
- `rpc.handle` 在 0.2.1-rc.2 上对第三方 fiber 抛 `cannot get property "webServer" without inject`（90 实测），
  实际生效的是「插件自挂 `prefix:/dsh-team-member-model` + 官方 `connection.admit()`」这条 fallback；两条路径 HTTP 行为一致，
  本记录只声明**功能级**通过，不声明「纯 handle 主路径已在真机验证」。
- 源码注释 `lib/index.js` 顶部说「不使用 rpc.handle」与实际「handle 优先、失败回退」不一致（仅注释，不影响行为），
  已在完成说明里报给 Lead/90，属作者收尾范围。
