# 一键统一当前队员模型 实现计划

> **状态：** 代码已冻结（task-44 修复后）。作者自测 GREEN **145/145**（24 条新增，基线 121）。最终全链 `test/typecheck/build/check` 与 `npm pack` 由 **task-43** 执行，**尚未完成**，本文不预先声称通过。

**目标：** 菜单顶部加独立草稿 + 显式按钮，把选定模型逐条应用到点击时可见的全部非 Lead 队员；Lead 与未来 default 不变，结果逐人可见。

**架构：** 复用既有 Host RPC `selectMemberModel`（身份/生命周期校验 + 下一轮生效），客户端加顺序协调器（纯函数）、不自动保存的 picker、以及**整段只获取一次**的同步闸门。无 Host 新 API、无事务、不改官方代码。

**规格（含契约证据）：** `docs/superpowers/specs/2026-10-19-bulk-member-model-design.md`

**技术栈：** TypeScript、React 18、`@deepseek-ai/dsh-client-store`、vitest + @testing-library/react（jsdom）。

---

## 文件结构（实际）

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `src/client/bulk-apply.ts` | 新增 | 纯逻辑：冻结点击时可见集、逐项顺序提交、结构化拒绝/传输异常分类、卸载停机。 |
| `src/client/BulkModelPicker.tsx` | 新增 | 受控草稿（model + effort），`onChange` 只回调，不发 RPC；初始为空；目录下架时整份清空 + `bulk.reselect`。 |
| `src/client/TeamModelDialog.tsx` | 改 | `beginBulk/endBulk/busy` 共享闸门；`draftValid()`；批量区与结果渲染；关闭拦截改用 `busy()`；两个编辑器 `isLocked` 加闸门。 |
| `src/client/settings-controller.ts` | 改 | 新增 `TeamSettingsRejectedError`：`!response.ok` 与传输异常分流（`failed` vs `unknown`）。 |
| `src/client/TeamModelSettings.module.css` | 改 | `.bulkSection/.bulkHint/.bulkPicker/.bulkApply/.bulkResults`。 |
| `src/client/locales.ts` | 改 | `bulk.*` 文案（zh 为键源，en 齐全），含 `bulk.reselect` / `bulk.incomplete`。 |
| `tests/client/bulk-apply.spec.ts` | 新增 | 纯逻辑 9 条。 |
| `tests/client/team-model-bulk.spec.tsx` | 新增 | 菜单集成 15 条。 |
| `README.md` | 改 | 批量入口、生效边界、结果语义。 |

新增用例合计 **24**（9 + 15）；仓库全量 **145**（旧 143 为 task-44 修复前）。

**命令（本机可用；本次未执行，归 task-43）：**

```bash
node node_modules/vitest/vitest.mjs run tests/client/bulk-apply.spec.ts
node node_modules/vitest/vitest.mjs run tests/client/team-model-bulk.spec.tsx
node node_modules/vitest/vitest.mjs run tests/client
node node_modules/typescript/bin/tsc --noEmit
```

---

## 实际对外契约（`src/client/bulk-apply.ts`）

```ts
export interface BulkTarget { readonly id: SessionId; readonly name: string; readonly phase: TeamMemberModelView['phase'] }
export type BulkStatus = 'saved' | 'failed' | 'skipped' | 'unknown'
export type BulkSkipReason = 'phase' | 'changed'        // 无 'unchanged'：相同 route 也照写一次
export interface BulkOutcome { readonly id: SessionId; readonly name: string; readonly status: BulkStatus; readonly reason?: BulkSkipReason }

export function frozenTargets(view: TeamModelSettingsView): readonly BulkTarget[]   // view.members 全量，按 id 去重，不预过滤

export interface BulkApplyInput {
  readonly targets: readonly BulkTarget[]
  readonly selection: TeamModelSelection
  readonly activeNames: readonly string[]              // 点击时冻结的官方投影名字
  readonly getView: () => TeamModelSettingsView | null
  readonly save: (name: string, selection: TeamModelSelection) => Promise<void>
  readonly reload: () => Promise<void>
  readonly alive: () => boolean
  readonly report: (outcomes: readonly BulkOutcome[]) => void
}
export async function applyToMembers(input: BulkApplyInput): Promise<readonly BulkOutcome[]>
```

（模块已不再导出 `sameSelection`：客户端不再用它预判“已一致”。）

**逐项规则（与实现一致）：** 循环顶部 `!alive()` → 停止剩余；先按 `id+name` 取 fresh view 行；`target.phase !== 'active'` → `skipped/phase`；行缺失、`row.phase !== 'active'` 或 `target.name` 不在冻结 `activeNames` → `skipped/changed`；**其余一律 `save(target.name, selection)` 写一次 → `saved`**（已解析相同也写）。

**抛错分类：** `error instanceof TeamSettingsRejectedError` → `failed`（Host 结构化 `ok:false`，存储未变）；其余（传输异常/响应丢失）→ `unknown`，只做一次尽力 `reload()` 刷新展示，**不用读回否定写入、不升格为 `saved`**。每条追加后 `report([...outcomes])`，仅在 `alive()` 时上报。

---

## task-44 修复实况（修复范围 + 作者 RED→GREEN 报告）

**本文件作者未运行任何测试**（只读核对源码与用例名）；以下是 task-44 的修复范围与作者报告，机制细节以 `src/client/bulk-apply.ts`、`BulkModelPicker.tsx`、`TeamModelDialog.tsx` 现值为准。

1. **修复范围（可从代码 diff 观察）**：删除 `sameSelection` 预判与 `'unchanged'` skip 分支及 `bulk.skip.unchanged` 文案/类型 → 改为除 `phase`/`changed` 外**每个合格队员显式写一次**；picker 增 `routeRetired/effortRetired` 侦测，下架时清空 `route`+`effort`、`onChange(null)`、显示 `bulk.reselect`；`draftValid()` 在提交前按当前目录复核 provider/model/effort；`bulkGate` 由 `applyBulk` 的 `try/finally` 覆盖整个 `applyToMembers`（含未确认读回段）。
2. **作者报告的 RED**：修复前这 4 条新用例失败（`writes every eligible member even when the resolved route already equals the target`、集成 `writes a teammate whose resolved route already equals the target`、`clears a draft whose effort was retired and asks for a new choice`、`stays locked while a lost response is being re-read`）。
3. **作者报告的 GREEN**：`npm test` **145/145**（24 新增 / 基线 121）。**独立全链与打包结论以 task-43 为准**，本文不预先声明通过。

---

## 回归清单（用例名逐条核对自实际测试文件）

**`tests/client/bulk-apply.spec.ts`（9 条）**

- [x] `freezes every visible teammate including provisioning and failed ones, deduped by id`
- [x] `saves each active member in order and reports non-active members as skipped`
- [x] `never sends a write for a teammate whose stable id was replaced under the same name`
- [x] `writes every eligible member even when the resolved route already equals the target`
- [x] `records a structured rejection as failed and keeps applying the rest`
- [x] `treats a lost response as unknown, refreshes, and never claims the write`
- [x] `keeps an unreadable read-back unknown instead of claiming nothing was written`
- [x] `stops sending remaining members after unmount and keeps finished results`
- [x] `skips a name no longer active in the frozen official projection`

**`tests/client/team-model-bulk.spec.tsx`（15 条）**

- [x] `starts empty, never sends an RPC from draft changes, and clears effort on a model change`
- [x] `applies one click to each active teammate in order and leaves the default untouched`
- [x] `holds the lock in the same tick against a per-member editor change`
- [x] `keeps one write per member when clicked twice in the same tick (controller saving holds the second)`
- [x] `keeps going after a structured rejection and keeps the summary through a poll`
- [x] `skips a teammate replaced under the same name while the bulk is running`
- [x] `does not attempt a teammate that joined after the click`
- [x] `shows a lost response as unconfirmed and keeps the remaining teammates`
- [x] `stops sending the remaining teammates after unmount`
- [x] `disables the action for an empty draft or an empty roster`
- [x] `blocks the submit when the live catalog no longer offers the drafted route`
- [x] `writes a teammate whose resolved route already equals the target`
- [x] `stays locked while a lost response is being re-read`
- [x] `clears a draft whose effort was retired and asks for a new choice`
- [x] `shows an empty-roster hint instead of a roster it cannot see`

---

## 待办（不属于本文件职责）

- [ ] task-43：全量 `npm test`（145）→ `typecheck` → `build` → `check` → `git diff --check`；`npm pack` 到 `artifacts/bulk-member-model-2026-10-19/dsh-agent-team-switchable-0.2.2.tgz`；逐字节比对 + SHA256；写 `docs/superpowers/verification/2026-10-19-bulk-member-model.md`。**尚未执行，勿视为已通过。**
- [ ] 真实 GUI/profile 安装与真实 LLM 换模：未做（用户只要求写按钮）。

## 自检

- **口径对齐：** 失败/未确认按 `TeamSettingsRejectedError` 分类，不按读回推断；`unknown` 不否定写入；无 `unchanged` skip 与对应文案；下架草稿清空 + 重选提示，不静默降级。
- **类型一致：** `BulkSkipReason` 仅 `'phase' | 'changed'`，与 `resultKey/skipKey` 映射、`bulk.skip.phase|changed` 两个键一一对应；`BulkTarget.phase` 复用 `TeamMemberModelView['phase']`（`src/types.ts:32`）；`save(name, selection)` 由弹窗适配到 `TeamSettingsController.save(target, selection)`。
- **有意未覆盖：** 多客户端并发 fencing；同名成员在单条 RPC 往返内被替换的残留窗口（Host 按 name 解析）；真实浏览器/已安装 profile 验证。
