# 验证记录：团队模型能力合并与统一路由引擎（0.7.0 打包交付）

日期：2026-10-26 · 版本：0.6.1 → 0.7.0 · 执行：persistence-tester（task-71）· 协作团队：bulk-planner-ds (63/70), bulk-coder-ds (66), ui-coder (67), bulk-reviewer-ds (69)

---

## 一、交付结论与全量事实摘要

1. **架构收敛**：成功将 `dsh-agent-team-switchable` 的团队模型管理能力无缝合并入 `dsh-team-member-model`（版本升级至 `0.7.0`）。消除了旧 switchable 的独立 `installModelSelection` waterfall，确立 Host 单一决策点与严格 5 级路由优先级体系。
2. **前后端接口对齐**：通过 `ctx.webServer` 在 `/api/dsh-team-member-model/teams` 暴露统一 GET/PUT 端点，带 `x-dsh-team-member-model: 1` 防跨站，严格使用不可变 `memberId`，杜绝同名混淆；通过 CAS 乐观锁版本号校验防乱序写覆盖。
3. **客户端交互单文件交付**：前端收敛于 `lib/client.js`（2486 行），注册公共插槽 `conversation.session.header.actions`（`order: -19`）；实现单一共享选择器、双主按钮（当前队员 / 未来默认）、只读默认 summary + 轻量恢复继承链接、成员独立自动保存及 `writeGate` 单层并发互斥锁。
4. **测试与打包契约**：编写 `test/package.mjs` 实现 0.7.0 契约 RED→GREEN；全量执行 `node --check` 语法检查（7/7 纯 JS 通过）及 8 个测试文件（42 个 Node TAP 测试，共 148 项业务断言全绿，退出码 0）；产出 `artifacts/team-integration-2026-10-26/dsh-team-member-model-0.7.0.tgz`，归档 12 个文件与工作区同路径逐字节比对 0 mismatch，无任何本机私有路径泄漏。

---

## 二、需求映射与任务链事实（task 63-71）

| 任务 | 负责人 | 核心产出与事实依据 |
| --- | --- | --- |
| **task-63** (设计) | bulk-planner-ds | 输出 `2026-10-26-team-integration-design.md` 与 plan，确立单一 Host 决策点、5 级优先级、teams HTTP 端点与双主按钮交互契约。 |
| **task-66** (Host 实现) | bulk-coder-ds | 实现 `lib/team-state.js`、`lib/team-routing.js`、改造 `lib/index.js`，接入 `agent/request` 统一拦截、`session/event(team/member)` 默认快照预约与 `agent/created` 原子落盘。 |
| **task-67** (UI 实现) | ui-coder | 实现 `lib/client.js`，挂载 `conversation.session.header.actions` 插槽，实现 `BulkModelPicker` 状态回填、双主按钮、恢复继承及 `TeamController`，并移除中间过渡文件。 |
| **task-68** (独立集成测试) | persistence-tester | 新建 `test/integration-support.mjs` (410行) 与 `test/team-integration.mjs` (701行)，以黑盒方式覆盖 12 个关键端到端 Case，协同修复 validateSelection 裸 return 与覆盖清除缓存残留等缺陷。 |
| **task-69** (独立复审) | bulk-reviewer-ds | 独立执行全链路审计与行为 mutation 验证，定位并推动修复 initials 内存未落盘（P1）与鉴权 fallback 越权（P1）两项缺陷。 |
| **task-70** (文档与说明) | bulk-planner-ds | 更新 `README.md`、`docs/spec.md` 与 `给测试者.md`，明确 0.7.0 统一架构、本地包安装推荐与旧 Windows 脚本 legacy 边界。 |
| **task-71** (验证与打包) | persistence-tester | 编写 `test/package.mjs`，更新 `package.json`，全量执行语法检查、自动化套件及 npm pack 归档核验。 |

---

## 三、核心机制与安全边界验证

### 1. 5 级路由决策体系
- **Level 1: `memberoverride`**：由团队菜单针对特定成员写入的覆盖记录。当 `turn > effectiveAfterTurn` 时生效；手动固定路由 `candidates = [route]`，`isManualFixed = true`，遇到 500/429 绝不自动回退重试，直接抛回官方流程。
- **Level 2: `createexplicit`**：创建子代理/成员时参数显式指定的模型（要求必须带非空 `model` 字段；`{}` 空对象守卫严格生效，不误判）。手动固定路由无回退。
- **Level 3: `captureddefault`**：创建时刻从所属团队 `defaultModel` 捕获的初始快照（`initials[member.id]`）。即使后续修改团队默认，已有成员依然锁定当时快照，杜绝被最新默认回退污染。
- **Level 4: `auto`**：由 `lib/rules.js` 规则引擎进行关键词/通道/时段匹配。遇到 408/429/5xx 可重试错误时自动进行候选链 failover，且在当轮内部保持已 advance 的候选。
- **Level 5: `inherit`**：无插件干预，回退到官方原生模型。
- **Lead 绝对保护**：Lead 自身请求直接 `if (!isChildAgent(agent)) return config` 放行，禁止通过 API 编辑 Lead 自身（返回 400）。

### 2. 当轮保护与清除覆盖机制
- 当在某轮次修改成员模型时，当前轮次依然执行原已固定的模型，下一轮（`turn > eff`）才正式切为新模型。
- 当提交清除成员覆盖（`selection: null`）时，当前轮次通过 `heldSelection` 维持原固定路由，下一轮才按契约清退并回退至 lower source。

### 3. 持久化与并发安全
- 团队设置独立存储于 `~/.dsh/team-member-model/teams.json`，不破坏、不修改、不自动扫描旧 switchable 的存储文件。
- 全局单一 Promise 链排队写，使用 `.tmp` 临时文件 + `rename` 原子替换落盘。
- 采用 CAS 乐观并发锁，客户端传入的 `revision` 与服务端不符时返回 409 `stale-revision`，阻止静默覆盖。

---

## 四、版本契约与测试实测（RED → GREEN）

### 1. Package 契约测试（先 RED 后 GREEN）
编写 `test/package.mjs` 验证清单与元数据：
- **RED 阶段**：在 `package.json` 为 0.6.1 时运行：
  ```
  ✖ Package Contract: 版本号严格为 0.7.0 (AssertionError: '0.6.1' !== '0.7.0')
  ✖ Package Contract: exports 映射包含新增 Host 状态与路由子路径 (AssertionError: undefined !== './lib/team-state.js')
  ✖ Package Contract: files 清单完整包含新增 team 模块且不含已删除文件 (AssertionError: missing lib/team-state.js)
  ```
- **GREEN 阶段**：更新 `package.json`（版本升级 0.7.0、补充 `./team-state` / `./team-routing` 导出及 `files` 字段）：
  ```
  node --test test/package.mjs
  ✔ Package Contract: 版本号严格为 0.7.0
  ✔ Package Contract: exports 映射包含新增 Host 状态与路由子路径
  ✔ Package Contract: files 清单完整包含新增 team 模块且不含已删除文件
  ✔ Package Contract: DSH 组合包与 Client 平台注入规范
  ✔ Package Contract: 组合包 cordis.patch.yml 格式有效性
  ✔ Package Contract: 离线静态 require/import 可解析性
  ℹ tests 6 · pass 6 · fail 0
  ```

### 2. 语法静态检查
执行命令：`count=0; for f in lib/*.js; do node --check "$f" || exit 1; count=$((count + 1)); done; echo "Total checked: $count"`
- **结果**：全量 7 个 lib 文件（`client.js`, `index.js`, `rules.js`, `skill.js`, `team-routing.js`, `team-state.js`, `usage.js`）全部语法校验通过，**7/7 passed**，退出码 0。

### 3. 全量测试套件执行证据
执行命令：
```bash
node --test test/smoke.mjs test/client.mjs test/apply.mjs test/team-state.mjs test/team-host.mjs test/team-client.mjs test/team-integration.mjs test/package.mjs
```
- **测试套件分类统计**：
  1. `test/smoke.mjs`：37 项规则与纯函数断言，1 个 node:test 子任务通过；
  2. `test/client.mjs`：29 项客户端组件与渲染断言，1 个 node:test 子任务通过；
  3. `test/apply.mjs`：43 项 Host 包装与既有功能断言，1 个 node:test 子任务通过；
  4. `test/team-state.mjs`：3 项团队持久化与原子并发落盘测试通过；
  5. `test/team-host.mjs`：6 项 Host 路由判定与 P1 修复回归测试通过；
  6. `test/team-client.mjs`：12 项前端弹出菜单与组件行为测试通过；
  7. `test/team-integration.mjs`：12 项端到端黑盒集成测试通过；
  8. `test/package.mjs`：6 项包契约与导出完整性测试通过。
- **总体验收**：Node TAP **42 tests 全部通过，0 失败**；底层业务断言 **148 项全部 PASS，退出码 0**！

---

## 五、打包归档与逐字节核验

### 1. 产物规格
- **产物绝对路径**：`/Users/mewcapoo/Projects/dsh-team-member-model/artifacts/team-integration-2026-10-26/dsh-team-member-model-0.7.0.tgz`
- **文件大小**：122,720 字节 (约 122.7 kB)
- **SHA256 哈希值**：`6859b58cfe6ffd4490ab578f1d25c0645163e07521180d25c16a629d5cf635be`
- **包含文件数**：12 个文件（打包清单完全符合 `files` 定义，不包含任何已删除过渡模块）：
  - `README.md`
  - `cordis.patch.yml`
  - `docs/spec.md`
  - `lib/client.js`
  - `lib/index.js`
  - `lib/rules.js`
  - `lib/skill.js`
  - `lib/team-routing.js`
  - `lib/team-state.js`
  - `lib/usage.js`
  - `package.json`
  - `skills/model-routing/SKILL.md`

### 2. 逐字节核验（Byte-by-byte compare）
解包至临时目录并逐个文件与当前工作区执行 `cmp`：
- **比对结果**：**Total mismatches: 0**（12 个文件逐字节完全一致）。
- **解包内部版本**：`package.json` 内 `version === "0.7.0"`。
- **私有路径扫描**：全面排查解包目录，无 `/Users/mewcapoo`、无 `C:\Users\lmy`、无 `/tmp/` 残留，干净合格。
- **离线引入验证**：在未连接真实宿主沙箱下，Node.js 成功 import 解包后的 6 个 Host 模块，且 `lib/client.js` 成功在假 `__ModuleLoader__` 沙箱中执行并导出。

---

## 六、部署边界、遗留项与风险声明（不夸大）

1. **未安装到真实环境**：本次交付不向真实 `~/.dsh/profiles/` 安装或热替换已安装插件，不进行浏览器真实点击交互，未执行真实付费 LLM 调用。所有验证均基于原生 Node.js / VM 离线 mock Host 环境。
2. **旧 switchable 插件迁移**：本插件不会自动卸载或覆盖旧 `dsh-agent-team-switchable`。由于两者会产生菜单插槽与路由功能重叠，用户须在空闲维护窗口手动在 DSH 界面停用旧插件；旧插件的历史存储文件不会自动迁移至 `teams.json`，原有配置保持不变。
3. **旧 Windows 部署脚本状态**：仓库根目录下保留的 `team-member-model.ps1` 与 4 个 `.cmd` 脚本属于早期 Windows 便捷工具，其硬编码的文件同步列表未包含 0.7.0 新增的 `team-state.js` 和 `team-routing.js`。已在 `README.md` 与 `给测试者.md` 中将其明确定位为 **Legacy 辅助脚本**，并明确推荐用户通过 DSH 官方 `plugin_manager` 或界面卡片直接选择 `.tgz` 本地包安装，严禁手动执行脚本改写 profile。
4. **参考项目状态**：参考代码库 `/Users/mewcapoo/Projects/dsh-agent-team-switchable` 在整个流程中保持严格只读，未产生任何改动。
