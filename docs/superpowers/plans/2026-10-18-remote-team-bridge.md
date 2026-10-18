# 跨 DSH 团队协作桥实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。持久 Agent Teams 分工协作，不使用临时子代理。

**目标：** 交付 `dsh-remote-team-bridge@0.1.0` 双端插件：接收端监听端口，发起端凭 6 位调用码配对，经域名或 IPv6 直连；按「专用团队（默认）／绑定已有团队」承接跨端任务，以状态机、序号游标和哈希清单完成交付，最终由发起端 Lead 判定验收。

**架构：** 独立新包，四层：协议层（信封、状态机、幂等键、错误码）纯函数；传输层（Node `https` + WebSocket 帧、自签证书与 TOFU 指纹、调用码限速）；主机适配层（包装公开 `sessionController` Remote 与 `agentTeams`，端点可注入以便测试）；Host 插件装配（Cordis Service、Typert RPC、Storage Domain、工具、监听生命周期）。发起端不伪造本地 Agent，远端任务标识与官方 `taskID` 解耦。

**技术栈：** Node ≥22、TypeScript、Cordis 4.0.4、DSH 0.2.0-rc.2 公共 SDK、Storage Domain、Vitest、esbuild、`node:crypto`／`node:https`／`node:net`。不新增第三方运行时依赖。

**设计规格：** [跨 DSH 团队协作桥设计规格](<../specs/2026-10-18-remote-team-bridge-design.md>)。

---

## 工作区与交接边界

新包位于共享工作区子目录 `dsh-remote-team-bridge/`，使用独立 `package.json`、`tsconfig.json`、`vitest.config.ts`，不改变现有 `dsh-agent-team-switchable` 包的依赖、入口或构建。基线 HEAD 为 `9fffad7`；现有工作树的未提交改动属于前几轮成果，本计划不重置、不 stash、不夹带。

所有执行员只修改自己任务列出的路径，不自行 `git add`／`commit`；Lead 在阶段结束后核查 diff 并隔离提交。

### 文件职责与所有者

| 路径 | 职责 | 所有者 |
|---|---|---|
| `dsh-remote-team-bridge/package.json`、`tsconfig.json`、`vitest.config.ts`、`scripts/build.mjs` | 独立包骨架与构建 | env-coder |
| `src/protocol/types.ts` | 信封、载荷、视图、错误码类型 | backend-coder |
| `src/protocol/codes.ts` | 6 位调用码生成与校验 | backend-coder |
| `src/protocol/state.ts` | 状态机、幂等键、超时判定 | backend-coder |
| `src/protocol/slug.ts` | 团队名 slug 与配额判定 | backend-coder |
| `src/transport/tls.ts` | 自签证书生成与 SHA-256 指纹 | backend-coder |
| `src/transport/frames.ts` | WebSocket 帧编解码与大小上限 | backend-coder |
| `src/transport/server.ts` | HTTPS/WS 监听、握手、限速封禁 | backend-coder |
| `src/transport/client.ts` | 客户端连接、指纹校验收、重连退避 | backend-coder |
| `src/host/session-adapter.ts` | 包装公开 `sessionController` 与 `agentTeams` | ui-coder |
| `src/host/artifact.ts` | 产物清单、SHA-256、路径与权限校验 | ui-coder |
| `src/bridge-service.ts` | 配对、任务、游标、验收的编排与持久化 | ui-coder |
| `src/index.ts` | Cordis 插件装配、监听生命周期 | env-coder |
| `src/remote.ts`、`src/typert*.ts` | 本插件自有 RPC 契约 | env-coder |
| `src/client/*` | 协作桥客户端面板 | ui-coder |
| `tests/**` | 与上表同责任人的测试 | 各所有者 |
| `dsh-remote-team-bridge/README.md` | 使用、配对、端口、故障排查 | env-coder |

### 跨任务不变量

1. 只使用规格确认的公开接口；不得调用不存在的远程 `inspect`。
2. `accepted` 不等于完成；只有发起端 Lead 可写 `completed`。
3. 状态不明先 `task_query`；不得盲目重发写操作。
4. 长期 Token 只授协作命名空间，不落日志，不打印调用码。
5. 任何跨端路径不得逃逸绑定工作区；产物回传必须校验 SHA-256。
6. 官方 `agentTeams` 仅在本 Host 内使用，不跨端共享官方 `taskID`。

---

## 任务 1：独立包骨架与构建（env-coder）

**文件：** 创建 `dsh-remote-team-bridge/package.json`、`tsconfig.json`、`vitest.config.ts`、`scripts/build.mjs`、`src/index.ts`（仅导出占位类型）、`tests/smoke.spec.ts`。

- [ ] **步骤 1：写入包清单。**

```json
{
  "name": "dsh-remote-team-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "node scripts/build.mjs",
    "check": "node --test tests/package.test.mjs"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.4",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-api-session-controller": "0.2.0-rc.2",
    "@deepseek-ai/dsh-experimental-agent-team": "0.2.0-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.2.0-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **步骤 2：写入最小测试并验证红灯。**

```ts
import { expect, it } from 'vitest'
import { PACKAGE_TAG } from '../src/index.ts'

it('exposes the package tag', () => {
  expect(PACKAGE_TAG).toBe('dsh-remote-team-bridge')
})
```

运行 `cd dsh-remote-team-bridge && npm install && npm test`。预期：FAIL，模块无导出。

- [ ] **步骤 3：写最小实现并跑到绿灯。**

```ts
export const PACKAGE_TAG = 'dsh-remote-team-bridge'
```

- [ ] **步骤 4：验证构建。**

运行 `npm run typecheck && npm test && npm run build`。预期：类型 0 错误、1/1 通过、生成 `lib/index.js`。

## 任务 2：协议类型与 6 位调用码（backend-coder）

**文件：** 创建 `src/protocol/types.ts`、`src/protocol/codes.ts`、`tests/protocol/codes.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

```ts
import { describe, expect, it } from 'vitest'
import { createPairingCode, verifyPairingCode } from '../../src/protocol/codes.ts'

describe('pairing code', () => {
  it('generates exactly six digits, including leading zeros', () => {
    const random = (size: number): Uint8Array => {
      expect(size).toBe(6)
      return Uint8Array.from([0, 0, 0, 0, 1, 5])
    }
    expect(createPairingCode(random)).toBe('000015')
  })

  it('rejects wrong text and wrong-length input in constant time', () => {
    const record = { code: '839201', expiresAt: 1_000, failures: 0, blockedUntil: 0 }
    expect(verifyPairingCode(record, '839201', 999).ok).toBe(true)
    expect(verifyPairingCode(record, '839202', 999).ok).toBe(false)
    expect(verifyPairingCode(record, '83920', 999).ok).toBe(false)
    expect(verifyPairingCode(record, '839201', 1_000).ok).toBe(false)
  })

  it('blocks after five consecutive failures for fifteen minutes', () => {
    const record = { code: '839201', expiresAt: 10_000, failures: 0, blockedUntil: 0 }
    for (let i = 0; i < 4; i += 1) expect(verifyPairingCode(record, '000000', 1).blockedUntil).toBe(0)
    const blocked = verifyPairingCode(record, '000000', 1)
    expect(blocked.blockedUntil).toBe(1 + 15 * 60_000)
    expect(verifyPairingCode(record, '839201', 2).ok).toBe(false)
  })
})
```

- [ ] **步骤 2：运行验证红灯。**

`npm test -- tests/protocol/codes.spec.ts` → FAIL，`createPairingCode` 未定义。

- [ ] **步骤 3：实现协议类型。**

```ts
export type BridgeTaskStatus =
  | 'submitted' | 'accepted' | 'in_progress' | 'reviewing'
  | 'completed' | 'failed' | 'cancelled'

export interface BridgeTaskView {
  readonly bridgeTaskId: string
  readonly status: BridgeTaskStatus
  readonly remoteLeadSessionId?: string
  readonly lastAckSeq: number
  readonly updatedAt: number
  readonly errorCode?: BridgeErrorCode
}

export type BridgeErrorCode =
  | 'SUBMIT_TIMEOUT' | 'REMOTE_TASK_LOST' | 'QUOTA_EXCEEDED'
  | 'UNAUTHORIZED' | 'PAIRING_BLOCKED' | 'TARGET_UNAVAILABLE'
```

- [ ] **步骤 4：实现调用码。**

```ts
export interface PairingCodeRecord {
  code: string
  expiresAt: number
  failures: number
  blockedUntil: number
}

export interface PairingVerdict {
  ok: boolean
  blockedUntil: number
}

export type CodeRandom = (size: number) => Uint8Array

export function createPairingCode(random: CodeRandom): string {
  return Array.from(random(6), value => String(value % 10)).join('')
}

export function verifyPairingCode(
  record: PairingCodeRecord,
  input: string,
  now: number,
): PairingVerdict {
  if (record.blockedUntil > now) return { ok: false, blockedUntil: record.blockedUntil }
  const expected = Buffer.from(record.code, 'utf8')
  const actual = Buffer.from(input, 'utf8')
  const same = expected.length === actual.length && timingSafeEqual(expected, actual)
  if (same && now < record.expiresAt) {
    record.failures = 0
    return { ok: true, blockedUntil: 0 }
  }
  record.failures += 1
  record.blockedUntil = record.failures >= 5 ? now + 15 * 60_000 : 0
  return { ok: false, blockedUntil: record.blockedUntil }
}
```

`timingSafeEqual` 从 `node:crypto` 引入。长度不同时仍执行一次等长比较，避免长度侧信道。

- [ ] **步骤 5：验证绿灯并提交。**

`npm test -- tests/protocol/codes.spec.ts` → 3/3 通过。

## 任务 3：状态机、幂等键与超时（backend-coder）

**文件：** 创建 `src/protocol/state.ts`、`tests/protocol/state.spec.ts`。

- [ ] **步骤 1：先写失败测试，覆盖规格的六条关键规则。**

```ts
import { expect, it } from 'vitest'
import { canTransition, cancellationVerdict, submissionVerdict, acceptedWatchdog } from '../../src/protocol/state.ts'

it('never treats accepted as finished', () => {
  expect(canTransition('accepted', 'completed')).toBe(false)
  expect(canTransition('reviewing', 'completed')).toBe(true)
})

it('times out a submission after thirty seconds', () => {
  expect(submissionVerdict('submitted', 0, 30_000)).toMatchObject({ expired: false })
  expect(submissionVerdict('submitted', 0, 30_001)).toMatchObject({ expired: true, errorCode: 'SUBMIT_TIMEOUT' })
})

it('flags an accepted task with no progress after three minutes', () => {
  expect(acceptedWatchdog('accepted', 1_000, 181_000).stalled).toBe(true)
  expect(acceptedWatchdog('in_progress', 1_000, 181_000).stalled).toBe(false)
})

it('lets a remote delivery win a cancel race', () => {
  expect(cancellationVerdict('reviewing')).toEqual({ action: 'defer-to-remote' })
  expect(cancellationVerdict('in_progress')).toEqual({ action: 'request-cancel' })
  expect(cancellationVerdict('completed')).toEqual({ action: 'ignore' })
})

it('treats a missing remote task as a released failure', () => {
  expect(remoteQueryVerdict(null)).toEqual({ status: 'failed', errorCode: 'REMOTE_TASK_LOST', release: true })
})
```

- [ ] **步骤 2：运行验证红灯。**

`npm test -- tests/protocol/state.spec.ts` → FAIL，导出缺失。

- [ ] **步骤 3：实现。**

```ts
import type { BridgeErrorCode, BridgeTaskStatus } from './types.ts'

const ALLOWED: Readonly<Record<BridgeTaskStatus, readonly BridgeTaskStatus[]>> = {
  submitted: ['accepted', 'failed', 'cancelled'],
  accepted: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['reviewing', 'failed', 'cancelled'],
  reviewing: ['completed', 'in_progress', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: BridgeTaskStatus, to: BridgeTaskStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function submissionVerdict(status: BridgeTaskStatus, createdAt: number, now: number) {
  return status === 'submitted' && now - createdAt > 30_000
    ? { expired: true, errorCode: 'SUBMIT_TIMEOUT' as BridgeErrorCode }
    : { expired: false }
}

export function acceptedWatchdog(status: BridgeTaskStatus, updatedAt: number, now: number) {
  return { stalled: status === 'accepted' && now - updatedAt > 180_000 }
}

export function cancellationVerdict(status: BridgeTaskStatus):
  { action: 'defer-to-remote' | 'request-cancel' | 'ignore' } {
  if (status === 'reviewing') return { action: 'defer-to-remote' }
  if (status === 'in_progress' || status === 'accepted' || status === 'submitted') return { action: 'request-cancel' }
  return { action: 'ignore' }
}

export function remoteQueryVerdict(view: { status: BridgeTaskStatus } | null) {
  return view === null
    ? { status: 'failed' as BridgeTaskStatus, errorCode: 'REMOTE_TASK_LOST' as BridgeErrorCode, release: true }
    : { status: view.status, release: false }
}

export function idempotencyKey(bridgeTaskId: string, attempt: number): string {
  return `${bridgeTaskId}:${attempt}`
}
```

补充一条断言：同 `bridgeTaskId` 与同 `attempt` 的键必须相等，不同 `attempt` 必须不同。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/protocol/state.spec.ts` → 6/6 通过，`npm run typecheck` 0 错误。

## 任务 4：团队 slug、配额与路径校验（backend-coder）

**文件：** 创建 `src/protocol/slug.ts`、`tests/protocol/slug.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

```ts
import { describe, expect, it } from 'vitest'
import { bridgeTeamName, withinQuota, isSafeRelativePath } from '../../src/protocol/slug.ts'

describe('team naming and paths', () => {
  it('sanitizes hostile input and adds a random suffix', () => {
    const name = bridgeTeamName('../../Host A', 'task/../x', () => [0x7f, 0x2a])
    expect(name).toBe('bridge-host-a-task-x-7f2a')
    expect(name.length).toBeLessThanOrEqual(32)
  })

  it('rejects a sixth concurrent bridge team', () => {
    expect(withinQuota(4, 5)).toBe(true)
    expect(withinQuota(5, 5)).toBe(false)
  })

  it('rejects escaping artifact paths', () => {
    expect(isSafeRelativePath('dist/app.exe')).toBe(true)
    expect(isSafeRelativePath('../secret')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\Windows\\x')).toBe(false)
  })
})
```

- [ ] **步骤 2：运行验证红灯。**

`npm test -- tests/protocol/slug.spec.ts` → FAIL。

- [ ] **步骤 3：实现。**

```ts
function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function bridgeTeamName(host: string, task: string, random: (size: number) => Uint8Array): string {
  const suffix = Buffer.from(random(2)).toString('hex')
  const body = `bridge-${slugPart(host)}-${slugPart(task)}`.slice(0, 32 - 1 - suffix.length)
  return `${body.replace(/-+$/g, '')}-${suffix}`
}

export function withinQuota(active: number, limit: number): boolean {
  return active < limit
}

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.every(part => part !== '..' && part !== '.' && part.length > 0)
}
```

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/protocol/slug.spec.ts` → 3/3 通过。

## 任务 5：TLS 自签证书与指纹（backend-coder）

**文件：** 创建 `src/transport/tls.ts`、`tests/transport/tls.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

```ts
import { expect, it } from 'vitest'
import { createSelfSignedIdentity, fingerprintOf } from '../../src/transport/tls.ts'

it('creates a certificate whose pinned fingerprint verifies', async () => {
  const identity = await createSelfSignedIdentity('bridge.local')
  expect(identity.cert).toContain('BEGIN CERTIFICATE')
  expect(identity.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(fingerprintOf(identity.cert)).toBe(identity.fingerprintSha256)
})
```

- [ ] **步骤 2：运行验证红灯。**

`npm test -- tests/transport/tls.spec.ts` → FAIL。

- [ ] **步骤 3：实现生成与指纹。**

用 `node:child_process` 调用本机 `openssl`（macOS/Linux/Windows 均随 DSH 研发环境提供）生成 RSA-2048 自签证书（SAN 为传入域名或 IPv6），有效期 3650 天；证书与私钥落在 `~/.dsh/storages/remote_team_bridge/tls/`，文件权限 `0o600`，不打印私钥。指纹取证书 DER 的 SHA-256：

```ts
export function fingerprintOf(pemCertificate: string): string {
  const der = Buffer.from(
    pemCertificate.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64',
  )
  return createHash('sha256').update(der).digest('hex')
}
```

若 `openssl` 不可用，返回 `certificate-unavailable` 错误，管理界面提示安装或手工放入证书；不降级为明文连接。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/transport/tls.spec.ts` → 1/1 通过，并断言私钥文件权限为 `0o600`。

## 任务 6：帧编解码与大小上限（backend-coder）

**文件：** 创建 `src/transport/frames.ts`、`tests/transport/frames.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

```ts
import { expect, it } from 'vitest'
import { encodeFrame, decodeFrame, FrameError, MAX_FRAME_BYTES } from '../../src/transport/frames.ts'

it('round-trips one envelope', () => {
  const frame = encodeFrame({ kind: 'ping', seq: 7, body: { at: 1 } })
  expect(decodeFrame(frame)).toEqual({ kind: 'ping', seq: 7, body: { at: 1 } })
})

it('rejects oversized and malformed frames', () => {
  expect(() => decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow(FrameError)
  expect(() => decodeFrame(Buffer.from([0, 0, 0, 0, 1]))).toThrow(FrameError)
})
```

- [ ] **步骤 2：运行验证红灯，步骤 3 实现。**

帧格式为 4 字节大端长度前缀加 JSON UTF-8 载荷，`MAX_FRAME_BYTES` 为 4 MiB；解码先校验长度、再校验 JSON 与 `kind`／`seq` 类型，任何不合法抛 `FrameError`（携带稳定 `code`）。二进制大文件不进 JSON 帧，走清单与分块下载。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/transport/frames.spec.ts` → 2/2 通过。

## 任务 7：接收端监听与握手限速（backend-coder）

**文件：** 创建 `src/transport/server.ts`、`tests/transport/server.spec.ts`。

- [ ] **步骤 1：先写失败测试，用随机端口与临时自签证书。**

测试必须覆盖：正确调用码进入 `pending-confirmation` 且不签发 Token；错误调用码返回 `unauthorized` 且不泄露正确码；第五次失败后同一来源返回 `pairing-blocked`；确认后输出长期 Token 且调用码立刻失效；同一 Token 可重复认证；撤销 Token 后返回 `unauthorized`。

```ts
it('holds the first handshake until the receiver confirms', async () => {
  const server = await startBridgeServer({ port: 0, pairing: '839201', clock: () => 1 })
  const first = await bridgeRequest(server.url, { op: 'pair', code: '839201', hostId: 'host-a' })
  expect(first.body).toEqual({ state: 'pending-confirmation', hostId: 'host-a' })
  const accepted = await server.confirmPairing(first.body.requestId, true)
  expect(accepted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
})
```

- [ ] **步骤 2：运行验证红灯，步骤 3 实现。**

`https.createServer` 加载自签证书；`upgrade` 事件完成握手指令，非协作路径一律 404。监听默认 `::`（IPv6 双栈，`ipv6Only: false`），端口来自配置。每次配对尝试串行化并固定 1 秒延迟。Token 用 `randomBytes(32).toString('base64url')`，服务端只存其 SHA-256。所有响应只回稳定错误码，不回内部异常文本。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/transport/server.spec.ts` → 全部通过，且测试结束后端口关闭、无句柄泄漏（`server.close()` 与 `unref`）。

## 任务 8：发起端连接、指纹校验与重连（backend-coder）

**文件：** 创建 `src/transport/client.ts`、`tests/transport/client.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

必须覆盖：首次连接记录指纹并在第二次连接时拒绝指纹变化；`submitted` 30 秒无应答返回 `SUBMIT_TIMEOUT`；断线后按 `1s → 2s → 4s` 退避且不超过 30 秒；重连成功后发送 `seq: lastAckSeq + 1`；查询到 404 时返回 `REMOTE_TASK_LOST` 并释放资源。

```ts
it('refuses a changed certificate fingerprint', async () => {
  const client = createBridgeClient({ baseUrl: 'https://127.0.0.1:1', pinnedFingerprint: 'a'.repeat(64) })
  await expect(client.connect(fakeTls({ fingerprint: 'b'.repeat(64) }))).rejects.toMatchObject({ code: 'FINGERPRINT_MISMATCH' })
})
```

- [ ] **步骤 2：运行验证红灯，步骤 3 实现。**

客户端使用 `https.request`＋`rejectUnauthorized: true` 配合 `ca` 固定证书，再比对对端证书 DER 的 SHA-256，不一致立即断开。退避函数为纯函数 `backoffDelay(attempt)`，上限 30 秒，测试直接断言序列。取消用 `AbortSignal`，取消后不再重试写操作。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/transport/client.spec.ts` → 全部通过。

## 任务 9：会话与团队适配层（ui-coder）

**文件：** 创建 `src/host/session-adapter.ts`、`tests/host/session-adapter.spec.ts`。

- [ ] **步骤 1：先写失败测试，以权威公开签名为准。**

类型必须直接引用安装的 SDK 声明，不自造形状：

```ts
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

export interface BridgeHostApi {
  createSession(input: { cwd: string; preset?: string }): Promise<{ sessionId: string }>
  prompt(sessionId: string, content: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }>
  cancel(sessionId: string): Promise<{ cancelled: boolean }>
  follow(sessionId: string, afterSeq: number): AsyncIterable<{ seq: number; type: string; data: unknown }>
  page(sessionId: string, afterSeq: number): Promise<Array<{ seq: number; type: string; data: unknown }>>
  listTeams(): Promise<Array<{ leadSessionId: string; name: string }>>
}
```

测试断言：`prompt` 的 `accepted` 不被映射为 `in_progress`；只有观察到 `turn/start` 才进入 `in_progress`；只有观察到 `turn/end` 才进入 `reviewing`；`cancel` 不影响 `reviewing`。

README 中写明：本层必须跟随实际 SDK 声明；若签名不符，以安装的 `.d.ts` 为准并在此处适配，不改官方包。

- [ ] **步骤 2：运行验证红灯，步骤 3 实现薄适配。**

适配层只做参数转换与错误归并，不缓存会话状态，不重试写操作。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/host/session-adapter.spec.ts` → 全部通过；`npm run typecheck` 0 错误。

## 任务 10：产物清单与校验（ui-coder）

**文件：** 创建 `src/host/artifact.ts`、`tests/host/artifact.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

```ts
it('rejects an artifact whose bytes do not match its digest', async () => {
  const listing = await collectArtifacts({ root, paths: ['dist/app.bin'], platform: { os: 'linux', arch: 'arm64' } })
  expect(listing.files[0]).toMatchObject({ path: 'dist/app.bin', os: 'linux', arch: 'arm64' })
  await expect(verifyArtifacts(root, [{ ...listing.files[0], sha256: '0'.repeat(64) }])).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
})
```

同时断言：`../x` 与绝对路径被拒绝；大于配额的文件不进入清单；diff 只能基于 `write_scopes` 生成。

- [ ] **步骤 2：运行验证红灯，步骤 3 实现。**

用 `createHash('sha256')` 流式计算；`lstat` 拒绝符号链接；可执行位写入清单；写入前 `mkdir -p` 并二次校验路径仍在根内。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/host/artifact.spec.ts` → 全部通过。

## 任务 11：桥服务编排与持久化（ui-coder）

**文件：** 创建 `src/bridge-service.ts`、`tests/host/bridge-service.spec.ts`。

- [ ] **步骤 1：先写失败测试。**

覆盖规格状态机全部路径：提交超时；`accepted` 停滞看门狗；`reviewing` 必须由发起端 `accept` 才能 `completed`；`reject` 回到 `in_progress`；`cancel` 与 `reviewing` 竞态走 `defer-to-remote`；远端 404 收敛为 `failed(REMOTE_TASK_LOST)` 并释放会话引用；第六个专用团队返回 `QUOTA_EXCEEDED`；绑定已有团队复用同一个 `remoteLeadSessionId`。

- [ ] **步骤 2：运行验证红灯，步骤 3 实现。**

状态写入 Storage Domain 新单元 `remote_team_bridge` v1；每次状态变更递增 `revision`，拒绝回退。`accept`／`reject` 只允许发起端 Lead 触发。所有副作用前先落盘意图，再执行；失败保留 `failed` 与错误码。

- [ ] **步骤 4：验证绿灯。**

`npm test -- tests/host/bridge-service.spec.ts` → 全部通过。

## 任务 12：插件装配与自有 RPC（env-coder）

**文件：** 创建 `src/index.ts`、`src/remote.ts`、`src/typert.host.ts`、`src/typert.remote-client.ts`、`tests/plugin.spec.ts`、`tests/package.test.mjs`。

- [ ] **步骤 1：先写失败测试。**

断言：可选依赖缺失时插件不抛错、不注册；监听只在配置 `enabled: true` 时开启；卸载插件关闭监听并释放 Storage；自有 RPC 命名空间为 `remote-team-bridge`，不占用官方命名空间。

- [ ] **步骤 2：运行验证红灯，步骤 3 实现装配。**

```ts
export const name = 'remote-team-bridge'

export function apply(ctx: Context, config: BridgeConfig = {}): void {
  ctx.inject(['sessionController', 'storageDomain', 'agentTeams'], scoped => {
    scoped.effect(() => startBridge(scoped, config), 'remote-team-bridge:lifecycle')
  })
}
```

`Config` 默认 `enabled: false`、`port: 19820`、`host: '::'`、`maxDedicatedTeams: 5`。默认关闭，避免安装即开放监听。

- [ ] **步骤 4：验证绿灯。**

`npm run typecheck && npm test && npm run build && npm run check` 全部通过。

## 任务 13：客户端协作面板（ui-coder）

**文件：** 创建 `src/client/index.ts`、`src/client/BridgePanel.tsx`、`src/client/BridgePanel.module.css`、`tests/client/bridge-panel.spec.tsx`。

- [ ] **步骤 1：先探查插槽。**

用 `cordis_inspect_list` 与 `Slots.listSubTree` 确认标题栏动作插槽与公开主题变量后再写；不得猜测插槽名或令牌。

- [ ] **步骤 2：先写失败测试。**

覆盖：显示监听状态与端口；生成调用码后 10 分钟倒计时，到期自动隐藏；待确认请求提供「接受并记住／拒绝」；已配对设备可撤销；任务列表显示状态、验收按钮只对 Lead 可用。

- [ ] **步骤 3：运行验证红灯，步骤 4 实现。**

采用非模态锚定面板与已确认主题令牌；失败就地显示错误码与重试；不使用官方团队菜单内部私有 DOM。

- [ ] **步骤 5：验证绿灯。**

`npm test -- tests/client/bridge-panel.spec.tsx` 通过并 `npm run typecheck` 0 错误。

## 任务 14：文档与端到端验收（env-coder）

**文件：** 创建 `dsh-remote-team-bridge/README.md`、`docs/superpowers/verification/2026-10-18-remote-team-bridge.md`。

- [ ] **步骤 1：写操作文档。**

内容包含：启用方式与风险提示（默认关闭监听）、端口与 IPv6 配置、调用码配对步骤、已配对设备撤销、两种团队接入、错误码表、断线与恢复行为、已知限制（需占用 `openssl`、需两端同版本协议）。

- [ ] **步骤 2：执行本机双实例验收。**

在两个不同端口启动两个实例，用回环 IPv6 `::1` 完成：配对、自动重连、提交任务、超时、404 收尾、配额拒绝、撤销后拒绝。记录真实命令与输出，写进验证文档。

- [ ] **步骤 3：验证并能诚实报告边界。**

`npm ci && npm run typecheck && npm test && npm run build && npm run check && git diff --check` 全部通过。跨操作系统矩阵与真实公网穿透未在本计划验证，文档必须如实标注。

## 任务 15：独立审查与打包（reviewer，Lead 打包）

- [ ] **步骤 1：独立审查。**

核对不变量六条、规格 9.3 验收清单逐项、错误码与状态机一致性、凭据不落日志、路径不逃逸、Diff 范围、README 与实现一致。发现缺陷交回原所有者修复并补红灯，不跨范围改写。

- [ ] **步骤 2：独立串行全链。**

```bash
cd dsh-remote-team-bridge && npm test && npm run typecheck && npm run build && npm run check && git diff --check
```

- [ ] **步骤 3：Lead 打包。**

Lead 在全部任务完成、reviewer 全链通过后执行，产物写入独立目录，不覆盖既有安装包：

```bash
cd dsh-remote-team-bridge && npm pack --pack-destination ../artifacts/remote-team-bridge
shasum -a 256 ../artifacts/remote-team-bridge/dsh-remote-team-bridge-0.1.0.tgz
```

打包后校验归档内 `lib/index.js`、`src/protocol/state.ts`、`package.json` 与工作区最终验证版本一致（逐字节比较），再报告哈希。

- [ ] **步骤 4：如实报告部署状态。**

新包默认 `enabled: false`，安装后不会自动开放端口。需要用户在两端分别安装、设置监听与配对；当前运行中的 profile 不在此阶段替换。本机双实例验证不等于真实跨主机、跨 OS 验证，报告必须区分。
