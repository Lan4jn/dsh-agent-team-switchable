/** Register only this plugin's locale and additive public header slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from 'dsh-agent-team-switchable/remote'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamModelSettingsAction, type TeamModelSettingsInjected } from './TeamModelSettingsAction.tsx'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    teamModelSettings: unknown
  }
}
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'team-model-settings': TeamKey
  }
}
// remote.session is required by ctx.modelDirectories.directoryFor on cold cache miss
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'modelDirectories', 'sessions']

export function registerTeamModelSettingsUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'team-model-settings: dictionaries')
  const actions: TeamModelSettingsInjected = {
    api: ctx.remote['team-model-settings'],
    acquireCatalogFor: async (leadSessionId, signal) => {
      // This package typechecks Host and Client halves together; the shared
      // Cordis Context name also has the Host's sessions face in that program.
      const sessions = ctx.sessions as unknown as ISessions
      const reference = sessions.retain(leadSessionId, { source: 'teamModelSettings', signal })
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        signal.removeEventListener('abort', release)
        reference.release()
      }
      signal.addEventListener('abort', release, { once: true })
      try {
        if (signal.aborted) { release(); throw new Error('Catalog acquisition cancelled') }
        await reference.ready
        if (signal.aborted) throw new Error('Catalog acquisition cancelled')
        const directory = ctx.modelDirectories.directoryFor(leadSessionId)
        return { directory: directory.store, load: () => directory.load(), release }
      } catch (error) {
        release()
        throw error
      }
    },
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'team-model-settings',
    order: -19,
    locale: NS,
    inject: () => actions,
  }, TeamModelSettingsAction))
}
