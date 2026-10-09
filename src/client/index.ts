/// <reference path="./css-modules.d.ts" />
/** Browser entry for the additive Team model settings contribution. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import teamSettingsRemote from 'dsh-agent-team-switchable/remote'
import { registerTeamModelSettingsUi } from './mount.ts'

export { inject } from './mount.ts'
export type { TeamModelSettingsInjected, TeamModelSettingsProps } from './TeamModelSettingsAction.tsx'
export type { TeamKey } from './locales.ts'

export async function apply(ctx: ClientContext): Promise<void> {
  // The remote contribution must exist before dependency injection resolves it.
  const disposeRemote = await ctx.remote.$mount(teamSettingsRemote)
  let ui: ReturnType<ClientContext['inject']> | undefined
  try {
    ui = ctx.inject(['remote.team-model-settings'], registerTeamModelSettingsUi)
    await ui
  } catch (error) {
    try { await ui?.dispose() } finally { await disposeRemote() }
    throw error
  }
  const ownedUi = ui
  ctx.effect(() => async () => {
    try { await ownedUi.dispose() } finally { await disposeRemote() }
  }, 'team-model-settings: UI and remote contribution')
}
