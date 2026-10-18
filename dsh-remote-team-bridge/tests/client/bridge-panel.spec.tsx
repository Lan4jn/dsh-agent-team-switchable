// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import {
  BridgePanel,
  type BridgePanelProps,
  type PairedDevice,
  type PendingPairingRequest,
  type BridgeTaskSummary,
} from '../../src/client/BridgePanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BridgePanel Component (Task 13)', () => {
  const defaultDevices: PairedDevice[] = [
    { deviceId: 'dev-1', hostName: 'Host-Alpha', pairedAt: 1000 },
  ]

  const defaultTasks: BridgeTaskSummary[] = [
    {
      taskId: 'task-101',
      title: 'Build remote feature',
      status: 'reviewing',
      remoteHost: 'Host-Alpha',
    },
  ]

  const createProps = (overrides?: Partial<BridgePanelProps>): BridgePanelProps => ({
    isListening: true,
    port: 19820,
    isLead: true,
    pairedDevices: defaultDevices,
    pendingRequests: [],
    tasks: defaultTasks,
    onGenerateCode: vi.fn(),
    onConfirmPairing: vi.fn(),
    onRejectPairing: vi.fn(),
    onRevokeDevice: vi.fn(),
    onAcceptTask: vi.fn(),
    onRejectTask: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  })

  it('displays listening status and port', () => {
    render(<BridgePanel {...createProps({ isListening: true, port: 19820 })} />)
    expect(screen.getByText(/监听中 \(端口 19820\)/)).toBeTruthy()

    cleanup()
    render(<BridgePanel {...createProps({ isListening: false, port: 19820 })} />)
    expect(screen.getByText(/未开启监听/)).toBeTruthy()
  })

  it('handles 10-minute pairing code countdown and auto-hides upon expiration', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      // expires in 600 seconds
      render(
        <BridgePanel
          {...createProps({
            activePairingCode: {
              code: '839201',
              expiresAt: now + 600_000,
            },
          })}
        />,
      )

      expect(screen.getByText('839201')).toBeTruthy()
      expect(screen.getByText(/剩余时间/)).toBeTruthy()

      // Advance by 599 seconds -> still visible
      act(() => {
        vi.advanceTimersByTime(599_000)
      })
      expect(screen.getByText('839201')).toBeTruthy()

      // Advance past 600s -> code expired/hidden
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(screen.queryByText('839201')).toBeNull()
      expect(screen.getByText(/调用码已过期/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('provides accept-and-remember and reject actions for pending pairing requests', () => {
    const onConfirmPairing = vi.fn()
    const onRejectPairing = vi.fn()
    const pending: PendingPairingRequest[] = [
      { requestId: 'req-1', hostName: 'Host-Beta', requestedAt: Date.now() },
    ]

    render(
      <BridgePanel
        {...createProps({
          pendingRequests: pending,
          onConfirmPairing,
          onRejectPairing,
        })}
      />,
    )

    expect(screen.getByText('Host-Beta')).toBeTruthy()
    const acceptBtn = screen.getByRole('button', { name: '接受并记住' })
    const rejectBtn = screen.getByRole('button', { name: '拒绝' })

    fireEvent.click(acceptBtn)
    expect(onConfirmPairing).toHaveBeenCalledWith('req-1')

    fireEvent.click(rejectBtn)
    expect(onRejectPairing).toHaveBeenCalledWith('req-1')
  })

  it('allows revoking paired devices', () => {
    const onRevokeDevice = vi.fn()
    render(<BridgePanel {...createProps({ onRevokeDevice })} />)

    expect(screen.getByText('Host-Alpha')).toBeTruthy()
    const revokeBtn = screen.getByRole('button', { name: '撤销' })
    fireEvent.click(revokeBtn)
    expect(onRevokeDevice).toHaveBeenCalledWith('dev-1')
  })

  it('restricts task acceptance actions exclusively to the Lead role', () => {
    const onAcceptTask = vi.fn()
    const onRejectTask = vi.fn()

    // Render as Lead -> acceptance buttons enabled
    const { rerender } = render(
      <BridgePanel
        {...createProps({
          isLead: true,
          onAcceptTask,
          onRejectTask,
        })}
      />,
    )

    const acceptBtn = screen.getByRole('button', { name: '验收通过' })
    const rejectBtn = screen.getByRole('button', { name: '驳回重做' })
    expect(acceptBtn.getAttribute('disabled')).toBeNull()
    expect(rejectBtn.getAttribute('disabled')).toBeNull()

    fireEvent.click(acceptBtn)
    expect(onAcceptTask).toHaveBeenCalledWith('task-101')

    fireEvent.click(rejectBtn)
    expect(onRejectTask).toHaveBeenCalledWith('task-101')

    // Rerender as non-Lead -> buttons disabled or view-only note shown
    rerender(
      <BridgePanel
        {...createProps({
          isLead: false,
          onAcceptTask,
          onRejectTask,
        })}
      />,
    )

    const nonLeadAcceptBtn = screen.getByRole('button', { name: '验收通过' })
    const nonLeadRejectBtn = screen.getByRole('button', { name: '驳回重做' })
    expect(nonLeadAcceptBtn.getAttribute('disabled')).toBeDefined()
    expect(nonLeadRejectBtn.getAttribute('disabled')).toBeDefined()
    expect(screen.getByText(/仅发起端 Lead 可执行验收/)).toBeTruthy()
  })
})
