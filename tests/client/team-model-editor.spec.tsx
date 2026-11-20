// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TeamModelEditor } from '../../src/client/TeamModelEditor.tsx'
import { catalog, catalogState, deferred, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)

describe('shared team model editor autosave', () => {
  it('commits model changes immediately without a save button', async () => {
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), {
      target: { value: JSON.stringify(['p', 'new']) },
    })
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      provider: 'p', model: 'new',
    }))
    expect(screen.queryByRole('button', { name: zh['model.save'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['model.cancel'] })).toBeNull()
  })

  it('commits reasoning effort change immediately with full route', async () => {
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new', reasoningEffort: 'high' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'low' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      provider: 'p', model: 'new', reasoningEffort: 'low',
    }))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('clears reasoning effort to model default when model changes', async () => {
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new', reasoningEffort: 'high' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), {
      target: { value: JSON.stringify(['p', 'old']) },
    })
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      provider: 'p', model: 'old',
    }))
    expect(screen.queryByLabelText(zh['model.reasoning'])).toBeNull()
  })

  it('does not submit when selection is unchanged', async () => {
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'old']) } })
    expect(save).not.toHaveBeenCalled()
  })

  it('blocks second submit and disables controls while save is pending', async () => {
    const directory = catalog()
    const pending = deferred<void>()
    const save = vi.fn(() => pending.promise)
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    expect(save).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(true)

    // Attempt second change while saving
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'old']) } })
    expect(save).toHaveBeenCalledTimes(1)

    act(() => directory.set({ ...catalogState(), status: 'error', error: 'changed during pending' }))
    expect(screen.queryByText('changed during pending')).toBeNull()

    await act(async () => pending.resolve())
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(false)
  })

  it('blocks changes and submit when disabled prop or isLocked predicate is true', async () => {
    const save = vi.fn(async () => {})
    let locked = false
    const { rerender } = render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} disabled={true} t={t} />)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    expect(save).not.toHaveBeenCalled()

    rerender(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} disabled={false} isLocked={() => locked} t={t} />)
    locked = true
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    expect(save).not.toHaveBeenCalled()
  })

  it('retains failed selection, displays error and allows retry', async () => {
    const pending = deferred<void>()
    const save = vi.fn(() => pending.promise)
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    expect(save).toHaveBeenCalledWith({ provider: 'p', model: 'new' })

    await act(async () => pending.reject(new Error('network save failed')))
    expect(screen.getByText('Error: network save failed')).toBeTruthy()
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))

    const retryButton = screen.getByRole('button', { name: zh.retry })
    expect(retryButton).toBeTruthy()

    const retryPending = deferred<void>()
    save.mockImplementationOnce(() => retryPending.promise)
    fireEvent.click(retryButton)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ provider: 'p', model: 'new' })

    await act(async () => retryPending.resolve())
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  })

  it('allows choosing another valid model after failure, replacing the failed draft', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('first fail')).mockResolvedValueOnce(undefined)
    const directory = catalog()
    directory.set({ ...catalogState(), groups: [{ id: 'p', name: 'Provider', models: [
      { id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' },
    ] }] })
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'm1' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'm2']) } })
    await waitFor(() => expect(screen.getByText('Error: first fail')).toBeTruthy())

    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'm3']) } })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith({ provider: 'p', model: 'm3' })
  })

  it('synchronizes with updated initial prop when idle/saved without saving', () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
    expect(save).not.toHaveBeenCalled()

    rerender(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new' }} save={save} t={t} />)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
    expect(save).not.toHaveBeenCalled()
  })

  it('retains pending or failed draft during background initial prop updates (polling)', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save rejected'))
    const { rerender } = render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(screen.getByText('Error: save rejected')).toBeTruthy())

    // Simulating background poll returning old value
    rerender(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
    expect(screen.getByText('Error: save rejected')).toBeTruthy()
  })

  it('blocks a stale explicit reasoning effort until an explicit valid choice', () => {
    const directory = catalog()
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'new', reasoningEffort: 'removed' }} save={save} t={t} />)
    expect(screen.getByRole('option', { name: /removed.*不可用/u })).toBeTruthy()
    expect(save).not.toHaveBeenCalled()

    // Changing reasoning to valid choice triggers save
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'low' } })
    expect(save).toHaveBeenCalledWith({ provider: 'p', model: 'new', reasoningEffort: 'low' })
  })

  it('allows good provider groups despite partial provider failure', async () => {
    const directory = catalog()
    directory.set({ ...catalogState(), failures: [{ id: 'bad', name: 'Broken provider', message: 'provider down' }] })
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    expect(screen.getByText('Broken provider: provider down')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ provider: 'p', model: 'new' }))
  })

  it('ignores late save completion on unmounted editor and does not disturb a new editor instance', async () => {
    const pending = deferred<void>()
    const oldSave = vi.fn(() => pending.promise)
    const first = render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={oldSave} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    expect(oldSave).toHaveBeenCalledTimes(1)
    first.unmount()

    const newSave = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={newSave} t={t} />)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))

    await act(async () => pending.resolve())
    // New editor remains untouched by old save resolution
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
    expect(newSave).not.toHaveBeenCalled()
  })

  it('disables retry when catalog removes the failed route or reasoning effort', async () => {
    const directory = catalog()
    const save = vi.fn().mockRejectedValueOnce(new Error('route save failed'))
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(screen.getByText('Error: route save failed')).toBeTruthy())

    const retryButton = screen.getByRole('button', { name: zh.retry }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(false)

    // Catalog drops provider p / model new
    act(() => directory.set({ ...catalogState(), groups: [{ id: 'p', name: 'Provider', models: [{ id: 'old', name: 'Old' }] }] }))
    expect(retryButton.disabled).toBe(true)

    fireEvent.click(retryButton)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('ignores change to placeholder or invalid route, preserving current selection, status and retry target', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save rejected'))
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(screen.getByText('Error: save rejected')).toBeTruthy())
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))

    // Changing to placeholder "" or invalid key should be completely ignored
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: '' } })
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
    expect(screen.getByText('Error: save rejected')).toBeTruthy()
    expect(save).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['invalid', 'none']) } })
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
    expect(screen.getByText('Error: save rejected')).toBeTruthy()
    expect(save).toHaveBeenCalledTimes(1)

    // Retry should still target p/new
    save.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ provider: 'p', model: 'new' })
  })

  it('ignores change to invalid reasoning effort, without calling save', () => {
    const save = vi.fn(async () => {})
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new', reasoningEffort: 'stale' }} save={save} t={t} />)
    const reasoningSelect = screen.getByLabelText(zh['model.reasoning']) as HTMLSelectElement
    // Selecting the stale invalid option should not call save
    fireEvent.change(reasoningSelect, { target: { value: 'stale' } })
    expect(save).not.toHaveBeenCalled()
  })

  it('submits explicit route when re-selecting committed model after a failed attempt (response-loss recovery)', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save rejected')).mockResolvedValueOnce(undefined)
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    await waitFor(() => expect(screen.getByText('Error: save rejected')).toBeTruthy())

    // Re-selecting p/old explicitly submits to ensure server and client align
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'old']) } })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith({ provider: 'p', model: 'old' })
  })

  it('submits explicit effort when re-selecting committed effort after a failed attempt', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('effort save failed')).mockResolvedValueOnce(undefined)
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new', reasoningEffort: 'high' }} save={save} t={t} />)
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'low' } })
    await waitFor(() => expect(screen.getByText('Error: effort save failed')).toBeTruthy())

    // Re-selecting high explicitly submits
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'high' } })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith({ provider: 'p', model: 'new', reasoningEffort: 'high' })
  })

})
