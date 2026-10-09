import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { immutable, type SettingsDomain } from './domain.ts'
import { TeamModelSettingsError } from './error.ts'
import { assertFreshTeam, currentModel, lastOwnTurn, validateSelection } from './model-routing.ts'
import type { TeamModelSettingsView, TeamSettingsRequest, TeamSelectMemberModelRequest, TeamSelectDefaultModelRequest } from './types.ts'

export interface ServiceState { readonly domain: SettingsDomain }

declare module '@deepseek-ai/cordis' {
  interface Context { teamModelSettings: TeamModelSettingsService }
}

/** Independent RPC view; session projections and official Team methods are untouched. */
export class TeamModelSettingsService extends TypertRemoteService {
  static inject = ['agents', 'agentTeams', 'llm', 'sessionController']

  constructor(ctx: Context, private readonly state: ServiceState) {
    super(ctx, 'teamModelSettings', { namespace: 'team-model-settings' })
  }

  /** Read plugin-owned settings for the exact authorized Team Lead. */
  @Remote
  async getSettings(request: TeamSettingsRequest): Promise<TeamModelSettingsView> {
    const lead = await this.authorizedLead(request)
    return this.view(lead)
  }

  /** Commit a complete teammate route for a later own turn, never the current step. */
  @Remote
  async selectMemberModel(request: TeamSelectMemberModelRequest): Promise<TeamModelSettingsView> {
    const lead = await this.authorizedLead(request)
    if (typeof request.target !== 'string' || request.target.length === 0 || request.target === 'lead') {
      throw new TeamModelSettingsError('invalid-target', 'A teammate immutable name is required; the Lead is not selectable.')
    }
    const member = this.ctx.agentTeams.listMembers(lead).find(row => row.role === 'teammate' && row.name === request.target)
    if (member === undefined || member.status === 'failed' || member.status === 'provisioning') {
      throw new TeamModelSettingsError('member-not-found', 'The named teammate must be active, not absent, provisioning or failed.')
    }
    const selection = await validateSelection(this.ctx, request.selection)
    await this.state.domain.transform(lead.id, old => {
      if (this.ctx.agents.get(lead.id) !== lead) throw new TeamModelSettingsError('lead-required', 'The authorized Lead is no longer live.')
      const row = this.ctx.agentTeams.listMembers(lead).find(candidate => candidate.id === member.id && candidate.name === request.target && candidate.role === 'teammate')
      if (row === undefined || row.status === 'failed' || row.status === 'provisioning') throw new TeamModelSettingsError('member-not-found', 'The teammate is no longer active.')
      const live = this.ctx.agents.get(member.id)
      if (live !== undefined) {
        const membership = this.ctx.agentTeams.membership(live)
        if (membership.role !== 'teammate' || membership.root !== lead || membership.name !== request.target) throw new TeamModelSettingsError('invalid-target', 'The public membership no longer matches this teammate.')
      }
      return { ...old, revision: old.revision + 1, choices: { ...old.choices, [member.id]: {
        selection, effectiveAfterTurn: live === undefined ? 0 : lastOwnTurn(live),
      } } }
    })
    return this.view(lead)
  }

  /** Commit a future-creation default, or a permanent null inheritance marker. */
  @Remote
  async selectTeamDefaultModel(request: TeamSelectDefaultModelRequest): Promise<TeamModelSettingsView> {
    const lead = await this.authorizedLead(request)
    const selection = request.selection === null ? null : await validateSelection(this.ctx, request.selection)
    await this.state.domain.transform(lead.id, old => ({ ...old, revision: old.revision + 1, defaultModel: selection }))
    return this.view(lead)
  }

  private async authorizedLead(request: TeamSettingsRequest): Promise<Agent> {
    this.state.domain.assertAvailable()
    if (typeof request.leadSessionId !== 'string' || request.leadSessionId.length === 0) {
      throw new TeamModelSettingsError('bad-request', 'A real Lead Session id is required.')
    }
    // Always traverse SessionController, even when the registry already has a live Agent.
    // Its browser-access check is not equivalent to a cached Agent lookup.
    const resolved = await this.ctx.sessionController.resolveAgent(request.leadSessionId)
    if ('error' in resolved) throw resolved.error
    const lead = resolved.agent
    assertFreshTeam(lead)
    const membership = this.ctx.agentTeams.membership(lead)
    if (membership.role !== 'lead' || membership.root !== lead || String(membership.id) !== request.leadSessionId) {
      throw new TeamModelSettingsError('lead-required', 'Only the exact Team Lead may read or edit model settings.')
    }
    this.state.domain.assertAvailable()
    return lead
  }

  private view(lead: Agent): TeamModelSettingsView {
    assertFreshTeam(lead)
    const record = this.state.domain.read(lead.id)
    const members = this.ctx.agentTeams.listMembers(lead).filter(member => member.role === 'teammate').map(member => {
      const live = this.ctx.agents.get(member.id)
      const current = live === undefined ? undefined : currentModel(live)
      const next = record.choices[member.id]?.selection ?? record.initials[member.id] ?? undefined
      const pending = next !== undefined && (current === undefined || current.provider !== next.provider
        || current.model !== next.model || current.reasoningEffort !== next.reasoningEffort)
      return {
        id: member.id, name: member.name,
        ...member.description === undefined ? {} : { description: member.description },
        phase: member.status === 'failed' ? 'failed' as const : member.status === 'provisioning' ? 'provisioning' as const : 'active' as const,
        status: member.status === 'running' ? 'running' as const : 'inactive' as const,
        ...current === undefined ? {} : { currentModel: current },
        ...pending ? { nextModel: next } : {},
      }
    })
    return immutable({ teamId: lead.id, revision: record.revision, defaultModel: record.defaultModel, members })
  }
}
