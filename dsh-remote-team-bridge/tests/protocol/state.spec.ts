import { describe, expect, it } from 'vitest'
import {
  canTransition,
  cancellationVerdict,
  submissionVerdict,
  acceptedWatchdog,
  remoteQueryVerdict,
  idempotencyKey,
} from '../../src/protocol/state.ts'

describe('task state machine and watchdog', () => {
  it('never treats accepted as finished', () => {
    expect(canTransition('accepted', 'completed')).toBe(false)
    expect(canTransition('reviewing', 'completed')).toBe(true)
  })

  it('times out a submission after thirty seconds', () => {
    expect(submissionVerdict('submitted', 0, 30_000)).toMatchObject({ expired: false })
    expect(submissionVerdict('submitted', 0, 30_001)).toMatchObject({ expired: true, errorCode: 'SUBMIT_TIMEOUT' })
  })

  it('flags an accepted task with no progress after three minutes', () => {
    expect(acceptedWatchdog('accepted', 1_000, 181_000).stalled).toBe(true)
    expect(acceptedWatchdog('in_progress', 1_000, 181_000).stalled).toBe(false)
  })

  it('lets a remote delivery win a cancel race', () => {
    expect(cancellationVerdict('reviewing')).toEqual({ action: 'defer-to-remote' })
    expect(cancellationVerdict('in_progress')).toEqual({ action: 'request-cancel' })
    expect(cancellationVerdict('completed')).toEqual({ action: 'ignore' })
  })

  it('treats a missing remote task as a released failure', () => {
    expect(remoteQueryVerdict(null)).toEqual({ status: 'failed', errorCode: 'REMOTE_TASK_LOST', release: true })
    expect(remoteQueryVerdict({ status: 'in_progress' })).toEqual({ status: 'in_progress', release: false })
  })

  it('generates consistent idempotency keys', () => {
    expect(idempotencyKey('task-1', 1)).toBe('task-1:1')
    expect(idempotencyKey('task-1', 2)).toBe('task-1:2')
  })
})
