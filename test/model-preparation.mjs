/**
 * test/model-preparation.mjs
 * 针对 DSH 0.2.2-rc.1 真实生命周期契约的测试：
 * 验证模型选择必须在 step preparation (preStep) 前通过 agent.model.select() 生效，
 * 禁止在 agent/request 中偷换 config.provider/model/reasoningEffort 导致 prepareRequest 报错。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'
import {
  createIntegrationHost,
  createLeadAgent,
  createTeammateAgent,
} from './integration-support.mjs'

const MUTATION_HEADERS = {
  'content-type': 'application/json',
  'x-dsh-team-member-model': '1',
}

/**
 * 模拟官方 DSH AgentLoop preStep 与 prepareRequest 真实契约：
 * 1. preStep: inbox.claim 同步触发 agent/inbox/claimed，随后读取 selection = agent.model.current()
 * 2. prepareRequest: 传入由 selection 构成的 seedConfig，调用 agent/request waterfall，严格断言 proposedConfig 必须与 selection 完全一致
 */
async function simulateLoopStep(host, agent, turn) {
  agent._setTurn(turn)
  // 1. inbox.claim 同步派发 agent/inbox/claimed (模拟 loop/lib/index.js:670 同步通知)
  const claimedHandlers = host.captured.listeners['agent/inbox/claimed'] || []
  for (const h of claimedHandlers) {
    h({
      message: { id: `msg-${turn}`, role: 'user', content: [{ type: 'text', text: 'hi' }] },
      turn,
      agent,
    })
  }

  // preStep 固定 selection
  const selection = agent.model?.current()
  assert.ok(selection, `agent ${agent.id} must have a model selection`)

  // 2. prepareRequest: 传入由 selection 构成的 seedConfig，调用 agent/request
  const seedConfig = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
  const proposedConfig = await host.requestRoute(agent, seedConfig)

  // 严格执行官方 @deepseek-ai/dsh-agent-loop/lib/index.js:1000-1002 检查
  if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
    throw new Error(`agent "${agent.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`)
  }
  if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
    throw new Error(`agent "${agent.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`)
  }

  return { selection, proposedConfig }
}

test('Test 1: 创建期模型通过 agent.model.select 生效且 prepareRequest 无冲突', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 设置团队未来默认模型
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-default', model: 'm-default' },
      revision: 0,
    })

    // 创建 teammate，未指定 explicit，应命中 Level 3 captureddefault (p-default/m-default)
    const m1 = createTeammateAgent('m1-id', 'lead-1', 'worker-1', {})
    host.registerTeammate(lead, m1, 'worker-1')
    await host.emitProvisioning('lead-1', 'm1-id', 'worker-1')
    await host.emitAgentCreated(m1)

    // 此时尚未开始 turn，agent.model.current() 应该已被设置为 p-default/m-default
    assert.deepEqual(m1.model.current(), { provider: 'p-default', model: 'm-default' })

    // 执行 Step 1，prepareRequest 必须一致不报错
    const step1 = await simulateLoopStep(host, m1, 1)
    assert.equal(step1.selection.model, 'm-default')
    assert.equal(step1.proposedConfig.model, 'm-default')
  } finally {
    await host.cleanup()
  }
})

test('Test 2: 下一轮生效机制与跨轮模型切换 (无 prepareRequest 冲突)', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    const m1 = createTeammateAgent('m1-id', 'lead-1', 'worker-1', {
      provider: 'p-orig',
      model: 'm-orig',
    })
    host.registerTeammate(lead, m1, 'worker-1')
    await host.emitProvisioning('lead-1', 'm1-id', 'worker-1')
    await host.emitAgentCreated(m1)

    // Turn 1: 原始模型 p-orig/m-orig
    const step1 = await simulateLoopStep(host, m1, 1)
    assert.equal(step1.selection.model, 'm-orig')

    // 在 Turn 1 运行期间，用户通过 UI/API 设置新模型 p-next/m-next (effectiveAfterTurn = 1)
    const curV = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm1-id',
      selection: { provider: 'p-next', model: 'm-next' },
      revision: curV.body.view.revision,
    })

    // Turn 1 内后续 step：仍保持当轮旧模型 m-orig
    const step1Subsequent = await simulateLoopStep(host, m1, 1)
    assert.equal(step1Subsequent.selection.model, 'm-orig')

    // Turn 2: 进入下一轮，新模型 p-next/m-next 正式生效！
    const step2 = await simulateLoopStep(host, m1, 2)
    assert.equal(step2.selection.model, 'm-next')
    assert.equal(step2.proposedConfig.model, 'm-next')
  } finally {
    await host.cleanup()
  }
})

test('Test 3: 清除覆盖后能够正确恢复 Level 3/5，解除 sticky model.current', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 默认模型 p-default/m-default
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: null,
      selection: { provider: 'p-default', model: 'm-default' },
      revision: 0,
    })

    const m1 = createTeammateAgent('m1-id', 'lead-1', 'worker-1', {})
    host.registerTeammate(lead, m1, 'worker-1')
    await host.emitProvisioning('lead-1', 'm1-id', 'worker-1')
    await host.emitAgentCreated(m1)

    // 覆盖为 p-override/m-override
    let curV = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm1-id',
      selection: { provider: 'p-override', model: 'm-override' },
      revision: curV.body.view.revision,
    })

    // Turn 2 生效 override
    const step2 = await simulateLoopStep(host, m1, 2)
    assert.equal(step2.selection.model, 'm-override')

    // 现在用户清除 override (selection: null, effectiveAfterTurn = 2)
    curV = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm1-id',
      selection: null,
      revision: curV.body.view.revision,
    })

    // Turn 3: 必须解除 sticky override，正确降级回 Level 3 默认快照 p-default/m-default！
    const step3 = await simulateLoopStep(host, m1, 3)
    assert.equal(step3.selection.model, 'm-default')
    assert.equal(step3.proposedConfig.model, 'm-default')
  } finally {
    await host.cleanup()
  }
})

test('Test 4: 运行时 request-error 执行 deferred failover，下轮切换且当次错误交给官方', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {
      members: [
        { provider: 'p-custom', model: 'm-custom' },
        { provider: 'p-custom', model: 'm-fallback' },
      ],
      rules: [],
      failover: { enabled: true, patience: 2 },
    })
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 自动规划路由的子代理 (候选为 m-custom, m-fallback)
    const sub = createTeammateAgent('sub-id', 'lead-1', 'worker-auto', {})
    host.registerTeammate(lead, sub, 'worker-auto')
    await host.emitProvisioning('lead-1', 'sub-id', 'worker-auto')
    await host.emitAgentCreated(sub)

    // Turn 1 运行第 1 候选 m-custom
    assert.equal(sub.model?.current()?.model, 'm-custom')
    const step1 = await simulateLoopStep(host, sub, 1)
    assert.equal(step1.selection.model, 'm-custom')

    // 发生网络错误 502
    const { result, nextCalled } = await host.requestError(sub, { status: 502, code: 'BAD_GATEWAY', message: 'Service down' })

    // 必须交由官方 next 处理，不能伪装返回 { kind: 'retry' } 欺骗同 step 重试
    assert.equal(nextCalled, true, 'error must be delegated to official loop next()')
    assert.notEqual(result?.kind, 'retry', 'must not return retry for same-step cross-model switch')

    // 检查 trace 记录应为 deferred
    const st = await host.apiRequest('GET', '/api/dsh-team-member-model/state')
    const failoverTrace = st.body.trace?.find(t => t.kind === 'failover')
    assert.ok(failoverTrace, 'should record a failover trace')
    assert.equal(failoverTrace.outcome, 'deferred', 'outcome must be deferred')
    assert.equal(failoverTrace.to, 'p-custom/m-fallback')

    // Turn 2: 下一轮自动切换至第 2 候选 m-fallback，并且 prepareRequest 校验一致
    const step2 = await simulateLoopStep(host, sub, 2)
    assert.equal(step2.selection.model, 'm-fallback')
    assert.equal(step2.proposedConfig.model, 'm-fallback')
  } finally {
    await host.cleanup()
  }
})

test('Test 5: 清除 override 恢复 Level 5 inherit 时，传递具体 baseline 路线，严禁向 agent.model.select 传 null', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 创建一个无 default 快照的普通 teammate，初始基线为 p-orig/m-orig
    const m = createTeammateAgent('m-null-check', 'lead-1', 'worker-null-check', {
      provider: 'p-orig',
      model: 'm-orig',
    })
    host.registerTeammate(lead, m, 'worker-null-check')
    await host.emitProvisioning('lead-1', 'm-null-check', 'worker-null-check')
    await host.emitAgentCreated(m)

    // 监控 agent.model.select：断言传入参数绝不能是 null / undefined
    const originalSelect = m.model.select.bind(m.model)
    m.model.select = (sel) => {
      assert.notEqual(sel, null, 'agent.model.select must never receive null (would cause TypeError in real SDK)')
      assert.notEqual(sel, undefined, 'agent.model.select must never receive undefined')
      assert.ok(sel.provider && sel.model, 'selection must have provider and model')
      originalSelect(sel)
    }

    // 设置 override 为 p-override/m-override
    const curV = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-null-check',
      selection: { provider: 'p-override', model: 'm-override' },
      revision: curV.body.view.revision,
    })

    // Turn 2 生效 override
    await simulateLoopStep(host, m, 2)
    assert.equal(m.model.current().model, 'm-override')

    // 清除 override (selection: null)
    const curV2 = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=lead-1')
    await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', MUTATION_HEADERS, {
      sessionId: 'lead-1',
      target: 'm-null-check',
      selection: null,
      revision: curV2.body.view.revision,
    })

    // Turn 3: 恢复到继承基线 p-orig/m-orig，且绝不传 null 触发 TypeError
    const step3 = await simulateLoopStep(host, m, 3)
    assert.equal(step3.selection.provider, 'p-orig')
    assert.equal(step3.selection.model, 'm-orig')
  } finally {
    await host.cleanup()
  }
})

test('Test 6: 冷恢复 turn 计算：冷恢复到 turn 10 时，effectiveAfterTurn 为 8 的覆盖必须正确生效新选择', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 创建已经在第 10 轮的成员
    const m = createTeammateAgent('m-cold-10', 'lead-1', 'worker-cold')
    host.registerTeammate(lead, m, 'worker-cold')
    await host.emitProvisioning('lead-1', 'm-cold-10', 'worker-cold')

    // 模拟成员 session 中有历史 turn 1..10 的事件
    m._setTurn(10)

    // 预先向存储写入已存在的 choices (模拟从磁盘恢复已存在的团队记录：effectiveAfterTurn 为 8)
    const { readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const teamsPath = join(host.dshHome, 'team-member-model', 'teams.json')
    let teamsData = {}
    try {
      teamsData = JSON.parse(await readFile(teamsPath, 'utf8'))
    } catch {}
    teamsData['lead-1'] = teamsData['lead-1'] || { revision: 1, defaultModel: null, initials: {}, choices: {} }
    teamsData['lead-1'].choices['m-cold-10'] = {
      selection: { provider: 'p-new', model: 'm-new' },
      heldSelection: { provider: 'p-old', model: 'm-old' },
      effectiveAfterTurn: 8,
    }
    await writeFile(teamsPath, JSON.stringify(teamsData, null, 2), 'utf8')

    // 重新从磁盘加载 teamStore 状态
    await apply(host.ctx, {})

    // 模拟冷恢复触发 agent/created
    await host.emitAgentCreated(m)

    // 此时冷恢复计算 turn 应为 Math.max(1, lastOwnTurn + 1) = 11 > 8，必须生效新选择 p-new/m-new
    assert.equal(m.model.current()?.model, 'm-new', 'cold recovery at turn 10 must activate choice with effectiveAfterTurn 8')
  } finally {
    await host.cleanup()
  }
})

test('Test 7: 非团队 plain 子 agent 也支持策略 auto 路由并在 preStep 前完成选模', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {
      members: [
        { provider: 'p-auto', model: 'm-plain-auto' },
      ],
      rules: [
        { use: 'p-auto/m-plain-auto', channel: 'spawn', label: '*' },
      ],
      failover: { enabled: true, patience: 2 },
    })

    // 建立一个普通的非团队 child agent (没有 agentTeams membership)
    const plainChild = {
      id: 'plain-child-1',
      session: {
        id: 'plain-child-1',
        header: {
          id: 'plain-child-1',
          origin: 'subagent',
          delegationDepth: 1,
          cwd: '/home/me/proj',
        },
        ownEvents: () => [],
        snapshotEvents: () => [],
        requestHeader: () => undefined,
      },
      options: { provider: 'init-p', model: 'init-m' },
    }
    let currentSelection = { provider: 'init-p', model: 'init-m' }
    plainChild.model = {
      current: () => currentSelection,
      select: (sel) => { currentSelection = sel ? { ...sel } : undefined },
    }

    host.agentRegistry.set(plainChild.id, plainChild)

    // 身份未可验证时 created 保持原模型，不提前标记当前轮。
    await host.emitAgentCreated(plainChild)
    assert.deepEqual(plainChild.model.current(), { provider: 'init-p', model: 'init-m' })
    plainChild._setTurn = () => {}
    // claimed 同步触发选模，随后模拟 preStep 固定和 prepareRequest 全字段校验。
    const { selection, proposedConfig } = await simulateLoopStep(host, plainChild, 1)
    assert.equal(selection.model, 'm-plain-auto')
    assert.equal(proposedConfig.model, 'm-plain-auto')
  } finally {
    await host.cleanup()
  }
})

test('冷恢复清除覆盖时保留 SDK 原始 options 的不同 reasoningEffort', async () => {
  const host = await createIntegrationHost()
  try {
    const { TeamStateStore } = await import('../lib/team-state.js')
    const store = new TeamStateStore(`${host.dshHome}/team-member-model`)
    await store.init()
    await store.updateTeam('effort-root', team => {
      team.initials['effort-child'] = { selection: null, source: 'default' }
      team.choices['effort-child'] = { selection: null, effectiveAfterTurn: 0 }
      return team
    })
    const lead = createLeadAgent('effort-root')
    lead.options = { provider: 'same-p', model: 'same-m', reasoningEffort: 'low' }
    const member = createTeammateAgent('effort-child', lead.id, 'worker')
    member.options = { provider: 'same-p', model: 'same-m', reasoningEffort: 'high' }
    member.model.select({ provider: 'history-p', model: 'history-m' })
    host.registerLead(lead)
    host.registerTeammate(lead, member)
    await apply(host.ctx, {})
    await host.emitAgentCreated(member)
    const step = await simulateLoopStep(host, member, 2)
    assert.deepEqual(step.selection, { provider: 'same-p', model: 'same-m', reasoningEffort: 'high' })
  } finally { await host.cleanup() }
})

test('Test 8: 冷恢复继承基线严格取 SDK 创建 options，绝不被历史 manual choice 污染', async () => {
  const host = await createIntegrationHost()
  try {
    await apply(host.ctx, {})
    const lead = createLeadAgent('lead-1')
    host.registerLead(lead)

    // 创建一个成员，其 options 固定为 lead-base-p/lead-base-m
    const m = createTeammateAgent('m-cold-base', 'lead-1', 'worker-cold-base', {
      provider: 'lead-base-p',
      model: 'lead-base-m',
    })
    host.registerTeammate(lead, m, 'worker-cold-base')
    await host.emitProvisioning('lead-1', 'm-cold-base', 'worker-cold-base')

    // 模拟冷恢复：历史 projection 重放使 agent.model.current() 暂时返回历史覆盖模型 p-override/m-override
    m.model.select({ provider: 'p-override', model: 'm-override' })
    assert.equal(m.model.current().model, 'm-override')

    // 模拟团队 choices 已被用户清除覆盖 (selection: null)
    const { readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const teamsPath = join(host.dshHome, 'team-member-model', 'teams.json')
    let teamsData = {}
    try {
      teamsData = JSON.parse(await readFile(teamsPath, 'utf8'))
    } catch {}
    teamsData['lead-1'] = teamsData['lead-1'] || { revision: 1, defaultModel: null, initials: {}, choices: {} }
    teamsData['lead-1'].initials['m-cold-base'] = { selection: null, source: 'default' }
    teamsData['lead-1'].choices['m-cold-base'] = { selection: null, effectiveAfterTurn: 0 }
    await writeFile(teamsPath, JSON.stringify(teamsData, null, 2), 'utf8')

    // 重新应用插件加载冷恢复状态
    await apply(host.ctx, {})

    // 触发冷恢复 agent/created：应严格抓取 m.options (lead-base-p)，严禁抓取已被污染的 m.model.current()
    await host.emitAgentCreated(m)

    // 随后进入 Turn 2 执行步准备
    const step = await simulateLoopStep(host, m, 2)

    // 断言：由于清除覆盖，顺利退回到真正未受污染的继承基线 lead-base-p/lead-base-m
    assert.equal(step.selection.provider, 'lead-base-p')
    assert.equal(step.selection.model, 'lead-base-m')
  } finally {
    await host.cleanup()
  }
})
