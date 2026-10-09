import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamModelSelection } from '../../src/types.ts'

/** Plugin unit fixture: only the public callbacks it consumes, not an Agent/Core runtime. */
export function backendFixture() {
  const registry = new Map<string, Agent>()
  const roles = new Map<Agent, { root: Agent; id: string; role: 'lead' | 'teammate'; name: string }>()
  const subscriptions = new Map<Agent, Map<string, Array<(...args: any[]) => any>>>()
  const validations: unknown[] = []
  const ctx = {
    agents: { get: (id: string) => registry.get(id), list: () => [...registry.values()] },
    agentTeams: {
      tryMembership: (agent: Agent) => registry.get(agent.id) === agent ? roles.get(agent) : undefined,
      membership: (agent: Agent) => { const role = registry.get(agent.id) === agent ? roles.get(agent) : undefined; if (!role) throw new Error('not a member'); return role },
      listMembers: (root: Agent) => [...roles.entries()].filter(([, role]) => role.root === root).map(([agent, role]) => ({
        id: agent.id, name: role.name, role: role.role, status: agent.status === 'idle' ? 'inactive' : 'running', description: role.name,
      })),
    },
    llm: {
      listProviders: () => ['p', 'q', 'inherited', 'llm-provider', 'default-llm'].map(id => ({ id })),
      listModels: async () => ['a', 'b', 'base', 'old', 'next', 'x', 'explicit', 'default'].map(id => ({ id })),
      resolveCallConfig: async (config: unknown) => { validations.push(config); return config },
    },
  } as unknown as Context

  function agent(id: string, root?: Agent, name = 'worker', inherited: SessionEvent[] = []) {
    const own: SessionEvent[] = []
    let header: any
    const listeners = new Map<string, Array<(...args: any[]) => any>>()
    const scoped = {
      on: (event: string, listener: (...args: any[]) => any) => {
        const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list)
        return () => { const position = list.indexOf(listener); if (position !== -1) list.splice(position, 1) }
      },
    }
    const live = {
      id, status: 'idle', ctx: scoped, options: { provider: 'inherited', model: 'base', reasoningEffort: 'high' },
      session: { id, header: { id, ...root === undefined ? {} : { parentSession: root.id } },
        ownEvents: () => own, snapshotEvents: () => [...inherited, ...own], requestHeader: () => header,
      },
    } as unknown as Agent
    registry.set(id, live)
    if (root === undefined) roles.set(live, { root: live, id, role: 'lead', name: 'lead' })
    else roles.set(live, { root, id: root.id, role: 'teammate', name })
    subscriptions.set(live, listeners)
    return {
      live, own, listeners,
      event: (type: string, data: unknown) => { const event = { type, data, seq: own.length, time: 0 } as SessionEvent; own.push(event); return event },
      request: (selection: TeamModelSelection, adapterDefault = false) => {
        header = { config: selection, ...adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {} }
        own.push({ type: 'request/header', data: { header }, seq: own.length, time: 0 } as SessionEvent)
      },
      inheritRequest: (selection: TeamModelSelection) => { header = { config: selection } },
    }
  }

  async function assemble(live: Agent) {
    const listeners = subscriptions.get(live)!
    const assembly = listeners.get('system-prompt/assemble')?.[0]
    const request = listeners.get('agent/request')?.[0]
    const prompt = assembly === undefined ? { variables: { provider: 'inherited', model: 'base' } }
      : await assembly({}, {}, async () => ({ variables: { provider: 'inherited', model: 'base' } }))
    const config = request === undefined ? live.options : await request({}, async () => live.options)
    return { prompt, config }
  }
  return { ctx, agent, registry, roles, validations, assemble }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
