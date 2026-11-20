/**
 * test/integration-support.mjs
 * 团队集成测试宿主桩与辅助工具，隔离 DSH_HOME，纯黑盒模拟真实宿主行为。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/**
 * 复刻 cordis createTraceable 机制
 */
export function makeTraceable(service) {
  const shadowLike = Object.create(service)
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      const value = Reflect.get(target, prop, target)
      if (typeof value === 'function') {
        return new Proxy(value, {
          apply: (_t, _thisArg, args) => Reflect.apply(value, shadowLike, args),
        })
      }
      return value
    },
    set(target, prop, value) {
      const shadow = Object.create(target)
      return Reflect.set(target, prop, value, shadow)
    },
  })
}

export function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

export function makeReq(method, url, headers = {}, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:19387', ...headers }
  return stream
}

export function createLeadAgent(sessionId = 'lead-session-1', cwd = '/home/me/proj') {
  const events = []
  return {
    id: sessionId,
    session: {
      id: sessionId,
      header: { id: sessionId, cwd },
      ownEvents: () => events,
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: 'base-p', model: 'base-m' } }),
    },
    options: { provider: 'base-p', model: 'base-m' },
  }
}

export function createTeammateAgent(memberId, leadSessionId = 'lead-session-1', name = 'worker-1', options = {}) {
  const events = []
  let header = undefined
  let turn = 1
  const isExplicit = Boolean(options.provider && options.model)
  const agentOpts = isExplicit ? { ...options, explicit: true } : options
  let currentSelection = isExplicit ? { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort } : undefined
  return {
    id: memberId,
    name,
    session: {
      id: memberId,
      header: {
        id: memberId,
        parentSession: leadSessionId,
        origin: 'subagent',
        delegationDepth: 1,
        cwd: '/home/me/proj',
      },
      ownEvents: () => events,
      snapshotEvents: () => events,
      requestHeader: () => header,
    },
    options: agentOpts,
    model: {
      current() {
        return currentSelection
      },
      select(sel) {
        currentSelection = sel ? { ...sel } : undefined
      },
    },
    _getTurn() {
      return turn
    },
    _setTurn(t) {
      turn = t
      events.push({ type: 'turn/start', data: { turn: t } })
      if (typeof this._emitClaimed === 'function') {
        this._emitClaimed(t)
      }
    },
    _setHeader(config) {
      header = { config }
      events.push({ type: 'request/header', data: { header } })
    },
  }
}

export async function createIntegrationHost(options = {}) {
  const previousHome = process.env.DSH_HOME
  const dshHome = options.dshHome || await mkdtemp(join(tmpdir(), 'tmm-integration-'))
  process.env.DSH_HOME = dshHome

  const captured = {
    specs: [],
    starts: [],
    tools: [],
    routes: [],
    effects: [],
    listeners: {},
    disposers: [],
    skills: [],
  }

  // 模拟团队表：teamId -> { leadAgent, members: Map<memberId, memberData> }
  const teams = new Map()
  const agentRegistry = new Map()

  function registerLead(leadAgent) {
    agentRegistry.set(leadAgent.id, leadAgent)
    if (!teams.has(leadAgent.id)) {
      teams.set(leadAgent.id, { leadAgent, members: new Map() })
    }
    return leadAgent
  }

  function registerTeammate(leadAgent, teammateAgent, name = teammateAgent.name || 'worker', description = 'worker description') {
    registerLead(leadAgent)
    agentRegistry.set(teammateAgent.id, teammateAgent)
    const team = teams.get(leadAgent.id)
    team.members.set(teammateAgent.id, {
      agent: teammateAgent,
      id: teammateAgent.id,
      name,
      description,
      role: 'teammate',
      phase: 'active',
      status: 'running',
    })
    teammateAgent._emitClaimed = (t) => {
      const handlers = captured.listeners['agent/inbox/claimed'] || []
      for (const h of handlers) {
        h({ message: { id: `msg-${t}` }, turn: t, agent: teammateAgent })
      }
    }
    return teammateAgent
  }

  const llm = {
    listProviders: () => [
      { id: 'zai-coding-cn', name: 'ZAI' },
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'p-custom', name: 'Custom P' },
      { id: 'p-default', name: 'Default P' },
      { id: 'p-override', name: 'Override P' },
      { id: 'p-explicit', name: 'Explicit P' },
      { id: 'p-snap', name: 'Snap P' },
      { id: 'p-def1', name: 'Def1 P' },
      { id: 'p-def2', name: 'Def2 P' },
      { id: 'p-def3', name: 'Def3 P' },
      { id: 'p-def-LATE', name: 'Late Def P' },
      { id: 'p-auto', name: 'Auto P' },
      { id: 'p-new', name: 'New P' },
      { id: 'p-next', name: 'Next P' },
      { id: 'p-real', name: 'Real P' },
      { id: 'p-orig', name: 'Orig P' },
      { id: 'p-manual', name: 'Manual P' },
    ],
    listModels: async (providerId) => {
      const map = {
        'zai-coding-cn': [{ id: 'glm-5.3' }, { id: 'glm-4.6v' }],
        'opencode-go': [{ id: 'deepseek-v4.1-flash' }],
        'p-custom': [{ id: 'm-custom' }, { id: 'm-fallback' }, { id: 'm-fallback2' }],
        'p-default': [{ id: 'm-default' }],
        'p-override': [{ id: 'm-override' }],
        'p-explicit': [{ id: 'm-explicit' }],
        'p-snap': [{ id: 'm-snap' }],
        'p-def1': [{ id: 'm-def1' }],
        'p-def2': [{ id: 'm-def2' }],
        'p-def3': [{ id: 'm-def3' }],
        'p-def-LATE': [{ id: 'm-def-LATE' }],
        'p-auto': [{ id: 'm-auto' }, { id: 'm-auto-fb' }],
        'p-new': [{ id: 'm-new' }],
        'p-next': [{ id: 'm-next' }],
        'p-real': [{ id: 'm-real' }],
        'p-orig': [{ id: 'm-orig' }],
        'p-manual': [{ id: 'm-manual' }],
      }
      return map[providerId] || [{ id: 'default-m' }]
    },
    resolveModelInfo: async (provider, model) => ({
      id: model,
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
    }),
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'intent' }
    },
  }

  const agentTeams = {
    isEnabled(agent) { return teams.has(agent?.id) },
    tryMembership(agent) {
      if (!agent) return undefined
      for (const [teamId, team] of teams.entries()) {
        if (agent.id === teamId || agent.id === team.leadAgent.id) {
          return { root: team.leadAgent, id: teamId, role: 'lead', name: 'lead' }
        }
        if (team.members.has(agent.id)) {
          const m = team.members.get(agent.id)
          return { root: team.leadAgent, id: teamId, role: 'teammate', name: m.name }
        }
      }
      return undefined
    },
    membership(agent) {
      const m = this.tryMembership(agent)
      if (!m) throw new Error(`Not a team member: ${agent?.id}`)
      return m
    },
    listMembers(leadAgent) {
      const team = teams.get(leadAgent?.id)
      if (!team) return []
      return Array.from(team.members.values()).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        role: m.role,
        phase: m.phase,
        status: m.status,
      }))
    },
    async spawnTeammate(caller, request) {
      return { member: { id: 'child-x', name: request.name, phase: 'active' } }
    },
  }

  const sessionController = {
    async resolveAgent(sessionId) {
      if (typeof options.resolveAgent === 'function') {
        return options.resolveAgent(sessionId)
      }
      const agent = agentRegistry.get(sessionId)
      if (!agent) return { error: new Error(`Session ${sessionId} not found`) }
      return { agent }
    },
  }

  class FakeSubagents {
    rootOf(agent) {
      const membership = agentTeams.tryMembership(agent)
      if (!membership || agentRegistry.get(agent.id) !== agent) throw new Error('UNAUTHORIZED')
      return membership.root
    }
    async listDescendants(rootId) {
      const team = teams.get(rootId)
      if (!team) throw new Error('unknown root')
      return Array.from(team.members.values()).map(m => ({
        kind: 'child', id: m.id, name: m.name, path: m.name, mode: 'continuable',
        activity: m.status === 'running' ? 'running' : 'inactive', parentId: rootId, depth: 1, hasChildren: false,
      }))
    }
    async startContinuable(spec) {
      captured.specs.push(spec)
      return { childId: spec?.childId, messageId: 'msg-x' }
    }
    async start(name, request) {
      captured.starts.push({ name, request })
      return { localAgent: { session: { id: `child-${captured.starts.length}` } } }
    }
    getProvider(name) {
      if (name === 'spawn' || name === 'fork') return { name, capabilities: { agentOptions: true } }
      return undefined
    }
  }

  const rawSubagents = new FakeSubagents()

  const agents = {
    get: (id) => agentRegistry.get(id),
    list: () => Array.from(agentRegistry.values()),
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents,
    inject(names, callback) {
      callback(ctx)
      return () => {}
    },
    skills: {
      register(skill) {
        captured.skills.push(skill)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        captured.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        captured.routes.push(route)
        return () => {}
      },
    },
    subagents: makeTraceable(rawSubagents),
    on(event, handler) {
      captured.listeners[event] = captured.listeners[event] ?? []
      captured.listeners[event].push(handler)
      return () => {
        const list = captured.listeners[event] ?? []
        const at = list.indexOf(handler)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(fn) {
      captured.effects.push(fn)
    },
    get(name) {
      if (name === 'connection') return Object.hasOwn(options, 'connection') ? options.connection : { requestRejection: () => undefined }
      if (name === 'llm') return llm
      if (name === 'agentTeams') return agentTeams
      if (name === 'sessionController') return sessionController
      if (name === 'agents') return agents
      if (name === 'subagents') return rawSubagents
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 1000 }) }
      return undefined
    },
  }

  const store = Object.create(null)
  store[Symbol('isolate:subagents')] = { name: 'subagents', fiber: {}, value: rawSubagents }
  ctx.reflect = {
    store,
    _getImpl(name) {
      return name === 'subagents' ? { name, value: rawSubagents } : undefined
    },
  }

  async function apiRequest(method, pathAndQuery, headers = {}, body = undefined) {
    const route = captured.routes.find(r => r.path === '/api/dsh-team-member-model')
    if (!route) throw new Error('API route /api/dsh-team-member-model not registered')
    const req = makeReq(method, pathAndQuery, headers, body ? JSON.stringify(body) : undefined)
    const res = makeRes()
    await route.handler(req, res)
    let json
    try {
      json = JSON.parse(res.body)
    } catch {
      json = res.body
    }
    return { status: res.statusCode || 200, headers: res.headers, body: json }
  }

  async function emitWaterfall(event, payload, terminal) {
    const handlers = captured.listeners[event] ?? []
    const run = (index) =>
      index >= handlers.length
        ? Promise.resolve().then(terminal)
        : Promise.resolve(handlers[index](payload, () => run(index + 1)))
    return await run(0)
  }

  async function emitEvent(event, ...args) {
    const handlers = captured.listeners[event] ?? []
    const results = []
    for (const h of handlers) {
      results.push(await h(...args))
    }
    return results
  }

  async function emitProvisioning(teamId, memberId, memberName) {
    return emitEvent('session/event', { id: teamId }, {
      type: 'team/member',
      data: {
        version: 2,
        teamId,
        member: { id: memberId, name: memberName, phase: 'provisioning' },
      },
    })
  }

  async function emitAgentCreated(agent, signal) {
    return emitEvent('agent/created', { agent, signal })
  }

  async function requestRoute(agent, baseConfig = { provider: 'base-p', model: 'base-m' }) {
    const turn = agent._getTurn?.() ?? 1
    for (const handler of captured.listeners['agent/inbox/claimed'] ?? []) handler({ agent, turn, message: { id: `prepare-${turn}` } })
    const seed = agent.model?.current() ?? baseConfig
    return emitWaterfall('agent/request', { agent, turn }, () => seed)
  }

  async function requestError(agent, failure = { status: 500, message: 'Server error' }) {
    let nextCalled = false
    const result = await emitWaterfall('agent/request-error', { agent, failure }, () => {
      nextCalled = true
      return { kind: 'error-next' }
    })
    return { result, nextCalled }
  }

  async function cleanup() {
    process.env.DSH_HOME = previousHome
    if (!options.preserveDir) {
      await rm(dshHome, { recursive: true, force: true })
    }
  }

  return {
    ctx,
    captured,
    dshHome,
    teams,
    agentRegistry,
    registerLead,
    registerTeammate,
    apiRequest,
    emitWaterfall,
    emitEvent,
    emitProvisioning,
    emitAgentCreated,
    requestRoute,
    requestError,
    cleanup,
  }
}
