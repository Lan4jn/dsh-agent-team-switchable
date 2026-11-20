# 统一模型选择器 + 双按钮 实现计划

> **面向执行者：** 按任务顺序小步实现，每条先写失败测试再补实现；测试命令用本仓现有形式。实现细节不要引入本文之外的 API。

**目标：** 一组共享 provider/model/effort 草稿 + 两个显式按钮（应用到当前队员 / 设为新队员默认）；删除重复 default 编辑器与全局自动保存提示；保留成员逐行 autosave。

**架构：** 全部落在 `src/client`：复用 `TeamSettingsController.save(name|null, selection|null)`、`bulk-apply.ts` 的 `frozenTargets/applyToMembers/agreedSelection`、现有 `BulkModelPicker` 与单一写闸门。Host、存储、协议、`package.json` 版本都不动。

**规格：** `docs/superpowers/specs/2026-10-21-shared-model-picker-design.md`

**基线：** 0.2.3 现状（共享 picker、`agreedSelection` 回填、批量应用均已存在）。

**写范围（task-58）：** `src/client/TeamModelDialog.tsx`、`src/client/BulkModelPicker.tsx`（仅在需要时）、`src/client/TeamModelSettings.module.css`、`src/client/locales.ts`、`tests/client/*`（含既有 spec 的定向更新）、`README.md`。

---

## 任务 0：先跑基线，确认现有绿灯

- [ ] `node node_modules/vitest/vitest.mjs run tests/client` → 记录当前通过数（预期全绿）。
- [ ] 记录以下将被改动的用例位置（改动后需定向更新，不是放宽断言）：
  - `tests/client/team-model-action.spec.tsx`：在 `defaultModel.title` region 内操作模型下拉的用例（约 71–79、140–142、189 行附近）。
  - `tests/client/slot-runtime.spec.tsx`：约 139 行 `within(defaults).getByLabelText(zh.model)`。
  - `tests/client/team-model-bulk.spec.tsx`：所有 `zh['bulk.apply']` 按钮文案引用（文案改为「应用到当前队员」后仍按同一键取）。

## 任务 1：locale 键调整

**文件：** `src/client/locales.ts`

- [ ] 1.1 先改测试（`tests/client/team-model-bulk.spec.tsx` 中断言按钮名处保持用 `zh['bulk.apply']`；新增一条断言 `zh['defaultAction.apply']` 存在且按钮可见）→ 先红。
- [ ] 1.2 zh/en 同步：`bulk.apply` 改为「应用到当前队员」；新增 `bulk.applyScope`、`defaultAction.apply`、`defaultAction.scope`、`defaultAction.recovery`、`defaultAction.recovered`、`defaultAction.saved`、`defaultAction.failed`、`defaultAction.unknown`；删除已无引用的 `model.autoSaveHint`。
- [ ] 1.3 `node node_modules/typescript/bin/tsc --noEmit`（`en` 用 `satisfies Record<TeamKey,string>`，漏键即报错）。

## 任务 2：删除重复 default 编辑器与全局提示

**文件：** `src/client/TeamModelDialog.tsx`

- [ ] 2.1 测试：在 `defaultModel.title` region 内断言 `queryByLabelText(zh.model)` 为 `null`、且该 region 仍含 `data-committed-default` 与「恢复继承」入口；同时断言全局 `model.autoSaveHint` 文案不再出现 → 先红。
- [ ] 2.2 删除 `<p className={css.autoSaveHint}>…</p>` 与 `defaultSection` 内的 `<TeamModelEditor mode="default" …/>`；`defaultSection` 只留只读摘要。
- [ ] 2.3 定向更新既有用例：把原先操作 default 下拉的步骤改为「改共享草稿 → 点『设为新队员默认』」（落在任务 4），slot-runtime 取 `zh['bulk.model']`。

## 任务 3：草稿回填规则

**文件：** `src/client/TeamModelDialog.tsx`（复用 `agreedSelection`，必要时在 `bulk-apply.ts` 增一个纯函数）

- [ ] 3.1 测试（新 spec 或追加到 `team-model-bulk.spec.tsx`）：
  - 成员共识 → 重开时草稿等于该共识；
  - 成员 mixed → 草稿为空 + `zh['bulk.mixed']` 提示，且不显示统一结论；
  - 无可执行成员但 `defaultModel` 合法 → 草稿回填该 default，且只有 #2 可用；
  - 零数据（无成员且 default 为 null）→ 两按钮禁用；
  - 用户手改草稿后，即使 poll 返回不同共识，草稿**不被覆盖**。
  先红。
- [ ] 3.2 实现 `effectiveSelection`：`bulkSelection !== undefined` 时直接用它；否则按「有可执行成员 → 共识/mixed/空；无可执行成员 → 合法 default；否则 null」。mixed 提示只在 `bulkSelection === undefined` 时显示。
- [ ] 3.3 确认 picker 的 `pristine` 语义满足：手改或下架后不再跟随 `initial`（若发现 `initial` 变化可覆盖，最小修 picker，不动其对外 props）。

## 任务 4：按钮 #2「设为新队员默认」与「恢复继承」

**文件：** `src/client/TeamModelDialog.tsx`、`TeamModelSettings.module.css`

- [ ] 4.1 测试：点 #2 时 `selectTeamDefaultModel` 恰好 1 次（`selection` 等于草稿）、`selectMemberModel` 0 次；结构化拒绝 → `defaultAction.failed`；传输异常 → `defaultAction.unknown`；「恢复继承」→ `selectTeamDefaultModel({selection:null})` 恰好 1 次。
- [ ] 4.2 实现 `applyDefault(selection: TeamModelSelection | null)`：`if (!beginWrite()) return` → `setDefaultResult(null)` → `await saveTarget(null, selection)` → `saved`；`catch` 按 `e instanceof TeamSettingsRejectedError` 分 `failed` / `unknown`；`finally { endWrite() }`。
- [ ] 4.3 「恢复继承」用链接样式按钮（不是第三个主按钮），`disabled` 条件同 #2 且 `view.defaultModel === null` 时禁用；成功后该行回到 `defaultModel.inherit`。
- [ ] 4.4 结果单行渲染：`defaultAction.saved|failed|unknown`，文案需含「保存 ≠ 已实际生效」含义。

## 任务 5：按钮 #1 作用域收敛 + 锁改名覆盖三入口

**文件：** `src/client/TeamModelDialog.tsx`

- [ ] 5.1 测试：同 tick 先点 #1 再点 #2（或反之）只发起一次写入；#1 在无任何可执行队员时禁用但 #2 仍可用；成员行编辑器在 #2 在途时禁用；关闭/ Escape / 外点在写入期间被拦截。
- [ ] 5.2 把 `bulkGate/bulkRunning/beginBulk/endBulk` 改名为 `writeGate/writeRunning/beginWrite/endWrite`；`busy()` 语义不变。
- [ ] 5.3 #1 的 handler 保持现有 `applyToMembers` 流程，只把禁用条件改为「无可执行队员 → 禁用」（用 `frozenTargets(view).some(t => t.phase === 'active')`），并加 `bulk.applyScope` 提示。
- [ ] 5.4 两个按钮并排（`flex`，窄屏换行），沿用现有 `--dsw-alias-*` token；不做第三个主按钮。

## 任务 6：README 与全量验证

- [ ] 6.1 `README.md` 更新交互描述：一组草稿 + 两个按钮 + 只读默认行 + 恢复继承；成员逐行 autosave 保留；说明「保存 ≠ 已实际使用」与「下一轮生效」；说明版本号与打包由后续流程处理（不在此写具体版本）。
- [ ] 6.2 `node node_modules/vitest/vitest.mjs run tests/client` 全绿；`node node_modules/typescript/bin/tsc --noEmit` 退出码 0；`node --test tests/package.test.mjs` 通过（若包契约测试引用注入列表，确认未受影响）。
- [ ] 6.3 `git diff --check` 干净；`git status` 只含本任务预期文件（保留其它既有 dirty，不 `reset`/`stash`）。

---

## 验收清单

- [ ] 草稿选择不触发任何 RPC；#1 只写当前非 Lead 队员；#2 只写 default；两者互不代写。
- [ ] 重开回填四态（共识 / mixed / 仅 default / 零数据）行为与规格 §4 一致，mixed 不假称统一。
- [ ] 用户手改或下架后，poll 不覆盖草稿；下架整份清空并提示重选。
- [ ] 三入口 + 成员行 + 关闭共用同一把锁，同 tick 只有一个写入发起。
- [ ] #2 失败三态（saved / failed / unknown）文案正确；unknown 不声称未写入。
- [ ] 「恢复继承」只写 default、被同锁保护、不提供共享 picker 的 inherit 选项。
- [ ] 成员逐行 autosave 与既有回归不变；卸载后不继续发送、不回滚。
