// @vitest-environment jsdom
/** Bulk apply integration: one explicit click, one shared lock, per-member results. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamModelSelection, TeamModelSettingsView } from '../../src/types.ts'
import { TeamModelDialog } from '../../src/client/TeamModelDialog.tsx'
import { TeamSettingsController } from '../../src/client/settings-controller.ts'
import { apiFor, catalog, deferred, lead, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)

const roster: TeamModelSettingsView = {
  teamId: lead,
  revision: 1,
  defaultModel: { provider: 'p', model: 'old' },
  members: [
    { id: 'a-id' as SessionId, name: 'a', phase: 'active', status: 'running', currentModel: { provider: 'p', model: 'old' } },
    { id: 'b-id' as SessionId, name: 'b', phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' } },
    { id: 'c-id' as SessionId, name: 'c', phase: 'provisioning', status: 'inactive' },
  ],
}

function mountDialog(controller: TeamSettingsController, options: Partial<Parameters<typeof TeamModelDialog>[0]> = {}) {
  const directory = catalog()
  return render(<TeamModelDialog controller={controller} anchor={{ current: null }} acquireCatalog={async () => ({ directory, load: async () => {}, release: vi.fn() })} eligible activeNames={['a', 'b']} onClose={vi.fn()} t={t} {...options} />)
}

/** Commit an explicit choice the way the Host view would report it. */
function withChoice(view: TeamModelSettingsView, name: string, selection: TeamModelSelection): TeamModelSettingsView {
  return {
    ...view,
    revision: view.revision + 1,
    members: view.members.map(member => member.name === name ? { ...member, nextModel: selection } : member),
  }
}

/** GET returns the latest committed view so reopening reads back what was written. */
function stateful(initial: TeamModelSettingsView) {
  let current = initial
  const api = apiFor(initial)
  vi.mocked(api.getSettings).mockImplementation(async () => ({ ok: true as const, value: current }))
  vi.mocked(api.selectMemberModel).mockImplementation(async request => {
    current = withChoice(current, request.target, request.selection)
    return { ok: true as const, value: current }
  })
  vi.mocked(api.selectTeamDefaultModel).mockImplementation(async () => ({ ok: true as const, value: current }))
  return { api, saved: () => current }
}

async function bulkRegion() {
  const region = await screen.findByRole('region', { name: zh['bulk.title'] })
  // The picker appears once the catalog lease is ready; drafts may backfill a tick later.
  await within(region).findByLabelText(zh['bulk.model'])
  return region
}

function chooseRoute(region: HTMLElement, route: [string, string], effort?: string) {
  fireEvent.change(within(region).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(route) } })
  if (effort !== undefined) {
    fireEvent.change(within(region).getByLabelText(zh['model.reasoning']), { target: { value: effort } })
  }
}

describe('bulk apply to every teammate', () => {
  it('backfills the agreed saved route, never sends an RPC from draft changes, and clears effort on a model change', async () => {
    const api = apiFor({ ...roster })
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    const modelSelect = within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement
    // Both executable members resolve to p/old, so the shared route is a real view fact, not a default.
    await waitFor(() => expect(modelSelect.value).toBe(JSON.stringify(['p', 'old'])))

    chooseRoute(region, ['p', 'new'], 'high')
    expect((within(region).getByLabelText(zh.model === zh.model ? zh['model.reasoning'] : '') as HTMLSelectElement).value).toBe('high')
    chooseRoute(region, ['p', 'old'])
    expect(within(region).queryByLabelText(zh['model.reasoning'])).toBeNull()
    expect(api.selectMemberModel).not.toHaveBeenCalled()
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
  })

  it('applies one click to each active teammate in order and leaves the default untouched', async () => {
    const api = apiFor({ ...roster })
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a', 'b'])
    expect(vi.mocked(api.selectMemberModel).mock.calls[0][0].selection).toEqual({ provider: 'p', model: 'new', reasoningEffort: 'high' })
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
    expect(within(region).getByText(new RegExp(`c：${zh['bulk.result.skipped']}`))).toBeTruthy()
  })

  it('holds the lock in the same tick against a per-member editor change', async () => {
    const api = apiFor({ ...roster })
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    const rowB = screen.getByRole('article', { name: 'b' })

    act(() => {
      fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
      fireEvent.change(within(rowB).getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'old']) } })
    })
    await waitFor(() => expect(vi.mocked(api.selectMemberModel).mock.calls.length).toBe(2))
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a', 'b'])
    expect(vi.mocked(api.selectTeamDefaultModel).mock.calls).toHaveLength(0)
  })

  it('keeps one write per member when clicked twice in the same tick (controller saving holds the second)', async () => {
    const api = apiFor({ ...roster })
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    const apply = within(region).getByRole('button', { name: zh['bulk.apply'] })

    act(() => { fireEvent.click(apply); fireEvent.click(apply) })
    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a', 'b'])
  })

  it('keeps going after a structured rejection and keeps the summary through a poll', async () => {
    const api = apiFor({ ...roster })
    vi.mocked(api.selectMemberModel).mockResolvedValueOnce({ ok: false, error: { code: 'member-not-found', message: 'gone' } } as Awaited<ReturnType<typeof api.selectMemberModel>>)
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(within(region).getByText(/已保存 1 · 失败 1/u)).toBeTruthy())
    expect(within(region).getByText(new RegExp(`a：${zh['bulk.result.failed']}`))).toBeTruthy()
    expect(within(region).getByText(new RegExp(`b：${zh['bulk.result.saved']}`))).toBeTruthy()
    await act(async () => { await controller.load() })
    expect(within(region).getByText(/已保存 1 · 失败 1/u)).toBeTruthy()
  })

  it('skips a teammate replaced under the same name while the bulk is running', async () => {
    const api = apiFor({ ...roster })
    const pending = deferred<Awaited<ReturnType<typeof api.selectMemberModel>>>()
    vi.mocked(api.selectMemberModel).mockReturnValueOnce(pending.promise)
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    const replaced: TeamModelSettingsView = {
      ...roster,
      revision: 2,
      members: roster.members.map(member => member.name === 'b' ? { ...member, id: 'b-new' as SessionId } : member),
    }
    await act(async () => pending.resolve({ ok: true, value: replaced }))

    await waitFor(() => expect(within(region).getByText(new RegExp(`b：${zh['bulk.result.skipped']}`))).toBeTruthy())
    expect(within(region).getByText(new RegExp(zh['bulk.skip.changed']))).toBeTruthy()
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a'])
  })

  it('does not attempt a teammate that joined after the click', async () => {
    const api = apiFor({ ...roster })
    const pending = deferred<Awaited<ReturnType<typeof api.selectMemberModel>>>()
    vi.mocked(api.selectMemberModel).mockReturnValueOnce(pending.promise)
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    const grown: TeamModelSettingsView = {
      ...roster,
      revision: 2,
      members: [...roster.members, { id: 'd-id' as SessionId, name: 'd', phase: 'active', status: 'inactive' }],
    }
    await act(async () => pending.resolve({ ok: true, value: grown }))

    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a', 'b'])
    expect(within(region).queryByText(/d：/u)).toBeNull()
  })

  it('shows a lost response as unconfirmed and keeps the remaining teammates', async () => {
    const api = apiFor({ ...roster })
    vi.mocked(api.selectMemberModel).mockRejectedValueOnce(new Error('socket closed'))
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(within(region).getByText(/已保存 1 · .*未确认 1/u)).toBeTruthy())
    expect(within(region).getByText(new RegExp(`a：${zh['bulk.result.unknown']}`))).toBeTruthy()
    expect(within(region).getByText(new RegExp(`b：${zh['bulk.result.saved']}`))).toBeTruthy()
  })

  it('stops sending the remaining teammates after unmount', async () => {
    const api = apiFor({ ...roster })
    const pending = deferred<Awaited<ReturnType<typeof api.selectMemberModel>>>()
    vi.mocked(api.selectMemberModel).mockReturnValueOnce(pending.promise)
    const view = mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(api.selectMemberModel).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => pending.resolve({ ok: true, value: roster }))
    expect(api.selectMemberModel).toHaveBeenCalledTimes(1)
  })

  it('asks for a choice instead of a default when members disagree', async () => {
    const mixed: TeamModelSettingsView = {
      ...roster,
      members: roster.members.map(member => member.name === 'a'
        ? { ...member, nextModel: { provider: 'p', model: 'new', reasoningEffort: 'high' } }
        : member.name === 'b' ? { ...member, nextModel: { provider: 'p', model: 'old' } } : member),
    }
    const api = apiFor(mixed)
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    await waitFor(() => expect(within(region).getByText(zh['bulk.mixed'])).toBeTruthy())
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe('')
    const apply = within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    chooseRoute(region, ['p', 'new'])
    expect(apply.disabled).toBe(false)
    expect(within(region).queryByText(zh['bulk.mixed'])).toBeNull()
  })

  it('blocks the submit when the live catalog no longer offers the drafted route', async () => {
    const api = apiFor({ ...roster })
    const directory = catalog()
    mountDialog(new TeamSettingsController(lead, api), {
      acquireCatalog: async () => ({ directory, load: async () => {}, release: vi.fn() }),
    })
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    const apply = within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)

    act(() => {
      directory.update(state => {
        state.groups = [{ id: 'p', name: 'Provider', models: [{ id: 'old', name: 'Old' }] }]
      })
    })
    await waitFor(() => expect(apply.disabled).toBe(true))
    fireEvent.click(apply)
    expect(api.selectMemberModel).not.toHaveBeenCalled()
  })

  it('writes a teammate whose resolved route already equals the target', async () => {
    const api = apiFor({
      ...roster,
      members: [
        { id: 'a-id' as SessionId, name: 'a', phase: 'active', status: 'running', currentModel: { provider: 'p', model: 'new', reasoningEffort: 'high' } },
        { id: 'b-id' as SessionId, name: 'b', phase: 'active', status: 'inactive', nextModel: { provider: 'p', model: 'new', reasoningEffort: 'high' } },
      ],
    })
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    expect(vi.mocked(api.selectMemberModel).mock.calls.map(([request]) => request.target)).toEqual(['a', 'b'])
    expect(vi.mocked(api.selectMemberModel).mock.calls[0][0].selection).toEqual({ provider: 'p', model: 'new', reasoningEffort: 'high' })
  })

  it('stays locked while a lost response is being re-read', async () => {
    const api = apiFor({ ...roster })
    vi.mocked(api.selectMemberModel).mockRejectedValueOnce(new Error('socket closed'))
    const reload = deferred<Awaited<ReturnType<typeof api.getSettings>>>()
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'])
    vi.mocked(api.getSettings).mockReturnValueOnce(reload.promise)
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))

    await waitFor(() => expect(api.selectMemberModel).toHaveBeenCalledTimes(1))
    const close = screen.getByRole('button', { name: zh['model.close'] }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
    const rowB = screen.getByRole('article', { name: 'b' })
    expect((within(rowB).getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
    expect(api.selectMemberModel).toHaveBeenCalledTimes(1)

    await act(async () => reload.resolve({ ok: true, value: roster }))
    await waitFor(() => expect(within(region).getByText(/已保存 1 · .*未确认 1/u)).toBeTruthy())
    expect(api.selectMemberModel).toHaveBeenCalledTimes(2)
  })

  it('clears a draft whose effort was retired and asks for a new choice', async () => {
    const api = apiFor({ ...roster })
    const directory = catalog()
    mountDialog(new TeamSettingsController(lead, api), {
      acquireCatalog: async () => ({ directory, load: async () => {}, release: vi.fn() }),
    })
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    const apply = within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)

    act(() => {
      directory.update(state => {
        state.groups = [{ id: 'p', name: 'Provider', models: [{ id: 'new', name: 'New', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }] } }] }]
      })
    })
    await waitFor(() => expect(within(region).getByText(zh['bulk.reselect'])).toBeTruthy())
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe('')
    expect(within(region).queryByLabelText(zh['model.reasoning'])).toBeNull()
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(api.selectMemberModel).not.toHaveBeenCalled()
  })

  it('backfills the saved route after closing and reopening the same menu', async () => {
    const { api } = stateful({ ...roster })
    const controller = new TeamSettingsController(lead, api)
    const first = mountDialog(controller)
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    first.unmount()

    mountDialog(controller)
    const reopened = await bulkRegion()
    await waitFor(() => expect((within(reopened).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))
    expect((within(reopened).getByLabelText(zh['model.reasoning']) as HTMLSelectElement).value).toBe('high')
    expect((within(reopened).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(false)
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
  })

  it('backfills a fresh controller from the committed view', async () => {
    const { api, saved } = stateful({ ...roster })
    const first = mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    first.unmount()

    mountDialog(new TeamSettingsController(lead, apiFor(saved())))
    const reopened = await bulkRegion()
    await waitFor(() => expect((within(reopened).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))
  })

  it('still writes every member when re-applying from a backfilled draft', async () => {
    const { api } = stateful({ ...roster })
    const controller = new TeamSettingsController(lead, api)
    const first = mountDialog(controller)
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
    await waitFor(() => expect(vi.mocked(api.selectMemberModel).mock.calls.length).toBe(2))
    first.unmount()

    mountDialog(new TeamSettingsController(lead, api))
    const reopened = await bulkRegion()
    await waitFor(() => expect((within(reopened).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))
    fireEvent.click(within(reopened).getByRole('button', { name: zh['bulk.apply'] }))
    await waitFor(() => expect(vi.mocked(api.selectMemberModel).mock.calls.length).toBe(4))
    expect(vi.mocked(api.selectMemberModel).mock.calls.slice(2).map(([request]) => request.target)).toEqual(['a', 'b'])
  })

  it('backfills once when the saved view arrives asynchronously', async () => {
    const { api, saved } = stateful({ ...roster })
    const savedView = withChoice(withChoice(saved(), 'a', { provider: 'p', model: 'new', reasoningEffort: 'high' }), 'b', { provider: 'p', model: 'new', reasoningEffort: 'high' })
    const held = deferred<Awaited<ReturnType<typeof api.getSettings>>>()
    vi.mocked(api.getSettings).mockReturnValueOnce(held.promise)
    mountDialog(new TeamSettingsController(lead, api))
    await act(async () => held.resolve({ ok: true, value: savedView }))
    const region = await bulkRegion()
    await waitFor(() => expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))
  })

  it('backfills after an asynchronous catalog lease arrives', async () => {
    const savedView = withChoice(withChoice({ ...roster, revision: 1 }, 'a', { provider: 'p', model: 'new', reasoningEffort: 'high' }), 'b', { provider: 'p', model: 'new', reasoningEffort: 'high' })
    const directory = catalog()
    let releaseCatalog!: () => void
    const gate = new Promise<void>(resolve => { releaseCatalog = resolve })
    mountDialog(new TeamSettingsController(lead, apiFor(savedView)), {
      acquireCatalog: async () => { await gate; return { directory, load: async () => {}, release: vi.fn() } },
    })
    const region = await screen.findByRole('region', { name: zh['bulk.title'] })
    expect(within(region).queryByLabelText(zh['bulk.model'])).toBeNull()

    await act(async () => { releaseCatalog() })
    await waitFor(() => expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))
    expect((within(region).getByLabelText(zh['model.reasoning']) as HTMLSelectElement).value).toBe('high')
  })

  it('keeps a hand-edited draft across a poll of the committed view', async () => {
    const { api, saved } = stateful({ ...roster })
    const savedView = withChoice(withChoice(saved(), 'a', { provider: 'p', model: 'new', reasoningEffort: 'high' }), 'b', { provider: 'p', model: 'new', reasoningEffort: 'high' })
    const controller = new TeamSettingsController(lead, apiFor(savedView))
    mountDialog(controller)
    const region = await bulkRegion()
    await waitFor(() => expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new'])))

    chooseRoute(region, ['p', 'old'])
    await act(async () => { await controller.load() })
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
  })

  it('never carries a draft across teams', async () => {
    const { api, saved } = stateful({ ...roster })
    const first = mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    chooseRoute(region, ['p', 'new'], 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['bulk.apply'] }))
    await waitFor(() => expect(within(region).getByText(/已保存 2 · 失败 0/u)).toBeTruthy())
    first.unmount()
    expect(saved().members[0].nextModel?.model).toBe('new')

    const other = 'lead-b' as SessionId
    const viewB: TeamModelSettingsView = { teamId: other, revision: 1, defaultModel: null, members: [
      { id: 'x-id' as SessionId, name: 'x', phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' } },
    ] }
    mountDialog(new TeamSettingsController(other, apiFor(viewB)), { activeNames: ['x'] })
    const regionB = await bulkRegion()
    await waitFor(() => expect((within(regionB).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old'])))
  })

  it('clears a backfilled draft the live catalog no longer offers', async () => {
    const savedView = withChoice(withChoice({ ...roster, revision: 1 }, 'a', { provider: 'p', model: 'gone', reasoningEffort: 'high' }), 'b', { provider: 'p', model: 'gone', reasoningEffort: 'high' })
    const directory = catalog()
    mountDialog(new TeamSettingsController(lead, apiFor(savedView)), {
      acquireCatalog: async () => ({ directory, load: async () => {}, release: vi.fn() }),
    })
    const region = await bulkRegion()
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe('')
    expect((within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(region).queryByText(zh['bulk.mixed'])).toBeNull()
  })

  it('shows an empty-roster hint instead of a roster it cannot see', async () => {
    const empty: TeamModelSettingsView = { teamId: lead, revision: 1, defaultModel: null, members: [] }
    mountDialog(new TeamSettingsController(lead, apiFor(empty)))
    const region = await bulkRegion()
    expect(within(region).getByText(zh['bulk.empty'])).toBeTruthy()
    expect((within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})
