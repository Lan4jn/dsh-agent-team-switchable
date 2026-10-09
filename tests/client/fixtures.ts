/** Minimal test doubles for this plugin's own API, catalog and translation. */
import { vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamModelSettingsView } from '../../src/types.ts'
import type { TeamSettingsApi } from '../../src/client/settings-controller.ts'
import type { TeamModelCatalogState } from '../../src/client/TeamModelEditor.tsx'
import type { TeamModelSummary } from '../../src/client/TeamModelSummary.tsx'
import { zh } from '../../src/client/locales.ts'

export const lead = 'lead' as SessionId
export const t: ComponentProps<typeof TeamModelSummary>['t'] = (key, values) => zh[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values?.[name] ?? placeholder))
export function snapshot(revision = 1): TeamModelSettingsView {
  return { teamId: lead, revision, defaultModel: { provider: 'p', model: 'old' }, members: [
    { id: 'worker-id' as SessionId, name: 'worker', phase: 'active', status: 'running', currentModel: { provider: 'actual', model: 'request-header-model' }, nextModel: { provider: 'p', model: 'new', reasoningEffort: 'high' } },
    { id: 'starting-id' as SessionId, name: 'starting', phase: 'provisioning', status: 'inactive' },
    { id: 'failed-id' as SessionId, name: 'failed', phase: 'failed', status: 'inactive' },
  ] }
}
export function apiFor(view = snapshot()): TeamSettingsApi {
  return {
    getSettings: vi.fn(async () => ({ ok: true as const, value: view })),
    selectMemberModel: vi.fn(async () => ({ ok: true as const, value: view })),
    selectTeamDefaultModel: vi.fn(async () => ({ ok: true as const, value: view })),
  }
}
export function catalogState(): TeamModelCatalogState {
  return { status: 'ready', error: null, failures: [], groups: [{ id: 'p', name: 'Provider', models: [
    { id: 'old', name: 'Old' },
    { id: 'new', name: 'New', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } },
  ] }] }
}
export function catalog() { return createSnapshotStore(catalogState()) }
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
