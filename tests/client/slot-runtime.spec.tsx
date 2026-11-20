// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Context, Service } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { publishedClient } from './real-sdk-runtime.ts'
import { apiFor, catalog, deferred, lead, t } from './fixtures.ts'
import { zh } from '../../src/client/locales.ts'

// Use exact exported SDK icon implementations rather than primitives.tsx.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('./real-sdk-runtime.ts')).publishedIcons())
vi.mock('dsh-agent-team-switchable/remote', () => ({ default: { namespace: 'team-model-settings', descriptors: [] } }))
import { registerTeamModelSettingsUi } from '../../src/client/mount.ts'
import { apply as clientApply, inject as clientInject } from '../../src/client/index.ts'

const key = 'conversation.session.header.actions'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function runtime() {
  const ctx = new Context()
  const renderer = publishedClient('@deepseek-ai/dsh-client-ui-renderer')
  renderer.apply(ctx)
  const slots = ctx.slots
  const session = createSnapshotStore({ subagent: { address: { parentSessionId: lead } } })
  const projections = createSnapshotStore({ projectionsBySession: { [lead]: { values: { agentTeam: { members: [
    { id: lead, name: 'Lead', role: 'lead', phase: 'active' },
    { id: 'worker-id', name: 'worker', role: 'teammate', phase: 'active' },
  ] } } } } })
  const binding = { key: 'worker-id', ctx: ctx.extend(), hooks: { session }, keyedHooks: {}, props: { sessionId: 'worker-id' } }
  const scope = createSnapshotStore(binding)
  slots.installScope('session', { current: scope, bindingSource: () => scope, renderArea: () => null })
  slots.provideRoot({ hooks: { sessions: projections } })
  const locale = createSnapshotStore({ revision: 0 })
  slots.installLocale({ ...locale, bind: () => t })
  slots.register({ name: 'root', children: { [key]: { kind: 'list', scope: 'session' } } }, ({ renderSlot }: any) => renderSlot(key, {}))
  const errors = vi.fn()
  slots.onEntryError(errors)
  return { ctx, slots, errors, session, projections, scope }
}

function modelResolver(sessions: unknown, directory = catalog()) {
  const modelSdk = publishedClient('@deepseek-ai/dsh-client-ui-model-selection')
  const binding = {}
  const resident = { store: directory, load: vi.fn(async () => {}) }
  const face = { ctx: { sessions }, live: { directories: new Map([[binding, resident]]) } }
  return {
    binding,
    resident,
    directoryFor: (id: string) => modelSdk.ModelDirectoryResolver.prototype.directoryFor.call(face, id),
  }
}

function actionsOf(slots: any) { return slots.snapshot(key)[0].occupants }

describe('published SDK Slot integration (not selector/primitive stubs)', () => {
  it('proves the old render-time missing-Lead scope retires a list entry', async () => {
    const { slots, errors } = runtime()
    const resolver = modelResolver({ scope: () => undefined, binding: () => undefined })
    slots.register({ name: key, id: 'old-unsafe-path' }, () => { resolver.directoryFor(lead); return null })
    expect(actionsOf(slots)[0].active).toBe(true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const expectedCrash = (event: ErrorEvent): void => {
      if (String(event.error).includes('resolved no scope')) event.preventDefault()
    }
    window.addEventListener('error', expectedCrash)
    try { render(slots.renderSlot('root', {})) } finally { window.removeEventListener('error', expectedCrash) }
    await waitFor(() => expect(actionsOf(slots)[0].active).toBe(false))
    expect(slots.entries(key)).toHaveLength(1)
    expect(slots.entriesOfSlot(key)).toHaveLength(0)
    expect(errors).toHaveBeenCalledOnce()
    expect(String(errors.mock.calls[0]?.[2])).toContain('resolved no scope')
    expect(errors.mock.calls[0]?.[3]).toEqual({ abdicated: true })
    expect(log).toHaveBeenCalled()
  })

  it('reacts to real observable projection Hooks without confusing eligibility with abdication', async () => {
    const { ctx, slots, errors, projections } = runtime()
    ctx.reflect.provide('sessions', { retain: vi.fn() })
    ctx.reflect.provide('modelDirectories', { directoryFor: vi.fn() })
    ctx.reflect.provide('remote', { 'team-model-settings': apiFor() })
    ctx.reflect.provide('locale', { register: vi.fn(() => () => {}) })
    registerTeamModelSettingsUi(ctx)
    render(slots.renderSlot('root', {}))
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
    await act(async () => projections.update(state => { state.projectionsBySession[lead]!.values.agentTeam.members[1]!.phase = 'failed' }))
    expect(screen.queryByRole('button', { name: zh.trigger })).toBeNull()
    expect(actionsOf(slots)[0].active).toBe(true)
    await act(async () => projections.update(state => { state.projectionsBySession[lead]!.values.agentTeam.members[1]!.phase = 'active' }))
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
    expect(errors).not.toHaveBeenCalled()
  })

  it('keeps the real Slot live across directory/RPC/catalog errors, retries and releases the retained Lead', async () => {
    const { ctx, slots, errors } = runtime()
    const api = apiFor()
    vi.mocked(api.getSettings).mockRejectedValueOnce(new Error('RPC offline'))
    let retained = false
    const ready = deferred<unknown>()
    const release = vi.fn(() => { retained = false })
    const sessions: any = { scope: () => retained ? ctx : undefined, binding: () => retained ? resolver.binding : undefined,
      retain: vi.fn(() => ({ ready: ready.promise, release })) }
    const resolver = modelResolver(sessions)
    const directoryFor = vi.fn(resolver.directoryFor)
    directoryFor.mockImplementationOnce(() => { throw new Error('directory unavailable') })
    resolver.resident.load.mockRejectedValueOnce(new Error('catalog offline'))
    ctx.reflect.provide('sessions', sessions)
    ctx.reflect.provide('modelDirectories', { directoryFor })
    ctx.reflect.provide('remote', { 'team-model-settings': api })
    ctx.reflect.provide('locale', { register: vi.fn(() => () => {}) })
    registerTeamModelSettingsUi(ctx)
    render(slots.renderSlot('root', {}))
    const trigger = screen.getByRole('button', { name: zh.trigger })
    expect(trigger.querySelector('svg path')).toBeTruthy()
    expect(sessions.retain).not.toHaveBeenCalled()
    expect(directoryFor).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    expect(sessions.retain).toHaveBeenCalledWith(lead, expect.objectContaining({ source: 'teamModelSettings' }))
    expect(directoryFor).not.toHaveBeenCalled()
    await act(async () => { retained = true; ready.resolve({}) })
    await screen.findByText('Error: directory unavailable')
    await screen.findByText('Error: RPC offline')
    expect(release).toHaveBeenCalledOnce()
    expect(actionsOf(slots)[0].active).toBe(true)
    expect(errors).not.toHaveBeenCalled()
    // Retry both local acquisition and RPC independently.
    fireEvent.click(screen.getAllByRole('button', { name: zh.retry })[0]!)
    const defaults = await screen.findByRole('region', { name: zh['defaultModel.title'] })
    sessions.retain.mockImplementationOnce(() => { retained = true; return { ready: Promise.resolve({}), release } })
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByText('Error: catalog offline')
    expect(errors).not.toHaveBeenCalled()
    expect(actionsOf(slots)[0].active).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => expect(screen.queryByText('Error: catalog offline')).toBeNull())
    expect(resolver.resident.load).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('region', { name: zh['bulk.title'] })).getByLabelText(zh['bulk.model'])).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(release).toHaveBeenCalledTimes(2)
    expect(actionsOf(slots)[0].active).toBe(true)
    expect(errors).not.toHaveBeenCalled()
  })

  it('cold directory creation on teammate session verifies remote.session injection', async () => {
    const root = new Context()
    const modelSdk = publishedClient('@deepseek-ai/dsh-client-ui-model-selection')

    const mockCatalog = {
      default: { provider: 'provider-a', model: 'model-a' },
      groups: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: [{ id: 'model-a', name: 'Model A' }],
        },
      ],
      status: 'ready',
      error: null,
      failures: [],
    }
    const sessionRemote = { modelCatalog: vi.fn(async () => ({ ok: true, value: mockCatalog })) }
    await root.plugin({
      name: 'api-session-controller',
      apply(sessionCtx) {
        sessionCtx.reflect.provide('remote.session', sessionRemote)
      },
    })

    class TestRemoteService extends Service {
      constructor(ctx: any) {
        super(ctx, 'remote')
      }
      $on = vi.fn(() => () => {})
      $mount = vi.fn(async () => async () => {})
      'team-model-settings' = apiFor()
    }
    new TestRemoteService(root)

    root.reflect.provide('remote.team-model-settings', apiFor())

    const modelSelectionStore = createSnapshotStore({})
    const sessionBindings = new Map<string, any>()
    const releaseSpies: ReturnType<typeof vi.fn>[] = []
    const sessions = {
      scope: vi.fn(() => root.extend()),
      binding: vi.fn((id: string) => {
        let binding = sessionBindings.get(id)
        if (!binding) {
          binding = {
            session: {
              projections: { faceOf: () => modelSelectionStore },
              getSnapshot: () => ({ blank: false }),
            },
          }
          sessionBindings.set(id, binding)
        }
        return binding
      }),
      subagentAddress: vi.fn(() => undefined),
      retain: vi.fn(() => {
        const release = vi.fn()
        releaseSpies.push(release)
        return { ready: Promise.resolve(), release }
      }),
    }
    root.reflect.provide('sessions', sessions)
    root.reflect.provide('locale', { register: vi.fn(() => () => {}), bind: vi.fn(() => t) })
    new modelSdk.ModelDirectoryResolver(root)

    let registeredAction: any
    root.reflect.provide('slots', {
      inject: (_name: string, fn: () => void) => fn(),
      register: (descriptor: any) => { registeredAction = descriptor },
    })

    const pluginFiber = root.plugin({
      name: 'test-team-switchable-plugin',
      inject: clientInject,
      apply: clientApply,
    })
    await pluginFiber

    const actions = registeredAction.inject()
    const cancellation = new AbortController()

    // 1. Cold path: constructs new directory using remote.session and loads live catalog groups
    const lease1 = await actions.acquireCatalogFor('teammate-cold-session', cancellation.signal)
    expect(lease1.directory).toBeTruthy()
    await lease1.load()
    expect(lease1.directory.getSnapshot().groups).toEqual(mockCatalog.groups)
    expect(lease1.directory.getSnapshot().current).toEqual(mockCatalog.default)
    expect(sessionRemote.modelCatalog).toHaveBeenCalled()

    // 2. Cached path: reuses existing directory from live.directories
    const lease2 = await actions.acquireCatalogFor('teammate-cold-session', cancellation.signal)
    expect(lease2.directory).toBe(lease1.directory)

    // 3. Release cleanup & abort cancellation
    lease1.release()
    expect(releaseSpies[0]).toHaveBeenCalledOnce()
    lease2.release()
    expect(releaseSpies[1]).toHaveBeenCalledOnce()

    const abortedCtrl = new AbortController()
    abortedCtrl.abort()
    await expect(actions.acquireCatalogFor('aborted-session', abortedCtrl.signal))
      .rejects.toThrow('Catalog acquisition cancelled')
    expect(releaseSpies.at(-1)).toHaveBeenCalledOnce()

    // 4. Negative regression counterexample: a plugin context omitting remote.session reproduces the exact failure
    const restrictedFiber = root.plugin({
      name: 'restricted-test-plugin-missing-session',
      inject: clientInject.filter(k => k !== 'remote.session'),
      apply(restrictedCtx) {
        registerTeamModelSettingsUi(restrictedCtx)
      },
    })
    await restrictedFiber
    const restrictedActions = registeredAction.inject()
    await expect(restrictedActions.acquireCatalogFor('other-cold-session', new AbortController().signal))
      .rejects.toThrow('cannot get property "remote.session" without inject')

    // 5. Clean up fibers
    await pluginFiber.dispose()
    await restrictedFiber.dispose()
  })
})
