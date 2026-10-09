/** Committed RPC snapshots only; this store is not a Session projection. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamModelSelection, TeamModelSettingsView, TeamSelectDefaultModelRequest, TeamSelectMemberModelRequest, TeamSettingsRequest } from '../types.ts'

export interface TeamSettingsApi {
  getSettings(request: TeamSettingsRequest): Promise<RemoteResult<TeamModelSettingsView>>
  selectMemberModel(request: TeamSelectMemberModelRequest): Promise<RemoteResult<TeamModelSettingsView>>
  selectTeamDefaultModel(request: TeamSelectDefaultModelRequest): Promise<RemoteResult<TeamModelSettingsView>>
}
export interface SettingsState {
  view: TeamModelSettingsView | null
  loading: boolean
  saving: boolean
  error: string | null
}

/** One Lead scope, retained across dialog closes, invalidated on UI teardown. */
export class TeamSettingsController {
  readonly store = createSnapshotStore<SettingsState>({ view: null, loading: false, saving: false, error: null })
  private generation = 0
  private request = 0
  private open = false
  private disposed = false
  private loading = false

  constructor(readonly leadSessionId: SessionId, private readonly api: TeamSettingsApi) {}

  activate(): void {
    if (this.disposed) return
    this.open = true
    ++this.generation
    this.loading = false
    this.store.update(state => { state.loading = false; state.saving = false; state.error = null })
    void this.load()
  }

  deactivate(): void {
    this.open = false
    ++this.generation
    ++this.request
    this.loading = false
  }

  dispose(): void {
    this.deactivate()
    this.disposed = true
  }

  async load(): Promise<void> {
    if (!this.open || this.disposed || this.loading || this.store.getSnapshot().saving) return
    const generation = this.generation
    const request = ++this.request
    this.loading = true
    this.store.update(state => { state.loading = true })
    try {
      const response = await this.api.getSettings({ leadSessionId: this.leadSessionId })
      if (!this.valid(generation, request)) return
      if (!response.ok) throw new Error(response.error.message)
      this.commit(response.value)
      this.store.update(state => { state.error = null })
    } catch (error) {
      if (this.valid(generation, request)) this.store.update(state => { state.error = String(error) })
    } finally {
      if (this.valid(generation, request)) {
        this.loading = false
        this.store.update(state => { state.loading = false })
      }
    }
  }

  async save(target: string | null, selection: TeamModelSelection | null): Promise<void> {
    if (!this.open || this.disposed || this.store.getSnapshot().saving) throw new Error('Settings are not editable')
    const generation = this.generation
    // Any pre-save read loses its authority, including a response arriving after failure.
    const request = ++this.request
    this.loading = false
    this.store.update(state => { state.saving = true; state.loading = false; state.error = null })
    try {
      if (target !== null && selection === null) throw new Error('A teammate requires a model')
      const response = target === null
        ? await this.api.selectTeamDefaultModel({ leadSessionId: this.leadSessionId, selection })
        : await this.api.selectMemberModel({ leadSessionId: this.leadSessionId, target, selection: selection! })
      if (!this.valid(generation, request)) return
      if (!response.ok) throw new Error(response.error.message)
      this.commit(response.value)
    } finally {
      if (this.valid(generation, request)) this.store.update(state => { state.saving = false })
    }
  }

  private valid(generation: number, request: number): boolean {
    return this.open && !this.disposed && generation === this.generation && request === this.request
  }

  private commit(view: TeamModelSettingsView): void {
    if (view.teamId !== this.leadSessionId) throw new Error('Settings response belongs to another team')
    // Polls may lag a save response. Revision never moves backwards.
    this.store.update(state => {
      if (state.view === null || view.revision >= state.view.revision) state.view = view
    })
  }
}
