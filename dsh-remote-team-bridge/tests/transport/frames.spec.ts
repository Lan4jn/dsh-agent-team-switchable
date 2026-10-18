import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  decodeFrame,
  FrameError,
  MAX_FRAME_BYTES,
} from '../../src/transport/frames.ts'

describe('frame encoding and decoding', () => {
  it('round-trips one envelope', () => {
    const frame = encodeFrame({ kind: 'ping', seq: 7, body: { at: 1 } })
    expect(decodeFrame(frame)).toEqual({ kind: 'ping', seq: 7, body: { at: 1 } })
  })

  it('rejects oversized and malformed frames', () => {
    // Length prefix specifies > MAX_FRAME_BYTES
    const oversizedHeader = Buffer.alloc(4)
    oversizedHeader.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => decodeFrame(oversizedHeader)).toThrow(FrameError)

    // Incomplete buffer or corrupted JSON
    expect(() => decodeFrame(Buffer.from([0, 0, 0, 1, 0x78]))).toThrow(FrameError) // 'x' not json
    expect(() => decodeFrame(Buffer.from([0, 0, 0, 0, 1]))).toThrow(FrameError)
    expect(() => decodeFrame(Buffer.from([0, 1]))).toThrow(FrameError)
  })

  it('rejects frames without valid kind or seq', () => {
    const invalidKind = Buffer.from(JSON.stringify({ seq: 1, body: {} }), 'utf8')
    const frame1 = Buffer.alloc(4 + invalidKind.length)
    frame1.writeUInt32BE(invalidKind.length, 0)
    invalidKind.copy(frame1, 4)
    expect(() => decodeFrame(frame1)).toThrow(FrameError)

    const invalidSeq = Buffer.from(JSON.stringify({ kind: 'test', body: {} }), 'utf8')
    const frame2 = Buffer.alloc(4 + invalidSeq.length)
    frame2.writeUInt32BE(invalidSeq.length, 0)
    invalidSeq.copy(frame2, 4)
    expect(() => decodeFrame(frame2)).toThrow(FrameError)
  })
})
