import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

export interface BridgeSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

export interface BridgeHostApi {
  createSession(input: { cwd: string; preset?: string }): Promise<{ sessionId: string }>
  prompt(sessionId: string, content: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }>
  cancel(sessionId: string): Promise<{ cancelled: boolean }>
  follow(sessionId: string, afterSeq: number): AsyncIterable<BridgeSessionEvent>
  page(sessionId: string, afterSeq: number): Promise<BridgeSessionEvent[]>
  listTeams(): Promise<Array<{ leadSessionId: string; name: string }>>
}

export type AdapterExecutionState =
  | 'idle'
  | 'accepted'
  | 'in_progress'
  | 'reviewing'
  | 'cancelled'

export class BridgeSessionAdapter {
  private readonly states = new Map<string, AdapterExecutionState>()
  private readonly iterators = new Map<string, AsyncIterator<BridgeSessionEvent>>()
  private readonly lastSeqs = new Map<string, number>()

  constructor(private readonly api: BridgeHostApi) {}

  async initSession(input: { cwd: string; preset?: string }): Promise<{ sessionId: string }> {
    const res = await this.api.createSession(input)
    this.states.set(res.sessionId, 'idle')
    this.lastSeqs.set(res.sessionId, 0)
    return res
  }

  getExecutionState(sessionId: string): AdapterExecutionState {
    return this.states.get(sessionId) ?? 'idle'
  }

  getLastSeq(sessionId: string): number {
    return this.lastSeqs.get(sessionId) ?? 0
  }

  async sendPrompt(
    sessionId: string,
    content: string,
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<{ accepted: true }> {
    const res = await this.api.prompt(sessionId, content, mode)
    // Invariant: accepted does not equal in_progress!
    if (this.states.get(sessionId) !== 'reviewing') {
      this.states.set(sessionId, 'accepted')
    }
    return res
  }

  async cancelSession(sessionId: string): Promise<{ cancelled: boolean }> {
    const res = await this.api.cancel(sessionId)
    const current = this.states.get(sessionId)
    // Invariant: cancel does not affect reviewing
    if (current !== 'reviewing') {
      this.states.set(sessionId, 'cancelled')
    }
    return res
  }

  async consumeNextEvent(sessionId: string): Promise<BridgeSessionEvent | null> {
    let iter = this.iterators.get(sessionId)
    if (!iter) {
      const lastSeq = this.lastSeqs.get(sessionId) ?? 0
      const iterable = this.api.follow(sessionId, lastSeq)
      iter = iterable[Symbol.asyncIterator]()
      this.iterators.set(sessionId, iter)
    }

    const { value, done } = await iter.next()
    if (done || !value) return null

    this.lastSeqs.set(sessionId, value.seq)

    // State transitions based on authoritative session events
    if (value.type === 'turn/start') {
      this.states.set(sessionId, 'in_progress')
    } else if (value.type === 'turn/end') {
      this.states.set(sessionId, 'reviewing')
    }

    return value
  }

  async pageEvents(sessionId: string, afterSeq: number): Promise<BridgeSessionEvent[]> {
    return this.api.page(sessionId, afterSeq)
  }

  async listTeams(): Promise<Array<{ leadSessionId: string; name: string }>> {
    return this.api.listTeams()
  }
}
