# 逐成员模型选择即保存实现计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 逐任务执行，并由持久 Agent Teams 分担实现与独立审查。不使用临时子代理。步骤使用复选框跟踪进度。

**目标：** 把已批准的方案 B 接入真实插件：顶部新成员默认模型，每个 teammate 独立模型与推理下拉框，选择即保存，无设置对象选择器及常规保存按钮。

**架构：** 沿用现有单目标编辑器组件，但将其转换为自动保存状态机；菜单固定渲染默认编辑器和按成员 ID 隔离的编辑器实例。复用 Controller 的全局保存互斥，RPC、后端存储和官方运行时不变。保留 Lead 引用租赁及 `remote.session` 精确注入。

**技术栈：** React 18、TypeScript、Cordis、DSH 公共 SDK、Vitest、Testing Library、esbuild。

**已批准规格：** [设计规格](<../specs/2026-10-09-member-model-autosave-design.md>)。

---

## 工作区与并行边界

继续使用当前共享工作区，不另建缺少现有修复的空白 worktree，不执行 reset、clean、stash 或替换 profile。实现前已切换到 `feature/member-model-autosave` 功能分支；起点是设计文档提交 `9786e30`，基线全量测试 100/100 通过。工作树包含前几轮尚未提交的源码修复。各执行员只修改自己的范围，不自行 stage/commit，以免夹带共享树中的其他改动；Lead 在每个阶段核查 diff，计划文档可单独提交。

### 文件职责与所有者

| 文件 | 职责 | 所有者 |
|---|---|---|
| [TeamModelEditor](<../../../src/client/TeamModelEditor.tsx>) | 单目标选择、即时提交、局部失败恢复和同步状态 | backend-coder |
| [locales](<../../../src/client/locales.ts>) | 自动保存及失败状态的中英文文案 | backend-coder |
| [编辑器测试](<../../../tests/client/team-model-editor.spec.tsx>) | 自动保存状态机与目录边界回归 | backend-coder |
| [TeamModelDialog](<../../../src/client/TeamModelDialog.tsx>) | 默认与逐成员布局、目标校验、全局互斥 | ui-coder |
| [菜单样式](<../../../src/client/TeamModelSettings.module.css>) | 紧凑内联控件和既有弹出菜单主题 | ui-coder |
| [菜单测试](<../../../tests/client/team-model-dialog.spec.tsx>) | 独立目标布局、提交隔离和关闭约束 | ui-coder |
| [入口测试](<../../../tests/client/team-model-action.spec.tsx>) | 更新多编辑器查询，同时保留会话生命周期覆盖 | ui-coder |
| [真实 SDK 测试](<../../../tests/client/slot-runtime.spec.tsx>) | 更新多编辑器查询，保留冷目录构造和精确注入反例 | ui-coder |
| [README](<../../../README.md>) | 真实 B 操作方式与安装生效边界 | env-coder |

不要更改 Controller、后端 Service、官方团队模块、客户端 mount 或现有六项依赖声明。若发现确需修改 Controller，先向 Lead 提交具体失败用例与原因，另立任务，不扩大已分配的写范围。

## 任务 1：TDD 转换单目标编辑器（task-18）

- [ ] **步骤 1：更新编辑器行为测试，先验证红灯。**

首个可直接运行的回归使用现有 fixture：

```tsx
it('commits model changes immediately without a save button', async () => {
  const save = vi.fn(async () => {})
  render(<TeamModelEditor mode="member" directory={catalog()}
    initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.model), {
    target: { value: JSON.stringify(['p', 'new']) },
  })
  await waitFor(() => expect(save).toHaveBeenCalledWith({
    provider: 'p', model: 'new',
  }))
  expect(screen.queryByRole('button', { name: zh['model.save'] })).toBeNull()
  expect(screen.queryByRole('button', { name: zh['model.cancel'] })).toBeNull()
})
```

继续将旧手动保存用例改为以下完整行为集合：

| 用例 | 操作 | 断言 |
|---|---|---|
| 推理选择 | `new/high` 改成 `low` | 提交 `p/new/low` 一次 |
| 模型切换 | `new/high` 改成 `old` | 提交 `p/old`，没有 reasoningEffort |
| 继承 | default 显式路线改成继承 | 提交 null；推理禁用 |
| 目录离线 | default 现有路线改成继承 | 仍提交 null；不允许缺失模型路线 |
| 无变化 | 原路线再次触发 change | 无 RPC |
| 保存锁 | deferred save 未完成，再次 change | 无第二次提交；控件禁用 |
| 外部锁 | disabled 或 isLocked 返回 true | 不修改输入，不提交 |
| 失败重试 | save reject，点击局部 retry | 原选择保留；重试同一完整路线 |
| 失败改选 | 失败后选择另一有效路线 | 新路线取代待重试路线 |
| 轮询 | rerender initial，编辑器空闲 | 更新选择，不提交 |
| 失败时轮询 | 保存失败后 rerender initial | 保留失败选择及错误 |
| 目录变化 | 删除当前模型或显式推理等级 | 保留显示及不可用说明，禁止无效重试 |
| 部分提供方失败 | 保留有效 groups 与 failures | 可选有效模型，显示局部提供方错误 |
| 晚到结果 | pending 时 unmount 后另建编辑器 | 旧结果不改新编辑器 |

运行：`npm test -- tests/client/team-model-editor.spec.tsx`。预期首个新用例因旧实现没有在 change 时调用 save 而失败，不能把编译错误当成目标红灯。

- [ ] **步骤 2：实现与菜单约定一致的 Props。**

保留现有 ModelSelection 与 TeamModelDirectory 类型，替换 Props：

```ts
export type TeamModelEditorProps = {
  directory: TeamModelDirectory
  disabled?: boolean
  isLocked?: () => boolean
  t: TranslateNS<typeof NS>
} & (
  | { mode?: 'member'; initial?: ModelSelection | null;
      save: (selection: ModelSelection) => Promise<void> }
  | { mode: 'default'; initial?: ModelSelection | null;
      save: (selection: ModelSelection | null) => Promise<void> }
)
```

`disabled` 负责 DOM 禁用；`isLocked` 在事件时同步读取 Controller 最新锁，防止多个编辑器同一 tick 竞争。模式默认 member，与现有 API 保持一致。删除 cancel 依赖。

- [ ] **步骤 3：实现单目标自动保存状态机。**

编辑器保留 route、effort，新增局部状态 idle/saving/saved/failed、保存中同步 ref、失败选择及请求序号。每次模型 change 先检查 `disabled || isLocked?.() || savingRef.current`，从当前目录验证完整路线，清空 effort，直接传计算得到的选择；不得依赖刚刚 setState 后尚未更新的值。

完整选择比较与构造采用下列行为：

```ts
const sameSelection = (a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined): boolean =>
  a == null || b == null ? a == null && b == null :
    a.provider === b.provider && a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort

const selectionWithEffort = (provider: string, model: string,
  effort: string): ModelSelection => ({
    provider, model,
    ...(effort === '' ? {} : { reasoningEffort: effort }),
  })
```

模型 change 使用 `selectionWithEffort(provider, model, '')`；推理 change 使用当前完整路线与新 effort；继承仅在 default 模式调用 save(null)。未选择、目录不存在或 effort 不受支持时不可提交。成功只标记局部已保存，不改写最近使用概要；失败保留输入并显示错误和 retry；retry 也要重新验证目录与保存锁。

初次加载和空闲的 initial 变化只同步输入，不发写请求。保存中和失败未确认时，initial 变化不覆盖本地选择。保存期间冻结该目标的目录视图，返回后恢复实时目录。useEffect 清理须使请求序号失效，以免 unmount 晚到响应改新状态。

新增 `model.saved`、`model.unsaved` 和自动保存说明的中英文文案；现有 target/save/cancel 字典键可以保留供回归查询，但实际菜单不得渲染旧控件。

- [ ] **步骤 4：验证绿灯并交接 API。**

运行同一编辑器测试命令；记录首次红灯与最终绿灯输出。可运行 `npm run typecheck`，若菜单并行分支暂时仍有 cancel 调用，报告具体错误交给 ui-coder，不修改对方文件。只在自己的写范围修改，不执行全量构建或打包。

## 任务 2：TDD 替换菜单布局（task-19，与任务 1 并行）

- [ ] **步骤 1：先用现有 Editor 编写新布局红灯。**

使用已有 mountDialog/apiFor fixture，添加：

```tsx
it('shows default and each teammate inline without a target selector', async () => {
  mountDialog(new TeamSettingsController(lead, apiFor()))
  const defaults = await screen.findByRole('region', {
    name: zh['defaultModel.title'],
  })
  const worker = screen.getByRole('article', { name: 'worker' })
  expect(within(defaults).getByLabelText(zh.model)).toBeTruthy()
  expect(within(worker).getByLabelText(zh.model)).toBeTruthy()
  expect(screen.queryByLabelText(zh.target)).toBeNull()
  expect(screen.queryByRole('button', { name: zh['model.save'] })).toBeNull()
})
```

运行：`npm test -- tests/client/team-model-dialog.spec.tsx`。预期旧布局缺少命名 region 和成员内联下拉而失败。

- [ ] **步骤 2：移除全局 target 状态并建立稳定实例。**

删除 target、editorVersion、单编辑目标判定和失效目标 reset effect。默认 editor 在 `section aria-label={t('defaultModel.title')}` 下固定渲染；成员 `article aria-label={item.name}` 使用 key={item.id}。仅 phase active 且官方 activeNames 包含的成员显示可编辑下拉；status inactive 不限制编辑。创建中和失败成员仍显示既有说明与概要。

调用形态：

```tsx
<TeamModelEditor mode="default" directory={catalog.directory}
  initial={view.defaultModel} disabled={state.saving}
  isLocked={() => controller.store.getSnapshot().saving}
  save={selection => saveTarget(null, selection)} t={t} />

<TeamModelEditor mode="member" directory={catalog.directory}
  initial={item.nextModel ?? item.currentModel ?? null}
  disabled={state.saving}
  isLocked={() => controller.store.getSnapshot().saving}
  save={selection => saveTarget(item.name, selection, item.id)} t={t} />
```

成员 callback 在实际实现中还必须结合最新 eligibility/official names 和稳定 ID 做目标校验；上述调用体现类型契约，不放宽现有权限。

- [ ] **步骤 3：实现最新状态守卫及保持关闭互斥。**

`saveTarget` 参数为 `(target: string | null, selection: TeamModelSelection | null, memberId?: string)`。在同步进入 save 之前读取 `controller.store.getSnapshot()`：保存中立即拒绝；eligible 失效拒绝；非 null 目标须在最新 view 中匹配 name、id、phase active，并且最新官方名字集合包含此目标。随后冻结当前 activeNames，调用原有 `controller.save(target, selection)`。

事件侧 `isLocked` 同步防重入，RPC 前守卫进行第二次校验。保存期间保留当前编辑器布局与冻结可编辑成员集合；全部下拉 disabled。保持关闭按钮、触发按钮切换、Escape 与外点的现有保存中关闭拦截。

只修改插件自有菜单 DOM，保留原有 acquireCatalog、ready、release、abort、菜单 Portal、定位、视口裁剪及焦点恢复。不修改官方节点或 mount 的 `remote.session`。

- [ ] **步骤 4：补全菜单和生命周期回归。**

测试分别用 within(default region) 和 within(member article) 定位模型与推理控件，不使用全页面唯一模型假设。覆盖：两个可编辑成员（含 inactive）互不串扰；默认仅调用 selectTeamDefaultModel；成员仅调用 selectMemberModel；同一 tick 第二个目标不能发写请求；保存中所有下拉及关闭禁用；失败保留输入与已提交概要且 retry 可恢复；轮询不触发写入；成员消失、变不可编辑以及 Lead/会话切换丢弃旧目标。

更新入口与真实 SDK 测试中的旧 target 或单模型查询。绝不删除真实 Cordis 受限 plugin、空目录新建、load 非空模型组、缓存复用、release/abort 及剔除 remote.session 的负例。

运行：`npm test -- tests/client/team-model-dialog.spec.tsx tests/client/team-model-action.spec.tsx tests/client/slot-runtime.spec.tsx`。任务 1 未集成前的错误应交接，不靠修改 mocks 掩盖。

- [ ] **步骤 5：整理紧凑布局并交接。**

只使用当前 Inspect 确认的主题变量：`--dsw-alias-bg-overlay`、`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary` 和公开 state 颜色。默认区与成员卡片有明确分隔，模型下拉宽度占满可用行，推理等级紧邻对应模型，保留视口内滚动。

## 任务 3：独立规格和代码复核（reviewer，依赖任务 1、2）

- [ ] **步骤 1：逐项核查规格和 diff。**

对照已批准规格的 8 项验收。重点审查无常规保存按钮、立即完整路线提交、模型切换清推理、稳定 ID 及最新权限校验、全局同步锁、失败保留和重试、空闲同步不产生 RPC、晚到响应隔离。

若发现缺陷，先给出失败用例和具体文件行号，由原所有者修复，不跨范围改文件。实质修复后原测试必须先捕获缺陷再通过。

- [ ] **步骤 2：独立串行运行完整链。**

```bash
npm test && npm run typecheck && npm run build && npm run check && git diff --check
```

预期：所有测试通过，TypeScript 无错误，构建成功，包检查 10/10，diff 格式无错误。由 reviewer 独占该阶段的 lib 生成；Lead 与其他成员不并行运行构建或打包。

- [ ] **步骤 3：报告真实验证边界。**

真实 Cordis/SDK 回归仍以 RPC fixture 隔离通信，不声称已验证当前安装的 GUI 或真实 Host/browser E2E。不得以缓存路径通过代替冷构造验证。

## 任务 4：文档及打包交付

- [ ] **步骤 1：更新操作文档。**

env-coder 仅更新 [README](<../../../README.md>)：选择即保存、顶部默认与逐成员配置、保存中短暂锁定、错误重试、默认作用范围和下一 turn 语义。删除旧的设置对象/点击保存操作说明。明确安装包和当前 profile 不会自动同步。

- [ ] **步骤 2：Lead 复跑并打包。**

全部队员写入结束后，Lead 复跑完整链。把新安装包放到 `artifacts/member-model-autosave/`，不得覆盖已交付的旧包。打包前检查目标文件不存在，打包后校验归档中的源码及浏览器产物与最终验证版本一致。

```bash
npm pack --pack-destination artifacts/member-model-autosave
shasum -a 256 artifacts/member-model-autosave/dsh-agent-team-switchable-0.2.0.tgz
```

当前版本号仍为 0.2.0，以新交付目录区分内容，最终说明不要误用旧包。

- [ ] **步骤 3：交付且准确说明 GUI 状态。**

展示本次新包，报告实际测试数量、类型与构建结果。未修改官方代码、未热替换运行中的 profile。用户在空闲维护窗口更新并冷重启/刷新后，才可在原 GUI 中看到新布局；不得把独立原型的表现当成已经部署的插件表现。
