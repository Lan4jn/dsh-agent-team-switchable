// @vitest-environment jsdom
/** One shared draft, two explicit scopes: members and the future-teammate default. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamModelSettingsView } from '../../src/types.ts'
import { TeamModelDialog } from '../../src/client/TeamModelDialog.tsx'
import { TeamSettingsController } from '../../src/client/settings-controller.ts'
import { apiFor, catalog, deferred, lead, snapshot, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
const OLD_AUTOSAVE_HINT = '选择即自动保存'

function mountDialog(controller: TeamSettingsController, options: Partial<Parameters<typeof TeamModelDialog>[0]> = {}) {
  const directory = catalog()
  return render(<TeamModelDialog controller={controller} anchor={{ current: null }} acquireCatalog={async () => ({ directory, load: async () => {}, release: vi.fn() })} eligible activeNames={['worker']} onClose={vi.fn()} t={t} {...options} />)
}

async function bulkRegion() {
  const region = await screen.findByRole('region', { name: zh['bulk.title'] })
  await within(region).findByLabelText(zh['bulk.model'])
  return region
}

function choose(region: HTMLElement, model: string, effort?: string) {
  fireEvent.change(within(region).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(['p', model]) } })
  if (effort !== undefined) fireEvent.change(within(region).getByLabelText(zh['model.reasoning']), { target: { value: effort } })
}

/** Keeps the committed view in sync with the default write so the summary updates. */
function statefulDefault(view: TeamModelSettingsView) {
  let current = view
  const api = apiFor(view)
  vi.mocked(api.getSettings).mockImplementation(async () => ({ ok: true as const, value: current }))
  vi.mocked(api.selectTeamDefaultModel).mockImplementation(async request => {
    current = { ...current, revision: current.revision + 1, defaultModel: request.selection }
    return { ok: true as const, value: current }
  })
  return { api, saved: () => current }
}

describe('shared model picker with two explicit scopes', () => {
  it('renders one shared draft, two scoped buttons, and a read-only default row', async () => {
    mountDialog(new TeamSettingsController(lead, apiFor()))
    const region = await bulkRegion()
    const defaults = screen.getByRole('region', { name: zh['defaultModel.title'] })

    expect(within(region).getAllByLabelText(zh['bulk.model'])).toHaveLength(1)
    expect(within(region).getByRole('button', { name: zh['bulk.apply'] })).toBeTruthy()
    expect(within(region).getByRole('button', { name: zh['defaultAction.apply'] })).toBeTruthy()
    expect(within(region).getByText(zh['bulk.applyScope'])).toBeTruthy()
    expect(within(region).getByText(zh['defaultAction.scope'])).toBeTruthy()

    expect(within(defaults).queryByLabelText(zh.model)).toBeNull()
    expect(defaults.querySelector('[data-committed-default]')).toBeTruthy()
    expect(within(defaults).getByRole('button', { name: zh['defaultAction.recovery'] })).toBeTruthy()
    expect(screen.queryByText(OLD_AUTOSAVE_HINT)).toBeNull()
  })

  it('never writes from changing the shared draft', async () => {
    const api = apiFor()
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    choose(region, 'new', 'high')
    choose(region, 'old')
    expect(api.selectMemberModel).not.toHaveBeenCalled()
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
  })

  it('writes only the future default from the second button', async () => {
    const { api } = statefulDefault(snapshot())
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    choose(region, 'new', 'high')
    fireEvent.click(within(region).getByRole('button', { name: zh['defaultAction.apply'] }))

    await screen.findByText(zh['defaultAction.saved'])
    expect(api.selectTeamDefaultModel).toHaveBeenCalledTimes(1)
    expect(api.selectTeamDefaultModel).toHaveBeenCalledWith({ leadSessionId: lead, selection: { provider: 'p', model: 'new', reasoningEffort: 'high' } })
    expect(api.selectMemberModel).not.toHaveBeenCalled()
    expect(await screen.findByText(/已保存的新成员默认：p\/new/u)).toBeTruthy()
  })

  it('reports a structured default rejection as failed and keeps the summary', async () => {
    const api = apiFor()
    vi.mocked(api.selectTeamDefaultModel).mockResolvedValueOnce({ ok: false, error: { code: 'bad-selection', message: 'nope' } } as Awaited<ReturnType<typeof api.selectTeamDefaultModel>>)
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    choose(region, 'new')
    fireEvent.click(within(region).getByRole('button', { name: zh['defaultAction.apply'] }))

    await screen.findByText(zh['defaultAction.failed'])
    expect(screen.getByText(/已保存的新成员默认：p\/old/u)).toBeTruthy()
    expect(api.selectMemberModel).not.toHaveBeenCalled()
  })

  it('reports a lost default response as unknown without claiming anything', async () => {
    const api = apiFor()
    vi.mocked(api.selectTeamDefaultModel).mockRejectedValueOnce(new Error('socket closed'))
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    choose(region, 'new')
    fireEvent.click(within(region).getByRole('button', { name: zh['defaultAction.apply'] }))

    await screen.findByText(zh['defaultAction.unknown'])
    expect(screen.getByText(/已保存的新成员默认：p\/old/u)).toBeTruthy()
  })

  it('restores inheritance from the lightweight entry and disables it when already inherited', async () => {
    const { api, saved } = statefulDefault(snapshot())
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    const defaults = await screen.findByRole('region', { name: zh['defaultModel.title'] })
    fireEvent.click(within(defaults).getByRole('button', { name: zh['defaultAction.recovery'] }))

    await waitFor(() => expect(api.selectTeamDefaultModel).toHaveBeenCalledWith({ leadSessionId: lead, selection: null }))
    await waitFor(() => expect(screen.getByText(/已保存的新成员默认：继承原设置/u)).toBeTruthy())
    expect(saved().defaultModel).toBeNull()
    expect((within(defaults).getByRole('button', { name: zh['defaultAction.recovery'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the default action usable when no member is executable', async () => {
    const view: TeamModelSettingsView = {
      teamId: lead, revision: 1, defaultModel: { provider: 'p', model: 'old' },
      members: [{ id: 'starting-id' as SessionId, name: 'starting', phase: 'provisioning', status: 'inactive' }],
    }
    const { api } = statefulDefault(view)
    mountDialog(new TeamSettingsController(lead, api), { activeNames: [] })
    const region = await bulkRegion()

    await waitFor(() => expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old'])))
    const applyCurrent = within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement
    const applyDefault = within(region).getByRole('button', { name: zh['defaultAction.apply'] }) as HTMLButtonElement
    expect(applyCurrent.disabled).toBe(true)
    expect(applyDefault.disabled).toBe(false)

    fireEvent.click(applyDefault)
    await waitFor(() => expect(api.selectTeamDefaultModel).toHaveBeenCalledTimes(1))
    expect(api.selectMemberModel).not.toHaveBeenCalled()
  })

  it('disables both actions when there is no member and no saved default', async () => {
    const view: TeamModelSettingsView = { teamId: lead, revision: 1, defaultModel: null, members: [] }
    const api = apiFor(view)
    mountDialog(new TeamSettingsController(lead, api), { activeNames: [] })
    const region = await bulkRegion()
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe('')
    expect((within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(region).getByRole('button', { name: zh['defaultAction.apply'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables the default action after a manual pick even with no members or saved default', async () => {
    const view: TeamModelSettingsView = { teamId: lead, revision: 1, defaultModel: null, members: [] }
    const { api } = statefulDefault(view)
    mountDialog(new TeamSettingsController(lead, api), { activeNames: [] })
    const region = await bulkRegion()
    const applyCurrent = within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement
    const applyDefault = within(region).getByRole('button', { name: zh['defaultAction.apply'] }) as HTMLButtonElement
    expect(applyDefault.disabled).toBe(true)

    choose(region, 'new')
    expect(applyCurrent.disabled).toBe(true)
    expect(applyDefault.disabled).toBe(false)
    fireEvent.click(applyDefault)
    await waitFor(() => expect(api.selectTeamDefaultModel).toHaveBeenCalledTimes(1))
    expect(api.selectTeamDefaultModel).toHaveBeenCalledWith({ leadSessionId: lead, selection: { provider: 'p', model: 'new' } })
    expect(api.selectMemberModel).not.toHaveBeenCalled()
  })

  it('restores inheritance even when the shared draft is invalid', async () => {
    // The saved default's model is no longer in the catalog, so the draft can never be valid.
    const view: TeamModelSettingsView = {
      teamId: lead, revision: 1, defaultModel: { provider: 'p', model: 'gone' },
      members: [{ id: 'starting-id' as SessionId, name: 'starting', phase: 'provisioning', status: 'inactive' }],
    }
    const api = apiFor(view)
    vi.mocked(api.selectTeamDefaultModel).mockImplementation(async request => ({
      ok: true as const,
      value: { ...view, revision: 2, defaultModel: request.selection },
    }))
    mountDialog(new TeamSettingsController(lead, api), { activeNames: [] })
    const defaults = await screen.findByRole('region', { name: zh['defaultModel.title'] })
    const recovery = within(defaults).getByRole('button', { name: zh['defaultAction.recovery'] }) as HTMLButtonElement
    expect(recovery.disabled).toBe(false)
    fireEvent.click(recovery)

    await waitFor(() => expect(api.selectTeamDefaultModel).toHaveBeenCalledWith({ leadSessionId: lead, selection: null }))
    await waitFor(() => expect(screen.getByText(/已保存的新成员默认：继承原设置/u)).toBeTruthy())
  })

  it('asks for a choice when members disagree instead of falling back to the default', async () => {
    const view: TeamModelSettingsView = {
      teamId: lead, revision: 1, defaultModel: { provider: 'p', model: 'old' },
      members: [
        { id: 'a-id' as SessionId, name: 'a', phase: 'active', status: 'running', nextModel: { provider: 'p', model: 'new' } },
        { id: 'b-id' as SessionId, name: 'b', phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' } },
      ],
    }
    const api = apiFor(view)
    mountDialog(new TeamSettingsController(lead, api), { activeNames: ['a', 'b'] })
    const region = await bulkRegion()

    await waitFor(() => expect(within(region).getByText(zh['bulk.mixed'])).toBeTruthy())
    expect((within(region).getByLabelText(zh['bulk.model']) as HTMLSelectElement).value).toBe('')
    expect((within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(region).getByRole('button', { name: zh['defaultAction.apply'] }) as HTMLButtonElement).disabled).toBe(true)

    choose(region, 'new')
    expect((within(region).getByRole('button', { name: zh['bulk.apply'] }) as HTMLButtonElement).disabled).toBe(false)
    expect((within(region).getByRole('button', { name: zh['defaultAction.apply'] }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('runs only the first of two same-tick writes and keeps the losing scope untouched', async () => {
    const api = apiFor()
    mountDialog(new TeamSettingsController(lead, api))
    const region = await bulkRegion()
    choose(region, 'new')
    const members = within(region).getByRole('button', { name: zh['bulk.apply'] })
    const future = within(region).getByRole('button', { name: zh['defaultAction.apply'] })

    act(() => { fireEvent.click(members); fireEvent.click(future) })
    await waitFor(() => expect(api.selectMemberModel).toHaveBeenCalledTimes(1))
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()

    cleanup()
    const second = apiFor()
    mountDialog(new TeamSettingsController(lead, second))
    const other = await bulkRegion()
    choose(other, 'new')
    act(() => {
      fireEvent.click(within(other).getByRole('button', { name: zh['defaultAction.apply'] }))
      fireEvent.click(within(other).getByRole('button', { name: zh['bulk.apply'] }))
    })
    await waitFor(() => expect(second.selectTeamDefaultModel).toHaveBeenCalledTimes(1))
    expect(second.selectMemberModel).not.toHaveBeenCalled()
  })

  it('locks member autosave and closing while the default write is pending', async () => {
    const api = apiFor()
    const pending = deferred<Awaited<ReturnType<typeof api.selectTeamDefaultModel>>>()
    vi.mocked(api.selectTeamDefaultModel).mockReturnValueOnce(pending.promise)
    const onClose = vi.fn()
    mountDialog(new TeamSettingsController(lead, api), { onClose })
    const region = await bulkRegion()
    choose(region, 'new')
    fireEvent.click(within(region).getByRole('button', { name: zh['defaultAction.apply'] }))

    const worker = screen.getByRole('article', { name: 'worker' })
    expect((within(worker).getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['model.close'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => pending.resolve({ ok: true, value: snapshot(2) }))
  })
})
