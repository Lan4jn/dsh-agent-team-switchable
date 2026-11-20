# 0.7.2 思考档位选择器验证

日期：2026-10-27；执行：effort-verifier-flash；任务：75（承接 74 冻结源码）。工作区：`/Users/mewcapoo/Projects/dsh-team-member-model`。

## 结论

独立审查未发现阻塞缺陷。用户要求的「设为新队员默认」右侧思考档位下拉由真实 metadata 驱动，未公布档位的模型（截图所用 `gemini/gemini-3.8-flash-high`）不占位；显示、回填、发送校验同源；默认项省略 `reasoningEffort`；`writeGate` / CAS、双按钮与逐成员自动保存语义未变。0.7.1 的技能 `source` 修复与 Host 侧代码原样保留（`lib/index.js` 等 6 个 Host 文件与 0.7.1 包逐字节相同）。

| 项目 | 实测证据 |
| --- | --- |
| 审查范围 | `lib/client.js`（相对 0.7.1 +145/−59 行，5 处行为改动）+ `test/team-client.mjs` 新增 8 例；`lib/index.js`/`skill.js`/`rules.js`/`usage.js`/`team-state.js`/`team-routing.js` 与 0.7.1 包 `cmp` 全部 SAME。 |
| 数据源根因（真实 Host） | `GET /state` 的 `catalog[].models[]` 实际只有 `id`/`name`，无 `efforts` 字段；档位只来自 `GET /api/dsh-team-member-model/efforts?provider=&model=`（Host `llm.resolveModelInfo().reasoning`，只读、无 LLM 调用）。 |
| 真实 metadata：应隐藏 | `gemini/gemini-3.8-flash-high` → `{"efforts":[],"supported":true}`（与用户截图模型一致）。 |
| 真实 metadata：应显示 | `deepseek-official/deepseek-flash` → `off/low/high/max`，`defaultEffort:"high"`（模型真公布，非名字猜测）。 |
| 旧实现 RED（非人造） | 用 `artifacts/skill-source-hotfix-2026-10-27` 解出的 0.7.1 `lib/client.js` 跑新测试：`tests 20 / pass 11 / fail 9`（8 个新档位用例 + 改写后的 `checkDraftValidity` 用例），旧 12 条仍绿。 |
| 反向 mutation A | 把 `selectionOf` 改回总是写 `reasoningEffort: ""` → 「默认项省略 reasoningEffort」FAIL（20 中 1 fail），证明省略语义被真测。 |
| 反向 mutation B | 把 `patchEfforts` 改成整表覆盖（丢掉其他 key）→ 「A 的迟到响应不能污染 B」FAIL（20 中 1 fail），证明按 `provider/model` 分 key 的隔离被真测。 |
| 交互位置 | `tmm-team-btns` 行内元素为 [应用到当前队员, 设为新队员默认, 思考档位 select]；`efforts` 为空时行内只有 2 个元素、无 `.tmm-team-effort` 占位。成员卡片复用同一 bank，未另建选择器。 |
| 校验/写入同源 | `checkDraftValidity(draft, catalog, efforts)` 读同一 bank：loading/error/未知值一律不允许写入（零 PUT），继承来的旧值仍可见并标注「当前值，模型未公布」；`selectionOf` 让空档位省略字段。 |
| 版本契约 RED→GREEN | `test/package.mjs` 期望 0.7.2 而 manifest 仍 0.7.1：`tests 6 / pass 5 / fail 1`（唯一失败为版本）→ 改 `package.json` 0.7.2 后 `6/6 pass`。 |
| 语法 | `node --check` 逐文件（非 glob）：`lib/index.js rules.js usage.js skill.js team-state.js team-routing.js client.js` 7/7 通过，exit 0。 |
| 全量测试 | 8 个明确文件一次：`tests 50 / pass 50 / fail 0`，exit 0。业务检查 156 项 = 109 个 `check()` 检查组（smoke 37 / apply 43 / client 29）+ 47 个原生 `test()`，非 assert 调用数。 |
| 打包 | `npm pack --ignore-scripts --pack-destination artifacts/effort-picker-2026-10-27`，12 个文件，exit 0，125902 字节。 |
| 归档一致性 | 解包后 12 个文件与冻结工作区逐一 `cmp`：12/12 SAME，0 DIFF。 |
| 包内关键内容 | `lib/index.js` 含 `source: 'team-member-model'` 1 处；`lib/client.js` 含 `fetchEfforts/ensureEfforts/patchEfforts` 及 `/efforts?provider=` 异步链路；`package.json` = `dsh-team-member-model@0.7.2`、`files` 11 项。 |
| 旧产物未覆盖 | 0.7.1 `f88bf6ac…`（与上轮记录一致）、0.7.0 两份 sha256 与本轮前相同。 |

产物：`artifacts/effort-picker-2026-10-27/dsh-team-member-model-0.7.2.tgz`

SHA256：`9bfb28fe6221d0c3f759d038f8af2bac2fccf5b14450591172b8215142a40337`

字节：125902。

全量命令：

```bash
node --test test/smoke.mjs test/apply.mjs test/client.mjs test/team-state.mjs test/team-host.mjs test/team-client.mjs test/team-integration.mjs test/package.mjs
```

## 边界（未验证即不宣称）

1. **未安装当前 profile、未重启、未在真实 GUI 复验**：截图中的「红框位置」本轮只在 VM/组件级（真实 `lib/client.js` 单 factory + 模块加载器沙箱）验证元素结构，不代表真实浏览器渲染、暗色主题或换行表现；需空闲维护窗口装包冷重启/刷新后目视确认。
2. 档位 bank 按 `provider/model` 存在会话内存中，不随 Host `EFFORT_TTL` 过期、也不轮询；同一会话内模型公布档变化不会自动刷新（关闭重开面板即重建）。
3. 本轮未调用任何付费 LLM；metadata 为 `llm.resolveModelInfo` 只读解析。未改 profile、未改规则/团队数据、未动原 `dsh-agent-team-switchable`、未 commit/push。
