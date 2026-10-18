import { describe, expect, it, vi } from 'vitest'
import {
  BridgeService,
  type BridgeStorage,
  type BridgeTaskRecord,
  type DedicatedTeamRecord,
} from '../../src/bridge-service.ts'

function createInMemoryStorage(): BridgeStorage {
  const tasks = new Map<string, BridgeTaskRecord>()
  const teams = new Map<string, DedicatedTeamRecord>()
  return {
    tasks: {
      get: (k: string) => tasks.get(k),
      put: async (k: string, v: BridgeTaskRecord) => { tasks.set(k, v) },
      update: async (k: string, fn: (cur: BridgeTaskRecord) => BridgeTaskRecord) => {
        const cur = tasks.get(k)
        if (!cur) throw new Error('missing-key')
        const next = fn(cur)
        tasks.set(k, next)
        return next
      },
      list: () => Array.from(tasks.values()),
    },
    teams: {
      get: (k: string) => teams.get(k),
      put: async (k: string, v: DedicatedTeamRecord) => { teams.set(k, v) },
      list: () => Array.from(teams.values()),
    },
  }
}

describe('BridgeService (Task 11)', () => {
  it('times out submitted task after 30s into SUBMIT_TIMEOUT and increments revision', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    const task = await service.createTask({
      taskId: 't-1',
      remoteHost: 'node-b',
      initiatorLeadId: 'lead-local',
      now: 1000,
    })
    expect(task.status).toBe('submitted')
    expect(task.revision).toBe(1)

    // Check at 30s: not timed out yet
    const checked29s = await service.checkTimeout('t-1', 1000 + 30_000)
    expect(checked29s.status).toBe('submitted')

    // Check at 30001ms: times out
    const timedOut = await service.checkTimeout('t-1', 1000 + 30_001)
    expect(timedOut.status).toBe('failed')
    expect(timedOut.errorCode).toBe('SUBMIT_TIMEOUT')
    expect(timedOut.revision).toBe(2)
  })

  it('stalls accepted task after 3 minutes (180s) watchdog into STALLED', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    await service.createTask({ taskId: 't-2', remoteHost: 'node-b', initiatorLeadId: 'lead-local', now: 1000 })
    await service.transitionToAccepted('t-2', 2000)

    const okAt180s = await service.checkTimeout('t-2', 2000 + 180_000)
    expect(okAt180s.status).toBe('accepted')

    const stalled = await service.checkTimeout('t-2', 2000 + 180_001)
    expect(stalled.status).toBe('failed')
    expect(stalled.errorCode).toBe('STALLED')
  })

  it('only allows initiator Lead to accept or reject reviewing task', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    await service.createTask({ taskId: 't-3', remoteHost: 'node-b', initiatorLeadId: 'lead-local', now: 1000 })
    await service.transitionToAccepted('t-3', 1100)
    await service.transitionToInProgress('t-3', 1200)
    await service.transitionToReviewing('t-3', 1300)

    // Non-lead trying to accept
    await expect(
      service.acceptTask('t-3', 'wrong-caller', 1400),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_LEAD_ONLY' })

    // Non-lead trying to reject
    await expect(
      service.rejectTask('t-3', 'wrong-caller', 'needs fix', 1400),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_LEAD_ONLY' })

    // Lead rejects -> returns to in_progress
    const rejected = await service.rejectTask('t-3', 'lead-local', 'needs fix', 1500)
    expect(rejected.status).toBe('in_progress')
    expect(rejected.feedback).toBe('needs fix')

    // Transition back to reviewing
    await service.transitionToReviewing('t-3', 1600)

    // Lead accepts -> completed
    const accepted = await service.acceptTask('t-3', 'lead-local', 1700)
    expect(accepted.status).toBe('completed')
  })

  it('resolves cancel vs reviewing race by deferring to remote (defer-to-remote)', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    await service.createTask({ taskId: 't-4', remoteHost: 'node-b', initiatorLeadId: 'lead-local', now: 1000 })
    await service.transitionToAccepted('t-4', 1100)
    await service.transitionToInProgress('t-4', 1200)
    await service.transitionToReviewing('t-4', 1300)

    // Local cancel attempt when remote is already reviewing -> cancel rejected with defer-to-remote
    const result = await service.requestCancel('t-4', 1400)
    expect(result.cancelled).toBe(false)
    expect(result.reason).toBe('defer-to-remote')
    expect(service.getTask('t-4')?.status).toBe('reviewing')
  })

  it('handles remote 404 by marking REMOTE_TASK_LOST and releasing session reference', async () => {
    const storage = createInMemoryStorage()
    const releaseFn = vi.fn()
    const service = new BridgeService({ storage })

    await service.createTask({
      taskId: 't-5',
      remoteHost: 'node-b',
      initiatorLeadId: 'lead-local',
      now: 1000,
      sessionReference: { release: releaseFn },
    })

    const lost = await service.handleRemoteQuery404('t-5', 2000)
    expect(lost.status).toBe('failed')
    expect(lost.errorCode).toBe('REMOTE_TASK_LOST')
    expect(releaseFn).toHaveBeenCalledOnce()
  })

  it('enforces quota of 5 dedicated teams, returning QUOTA_EXCEEDED on 6th', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage, maxDedicatedTeams: 5 })

    for (let i = 1; i <= 5; i++) {
      const team = await service.allocateDedicatedTeam(`host-${i}`, `task-${i}`)
      expect(team.name).toBeDefined()
    }

    await expect(
      service.allocateDedicatedTeam('host-6', 'task-6'),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('reuses remoteLeadSessionId when binding to an existing team', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    const boundTeam = await service.bindExistingTeam('existing-lead-123')
    expect(boundTeam.remoteLeadSessionId).toBe('existing-lead-123')

    const task1 = await service.createTask({
      taskId: 't-bound-1',
      remoteHost: 'node-x',
      initiatorLeadId: 'lead-local',
      now: 1000,
      boundLeadSessionId: 'existing-lead-123',
    })
    expect(task1.remoteLeadSessionId).toBe('existing-lead-123')

    const task2 = await service.createTask({
      taskId: 't-bound-2',
      remoteHost: 'node-x',
      initiatorLeadId: 'lead-local',
      now: 2000,
      boundLeadSessionId: 'existing-lead-123',
    })
    expect(task2.remoteLeadSessionId).toBe('existing-lead-123')
  })

  it('ensures revision is monotonic and never regresses', async () => {
    const storage = createInMemoryStorage()
    const service = new BridgeService({ storage })

    const t = await service.createTask({ taskId: 't-rev', remoteHost: 'node-b', initiatorLeadId: 'lead-local', now: 1000 })
    expect(t.revision).toBe(1)

    const t2 = await service.transitionToAccepted('t-rev', 1100)
    expect(t2.revision).toBe(2)

    const t3 = await service.transitionToInProgress('t-rev', 1200)
    expect(t3.revision).toBe(3)

    // Cannot set revision backwards
    await expect(
      service.updateTaskDirect('t-rev', { revision: 1 } as any),
    ).rejects.toMatchObject({ code: 'REVISION_REGRESSION_REJECTED' })
  })
})
