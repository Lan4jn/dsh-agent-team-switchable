import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeReq, makeRes } from './integration-support.mjs'
import { createRequire } from 'node:module'

const root = process.env.DSH_INSTALL_DIR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh'
const require = createRequire(join(root, 'package.json'))
const load = name => import(require.resolve('@deepseek-ai/' + name))

test('real rc3 warm catalog, stored choice and cold first request', async () => {
  assert.ok(process.versions.electron, 'run with ELECTRON_RUN_AS_NODE=1')
  const home = await mkdtemp(join(tmpdir(), 'tmm-rc3-real-'))
  process.env.DSH_HOME = home
  const { Context } = await load('cordis')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { SubagentRuntime } = await load('dsh-subagent')
  const persistence = await load('dsh-session-persistence-jsonl')
  const query = await load('dsh-session-query-sqlite')
  const ctx = new Context()
  const prepared = []
  ctx.reflect.provide('llm', { prepareCall: async (config, signal) => { prepared.push({ config, signal }); return { config, adapterDefaults: {}, stream: () => [] } } })
  ctx.reflect.provide('tools', { resolve: async () => ({ dispose() {} }), register: () => () => {} })
  ctx.reflect.provide('systemPrompt', { variable: () => () => {}, getContextOrder: () => [], context: () => () => {}, assemble: async () => ({ tools: [], sections: [], contexts: [], variables: {} }), refreshContext: () => [] })
  ctx.reflect.provide('workingDirectory', { get: () => '/tmp', ensure: async () => '/tmp', set: async () => '/tmp' })
  let handler
  ctx.reflect.provide('webServer', { register: spec => { handler = spec.handler; return () => {} } })
  ctx.reflect.provide('connection', { requestRejection: () => undefined })
  ctx.reflect.provide('sessionController', { resolveAgent: async id => ({ agent: ctx.agents.get(id) }) })
  ctx.reflect.provide('agentTeams', { isEnabled: () => true })
  const fibers = []
  try {
    for (const [plugin, config] of [[SessionStore, {}], [persistence, { root: join(home, 'sessions'), compression: 'none' }], [SessionProjectionRegistry, {}], [query.default, { path: ':memory:', openAt: 'never' }], [AgentRegistry, {}], [AgentLoop, { agents: [] }], [SubagentRuntime, {}]]) {
      const fiber = ctx.plugin(plugin, config)
      fibers.push(fiber)
      await fiber
    }
    const production = await import('../lib/index.js')
    const pluginFiber = ctx.plugin(production, {})
    fibers.push(pluginFiber)
    await pluginFiber
    assert.equal(typeof ctx.subagents.startActivation, 'function')
    const parentHandle = await ctx.agents.create({ sessionId: 'offline-root', agentOptions: { provider: 'offline', model: 'base' } })
    try {
      const parent = parentHandle.agent
      assert.equal(ctx.subagents.rootOf(parent), parent)
      const events = []
      ctx.on('agent/created', ({ agent }) => { if (agent.id === 'offline-child') events.push('created') })
      ctx.on('subagent/start', info => { if (info.id === 'offline-child') events.push(ctx.agents.get(info.id) ? 'published' : 'missing') })
      ctx.subagents.registerProvider({ name: 'offline', capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true }, inheritsParentContext: false, prepareContinuable: async () => ({}) })
      const activation = await ctx.subagents.startActivation({ provider: 'offline', childId: 'offline-child', name: 'worker', label: 'fixture', parent, prompt: [{ type: 'text', text: 'fixture' }], delivery: 'parent', signal: new AbortController().signal })
      try {
        const child = ctx.agents.get('offline-child')
        assert.ok(child)
        assert.deepEqual(events, ['created', 'published'])
        assert.equal(ctx.subagents.rootOf(child), parent)
        const descendants = await ctx.subagents.listDescendants(parent.id)
        assert.ok(descendants.some(row => row.kind === 'child' && row.id === child.id))
        const read = makeRes()
        await handler(makeReq('GET', '/api/dsh-team-member-model/teams?sessionId=' + parent.id), read)
        assert.equal(read.statusCode, 200, read.body)
        const response = makeRes()
        const body = JSON.stringify({ sessionId: parent.id, target: child.id, revision: JSON.parse(read.body).view.revision, selection: { provider: 'offline', model: 'alternate' } })
        await handler(makeReq('PUT', '/api/dsh-team-member-model/teams', { 'x-dsh-team-member-model': '1' }, body), response)
        assert.equal(response.statusCode, 200, response.body)
      } finally { await activation.dispose() }
      assert.equal(ctx.agents.get('offline-child'), undefined)
      prepared.length = 0
      const coldRequests = []
      ctx.on('agent/request', async (payload, next) => {
        const config = await next()
        if (payload.agent.id === 'offline-child') coldRequests.push({ config, signal: payload.signal })
        return config
      })
      await ctx.subagents.sendMessage(parent, 'offline-child', [{ type: 'text', text: 'resume' }], { signal: new AbortController().signal })
      const resumed = ctx.agents.get('offline-child')
      assert.ok(resumed, 'cold child is reactivated')
      assert.equal(ctx.subagents.rootOf(resumed), parent)
      assert.deepEqual(resumed.model.current(), { provider: 'offline', model: 'alternate' })
      await resumed.whenIdle()
      assert.ok(coldRequests.length > 0, 'cold first step reaches agent/request')
      assert.equal(coldRequests[0].config.provider, 'offline')
      assert.equal(coldRequests[0].config.model, 'alternate')
      const actual = prepared.find(call => call.signal === coldRequests[0].signal)
      assert.ok(actual, 'cold child reaches actual prepareCall with matching signal')
      assert.equal(actual.config.provider, 'offline')
      assert.equal(actual.config.model, 'alternate')
    } finally { await parentHandle.dispose() }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
