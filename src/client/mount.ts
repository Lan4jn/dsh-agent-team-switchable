/** Register only this plugin's locale and additive public header slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from 'dsh-agent-team-switchable/remote'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamModelSettingsAction, type TeamModelSettingsInjected } from './TeamModelSettingsAction.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'team-model-settings': TeamKey
  }
}
export const inject = ['slots', 'locale', 'remote', 'modelDirectories']

export function registerTeamModelSettingsUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'team-model-settings: dictionaries')
  const actions: TeamModelSettingsInjected = {
    api: ctx.remote['team-model-settings'],
    modelDirectoryFor: leadSessionId => ctx.modelDirectories.directoryFor(leadSessionId).store,
    // Load the Lead's shared catalog only. Never call directory.select for teammates.
    loadCatalogFor: leadSessionId => ctx.modelDirectories.directoryFor(leadSessionId).load(),
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'team-model-settings',
    order: -19,
    locale: NS,
    inject: () => actions,
  }, TeamModelSettingsAction))
}
