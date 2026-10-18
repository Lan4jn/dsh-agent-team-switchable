export class BridgeServiceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'BridgeServiceError'
  }
}

export type BridgeTaskStatus =
  | 'submitted'
  | 'accepted'
  | 'in_progress'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BridgeErrorCode =
  | 'SUBMIT_TIMEOUT'
  | 'STALLED'
  | 'REMOTE_TASK_LOST'
  | 'QUOTA_EXCEEDED'
  | 'UNAUTHORIZED_LEAD_ONLY'
  | 'REVISION_REGRESSION_REJECTED'
  | 'INVALID_TRANSITION'

export interface SessionReferenceLike {
  release: () => void
}

export interface BridgeTaskRecord {
  readonly taskId: string
  readonly remoteHost: string
  readonly initiatorLeadId: string
  readonly status: BridgeTaskStatus
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly remoteLeadSessionId?: string
  readonly errorCode?: BridgeErrorCode
  readonly feedback?: string
}

export interface DedicatedTeamRecord {
  readonly teamId: string
  readonly name: string
  readonly hostId: string
  readonly createdAt: number
}

export interface BoundTeamRecord {
  readonly remoteLeadSessionId: string
  readonly boundAt: number
}

export interface BridgeStorage {
  tasks: {
    get: (key: string) => BridgeTaskRecord | undefined
    put: (key: string, val: BridgeTaskRecord) => Promise<void>
    update: (key: string, fn: (cur: BridgeTaskRecord) => BridgeTaskRecord) => Promise<BridgeTaskRecord>
    list: () => BridgeTaskRecord[]
  }
  teams: {
    get: (key: string) => DedicatedTeamRecord | undefined
    put: (key: string, val: DedicatedTeamRecord) => Promise<void>
    list: () => DedicatedTeamRecord[]
  }
}

export interface BridgeServiceOptions {
  storage: BridgeStorage
  maxDedicatedTeams?: number
}

export class BridgeService {
  private readonly storage: BridgeStorage
  private readonly maxDedicatedTeams: number
  private readonly sessionRefs = new Map<string, SessionReferenceLike>()

  constructor(opts: BridgeServiceOptions) {
    this.storage = opts.storage
    this.maxDedicatedTeams = opts.maxDedicatedTeams ?? 5
  }

  async createTask(input: {
    taskId: string
    remoteHost: string
    initiatorLeadId: string
    now: number
    boundLeadSessionId?: string
    sessionReference?: SessionReferenceLike
  }): Promise<BridgeTaskRecord> {
    if (input.sessionReference) {
      this.sessionRefs.set(input.taskId, input.sessionReference)
    }

    const record: BridgeTaskRecord = {
      taskId: input.taskId,
      remoteHost: input.remoteHost,
      initiatorLeadId: input.initiatorLeadId,
      status: 'submitted',
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      remoteLeadSessionId: input.boundLeadSessionId,
    }

    await this.storage.tasks.put(input.taskId, record)
    return record
  }

  getTask(taskId: string): BridgeTaskRecord | undefined {
    return this.storage.tasks.get(taskId)
  }

  private releaseSessionRef(taskId: string): void {
    const ref = this.sessionRefs.get(taskId)
    if (ref) {
      try {
        ref.release()
      } finally {
        this.sessionRefs.delete(taskId)
      }
    }
  }

  async checkTimeout(taskId: string, now: number): Promise<BridgeTaskRecord> {
    return this.storage.tasks.update(taskId, cur => {
      if (cur.status === 'submitted') {
        if (now - cur.updatedAt > 30_000) {
          this.releaseSessionRef(taskId)
          return {
            ...cur,
            status: 'failed',
            errorCode: 'SUBMIT_TIMEOUT',
            revision: cur.revision + 1,
            updatedAt: now,
          }
        }
      } else if (cur.status === 'accepted') {
        if (now - cur.updatedAt > 180_000) {
          this.releaseSessionRef(taskId)
          return {
            ...cur,
            status: 'failed',
            errorCode: 'STALLED',
            revision: cur.revision + 1,
            updatedAt: now,
          }
        }
      }
      return cur
    })
  }

  async transitionToAccepted(taskId: string, now: number): Promise<BridgeTaskRecord> {
    return this.storage.tasks.update(taskId, cur => {
      if (cur.status !== 'submitted') {
        throw new BridgeServiceError(`Cannot accept task in status ${cur.status}`, 'INVALID_TRANSITION')
      }
      return {
        ...cur,
        status: 'accepted',
        revision: cur.revision + 1,
        updatedAt: now,
      }
    })
  }

  async transitionToInProgress(taskId: string, now: number): Promise<BridgeTaskRecord> {
    return this.storage.tasks.update(taskId, cur => {
      return {
        ...cur,
        status: 'in_progress',
        revision: cur.revision + 1,
        updatedAt: now,
      }
    })
  }

  async transitionToReviewing(taskId: string, now: number): Promise<BridgeTaskRecord> {
    return this.storage.tasks.update(taskId, cur => {
      return {
        ...cur,
        status: 'reviewing',
        revision: cur.revision + 1,
        updatedAt: now,
      }
    })
  }

  async acceptTask(taskId: string, callerId: string, now: number): Promise<BridgeTaskRecord> {
    const cur = this.storage.tasks.get(taskId)
    if (!cur) throw new BridgeServiceError(`Task not found: ${taskId}`, 'NOT_FOUND')

    if (callerId !== cur.initiatorLeadId) {
      throw new BridgeServiceError(
        `Only initiator Lead (${cur.initiatorLeadId}) can accept task`,
        'UNAUTHORIZED_LEAD_ONLY',
      )
    }

    if (cur.status !== 'reviewing') {
      throw new BridgeServiceError(`Task ${taskId} is not in reviewing state`, 'INVALID_TRANSITION')
    }

    this.releaseSessionRef(taskId)
    return this.storage.tasks.update(taskId, latest => ({
      ...latest,
      status: 'completed',
      revision: latest.revision + 1,
      updatedAt: now,
    }))
  }

  async rejectTask(
    taskId: string,
    callerId: string,
    feedback: string,
    now: number,
  ): Promise<BridgeTaskRecord> {
    const cur = this.storage.tasks.get(taskId)
    if (!cur) throw new BridgeServiceError(`Task not found: ${taskId}`, 'NOT_FOUND')

    if (callerId !== cur.initiatorLeadId) {
      throw new BridgeServiceError(
        `Only initiator Lead (${cur.initiatorLeadId}) can reject task`,
        'UNAUTHORIZED_LEAD_ONLY',
      )
    }

    if (cur.status !== 'reviewing') {
      throw new BridgeServiceError(`Task ${taskId} is not in reviewing state`, 'INVALID_TRANSITION')
    }

    return this.storage.tasks.update(taskId, latest => ({
      ...latest,
      status: 'in_progress',
      feedback,
      revision: latest.revision + 1,
      updatedAt: now,
    }))
  }

  async requestCancel(
    taskId: string,
    now: number,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    const cur = this.storage.tasks.get(taskId)
    if (!cur) return { cancelled: false, reason: 'not-found' }

    if (cur.status === 'reviewing' || cur.status === 'completed') {
      // Invariant: cancel vs reviewing race defers to remote
      return { cancelled: false, reason: 'defer-to-remote' }
    }

    this.releaseSessionRef(taskId)
    await this.storage.tasks.update(taskId, latest => ({
      ...latest,
      status: 'cancelled',
      revision: latest.revision + 1,
      updatedAt: now,
    }))

    return { cancelled: true }
  }

  async handleRemoteQuery404(taskId: string, now: number): Promise<BridgeTaskRecord> {
    this.releaseSessionRef(taskId)
    return this.storage.tasks.update(taskId, cur => ({
      ...cur,
      status: 'failed',
      errorCode: 'REMOTE_TASK_LOST',
      revision: cur.revision + 1,
      updatedAt: now,
    }))
  }

  async allocateDedicatedTeam(
    hostId: string,
    taskSlug: string,
  ): Promise<DedicatedTeamRecord> {
    const existingTeams = this.storage.teams.list()
    if (existingTeams.length >= this.maxDedicatedTeams) {
      throw new BridgeServiceError(
        `Max dedicated teams quota (${this.maxDedicatedTeams}) exceeded`,
        'QUOTA_EXCEEDED',
      )
    }

    const teamId = `team-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
    const record: DedicatedTeamRecord = {
      teamId,
      name: `${hostId}-${taskSlug}`.slice(0, 32),
      hostId,
      createdAt: Date.now(),
    }

    await this.storage.teams.put(teamId, record)
    return record
  }

  async bindExistingTeam(remoteLeadSessionId: string): Promise<BoundTeamRecord> {
    return {
      remoteLeadSessionId,
      boundAt: Date.now(),
    }
  }

  async updateTaskDirect(taskId: string, updates: Partial<BridgeTaskRecord>): Promise<BridgeTaskRecord> {
    return this.storage.tasks.update(taskId, cur => {
      if (updates.revision !== undefined && updates.revision <= cur.revision) {
        throw new BridgeServiceError(
          `Revision regression rejected: ${updates.revision} <= ${cur.revision}`,
          'REVISION_REGRESSION_REJECTED',
        )
      }
      return {
        ...cur,
        ...updates,
      }
    })
  }
}
