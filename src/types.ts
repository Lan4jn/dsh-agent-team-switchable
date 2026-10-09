/** Browser-safe wire vocabulary owned by the additive model-settings plugin. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The public Storage Domain API forbids hyphens in physical unit names. */
export const TEAM_SETTINGS_DOMAIN = 'agent_team_model_settings'

export interface TeamModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface TeamSettingsRequest {
  readonly leadSessionId: SessionId
}

export interface TeamSelectMemberModelRequest extends TeamSettingsRequest {
  /** Immutable official teammate name; the Lead is never a valid target. */
  readonly target: string
  readonly selection: TeamModelSelection
}

export interface TeamSelectDefaultModelRequest extends TeamSettingsRequest {
  /** null restores ordinary inherited behavior for future members. */
  readonly selection: TeamModelSelection | null
}

export interface TeamMemberModelView {
  readonly id: SessionId
  readonly name: string
  readonly description?: string
  readonly phase: 'provisioning' | 'active' | 'failed'
  readonly status: 'running' | 'inactive'
  readonly currentModel?: TeamModelSelection
  readonly nextModel?: TeamModelSelection
}

export interface TeamModelSettingsView {
  readonly teamId: SessionId
  readonly revision: number
  readonly defaultModel: TeamModelSelection | null
  /** Teammates only; the official Lead route is untouched. */
  readonly members: readonly TeamMemberModelView[]
}
