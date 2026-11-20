// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TeamModelSettingsAction, type TeamModelSettingsProps } from '../../src/client/TeamModelSettingsAction.tsx'
import { apiFor, catalog, deferred, lead, snapshot, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
const officialTeam = { members: [
  { id: lead, name: 'Lead', role: 'lead', phase: 'active' },
  { id: 'worker-id', name: 'worker', role: 'teammate', phase: 'active' },
  { id: 'starting-id', name: 'starting', role: 'teammate', phase: 'provisioning' },
] }
function actionProps(options: { sessionId?: string; addressed?: boolean; team?: typeof officialTeam | null } = {}): TeamModelSettingsProps {
  const team = options.team === undefined ? officialTeam : options.team
  const directory = catalog()
  return {
    sessionId: options.sessionId ?? lead,
    api: apiFor(), t,
    acquireCatalogFor: vi.fn(async () => ({ directory, load: vi.fn(async () => {}), release: vi.fn() })),
    useSession: (selector: (value: unknown) => unknown) => selector(options.addressed ? { subagent: { address: { parentSessionId: lead } } } : {}),
    useSessions: (selector: (value: unknown) => unknown) => selector({ projectionsBySession: { [lead]: { values: team === null ? {} : { agentTeam: team } } } }),
  } as unknown as TeamModelSettingsProps
}

describe('pure additive header action', () => {
  it('keeps a top-level trigger without projection but denies known non-Team workers', async () => {
    const props = actionProps({ team: null })
    const view = render(<TeamModelSettingsAction {...props} />)
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
    expect(props.acquireCatalogFor).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    view.rerender(<TeamModelSettingsAction {...actionProps({ sessionId: 'non-team', addressed: true })} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<TeamModelSettingsAction {...actionProps({ sessionId: 'starting-id', addressed: true })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps an unverified child trigger without granting parent editing rights', () => {
    const props = actionProps({ sessionId: 'non-team', addressed: true, team: null })
    render(<TeamModelSettingsAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(props.api.getSettings).not.toHaveBeenCalled()
    expect(props.acquireCatalogFor).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh.model)).toBeNull()
  })

  it('loads only the Lead catalog and leaves an existing official header/panel node untouched', async () => {
    const props = actionProps({ sessionId: 'worker-id', addressed: true })
    render(<><button data-official-team>官方团队按钮</button><aside data-official-panel>官方任务面板</aside><TeamModelSettingsAction {...props} /></>)
    const officialButton = screen.getByText('官方团队按钮')
    const officialPanel = screen.getByText('官方任务面板')
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    expect(props.acquireCatalogFor).toHaveBeenCalledWith(lead, expect.any(AbortSignal))
    expect(screen.getByText('官方团队按钮')).toBe(officialButton)
    expect(screen.getByText('官方任务面板')).toBe(officialPanel)
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('官方任务面板')).toBe(officialPanel)
  })

  it('header summary stays committed on a lost default save and same-Lead reopen ignores draft inputs', async () => {
    const props = actionProps()
    vi.mocked(props.api.selectTeamDefaultModel).mockRejectedValueOnce(new Error('failed'))
    render(<TeamModelSettingsAction {...props} />)
    const button = screen.getByRole('button', { name: zh.trigger })
    fireEvent.click(button)
    const bulk = await screen.findByRole('region', { name: zh['bulk.title'] })
    expect(button.title).toContain('p/old')
    fireEvent.change(within(bulk).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(within(bulk).getByRole('button', { name: zh['defaultAction.apply'] }))
    await screen.findByText(zh['defaultAction.unknown'])
    expect(button.title).toContain('p/old')
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    fireEvent.click(button)
    const reopenedDefaults = await screen.findByRole('region', { name: zh['defaultModel.title'] })
    expect(within(reopenedDefaults).queryByLabelText(zh.model)).toBeNull()
    expect(within(reopenedDefaults).getByText(/已保存的新成员默认：p\/old/u)).toBeTruthy()
    await waitFor(() => expect(props.api.getSettings).toHaveBeenCalledTimes(2))
  })

  it('owns a body portal, toggles, restores focus on Escape and respects outside focus', async () => {
    const props = actionProps()
    const view = render(<><button>outside</button><TeamModelSettingsAction {...props} /></>)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    fireEvent.click(trigger)
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    const menu = screen.getByRole('dialog')
    expect(menu.parentElement).toBe(document.body)
    expect(view.container.contains(menu)).toBe(false)
    expect(document.activeElement).toBe(menu)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(props.acquireCatalogFor).toHaveBeenCalledTimes(3)
  })

  it('clamps the menu to the viewport and follows its own anchor on resize/scroll', async () => {
    const props = actionProps()
    render(<TeamModelSettingsAction {...props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    const rect = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 730, left: 970, right: 1000, width: 30, height: 30, x: 970, y: 700, toJSON: () => {} })
    fireEvent.click(trigger)
    const menu = screen.getByRole('dialog')
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8)
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(menu.style.top)).toBeLessThan(700)
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8)
    rect.mockReturnValue({ top: 10, bottom: 40, left: 2, right: 32, width: 30, height: 30, x: 2, y: 10, toJSON: () => {} })
    fireEvent(window, new Event('resize'))
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('46px')
    rect.mockReturnValue({ top: 20, bottom: 50, left: 2, right: 32, width: 30, height: 30, x: 2, y: 20, toJSON: () => {} })
    fireEvent(document, new Event('scroll'))
    expect(menu.style.top).toBe('56px')
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    rect.mockRestore()
  })

  it('never closes or releases a catalog while a save is pending', async () => {
    const props = actionProps()
    const release = vi.fn()
    vi.mocked(props.acquireCatalogFor).mockResolvedValue({ directory: catalog(), load: async () => {}, release })
    const pending = deferred<Awaited<ReturnType<typeof props.api.selectTeamDefaultModel>>>()
    vi.mocked(props.api.selectTeamDefaultModel).mockReturnValueOnce(pending.promise)
    render(<TeamModelSettingsAction {...props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    fireEvent.click(trigger)
    const bulk = await screen.findByRole('region', { name: zh['bulk.title'] })
    fireEvent.change(within(bulk).getByLabelText(zh['bulk.model']), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(within(bulk).getByRole('button', { name: zh['defaultAction.apply'] }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(release).not.toHaveBeenCalled()
    await act(async () => pending.resolve({ ok: true, value: snapshot(2) }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases late acquisitions on session switch without reviving an old menu', async () => {
    const old = actionProps()
    const pending = deferred<Awaited<ReturnType<typeof old.acquireCatalogFor>>>()
    const release = vi.fn()
    const load = vi.fn(async () => {})
    vi.mocked(old.acquireCatalogFor).mockReturnValueOnce(pending.promise)
    const view = render(<TeamModelSettingsAction {...old} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    const signal = vi.mocked(old.acquireCatalogFor).mock.calls[0]![1]
    const next = actionProps({ sessionId: 'worker-id', addressed: true })
    view.rerender(<TeamModelSettingsAction {...next} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    await act(async () => pending.resolve({ directory: catalog(), load, release }))
    expect(release).toHaveBeenCalledOnce()
    expect(load).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(next.acquireCatalogFor).toHaveBeenCalledWith(lead, expect.any(AbortSignal))
  })

  it('remounts an unverified child menu when official membership becomes ready', async () => {
    const props = actionProps({ sessionId: 'worker-id', addressed: true, team: null })
    const view = render(<TeamModelSettingsAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(props.acquireCatalogFor).not.toHaveBeenCalled()
    const verified = actionProps({ sessionId: 'worker-id', addressed: true })
    view.rerender(<TeamModelSettingsAction {...verified} />)
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    expect(screen.queryByText(zh.unavailable)).toBeNull()
    expect(verified.acquireCatalogFor).toHaveBeenCalledOnce()
    view.rerender(<TeamModelSettingsAction {...actionProps({ sessionId: 'worker-id', addressed: true, team: null })} />)
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(screen.queryByLabelText(zh.model)).toBeNull()
  })

  it('a late old-session response cannot overwrite the new conversation', async () => {
    const old = actionProps()
    const pending = deferred<Awaited<ReturnType<typeof old.api.getSettings>>>()
    vi.mocked(old.api.getSettings).mockReturnValueOnce(pending.promise)
    const view = render(<TeamModelSettingsAction {...old} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    const next = actionProps({ sessionId: 'worker-id', addressed: true })
    view.rerender(<TeamModelSettingsAction {...next} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('region', { name: zh['defaultModel.title'] })
    await act(async () => pending.resolve({ ok: true, value: { ...snapshot(99), defaultModel: { provider: 'bad', model: 'stale' } } }))
    expect(screen.getByRole('button', { name: zh.trigger }).title).toContain('p/old')
    expect(screen.queryByText(/bad\/stale/u)).toBeNull()
  })
})
