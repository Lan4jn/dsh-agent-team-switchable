/** Browser-safe request vocabulary for the plugin-local team model gateway. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
/** Exact route accepted by the team model service. */
export interface TeamModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Complete team-local selection addressed by member name, not child Session id. */
export interface TeamSelectMemberModelRequest {
  readonly leadSessionId: SessionId
  readonly target: string
  readonly selection: TeamModelSelection
}

/** Team-wide default model selection for future spawned teammates. */
export interface TeamSelectDefaultModelRequest {
  readonly leadSessionId: SessionId
  readonly selection: TeamModelSelection | null
}
