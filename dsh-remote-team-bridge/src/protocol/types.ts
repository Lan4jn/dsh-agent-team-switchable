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
  | 'REMOTE_TASK_LOST'
  | 'QUOTA_EXCEEDED'
  | 'UNAUTHORIZED'
  | 'PAIRING_BLOCKED'
  | 'TARGET_UNAVAILABLE'
  | 'FINGERPRINT_MISMATCH'
  | 'DIGEST_MISMATCH'

export interface BridgeTaskView {
  readonly bridgeTaskId: string
  readonly status: BridgeTaskStatus
  readonly remoteLeadSessionId?: string
  readonly lastAckSeq: number
  readonly updatedAt: number
  readonly errorCode?: BridgeErrorCode
}

export interface PairingCodeRecord {
  code: string
  expiresAt: number
  failures: number
  blockedUntil: number
}

export interface PairingVerdict {
  ok: boolean
  blockedUntil: number
}

export type CodeRandom = (size: number) => Uint8Array

export interface BridgeEnvelope<T = unknown> {
  kind: string
  seq: number
  body: T
}
