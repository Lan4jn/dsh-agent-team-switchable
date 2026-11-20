import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { makeReq, makeRes } from './integration-support.mjs'

const root = process.env.DSH_INSTALL_DIR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh'
const require = createRequire(join(root, 'package.json'))
const load = name => import(require.resolve('@deepseek-ai/' + name))

test('rc3 team default model routing via tool-subagent execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tmm-rc3-team-'))
  process.env.DSH_HOME = home
  const { Context } = await load('cordis')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { SubagentRuntime } = await load('dsh-subagent')
  const persistence = await load('dsh-session-persistence-jsonl')
  const query = await load('dsh-session-query-sqlite')
  const toolSubagent = await load('dsh-tool-subagent')
  const production = await import('../lib/index.js')

  const ctx = new Context()
  const prepared = []
  ctx.reflect.provide('llm', {
    prepareCall: async (config, signal) => {
      prepared.push({ config, signal })
      return { config, adapterDefaults: {}, stream: () => [] }
    },
    resolveModelInfo: async (provider, model) => ({
      provider,
      model,
      reasoning: { efforts: [{ id: 'high' }, { id: 'low' }], defaultEffort: 'low' }
    })
  })

  const registeredTools = new Map()
  ctx.reflect.provide('tools', {
    resolve: async () => ({ dispose() {} }),
    register: (def) => {
      registeredTools.set(def.name, def)
      return () => registeredTools.delete(def.name)
    },
    list: () => Array.from(registeredTools.values())
  })

  ctx.reflect.provide('systemPrompt', {
    variable: () => () => {},
    getContextOrder: () => ['default'],
    getSectionOrder: () => ['default'],
    section: () => () => {},
    context: () => (ctx) => ({ default: [] }),
    assemble: async () => ({ tools: [], sections: [], contexts: [], variables: {} }),
    refreshContext: () => []
  })
  ctx.reflect.provide('workingDirectory', { get: () => '/tmp', ensure: async () => '/tmp', set: async () => '/tmp' })
  let handler
  ctx.reflect.provide('webServer', { register: spec => { handler = spec.handler; return () => {} } })
  ctx.reflect.provide('connection', { requestRejection: () => undefined })
  ctx.reflect.provide('sessionController', { resolveAgent: async id => ({ agent: ctx.agents.get(id) }) })
  ctx.reflect.provide('agentTeams', { isEnabled: () => true })

  const fibers = []
  try {
    for (const [plugin, config] of [
      [SessionStore, {}],
      [persistence, { root: join(home, 'sessions'), compression: 'none' }],
      [SessionProjectionRegistry, {}],
      [query.default, { path: ':memory:', openAt: 'never' }],
      [AgentRegistry, {}],
      [AgentLoop, { agents: [] }],
      [SubagentRuntime, {}]
    ]) {
      fibers.push(await ctx.plugin(plugin, config))
    }
    fibers.push(await ctx.plugin(production, {}))

    // 注册 spawn provider
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { agentOptions: true, depthLimit: true },
      inheritsParentContext: false,
      prepareContinuable: async () => ({})
    })

    // 加载官方 tool-subagent
    fibers.push(await ctx.plugin(toolSubagent, {
      provider: 'spawn',
      toolName: 'subagent',
      modelSelection: true,
      modelDiscovery: true, // 确保开启模型发现/允许 override
      maxDepth: 2,
    }))

    // 1. 设置 Lead 默认模型
    const leadId = 'lead-session'
    const leadHandle = await ctx.agents.create({ sessionId: leadId, agentOptions: { provider: 'lead-p', model: 'lead-m' } })

    // 2. PUT 设置 Team 默认模型（target: null）
    const read = makeRes()
    await handler(makeReq('GET', '/api/dsh-team-member-model/teams?sessionId=' + leadId), read)
    const view = JSON.parse(read.body).view

    const response = makeRes()
    const body = JSON.stringify({
      sessionId: leadId,
      revision: view.revision,
      target: null,
      selection: { provider: 'default-p', model: 'default-m' }
    })
    await handler(makeReq('PUT', '/api/dsh-team-member-model/teams', { 'x-dsh-team-member-model': '1' }, body), response)
    assert.equal(response.statusCode, 200, response.body)

    const requests = []
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      requests.push({ agentId: payload.agent.id, config, signal: payload.signal })
      return config
    })

    const tool = registeredTools.get('subagent')
    assert.ok(tool, 'subagent tool should be registered')

    // 3. 执行工具调用：不传 model 参数
    const toolExecResult = await tool.execute({
      description: 'child-no-args',
      prompt: 'hello world',
      name: 'child-worker'
    }, {
      agent: leadHandle.agent,
      signal: new AbortController().signal
    })

    assert.equal(toolExecResult.kind, 'activation')
    const childId = Array.from(ctx.agents.store.keys()).find(k => k !== leadId)
    assert.ok(childId, 'child session should be created')

    const child = ctx.agents.get(childId)
    assert.ok(child)
    await child.whenIdle()

    // 验证：不传 model 参数时，首请求是否命中 Team 默认模型
    const childReq = requests.find(r => r.agentId === childId)
    assert.ok(childReq, 'child should make a request')
    assert.equal(childReq.config.provider, 'default-p')
    assert.equal(childReq.config.model, 'default-m')

    // 4. 对照组：显式传入 model override
    const toolExecResult2 = await tool.execute({
      description: 'child-with-override',
      prompt: 'hello override',
      name: 'child-worker-2',
      provider: 'override-p',
      model: 'override-m'
    }, {
      agent: leadHandle.agent,
      signal: new AbortController().signal
    })

    const childId2 = Array.from(ctx.agents.store.keys()).find(k => k !== leadId && k !== childId)
    assert.ok(childId2, 'child-2 session should be created')

    const child2 = ctx.agents.get(childId2)
    assert.ok(child2)
    await child2.whenIdle()

    const childReq2 = requests.find(r => r.agentId === childId2)
    assert.ok(childReq2, 'child-2 should make a request')
    assert.equal(childReq2.config.provider, 'override-p')
    assert.equal(childReq2.config.model, 'override-m')

    await leadHandle.dispose()
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
