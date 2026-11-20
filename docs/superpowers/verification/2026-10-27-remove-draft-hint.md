# 0.7.4 移除草稿提示与随包说明验证

日期：2026-10-27；执行：effort-verifier-flash；任务：80（用户只说「打包」）。
工作区：`/Users/mewcapoo/Projects/dsh-team-member-model`。

## 变更（唯一业务改动来自源码作者，非本任务）

`lib/client.js` 的 `SharedPicker` 第一行：删除说明文字 `选择模型草稿（修改草稿不自动保存）`，该行改为 `h("div", { className: "tmm-team-row", style: { justifyContent: "flex-end" } }, …服务提供方…)`，即「服务提供方」靠右；第二行 `模型 + 思考档位` 与下方双按钮不变。相对 0.7.3 包的行级 diff = `-1 行 span`、`+0 新增`，无其它业务改动。

同时把此前已写好但未随包发布的 `docs/model-routing-guide.md`（14110 字节）加入 `package.json` 的 `files`，让安装包自带使用说明：`files` 由 11 项变 12 项，归档文件由 12 个变 **13 个**。

## 版本与契约

- `package.json`：`0.7.3` → `0.7.4`；`files` 增 `docs/model-routing-guide.md`。
- `test/package.mjs`：版本断言改 0.7.4，期望文件清单增 `docs/model-routing-guide.md`（含磁盘存在性断言）；实测 `tests 6 / pass 6 / fail 0`。
- 旧包不覆盖：`artifacts/{team-integration-2026-10-26, skill-source-fix-2026-10-27, skill-source-hotfix-2026-10-27, effort-picker-2026-10-27, bulk-apply-layout-2026-10-27}/` 内 0.7.0/0.7.1/0.7.2/0.7.3 全部保留。

## 测试与语法

- 逐文件 `node --check`：`lib/index.js rules.js usage.js skill.js team-state.js team-routing.js client.js` → 7/7，exit 0。
- 全量 8 个明确文件一次（见下），结果见「验收结论」。`test/team-client.mjs` 的布局用例按用户本次要求做了一处最小更新（Lead 已批准）：标题改为「服务提供方独占第一行靠右、无草稿提示…」，断言由「第一行 2 个孩子 + 含说明文字」改为「第一行 1 个字段 = 服务提供方 + `justifyContent: 'flex-end'` + 整树不含『选择模型草稿』」，其余断言原样保留；`team-client` 26/26。

## 归档校验

- `npm pack --ignore-scripts --pack-destination artifacts/remove-draft-hint-2026-10-27`，exit 0。
- 解包后 13 个文件与冻结工作区逐一 `cmp`，并核对：`package.json` version=0.7.4、`source: 'team-member-model'` 存在、`lib/client.js` 不含「选择模型草稿」、`docs/model-routing-guide.md` 在包内。
- SHA256 与字节数见「验收结论」。

## 验收结论（真实输出）

- `node --test` 8 文件（smoke / apply / client / team-state / team-host / team-client / team-integration / package）：**Node TAP 56/56 pass，exit 0**（其中 team-client 26/26）。业务检查组 162 = 109 个 `check()` + 53 个原生 `test()`（非 assert 调用数）。
- `node --check` 7 个 lib 文件逐文件：7/7，exit 0。
- 归档：13 个文件（`tar -tzf | wc -l` = 13），解包后与冻结工作区逐一 `cmp`：**13/13 SAME**；`package.json` version=0.7.4、`files` 12 项且含 `docs/model-routing-guide.md`；`lib/index.js` 含 `source: 'team-member-model'` 1 处；`lib/client.js` 不含「选择模型草稿」、含 `justifyContent: "flex-end"` 1 处。
- 产物：`artifacts/remove-draft-hint-2026-10-27/dsh-team-member-model-0.7.4.tgz`；**134199 字节**；SHA256 `481d551a110b30ad9ef455c6a13d67e5597c45bee18b63a4f3a346c001b487e9`。
- 旧包未覆盖：0.7.0/0.7.1/0.7.2/0.7.3 归档目录保持原样（0.7.2 `9bfb28fe…`、0.7.3 `95b97d60…` 哈希未变）。

## 边界

未安装到 profile、未重启、未做真实 GUI 交互、未调用付费 LLM、未改规则/团队数据/官方源码/原 `dsh-agent-team-switchable`、未 commit/push；归档校验为字节级，`cmp` 只证明"包内文件 == 当前工作区"，不证明运行期渲染效果。
