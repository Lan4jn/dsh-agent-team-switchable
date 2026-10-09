/// <reference path="./css-modules.d.ts" />
/** Browser entry registering the Agent Teams conversation-header action. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import teamModelsRemote from 'dsh-agent-team-switchable/remote'
import { registerAgentTeamUi } from './mount.ts'

export { inject } from './mount.ts'
export type { TeamActionInjected, TeamActionProps } from './TeamAction.tsx'
export type { TeamKey } from './locales.ts'

/**
 * Register the Team locale dictionaries and header action on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(teamModelsRemote)
  const ui = ctx.inject(['remote.agent-team-models'], registerAgentTeamUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  ctx.effect(() => async () => {
    await ui.dispose()
    await disposeRemote()
  }, 'client-ui-agent-team: model remote and UI')
}
