# 验证记录：统一双按钮模型选择界面（0.2.4 打包交付）

日期：2026-10-21 · 版本：0.2.3 → 0.2.4 · 执行：persistence-tester（task-60）· 实现：bulk-coder-ds（task-58）· 独立复审：bulk-reviewer-ds（task-59）

## 一、结论摘要

- 0.2.4 只改客户端菜单交互：一组共享 provider/model/effort 草稿 + 两个显式按钮（「应用到当前队员」「设为新队员默认」）；成员行仍是各自独立的自动保存；默认区只有只读 summary 与轻量「恢复继承」入口。
- Host/Domain/remote/types/model-routing/bridge/profile/官方插件零改动；无新 RPC、无新存储、无 Gemini 网关 schema 变更。
- 版本契约、全链与打包在本文命令下真实通过；产物落在新目录，未覆盖任何旧包。
- 未安装 profile、未做真实 GUI 点击、未触真实 LLM；官方团队弹层/创建卡的静态 `options.model` 显示问题不在本次范围内。

## 二、需求映射（用户批准口径 → 可验证落点）

| 需求 | 实现落点 | 本次如何验证 |
| --- | --- | --- |
| 单一共享 model/effort 选择器，不再有第二份默认表单 | `BulkModelPicker` 唯一 picker；default 区仅 `data-committed-default` 只读 summary | 打包后 `lib/client.js`：`data-committed-default`×1、按钮文案各×1、`applyBulk`×2、`applyDefault`×3 |
| 两个显式按钮各写各的范围 | 按钮1 `applyBulk` → `applyToMembers`（仅可执行成员，每条 `controller.save(name, …)`）；按钮2 `applyDefault` → `controller.save(null, …)` | 同上调用点计数 + 59 的 scope 互斥 mutation（M4） |
| 选 provider/model/effort 本身绝不触发写入 | 草稿为纯 UI 状态；提交只在按钮 handler 内 | `bulk.hint`「草稿不会自动保存…」×1；`localStorage` 0 次 |
| 成员仍各自独立 autosave | `TeamModelEditor` member-only 保存路径保留 | 打包 `lib/client.js` 含「自动保存」局部提示 ×1；59 复核 `saveMember` 路径未变 |
| 默认展示为 summary + 轻量恢复继承 | `defaultModel.summary` + `defaultAction.recovery`「恢复继承」（同锁 `save(null,null)`） | 「恢复继承」×1、「只影响之后新增的成员」×1；59 的 M1 mutation |
| 无重复全局自动保存提示 | `model.autoSaveHint` 已删 | 打包内 `model.autoSaveHint` 计数 0 |
| 不改 Host / 不新增协议 | 复用既有 `selectMemberModel` / `selectTeamDefaultModel` | 归档 `lib/typert.remote-client.js` 仅这 3 个名字各 1 次 |

## 三、58 实现的 RED/GREEN（59 实测口径）

- 新增 `team-model-shared-picker` 13 项；净变化 158 − 3（旧 default-mode）+ 13 = **168**。
- 59 在 `/tmp` 隔离副本上做行为 mutation 并 `diff -q` 还原：
  - M1 恢复继承改成 `|| !draftValid()` → `restores inheritance even when the shared draft is invalid` FAIL（证明「invalid stored default 仍可清」被断言住）。
  - M3 失联计为 saved → 2 FAIL（`reports a lost default response as unknown…`、`preserves committed default on a lost response…`）。
  - M4 按钮1 额外写 default → `runs only the first of two same-tick writes…` FAIL（scope 互斥真被测）。
  - M5 handler 内二次 `beginWrite()` → 7 FAIL，含 default/恢复继承用例，说明断言的是真实 `selectTeamDefaultModel` RPC 而非 UI 自证。
  - M2 去掉 `applyDefault` 的 `writeGate` → 23/23 仍绿：同 tick 由 `controller.save` 同步置 `saving` 顶住，gate 的独立价值只在 bulk unknown-reload 窗口（见第七节遗留）。

## 四、59 独立复审结论

全链 `npm test` 16 files / **168 passed**、`typecheck`/`build`/`check`(10/10)/`git diff --check` 全 exit 0；范围仅客户端 5 个文件 + `tests/client/*` + README，Host/Domain/remote/types/model-routing 当日零改动；源码复核确认单组共享草稿、按钮1 不触碰 default、按钮2 只写 default、恢复继承不依赖 `draftValid`、单一 `writeGate`（按钮1/按钮2/恢复继承/成员 autosave 各只取一次且不自套锁）、Lead 无写路径。结论：无阻塞，可交 60 打包；1 条非阻塞覆盖建议（bulk unknown-reload 窗口内 #2 的 gate 阻断缺判别用例）。

## 五、60 版本契约 RED → GREEN

RED（只把断言改为 `0.2.4`，manifest 仍 `0.2.3`）：

```
$ npm run check
ℹ tests 10 · pass 9 · fail 1
AssertionError [ERR_ASSERTION]: '0.2.3' !== '0.2.4'      → exit 1
```

GREEN（`package.json` 顶层 1 处 + `package-lock.json` 顶层/根 2 处改 `0.2.4`；依赖图、pnpm 旧锁均未动，未 force / legacy-peer）：

| 步骤 | 命令 | 实测结果 |
| --- | --- | --- |
| 单测 | `npm test` | 16 files / **168 passed**，exit 0 |
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build` | exit 0（独占构建，未与 59 并行） |
| 包契约 | `npm run check` | 10/10 pass，exit 0 |
| 空白 | `git diff --check` | exit 0 |

SDK 依赖图未漂移：DSH `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`；`package.json`/`package-lock.json` 内已无 `0.2.3` 残留。

## 六、产物与逐字节核验

- 路径：`/Users/mewcapoo/Projects/dsh-agent-team-switchable/artifacts/shared-model-picker-2026-10-21/dsh-agent-team-switchable-0.2.4.tgz`
- SHA256：`f14d455af0779a48c2235ebc769712e26e71f297b3c3459862b0ab0006ba8d2e`
- 大小：375424 bytes · 归档 **36** 个文件（`total files: 36`，`bundled: []`），新目录，未覆盖任何旧 tgz
- 归档内 `package.json` version = `0.2.4`
- 逐字节：解包后 36 个文件逐个 `cmp` 与当前工作区同路径文件比对 → **mismatch=0**
- 归档内 `lib/client.js` 内容核验（esbuild ascii 转义解码后）：`应用到当前队员`×1、`设为新队员默认`×1、`草稿不会自动保存`×1、`恢复继承`×1、`最近已使用`×1、`只影响之后新增的成员`×1、`data-committed-default`×1、`applyBulk`×2、`applyDefault`×3、`writeGate`×5、`beginWrite`×4、`model.autoSaveHint`×0、`localStorage`×0；`lib/typert.remote-client.js` 仅 `getSettings`/`selectMemberModel`/`selectTeamDefaultModel` 各 1 次（无新 Host 协议）。
- 私有路径：归档 `lib/*.js` 内 `/Users/`、`/tmp/`、`.dsh/profiles` 命中 0（无本机路径泄漏）。

## 七、可验证范围与未验证清单

已验证：版本契约 RED→GREEN；16/168 真实单测、类型、构建、包契约、空白检查；归档 36 文件逐字节一致与 SHA256；归档内 version 与编译产物行为标记；无第二份 default 表单、无全局自动保存误导文案、无新增 RPC、无本机路径泄漏。

未验证 / 不外推：

1. 未把 0.2.4 安装进任何 profile，未做真实 DSH 冷重启。
2. 未做真实 GUI 点击/E2E：两按钮在真实浏览器里的可点性、混排布局与提示文案观感均未取图。
3. 未触真实 LLM 请求；「保存后下一轮实际换模」仍以 0.2.2/0.2.3 的受控回归（真实 DomainFacility + tests 内 JSON facet）为依据，**不等于**用户进程冷重启或 `pipeline-worker` 真实 `request/header` 已取证。
4. 菜单合并不修 Gemini 网关 schema：上游 400/schema 转换问题与本次 UI 合并无关。
5. 语义边界（用户可见须一致）：未来 default 只影响之后新增成员；批量按钮只作用当前可执行成员且 Lead 不变；成员行仍各自独立 autosave。
6. 遗留覆盖建议（59 提出，未扩测试）：bulk unknown-reload 窗口内按钮2/恢复继承被 `writeGate` 阻断缺判别用例；`pristine` 类判别断言建议同类跟进。
7. 未 commit / push / reset / stash；未改 profile、官方包、bridge；未扫 session 日志或 token。**打包阶段未再修改业务 src 与 README**（本次只动 `package.json`、`package-lock.json`、`tests/package.test.mjs`、本文件与 `lib` 构建产物）——实现阶段的客户端改动见第二、三节（`src/client/*` 与 `tests/client/*`），README 的 0.2.4 版本/路径与双范围说明由实现方（task-58）写入并冻结。
