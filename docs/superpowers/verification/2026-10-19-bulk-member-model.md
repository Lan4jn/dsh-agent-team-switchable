# 验证记录：一键应用到全体非 Lead 队员（0.2.2 打包交付）

日期：2026-10-19 21:18（Asia/Shanghai）
执行者：bulk-tester-ds（共享 task-43，最终 tester / 打包员）
分支 / HEAD：`feature/member-model-autosave` / `aa1d099`（工作树含本轮与既有全部未提交改动，未 commit、未 push、未 reset、未 stash）
授权依据：Lead 按用户规范不执行终端命令，故本文件的每条结论都由本会话真实命令输出支撑。

## 1. 环境与解析版本（真实读取）

| 项 | 值 | 取证方式 |
| --- | --- | --- |
| node | v26.10.0（`/Users/mewcapoo/.local/bin/node`） | `node -v` |
| npm | 11.19.1（`/Users/mewcapoo/.local/bin/npm`） | `npm -v` |
| `@deepseek-ai/dsh-agent` | 0.2.1-rc.2 | `require('./node_modules/@deepseek-ai/dsh-agent/package.json').version` |
| `@deepseek-ai/cordis` | 4.0.5 | 同上 |
| `@deepseek-ai/schemastery` | 3.18.5 | 同上 |
| `@deepseek-ai/dsh-experimental-agent-team` | 0.2.1-rc.2 | 同上 |
| `@deepseek-ai/dsh-client-ui-model-selection` | 0.2.1-rc.2 | 同上 |
| zod / typescript / vitest / esbuild | 4.4.3 / 5.9.3 / 4.1.12 / 0.28.2 | 同上 |
| `node_modules` | 真实目录（非 symlink） | `ls -ld node_modules`、`readlink` |
| `lib` | `realpath` = 本仓库 `lib` | `realpath lib` |

peer 依赖未放宽、未使用 `--force` / `--legacy-peer-deps`，仍锁 DSH 0.2.1-rc.2 / Cordis 4.0.5 / Schemastery 3.18.5。

## 2. 本轮改动范围（仅 task-43 授权文件）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `package.json` | 1 行：`version` 0.2.1 → 0.2.2 | 新功能默认小版本 |
| `package-lock.json` | 2 处 `version` 字段（顶层 + `packages[""]`） | 由 `npm install --package-lock-only` 生成，依赖图零漂移 |
| `tests/package.test.mjs` | 1 行：版本断言 → `'0.2.2'` | 先 RED 后 GREEN |
| `artifacts/bulk-member-model-2026-10-19/dsh-agent-team-switchable-0.2.2.tgz` | 新目录 + 新产物 | 未覆盖任何旧 tgz |
| `docs/superpowers/verification/2026-10-19-bulk-member-model.md` | 本文件 | 新建 |
| `lib/` | 由 `npm run build` / pack lifecycle 重建 | 独占构建（reviewer 已停写） |

未改动：`src/`、`tests/`（除上述 1 行）、`dsh-remote-team-bridge/`、profile、官方 SDK 包。README 的版本/产物路径由 bulk-coder-ds 在 task-41 内完成，本任务未编辑 README。

## 3. 版本契约 RED → GREEN（真实输出）

**RED**（先只把断言改为 0.2.2，package.json 仍 0.2.1）：

```
npm run check            → exit 1
ℹ tests 10 / pass 9 / fail 1
✖ additive bundle inserts only its own root and never disables or replaces official rows
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  '0.2.1' !== '0.2.2'
      at tests/package.test.mjs:43:10
```

**GREEN**（package.json + lock 改为 0.2.2 后重跑）：

```
npm run check            → exit 0
ℹ tests 10 / pass 10 / fail 0 / duration_ms 344.5
```

锁文件只允许版本变化，实测：

```
diff -u /tmp/task43-package-lock.backup.json package-lock.json   → 4 行变化（仅两处 version）
entries before/after: 265 / 265
dep-graph identical: true
resolved count: 264
lock version: 0.2.2 | root: 0.2.2
```

`package-lock.json` 备份为 `/tmp/task43-package-lock.backup.json`（sha256 `ba644dd0…f8c2cf`），未 move/delete 工作区文件；`pnpm-lock.yaml` / `pnpm-workspace.yaml` 旧残留未触碰。

## 4. 全链串行验证（真实 exit）

命令：`npm test && npm run typecheck && npm run build && npm run check && git diff --check`

| 步骤 | 结果 | exit |
| --- | --- | --- |
| `npm test`（vitest run） | **14 test files passed / 145 tests passed**，2.18s | 0 |
| `npm run typecheck`（tsc --noEmit） | 无输出、0 错误 | 0 |
| `npm run build`（scripts/build.mjs） | `Built dsh-agent-team-switchable: additive Host/settings/tools, own types/Typert and browser factory` | 0 |
| `npm run check`（node --test tests/package.test.mjs） | 10 tests / 10 pass / 0 fail | 0 |
| `git diff --check` | 无输出 | 0 |

单文件用例分布（vitest 输出原文）：service 40、bulk-apply 9、settings-controller 5、root 3、domain 3、team-model-summary 4、contribution 4、team-model-editor 21、team-model-action 10、team-model-dialog 10、team-model-bulk 15、slot-runtime 4（另有 model-routing 等文件）。

新增用例 24 个 = `bulk-apply.spec.ts` 9 + `team-model-bulk.spec.tsx` 15；基线 121 → 145。

历史 RED/GREEN 证据由 task-42/task-45 留档（旧实现 `3 failed / 21 passed` 在仓库外 `/tmp/bulk666/red`，修后反向 mutation 在 `/tmp/bulk666/fixed`）。**本文件只引用、未复跑**这两个仓库外镜像，也未把它们当作本轮修后证据；本轮的修后证据是上面第 3、4 节的真实重跑。

## 5. compiled client 真实按钮与真实 RPC 链（非 stub）

对最终 `lib/client.js`（与归档内副本逐字节一致）实测：

```
"bulk.apply" 出现 4 次；bulk.title/hint/model/choose/reselect/running/empty/incomplete/
summary/result.*/skip.* 等 key 全部存在（编译产物内联中英字面量）
"selectMemberModel" 出现 2 次；"selectTeamDefaultModel" 出现 2 次
TODO / FIXME / "not implemented" 命中数：0
applyBulk button wired: true（className: bulkApply，onClick: () => { void applyBulk() }，children: t("bulk.apply")）
```

真实链路（源码 + 编译产物双向核对）：

```
applyBulk()
  → 守卫：eligible && draftValid() && view.members.length>0 && !saving && !bulkRunning
           （disabled 同上，未选/无效/空队列/保存中/批量中均不可点）
  → frozenNames.current = activeNames；targets = frozenTargets(view)（点击时冻结非 Lead 名单）
  → applyToMembers({ targets, selection, activeNames, getView, save: controller.save, reload, alive, report })
  → 逐项 TeamSettingsRejectedError → failed；其他异常 → 先 reload 再判 unknown（不谎称未写入）
  → controller.save(name, selection) → api.selectMemberModel({ leadSessionId, target, selection })
```

- `default` 路径 `api.selectTeamDefaultModel` 只存在于 `controller.save(target === null, …)` 分支；`bulk-apply.ts` 中 `selectTeamDefaultModel` 命中数 **0**，批量不写 Lead、不写未来默认。
- 按钮 disabled 还包含 `state.saving || bulkRunning`，与逐行自动保存共用同一全局锁。

## 6. 打包与归档逐字节比对

```
npm pack --pack-destination artifacts/bulk-member-model-2026-10-19   → exit 0（prepack+prepare 各构建一次 lib）
产物：dsh-agent-team-switchable-0.2.2.tgz
bytes：372968
sha256：18d6434ebd99a4a1612195dc79c168e0e0bf8fe4f79f83e7b0b747f93053fe32
npm 内部 shasum(sha1)：1bcb6567e819f1057903f5f8732ce8055a8e4794
total files：36；unpacked 2.4 MB；package size 373.0 kB
```

解包到 `/tmp/task43-pack-verify` 后对**归档内全部 36 个文件**做 `cmp` + SHA256 双向比对：

```
TOTAL=36  OK=36  DIFF=0  （BYTE_COMPARE_MISMATCHES=0）
归档内 package.json version = 0.2.2
禁止路径检查（tests/ docs/ artifacts/ node_modules/ .superpowers/ *.tgz）：none
```

即 `prepack` 与 `prepare` 两次构建产物一致（可复现），归档内容与最终工作区完全一致。旧产物未覆盖：`artifacts/member-model-autosave/*.tgz`（0.2.0 / 0.2.1）与 `artifacts/dsh-0.2.1-adaptation/*.tgz` 的 mtime、大小与 sha256 均未变。

### 6.1 归档文件 SHA256（工作区 = 归档，36/36 OK）

```
27cb7694c7846def4918e0614a8d1f55a657a72570925207d688843f68d8daa4 OK LICENSE
0b014c642b0a6e281241ec67ca0f64793c38459f1f371053f31255e1f6084d8b OK README.md
ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be OK UPSTREAM-LICENSE
237435ebd4d35d1e8f05c54e919961801c0484b19980c89e45d14c0595b84a9f OK cordis.patch.yml
749e90d3358b52190e0dd25ec1551b1075a900ef7228f0239af2be9408ece0c8 OK lib/client.js
73a2e8021d83186e89a1671e823f9e596731af509b6e0c11ed53f2ba067c26e2 OK lib/index.js
e586e64c64de496505eb57710223fa4558dc5f8b931d3dfc83949d7f851190c6 OK lib/typert.host.d.ts
6a2741f7d4f7cf98769491af0b56042c5542e76c9740784ab2873cc0a8ebe5b9 OK lib/typert.host.js
a635067d4168654f7946455806d2d554da905906a1385eb64c5e8cb80c1faead OK lib/typert.remote-client.d.ts
702d57b322a7e1d761a0b6cb673959aeabcd44325769c42ea3f876a1a5502685 OK lib/typert.remote-client.js
0e51b8725bd410710d42464c05098620809ebdc76fc10f251266f704d06cedcd OK lib/types.js
3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8 OK lib/zod.LICENSE
c4837a980c5e0d01ebf31620cc0e6945bb266c60a8fd9da38664318f85b1efb5 OK package.json
9eebe31891ba2deea0cb29077ef9e14a52fca79403abddba85743239f668a82b OK scripts/build.mjs
26d0acd58441c8f0bdc1c96481a6fb6510feaa3924ae3c0e10ba9f3d40755015 OK src/client/BulkModelPicker.tsx
b1f1347d5af51e6c148c2b1871a441527a919361fe4c9fc596f105f14950e8fb OK src/client/TeamModelDialog.tsx
e9e3e924d378b66b9c924ec2263517b964858e936a700d15547414ab326d04b1 OK src/client/TeamModelEditor.tsx
6e7385be5c96d7ae813f4ab0cb4b36aff3e258b1b202dcadb54651f00c706483 OK src/client/TeamModelSettings.module.css
42d1a4e138798eab20b34f3b714ab330bb0c23aa6a8a7e882363e53d06d403e9 OK src/client/TeamModelSettingsAction.tsx
cd676c141421391431bd0942c74ce18c62fdff003905940f5af9fda28ddee571 OK src/client/TeamModelSummary.tsx
177b31c8b9f2ea9d38a16d21a3fce59c670d907ba8d3d1f5118715c3c4481027 OK src/client/bulk-apply.ts
1b119eae282e4981c7ee24bbcf0ceafe34d57f6d5e6b148b2b7cc7c09cd89513 OK src/client/css-modules.d.ts
a2e125b505e9724e23c96f32f06ad822837a21226ecf748eb2506274ba7d10e0 OK src/client/index.ts
2341c922b311659fe1919ba8f9c00045870701a58cda4f4e02db031c43196430 OK src/client/locales.ts
626dc548942ad3042012c29ddbf2064bae677f7ee8b8d998882b0a44d4822eb3 OK src/client/mount.ts
e65adda8a0059e78eae0cb304e946d6f0b51e67233db1276644b8f71c25d28ad OK src/client/settings-controller.ts
e91ccc60c3db0e09a428495dcb0a9308d985933d14ae96054eeb6fcedbf560b3 OK src/domain.ts
9ca9acc212343343ba295b5ce6219e1c9dd6f31ffc279075612e4924c582facb OK src/error.ts
bdd606defbc77ece9176edb2294c4b6ada3b656ab64a8bec4ac12e7f0e3d117a OK src/host-contract.ts
9433a569160e6dde5e1e16728b7284e8753622a9c75bd98fadd534586da811c6 OK src/index.ts
ea5d0f2a81e8b90aff773b35e44b42773f9727b12ae108a933c1acc1da21e514 OK src/model-routing.ts
b0491f8f4101e7dc4b2020e8a39cd9f140172c541ee87706f37104a23052b6dc OK src/remote.ts
9058a43a6c2c0f2687b95101b1731b2356f6fd02b152a591068cde45d0e98b7e OK src/service.ts
6da5969c24df9a23064565c834c73e5a316941799e6f65cad73099379aca0864 OK src/tools.ts
d4471864c35c47e173f0c395fb786ab3184f795dd98dd5cb1755c39499043723 OK src/types.ts
6a0153d33294eab79206603b9acb503af1c9136029c6dc2849e646cf961f394f OK tsconfig.json
```

## 7. 边界：本文件**不**声称的内容

- **未安装到 GUI / profile**：没有把 0.2.2 包装进当前 profile，没有热替换正在运行团队所用插件。用户只要求写按钮，安装动作留给空闲维护窗口（冷重启 + 刷新原 GUI）。
- **未发真实 LLM 请求**：全部验证走本地 fixture / 真实 SDK 类型与 resolver，没有向任何模型端点发起调用，因此**不声称实际换模已发生**。功能语义仅为「设置已保存，下一轮 turn 生效」。
- **未做真实浏览器 E2E**：没有浏览器自动化交互点击该按钮；控件正确性由 vitest + jsdom 行为用例、编译产物探针（按钮 key、onClick 接线、RPC 方法名）与打包契约共同支撑。
- **未验证**当前会话正在跑的团队在切换后下一轮的真实路由；`default`（未来新增成员默认）与 Lead 均不被批量写入，这一点由代码路径与用例断言证明，而非线上观测。
- **未 commit / push / reset / stash**：工作树保留全部既有 dirty；`dsh-remote-team-bridge/`（仅既有两个未跟踪交接文档）与 `src/` 未由本任务改动。
- 任务 44/45/46 的报告与设计计划（`docs/superpowers/specs/2026-10-19-bulk-member-model-design.md`、`docs/superpowers/plans/2026-10-19-bulk-member-model.md`）为并行文档产物，本文件不重复其内容，也不把其修前 RED 当作修后证据。
