/** Bulk coordinator: frozen roster, sequential saves, and honest result states. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberModelView, TeamModelSelection, TeamModelSettingsView } from '../../src/types.ts'
import { TeamSettingsRejectedError } from '../../src/client/settings-controller.ts'
import { agreedSelection, applyToMembers, frozenTargets, type BulkOutcome } from '../../src/client/bulk-apply.ts'

const target: TeamModelSelection = { provider: 'p', model: 'new', reasoningEffort: 'high' }
const lead = 'lead' as SessionId

function row(over: Partial<TeamMemberModelView> & { id: string; name: string }): TeamMemberModelView {
  return { phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' }, ...over } as TeamMemberModelView
}
function view(members: TeamMemberModelView[]): TeamModelSettingsView {
  return { teamId: lead, revision: 1, defaultModel: { provider: 'p', model: 'old' }, members }
}

/** Records save calls and lets each test mutate the committed view mid-run. */
function harness(current: TeamModelSettingsView, activeNames: readonly string[] = current.members.filter(m => m.phase === 'active').map(m => m.name)) {
  const reports: (readonly BulkOutcome[])[] = []
  let live = current
  let alive = true
  const reload = vi.fn(async () => {})
  const save = vi.fn(async (_name: string, _selection: TeamModelSelection) => {})
  const saves = () => save.mock.calls.map(([name, selection]) => ({ name, selection }))
  const input = {
    targets: frozenTargets(current),
    selection: target,
    activeNames,
    getView: () => live,
    save,
    reload,
    alive: () => alive,
    report: (outcomes: readonly BulkOutcome[]) => { reports.push(outcomes) },
  }
  return {
    input, saves, reports, reload, save,
    setView: (next: TeamModelSettingsView) => { live = next },
    stop: () => { alive = false },
    outcomes: () => reports.at(-1) ?? [],
  }
}

describe('bulk model apply', () => {
  it('freezes every visible teammate including provisioning and failed ones, deduped by id', () => {
    const frozen = frozenTargets(view([
      row({ id: 'a', name: 'a' }),
      row({ id: 'b', name: 'b', phase: 'provisioning' }),
      row({ id: 'c', name: 'c', phase: 'failed' }),
      row({ id: 'a', name: 'a' }),
    ]))
    expect(frozen.map(item => [item.id, item.name, item.phase])).toEqual([
      ['a', 'a', 'active'], ['b', 'b', 'provisioning'], ['c', 'c', 'failed'],
    ])
  })

  it('agrees on the shared route of the executable roster only', () => {
    const both = view([
      row({ id: 'a', name: 'a', nextModel: target }),
      row({ id: 'b', name: 'b', nextModel: { ...target } }),
      row({ id: 'c', name: 'c', phase: 'provisioning', currentModel: { provider: 'other', model: 'x' } }),
    ])
    expect(agreedSelection(both, ['a', 'b'])).toEqual({ kind: 'agreed', selection: target })

    const fallback = view([
      row({ id: 'a', name: 'a', currentModel: target }),
      row({ id: 'b', name: 'b', nextModel: target }),
    ])
    expect(agreedSelection(fallback, ['a', 'b'])).toEqual({ kind: 'agreed', selection: target })
  })

  it('reports a mixed roster instead of inventing a shared route', () => {
    const mixed = view([
      row({ id: 'a', name: 'a', nextModel: target }),
      row({ id: 'b', name: 'b', nextModel: { provider: 'p', model: 'old' } }),
    ])
    expect(agreedSelection(mixed, ['a', 'b'])).toEqual({ kind: 'mixed' })

    const effortDiffers = view([
      row({ id: 'a', name: 'a', nextModel: target }),
      row({ id: 'b', name: 'b', nextModel: { provider: 'p', model: 'new' } }),
    ])
    expect(agreedSelection(effortDiffers, ['a', 'b'])).toEqual({ kind: 'mixed' })

    const unknownRoute = view([
      row({ id: 'a', name: 'a', nextModel: target }),
      { id: 'b' as SessionId, name: 'b', phase: 'active', status: 'inactive' },
    ])
    expect(agreedSelection(unknownRoute, ['a', 'b'])).toEqual({ kind: 'mixed' })
  })

  it('treats an empty executable set as no agreement', () => {
    const onlyStarting = view([row({ id: 'c', name: 'c', phase: 'provisioning' })])
    expect(agreedSelection(onlyStarting, ['c'])).toEqual({ kind: 'none' })
    const activeNotProjected = view([row({ id: 'a', name: 'a', currentModel: target })])
    expect(agreedSelection(activeNotProjected, ['b'])).toEqual({ kind: 'none' })
    expect(agreedSelection(view([]), [])).toEqual({ kind: 'none' })
  })

  it('saves each active member in order and reports non-active members as skipped', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b', phase: 'provisioning' }), row({ id: 'c', name: 'c', phase: 'failed' })]))
    const outcomes = await applyToMembers(h.input)
    expect(h.saves().map(item => item.name)).toEqual(['a'])
    expect(h.saves()[0].selection).toEqual(target)
    expect(outcomes).toEqual([
      { id: 'a', name: 'a', status: 'saved' },
      { id: 'b', name: 'b', status: 'skipped', reason: 'phase' },
      { id: 'c', name: 'c', status: 'skipped', reason: 'phase' },
    ])
    expect(h.reports).toHaveLength(3)
  })

  it('never sends a write for a teammate whose stable id was replaced under the same name', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' })]))
    h.setView(view([row({ id: 'a2', name: 'a' })]))
    const outcomes = await applyToMembers(h.input)
    expect(h.save).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ id: 'a', name: 'a', status: 'skipped', reason: 'changed' }])
  })

  it('writes every eligible member even when the resolved route already equals the target', async () => {
    const h = harness(view([
      row({ id: 'a', name: 'a', nextModel: target }),
      row({ id: 'b', name: 'b', currentModel: target }),
    ]))
    const outcomes = await applyToMembers(h.input)
    expect(h.saves().map(item => item.name)).toEqual(['a', 'b'])
    expect(h.saves().every(item => item.selection === target)).toBe(true)
    expect(outcomes).toEqual([
      { id: 'a', name: 'a', status: 'saved' }, { id: 'b', name: 'b', status: 'saved' },
    ])
  })

  it('records a structured rejection as failed and keeps applying the rest', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b' })]))
    h.save.mockRejectedValueOnce(new TeamSettingsRejectedError('member-not-found'))
    const outcomes = await applyToMembers(h.input)
    expect(h.saves().map(item => item.name)).toEqual(['a', 'b'])
    expect(outcomes.map(item => [item.name, item.status])).toEqual([['a', 'failed'], ['b', 'saved']])
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('treats a lost response as unknown, refreshes, and never claims the write', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b' })]))
    h.save.mockRejectedValueOnce(new Error('socket closed'))
    // Even a read-back that equals the target must not be reported as an acknowledged save.
    h.reload.mockImplementationOnce(async () => {
      h.setView(view([row({ id: 'a', name: 'a', nextModel: target }), row({ id: 'b', name: 'b' })]))
    })
    const outcomes = await applyToMembers(h.input)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.saves().map(item => item.name)).toEqual(['a', 'b'])
    expect(outcomes.map(item => [item.name, item.status])).toEqual([['a', 'unknown'], ['b', 'saved']])
  })

  it('keeps an unreadable read-back unknown instead of claiming nothing was written', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' })]))
    h.save.mockRejectedValueOnce(new Error('gateway timeout'))
    h.reload.mockRejectedValueOnce(new Error('offline'))
    const outcomes = await applyToMembers(h.input)
    expect(outcomes).toEqual([{ id: 'a', name: 'a', status: 'unknown' }])
  })

  it('stops sending remaining members after unmount and keeps finished results', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b' })]))
    h.save.mockImplementationOnce(async () => { h.stop() })
    const outcomes = await applyToMembers(h.input)
    expect(h.saves().map(item => item.name)).toEqual(['a'])
    expect(outcomes).toEqual([{ id: 'a', name: 'a', status: 'saved' }])
  })

  it('skips a name no longer active in the frozen official projection', async () => {
    const h = harness(view([row({ id: 'a', name: 'a' }), row({ id: 'b', name: 'b' })]), ['b'])
    const outcomes = await applyToMembers(h.input)
    expect(h.saves().map(item => item.name)).toEqual(['b'])
    expect(outcomes.map(item => [item.name, item.status, item.reason])).toEqual([
      ['a', 'skipped', 'changed'], ['b', 'saved', undefined],
    ])
  })

})
