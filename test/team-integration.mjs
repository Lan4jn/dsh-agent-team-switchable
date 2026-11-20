/**
 * test/team-integration.mjs
 * 独立黑盒集成测试：验证团队模型设置 API、持久化恢复、快照预约与 5 级路由决策整合。
 * 运行方式：node --test test/team-integration.mjs
 */

import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { resolveTeamRoute, isManualFixedRoute } from '../lib/team-routing.js'
import {
  createIntegrationHost,
  createLeadAgent,
  createTeammateAgent,
} from './integration-support.mjs'

const MUTATION_HEADERS = {
  'content-type': 'application/json',
  'x-dsh-team-member-model': '1',
}

test('Case 1: 5 级路由优先级黑盒整合验证 (memberoverride > createexplicit > captureddefault > auto > inherit)', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {
      members: [{ provider: 'p-auto', model: 'm-auto' }],
      rules: [{ use: 'p-auto/m-auto', channel: 'spawn', label: '*' }],
    })

    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 先通过 API 设置团队未来默认模型 (Level 3 来源)
    const setDefRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-default', model: 'm-default' },
      revision: 0,
    })
    assert.equal(setDefRes.status, 200, `set default failed: ${JSON.stringify(setDefRes.body)}`)

    // Member 1: 同时拥有 Level 1(override), Level 2(explicit), Level 3(captured default)
    const m1 = createTeammateAgent('m1-id', 'lead-1', 'worker-1', {
      provider: 'p-explicit',
      model: 'm-explicit',
    })
    host.registerTeammate(lead, m1, 'worker-1')

    // 触发创建预约与初始化
    await host.emitProvisioning('lead-1', 'm1-id', 'worker-1')
    await host.emitAgentCreated(m1)

    // 成员正在 Turn 1 运行
    m1._setTurn(1)

    // 读取当前最新 revision 进行 CAS 更新
    const curV1 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')

    // 通过 API 赋予 Member 1 覆盖设置 (Level 1)，effectiveAfterTurn 记录为 1
    const overrideRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm1-id',
      selection: { provider: 'p-override', model: 'm-override' },
      revision: curV1.body.view.revision,
    })
    assert.equal(overrideRes.status, 200)

    // 在 Turn 1 (当前轮次 <= effectiveAfterTurn 1): Level 1 未生效，Level 2 (explicit) 胜出！
    const rTurn1 = await host.requestRoute(m1, { provider: 'base-p', model: 'base-m' })
    assert.equal(rTurn1.provider, 'p-explicit')
    assert.equal(rTurn1.model, 'm-explicit')

    // 在 Turn 2 (轮次 > effectiveAfterTurn 1): Level 1 (override) 胜出！
    m1._setTurn(2)
    const rTurn2 = await host.requestRoute(m1, { provider: 'base-p', model: 'base-m' })
    assert.equal(rTurn2.provider, 'p-override')
    assert.equal(rTurn2.model, 'm-override')

    // Member 2: 空 agentOptions {}（无 explicit），应命中 Level 3 captureddefault
    const m2 = createTeammateAgent('m2-id', 'lead-1', 'worker-2', {})
    host.registerTeammate(lead, m2, 'worker-2')
    await host.emitProvisioning('lead-1', 'm2-id', 'worker-2')
    await host.emitAgentCreated(m2)
    m2._setTurn(1)
    const rM2 = await host.requestRoute(m2, { provider: 'base-p', model: 'base-m' })
    assert.equal(rM2.provider, 'p-default')
    assert.equal(rM2.model, 'm-default')

    // Member 3: 无 override, 无 explicit, 默认被清空 -> 命中 Level 4 auto 规则
    // 清空默认
    const curV2 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    const clearDefRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: null,
      revision: curV2.body.view.revision,
    })
    assert.equal(clearDefRes.status, 200)

    const m3 = createTeammateAgent('m3-id', 'lead-1', 'worker-3')
    host.registerTeammate(lead, m3, 'worker-3')
    await host.emitProvisioning('lead-1', 'm3-id', 'worker-3')
    await host.emitAgentCreated(m3)
    m3._setTurn(1)
    const rM3 = await host.requestRoute(m3, { provider: 'base-p', model: 'base-m' })
    assert.equal(rM3.provider, 'p-auto')
    assert.equal(rM3.model, 'm-auto')
  } finally {
    await host.cleanup()
  }
})

test('Case 2: 团队未来默认预约快照与防污染隔离 (含 null 快照，禁止回退到最新默认)', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 1. 设置默认模型为 def1
    const res1 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def1', model: 'm-def1' },
      revision: 0,
    })
    assert.equal(res1.status, 200)

    // Member A 创建并捕获快照 def1
    const mA = createTeammateAgent('mA-id', 'lead-1', 'worker-A')
    host.registerTeammate(lead, mA, 'worker-A')
    await host.emitProvisioning('lead-1', 'mA-id', 'worker-A')

    // 2. 将默认修改为 def2
    const res2 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def2', model: 'm-def2' },
      revision: res1.body.view.revision,
    })
    assert.equal(res2.status, 200)

    // Member B 创建并捕获快照 def2
    const mB = createTeammateAgent('mB-id', 'lead-1', 'worker-B')
    host.registerTeammate(lead, mB, 'worker-B')
    await host.emitProvisioning('lead-1', 'mB-id', 'worker-B')

    // 3. 将默认清空为 null（恢复继承）
    const res3 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: null,
      revision: res2.body.view.revision,
    })
    assert.equal(res3.status, 200)

    // Member C 创建并捕获快照 null
    const mC = createTeammateAgent('mC-id', 'lead-1', 'worker-C')
    host.registerTeammate(lead, mC, 'worker-C')
    await host.emitProvisioning('lead-1', 'mC-id', 'worker-C')

    // 4. 再次将默认设置为 def3
    const res4 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def3', model: 'm-def3' },
      revision: res3.body.view.revision,
    })
    assert.equal(res4.status, 200)

    // 触发 agent/created 实例化
    await host.emitAgentCreated(mA)
    await host.emitAgentCreated(mB)
    await host.emitAgentCreated(mC)

    // 验证各成员完全保留各自创建时刻的预约快照，绝不污染回退至 def3
    const rA = await host.requestRoute(mA, { provider: 'base-p', model: 'base-m' })
    assert.equal(rA.provider, 'p-def1')
    assert.equal(rA.model, 'm-def1')

    const rB = await host.requestRoute(mB, { provider: 'base-p', model: 'base-m' })
    assert.equal(rB.provider, 'p-def2')
    assert.equal(rB.model, 'm-def2')

    const rC = await host.requestRoute(mC, { provider: 'base-p', model: 'base-m' })
    // Member C 快照为 null，回退到 baseConfig (inherit)
    assert.equal(rC.provider, 'base-p')
    assert.equal(rC.model, 'base-m')
  } finally {
    await host.cleanup()
  }
})

test('Case 3: 成员覆盖当轮保护与清除覆盖 (clear override) 下一轮生效', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    const m = createTeammateAgent('m-id', 'lead-1', 'worker-turn')
    host.registerTeammate(lead, m, 'worker-turn')
    await host.emitProvisioning('lead-1', 'm-id', 'worker-turn')
    await host.emitAgentCreated(m)

    // 模拟成员在 Turn 1 正在运行，自身 request header 记录 p-orig/m-orig
    m._setTurn(1)
    m._setHeader({ provider: 'p-orig', model: 'm-orig' })

    const curV = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')

    // 此时提交覆盖：selection 变更为 p-new/m-new
    const putRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-id',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: curV.body.view.revision,
    })
    assert.equal(putRes.status, 200)

    // 在当轮 (Turn 1): 请求依然保持原状，当轮不被中断破坏！
    const rSameTurn = await host.requestRoute(m, { provider: 'p-orig', model: 'm-orig' })
    assert.equal(rSameTurn.model, 'm-orig')

    // 进入下一轮 (Turn 2): 覆盖生效，路由为 p-new/m-new
    m._setTurn(2)
    const rNextTurn = await host.requestRoute(m, { provider: 'p-orig', model: 'm-orig' })
    assert.equal(rNextTurn.model, 'm-new')

    // 在 Turn 2 中提交清除覆盖 (selection: null)
    const clearRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-id',
      selection: null,
      revision: putRes.body.view.revision,
    })
    assert.equal(clearRes.status, 200)

    // 在当轮 (Turn 2): 依然保持原覆盖 p-new/m-new (heldSelection 保护)
    const rHeld = await host.requestRoute(m, { provider: 'base-p', model: 'base-m' })
    assert.equal(rHeld.model, 'm-new')

    // 进入 Turn 3: 清除生效，回退到 baseConfig (inherit)
    m._setTurn(3)
    const rCleared = await host.requestRoute(m, { provider: 'base-p', model: 'base-m' })
    assert.equal(rCleared.model, 'base-m')
  } finally {
    await host.cleanup()
  }
})

test('Case 4: 手动固定路由无 failover 回退 vs 自动规则允许 failover 且同轮保持已 advance 候选', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {
      members: [
        { provider: 'p-custom', model: 'm-custom' },
        { provider: 'p-custom', model: 'm-fallback' },
      ],
      rules: [{ use: 'p-custom/m-custom', channel: 'spawn', label: '*' }],
      failover: { enabled: true, patience: 2 },
    })
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 1. 手动固定路由 Member: 在 Turn 1 提交保存，Turn 2 下一轮生效
    const mManual = createTeammateAgent('m-manual-id', 'lead-1', 'worker-manual')
    host.registerTeammate(lead, mManual, 'worker-manual')
    await host.emitProvisioning('lead-1', 'm-manual-id', 'worker-manual')
    await host.emitAgentCreated(mManual)
    mManual._setTurn(1)

    const curVM = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-manual-id',
      selection: { provider: 'p-manual', model: 'm-manual' },
      revision: curVM.body.view.revision,
    })

    // 进入 Turn 2: 手动固定路由生效
    mManual._setTurn(2)

    // 发起路由后抛出可重试错误 500
    const mRoute = await host.requestRoute(mManual, { provider: 'base-p', model: 'base-m' })
    assert.equal(mRoute.model, 'm-manual')

    const manualErr = await host.requestError(mManual, { status: 500, message: 'Server error' })
    // 手动固定路由绝不重试回退，直接让 next() 处理
    assert.equal(manualErr.nextCalled, true)
    assert.notEqual(manualErr.result?.kind, 'retry')

    // 2. 自动规则 Member (Auto 候选回退)
    await host.ctx.subagents.startContinuable({
      childId: 'm-auto-id',
      provider: 'spawn',
      label: 'worker-auto',
      request: {
        prompt: [{ type: 'text', text: 'worker-auto prompt' }],
        parent: lead,
      },
    })
    const mAuto = createTeammateAgent('m-auto-id', 'lead-1', 'worker-auto', {
      provider: 'p-custom',
      model: 'm-custom',
      __tmmInjected: true,
    })
    host.registerTeammate(lead, mAuto, 'worker-auto')
    await host.emitProvisioning('lead-1', 'm-auto-id', 'worker-auto')
    await host.emitAgentCreated(mAuto)
    mAuto._setTurn(1)

    // 第一次调用：命中首选 m-custom
    const r1 = await host.requestRoute(mAuto, { provider: 'p-custom', model: 'm-custom' })
    assert.equal(r1.model, 'm-custom')

    // 抛出 500 错误，自动回退介入 (deferred failover) 并交官方 next 处理
    const autoErr = await host.requestError(mAuto, { status: 500, message: 'Server error' })
    assert.equal(autoErr.nextCalled, true)
    assert.notEqual(autoErr.result?.kind, 'retry')

    // 下一轮请求：必须保持已经 advance 的候选 (m-fallback)，不能重置回 m-custom！
    mAuto._setTurn(2)
    const r2 = await host.requestRoute(mAuto, { provider: 'p-custom', model: 'm-custom' })
    assert.equal(r2.model, 'm-fallback')
  } finally {
    await host.cleanup()
  }
})

test('Case 5: 成员按 immutable memberId 隔离，防同名替换', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 创建同名的两个成员，ID 分别为 id-1 和 id-2
    const m1 = createTeammateAgent('id-1', 'lead-1', 'coder')
    const m2 = createTeammateAgent('id-2', 'lead-1', 'coder')
    host.registerTeammate(lead, m1, 'coder')
    host.registerTeammate(lead, m2, 'coder')
    await host.emitProvisioning('lead-1', 'id-1', 'coder')
    await host.emitProvisioning('lead-1', 'id-2', 'coder')
    await host.emitAgentCreated(m1)
    await host.emitAgentCreated(m2)

    // 分别针对 id-1 和 id-2 设定不同的覆盖模型
    const v0 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    assert.equal(v0.status, 200)

    const p1 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'id-1',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: v0.body.view.revision,
    })
    assert.equal(p1.status, 200)

    const p2 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'id-2',
      selection: { provider: 'p-snap', model: 'm-snap' },
      revision: p1.body.view.revision,
    })
    assert.equal(p2.status, 200)

    // 获取视图，两成员配置严格区分
    const viewRes = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    const members = viewRes.body.view.members
    const vm1 = members.find(m => m.id === 'id-1')
    const vm2 = members.find(m => m.id === 'id-2')
    assert.equal(vm1.nextModel.model, 'm-new')
    assert.equal(vm2.nextModel.model, 'm-snap')

    // 传入名字 'coder' 作为 target 应当被拒绝 (必须使用 immutable id)
    const errRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'coder',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: p2.body.view.revision,
    })
    assert.ok(errRes.status === 400 || errRes.status === 404, '必须拒绝用 name 代替 immutable memberId')
  } finally {
    await host.cleanup()
  }
})

test('Case 6: Lead 绝对保护与跨 Team 权限隔离 (403 Forbidden)', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const leadA = createLeadAgent('lead-A')
    const leadB = createLeadAgent('lead-B')
    host.registerLead(leadA)
    host.registerLead(leadB)

    const mA = createTeammateAgent('mA-id', 'lead-A', 'worker-A')
    host.registerTeammate(leadA, mA, 'worker-A')

    // 1. 尝试修改 Lead 自身 -> 400 拒绝
    const leadEditRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-A',
      target: 'lead',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: 0,
    })
    assert.equal(leadEditRes.status, 400)

    const leadIdEditRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-A',
      target: 'lead-A',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: 0,
    })
    assert.equal(leadIdEditRes.status, 400)

    // 2. Lead 自身的请求绝对不被拦截修改
    const leadRoute = await host.requestRoute(leadA, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    assert.equal(leadRoute.provider, 'opencode-go')
    assert.equal(leadRoute.model, 'deepseek-v4.1-flash')

    // 3. 跨 Team 越权修改: lead-B 尝试修改属于 lead-A 的 mA-id -> 403/404 拒绝
    const crossRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-B',
      target: 'mA-id',
      selection: { provider: 'p-new', model: 'm-new' },
      revision: 0,
    })
    assert.ok(crossRes.status === 403 || crossRes.status === 404, `预期跨团队拒绝，实际 ${crossRes.status}`)
  } finally {
    await host.cleanup()
  }
})

test('Case 7: CAS 乐观并发与全局文件锁原子持久化冷重开', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead1 = createLeadAgent('lead-1')
    const lead2 = createLeadAgent('lead-2')
    host.registerLead(lead1)
    host.registerLead(lead2)

    // 1. CAS 版本控制测试
    const res1 = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def1', model: 'm-def1' },
      revision: 0,
    })
    assert.equal(res1.status, 200)
    assert.equal(res1.body.view.revision, 1)

    // 传入过期的 revision 0 -> 409 Conflict
    const staleRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def2', model: 'm-def2' },
      revision: 0,
    })
    assert.equal(staleRes.status, 409, '过期 revision 应当返回 409')

    // 2. 全局文件锁并发写入：同时更新 lead-1 和 lead-2
    const p1 = host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def2', model: 'm-def2' },
      revision: 1,
    })
    const p2 = host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-2',
      target: null,
      selection: { provider: 'p-def3', model: 'm-def3' },
      revision: 0,
    })
    const [c1, c2] = await Promise.all([p1, p2])
    assert.equal(c1.status, 200)
    assert.equal(c2.status, 200)

    // 验证磁盘文件 teams.json
    const teamsFile = join(host.dshHome, 'team-member-model', 'teams.json')
    const fileContent = JSON.parse(await readFile(teamsFile, 'utf8'))
    assert.equal(fileContent['lead-1'].defaultModel.model, 'm-def2')
    assert.equal(fileContent['lead-2'].defaultModel.model, 'm-def3')
  } finally {
    await host.cleanup()
  }
})

test('Case 8: 视图投影契约：currentModel 取自身真实 request/header，nextModel 取持久选择', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    const m = createTeammateAgent('m-view-id', 'lead-1', 'worker-view')
    host.registerTeammate(lead, m, 'worker-view')
    await host.emitProvisioning('lead-1', 'm-view-id', 'worker-view')
    await host.emitAgentCreated(m)

    // 未执行任何调用前：currentModel 为 undefined，绝不伪造成 initial！
    const v1 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    const mem1 = v1.body.view.members.find(x => x.id === 'm-view-id')
    assert.equal(mem1.currentModel, undefined)

    // 设置下轮覆盖
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-view-id',
      selection: { provider: 'p-next', model: 'm-next' },
      revision: v1.body.view.revision,
    })

    // 执行一次真实调用，产生 request header
    m._setTurn(1)
    m._setHeader({ provider: 'p-real', model: 'm-real' })

    const v2 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    const mem2 = v2.body.view.members.find(x => x.id === 'm-view-id')
    assert.deepEqual(mem2.currentModel, { provider: 'p-real', model: 'm-real' })
    assert.deepEqual(mem2.nextModel, { provider: 'p-next', model: 'm-next' })
  } finally {
    await host.cleanup()
  }
})

test('Case 9: 空 agentOptions {} 防误判守卫', () => {
  // 单元级与路由逻辑集成：确保无 model 的对象绝不被当作 createexplicit
  const teamRecord = {
    teamId: 'lead-1',
    revision: 1,
    defaultModel: { provider: 'p-default', model: 'm-default' },
    initials: { 'm-empty': { selection: { provider: 'p-snap', model: 'm-snap' }, source: 'default' } },
    choices: {},
  }

  const rEmpty = resolveTeamRoute({
    agentId: 'm-empty',
    turn: 1,
    teamRecord,
    agentOptions: {}, // 空对象
  })
  assert.notEqual(rEmpty.level, 'createexplicit')
  assert.equal(rEmpty.level, 'captureddefault')
  assert.equal(rEmpty.route.model, 'm-snap')

  const rNull = resolveTeamRoute({
    agentId: 'm-empty',
    turn: 1,
    teamRecord,
    agentOptions: null,
  })
  assert.equal(rNull.level, 'captureddefault')

  const rWrongProp = resolveTeamRoute({
    agentId: 'm-empty',
    turn: 1,
    teamRecord,
    agentOptions: { temperature: 0.5 },
  })
  assert.equal(rWrongProp.level, 'captureddefault')
})

test('Case 10: HTTP 安全防御 (Headers, Method, URL Params, 目录校验)', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 1. PUT 缺少 x-dsh-team-member-model 标记头 -> 403 Forbidden
    const noHeaderRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', {}, {
      sessionId: 'lead-1',
      target: null,
      selection: null,
      revision: 0,
    })
    assert.equal(noHeaderRes.status, 403)

    // 2. GET 缺少 sessionId -> 400 Bad Request
    const noSessionRes = await host.apiRequest('GET', '/api/dsh-team-member-model/teams')
    assert.equal(noSessionRes.status, 400)

    // 3. PUT 模型不在目录中 -> 400 Bad Request
    const badModelRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'non-existent', model: 'fake' },
      revision: 0,
    })
    assert.equal(badModelRes.status, 400)
  } finally {
    await host.cleanup()
  }
})

test('Case 11: P1 团队成员 initial 快照冷恢复持久化（created 后无另行 PUT 依然持久落盘，冷重开后不被最新 default 污染）', async () => {
  const host1 = await createIntegrationHost({ preserveDir: true })
  const sharedDshHome = host1.dshHome
  try {
    await apply(host1.ctx, {})
    const lead1 = createLeadAgent('lead-1')
    host1.registerLead(lead1)

    // 1. 设置默认模型为 def1
    const setDefRes = await host1.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def1', model: 'm-def1' },
      revision: 0,
    })
    assert.equal(setDefRes.status, 200)

    // Member A: 普通成员，捕获快照 def1
    const mA = createTeammateAgent('mA-id', 'lead-1', 'worker-A')
    host1.registerTeammate(lead1, mA, 'worker-A')
    await host1.emitProvisioning('lead-1', 'mA-id', 'worker-A')
    await host1.emitAgentCreated(mA)

    // Member B: 显式指定 options 创建
    const mB = createTeammateAgent('mB-id', 'lead-1', 'worker-B', { provider: 'p-explicit', model: 'm-explicit' })
    host1.registerTeammate(lead1, mB, 'worker-B')
    await host1.emitProvisioning('lead-1', 'mB-id', 'worker-B')
    await host1.emitAgentCreated(mB)

    // 清除默认模型为 null (恢复继承)
    const curV = await host1.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host1.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: null,
      revision: curV.body.view.revision,
    })

    // Member C: 捕获快照 null (继承)
    const mC = createTeammateAgent('mC-id', 'lead-1', 'worker-C')
    host1.registerTeammate(lead1, mC, 'worker-C')
    await host1.emitProvisioning('lead-1', 'mC-id', 'worker-C')
    await host1.emitAgentCreated(mC)

    // 注意：此后不再调用任何 PUT /teams！
    // 验证物理磁盘上的 teams.json 文件是否已经持久化了 initials
    const teamsFilePath = join(sharedDshHome, 'team-member-model', 'teams.json')
    const diskContent = JSON.parse(await readFile(teamsFilePath, 'utf8'))
    assert.ok(diskContent['lead-1']?.initials?.['mA-id'], '磁盘上必须已持久化 mA-id 的 initial 快照')
    assert.equal(diskContent['lead-1'].initials['mA-id'].selection.model, 'm-def1')
    assert.ok(Object.hasOwn(diskContent['lead-1']?.initials, 'mC-id'), '磁盘上必须包含 mC-id 的 null 快照')

    // 关闭宿主 1
    await host1.cleanup()

    // 2. 模拟冷重启：启动全新的宿主 2，挂载相同的 dshHome
    const host2 = await createIntegrationHost({ dshHome: sharedDshHome, preserveDir: false })
    try {
      await apply(host2.ctx, {})
      const lead2 = createLeadAgent('lead-1')
      host2.registerLead(lead2)

      // 在冷重启后的环境中，将默认模型改为全新的 p-def-LATE
      const v2 = await host2.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
      await host2.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
        sessionId: 'lead-1',
        target: null,
        selection: { provider: 'p-def-LATE', model: 'm-def-LATE' },
        revision: v2.body.view.revision,
      })

      // 成员重新挂载 / late attach
      const rmA = createTeammateAgent('mA-id', 'lead-1', 'worker-A')
      const rmB = createTeammateAgent('mB-id', 'lead-1', 'worker-B', { provider: 'p-explicit', model: 'm-explicit' })
      const rmC = createTeammateAgent('mC-id', 'lead-1', 'worker-C')
      host2.registerTeammate(lead2, rmA, 'worker-A')
      host2.registerTeammate(lead2, rmB, 'worker-B')
      host2.registerTeammate(lead2, rmC, 'worker-C')

      // 发起路由调用：验证成员严格执行创建时记录的快照，绝不被 p-def-LATE 污染！
      const routeA = await host2.requestRoute(rmA, { provider: 'base-p', model: 'base-m' })
      assert.equal(routeA.model, 'm-def1', 'mA 必须保持创建时捕获的 m-def1 快照')

      const routeB = await host2.requestRoute(rmB, { provider: 'base-p', model: 'base-m' })
      assert.equal(routeB.model, 'm-explicit', 'mB 必须保持显式指派的 m-explicit')

      const routeC = await host2.requestRoute(rmC, { provider: 'base-p', model: 'base-m' })
      assert.equal(routeC.model, 'base-m', 'mC 必须保持继承，不被新默认污染')
    } finally {
      await host2.cleanup()
    }
  } finally {
    // 确保清理临时目录
    await rm(sharedDshHome, { recursive: true, force: true }).catch(() => {})
  }
})

test('Case 12: P1 鉴权越权防护（sessionController 返回 error 时严禁回退到 agents.get 放行）', async () => {
  const host = await createIntegrationHost({
    resolveAgent: async (sessionId) => {
      // 模拟 sessionController 明确拒绝访问（如越权或会话失效）
      return { error: { code: 'session/subagent-ownership', message: 'unauthorized subagent session' } }
    },
  })
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    // 将 lead 注册到 agents 服务中，测试是否会被偷渡 fallback 命中
    host.registerLead(lead)

    // 1. GET /teams 应当严格返回 403 / 拒绝，绝对不能 fallback 到 agents.get 放行返回 200
    const getRes = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    assert.equal(getRes.status, 403, `sessionController 鉴权拒绝时 GET 必须返回 403，实际返回 ${getRes.status}`)

    // 2. PUT /teams 应当同样严格返回 403，绝不允许越权写
    const putRes = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-def1', model: 'm-def1' },
      revision: 0,
    })
    assert.equal(putRes.status, 403, `sessionController 鉴权拒绝时 PUT 必须返回 403，实际返回 ${putRes.status}`)
  } finally {
    await host.cleanup()
  }
})
