# 适配模型设置插件到 DSH 0.2.1-rc.2 实现计划

日期：2026-10-18
目标版本：DSH 0.2.1-rc.2 / Cordis 4.0.5 / Schemastery 3.18.5
插件版本：0.2.0 -> 0.2.1

## 1. 目标与范围

独占根包适配，保留所有既有未提交 autosave 改动，禁止修改 `dsh-remote-team-bridge/` 及任何交接文档。
不执行 git reset / clean / stash / commit / push，不安装至宿主 profile。

## 2. 执行步骤

- [x] **步骤 1：TDD 版本契约测试先红**
  - 修改 `tests/package.test.mjs` 中的版本断言，要求 manifest 版本为 `0.2.1`、peerDependencies 满足 `0.2.1-rc.2`。
  - 运行 `npm run check`，验证红灯失败。
- [x] **步骤 2：更新根包清单与依赖安装**
  - 更新 `package.json`：
    - `version`: `0.2.1`
    - `peerDependencies` 中 `@deepseek-ai/*` 升级至 `0.2.1-rc.2`，`@deepseek-ai/cordis` 升至 `4.0.5`，`@deepseek-ai/schemastery` 升至 `3.18.5`。
    - `devDependencies` 中 `@deepseek-ai/*` 升级至 `0.2.1-rc.2`。
  - 执行 `npm install --registry=https://registry.npmjs.org/`，更新 `package-lock.json`。
  - 检查并验证 `node_modules` 中实际 resolved 的版本确为 0.2.1-rc.2。
- [x] **步骤 3：源码与测试类型/生命周期检查及最小修复**
  - 运行 `npm run typecheck`。
  - 运行 `npm test`，若新 SDK 存在破坏性类型或调用契约变更，执行最小代码适配。
- [x] **步骤 4：验证绿灯与打包检查**
  - 运行 `npm run check`，验证版本契约绿灯通过。
  - 完整执行 `npm run typecheck && npm test && npm run build && npm run check && git diff --check`。
- [x] **步骤 5：同步 README 版本说明**
  - 更新 `README.md` 中目标版本为 `0.2.1-rc.2`，记录 0.2.1 补丁版本。
- [x] **步骤 6：汇报证据并交回 Lead 打包**
  - 汇总 RED/GREEN 日志、resolved SDK 版本清单、测试计数与 exit code。
