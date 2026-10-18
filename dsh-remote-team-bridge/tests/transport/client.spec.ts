import { describe, expect, it, vi } from 'vitest'
import {
  createBridgeClient,
  backoffDelay,
  BridgeClientError,
} from '../../src/transport/client.ts'

describe('bridge client transport and resilience', () => {
  it('calculates exponential backoff capped at 30 seconds', () => {
    expect(backoffDelay(0)).toBe(1_000)
    expect(backoffDelay(1)).toBe(2_000)
    expect(backoffDelay(2)).toBe(4_000)
    expect(backoffDelay(3)).toBe(8_000)
    expect(backoffDelay(4)).toBe(16_000)
    expect(backoffDelay(5)).toBe(30_000)
    expect(backoffDelay(10)).toBe(30_000)
  })

  it('refuses a changed certificate fingerprint', async () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
      pinnedFingerprint: 'a'.repeat(64),
    })

    const fakeTransport = {
      connect: vi.fn(async () => ({
        fingerprintSha256: 'b'.repeat(64),
      })),
    }

    await expect(client.connect(fakeTransport)).rejects.toMatchObject({
      code: 'FINGERPRINT_MISMATCH',
    })
  })

  it('accepts and pins fingerprint on initial connection when not yet pinned', async () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
    })

    const fakeTransport = {
      connect: vi.fn(async () => ({
        fingerprintSha256: 'c'.repeat(64),
      })),
    }

    const res = await client.connect(fakeTransport)
    expect(res.fingerprintSha256).toBe('c'.repeat(64))
    expect(client.getPinnedFingerprint()).toBe('c'.repeat(64))
  })

  it('times out submission after 30 seconds', async () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
      pinnedFingerprint: 'a'.repeat(64),
      requestTimeoutMs: 50, // fast timeout in test
    })

    const fakeTransport = {
      post: vi.fn(
        (): Promise<{ status: number; body: unknown }> =>
          new Promise(resolve => {
            setTimeout(() => resolve({ status: 200, body: {} }), 200)
          }),
      ),
    }

    await expect(
      client.submitTask('task-1', { prompt: 'do work' }, fakeTransport),
    ).rejects.toMatchObject({
      code: 'SUBMIT_TIMEOUT',
    })
  })

  it('returns REMOTE_TASK_LOST when query returns 404', async () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
      pinnedFingerprint: 'a'.repeat(64),
    })

    const fakeTransport = {
      post: vi.fn(async () => ({
        status: 404,
        body: null,
      })),
    }

    const result = await client.queryTask('task-missing', fakeTransport)
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'REMOTE_TASK_LOST',
      release: true,
    })
  })

  it('creates resume subscription frame with lastAckSeq + 1', () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
    })

    const resumePayload = client.createResumePayload('task-1', 42)
    expect(resumePayload).toEqual({
      op: 'resume_subscription',
      bridgeTaskId: 'task-1',
      lastAckSeq: 42,
      nextSeq: 43,
    })
  })

  it('honors AbortSignal and does not retry writes when cancelled', async () => {
    const client = createBridgeClient({
      baseUrl: 'https://127.0.0.1:19820',
    })

    const controller = new AbortController()
    controller.abort()

    const fakeTransport = {
      post: vi.fn(async () => ({ status: 200, body: {} })),
    }

    await expect(
      client.submitTask('task-1', { prompt: 'do work' }, fakeTransport, controller.signal),
    ).rejects.toThrow()
    expect(fakeTransport.post).not.toHaveBeenCalled()
  })
})
