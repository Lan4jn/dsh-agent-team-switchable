# 0.7.3 批量应用名单三态与设置面板布局验证

日期：2026-10-27；执行：effort-verifier-flash；任务：78（最终 review + release；76 源码已冻结，77 反向诊断已完成）。
工作区：`/Users/mewcapoo/Projects/dsh-team-member-model`。验收对象：`lib/client.js`（相对 0.7.2 +134/−… 行）+ `test/team-client.mjs`（26 例）。

## 结论

0.7.2 的「应用到当前队员不生效」根因已在客户端侧定位并修复，Host 侧无需改动：`TeamAction` 过去把「官方投影未就绪」与「投影里确实没有活动队员」都折成 `activeNames = []`，于是所有队员被判「未在活动名单内」——成员卡不可编辑、批量零 eligible、点击一次 PUT 都不发。0.7.3 改为三态（`undefined` = unknown / 数组含 `[]` = 已知名单 / Lead 排除），并对每条成功 PUT 立即回读视图，布局按截图重排、思考档位常驻置灰。独立同 fixture A/B 证明 0.7.2 失败与 0.7.3 成功出自同一组输入，且 `known []` 与 Lead 均零写入。

| 项目 | 实测证据 |
| --- | --- |
| 源码审查 | `lib/client.js:1865-1870` `isEligibleMember`：先 `role==='lead'‖name==='lead'` 返回 false，再 `activeNames===undefined` → true（unknown fallback）、数组严格 `indexOf`；`deriveBackfill`/`applyBulkMembers` 不再用 `|| []` 抹平 unknown；`TeamAction` 仅在 `team.members` 非数组时传 `undefined`，`members` 存在但过滤为空保留 `[]`。 |
| 回读与 CAS | `lib/client.js` bulk `saveMember` 每条成功后 `patchState({view})`，CAS revision 由回包逐条推进，无静默重试；`BulkResultsSummary` 新增零写入分支（`当前没有活动队员，未写入任何设置` / `没有可应用的队员…`）。 |
| 布局 | `SharedPicker` 改为 `.tmm-team-grid`：第一行 `说明 + 服务提供方`，第二行 `模型 + 思考档位`，`tmm-team-btns` 在下方；`effortField` 常驻 `select`，`disabled||!ready`，占位文案区分 `先选模型` / `正在读取档位…` / `读取失败（不会发送未确认档位）` / `该模型未公布档位`。 |
| 同 fixture A/B（真 Host handler + 真组件，隔离 temp DSH_HOME） | 同一 Host 视图 w1/w2（均 active）、同一默认 `deepseek-official/deepseek-flash high`：**0.7.2（installed 字节 3a17…）+ `[]`** → 成员卡可编辑 0、批量按钮 disabled、点击 `changed=[]`、`rev 0→0`（用户"不生效"复现）；**0.7.3 + `undefined`** → 可编辑 2、按钮可用、点击 `rev 0→2` 且 `m1/m2 next=deepseek-flash/high`；**0.7.3 + `[]`** → 提示「官方名单里当前没有活动队员」、`changed=[]`、`rev 2→2`（零写入）。 |
| 下一轮真路由 | 真 Host 落库后，真 `lib/team-routing.js resolveTeamRoute(turn = effectiveAfterTurn+1)` 对 m1/m2 均为 `memberoverride deepseek-flash/high` → Host 保存与下一轮生效路径正确。 |
| Lead 保护 | Host `buildTeamView` 只取 `role==='teammate'`；客户端 `isEligibleMember` 再挡 `role/name==='lead'`，两处同时成立才可写。 |
| 真实 SDK 形状 | `app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:649-659` 投影 schema `{id,name,role:lead|teammate,phase:provisioning|active|failed,error?}`；`:684-697` 构造 `members=[lead(role lead), …队员]` —— 0.7.2 的 role/phase 过滤本身不错，错在 unknown 被折成 `[]`。 |
| 测试 | `node --test test/team-client.mjs`：26/26 pass。全量 8 个明确文件一次：**Node TAP 56/56 pass，exit 0**（业务检查 162 = 109 个 `check()` 组 + 53 个原生 `test()`，非 assert 调用数）。 |
| 语法 | 逐文件 `node --check`：`lib/index.js rules.js usage.js skill.js team-state.js team-routing.js client.js` → 7/7，exit 0。 |
| 版本契约 | `test/package.mjs` 期望 0.7.3 而 manifest 仍 0.7.2：`tests 6 / pass 5 / fail 1`（唯一失败为版本 `'0.7.2' !== '0.7.3'`）→ 改 `package.json` 0.7.3 后 6/6 pass。 |
| 打包 | `npm pack --ignore-scripts --pack-destination artifacts/bulk-apply-layout-2026-10-27`，12 个文件，exit 0，128296 字节。 |
| 归档一致性 | 解包后 12 个文件与冻结工作区逐一 `cmp`：12/12 SAME，0 DIFF。 |
| 包内关键内容 | `lib/index.js` 含 `source: 'team-member-model'` 1 处（0.7.1 技能修复未退化）；`lib/client.js` 含 `isEligibleMember`/`effortPlaceholder`/`rosterUnknown`/`没有活动队员` 共 12 处；`package.json` = `dsh-team-member-model@0.7.3`、`files` 11 项。 |
| 入口可加载 | Node ESM `import lib/index.js` → `apply: function`、`name: team-member-model`；Client 以 `__ModuleLoader__.load` 沙箱加载 → `id: dsh-team-member-model`、`factory: function`（未引入新构建链/依赖）。 |
| 旧产物未覆盖 | 0.7.2 `9bfb28fe…`、0.7.1 `f88bf6ac…` 哈希与本轮前一致。 |

产物：`artifacts/bulk-apply-layout-2026-10-27/dsh-team-member-model-0.7.3.tgz`

SHA256：`95b97d6032713b240454468eafefa6c2a6e253218b46d5f04e7bfe2991b1acad`

字节：128296。

全量命令：

```bash
node --test test/smoke.mjs test/apply.mjs test/client.mjs test/team-state.mjs test/team-host.mjs test/team-integration.mjs test/team-client.mjs test/package.mjs
```

## 边界（未验证即不宣称）

1. **未在真实浏览器点击/目视**：GUI 52544 的 Client Inspect 超时未连上，本轮证据是 VM 内真实 `lib/client.js` 单 factory（真实组件树、真实事件 handler）+ 隔离真 Host handler 的 click→HTTP→readback→next-turn；两行布局是节点结构与 CSS 规则级核对，不代表实际渲染像素。
2. **`unknown` 分支是机制级结论**：我无法读取用户浏览器里的实际 `agentTeam` 投影（`/teams` GET 对我方 session 返回 403），因此「用户现场当时确实是 unknown」不作为已观察事实；可确证的是 0.7.2 的 `[]` 路径必然零写入。
3. 未安装 profile、未重启、未改规则/团队数据/原 `dsh-agent-team-switchable`、未调用付费 LLM、未 commit/push；未扫描用户日志或凭据。
