import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KvFacet, KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { BackendRegistry } from '@deepseek-ai/dsh-storage'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../../src/index.ts'
import type { TeamModelSelection } from '../../src/types.ts'

/**
 * Real Domain data form over an isolated temp directory.
 * The shipped file backend is not installed in this workspace, so only the medium
 * is local: one JSON document per unit, atomic rename, `single` layout. Everything
 * above it is the real SDK (defineDomain spec, zod validation, DomainFacility,
 * per-unit write chain, close, fresh open).
 */
export function storageFacility(dir: string): DomainFacility {
  const facet: KvFacet = {
    async open(descriptor: KvUnitDescriptor): Promise<KvUnit> {
      const file = join(dir, `${descriptor.name}.json`)
      let state: { version: number; tables: Record<string, Record<string, unknown>> }
      try { state = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        state = { version: descriptor.version, tables: {} }
      }
      let closed = false
      const live = () => { if (closed) throw new Error('closed') }
      const flush = () => {
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(state))
        renameSync(tmp, file)
      }
      return {
        async loadAll() { live(); return { tables: state.tables, global: null } },
        async putRecord(table, key, value) {
          live()
          state = { ...state, tables: { ...state.tables, [table]: { ...(state.tables[table] ?? {}), [key]: value } } }
          flush()
        },
        async deleteRecord(table, key) {
          live()
          const { [key]: _dropped, ...rest } = state.tables[table] ?? {}
          state = { ...state, tables: { ...state.tables, [table]: rest } }
          flush()
        },
        async setGlobal() { throw new Error('unit declares no global') },
        async close() { closed = true },
      }
    },
  }
  const registry = new BackendRegistry()
  registry.register('json', { kv: facet, close: async () => {} })
  // DomainFacility touches only the backend table, `emit` and `logger`.
  const ctx = { storage: { backend: registry }, emit: () => {}, logger: { warn() {}, error() {} } }
  return new DomainFacility(ctx as never, { backend: 'json', routes: {} })
}

export interface Route { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

interface Live { readonly live: Agent; readonly events: SessionEvent[]; carrier: object; header?: { config: Route } }

/**
 * Real Cordis Context plus only the public services `apply` injects. Each Agent
 * carries a child Context so `installModelSelection` listeners stay Agent-scoped,
 * and `session/event` / serial `agent/created` are dispatched for real.
 */
export function boot(dir: string, config: Config = {}) {
  const root = new Context()
  const registry = new Map<string, Agent>()
  const roles = new Map<Agent, { root: Agent; id: string; role: 'lead' | 'teammate'; name: string }>()
  const lives = new Map<string, Live>()
  const facility = storageFacility(dir)
  root.provide('agents', { list: () => [...registry.values()], get: (id: string) => registry.get(id) } as never)
  root.provide('agentTeams', {
    tryMembership: (agent: Agent) => registry.get(agent.id) === agent ? roles.get(agent) : undefined,
    membership: (agent: Agent) => {
      const role = registry.get(agent.id) === agent ? roles.get(agent) : undefined
      if (role === undefined) throw new Error('not a member')
      return role
    },
    listMembers: (lead: Agent) => [...roles.entries()].filter(([, role]) => role.root === lead).map(([agent, role]) => ({
      id: agent.id, name: role.name, role: role.role, status: 'inactive', description: role.name,
    })),
  } as never)
  root.provide('llm', {
    listProviders: () => ['p', 'q', 'inherited'].map(id => ({ id })),
    listModels: async () => ['a', 'b', 'old', 'base', 'next'].map(id => ({ id })),
    resolveCallConfig: async (call: unknown) => call,
  } as never)
  root.provide('tools', { register: () => () => {} } as never)
  root.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 0 } as never)
  root.provide('sessionController', {
    resolveAgent: async (id: string) => {
      const agent = registry.get(id)
      return agent === undefined ? { error: new Error(`no agent ${id}`) } : { agent }
    },
  } as never)
  root.provide('storageDomain', facility as never)

  function agent(id: string, name = 'worker', lead?: Agent): Live {
    const events: SessionEvent[] = []
    const subject = { id }
    // Mirrors the real carrier: a stamped scope for per-Agent listeners plus its routing receiver.
    const scope = createScope(root, subject)
    const record: Live = { live: undefined!, events, carrier: scopeTarget(subject, subject) }
    const session = {
      id, header: { id, ...lead === undefined ? {} : { parentSession: lead.id } },
      ownEvents: () => events, snapshotEvents: () => events, requestHeader: () => record.header,
    }
    ;(record as { live: Agent }).live = {
      id, status: 'idle', ctx: scope.ctx,
      options: { provider: 'inherited', model: 'base', reasoningEffort: 'high' }, session,
    } as unknown as Agent
    registry.set(id, record.live)
    roles.set(record.live, lead === undefined
      ? { root: record.live, id, role: 'lead', name: 'lead' }
      : { root: lead, id: lead.id, role: 'teammate', name })
    lives.set(id, record)
    return record
  }

  function push(record: Live, type: string, data: unknown): SessionEvent {
    const event = { type, data, seq: record.events.length, time: 0 } as SessionEvent
    record.events.push(event)
    root.emit('session/event', (record.live as unknown as { session: unknown }).session, event)
    return event
  }

  return {
    root, registry, roles, facility, agent,
    start: () => root.plugin({ name: 'durable-recovery-fixture', apply: (ctx) => apply(ctx, config) }),
    /** The teammate's own durable request header, as the session log restores it. */
    request(id: string, selection: Route) {
      const record = lives.get(id)!
      record.header = { config: selection }
      push(record, 'request/header', { header: record.header })
    },
    turn(id: string, turn: number) { push(lives.get(id)!, 'turn/start', { turn }) },
    announce(live: Agent) { return root.serial(root, 'agent/created', { agent: live }) as Promise<void> },
    async assemble(live: Agent) {
      const record = lives.get(live.id)!
      const dispatch = root as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }
      const prompt = await dispatch.waterfall(record.carrier, 'system-prompt/assemble', {}, {},
        async () => ({ variables: { provider: 'inherited', model: 'base' } }))
      // A restored own request header is this member's real current route; options are plain inheritance.
      const restored = record.header?.config ?? (live as unknown as { options: TeamModelSelection }).options
      const config = await dispatch.waterfall(record.carrier, 'agent/request', {}, async () => restored)
      return { prompt, config: config as TeamModelSelection }
    },
  }
}
