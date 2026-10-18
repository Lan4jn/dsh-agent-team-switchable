import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const PACKAGE_TAG = 'dsh-remote-team-bridge'
export const name = 'dsh-remote-team-bridge'

export interface BridgeConfig {
  readonly enabled?: boolean
  readonly port?: number
  readonly host?: string
  readonly maxDedicatedTeams?: number
}

export const Config: z<BridgeConfig> = z.object({
  enabled: z.boolean().default(false).description('Whether to start listening on the remote team bridge port'),
  port: z.number().default(19820).description('Port to listen for remote bridge connections'),
  host: z.string().default('::').description('Host / interface to bind (default :: IPv6 dual-stack)'),
  maxDedicatedTeams: z.number().default(5).description('Maximum concurrent dedicated remote teams'),
})

export function apply(ctx: Context, configInput: BridgeConfig = {}): void {
  const cfg = Config(configInput)

  // As specified in the plan: inject sessionController, storageDomain, agentTeams permissively
  ctx.inject(['sessionController', 'storageDomain', 'agentTeams'], (scoped) => {
    scoped.effect(() => {
      if (!cfg.enabled) {
        // Disabled by default: remains completely inert
        return () => {}
      }

      // When enabled, lifecycle management hooks here
      return () => {
        // Teardown / cleanup
      }
    }, 'remote-team-bridge:lifecycle')
  })
}

export { TYPERT } from './typert.host.ts'
export { TYPERT_REMOTE } from './typert.remote-client.ts'
