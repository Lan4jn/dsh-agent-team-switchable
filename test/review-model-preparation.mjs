/**
 * test/review-model-preparation.mjs
 * 独立审查测试：复现第二轮模型准备实现中的关键缺陷与边界风险。
 * 运行方式：
 *   node --test test/review-model-preparation.mjs
 *   或者：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/review-model-preparation.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ELECTRON_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const ASAR_ROOT = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'

if (!process.versions.electron) {
  test('delegates to Electron runner for real asar SDK execution', () => {
    const res = spawnSync(ELECTRON_BIN, [new URL(import.meta.url).pathname], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    })
    if (res.status !== 0) {
      console.error(res.stderr || res.stdout)
    }
    assert.equal(res.status, 0, `Electron test run failed with code ${res.status}`)
  })
} else {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const testHome = await mkdtemp(join(tmpdir(), 'tmm-review-test-'))
  process.env.DSH_HOME = testHome

  const cordisPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`
  const dshAgentPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/dsh-agent/lib/index.js`
  const dshLoopPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`

  const { Context } = await import(cordisPath)
  const { modelSelectionProjectionDefinition } = await import(dshAgentPath)
  const { AgentLoop } = await import(dshLoopPath)
  const { apply } = await import('../lib/index.js')
  const { resolveTeamRoute } = await import('../lib/team-routing.js')
  const { TeamStateStore } = await import('../lib/team-state.js')

  test('Check 1: 验证 team-routing 已修复裸 agent.options 继承问题，正确命中 Level 3 captureddefault', () => {
    const teamRecord = {
      teamId: 'team-root-1',
      defaultModel: { provider: 'default-p', model: 'default-m' },
      initials: {
        'worker-1': {
          selection: { provider: 'default-p', model: 'default-m' },
          source: 'default',
        },
      },
      choices: {},
    }

    // 宿主合并后的裸 agent.options（继承自 Lead）
    const agentOptions = { provider: 'lead-p', model: 'lead-m' }

    const resolution = resolveTeamRoute({
      agentId: 'worker-1',
      turn: 1,
      teamRecord,
      agentOptions,
    })

    // 经修复后，裸 options 不再被误判为 createexplicit，正确下沉到 captureddefault
    assert.equal(resolution?.level, 'captureddefault')
    assert.equal(resolution?.route.provider, 'default-p')
    assert.equal(resolution?.route.model, 'default-m')
  })

  test('Check 2 (P0 Verified): 冷恢复时 state.baselines 严格取 SDK 初始 options，历史 manual choice 绝不污染 Level 5 继承基线', async () => {
    // 场景复现：
    // 成员在历史轮次存在 manual override (p-override/m-override)
    // 现恢复会话，用户在历史已将 choice.selection 设为 null（清除覆盖，意图恢复为 Lead 继承底线 lead-base-p）
    // 但在 lib/index.js:1411 处：
    //   const initialCurrent = agent.model?.current()
    //   const base = initialCurrent ?? ...
    //   state.baselines.set(memberId, base)
    // 导致 baselines 存入了历史的 p-override！
    const preStore = new TeamStateStore(join(testHome, 'team-member-model'))
    await preStore.init()
    await preStore.updateTeam('team-root-1', (team) => {
      team.defaultModel = null
      team.initials['worker-1'] = { selection: null, source: 'default' }
      team.choices['worker-1'] = { selection: null, effectiveAfterTurn: 0 }
      return team
    })

    const ctx = new Context()
    let selectionState = {
      lastUsed: { provider: 'p-override', model: 'm-override' },
      pending: null,
    }

    ctx.reflect.provide('agents', {
      turnBoundaryOf: () => ({ lastTurn: 10 }),
      enter: () => () => {},
      announce: async () => {},
      setFactory: () => () => {},
    })
    ctx.reflect.provide('sessions', { enter: () => () => {}, announce: () => {} })
    ctx.reflect.provide('llm', { prepareCall: async (c) => ({ config: c }) })
    ctx.reflect.provide('tools', { resolve: async () => ({ dispose: () => {} }), register: () => () => {} })
    ctx.reflect.provide('systemPrompt', {
      variable: () => () => {},
      assemble: async () => ({ tools: [], sections: [], contexts: [], variables: {} }),
      refreshContext: () => [],
    })
    ctx.reflect.provide('sessionProjections', {
      register: async (def) => ({
        readerFor: (s) => () => (def.key === 'modelSelection' ? selectionState : s.inboxState),
      }),
    })
    const root = { id: 'team-root-1', options: { provider: 'lead-base-p', model: 'lead-base-m' } }
    ctx.reflect.provide('agentTeams', { isEnabled: (agent) => agent === root })
    ctx.reflect.provide('webServer', { register: () => () => {} })

    class SubagentsStub {
      rootOf() { return root }
      async listDescendants() { return [] }
      async startContinuable() {}
      async startLocal() {}
      async startExternal() {}
      async start() {}
      getProvider() { return { name: 'spawn', capabilities: { agentOptions: true } } }
    }
    ctx.reflect.provide('subagents', new SubagentsStub())

    const loopFiber = ctx.plugin(AgentLoop, { agents: [] })
    await loopFiber
    const loop = ctx.agentLoop

    let seq = 0
    const session = {
      id: 'worker-1',
      surface: { contentGeneration: 1 },
      toolHistory: () => [],
      requestContext: () => undefined,
      requestHeader: () => undefined,
      deriveMessages: () => [],
      snapshotEvents: () => [],
      append: (type, data) => {
        const ev = { type, data, seq: ++seq }
        if (type === 'model/selection') {
          selectionState = modelSelectionProjectionDefinition.apply(selectionState, ev)
        }
        return ev
      },
      inboxState: { 'next-turn': [{ id: 'turn-msg-1', text: 'hi' }], 'next-step': [] },
      header: { cwd: '/tmp', delegationDepth: 1, origin: 'subagent' },
    }

    // 真实构建 ReactLoopAgent，此时历史 current() 为 p-override
    const res = await loop.initializeAgent(ctx, {
      session,
      agentOptions: { provider: 'lead-base-p', model: 'lead-base-m' },
      source: 'restore',
    })

    await apply(ctx, {
      members: [],
      rules: [],
    })

    // 触发 Turn 11 的消息认领与选模：用户期望恢复为 Lead 的继承底线 lead-base-p
    res.agent.inbox.claim('next-turn', 11)

    const finalModel = res.agent.model.current()
    console.log('[Diagnostic] Cleared override fallback model:', finalModel)

    // 验证修复：已正确退回 Lead 的继承底线 lead-base-p，不再被历史的 p-override 污染
    assert.equal(finalModel.provider, 'lead-base-p')
    assert.equal(finalModel.model, 'lead-base-m')

    await res.dispose()
  })

  test('Verification 3: 验证真实 ReactLoopAgent.prototype.preStep 完整管道（tools、systemPrompt、selection 强绑定）', async () => {
    const ctx = new Context()
    let selectionState = modelSelectionProjectionDefinition.init()

    let resolvedToolsSelection = null
    let assembledPromptSelection = null

    ctx.reflect.provide('agents', {
      turnBoundaryOf: () => ({ lastTurn: 0 }),
      enter: () => () => {},
      announce: async () => {},
      setFactory: () => () => {},
    })
    ctx.reflect.provide('sessions', { enter: () => () => {}, announce: () => {} })
    ctx.reflect.provide('llm', { prepareCall: async (c) => ({ config: c }) })
    ctx.reflect.provide('tools', {
      resolve: async (opts) => {
        resolvedToolsSelection = opts.modelSelection
        return { dispose: () => {} }
      },
      register: () => () => {},
    })
    ctx.reflect.provide('systemPrompt', {
      variable: () => () => {},
      assemble: async (opts) => {
        assembledPromptSelection = opts.modelSelection
        return { tools: [], sections: [], contexts: [], variables: {} }
      },
      refreshContext: () => [],
    })
    ctx.reflect.provide('sessionProjections', {
      register: async (def) => ({
        readerFor: (s) => () => (def.key === 'modelSelection' ? selectionState : s.inboxState),
      }),
    })
    ctx.reflect.provide('agentTeams', {
      tryMembership: () => ({
        id: 'team-root-1',
        role: 'teammate',
        name: 'worker-1',
        root: { id: 'team-root-1', options: { provider: 'lead-p', model: 'lead-m' } },
      }),
    })
    ctx.reflect.provide('webServer', { register: () => () => {} })

    class SubagentsStub {
      async startContinuable() {}
      async startLocal() {}
      async startExternal() {}
      async start() {}
      getProvider() { return { name: 'spawn', capabilities: { agentOptions: true } } }
    }
    ctx.reflect.provide('subagents', new SubagentsStub())

    const loopFiber = ctx.plugin(AgentLoop, { agents: [] })
    await loopFiber
    const loop = ctx.agentLoop

    let seq = 0
    const session = {
      id: 'worker-1',
      surface: { contentGeneration: 1 },
      toolHistory: () => [],
      requestContext: () => undefined,
      requestHeader: () => undefined,
      deriveMessages: () => [],
      snapshotEvents: () => [],
      append: (type, data) => {
        const ev = { type, data, seq: ++seq }
        if (type === 'model/selection') {
          selectionState = modelSelectionProjectionDefinition.apply(selectionState, ev)
        }
        return ev
      },
      inboxState: { 'next-turn': [{ id: 'turn-msg-1', text: 'run' }], 'next-step': [] },
      header: { cwd: '/tmp', delegationDepth: 1, origin: 'subagent' },
    }

    const res = await loop.initializeAgent(ctx, {
      session,
      agentOptions: { provider: 'init-p', model: 'init-m' },
      source: 'startup',
    })

    const agent = res.agent

    // 在 agent/inbox/claimed 阶段选择 target-p/target-m
    ctx.on('agent/inbox/claimed', () => {
      agent.model.select({ provider: 'target-p', model: 'target-m' })
    })

    // 真正执行 ReactLoopAgent.prototype.preStep 完整管道！
    agent.phase = { kind: 'running', turn: 1, step: 0, abort: new AbortController() }

    const decision = await agent.preStep('next-turn', { turn: 1, step: 1 })

    // 验证 preStep 完整管道：
    // 1. tools.resolve 接收到的是新选定的 target-p
    assert.deepEqual(resolvedToolsSelection, { provider: 'target-p', model: 'target-m' })
    // 2. systemPrompt.assemble 接收到的也是 target-p
    assert.deepEqual(assembledPromptSelection, { provider: 'target-p', model: 'target-m' })
    // 3. decision.selection 返回的也是 target-p
    assert.deepEqual(decision.selection, { provider: 'target-p', model: 'target-m' })

    await res.dispose()
  })
}
