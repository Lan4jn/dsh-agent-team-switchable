/** Host-owned, team-authorized model selection; never mutates Session/global defaults. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from './runtime/index.ts'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamModelSelection, TeamSelectDefaultModelRequest, TeamSelectMemberModelRequest } from './types.ts'

export type { TeamModelSelection, TeamSelectDefaultModelRequest, TeamSelectMemberModelRequest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** GUI plugin-owned, Lead-authorized team model gateway. */
    teamModelController: TeamModelController
  }
}

/** Plugin-local Remote service backed by the exact live Team Lead. */
export class TeamModelController extends TypertRemoteService {
  static inject = ['agents', 'agentTeams', 'sessionController']

  constructor(ctx: Context) {
    super(ctx, 'teamModelController', { namespace: 'agent-team-models' })
  }

  /**
   * Select one teammate's durable model for its next turn.
   * @param request - real Lead Session identity, member name, and full route.
   * @returns the validated team-local selection.
   */
  @Remote
  async selectMemberModel(request: TeamSelectMemberModelRequest): Promise<TeamModelSelection> {
    if (request.leadSessionId.length === 0 || request.target.length === 0) {
      throw new RemoteError('gateway/bad-request', 'Lead Session and member name are required', {})
    }
    let caller = this.ctx.agents.get(request.leadSessionId)
    if (caller === undefined) {
      const resolved = await this.ctx.sessionController.resolveAgent(request.leadSessionId)
      if ('error' in resolved) throw resolved.error
      caller = resolved.agent
    }
    if (this.ctx.agentTeams.membership(caller).role !== 'lead') {
      throw new RemoteError('gateway/bad-request', 'Only the real Team Lead may select member models', {})
    }
    return await this.ctx.agentTeams.selectMemberModel(caller, request.target, request.selection)
  }

  /**
   * Select or clear the team-wide default model for future spawned members.
   * @param request - real Lead Session identity and full route or null to clear.
   * @returns the validated team default selection or null when cleared.
   */
  @Remote
  async selectTeamDefaultModel(request: TeamSelectDefaultModelRequest): Promise<TeamModelSelection | null> {
    if (request.leadSessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'Lead Session is required', {})
    }
    let caller = this.ctx.agents.get(request.leadSessionId)
    if (caller === undefined) {
      const resolved = await this.ctx.sessionController.resolveAgent(request.leadSessionId)
      if ('error' in resolved) throw resolved.error
      caller = resolved.agent
    }
    if (this.ctx.agentTeams.membership(caller).role !== 'lead') {
      throw new RemoteError('gateway/bad-request', 'Only the real Team Lead may select default model', {})
    }
    return await this.ctx.agentTeams.selectTeamDefaultModel(caller, request.selection)
  }
}

/** Register only this plugin's gateway; the Typert Loader owns its descriptor. */
export function apply(ctx: Context): void {
  ctx.plugin(TeamModelController)
}
