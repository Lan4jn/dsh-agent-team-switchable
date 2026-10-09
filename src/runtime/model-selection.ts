/** Plugin-owned durable teammate routes and turn-boundary model selection. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TeamModelChoice, TeamModelSelection, TeamModelsProjection } from './types.ts'
import { TeamId } from './types.ts'
import { TeamError } from './error.ts'
import { requiredText } from './validation.ts'
import type { TeamRoster } from './roster.ts'
import { resolveActiveMember } from './roster.ts'
import type { TeamJournal } from './journal.ts'
import { teamDefaultModelEventSchema, teamMemberModelEventSchema, teamModelSelectionSchema } from './projection.ts'
import { readPersistedSession } from './persisted.ts'

/** Validate a complete route before any member is durably created. */
export async function resolveTeamModel(ctx: Context, selection: TeamModelSelection): Promise<ModelSelection> {
  const provider = requiredText(selection.provider, 'model provider', 200)
  const model = requiredText(selection.model, 'model', 500)
  try {
    if (!ctx.llm.listProviders().some(value => value.id === provider)
      || !(await ctx.llm.listModels(provider)).some(value => value.id === model)) {
      throw new Error(`model "${provider}/${model}" is unavailable`)
    }
    const resolved = await ctx.llm.resolveCallConfig({
      provider, model,
      ...(selection.reasoningEffort === undefined ? {} : {
        reasoningEffort: ReasoningEffortId(requiredText(selection.reasoningEffort, 'reasoning effort', 100)),
      }),
    })
    return {
      provider: resolved.provider, model: resolved.model,
      ...(selection.reasoningEffort === undefined || resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  } catch (error) {
    throw new TeamError(`model "${provider}/${model}" is unavailable: ${error instanceof Error ? error.message : String(error)}`, 'TEAM_MODEL_UNAVAILABLE', { cause: error })
  }
}

const selectionSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }).strict()
export const teamModelChoiceSchema = z.object({ selection: selectionSchema, effectiveAfterTurn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict() as z.ZodType<TeamModelChoice>
const modelsViewSchema = z.object({ choices: z.record(z.string(), teamModelChoiceSchema), defaultModel: teamModelSelectionSchema.optional(), failure: z.string().optional() }).strict()
const modelsStateSchema = modelsViewSchema.extend({ rootId: z.string() }).strict() as z.ZodType<ModelsState>
export interface ModelsState extends TeamModelsProjection { readonly rootId: string }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { agentTeamModels: ModelsState }
}

/** Independent projection leaves released roster record generations unchanged. */
export const teamModelsProjectionDefinition = {
  key: 'agentTeamModels', stateVersion: 2, stateSchema: modelsStateSchema,
  init: (header: SessionHeader): ModelsState => ({ rootId: header.id, choices: {} }),
  apply(state: ModelsState, event: SessionEvent): ModelsState {
    if (state.failure !== undefined || event.type !== 'team/member') return state
    if (typeof event.data !== 'object' || event.data === null) return { ...state, failure: 'invalid team model payload' }
    if (typeof event.data.teamId !== 'string' || event.data.teamId.length === 0) return { ...state, failure: 'invalid team model identity' }
    if (event.data.teamId !== state.rootId) return state
    if (event.data.version === 2) return state
    if (event.data.version !== 3 && event.data.version !== 4) return { ...state, failure: 'unsupported team model event version' }
    if (event.data.version === 4) {
      const parsed = teamDefaultModelEventSchema.safeParse(event.data)
      if (!parsed.success) return { ...state, failure: 'invalid team default model' }
      const { defaultModel: _prior, ...rest } = state
      return parsed.data.defaultModel === null ? rest : { ...rest, defaultModel: parsed.data.defaultModel }
    }
    const parsed = teamMemberModelEventSchema.safeParse(event.data)
    if (!parsed.success) return { ...state, failure: 'invalid team model choice' }
    const choices = { ...state.choices }
    if (parsed.data.modelChoice === null) delete choices[parsed.data.member.id]
    else choices[parsed.data.member.id] = parsed.data.modelChoice
    return { ...state, choices }
  },
  wire: {
    viewSchema: modelsViewSchema as z.ZodType<TeamModelsProjection>,
    view: (state: ModelsState): TeamModelsProjection => ({ choices: state.choices, ...(state.defaultModel === undefined ? {} : { defaultModel: state.defaultModel }), ...(state.failure === undefined ? {} : { failure: state.failure }) }),
  },
} satisfies ProjectionDefinition<'agentTeamModels', ModelsState>

/** Last turn observed in the member's own persisted execution history. */
function lastTurn(events: readonly SessionEvent[]): number {
  let turn = 0
  for (const event of events) if (event.type === 'turn/start') turn = event.data.turn
  return turn
}

/** Preserve explicit effort choices without pinning an adapter default. */
function ownRoute(agent: Agent): ModelSelection | undefined {
  const hasOwnRequest = agent.session.snapshotEvents().slice(agent.session.inheritedEventCount).some(event => event.type === 'request/header')
  const header = hasOwnRequest ? agent.session.requestHeader() : undefined
  const provider = header?.config.provider ?? agent.options.provider
  const model = header?.config.model ?? agent.options.model
  if (provider === undefined || model === undefined) return undefined
  const effort = header === undefined ? agent.options.reasoningEffort
    : header.adapterDefaults?.reasoningEffort === true ? undefined : header.config.reasoningEffort
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Routes are captured once per turn and choices publish only after persistence. */
export class TeamModelRouting {
  private readonly installed = new Map<Agent, () => void>()
  private readonly committed = new WeakMap<Agent, TeamModelsProjection>()

  constructor(private readonly ctx: Context, private readonly roster: TeamRoster, private readonly journal: TeamJournal) {}

  private configuration(root: Agent): TeamModelsProjection {
    const state = this.ctx.sessionProjections.stateOf(root.session, 'agentTeamModels')
    if (state === undefined || state.failure !== undefined) throw new TeamError(state?.failure ?? 'team model projection unavailable', 'TEAM_MODEL_STATE_INVALID')
    const cached = this.committed.get(root)
    if (cached !== undefined) return cached
    const configuration = teamModelsProjectionDefinition.wire.view(state)
    this.committed.set(root, configuration)
    return configuration
  }

  /** Only the committed configuration may seed a new member reservation. */
  defaultModel(root: Agent): TeamModelSelection | undefined {
    const selection = this.configuration(root).defaultModel
    return selection === undefined ? undefined : { ...selection }
  }

  /** Install synchronously before a created/resumed member can claim queued work. */
  install(agent: Agent): void {
    if (this.installed.has(agent)) return
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate') return
    this.configuration(membership.root)
    const route = ownRoute(agent)
    const selection: ModelSelectionRef = { current: route, assembled: undefined }
    const disposeSelection = installModelSelection(agent.ctx, selection)
    const disposeTurn = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/start') return
      const turn = event.data.turn
      const choice = this.configuration(membership.root).choices[agent.id]
      if (choice !== undefined && turn > choice.effectiveAfterTurn) selection.current = asModelSelection(choice.selection)
    })
    const dispose = (): void => { disposeTurn(); disposeSelection(); this.installed.delete(agent) }
    this.installed.set(agent, dispose)
    agent.ctx.effect(() => dispose, 'agentTeams.memberModelRouting()')
  }

  /** Save a validated member choice without changing the current turn or Lead. */
  async select(caller: Agent, target: string, requested: TeamModelSelection): Promise<TeamModelSelection> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can select teammate models', 'TEAM_LEAD_REQUIRED')
    const selection = await resolveTeamModel(this.ctx, requested)
    return this.journal.transact(membership.root.id, async () => {
      const current = this.roster.membership(caller)
      if (current.role !== 'lead') throw new TeamError('only the Team Lead can select teammate models', 'TEAM_LEAD_REQUIRED')
      const root = current.root
      const member = resolveActiveMember(root, this.journal.state(root), target)
      if (member.id === root.id) throw new TeamError('select a teammate, not the Team Lead', 'TEAM_INVALID_TARGET')
      const before = this.configuration(root)
      const live = this.ctx.agents.get(member.id)
      const events = live?.session.snapshotEvents() ?? (await readPersistedSession(this.ctx.sessionPersistence, member.id, new AbortController().signal)).events
      const choice: TeamModelChoice = { selection, effectiveAfterTurn: lastTurn(events) }
      const snapshot = this.journal.state(root).members.find(value => value.id === member.id)!
      root.session.append('team/member', { version: 3, teamId: TeamId(root.id), member: snapshot, modelChoice: choice })
      try {
        await this.ctx.sessions.flush(root.session)
      } catch (error) {
        root.session.append('team/member', { version: 3, teamId: TeamId(root.id), member: snapshot, modelChoice: before.choices[member.id] ?? null })
        try { await this.ctx.sessions.flush(root.session) }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'model choice persistence and rollback both failed') }
        throw error
      }
      this.committed.set(root, { ...before, choices: { ...before.choices, [member.id]: choice } })
      return { ...selection }
    })
  }

  /** Save a team-only route for future creation; null restores ordinary inheritance. */
  async selectDefault(caller: Agent, requested: TeamModelSelection | null): Promise<TeamModelSelection | null> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can select the team default model', 'TEAM_LEAD_REQUIRED')
    return this.journal.transact(membership.root.id, async () => {
      const current = this.roster.membership(caller)
      if (current.role !== 'lead') throw new TeamError('only the Team Lead can select the team default model', 'TEAM_LEAD_REQUIRED')
      const root = current.root
      const before = this.configuration(root)
      const selection = requested === null ? null : await resolveTeamModel(this.ctx, requested)
      root.session.append('team/member', { version: 4, teamId: TeamId(root.id), defaultModel: selection })
      try {
        await this.ctx.sessions.flush(root.session)
      } catch (error) {
        root.session.append('team/member', { version: 4, teamId: TeamId(root.id), defaultModel: before.defaultModel ?? null })
        try { await this.ctx.sessions.flush(root.session) }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'team default model persistence and rollback both failed') }
        throw error
      }
      const { defaultModel: _prior, ...rest } = before
      this.committed.set(root, selection === null ? rest : { ...rest, defaultModel: selection })
      return selection === null ? null : { ...selection }
    })
  }

  /** Release all scoped listeners on plugin unload. */
  dispose(): void { for (const dispose of [...this.installed.values()]) dispose() }
}

function asModelSelection(selection: TeamModelSelection): ModelSelection {
  return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) }
}
