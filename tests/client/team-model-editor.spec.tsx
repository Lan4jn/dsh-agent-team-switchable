// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TeamModelEditor } from '../../src/client/TeamModelEditor.tsx'
import { catalog, catalogState, deferred, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
const saveButton = () => screen.getByRole('button', { name: zh['model.save'] }) as HTMLButtonElement

describe('shared team model editor', () => {
  it('blocks a stale explicit reasoning effort until an explicit valid choice', () => {
    const directory = catalog()
    render(<TeamModelEditor mode="member" directory={directory} initial={{ provider: 'p', model: 'new', reasoningEffort: 'removed' }} save={vi.fn()} cancel={vi.fn()} t={t} />)
    expect(screen.getByRole('option', { name: /removed.*不可用/u })).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['model.reasoning']), { target: { value: 'low' } })
    expect(saveButton().disabled).toBe(false)
    act(() => directory.set({ ...catalogState(), groups: [{ id: 'p', name: 'Provider', models: [{ id: 'new', name: 'New', reasoning: { efforts: [] } }] }] }))
    expect(saveButton().disabled).toBe(true)
  })

  it('saves only provider/model/explicit effort, not SDK defaults', async () => {
    const save = vi.fn(async () => {})
    const cancel = vi.fn()
    render(<TeamModelEditor mode="member" directory={catalog()} save={save} cancel={cancel} t={t} />)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledWith({ provider: 'p', model: 'new' })
  })

  it('clears a default to null with an unavailable offline catalog', async () => {
    const directory = catalog()
    directory.set({ groups: [], failures: [], status: 'error', error: 'offline catalog' })
    const save = vi.fn(async () => {})
    render(<TeamModelEditor mode="default" directory={directory} initial={{ provider: 'gone', model: 'gone' }} save={save} cancel={vi.fn()} t={t} />)
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: '__inherit__' } })
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(saveButton())
    await waitFor(() => expect(save).toHaveBeenCalledWith(null))
  })

  it('allows good provider groups despite partial provider failure', () => {
    const directory = catalog()
    directory.set({ ...catalogState(), failures: [{ id: 'bad', name: 'Broken provider', message: 'provider down' }] })
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'old' }} save={vi.fn()} cancel={vi.fn()} t={t} />)
    expect(screen.getByText('Broken provider: provider down')).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
  })

  it('freezes pending controls and catalog display, retains input after failure', async () => {
    const directory = catalog()
    const pending = deferred<void>()
    render(<TeamModelEditor directory={directory} initial={{ provider: 'p', model: 'old' }} save={() => pending.promise} cancel={vi.fn()} t={t} />)
    fireEvent.click(saveButton())
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['model.cancel'] }) as HTMLButtonElement).disabled).toBe(true)
    act(() => directory.set({ groups: [], failures: [], status: 'error', error: 'changed during pending' }))
    expect(screen.queryByText('changed during pending')).toBeNull()
    expect(screen.getByRole('option', { name: 'Old' })).toBeTruthy()
    await act(async () => pending.reject(new Error('save failed')))
    expect(screen.getByText('Error: save failed')).toBeTruthy()
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
  })

  it('cancel never submits and an unmounted late save cannot cancel a new editor', async () => {
    const save = vi.fn(async () => {})
    const cancel = vi.fn()
    const first = render(<TeamModelEditor directory={catalog()} save={save} cancel={cancel} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['model.cancel'] }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    first.unmount()
    const pending = deferred<void>()
    const lateCancel = vi.fn()
    const second = render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'old' }} save={() => pending.promise} cancel={lateCancel} t={t} />)
    fireEvent.click(saveButton())
    second.unmount()
    render(<TeamModelEditor directory={catalog()} initial={{ provider: 'p', model: 'new' }} save={save} cancel={cancel} t={t} />)
    await act(async () => pending.resolve())
    expect(lateCancel).not.toHaveBeenCalled()
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'new']))
  })
})
