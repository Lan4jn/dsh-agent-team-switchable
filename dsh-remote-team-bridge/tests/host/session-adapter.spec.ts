import { describe, expect, it, vi } from 'vitest'
import {
  BridgeSessionAdapter,
  type BridgeHostApi,
  type BridgeSessionEvent,
} from '../../src/host/session-adapter.ts'

describe('session-adapter (Task 9)', () => {
  it('does not map prompt accepted to in_progress; only turn/start enters in_progress', async () => {
    const mockEvents: BridgeSessionEvent[] = [
      { seq: 1, type: 'session/created', data: {} },
      { seq: 2, type: 'turn/start', data: { turnId: 'turn-1' } },
    ]

    const api: BridgeHostApi = {
      createSession: vi.fn(async () => ({ sessionId: 'sess-1' })),
      prompt: vi.fn(async () => ({ accepted: true as const })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      follow: vi.fn(async function* () {
        for (const ev of mockEvents) yield ev
      }),
      page: vi.fn(async () => mockEvents),
      listTeams: vi.fn(async () => [{ leadSessionId: 'lead-1', name: 'team-alpha' }]),
    }

    const adapter = new BridgeSessionAdapter(api)
    const session = await adapter.initSession({ cwd: '/workspace', preset: 'default' })
    expect(session.sessionId).toBe('sess-1')
    expect(adapter.getExecutionState('sess-1')).toBe('idle')

    const promptResult = await adapter.sendPrompt('sess-1', 'Do something', 'queue')
    expect(promptResult.accepted).toBe(true)
    // prompt accepted does NOT mean in_progress yet!
    expect(adapter.getExecutionState('sess-1')).toBe('accepted')

    // Now advance event stream
    await adapter.consumeNextEvent('sess-1') // seq 1: session/created
    expect(adapter.getExecutionState('sess-1')).toBe('accepted')

    await adapter.consumeNextEvent('sess-1') // seq 2: turn/start
    expect(adapter.getExecutionState('sess-1')).toBe('in_progress')
  })

  it('enters reviewing on turn/end, and cancel does not revert reviewing', async () => {
    const mockEvents: BridgeSessionEvent[] = [
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'turn/end', data: { status: 'completed' } },
    ]

    const api: BridgeHostApi = {
      createSession: vi.fn(async () => ({ sessionId: 'sess-2' })),
      prompt: vi.fn(async () => ({ accepted: true as const })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      follow: vi.fn(async function* () {
        for (const ev of mockEvents) yield ev
      }),
      page: vi.fn(async () => mockEvents),
      listTeams: vi.fn(async () => []),
    }

    const adapter = new BridgeSessionAdapter(api)
    await adapter.initSession({ cwd: '/workspace' })

    await adapter.consumeNextEvent('sess-2') // turn/start
    expect(adapter.getExecutionState('sess-2')).toBe('in_progress')

    await adapter.consumeNextEvent('sess-2') // turn/end
    expect(adapter.getExecutionState('sess-2')).toBe('reviewing')

    // Cancelling while in reviewing does not change execution state away from reviewing
    const cancelRes = await adapter.cancelSession('sess-2')
    expect(cancelRes.cancelled).toBe(true)
    expect(adapter.getExecutionState('sess-2')).toBe('reviewing')
  })

  it('delegates listTeams to host API', async () => {
    const api: BridgeHostApi = {
      createSession: vi.fn(async () => ({ sessionId: 'sess-3' })),
      prompt: vi.fn(async () => ({ accepted: true as const })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      follow: vi.fn(async function* () {}),
      page: vi.fn(async () => []),
      listTeams: vi.fn(async () => [{ leadSessionId: 'lead-99', name: 'dedicated-team' }]),
    }
    const adapter = new BridgeSessionAdapter(api)
    const teams = await adapter.listTeams()
    expect(teams).toEqual([{ leadSessionId: 'lead-99', name: 'dedicated-team' }])
  })
})
