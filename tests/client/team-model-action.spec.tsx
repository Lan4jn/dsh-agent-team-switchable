// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    modelDirectoryFor: vi.fn(() => directory),
    loadCatalogFor: vi.fn(async () => {}),
    useSession: (selector: (value: unknown) => unknown) => selector(options.addressed ? { subagent: { address: { parentSessionId: lead } } } : {}),
    useSessions: (selector: (value: unknown) => unknown) => selector({ projectionsBySession: { [lead]: { values: team === null ? {} : { agentTeam: team } } } }),
  } as unknown as TeamModelSettingsProps
}

describe('pure additive header action', () => {
  it('hides without an official team projection and for an addressed non-Team session', () => {
    const view = render(<TeamModelSettingsAction {...actionProps({ team: null })} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<TeamModelSettingsAction {...actionProps({ sessionId: 'non-team', addressed: true })} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<TeamModelSettingsAction {...actionProps({ sessionId: 'starting-id', addressed: true })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('loads only the Lead catalog and leaves an existing official header/panel node untouched', async () => {
    const props = actionProps({ sessionId: 'worker-id', addressed: true })
    render(<><button data-official-team>官方团队按钮</button><aside data-official-panel>官方任务面板</aside><TeamModelSettingsAction {...props} /></>)
    const officialButton = screen.getByText('官方团队按钮')
    const officialPanel = screen.getByText('官方任务面板')
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByLabelText(zh.target)
    expect(props.modelDirectoryFor).toHaveBeenCalledWith(lead)
    expect(props.loadCatalogFor).toHaveBeenCalledWith(lead)
    expect(screen.getByText('官方团队按钮')).toBe(officialButton)
    expect(screen.getByText('官方任务面板')).toBe(officialPanel)
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('官方任务面板')).toBe(officialPanel)
  })

  it('header summary stays committed on save failure and same-Lead reopen ignores draft inputs', async () => {
    const props = actionProps()
    vi.mocked(props.api.selectTeamDefaultModel).mockRejectedValueOnce(new Error('failed'))
    render(<TeamModelSettingsAction {...props} />)
    const button = screen.getByRole('button', { name: zh.trigger })
    fireEvent.click(button)
    await screen.findByLabelText(zh.target)
    expect(button.title).toContain('p/old')
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: JSON.stringify(['p', 'new']) } })
    fireEvent.click(screen.getByRole('button', { name: zh['model.save'] }))
    await screen.findByText('Error: failed')
    expect(button.title).toContain('p/old')
    fireEvent.click(screen.getByRole('button', { name: zh['model.close'] }))
    fireEvent.click(button)
    expect((screen.getByLabelText(zh.model) as HTMLSelectElement).value).toBe(JSON.stringify(['p', 'old']))
    await waitFor(() => expect(props.api.getSettings).toHaveBeenCalledTimes(2))
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
    await screen.findByLabelText(zh.target)
    await act(async () => pending.resolve({ ok: true, value: { ...snapshot(99), defaultModel: { provider: 'bad', model: 'stale' } } }))
    expect(screen.getByRole('button', { name: zh.trigger }).title).toContain('p/old')
    expect(screen.queryByText(/bad\/stale/u)).toBeNull()
  })
})
