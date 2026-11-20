import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { registerTeamModelSettingsUi, inject as mountInject } from '../../src/client/mount.ts'
import { NS, zh } from '../../src/client/locales.ts'

vi.mock('dsh-agent-team-switchable/remote', () => ({ default: { namespace: 'own-remote' } }))
import { apply } from '../../src/client/index.ts'

describe('additive contribution ownership', () => {
  it('registers only a new public header slot and own locale namespace', async () => {
    const descriptors: unknown[] = []
    const register = vi.fn((descriptor, component) => { descriptors.push(descriptor); return component })
    const locale = vi.fn()
    const store = {}
    const load = vi.fn(async () => {})
    const select = vi.fn()
    const release = vi.fn()
    const retain = vi.fn(() => ({ ready: Promise.resolve(), release }))
    const ctx = {
      remote: { 'team-model-settings': {} },
      modelDirectories: { directoryFor: vi.fn(() => ({ store, load, select })) },
      sessions: { retain },
      locale: { register: locale },
      effect: (effect: () => unknown) => effect(),
      slots: { inject: vi.fn((_name, effect) => effect()), register },
    }
    registerTeamModelSettingsUi(ctx as unknown as Context)
    expect(mountInject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'modelDirectories', 'sessions'])
    expect(locale).toHaveBeenCalledWith('team-model-settings', expect.objectContaining({ zh }))
    expect(descriptors).toEqual([expect.objectContaining({ id: 'team-model-settings', name: 'conversation.session.header.actions', locale: NS })])
    const actions = (descriptors[0] as { inject: () => { acquireCatalogFor: (id: string, signal: AbortSignal) => Promise<{ directory: unknown; load: () => Promise<unknown>; release: () => void }> } }).inject()
    expect(ctx.modelDirectories.directoryFor).not.toHaveBeenCalled()
    const cancellation = new AbortController()
    const lease = await actions.acquireCatalogFor('lead', cancellation.signal)
    expect(retain).toHaveBeenCalledWith('lead', { source: 'teamModelSettings', signal: cancellation.signal })
    expect(lease.directory).toBe(store)
    await lease.load()
    cancellation.abort()
    lease.release()
    expect(release).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
  })

  it('mounts own remote before injection and disposes UI before remote', async () => {
    const order: string[] = []
    const remoteDispose = vi.fn(async () => { order.push('remote-dispose') })
    const uiDispose = vi.fn(async () => { order.push('ui-dispose') })
    const ui = Object.assign(Promise.resolve(), { dispose: uiDispose })
    let teardown: (() => Promise<void>) | undefined
    const ctx = {
      remote: { $mount: vi.fn(async () => { order.push('remote-mount'); return remoteDispose }) },
      inject: vi.fn((deps: string[]) => { expect(deps).toEqual(['remote.team-model-settings']); order.push('inject'); return ui }),
      effect: (effect: () => () => Promise<void>) => { teardown = effect() },
    }
    await apply(ctx as unknown as Context)
    expect(order).toEqual(['remote-mount', 'inject'])
    await teardown!()
    expect(order).toEqual(['remote-mount', 'inject', 'ui-dispose', 'remote-dispose'])
  })

  it('releases both ownerships when UI injection fails or disposal throws', async () => {
    const remoteDispose = vi.fn(async () => {})
    const uiDispose = vi.fn(async () => { throw new Error('UI dispose failed') })
    const ui = Object.assign(Promise.reject(new Error('missing injection')), { dispose: uiDispose })
    const ctx = { remote: { $mount: async () => remoteDispose }, inject: () => ui, effect: vi.fn() }
    await expect(apply(ctx as unknown as Context)).rejects.toThrow('UI dispose failed')
    expect(uiDispose).toHaveBeenCalledOnce()
    expect(remoteDispose).toHaveBeenCalledOnce()
  })

  it('contains no copied official TeamAction, full panel CSS, or DOM replacement', () => {
    const root = new URL('../../src/client/', import.meta.url)
    expect(existsSync(new URL('TeamAction.tsx', root))).toBe(false)
    expect(existsSync(new URL('TeamAction.module.css', root))).toBe(false)
    const action = readFileSync(new URL('TeamModelSettingsAction.tsx', root), 'utf8')
    const mount = readFileSync(new URL('mount.ts', root), 'utf8')
    expect(action).not.toMatch(/createPortal|querySelector|replaceChild|MutationObserver|TaskCard|openTeammate|agentTeamModels/u)
    expect(mount).not.toMatch(/id: 'agent-team'|remote\['agent-team-models'\]|\.select\(/u)
    expect(NS).toBe('team-model-settings')
    expect(zh).not.toHaveProperty('tasks')
    expect(zh).not.toHaveProperty('owner')
  })
})
