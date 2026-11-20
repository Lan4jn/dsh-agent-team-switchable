# 一键统一当前队员模型（批量切换）设计规格

**日期：** 2026-10-19（task-46 终版同步，对应 task-44 修复后的冻结代码）  
**状态：** 设计 + 实现口径已与代码一致；最终全链/打包由 task-43 执行，本文不预先声称通过。  
**前置：** `docs/superpowers/specs/2026-10-09-member-model-autosave-design.md`（顶部默认 + 逐成员自动保存布局）

---

## 1. 目标与已确认的用户决定

在现有“团队模型设置”弹出菜单顶部增加**独立的** provider/model/effort 草稿与一个显式按钮「一键应用到全体队员」：

1. 只作用于**点击那一刻** `view.members` 里可见的非 Lead 队员；之后新建的队员不纳入本次。
2. **Lead 不改**，**未来新成员的 default 也不改**（批量路径中 `selectTeamDefaultModel` 调用次数为 0）。
3. 当前运行中的轮次不打断，**下一轮生效**（沿用 Host 现有语义，不由客户端伪造）。
4. 同一时刻只允许一次批量执行；执行期间整菜单的提交路径（默认编辑器、逐行编辑器、批量按钮）互斥，锁**整段只获取一次**。
5. **显式写入口径（task-44 修正）：不再有 `unchanged` 跳过**。凡点击时合格、且逐项校验仍合格的当前非 Lead 队员，**每个都显式调用一次 `selectMemberModel`**——即使该成员“已解析出的当前/下轮模型”与目标相同也照写一次，让设置由 Host 落库，而不是由客户端“看起来已一致”推断。只有 `phase` 与 `changed` 两种真实变化才 skip。
6. 每人结果可见且区分：**已保存 / 失败 / 跳过 / 未确认**（locale key 固定 `bulk.result.saved` / `.failed` / `.skipped` / `.unknown`）。分类口径：`settings-controller.ts` 的 **`TeamSettingsRejectedError`** 表示 Host 结构化拒绝（`RemoteResult.ok === false`，存储未变）→ `failed`；其余抛错（传输异常/响应丢失）→ `unknown`，**不用读回否定写入**。
7. 打开中/失败/已删除/同名换 ID 的成员不得被计为成功。
8. 逐条顺序提交，**非事务、不回滚**；单人失败不终止其余；卸载后不再继续发送。
9. “成功”只表示**设置已保存**，且从**下一轮**生效，不表示已经发生一次 LLM 请求。
10. 顶部草稿**初始为空**，**不预填** default；若模型目录刷新使草稿的 model 或 effort **下架**，**清空整份草稿并提示重新选择**（`bulk.reselect`），绝不静默降级到其它模型/effort。

## 2. 现有真实契约（核对依据）

### 2.1 Host 写入路径：复用，不新增

`src/service.ts:34-58` `selectMemberModel`：

- 入参 `{ leadSessionId, target /* 不可变 name */, selection }`（`src/types.ts:17-21`）。
- 拒绝 Lead 与空 target（`:36-38`）；只接受 `role === 'teammate'`，`failed`/`provisioning` 拒绝，**`running` 与 `inactive` 都允许**（`:39-42`）。
- `domain.transform` 串行临界区内再次按 `id + name + role` 复核并校验公开 `membership`（`:44-52`）——排队/校验期间成员变化会失败而不是写错人。
- 写入 `choices[member.id] = { selection, effectiveAfterTurn: lastOwnTurn(live) }`（`:53-55`），**不触碰** `defaultModel`（对比 `:62-70`）。
- 返回完整 `TeamModelSettingsView`（revision 自增）。

下一轮生效的落地：`src/model-routing.ts:138-147`，仅在 `turn/start` 且 `event.data.turn > effectiveAfterTurn` 时替换整轮路由。

`view()`（`src/service.ts:99-118`）把 `listMembers` 过滤成 `role === 'teammate'` 后映射为 `phase ∈ {provisioning, active, failed}` + `status ∈ {running, inactive}`。**`view.members` 就是“非 Lead 可见集”**；不在其中的成员（例如未进入投影的创建失败项）本插件不可见，**不得伪造结果行**。

`agentTeams` 公开接口（host inspect `Service.listService(service: "agentTeams")` 实测）只有 `membership/listMembers/spawnTeammate/sendMessage/createTask…/interrupt/tryMembership`；`spawnTeammate` 只在创建时带 `provider`，没有“改已有成员模型”的方法。

### 2.2 Client 控制器：单航班 + 修订号单调 + 拒绝分类

`src/client/settings-controller.ts`：

- `save(target, selection)`（`:73-91`）：入口若 `state.saving` 直接抛错；**同步**置 `saving=true` 后才 `await` RPC；每次保存 `++this.request` 使在途轮询结果失效；`finally` 在仍有效时复位 `saving`。`!response.ok` 抛 **`TeamSettingsRejectedError`**（类定义 `:7`，抛出 `:89`），其余 API 拒绝原样冒泡 → 批量据此区分 `failed` / `unknown`。
- `load()`（`:51-71`）：`saving` 期间直接返回；失败写 `state.error`。
- `commit()`（`:97-103`）：`view.revision` 只增不减。
- `activate/deactivate/dispose`（`:30-49`）：`deactivate()` 使在途 `save()` 的 `valid()` 为假，卸载后再次 `save` 抛 `Settings are not editable`。

关键推论：`saving` 只在**单条 RPC 期间**为真，两条之间有空档 → 批量必须自带**同一 tick 生效、整段只获取一次**的闸门；也不能手动把 `store.saving` 常置真（会挡住后续每条 `save`）。

### 2.3 菜单挂载与生命周期

- `TeamModelSettingsAction.tsx:29-38`：`eligible` 来自官方投影 `agentTeam.members`；`activeNames` = `role === 'teammate' && phase === 'active'` 的名字。
- `:40-55`：`controller` 按 `leadSessionId` memo；`SettingsHeader` 由父级 `key` 重挂 → 批量状态随会话/Lead 变化重置。
- `TeamModelDialog.tsx`：`mounted.current` + 1s 轮询；cleanup 里 `mounted=false`、`abort`、`lease.release()`、`controller.deactivate()`；保存/批量期间禁止关闭（按钮 / Escape / 外点）。

### 2.4 核对手段与未验证项

- 已核对：host `agentTeams` 实时签名（§2.1）；`src/service.ts`、`src/model-routing.ts`、`src/client/*`（含 `bulk-apply.ts`、`BulkModelPicker.tsx`、`TeamModelDialog.tsx`、`settings-controller.ts`）逐行；两份测试文件用例名逐条（9 + 15）。
- 未验证：client `Service.listService` 与 `Slots.listSubTree` 在本会话多次 10s 超时（无已连接页面），客户端契约以已读源码 + 已发布 `lib/client.js` / `lib/typert.remote-client.d.ts` 为准。不影响设计：批量完全落在既有 `team-model-settings` occupant 内，**不需要新 Slot、不改 mount 注入**。
- 未发生：本文件作者**未**执行全量测试/typecheck/build/pack，也**未**安装 profile；最终全链与打包归 task-43。

## 3. 方案

复用 `selectMemberModel`：客户端一个**批量协调器**（纯函数）+ **受控 picker** + 菜单内一处集成。

### 3.1 共享锁：一次持有的唯一入口

```
busy() = bulkGate.current || controller.store.getSnapshot().saving
```

`TeamModelDialog.tsx` 内三个函数收口：

- `beginBulk()`：`bulkGate.current || saving` 为真返回 false；否则**同步**置 `bulkGate.current = true` 并 `setBulkRunning(true)`，返回 true。
- `endBulk()`：复位 `bulkGate`；仅在 `mounted.current` 时 `setBulkRunning(false)`。
- `busy()`：所有编辑器 `isLocked`、关闭按钮 / Escape / 外点判定共用。

`applyBulk()` 是**唯一获取点**，`try/finally` 保证释放；`controller.save` 内部的 `saving` 嵌在这层外锁之内。**未确认读回期间也保持持锁**——否则一条晚到的逐行写入会递增 `controller.request`，令批量在读回后的结果判定失效。

### 3.2 冻结与逐项契约

**冻结**：点击时取 `view.members` **全量**（不预筛 `phase`），映射 `{ id, name, phase }`，按 `id` 去重。批量中新增成员不在集合内 → 无结果行（不伪造）。

**逐项顺序执行**（`src/client/bulk-apply.ts`）：

1. `alive()` 为假 → 停止，剩余不再发送。
2. `target.phase !== 'active'` → `skipped`（原因 `phase`），仍展示。
3. 读最新 `store.getSnapshot().view`；行缺失、`row.phase !== 'active'`、或 `target.name` 不在点击时冻结的 `activeNames` → `skipped`（原因 `changed`）。这一步覆盖删除、转 failed/provisioning、同名换 ID。
4. **其余一律显式写一次**：`await controller.save(target.name, selection)` → `saved`；已解析 route 与目标相同也照写（§1.5）。
5. 抛错：`instanceof TeamSettingsRejectedError` → `failed`（存储未变）；其余 → 尽力 `reload()` 刷新展示后 `unknown`——**读回不改变状态、不作结论、不否定写入**。

`save` 入参是 **name**，Host 也按 name 解析；批量 id/name 复核是**尽力而为**：同名成员若在某条 RPC 往返内被替换，Host 会写向新 id。这是既有 Host 契约的残留窗口，不得声称原子 id 栅栏。

### 3.3 草稿有效性（下架即清空）

`draftValid()`：草稿非空且**当前目录**仍提供该 provider/model，且（如带 effort）该模型仍声明该 effort。picker 内部同样监听目录快照：`route` 或 `effort` 被下架时清空整份草稿、`onChange(null)` 并显示 `bulk.reselect`；按钮在 `!draftValid()` 时禁用。**不静默降级**到目录里第一个可用模型或丢弃 effort。

### 3.4 结果与状态归属

- `bulkOutcomes` 是组件 state（不派生自 `view`）→ 1s 轮询冲不掉；每次点击清空。
- 结果行 = 点击时的冻结集，不因后续 `view` 缺失某项而增删。
- `report` 仅在 `mounted.current` 时 `setState`；卸载后停止发送、不回滚已成功条目。
- 汇总：`bulk.summary` 四计数；任一行非 `saved` 时追加 `bulk.incomplete`；`bulk.result.saved` 文案写明“设置已保存，下一轮生效”。

## 4. 明确不做

- 不加 Host RPC、不改 `src/service.ts` / `src/domain.ts` / `src/remote.ts` / `src/types.ts`。
- 不改逐行自动保存（`TeamModelEditor.tsx` 保持原样，只是父级传入更严格的 `isLocked`）。
- 不改未来默认（批量路径中 `selectTeamDefaultModel` 一次都不调用）。
- 不做事务/回滚、不做多客户端并发 fencing、不向官方团队菜单 DOM 注入。
- 不 install profile、不 build/pack、不 commit/push。

## 5. 验收状态（对应现有回归；最终全链待 task-43）

- [x] 草稿初始为空、不预填 default；选择**不触发任何 RPC**；换模型清空 effort。
- [x] 一次点击 = 每个合格队员**恰好一条** `selectMemberModel`；`selectTeamDefaultModel` 零调用。
- [x] **已解析相同仍显式写一次**（纯逻辑 `writes every eligible member even when the resolved route already equals the target` + 集成 `writes a teammate whose resolved route already equals the target`）。
- [x] 同 tick 与逐行编辑器互斥；同 tick 连点仍是一人一条（`controller.saving` 挡住第二次）。
- [x] 结构化拒绝 → `failed` 且继续其余；传输异常/响应丢失 → `unknown` 且其余继续；读回不可读仍 `unknown`。
- [x] **未确认读回窗口内锁不释放**（`stays locked while a lost response is being re-read`）。
- [x] 运行中同名换 ID / 名字不在冻结 `activeNames` / 点击后加入者 → 跳过或不计入，均不判成功。
- [x] 卸载后不再发送剩余、不 `setState`、不回滚已完成条目。
- [x] 草稿 route 或 effort 下架 → 整份清空 + `bulk.reselect` + 按钮禁用；空草稿/空名单禁用并提示。
- [ ] 全量 `npm test`（145 条）→ `typecheck` → `build` → `check` → `git diff --check` 与 `npm pack`：**尚未执行，待 task-43 完成**。
