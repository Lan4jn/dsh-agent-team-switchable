# 0.7.5 紧凑团队表单验证

日期：2026-10-28。任务：82，独立核验并打包。

## 范围

- 81 的客户端修改与 0.7.4 包内源码比较：限于共享选择器 CSS、类名及注释；事件处理、选择值和保存逻辑未改变。
- 本次发布更新版本契约与 README，保留模型路由使用说明及此前修复。

## 布局核验层级：源码与组件节点

- 共享选择器建立 `container-type:inline-size`；提供方行宽 100%，字段 `flex:1 1 auto;min-width:0`，覆盖旧固定宽度声明。
- 模型和档位使用专用网格 `minmax(0,3fr) minmax(0,2fr)`，间距 8px；字段 `min-width:0`，选择框使用 `text-overflow:ellipsis`。
- 容器宽度不大于 360px 时网格变为单列；按钮仍在选择器下方。
- 假设共享容器内容宽 420px：扣除 8px 间距，网格两列理论宽度分别约 247.2px 和 164.8px；这不是浏览器实测值。
- 修改选择器限定于共享表单；原成员行通用 CSS 保留。已有组件测试覆盖档位置灰、保存与名单边界。
- Client Inspect 曾超时；未在真实浏览器测量或目视 0.7.5，窄屏、长模型名和最终视觉效果尚待现场验证。

## 验证

- 7 个 `lib` 文件分别执行 `node --check`，全部通过。
- 八个明确测试文件一次运行：Node TAP **56/56 pass，0 fail，exit 0**。
- 包契约测试 6 项包含版本、文件清单及 Host/Client 离线入口加载。
- `npm pack --ignore-scripts`：13 个文件；解包后逐文件对照工作区，13/13 字节一致。
- 归档包含 `docs/model-routing-guide.md`；`source: 'team-member-model'` 存在；客户端旧草稿提示不存在，3:2 网格及容器断点存在。

## 产物

- `artifacts/compact-team-form-2026-10-28/dsh-team-member-model-0.7.5.tgz`
- 大小：134332 字节。
- SHA256：`e7b14a977743f539bb3f892f02df631aade4b884528be0963bb73389fd0248aa`。
- 旧版本归档未覆盖；本次未安装 profile、重启服务、修改用户团队数据或调用付费模型。
