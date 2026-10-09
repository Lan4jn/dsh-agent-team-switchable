# Agent Teams 模型切换插件

为 DeepSeek Harness 的智能体团队提供成员独立模型与推理等级设置，以及之后新建成员的默认模型设置。此仓库仅包含该插件，不包含 DSH 应用、核心或其他插件源码。

## 功能

- Lead 创建成员时可指定 provider、model 和可选 reasoning effort。
- 在团队面板设置已有成员的下轮模型；当前执行轮次保持不变。
- “成员”标题右侧通过统一弹窗设置之后新建成员的默认模型和推理等级。
- 选择“继承默认”清除团队默认，恢复原继承行为，不固定某个提供方。
- 配置按团队持久化，已有成员与正在准备的成员不受新成员默认影响。
- 保存失败、模型目录不可用、失效推理等级以及异步保存的迟来结果均有相应处理。

## 兼容与启用

目标版本为 DSH **0.2.0-rc.2**。官方运行时和共享 UI 通过 peerDependencies 使用，插件不内置或改写 DSH 核心。

源码安装需要构建授权和安装依赖；也可先在本地构建预编译包。以下验证命令适用于源码检出目录，预编译安装包不包含开发测试：

```bash
npm install
npm run build
npm run check
npm pack
```

`npm pack` 会输出 `dsh-agent-team-switchable-0.1.0.tgz`，其中包含 `dsh.bundle` 清单、Cordis patch 和已构建代码。可将该包作为 DSH 插件包安装；本仓库目前没有发布到 npm，也没有创建 GitHub Release。

本插件包含一套完整的团队运行时、团队工具和界面入口，不应与官方团队实现同时注册。若已经启用官方 Agent Teams bundle，应把本插件的 bundle 排在其后；patch 会禁用官方三个团队入口，再启用本插件。未启用官方团队时，旧入口不存在的禁用提示可忽略。不要重复应用同一 bundle。安装与重启应在团队空闲时进行。

## 代码布局

```text
src/runtime/       团队服务、模型路由、持久化与投影
src/tools/         团队创建、通信与任务工具
src/client/        团队面板与模型设置弹窗
src/index.ts       插件自有 Host 模型设置接口
src/types.ts       Host/客户端请求类型
scripts/           独立构建脚本
cordis.patch.yml   插件入口和替换配置
```

只保留插件相关的回归测试，不携带 DSH 核心测试实现或完整开发工作区。

## 数据兼容限制

团队生命周期记录沿用 `team/member` v2；成员模型选择使用 v3；新成员默认配置使用 v4。新版兼容旧团队记录，但写入 v3/v4 后不能仅换回旧官方插件并继续读取这些团队日志。已有 continuable 核心的图像能力预检限制未由本插件改变。

## 来源与许可证

团队基础实现来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，基线提交 `639ed015397290b3745d163aafe02ffee4aa3f84`，原目录为 `packages/experimental/agent-team`、`tool-agent-team` 和 `client-ui-agent-team`。本仓库是在此基础上增加独立成员模型、团队默认模型和统一设置界面的衍生插件，并不是 DeepSeek 官方发布包。

保留原项目 MIT 版权许可于 `UPSTREAM-LICENSE`；本仓库许可证为 `LICENSE`。其他官方依赖仍指向原作者的发布包，不重新上传或复制它们。
