import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { TeamModelSettingsError } from './error.ts'
import type { ModelRouting } from './model-routing.ts'

export interface ToolConfig { readonly freshProvider: string; readonly forkProvider: string }

export const shortSystemPrompt = 'Create teammates only when the user explicitly requests Agent Teams or teammates. Use spawn_teammate_with_model (fresh context) or fork_teammate_with_model (completed Lead context) when an explicit teammate LLM route is needed. Their optional model is a full provider/model selection; omitting reasoningEffort clears inherited effort. Omit model to capture the committed Team default at dispatch, or ordinary inheritance when the default is cleared. Existing official Team tools remain available and unchanged.'

const parameters = {
  name: { type: 'string', required: true, description: 'Unique immutable lower-kebab-case teammate name.' },
  description: { type: 'string', required: true, description: 'Short delegated responsibility.' },
  prompt: { type: 'string', required: true, description: 'Complete initial teammate task.' },
  model: {
    type: 'object', additionalProperties: false,
    properties: {
      provider: { type: 'string', required: true },
      model: { type: 'string', required: true },
      reasoningEffort: { type: 'string' },
    },
  },
} as const
const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    target: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
  },
} as const

/** Only adds two unique tool definitions; never touches original definitions or methods. */
export class ModelTools {
  private readonly installed = new Map<Agent, () => void>()
  private readonly disposeMiddleware: () => void

  constructor(private readonly ctx: Context, private readonly routing: ModelRouting, private readonly config: ToolConfig) {
    this.disposeMiddleware = ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'spawn_teammate' && exec.name !== 'fork_teammate') return next()
      if (exec.agent === undefined) return next()
      const args = exec.arguments as { name?: unknown } | null
      if (typeof args?.name !== 'string') return next()
      // This supported around-dispatch hook spans the real body. pre-execute does not.
      // Identity, arguments, signal and official schema stay byte-for-byte untouched.
      return routing.creation(exec.agent, args.name, undefined, exec.signal, next)
    })
  }

  install(agent: Agent): void {
    if (this.installed.has(agent) || this.ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return
    const scoped = agent.ctx
    const disposers: Array<() => void> = []
    try {
      disposers.push(scoped.systemPrompt.section({
        name: 'team-model-settings:guidance', order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'), text: shortSystemPrompt,
      }))
      for (const context of ['fresh', 'fork'] as const) {
        disposers.push(scoped.tools.register(defineTool({
          name: context === 'fresh' ? 'spawn_teammate_with_model' : 'fork_teammate_with_model',
          description: 'Create one named teammate with an optional complete LLM route. Only use after explicit user Agent Teams intent; Lead only.',
          parameters,
          output: { schema: resultSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: (args, exec) => {
            if (exec.agent !== agent) throw new TeamModelSettingsError('lead-required', 'The tool requires its exact scoped Team Lead.')
            return this.routing.creation(agent, args.name, args.model, exec.signal, async () => {
              const result = await this.ctx.agentTeams.spawnTeammate(agent, {
                name: args.name, description: args.description,
                prompt: [{ type: 'text', text: `You are teammate ${JSON.stringify(args.name.trim())}; your Team Lead is "lead". Use the existing Team tools to collaborate.` }, { type: 'text', text: args.prompt }],
                context, provider: context === 'fresh' ? this.config.freshProvider : this.config.forkProvider,
                signal: exec.signal,
              })
              return { id: result.member.id, target: result.member.name, status: result.member.status }
            })
          },
        })))
      }
      this.installed.set(agent, () => { for (const dispose of disposers.reverse()) dispose() })
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }

  detach(agent: Agent): void {
    this.installed.get(agent)?.()
    this.installed.delete(agent)
  }

  dispose(): void {
    this.disposeMiddleware()
    for (const agent of this.installed.keys()) this.detach(agent)
  }
}
