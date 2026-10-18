import type { BridgeErrorCode, BridgeTaskStatus } from './types.ts'

const ALLOWED: Readonly<Record<BridgeTaskStatus, readonly BridgeTaskStatus[]>> = {
  submitted: ['accepted', 'failed', 'cancelled'],
  accepted: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['reviewing', 'failed', 'cancelled'],
  reviewing: ['completed', 'in_progress', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: BridgeTaskStatus, to: BridgeTaskStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function submissionVerdict(
  status: BridgeTaskStatus,
  createdAt: number,
  now: number,
): { expired: boolean; errorCode?: BridgeErrorCode } {
  return status === 'submitted' && now - createdAt > 30_000
    ? { expired: true, errorCode: 'SUBMIT_TIMEOUT' }
    : { expired: false }
}

export function acceptedWatchdog(
  status: BridgeTaskStatus,
  updatedAt: number,
  now: number,
): { stalled: boolean } {
  return { stalled: status === 'accepted' && now - updatedAt >= 180_000 }
}

export function cancellationVerdict(status: BridgeTaskStatus): {
  action: 'defer-to-remote' | 'request-cancel' | 'ignore'
} {
  if (status === 'reviewing') return { action: 'defer-to-remote' }
  if (status === 'in_progress' || status === 'accepted' || status === 'submitted') {
    return { action: 'request-cancel' }
  }
  return { action: 'ignore' }
}

export function remoteQueryVerdict(view: { status: BridgeTaskStatus } | null): {
  status: BridgeTaskStatus
  errorCode?: BridgeErrorCode
  release: boolean
} {
  return view === null
    ? { status: 'failed', errorCode: 'REMOTE_TASK_LOST', release: true }
    : { status: view.status, release: false }
}

export function idempotencyKey(bridgeTaskId: string, attempt: number): string {
  return `${bridgeTaskId}:${attempt}`
}
