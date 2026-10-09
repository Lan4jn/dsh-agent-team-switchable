// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TeamModelDialog } from '../../src/client/TeamModelDialog.tsx'
import { TeamSettingsController } from '../../src/client/settings-controller.ts'
import { apiFor, catalog, deferred, lead, snapshot, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
function mountDialog(controller: TeamSettingsController, options: Partial<Parameters<typeof TeamModelDialog>[0]> = {}) {
  return render(<TeamModelDialog controller={controller} directory={catalog()} activeNames={['worker']} loadCatalog={async () => {}} onClose={vi.fn()} t={t} {...options} />)
}

describe('unified settings dialog', () => {
  it('has one default/member selector and separate real current/next summaries', async () => {
    const api = apiFor()
    const controller = new TeamSettingsController(lead, api)
    mountDialog(controller)
    await screen.findByText(/已保存的新成员默认：p\/old/u)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('option', { name: zh['defaultModel.title'] })).toBeTruthy()
    expect((screen.getByRole('option', { name: 'starting' }) as HTMLOptionElement).disabled).toBe(true)
    expect((screen.getByRole('option', { name: 'failed' }) as HTMLOptionElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /最近已使用.*actual\/request-header-model/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /下轮模型.*p\/new/u })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.target), { target: { value: 'member:worker' } })
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
    expect((screen.getByLabelText(zh['model.reasoning']) as HTMLSelectElement).value).toBe('high')
    const returned = { ...snapshot(2), members: snapshot().members.map(item => item.name === 'worker' ? { ...item, nextModel: { provider: 'p', model: 'new', reasoningEffort: 'low' } } : item) }
    vi.mocked(api.selectMemberModel).mockResolvedValueOnce({ ok: true, value: returned })
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'low' } })
    fireEvent.click(screen.getByRole('button', { name: zh['model.save'] }))
    await waitFor(() => expect(controller.store.getSnapshot().view?.revision).toBe(2))
    expect(api.selectMemberModel).toHaveBeenCalledWith({ leadSessionId: lead, target: 'worker', selection: { provider: 'p', model: 'new', reasoningEffort: 'low' } })
    expect(api.selectTeamDefaultModel).not.toHaveBeenCalled()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('preserves committed default on failure, freezes target/close, and discards edits on reopen', async () => {
    const api = apiFor()
    const controller = new TeamSettingsController(lead, api)
    const onClose = vi.fn()
    const pending = deferred<Awaited<ReturnType<typeof api.selectTeamDefaultModel>>>()
    vi.mocked(api.selectTeamDefaultModel).mockReturnValueOnce(pending.promise)
    const view = mountDialog(controller, { onClose })
    await screen.findByText(/已保存的新成员默认：p\/old/u)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(screen.getByRole('button', { name: zh['model.save'] }))
    expect((screen.getByLabelText(zh.target) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['model.close'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/已保存的新成员默认：p\/old/u)).toBeTruthy()
    await act(async () => pending.reject(new Error('save failed')))
    expect(screen.getByText('Error: save failed')).toBeTruthy()
    expect(controller.store.getSnapshot().view?.defaultModel?.model).toBe('old')
    view.unmount()
    mountDialog(controller)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
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
    expect(screen.queryByLabelText(zh.target)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByLabelText(zh.target)
    expect(api.getSettings).toHaveBeenCalledTimes(2)
  })
})
