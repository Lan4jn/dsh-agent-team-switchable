import type { BridgeErrorCode, BridgeTaskStatus } from '../protocol/types.ts'

export class BridgeClientError extends Error {
  constructor(message: string, readonly code: BridgeErrorCode | string) {
    super(message)
    this.name = 'BridgeClientError'
  }
}

export function backoffDelay(attempt: number): number {
  const delay = 1_000 * Math.pow(2, attempt)
  return Math.min(delay, 30_000)
}

export interface BridgeClientOptions {
  baseUrl: string
  token?: string
  pinnedFingerprint?: string
  requestTimeoutMs?: number
}

export interface TransportConnector {
  connect(options?: unknown): Promise<{ fingerprintSha256: string }>
}

export interface TransportPoster {
  post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>
}

export function createBridgeClient(options: BridgeClientOptions) {
  let pinnedFingerprint = options.pinnedFingerprint
  const timeoutMs = options.requestTimeoutMs ?? 30_000

  return {
    getPinnedFingerprint() {
      return pinnedFingerprint
    },

    async connect(transport: TransportConnector) {
      const conn = await transport.connect()
      if (pinnedFingerprint) {
        if (conn.fingerprintSha256 !== pinnedFingerprint) {
          throw new BridgeClientError(
            `Certificate fingerprint mismatch: expected ${pinnedFingerprint}, got ${conn.fingerprintSha256}`,
            'FINGERPRINT_MISMATCH',
          )
        }
      } else {
        pinnedFingerprint = conn.fingerprintSha256
      }
      return conn
    },

    async submitTask(
      bridgeTaskId: string,
      payload: unknown,
      transport: TransportPoster,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) {
        throw new BridgeClientError('Operation cancelled before submit', 'ABORTED')
      }

      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BridgeClientError('Submission timed out', 'SUBMIT_TIMEOUT'))
        }, timeoutMs)
        signal?.addEventListener('abort', () => {
          if (timer) clearTimeout(timer)
          reject(new BridgeClientError('Operation cancelled', 'ABORTED'))
        })
      })

      const requestPromise = (async () => {
        try {
          return await transport.post(
            '/bridge',
            { op: 'submit', bridgeTaskId, payload },
            signal,
          )
        } finally {
          if (timer) clearTimeout(timer)
        }
      })()

      return await Promise.race([requestPromise, timeoutPromise])
    },

    async queryTask(
      bridgeTaskId: string,
      transport: TransportPoster,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) {
        throw new BridgeClientError('Operation cancelled', 'ABORTED')
      }
      const res = await transport.post(
        '/bridge',
        { op: 'query', bridgeTaskId },
        signal,
      )
      if (res.status === 404) {
        return {
          status: 'failed' as BridgeTaskStatus,
          errorCode: 'REMOTE_TASK_LOST' as BridgeErrorCode,
          release: true,
        }
      }
      return res.body
    },

    createResumePayload(bridgeTaskId: string, lastAckSeq: number) {
      return {
        op: 'resume_subscription',
        bridgeTaskId,
        lastAckSeq,
        nextSeq: lastAckSeq + 1,
      }
    },
  }
}
