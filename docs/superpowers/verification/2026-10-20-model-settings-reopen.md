# 验证记录：菜单重开回填与受控持久化冷恢复（0.2.3 打包交付）

日期：2026-10-20 · 版本：0.2.2 → 0.2.3 · 执行：persistence-tester（task-56）· 独立复审：bulk-reviewer-ds（task-55）

## 一、结论摘要

- 0.2.3 只新增客户端「批量草稿重开回填」与前序已合入的逐成员保存能力，Host 侧路由算法、Domain 规格、官方插件与 profile 均未改动。
- 版本契约、全链（test/typecheck/build/check/diff --check）与打包在本文件记录的命令下真实通过；产物与新目录无覆盖旧 tgz。
- **仍有两类事实未取证，不得外推**：① 用户真实 `pipeline-worker` 成员的 `request/header` 未取证，因此「该成员下一轮是否真的换了模型」仍未验证；② 未安装到 profile，未做真实 GUI E2E，官方团队弹层/创建卡显示的是创建期静态 `options.model`，本次不声称修好上游路由或修改官方显示。

## 二、51/52 根因：已证与未证边界

已证（52 只读调查 + 54 受控回归共同支撑）：

1. 持久化真实且 durable：`storageDomain.open(settingsDomainSpec)` 打开 `agent_team_model_settings`（v1），真实磁盘 `~/.dsh/storages/agent_team_model_settings.json` 中 team 记录含 `revision/defaultModel/initials/choices`，`choices` 带 `selection + effectiveAfterTurn`，冷启动可由 `loadAll` 恢复。
2. 已安装 0.2.2 的 `lib/index.js` 与工作区构建产物 sha256 相同（`73a2e802…`），运行时逻辑不存在旧版差异。
3. 官方 roster/`memberView()` 的 model 取 `live?.options.model ?? root.options.model`——创建期 `AgentOptions` 静态值；本插件不改 `options`，只经 `installModelSelection` 的 assemble/request waterfall 覆盖。**截图/弹层显示的旧模型是显示源问题，不能当作「覆盖未发生」的证据**。
4. 本插件的真实通道是 `service.view()` 的 `currentModel`，取自该成员 own `request/header` 的 config。
5. 代码级无「turn/start 早于监听」或「choices 恢复后不再应用」的缺口；54 的受控回归进一步证明 eff 边界与恢复语义成立。

未证（本次不外推）：

- 截图所指团队/成员的真实 `request/header` 未取证（不扫 sessions、不调业务读），因此「下一轮确实用了新模型」仍属未验证。
- 18 条历史记录中没有任何 choice 指向 `cm-oai/gpt-6.1-sol`，与截图相容，但不能据此断言就是该团队/成员。
- 51 的「重开菜单回默认」由 53 的 UI 修复与回归覆盖（见下节），但同样未做真实 GUI 观测。

## 三、53 新 UI 行为（RED/GREEN）

实现要点：`bulk-apply.ts` 的 `agreedSelection` 只汇总 `phase==='active'` 且仍在 `activeNames` 的可执行成员，比较 `nextModel ?? currentModel`；空集为 `none`、不一致为 `mixed`。`TeamModelDialog` 用 `bulkSelection: undefined` 表示「跟随 view」，实际公式是三态：`effectiveSelection = bulkSelection === undefined ? backfill : bulkSelection`——`null`（用户清空）必须保留为空，写成 `??` 会把清空误回填。backfill 仅当 `knownSelection`（当前目录仍存在该 route+effort）才生效。`BulkModelPicker` 的 `initial` 仅 display-only、非 RPC ack；`pristine` 只在未手编辑时跟随 initial，**所选模型或 effort 从模型目录下架**（picker 的 retired 指 model catalog，不是成员 `phase`）时 `pristine=false` + 清空 + `onChange(null)`。

55 用 `/tmp` 隔离副本改副本并 `diff -q` 还原，取得真实 RED：

- 置 backfill 恒 `null` → `backfills the saved route after closing and reopening the same menu` FAIL（`expected '' to be '["p","new"]'`）。
- 把 `mixed` 当 agreed → `asks for a choice instead of a default when members disagree` FAIL。
- 去掉 picker 的 `pristine` 判断 → 该场景**仍绿**（建议项：`pristine` 目前缺判别性断言，其作用仅在「草稿因退休被清空后不被仍合法的 view 共识重新回填」）。

GREEN：客户端测试 93 项（其中 53 新增 11），全量见第五节。

## 四、54 受控持久化/冷恢复回归层级（如实标注）

- 真实部分：`defineDomain` 规格 + zod 记录校验 + `DomainFacility.open/close` + 每单元写链；真实 Cordis `Context`、真实 plugins `apply()`、真实 scoped carrier（`createScope`/`scopeTarget`）、真实 serial `agent/created`、真实 `session/event` 分发。
- **模拟部分**：介质是本仓库 `tests/backend/durable-support.ts` 内的 JSON KV facet（每 unit 一个文档、tmp 目录、tmp+rename 原子写、`single` layout），原因是当前 workspace 未安装官方 file/sqlite backend 包。因此**这不是用户 DSH 进程冷重启**，也不触碰用户 `storages/`、profile。
- 用例 1：boot（`agents.list` 空）→ 真实 RPC `selectMemberModel` 写入 `{selection, effectiveAfterTurn:1}` → 断言**磁盘上**该 choice → 同 turn 再次 `turn/start` 不改本轮 → 卸载 plugin/关域 → 新 `DomainFacility` + 新 `Context` 同目录重开（仍空 agents，只靠 `agent/created` attach）→ eff 前 assemble 仍 oldRoute、`getSettings` 报 `currentModel=oldRoute, nextModel=chosen, defaultModel=null` → turn 2 起连续两步为 chosen → Lead 路由保持官方继承。
- 用例 2：重开前删掉磁盘上的 `choices` → 冷恢复保持官方继承（turn 2 也仍是旧模型），`getSettings` 无 `nextModel`，证明不会把上一轮请求或 default 伪造为选择。
- RED（隔离副本 mutation，改 `src/model-routing.ts` 后字节级 `cmp` 还原，sha256 `ea5d0f2a…21e514`）：`observe` 不读 durable choice → 用例 1 FAIL（`{q/next} ≠ {p/old}`）；`>` 改 `>=` → 用例 1 FAIL（提交当轮被抢占）；`attach` 忽略 choices → 未 FAIL，该路径由 `observe` 兜底（防御纵深，非缺口）。
- 冻结 hash：`durable-support.ts` `25057ad3b601a7cfbf487b4953372f80f510b763bc3cf6659fd927e80cefdb05`、`durable-recovery.spec.ts` `d45a4c12c717937e0e760b5c24158809401494ebc57f22c11c07c6f3090593c8`。

## 五、55 独立复审实测

`npm test` 15 files / **158 passed**（53 新增 11 → client 93；54 新增 2 → backend 65）、`typecheck` exit 0、`build` exit 0、`check` 10/10 exit 0、`git diff --check` exit 0；54 冻结 hash 复核一致，`src/model-routing.ts` 无 mutation 残留。结论：无阻塞，可交最终打包；2 条非阻塞建议（`pristine` 缺判别性断言、README 已写 0.2.3 而 manifest 仍 0.2.2 待本次收口）。

## 六、56 版本契约与打包

版本 RED（先只改断言，manifest 仍 0.2.2）：

```
$ npm run check
AssertionError [ERR_ASSERTION]: '0.2.2' !== '0.2.3'   → exit 1
```

GREEN（`package.json` 与 `package-lock.json` 仅改顶层/根 version 各 1 处，依赖图未动；pnpm 旧锁未改；未 force/legacy-peer）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 单测 | `npm test` | 15 files / 158 passed，exit 0 |
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build` | exit 0（独占构建，未与 55 并行） |
| 包检查 | `npm run check` | 10/10 pass，exit 0 |
| 空白检查 | `git diff --check` | exit 0 |

SDK 基线未漂移：DSH `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`；`package.test.mjs` 的 peer 断言仍绿。

产物（新目录，未覆盖任何旧 tgz）：

- 路径：`artifacts/model-settings-reopen-2026-10-20/dsh-agent-team-switchable-0.2.3.tgz`
- SHA256：`b7cd7385eafb49e6bf161982cc481965b91801c74dc78010bcca563356924b11`
- 大小：374565 bytes · 归档 **36** 个文件（`entryCount: 36`，`bundled: []`）
- 归档内 `package.json` version = `0.2.3`；归档内 README L27 为 53 作者冻结句「草稿未被手动编辑时随当前团队设置同步；用户编辑或目录失效清空后不被后台回填覆盖」。
- 逐字节核验：解包后对 36 个文件逐个 `cmp` 与当前工作区同路径文件比对，**mismatch=0**；`lib/client.js` 内含 `pristine` 守卫（5 处）与 53 新 UI 构建产物，`src/client/BulkModelPicker.tsx`、`src/client/bulk-apply.ts` 均在包内，构建链与源码一致（无 unchanged 跳过）。

## 七、未验证清单（不得外推）

1. 未把 0.2.3 安装进任何 profile；未做真实 DSH 冷重启。
2. 未做 GUI E2E/截图核验；官方团队弹层与创建卡仍显示创建期静态 `options.model`，可能继续显示旧模型——这不是本次修复目标，也未修改官方显示。
3. 用户 `pipeline-worker` 的真实 `request/header` 未取证，不宣称其真实请求已换模。
4. 54 冷恢复为受控 fixture 层级（真实 Domain 层 + tests 内 JSON facet），不等于用户进程冷重启。
5. 未提交、未推送、未 reset/stash、未改 profile/官方包/bridge，未读取额外 session 或 token。
