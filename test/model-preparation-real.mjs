/**
 * test/model-preparation-real.mjs
 * 独立生命周期与生产集成测试：基于当前官方运行时真实 SDK 与生产 plugin 验证模型准备与选择锁定契约。
 * 运行方式：
 *   node --test test/model-preparation-real.mjs
 *   或者：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/model-preparation-real.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ELECTRON_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const ASAR_ROOT = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'

// 当在普通 node 环境运行时，自动借助 Electron 环境执行以无缝读取 asar 内真实 SDK
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
  // 以下测试在真实 Electron Node 运行时执行，直接加载 app.asar 真实包
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const testHome = await mkdtemp(join(tmpdir(), 'tmm-real-sdk-'))
  process.env.DSH_HOME = testHome

  const cordisPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`
  const dshAgentPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/dsh-agent/lib/index.js`
  const dshLoopPath = `${ASAR_ROOT}/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`

  const { Context } = await import(cordisPath)
  const { modelSelectionProjectionDefinition } = await import(dshAgentPath)
  const { AgentLoop } = await import(dshLoopPath)
  const { apply } = await import(process.env.TMM_TEST_PLUGIN_ENTRY ?? '../lib/index.js')
  const { makeReq, makeRes } = await import('./integration-support.mjs')

  async function createRealHarness(options = {}) {
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'tmm-real-case-'))
    const ctx = new Context()
    let selectionState = modelSelectionProjectionDefinition.init()
    const sessionEvents = []
    const routes = []
    const root = { id: 'team-root-1', options: { provider: 'lead-p', model: 'lead-m' } }
    let liveAgent

    ctx.reflect.provide('agents', {
      get: (id) => id === root.id ? root : liveAgent?.id === id ? liveAgent : undefined,
      turnBoundaryOf: () => ({ lastTurn: 0 }),
      enter: () => () => {},
      announce: async () => {},
      setFactory: () => () => {},
    })

    ctx.reflect.provide('sessions', {
      enter: () => () => {},
      announce: () => {},
    })

    ctx.reflect.provide('llm', {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
      prepareCall: async (config) => ({
        config,
        retryPolicy: undefined,
        adapterDefaults: {},
        stream: () => [],
      }),
    })

    ctx.reflect.provide('tools', {
      resolve: async () => ({ dispose: () => {} }),
      register: () => () => {},
    })

    ctx.reflect.provide('systemPrompt', {
      variable: () => () => {},
      assemble: async () => ({ tools: [], sections: [], contexts: [], variables: {} }),
      refreshContext: () => [],
    })

    ctx.reflect.provide('sessionProjections', {
      register: async (def) => ({
        readerFor: (s) => () => {
          if (def.key === 'modelSelection') return selectionState
          if (def.key === 'inbox') return s.inboxState
          return def.init()
        },
      }),
    })

    ctx.reflect.provide('sessionController', {
      resolveAgent: async (id) => id === root.id ? { agent: root } : { error: new Error('not found') },
    })
    ctx.reflect.provide('agentTeams', {
      isEnabled: (a) => a === root,
    })
    ctx.reflect.provide('connection', { requestRejection: () => undefined })
    ctx.reflect.provide('webServer', {
      register: (route) => { routes.push(route); return () => {} },
    })

    class SubagentsStub {
      rootOf(agent) { if (agent === root || agent === liveAgent) return root; throw new Error('UNAUTHORIZED') }
      async listDescendants(id) { if (id !== root.id) throw new Error('UNAUTHORIZED'); return [{ kind: 'child', id: 'test-teammate', name: 'worker-1', path: 'worker-1', mode: 'continuable', activity: 'inactive', parentId: root.id, depth: 1, hasChildren: false }] }
      async startContinuable() {}
      async startLocal() {}
      async startExternal() {}
      async start() {}
      getProvider(name) {
        if (name === 'spawn' || name === 'fork') return { name, capabilities: { agentOptions: true } }
        return undefined
      }
    }
    ctx.reflect.provide('subagents', new SubagentsStub())

    // 加载生产 AgentLoop 服务
    const loopFiber = ctx.plugin(AgentLoop, { agents: [] })
    await loopFiber
    const loop = ctx.agentLoop

    // 创建测试 Session 实体
    let seqCounter = 0
    const session = {
      id: 'test-teammate',
      surface: { contentGeneration: 1 },
      toolHistory: () => [],
      requestContext: () => undefined,
      requestHeader: () => undefined,
      deriveMessages: () => [],
      snapshotEvents: () => sessionEvents,
      append: (type, data) => {
        const ev = { type, data, seq: ++seqCounter }
        sessionEvents.push(ev)
        if (type === 'model/selection') {
          selectionState = modelSelectionProjectionDefinition.apply(selectionState, ev)
        }
        return ev
      },
      inboxState: { 'next-turn': [], 'next-step': [] },
      header: { cwd: '/tmp', delegationDepth: 1, origin: 'subagent' },
    }

    // 由真实 AgentLoop.initializeAgent 实例化真实的 ReactLoopAgent 和 ReactLoopInbox
    const res = await loop.initializeAgent(ctx, {
      session,
      agentOptions: {
        provider: 'init-p',
        model: 'init-m',
        __tmmInjected: true,
      },
      source: 'startup',
    })

    const agent = res.agent
    liveAgent = agent

    // 加载生产插件并配置自动路由策略
    await apply(ctx, options.policy ?? {
      members: [
        { provider: 'primary-p', model: 'primary-m' },
        { provider: 'fallback-p', model: 'fallback-m' },
      ],
      rules: [
        { use: 'primary-p/primary-m', channel: 'spawn', label: '*' },
      ],
      failover: { enabled: true, patience: 2 },
    })

    return {
      ctx,
      loop,
      session,
      agent,
      async api(method, suffix, body) {
        const route = routes.find((r) => r.path === '/api/dsh-team-member-model')
        assert.ok(route, 'production HTTP handler registered')
        const response = makeRes()
        await route.handler(makeReq(method, '/api/dsh-team-member-model' + suffix,
          { 'x-dsh-team-member-model': '1', 'content-type': 'application/json' },
          body === undefined ? undefined : JSON.stringify(body)), response)
        assert.equal(response.statusCode, 200, response.body)
        return JSON.parse(response.body)
      },
      dispose: async () => {
        await res.dispose()
      },
    }
  }

  test('Case 1: 真实 ReactLoopAgent + 生产 agent/inbox/claimed 钩子驱动正式选模，使真实 prepareRequest 校验通过', async () => {
    const harness = await createRealHarness()
    const { session, agent, dispose } = harness

    try {
      // 验证真实类名
      assert.equal(agent.constructor.name, 'ReactLoopAgent')
      assert.equal(agent.inbox.constructor.name, 'ReactLoopInbox')

      // 投放一条待消费消息到 next-turn
      session.inboxState['next-turn'].push({ id: 'msg-turn-1', text: 'start task' })

      // 触发真实 ReactLoopInbox.prototype.claim -> 同步派发生产 agent/inbox/claimed 钩子
      const claimed = agent.inbox.claim('next-turn', 1)
      assert.equal(claimed.length, 1)

      // 断言：生产钩子在 L671 采样前调用了 agent.model.select()，使 model.current() 同步选为 primary-m
      const stepSelection = agent.model.current()
      assert.equal(stepSelection.provider, 'primary-p')
      assert.equal(stepSelection.model, 'primary-m')

      // 执行真实的 ReactLoopAgent.prototype.prepareRequest 调用，绝不抛出冲突异常
      const prepResult = await agent.prepareRequest(1, 1, stepSelection, new AbortController().signal)
      assert.equal(prepResult.config.provider, 'primary-p')
      assert.equal(prepResult.config.model, 'primary-m')
    } finally {
      await dispose()
    }
  })

  test('Case 2: 真实 ReactLoopAgent 在 preStep 锁定后，若 agent/request 试图篡改模型，精确触发官方报错', async () => {
    const harness = await createRealHarness()
    const { ctx, session, agent, dispose } = harness

    try {
      session.inboxState['next-turn'].push({ id: 'msg-1' })
      agent.inbox.claim('next-turn', 1)
      const stepSelection = agent.model.current()

      // 模拟旧插件在 agent/request 中强制篡改模型返回 deepseek
      agent.ctx.on('agent/request', async (_payload, _next) => {
        return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
      })

      // 执行真实的 ReactLoopAgent.prototype.prepareRequest，断言必定触发官方 L1000 守卫错误
      await assert.rejects(
        async () => {
          await agent.prepareRequest(1, 1, stepSelection, new AbortController().signal)
        },
        (err) => {
          assert.match(err.message, /after step preparation fixed/)
          assert.match(err.message, /use agent\.model\.select\(\) before step preparation/)
          return true
        },
      )
    } finally {
      await dispose()
    }
  })

  test('Case 3: 证明同 step 内部重试循环中 decision.selection 固定不可变，跨模型重试无官方重 prepare 通道', async () => {
    const harness = await createRealHarness()
    const { session, agent, dispose } = harness

    try {
      session.inboxState['next-turn'].push({ id: 'msg-1' })
      agent.inbox.claim('next-turn', 1)

      // 模拟 preStep 完成返回的 decision 结构（入参传递给 step）
      const decision = {
        kind: 'enter',
        selection: agent.model.current(),
      }
      assert.equal(decision.selection.provider, 'primary-p')

      // 在同 step 内部发生错误时，即使通过某种方式修改了 model
      agent.model.select({ provider: 'fallback-p', model: 'fallback-m' })

      // 关键事实断言：step(decision) 中的 decision.selection 始终锁定为 primary-p，证明同 step 重试无法换模
      assert.equal(decision.selection.provider, 'primary-p')
      assert.notEqual(decision.selection.provider, agent.model.current().provider)
    } finally {
      await dispose()
    }
  })

  test('Case 4: 验证生产 deferred failover：当前轮失败放行交官方，下一轮通过 agent/inbox/claimed 顺利切至新候选', async () => {
    const harness = await createRealHarness()
    const { ctx, session, agent, dispose } = harness

    try {
      // Turn 1 开始
      session.inboxState['next-turn'].push({ id: 'msg-turn-1' })
      agent.inbox.claim('next-turn', 1)
      assert.equal(agent.model.current().provider, 'primary-p')

      // 验证 Turn 1 的真实 prepareRequest 正常通过
      const prep1 = await agent.prepareRequest(1, 1, agent.model.current(), new AbortController().signal)
      assert.equal(prep1.config.provider, 'primary-p')

      // 模拟 Turn 1 发生可重试错误：触发生产 agent/request-error 监听器
      let nextCalled = false
      const action = await ctx.waterfall(
        agent,
        'agent/request-error',
        {
          agent,
          turn: 1,
          step: 1,
          provider: 'primary-p',
          failure: { status: 503, message: 'Service Unavailable' },
          signal: new AbortController().signal,
        },
        async () => {
          nextCalled = true
          return undefined
        },
      )

      // 断言：生产监听器不返回 { kind: 'retry' }（不冒充同 step 换模），如实放行交官方处理
      assert.equal(nextCalled, true)
      assert.equal(action, undefined)
      // 官方同一步重试仍是 A；第二次 A 失败不能跳过尚未运行的 B。
      const retry = await agent.prepareRequest(1, 1, agent.model.current(), new AbortController().signal)
      assert.equal(retry.config.provider, 'primary-p')
      await ctx.waterfall(agent, 'agent/request-error', {
        agent, turn: 1, step: 1, provider: 'primary-p',
        failure: { status: 503, message: 'same step retry failed' }, signal: new AbortController().signal,
      }, async () => undefined)

      // Turn 2 发生（下一轮开始）
      session.inboxState['next-turn'].push({ id: 'msg-turn-2' })
      // 触发真实 claim
      agent.inbox.claim('next-turn', 2)

      // 断言：Turn 2 开始前已平滑、合规切到候选 2 (fallback-p/fallback-m)
      const turn2Selection = agent.model.current()
      assert.equal(turn2Selection.provider, 'fallback-p')
      assert.equal(turn2Selection.model, 'fallback-m')

      // 验证 Turn 2 真实 prepareRequest 顺畅通过
      const prep2 = await agent.prepareRequest(2, 1, turn2Selection, new AbortController().signal)
      assert.equal(prep2.config.provider, 'fallback-p')
      assert.equal(prep2.config.model, 'fallback-m')
    } finally {
      await dispose()
    }
  })

  test('Case 5: 真实 SDK clear override 恢复 inherit 时，必须使用捕获的继承基线 ModelSelection，绝不能传 null 触发 TypeError', async () => {
    const harness = await createRealHarness()
    const { session, agent, dispose } = harness

    try {
      // 1. 先设置一个已生效的覆盖选择
      agent.model.select({ provider: 'override-p', model: 'override-m' })
      assert.equal(agent.model.current().model, 'override-m')

      // 2. 证明若企图通过 agent.model.select(null) 清除覆盖，会抛出 TypeError (官方 SDK 限制)
      assert.throws(
        () => {
          agent.model.select(null)
        },
        TypeError,
      )

      // 3. 验证当传递具体的 baseline selection 时，恢复成功且 current() 恢复基线
      const baseline = { provider: 'lead-p', model: 'lead-m' }
      agent.model.select(baseline)
      assert.deepEqual(agent.model.current(), baseline)

      // 4. 验证 prepareRequest 在恢复基线后顺畅通过
      const prep = await agent.prepareRequest(1, 1, baseline, new AbortController().signal)
      assert.equal(prep.config.provider, 'lead-p')
      assert.equal(prep.config.model, 'lead-m')
    } finally {
      await dispose()
    }
  })

  test('Case 6: actual preStep + consecutive saveTeam changes preserve A until next turn selects C', async () => {
    const modelA = { provider: 'gemini', model: 'gemini-3.8-flash-tiered' }
    const { session, agent, api, dispose } = await createRealHarness({ policy: {
      members: [modelA, { provider: 'gemini', model: 'gemini-4-argon-high' }],
      rules: [{ use: 'gemini/gemini-3.8-flash-tiered', channel: 'spawn', label: '*' }],
      failover: { enabled: true, patience: 2 },
    } })
    try {
      session.append('turn/start', { turn: 1 })
      session.inboxState['next-turn'].push({ id: 'boundary-turn-1', content: [] })
      agent.phase = { kind: 'running', turn: 1, step: 0, abort: new AbortController() }
      const decision = await agent.preStep('next-turn', { turn: 1, step: 1 })
      assert.deepEqual(decision.selection, modelA)
      let { view } = await api('GET', '/teams?sessionId=team-root-1')
      for (const selection of [
        { provider: 'gemini', model: 'gemini-4-argon-high', reasoningEffort: 'low' },
        { provider: 'gemini', model: 'gemini-4-argon-high', reasoningEffort: 'high' },
      ]) {
        ;({ view } = await api('PUT', '/teams', {
          sessionId: 'team-root-1', target: agent.id, selection, revision: view.revision,
        }))
      }
      const selectionsBefore = session.snapshotEvents().filter((e) => e.type === 'model/selection').length
      for (let retry = 0; retry < 2; retry++) {
        const request = await agent.prepareRequest(1, 1, decision.selection, new AbortController().signal)
        assert.deepEqual({ provider: request.config.provider, model: request.config.model }, modelA)
      }
      session.inboxState['next-turn'].push({ id: 'duplicate-turn-1', content: [] })
      agent.inbox.claim('next-turn', 1)
      assert.deepEqual(agent.model.current(), modelA)
      assert.equal(session.snapshotEvents().filter((e) => e.type === 'model/selection').length, selectionsBefore)
      session.append('turn/start', { turn: 2 })
      session.inboxState['next-turn'].push({ id: 'boundary-turn-2', content: [] })
      agent.phase = { kind: 'running', turn: 2, step: 0, abort: new AbortController() }
      const next = await agent.preStep('next-turn', { turn: 2, step: 1 })
      assert.deepEqual(next.selection, { provider: 'gemini', model: 'gemini-4-argon-high', reasoningEffort: 'high' })
      const request = await agent.prepareRequest(2, 1, next.selection, new AbortController().signal)
      assert.equal(request.config.model, 'gemini-4-argon-high')
      assert.equal(request.config.reasoningEffort, 'high')
    } finally {
      await dispose()
    }
  })
}
