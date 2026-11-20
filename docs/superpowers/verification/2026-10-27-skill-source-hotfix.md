# 0.7.1 技能 source 热修复验证

日期：2026-10-27；执行：persistence-tester；任务：73。

| 项目 | 实测证据 |
| --- | --- |
| 独立契约核对 | Host Inspect skills.register 接收 SkillRegistration；继承 SkillSummary 必需 source:string。允许自定义非空来源字符串。 |
| 修复复核 | lib/index.js installSkill 实际 register 对象包含 source:'team-member-model'、content:skill.content；保留注册返回 disposer 的 effect 清理。未改业务源码。 |
| 回归覆盖 | task72 在 test/apply.mjs 实际注册出口增加 source 类型、非空、精确来源及卸载 disposer 检查；仍为原43检查组。缺source隔离mutation RED由72执行，本轮未重复修改源码。 |
| 版本 RED | test/package.mjs 期望0.7.1，manifest仍0.7.0时：5 pass/1 fail，exit1，唯一失败为版本。 |
| GREEN | 更新manifest至0.7.1；8文件全量测试：Node TAP42 tests/42pass/0fail，exit0。统计为109旧检查组+39原生用例=148业务检查组，非148条assert调用。 |
| 语法 | 对lib/*.js逐文件 node --check，7/7，exit0。 |
| 打包 | npm pack --ignore-scripts --pack-destination artifacts/skill-source-hotfix-2026-10-27，exit0。 |
| 归档 | 12文件逐字节与当前工作区比较，0差异；归档installSkill实际包含source:'team-member-model'。 |

全量命令：
```bash
node --test test/smoke.mjs test/client.mjs test/apply.mjs test/team-state.mjs test/team-host.mjs test/team-client.mjs test/team-integration.mjs test/package.mjs
```

产物：`artifacts/skill-source-hotfix-2026-10-27/dsh-team-member-model-0.7.1.tgz`

大小：123050 字节。

SHA256：`f88bf6ac355922eeb0eb5d858221d2d500d47b0b2c4cbb8b604267d9b9b5ebd6`。

旧10-26版本0.7.0归档未覆盖；本次仅更新package.json、test/package.mjs版本、README短说明、新验证记录与新归档。

边界：Lead已报告当前Host的model-routing技能实时加载成功；本轮独立验证为Inspect契约与离线apply/mock回归，不代表所有会话、重启、真实GUI或真实LLM已验证。未操作profile/core、重启或调用付费LLM。安装建议为空闲维护窗口通过官方插件管理界面升级包，不直接修改profile。
