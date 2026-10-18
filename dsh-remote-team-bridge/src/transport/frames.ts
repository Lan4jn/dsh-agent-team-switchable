import type { BridgeEnvelope } from '../protocol/types.ts'

export const MAX_FRAME_BYTES = 4 * 1024 * 1024 // 4 MiB

export class FrameError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'FrameError'
  }
}

export function encodeFrame(envelope: BridgeEnvelope): Buffer {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8')
  if (json.length > MAX_FRAME_BYTES) {
    throw new FrameError(
      `Frame payload exceeds maximum size of ${MAX_FRAME_BYTES} bytes`,
      'FRAME_OVERSIZED',
    )
  }
  const frame = Buffer.allocUnsafe(4 + json.length)
  frame.writeUInt32BE(json.length, 0)
  json.copy(frame, 4)
  return frame
}

export function decodeFrame<T = unknown>(buffer: Buffer): BridgeEnvelope<T> {
  if (buffer.length < 4) {
    throw new FrameError('Buffer too small for frame header', 'FRAME_INCOMPLETE')
  }
  const payloadLength = buffer.readUInt32BE(0)
  if (payloadLength > MAX_FRAME_BYTES) {
    throw new FrameError(
      `Frame length ${payloadLength} exceeds maximum ${MAX_FRAME_BYTES}`,
      'FRAME_OVERSIZED',
    )
  }
  if (buffer.length < 4 + payloadLength) {
    throw new FrameError(
      `Frame buffer length ${buffer.length} is less than expected ${4 + payloadLength}`,
      'FRAME_INCOMPLETE',
    )
  }
  const jsonSlice = buffer.subarray(4, 4 + payloadLength).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonSlice)
  } catch (err) {
    throw new FrameError(`Invalid JSON in frame: ${String(err)}`, 'FRAME_INVALID_JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FrameError('Frame must contain a JSON object', 'FRAME_MALFORMED')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.kind !== 'string') {
    throw new FrameError('Frame envelope missing valid "kind" string', 'FRAME_MALFORMED')
  }
  if (typeof obj.seq !== 'number') {
    throw new FrameError('Frame envelope missing valid "seq" number', 'FRAME_MALFORMED')
  }
  return parsed as BridgeEnvelope<T>
}
