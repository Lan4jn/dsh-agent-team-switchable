// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamModelSettingsView } from '../../src/types.ts'
import { TeamModelDialog } from '../../src/client/TeamModelDialog.tsx'
import { TeamSettingsController } from '../../src/client/settings-controller.ts'
import { apiFor, catalog, deferred, lead, snapshot, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
function mountDialog(controller: TeamSettingsController, options: Partial<Parameters<typeof TeamModelDialog>[0]> = {}) {
  const directory = catalog()
  return render(<TeamModelDialog controller={controller} anchor={{ current: null }} acquireCatalog={async () => ({ directory, load: async () => {}, release: vi.fn() })} eligible activeNames={['worker']} onClose={vi.fn()} t={t} {...options} />)
}

describe('unified settings dialog', () => {
  it('shows a read-only default row, one shared draft, and each teammate inline', async () => {
    mountDialog(new TeamSettingsController(lead, apiFor()))
    const defaults = await screen.findByRole('region', {
      name: zh['defaultModel.title'],
    })
    const bulk = await screen.findByRole('region', { name: zh['bulk.title'] })
    const worker = screen.getByRole('article', { name: 'worker' })
    // The future default is no longer a second autosave editor.
    expect(within(defaults).queryByLabelText(zh.model)).toBeNull()
    expect(defaults.querySelector('[data-committed-default]')).toBeTruthy()
    expect(within(bulk).getByLabelText(zh['bulk.model'])).toBeTruthy()
    expect(within(worker).getByLabelText(zh.model)).toBeTruthy()
    expect(screen.queryByLabelText(zh.target)).toBeNull()
    expect(screen.queryByRole('button', { name: zh['model.save'] })).toBeNull()
    expect(screen.queryByText('选择即自动保存')).toBeNull()
  })

  it('has default and member editors with separate real current/next summaries', async () => {
    const api = apiFor()
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    await screen.findByText(/已保存的新成员默认：p\/old/u)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const defaults = screen.getByRole('region', { name: zh['defaultModel.title'] })
    const worker = screen.getByRole('article', { name: 'worker' })
    const starting = screen.getByRole('article', { name: 'starting' })
    const failed = screen.getByRole('article', { name: 'failed' })

    expect(within(defaults).queryByLabelText(zh.model)).toBeNull()
    expect(within(worker).getByLabelText(zh.model)).toBeTruthy()
    expect(within(starting).queryByLabelText(zh.model)).toBeNull()
    expect(within(starting).getByText(zh['member.provisioning'])).toBeTruthy()
    expect(within(failed).queryByLabelText(zh.model)).toBeNull()
    expect(within(failed).getByText(zh['member.failed'])).toBeTruthy()

    expect(screen.getByRole('button', { name: /最近已使用.*actual\/request-header-model/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /下轮模型.*p\/new/u })).toBeTruthy()
  })

  it('preserves committed default on a lost response and keeps close blocked while saving', async () => {
    const api = apiFor()
    const controller = new TeamSettingsController(lead, api)
    const onClose = vi.fn()
    const pending = deferred<Awaited<ReturnType<typeof api.selectTeamDefaultModel>>>()
    vi.mocked(api.selectTeamDefaultModel).mockReturnValueOnce(pending.promise)
    const view = mountDialog(controller, { onClose })
    await screen.findByText(/已保存的新成员默认：p\/old/u)
    const bulk = await screen.findByRole('region', { name: zh['bulk.title'] })
    fireEvent.change(within(bulk).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(within(bulk).getByRole('button', { name: zh['defaultAction.apply'] }))
    expect((screen.getByRole('button', { name: zh['model.close'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/已保存的新成员默认：p\/old/u)).toBeTruthy()
    await act(async () => pending.reject(new Error('save failed')))
    // A transport loss is unknown, never "failed to write".
    expect(screen.getByText(zh['defaultAction.unknown'])).toBeTruthy()
    expect(controller.store.getSnapshot().view?.defaultModel?.model).toBe('old')
    view.unmount()
    mountDialog(controller)
    await screen.findByText(/已保存的新成员默认：p\/old/u)
    await waitFor(() => expect(controller.store.getSnapshot().loading).toBe(false))
  })

  it('reads on open, polls about once a second, and ignores closed late reads', async () => {
    vi.useFakeTimers()
    try {
      const api = apiFor()
      const controller = new TeamSettingsController(lead, api)
      const view = mountDialog(controller)
      await act(async () => {})
      expect(api.getSettings).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(api.getSettings).toHaveBeenCalledTimes(2)
      const pending = deferred<Awaited<ReturnType<typeof api.getSettings>>>()
      vi.mocked(api.getSettings).mockReturnValueOnce(pending.promise)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      view.unmount()
      await act(async () => pending.resolve({ ok: true, value: snapshot(99) }))
      expect(controller.store.getSnapshot().view?.revision).toBe(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(api.getSettings).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('shows a restored-session load failure and retries without enabling absent settings', async () => {
    const api = apiFor()
    vi.mocked(api.getSettings).mockRejectedValueOnce(new Error('restored session unavailable'))
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    await screen.findByText('Error: restored session unavailable')
    expect(screen.queryByRole('region', { name: zh['defaultModel.title'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    expect(api.getSettings).toHaveBeenCalledTimes(2)
  })

  it('allows editing an inactive teammate (phase: active, status: inactive) and auto-saves independently', async () => {
    const customSnapshot: TeamModelSettingsView = {
      teamId: lead,
      revision: 1,
      defaultModel: { provider: 'p', model: 'old' },
      members: [
        { id: 'worker-id' as SessionId, name: 'worker', phase: 'active', status: 'running', currentModel: { provider: 'p', model: 'old' }, nextModel: null },
        { id: 'inactive-id' as SessionId, name: 'inactive-member', phase: 'active', status: 'inactive', currentModel: { provider: 'p', model: 'old' }, nextModel: null },
      ],
    }
    const api = apiFor(customSnapshot)
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller, { activeNames: ['worker', 'inactive-member'] })
    const workerArticle = await screen.findByRole('article', { name: 'worker' })
    const inactiveArticle = screen.getByRole('article', { name: 'inactive-member' })
    expect(within(inactiveArticle).getByText(zh['member.inactive'])).toBeTruthy()

    // 1. Change worker -> only worker RPC is invoked
    const workerSelect = within(workerArticle).getByLabelText(zh.model)
    fireEvent.change(workerSelect, { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(api.selectMemberModel).toHaveBeenCalledWith({
      leadSessionId: lead,
      target: 'worker',
      selection: { provider: 'p', model: 'new' },
    }))

    // 2. Change inactive-member -> only inactive-member RPC is invoked
    const inactiveSelect = within(inactiveArticle).getByLabelText(zh.model)
    fireEvent.change(inactiveSelect, { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(api.selectMemberModel).toHaveBeenCalledWith({
      leadSessionId: lead,
      target: 'inactive-member',
      selection: { provider: 'p', model: 'new' },
    }))

    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
  })

  it('prevents concurrent double-submit across scopes via immediate controller lock in the same tick', async () => {
    const api = apiFor()
    const onClose = vi.fn()
    const pending = deferred<Awaited<ReturnType<typeof api.selectTeamDefaultModel>>>()
    vi.mocked(api.selectTeamDefaultModel).mockReturnValueOnce(pending.promise)
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller, { onClose })
    const bulk = await screen.findByRole('region', { name: zh['bulk.title'] })
    const worker = screen.getByRole('article', { name: 'worker' })

    fireEvent.change(within(bulk).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(['p', 'new']) } })
    const workerSelect = within(worker).getByLabelText(zh.model)

    // Fired in the exact same batch without intermediate flush
    act(() => {
      fireEvent.click(within(bulk).getByRole('button', { name: zh['defaultAction.apply'] }))
      fireEvent.change(workerSelect, { target: { value: JSON.stringify(['p', 'old']) } })
    })

    expect(api.selectTeamDefaultModel).toHaveBeenCalledTimes(1)
    expect(api.selectMemberModel).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().saving).toBe(true)

    // Dialog close attempts while saving are blocked
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => pending.resolve({ ok: true, value: snapshot(2) }))
  })

  it.each(['failed', 'removed', 'replaced-id'] as const)(
    'prevents retry if member becomes %s after initial failure',
    async (reason) => {
      const api = apiFor()
      vi.mocked(api.selectMemberModel).mockRejectedValueOnce(new Error('initial network error'))
      const controller = new TeamSettingsController(lead, api)
      mountDialog(controller)
      const worker = await screen.findByRole('article', { name: 'worker' })
      const select = within(worker).getByLabelText(zh.model)

      // 1. Initial save fails -> editor enters failed state with retry button
      fireEvent.change(select, { target: { value: JSON.stringify(['p', 'old']) } })
      await screen.findByText('Error: initial network error')
      const retryBtn = within(worker).getByRole('button', { name: zh.retry })
      expect(retryBtn).toBeTruthy()

      // 2. Member state invalidation in store view, then click retry in the same act
      act(() => {
        controller.store.update(state => {
          if (!state.view) return
          if (reason === 'failed') {
            const m = state.view.members.find(x => x.name === 'worker')
            if (m) m.phase = 'failed'
          } else if (reason === 'removed') {
            state.view.members = state.view.members.filter(x => x.name !== 'worker')
          } else if (reason === 'replaced-id') {
            const m = state.view.members.find(x => x.name === 'worker')
            if (m) m.id = 'replacement-worker-id' as SessionId
          }
        })
        fireEvent.click(retryBtn)
      })

      // 3. Guaranteed only the initial call was made, retry was blocked!
      expect(api.selectMemberModel).toHaveBeenCalledTimes(1)
    },
  )
})
