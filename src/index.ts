import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SettingsDomain, settingsDomainSpec } from './domain.ts'
import { ModelRouting } from './model-routing.ts'
import { TeamModelSettingsService } from './service.ts'
import { ModelTools } from './tools.ts'

export { TeamModelSettingsService } from './service.ts'
export type * from './types.ts'
export const name = 'agent-team-model-settings'

export interface Config {
  readonly freshProvider?: string
  readonly forkProvider?: string
}
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'), forkProvider: z.string().default('fork'),
})

/** Wait for already-installed public services; never install/disable official plugins. */
export function apply(ctx: Context, config: Config = {}): Promise<void> {
  const fiber = ctx.inject(['agentTeams', 'agents', 'llm', 'storageDomain', 'tools', 'systemPrompt', 'sessionController'], async (ready) => {
    let stopping = false
    let domain: SettingsDomain | undefined
    let routing: ModelRouting | undefined
    let tools: ModelTools | undefined
    let disposeCreated: (() => void) | undefined
    let disposeEvents: (() => void) | undefined
    let disposeAgents: (() => void) | undefined
    const opening = ready.storageDomain.open(settingsDomainSpec)
    // Own the in-flight open before awaiting it: unload can happen during IO.
    ready.effect(() => async () => {
      stopping = true
      let owned: Awaited<typeof opening>
      try { owned = await opening } catch { return }
      try {
        tools?.dispose()
        await routing?.dispose()
        disposeCreated?.()
        disposeEvents?.()
        disposeAgents?.()
        await domain?.drain()
      } finally {
        await owned.close()
      }
    }, 'teamModelSettings.domain()')
    const owned = await opening
    if (stopping || ready.fiber.uid === null) return
    const settings = domain = new SettingsDomain(owned.table('teams'))
    const routes = routing = new ModelRouting(ready, settings)
    disposeEvents = ready.on('session/event', (session, event) => { routes.observe(session, event) })
    disposeCreated = ready.on('agent/created', async ({ agent, signal }) => {
      await routes.attach(agent, signal)
      tools?.install(agent)
      return undefined
    })
    disposeAgents = ready.on('agent/disposed', ({ agent }) => { routes.detach(agent); tools?.detach(agent) })
    tools = new ModelTools(ready, routes, {
      freshProvider: config.freshProvider ?? 'spawn', forkProvider: config.forkProvider ?? 'fork',
    })
    // Registered after hooks: Cordis unwinds effects in reverse order, so this
    // drain runs while the serial agent/created barrier is still subscribed.
    ready.effect(() => async () => { stopping = true; tools?.dispose(); await routes.dispose() }, 'teamModelSettings.runtimeDrain()')
    try {
      for (const agent of ready.agents.list()) {
        await routes.attach(agent)
        if (stopping) return
        tools.install(agent)
      }
      if (!stopping) ready.plugin(TeamModelSettingsService, { domain: settings })
    } catch (error) {
      if (!stopping) throw error
    }
  })
  return Promise.resolve(fiber).then(() => {})
}
