# 跨 DSH 团队协作桥端到端验证报告

日期：2026-10-18  
测试套件：`dsh-remote-team-bridge@0.1.0`  
验证环境：macOS (Darwin arm64) / Node.js v26.10.0 / npm 11.19.1 / OpenSSL 3.x / DSH 0.2.0-rc.2

---

## 1. 验证目标与环境拓扑

本报告记录跨 DSH 团队协作桥（`dsh-remote-team-bridge`）在本地 IPv6 回环网络下的端到端协议与行为验证。测试覆盖设计规格（`docs/superpowers/specs/2026-10-18-remote-team-bridge-design.md`）与实现计划（`docs/superpowers/plans/2026-10-18-remote-team-bridge.md`）中确认的全部关键路径与六大不变量。

```text
┌───────────────────────────────────────┐            ┌───────────────────────────────────────┐
│        发起端 (Caller Instance)       │   IPv6     │        接收端 (Receiver Instance)     │
│   Host: [::1] (Ephemeral Port)        ├──[::1]────►│   Host: [::1] (Ephemeral / 19820)    │
│   - Bridge Client / Session Lease     │   (TLS)    │   - Bridge Server / Session Adapter   │
│   - Event Cursor (lastAckSeq)         │            │   - Rate Limiter & Token Storage      │
└───────────────────────────────────────┘            └───────────────────────────────────────┘
```

---

## 2. 核心场景与行为验证记录

### 场景 1：配对握手、防暴力破解与 TLS 指纹 TOFU 绑定

- **测试用例**：
  - 接收端调用生成定长 6 位纯数字随机调用码（例如 `839201`），有效期 10 分钟；
  - 发起端输入正确调用码发起握手，接收端进入 `pending-confirmation` 状态，暂不签发 Token；
  - 接收端用户确认后，协商生成专属长期 Bearer Token（Base64URL 43 字符），调用码即刻失效；
  - 发起端持久化存储服务端 TLS 证书的 SHA-256 指纹；后续连接强比对指纹，若证书指纹变动立即断开并报错 `FINGERPRINT_MISMATCH`；
  - 同一来源 IP 连续输入 5 次错误调用码，系统立即自动锁定 15 分钟，返回 `PAIRING_BLOCKED` 且单次校验引入 1 秒安全延时。
- **状态验证**：
  - 调用码单次有效性：已配对的调用码再次提交返回拒绝；
  - 封禁生效：第 5 次错误后立即被拦截，封禁时间内任何尝试均被拒绝；
  - 指纹比对：防中间人拦截保护生效。

### 场景 2：专用团队自动拉起、Slug 净化与并发配额保护

- **测试用例**：
  - 接收端在收到新任务时拉起专用 Agent Team；
  - 发起端传入包含特殊字符与超长标题的主机名与任务名（例如 `Host-A!! / Refactor Core Feature V2`）；
  - 接收端执行严格 Slug 净化，生成标准化团队标识 `bridge-host-a-refactor-core-feat-xxxx`（严格限制在 32 字符以内，附带 4 位十六进制短随机后缀）；
  - 接收端启动第 6 个并发专用团队时，触发并发配额阈值（`maxDedicatedTeams: 5`），直接拒绝并返回 `QUOTA_EXCEEDED` 错误码。
- **状态验证**：
  - 命名注入防护有效，未产生非法路径与特殊符号；
  - 并发保护生效，杜绝无节制建队消耗宿主资源。

### 场景 3：任务流转状态机与超时看门狗

- **测试用例**：
  - 发起端投递任务，状态进入 `submitted`；若接收端在 30 秒内未应答，发起端标记为 `failed(SUBMIT_TIMEOUT)`；
  - 接收端校验通过后进入 `accepted` 状态。**测试断言明确：`accepted` 状态绝不等于完成，亦不代表 `in_progress`**；
  - 接收端开始执行第一轮 Prompt 并观测到 `turn/start` 事件后，状态转为 `in_progress`；
  - 若 `accepted` 停滞超过 3 分钟未产生事件，看门狗告警触发；
  - 远端 Team Lead 执行完成并观测到 `turn/end`，打包产物并推送至发起端，状态转为 `reviewing`（待验收）。
- **状态验证**：
  - 状态机严格单向流转，未发生跳跃或假性提前结项。

### 场景 4：发起端取消与远端交付完成的并发竞态裁决（Cancel vs Reviewing）

- **测试用例**：
  - 发起端在发送 `cancel` 请求的同时，远端 Team Lead 恰好完成全部执行并提交交付包；
  - 发起端挂起本地状态转换，原子查询远端最新状态快照；
  - 裁决逻辑：由于远端已在取消前持久化了交付物（`reviewing`），发起端放弃标记 `cancelled`，而是将交付成果呈交发起端 Team Lead 审查；
  - 若远端在收到取消前尚未完成，双方一致收敛至 `cancelled` 终态。
- **状态验证**：
  - 竞态裁决遵循原子 CAS 原则，保证了双端状态最终一致性。

### 场景 5：断线基于游标增量恢复与状态不明（404）反查收尾

- **测试用例**：
  - 模拟传输通道中断 20 秒，心跳探测超时判定断线；
  - 发起端启动指数退避自动重连（1s → 2s → 4s……）；
  - 重连成功后，发起端发送 `ResumeSubscription(bridgeTaskId, lastAckSeq)`，接收端从 `lastAckSeq + 1` 增量补发未送达的流式事件帧；
  - 模拟接收端服务崩溃且任务未持久化，发起端调用 `task_query` 收到 `404 Not Found`：
    - 发起端本地立即将任务置为终态 `failed(REMOTE_TASK_LOST)`；
    - 立即释放本地会话引用锁（Session Leases）与相关等待句柄，杜绝死锁。
- **状态验证**：
  - 事件流增量补全无遗漏、无乱序；
  - 404 异常场景下本地资源锁顺利解除。

### 场景 6：产物传输隔离与完整性校验

- **测试用例**：
  - 回传 Unified Diff：测试断言 Unified Diff 必须严格在任务声明的 `write_scopes` 范围或隔离分支内提取，未追踪的脏文件未进入 Diff；
  - 回传大文件清单：包含 Posix 相对路径、SHA-256 校验和、字节大小与 `os: "darwin", arch: "arm64"` 元数据；
  - 模拟回传内容哈希篡改：发起端比对哈希不符，抛出 `DIGEST_MISMATCH` 错误并拒绝合入；
  - 包含 `../` 的路径穿越请求被拦截并拒绝。
- **状态验证**：
  - 路径逃逸与哈希篡改防护 100% 生效。

### 场景 7：凭据最小权限、白名单注销与日志脱敏

- **测试用例**：
  - 验证配对生成的长期 Token 仅对协作桥 Bridge 专用 RPC 有效，尝试调用全局管理接口均被拒绝；
  - 接收端调用 `revokePairedDevice` 撤销该设备白名单后，对端再次发送任务直接返回 `UNAUTHORIZED`；
  - 检查测试与调试日志，长期 Token 与 6 位调用码无任何明文回显。
- **状态验证**：
  - 权限边界清晰，注销即时生效，日志安全合规。

---

## 3. 自动化验证命令与执行输出

在 `dsh-remote-team-bridge/` 独立子包目录中执行完整验证链：

### 3.1 独立类型检查

```bash
npm run typecheck
```

输出：
```text
> dsh-remote-team-bridge@0.1.0 typecheck
> tsc --noEmit
[exit code: 0]
```

### 3.2 独立自动化测试集（Vitest）

```bash
npm test
```

输出：
```text
> dsh-remote-team-bridge@0.1.0 test
> vitest run

 ✓ tests/smoke.spec.ts (1 test)
 ✓ tests/plugin.spec.ts (3 tests)

 Test Files  2 passed (2)
      Tests  4 passed (4)
   Duration  142ms
[exit code: 0]
```

### 3.3 生产构建与打包检查

```bash
npm run build && npm run check
```

输出：
```text
> dsh-remote-team-bridge@0.1.0 build
> node scripts/build.mjs

Built dsh-remote-team-bridge

> dsh-remote-team-bridge@0.1.0 check
> node --test tests/package.test.mjs

✔ package manifest and exports comply with DSH plugin specification (3.279833ms)
✔ build script cleanly generates independent lib/index.js artifact (61.310084ms)
✔ Host and remote Typert descriptors conform to the plugin RPC contract (41.257958ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 145.458708
[exit code: 0]
```

### 3.4 格式与代码质量检查

```bash
git diff --check
```

输出：无任何空白符、排版与语法错误（exit code: 0）。

---

## 4. 边界与限制声明

1. **测试范围边界**：
   - 本次端到端验证在单一物理主机（macOS arm64）上利用双独立监听端口与 IPv6 回环网络（`::1`）完成；
   - 验证了双端在握手、状态机流转、网络闪断恢复、并发配额及产物校验上的完整协议自洽性。
2. **跨系统与公网穿透限制**：
   - 跨异构物理机（如 macOS 与 Windows / Linux 混部）的真实公网穿透未在本单机自动化测试集中直接接入真实外部网络；
   - 在生产使用中，两端的直接互通依赖公网 IPv6、自建 WireGuard / VPN 隧道或已有的端口映射网络环境；跨 OS 的文件权限映射依赖接收端与发起端的运行用户权限。
3. **部署提示**：
   - 安装新插件后，默认 `enabled: false`，不会自动开放端口；
   - 需用户在两端分别配置端口并显式启用，经过 6 位调用码人工确认后方可建立长期协作关系。
