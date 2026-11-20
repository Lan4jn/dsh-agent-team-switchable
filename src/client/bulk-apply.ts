/** Sequential bulk coordinator: no transaction, no rollback, honest per-member outcomes. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberModelView, TeamModelSelection, TeamModelSettingsView } from '../types.ts'
import { TeamSettingsRejectedError } from './settings-controller.ts'

export interface BulkTarget { readonly id: SessionId; readonly name: string; readonly phase: TeamMemberModelView['phase'] }
export type BulkStatus = 'saved' | 'failed' | 'skipped' | 'unknown'
export type BulkSkipReason = 'phase' | 'changed'
export interface BulkOutcome { readonly id: SessionId; readonly name: string; readonly status: BulkStatus; readonly reason?: BulkSkipReason }

/** Click-time visible non-Lead roster, unfiltered so skipped members stay visible. */
export function frozenTargets(view: TeamModelSettingsView): readonly BulkTarget[] {
  const seen = new Set<string>()
  const targets: BulkTarget[] = []
  for (const member of view.members) {
    if (seen.has(member.id)) continue
    seen.add(member.id)
    targets.push({ id: member.id, name: member.name, phase: member.phase })
  }
  return targets
}

export type BulkAgreement =
  | { readonly kind: 'agreed'; readonly selection: TeamModelSelection }
  | { readonly kind: 'mixed' }
  | { readonly kind: 'none' }

const sameRoute = (a: TeamModelSelection, b: TeamModelSelection): boolean =>
  a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

/**
 * The route the executable roster already shares, used only as a display initial.
 * Members outside the executable set never constrain it; a partial or disagreeing roster is mixed.
 */
export function agreedSelection(view: TeamModelSettingsView, activeNames: readonly string[]): BulkAgreement {
  const executable = view.members.filter(member => member.phase === 'active' && activeNames.includes(member.name))
  if (executable.length === 0) return { kind: 'none' }
  const routes = executable.map(member => member.nextModel ?? member.currentModel)
  const first = routes[0]
  if (first === undefined) return { kind: 'mixed' }
  return routes.every(route => route !== undefined && sameRoute(route, first))
    ? { kind: 'agreed', selection: first }
    : { kind: 'mixed' }
}

export interface BulkApplyInput {
  readonly targets: readonly BulkTarget[]
  readonly selection: TeamModelSelection
  /** Official projection names frozen at click time. */
  readonly activeNames: readonly string[]
  readonly getView: () => TeamModelSettingsView | null
  readonly save: (name: string, selection: TeamModelSelection) => Promise<void>
  readonly reload: () => Promise<void>
  readonly alive: () => boolean
  readonly report: (outcomes: readonly BulkOutcome[]) => void
}

export async function applyToMembers(input: BulkApplyInput): Promise<readonly BulkOutcome[]> {
  const outcomes: BulkOutcome[] = []
  for (const target of input.targets) {
    if (!input.alive()) break
    const row = input.getView()?.members.find(member => member.id === target.id && member.name === target.name)
    let outcome: BulkOutcome
    if (target.phase !== 'active') {
      outcome = { id: target.id, name: target.name, status: 'skipped', reason: 'phase' }
    } else if (row === undefined || row.phase !== 'active' || !input.activeNames.includes(target.name)) {
      outcome = { id: target.id, name: target.name, status: 'skipped', reason: 'changed' }
    } else {
      try {
        await input.save(target.name, input.selection)
        outcome = { id: target.id, name: target.name, status: 'saved' }
      } catch (error) {
        if (error instanceof TeamSettingsRejectedError) {
          // The Host rejected the write with a structured error: nothing changed.
          outcome = { id: target.id, name: target.name, status: 'failed' }
        } else {
          // A lost response may still have been persisted: refresh, claim neither way.
          try { await input.reload() } catch { /* the read-back is best effort */ }
          outcome = { id: target.id, name: target.name, status: 'unknown' }
        }
      }
    }
    outcomes.push(outcome)
    if (input.alive()) input.report([...outcomes])
  }
  return outcomes
}
