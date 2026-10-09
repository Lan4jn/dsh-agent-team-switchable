import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { TEAM_SETTINGS_DOMAIN, type TeamModelSelection } from './types.ts'
import { unavailable } from './error.ts'

const route = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }).strict()
  .transform((value): TeamModelSelection => ({ provider: value.provider, model: value.model,
    ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort },
  }))
const choice = z.object({ selection: route, effectiveAfterTurn: z.number().int().nonnegative() }).strict()
const team = z.object({
  revision: z.number().int().nonnegative(),
  defaultModel: route.nullable(),
  initials: z.record(z.string(), route.nullable()),
  choices: z.record(z.string(), choice),
}).strict()

export const settingsDomainSpec = defineDomain({
  name: TEAM_SETTINGS_DOMAIN, version: 1,
  tables: { teams: domainTable<string, TeamSettingsRecord>(team) },
})

export interface MemberChoice {
  readonly selection: TeamModelSelection
  readonly effectiveAfterTurn: number
}
export interface TeamSettingsRecord {
  readonly revision: number
  readonly defaultModel: TeamModelSelection | null
  /** UUID keys; a present null permanently records original inheritance. */
  readonly initials: Readonly<Record<string, TeamModelSelection | null>>
  readonly choices: Readonly<Record<string, MemberChoice>>
}
export interface SettingsTable {
  get(id: string): TeamSettingsRecord | undefined
  put(id: string, value: TeamSettingsRecord): Promise<void>
}

/** Freeze detached JSON, including nested routes. No consumer may mutate committed state. */
export function immutable<T>(value: T): T {
  const detached = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(detached)
  return detached
}
const EMPTY = immutable<TeamSettingsRecord>({ revision: 0, defaultModel: null, initials: {}, choices: {} })

/**
 * Per-Team serial durable transformations over the public synchronous committed get.
 * Any put rejection may follow rename: poison the entire instance without rollback.
 * Recovery is explicit cold plugin disposal/Domain.close, then a new open and read.
 */
export class SettingsDomain {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly committed = new Map<string, TeamSettingsRecord>()
  private failed = false
  private closing = false

  constructor(private readonly table: SettingsTable) {}

  assertAvailable(): void {
    if (this.failed || this.closing) throw unavailable()
  }

  read(id: string): TeamSettingsRecord {
    this.assertAvailable()
    return this.readCommitted(id)
  }

  private readCommitted(id: string): TeamSettingsRecord {
    const cached = this.committed.get(id)
    if (cached !== undefined) return cached
    const stored = this.table.get(id)
    const result = stored === undefined ? EMPTY : immutable(stored)
    this.committed.set(id, result)
    return result
  }

  transform(id: string, transform: (old: TeamSettingsRecord) => TeamSettingsRecord): Promise<TeamSettingsRecord> {
    try { this.assertAvailable() } catch (error) { return Promise.reject(error) }
    const previous = this.tails.get(id) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      if (this.failed) throw unavailable()
      const old = this.readCommitted(id)
      const changed = transform(old)
      if (changed === old) return old
      const next = immutable(team.parse(changed))
      try {
        await this.table.put(id, next)
      } catch (error) {
        // Never attempt an inverse write: the durable medium may already contain next.
        this.failed = true
        throw error
      }
      this.committed.set(id, next)
      return next
    })
    this.tails.set(id, operation)
    void operation.finally(() => {
      if (this.tails.get(id) === operation) this.tails.delete(id)
    }).catch(() => {})
    return operation
  }

  /** Stop admission first, drain accepted puts, then let the owner close Domain. */
  async drain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.tails.values()])
  }
}
