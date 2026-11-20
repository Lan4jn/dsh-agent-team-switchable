# 统一模型选择器 + 双按钮 设计规格

**日期：** 2026-10-21  
**状态：** 用户已批准交互，本文件只固化契约，不含实现；实现与测试归 task-58。  
**基线：** 本仓 0.2.3 现状（已存在共享 picker、成员逐行 autosave、批量应用与 `agreedSelection` 回填）。0.2.4 版本号与打包由后续 tester 处理，本设计不改 Host 存储协议、不改 `profile`、不做 `commit`。

---

## 1. 目标

同一组 provider/model/effort 草稿，下方**两个主按钮**：

1. **「应用到当前队员」**——只写点击时的当前非 Lead 可执行队员，逐人显式写一次；不改未来默认。
2. **「设为新队员默认」**——只写 future-teammate default；不动任何现有队员。

并收敛掉重复的编辑器：删除菜单内第二套 default 编辑器和全局「选择即自动保存」提示；保留成员逐行的独立 autosave；Lead 永远不会被这两个按钮写到。

## 2. 现有可复用契约（实测，不改）

| 需要 | 现成能力 |
| --- | --- |
| 写某队员 | `TeamSettingsController.save(name: string, selection: TeamModelSelection)`（`src/client/settings-controller.ts`，内部 `selectMemberModel`） |
| 写未来默认 / 恢复继承 | `controller.save(null, selection)`；**`selection === null` 即恢复继承**（内部 `selectTeamDefaultModel({selection:null})`，Host 已支持，无需新 RPC） |
| 失败分类 | `!response.ok` 抛 `TeamSettingsRejectedError`（结构化拒绝，存储未变）；其它为传输异常 |
| 读取/轮询 | `controller.store.getSnapshot()` → `{ view, loading, saving, error }`；`controller.load()` 1s 轮询；`revision` 单调不回退 |
| 目录能力 | `knownSelection(sel)`（dialog 内已有）：当前目录仍提供该 provider/model 与 effort |
| 队员共识回填 | `agreedSelection(view, activeNames)` → `{kind:'agreed'|'mixed'|'none'}`（`src/client/bulk-apply.ts`） |
| 冻结清单/逐项结果 | `frozenTargets(view)`、`applyToMembers(...)`（`bulk-apply.ts`，行为不变） |
| 共享草稿 | `BulkModelPicker`（`initial` + `onChange`，`pristine` 内部 ref，下架即整份清空并提示 `bulk.reselect`） |

Host 侧：`selectMemberModel` 拒 Lead、拒 `failed`/`provisioning`，`running`/`inactive` 均可；写入 `effectiveAfterTurn` ⇒ **下一轮生效**。`selectTeamDefaultModel` 与成员写入互不影响。

## 3. 布局

```
[region  aria-label=bulk.title]
  hint：草稿不自动保存
  <BulkModelPicker initial=effectiveSelection onChange=setBulkSelection />
  [mixed 提示]   draft 未手改 且 共识为 mixed
  [reselect 提示] picker 内部已发出（草稿被下架清空）
  (button #1) 应用到当前队员      + scope 提示：只写当前可设置队员，不改未来默认
  (button #2) 设为新队员默认      + scope 提示：只影响之后新增成员，不改现有队员
  队员逐项结果（沿用现有 bulk.summary / 逐行 outcome）
  默认写入结果（单行，新）

[region  aria-label=defaultModel.title]   ← 只读
  <p data-committed-default>已保存的新成员默认：…</p>
  (link 样式按钮) 恢复继承        ← 非第三主按钮，写 default=null
  ※ 不再有模型下拉

[region  aria-label=members]   ← 不变：每人 TeamModelEditor 独立 autosave
```

删除：`<p>{t('model.autoSaveHint')}</p>` 全局提示、`defaultSection` 里的 `TeamModelEditor mode="default"`。

## 4. 草稿与回填（重开时）

`bulkSelection: TeamModelSelection | null | undefined`，`undefined` = 跟随已提交视图（**不是**已存草稿，也不构成任何写入确认）。

`effectiveSelection` 计算顺序：

1. `bulkSelection !== undefined` → 用它（`null` 表示用户清空/下架后的明确空草稿）。
2. 否则取 `executable = view.members` 中 `phase === 'active' && activeNames.includes(name)`：
   - `executable.length > 0`：`agreedSelection` 为 `agreed` 且 `knownSelection(selection)` → 该选择；`mixed` 或各成员 route 未知 → `null` 并显示 mixed/空提示（**不假称已统一**）。
   - `executable.length === 0`：`view.defaultModel !== null && knownSelection(view.defaultModel)` → 用它（此时**只有按钮 #2 可用**）；否则 `null`。
3. 零数据（无成员且无合法 default）→ 初始为空草稿，两个按钮**此时**都禁用；但禁用只针对“初始/当前草稿非法”：一旦用户选出合法草稿，即使没有任何队员，#2 也立即可用（#1 仍禁用）。

**poll 不得覆盖用户输入**：`BulkModelPicker` 只在 `pristine` 时跟随 `initial`；一旦用户手改或发生下架清空（`pristine=false`），后续 `initial` 变化一律忽略。dialog 侧只在 `bulkSelection === undefined` 时才重算回填。

## 5. 两个按钮的作用域与结果

| | 按钮 #1 应用到当前队员 | 按钮 #2 设为新队员默认 |
| --- | --- | --- |
| 写入 | `applyToMembers` 逐项 `controller.save(name, sel)` | `saveTarget(null, sel)` → `controller.save(null, sel)` |
| 禁用条件 | `!eligible` / 草稿非法 / 无可执行队员 / `saving` / 写锁在持 | `!eligible` / 草稿非法 / `saving` / 写锁在持（**不要求有队员**） |
| 结果 | 现有 `bulkOutcomes` 四态汇总 | 单行：`saved` / `failed`（结构化拒绝）/ `unknown`（传输异常，可能已写入） |
| 语义 | 仅设置保存，下一轮生效 | 仅设置保存，只影响之后新增成员 |

`恢复继承`：`saveTarget(null, null)` → `controller.save(null, null)`；成功后该行显示 `defaultModel.inherit`。

**它的禁用条件是独立的**：只要求 `view.defaultModel !== null`（确有已存默认可清）、`eligible`、且无 `busy()`——**与共享草稿是否合法无关**。因此即使草稿为空/非法（例如已存 default 的模型已被下架、无法回填成合法草稿），也必须能清掉这个已存 default，不能被「草稿无效」连带禁用。

结果文案必须写明**保存 ≠ LLM 已实际使用该模型**。

## 6. 锁（同 tick，一个门）

沿用现有单一闸门，改名以覆盖两种写入：

- `writeGate = useRef(false)`、`writeRunning` state、`busy() = writeGate.current || store.getSnapshot().saving`。
- `beginWrite()`：`writeGate || saving` 为真返回 false；否则同步置真 + `setWriteRunning(true)`，返回 true。它是**单层 owner 守卫**：只负责阻止重入/嵌套 double-acquire，`controller.save` 内部的 `saving` 是另一层既有守卫，两层职责不同、不要互相替代。
- `endWrite()`：复位；仅在 `mounted.current` 时 `setWriteRunning(false)`。
- 唯一获取点：按钮 #1、按钮 #2、`恢复继承` 三个 handler 各自 `if (!beginWrite()) return`，`finally { endWrite() }`。
- 消费方：两个按钮 `disabled={... || state.saving || writeRunning}`；两个编辑器 `isLocked={() => busy() || ...}`、`disabled={state.saving || writeRunning || ...}`；关闭按钮 / Escape / 外点用 `!busy()`。
- 完全卸载/会话切换：`mounted.current=false` ⇒ 停止剩余发送、不 `setState`、不回滚已提交项。`controller.deactivate()` 只让**后续请求与 UI 结果**失效（在途响应不再提交到 store），**不承诺取消已发给 Host 的写入**——已发出的 `selectMemberModel` / `selectTeamDefaultModel` 仍可能在 Host 侧落库。

## 7. 文案（zh 为键源，en 必须同键）

沿用：`bulk.title`、`bulk.hint`、`bulk.model`、`bulk.choose`、`bulk.reselect`、`bulk.mixed`、`bulk.running`、`bulk.empty`、`bulk.incomplete`、`bulk.summary`、`bulk.result.*`、`bulk.skip.*`、`defaultModel.*`、`model.reasoning`、`model.defaultReasoning`。

调整/新增：

- `bulk.apply` 文案改为「应用到当前队员」。
- `bulk.applyScope`：只写当前可设置队员，不改未来默认。
- `defaultAction.apply`：「设为新队员默认」。
- `defaultAction.scope`：只影响之后新增的成员，不改现有队员。
- `defaultAction.recovery`：「恢复继承」。
- `defaultAction.recovered`：「已恢复为继承」。
- `defaultAction.saved` / `defaultAction.failed` / `defaultAction.unknown`：三态结果（含“响应丢失可能已写入”的说法）。
- 删除已无引用的 `model.autoSaveHint`（两语言同步删除，避免死键）。

## 8. 不做

- 不新增 Host RPC / 存储表 / 事务；不改 `src/service.ts`、`src/types.ts`、`src/remote.ts`。
- 不让共享 picker 出现 `inherit` 选项（恢复继承只走独立轻量入口，避免被误当成批量继承）。
- 不改成员逐行 autosave 行为；不改 Lead 的任何路径。
- 不改 `package.json` 版本（0.2.4 由 tester）、不 `build`/`pack`、不装 profile、不 `commit`/`push`。

## 9. 回归要点（task-58）

1. 草稿初始回填：共识 → 共识；mixed → 空 + mixed 提示；无可执行成员 + 合法 default → 回填 default 且只有 #2 可用；零数据 → 全禁用。
2. 选择草稿**不发任何 RPC**；#1 只写当前队员；#2 只写 default（`selectTeamDefaultModel` 恰好一次、`selectMemberModel` 零次）；反之亦然。
3. 同 tick：三个入口与成员行编辑器互斥，只有一个写入成功发起。
4. poll 不覆盖用户手改/下架后的草稿。
5. 下架：草稿整份清空 + `bulk.reselect`；两个按钮均禁用。
6. #2 失败分类：结构化拒绝 → `failed`；传输异常 → `unknown` 且提示刷新。
7. `恢复继承` 只写 default，且被同一把锁保护。
8. 卸载后不再继续发送，已提交结果不回滚。
