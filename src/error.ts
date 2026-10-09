import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

type SettingsErrorCode = 'model-unavailable' | 'unavailable' | 'fresh-team-required' | 'bad-route' | 'lead-required' | 'creation-mismatch' | 'invalid-target' | 'member-not-found' | 'bad-request'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'team-model-settings/model-unavailable': Record<string, never>
    'team-model-settings/unavailable': Record<string, never>
    'team-model-settings/fresh-team-required': Record<string, never>
    'team-model-settings/bad-route': Record<string, never>
    'team-model-settings/lead-required': Record<string, never>
    'team-model-settings/creation-mismatch': Record<string, never>
    'team-model-settings/invalid-target': Record<string, never>
    'team-model-settings/member-not-found': Record<string, never>
    'team-model-settings/bad-request': Record<string, never>
  }
}

/** Stable plugin-owned failures; never rewrite official Team history. */
export class TeamModelSettingsError extends RemoteError {
  constructor(code: SettingsErrorCode, message: string) {
    super(`team-model-settings/${code}`, message, {})
  }
}

export function unavailable(): TeamModelSettingsError {
  return new TeamModelSettingsError('unavailable', 'Model-settings domain unavailable. Keep installed routes unchanged; close the plugin and cold reopen the domain before retrying.')
}

export function freshTeamRequired(): TeamModelSettingsError {
  return new TeamModelSettingsError('fresh-team-required', 'This Team contains unsupported v3/v4 Team records. Create a new fresh Team; historical logs are not migrated, deleted, or rewritten.')
}
