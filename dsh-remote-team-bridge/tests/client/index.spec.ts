import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../../src/client/index.ts'

describe('client entry and slot registration', () => {
  it('declares slots dependency in inject', () => {
    expect(inject).toContain('slots')
  })

  it('registers remote-team-bridge action in conversation.session.header.actions via ctx.inject', () => {
    const descriptors: any[] = []
    const register = vi.fn((descriptor, component) => {
      descriptors.push(descriptor)
      return component
    })

    const scopedCtx = {
      slots: {
        inject: vi.fn((slotName: string, cb: () => void) => cb()),
        register,
      },
    }

    const ctx = {
      inject: vi.fn((deps: string[], cb: (scoped: any) => void) => {
        expect(deps).toEqual(inject)
        cb(scopedCtx)
      }),
    }

    apply(ctx as any)

    expect(ctx.inject).toHaveBeenCalled()
    expect(scopedCtx.slots.inject).toHaveBeenCalledWith(
      'conversation.session.header.actions',
      expect.any(Function),
    )
    expect(descriptors).toEqual([
      expect.objectContaining({
        id: 'remote-team-bridge',
        name: 'conversation.session.header.actions',
      }),
    ])
  })
})
