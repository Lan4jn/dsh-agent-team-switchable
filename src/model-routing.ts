import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { immutable, SettingsDomain } from './domain.ts'
import { freshTeamRequired, TeamModelSettingsError, unavailable } from './error.ts'
import type { TeamModelSelection } from './types.ts'

/** Inspect only this Session's suffix; forked inherited Team events are not authority. */
export function assertFreshTeam(root: Agent): void {
  for (const event of root.session.ownEvents()) {
    if (!event.type.startsWith('team/')) continue
    const data = event.data as unknown as { version?: number; teamId?: string }
    if (data.teamId === root.id && (data.version === 3 || data.version === 4)) throw freshTeamRequired()
  }
}

export function lastOwnTurn(agent: Agent): number {
  let turn = 0
  for (const event of agent.session.ownEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn
  }
  return turn
}

/** A truthful current route comes from an own request, never options or inherited prefix. */
export function currentModel(agent: Agent): TeamModelSelection | undefined {
  if (!agent.session.ownEvents().some(event => event.type === 'request/header')) return undefined
  const header = agent.session.requestHeader()
  if (header === undefined) return undefined
  const config = header.config
  return immutable({ provider: config.provider, model: config.model,
    ...header.adapterDefaults?.reasoningEffort === true || config.reasoningEffort === undefined
      ? {} : { reasoningEffort: config.reasoningEffort },
  })
}

export async function validateSelection(ctx: Context, selection: TeamModelSelection, signal?: AbortSignal): Promise<TeamModelSelection> {
  if (typeof selection !== 'object' || selection === null
    || typeof selection.provider !== 'string' || selection.provider.length === 0
    || typeof selection.model !== 'string' || selection.model.length === 0
    || (selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || selection.reasoningEffort.length === 0))) {
    throw new TeamModelSettingsError('bad-route', 'A model selection needs a nonempty provider/model and optional nonempty reasoningEffort.')
  }
  const frozen = immutable({ provider: selection.provider, model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  })
  if (!ctx.llm.listProviders().some(provider => provider.id === frozen.provider)
    || !(await ctx.llm.listModels(frozen.provider)).some(model => model.id === frozen.model)) {
    throw new TeamModelSettingsError('model-unavailable', 'The selected provider/model is not advertised by the current model catalog.')
  }
  signal?.throwIfAborted()
  await ctx.llm.resolveCallConfig({ provider: frozen.provider, model: frozen.model,
    ...frozen.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(frozen.reasoningEffort) },
  }, signal)
  signal?.throwIfAborted()
  // Do not persist adapter defaults: omission must clear inherited reasoning effort.
  return frozen
}

interface CreationToken {
  readonly key: symbol
  readonly root: Agent
  readonly teamId: string
  readonly name: string
  readonly selection: TeamModelSelection | null
  readonly signal: AbortSignal
  readonly children: Set<string>
  active: boolean
}
interface InitialCapture {
  readonly root: Agent
  readonly teamId: string
  readonly name: string
  readonly childId: string
  readonly selection: TeamModelSelection | null
  readonly token?: CreationToken
}
interface InstalledRoute {
  readonly teamId: string
  readonly ref: ModelSelectionRef
  readonly dispose: () => void
}

/** Additive route owner. All Session observers are synchronous and append nothing. */
export class ModelRouting {
  private readonly requests = new AsyncLocalStorage<CreationToken>()
  private readonly captures = new Map<string, InitialCapture>()
  private readonly attaching = new WeakMap<Agent, Promise<void>>()
  private readonly installed = new Map<Agent, InstalledRoute>()
  private readonly operations = new Set<Promise<unknown>>()
  private disposed = false

  constructor(readonly ctx: Context, readonly domain: SettingsDomain) {}

  private assertAvailable(): void {
    if (this.disposed) throw unavailable()
    this.domain.assertAvailable()
  }

  /** Freeze explicit > committed default > original inheritance before the first await. */
  creation<T>(caller: Agent, name: string, explicit: TeamModelSelection | undefined, signal: AbortSignal, delegate: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    signal.throwIfAborted()
    assertFreshTeam(caller)
    const membership = this.ctx.agentTeams.membership(caller)
    if (membership.role !== 'lead' || membership.root !== caller) {
      throw new TeamModelSettingsError('lead-required', 'Only the exact public Team Lead may create teammates.')
    }
    const selection = immutable(explicit ?? this.domain.read(membership.id).defaultModel)
    const token: CreationToken = {
      key: Symbol('team-model-creation'), root: caller, teamId: membership.id,
      name: name.trim(), selection, signal, children: new Set(), active: true,
    }
    const operation = (async () => {
      try {
        if (selection !== null) await validateSelection(this.ctx, selection, signal)
        this.assertAvailable()
        signal.throwIfAborted()
        return await this.requests.run(token, delegate)
      } finally {
        token.active = false
        for (const id of token.children) {
          if (this.captures.get(id)?.token === token) this.captures.delete(id)
        }
      }
    })()
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }

  /** exact ALS span → official UUID, not a pending map keyed by reusable name. */
  observe(session: Session, event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'turn/start') {
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) return
      const installed = this.installed.get(agent)
      if (installed === undefined) return
      try {
        const selected = this.domain.read(installed.teamId).choices[agent.id]
        if (selected !== undefined && event.data.turn > selected.effectiveAfterTurn) {
          installed.ref.current = asCoreSelection(selected.selection)
        }
      } catch {
        // Uncertain durability must not disturb an already-installed whole-turn route.
      }
      return
    }
    if (event.type !== 'team/member') return
    const data = event.data as unknown as {
      version?: number; teamId?: string; member?: { id?: string; name?: string; phase?: string }
    }
    if (data.version !== 2 || typeof data.teamId !== 'string' || data.teamId !== session.id || data.member?.phase !== 'provisioning'
      || typeof data.member.id !== 'string' || typeof data.member.name !== 'string') return
    const root = this.ctx.agents.get(session.id)
    if (root === undefined || root.session !== session) return
    const token = this.requests.getStore()
    if (token !== undefined && (!token.active || token.root !== root || token.teamId !== data.teamId
      || token.name !== data.member.name || token.signal.aborted)) return
    if (this.captures.has(data.member.id)) return
    try {
      this.assertAvailable()
      assertFreshTeam(root)
      const selection = token === undefined
        // Direct public API calls have no request span: this is event-time, not request-time.
        ? this.domain.read(data.teamId).defaultModel : token.selection
      this.captures.set(data.member.id, {
        root, teamId: data.teamId, name: data.member.name, childId: data.member.id,
        selection: immutable(selection), ...token === undefined ? {} : { token },
      })
      token?.children.add(data.member.id)
    } catch {
      // Pure observer: admission failure is raised by the awaited agent/created hook.
    }
  }

  /** Called by awaited serial agent/created; queued first input cannot run ahead. */
  attach(agent: Agent, signal?: AbortSignal): Promise<void> {
    const existing = this.attaching.get(agent)
    if (existing !== undefined) return existing
    const operation = this.attachOnce(agent, signal)
    this.attaching.set(agent, operation)
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }

  private async attachOnce(agent: Agent, signal?: AbortSignal): Promise<void> {
    const membership = this.ctx.agentTeams.tryMembership(agent)
    if (membership?.role !== 'teammate') return
    this.assertAvailable()
    assertFreshTeam(membership.root)
    signal?.throwIfAborted()
    const capture = this.captures.get(agent.id)
    if (capture !== undefined && (capture.root !== membership.root || capture.teamId !== membership.id
      || capture.childId !== agent.id || capture.name !== membership.name
      || capture.token?.signal.aborted || capture.token?.active === false)) {
      throw new TeamModelSettingsError('creation-mismatch', 'The exact creation token does not authorize this teammate identity.')
    }
    const state = this.domain.read(membership.id)
    const initial = Object.hasOwn(state.initials, agent.id)
      ? state.initials[agent.id]! : capture?.selection ?? null
    if (initial !== null) await validateSelection(this.ctx, initial, signal)
    await this.domain.transform(membership.id, old => Object.hasOwn(old.initials, agent.id) ? old : ({
      ...old, revision: old.revision + 1, initials: { ...old.initials, [agent.id]: initial },
    }))
    this.assertAvailable()
    signal?.throwIfAborted()
    if (capture?.token?.signal.aborted) capture.token.signal.throwIfAborted()
    // An inherited member must not be pinned to its previous request by this addon.
    // Only our own non-null initial/choice authorizes a persistent route override.
    const ownCurrent = currentModel(agent)
    const chosen = this.domain.read(membership.id).choices[agent.id]
    const selected = initial === null && chosen === undefined ? undefined
      : ownCurrent ?? (chosen !== undefined && lastOwnTurn(agent) > chosen.effectiveAfterTurn
        ? chosen.selection : initial)
    if (selected !== null && selected !== undefined) await validateSelection(this.ctx, selected, signal)
    this.assertAvailable()
    signal?.throwIfAborted()
    capture?.token?.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new TeamModelSettingsError('creation-mismatch', 'The teammate Agent was replaced or disposed during initialization.')
    const ref: ModelSelectionRef = { current: selected === null || selected === undefined ? undefined : asCoreSelection(selected), assembled: undefined }
    const dispose = installModelSelection(agent.ctx, ref)
    this.installed.set(agent, { teamId: membership.id, ref, dispose })
    this.captures.delete(agent.id)
  }

  detach(agent: Agent): void {
    this.installed.get(agent)?.dispose()
    this.installed.delete(agent)
    this.captures.delete(agent.id)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.operations])
    for (const agent of this.installed.keys()) this.detach(agent)
    this.captures.clear()
    this.requests.disable()
  }
}

function asCoreSelection(route: TeamModelSelection): NonNullable<ModelSelectionRef['current']> {
  return Object.freeze({ provider: route.provider, model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  })
}
