import React, { useEffect, useState } from 'react'
import css from './BridgePanel.module.css'

export interface PairedDevice {
  readonly deviceId: string
  readonly hostName: string
  readonly pairedAt: number
}

export interface PendingPairingRequest {
  readonly requestId: string
  readonly hostName: string
  readonly requestedAt: number
}

export interface BridgeTaskSummary {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly remoteHost: string
}

export interface PairingCodeInfo {
  readonly code: string
  readonly expiresAt: number
}

export interface BridgePanelProps {
  readonly isListening: boolean
  readonly port: number
  readonly isLead: boolean
  readonly activePairingCode?: PairingCodeInfo
  readonly pairedDevices: readonly PairedDevice[]
  readonly pendingRequests: readonly PendingPairingRequest[]
  readonly tasks: readonly BridgeTaskSummary[]
  readonly onGenerateCode: () => void
  readonly onConfirmPairing: (requestId: string) => void
  readonly onRejectPairing: (requestId: string) => void
  readonly onRevokeDevice: (deviceId: string) => void
  readonly onAcceptTask: (taskId: string) => void
  readonly onRejectTask: (taskId: string) => void
  readonly onClose: () => void
}

export function BridgePanel(props: BridgePanelProps): React.ReactElement {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!props.activePairingCode) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [props.activePairingCode])

  const remainingSeconds = props.activePairingCode
    ? Math.max(0, Math.floor((props.activePairingCode.expiresAt - now) / 1000))
    : 0

  const isExpired = props.activePairingCode ? remainingSeconds <= 0 : true

  return (
    <div className={css.panel} role="dialog" aria-label="跨 DSH 团队协作桥">
      <div className={css.header}>
        <h2>跨 DSH 团队协作桥</h2>
        <button
          type="button"
          className={css.closeButton}
          aria-label="关闭面板"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>

      <div className={css.section}>
        <div className={css.sectionTitle}>监听状态</div>
        <div className={css.statusRow}>
          <span>
            {props.isListening ? `监听中 (端口 ${props.port})` : '未开启监听'}
          </span>
          <button
            type="button"
            className={css.btnSecondary}
            onClick={props.onGenerateCode}
          >
            生成 6 位调用码
          </button>
        </div>

        {props.activePairingCode && (
          <div className={css.codeBox}>
            {!isExpired ? (
              <>
                <div className={css.codeNumber}>{props.activePairingCode.code}</div>
                <div className={css.countdown}>
                  剩余时间: {Math.floor(remainingSeconds / 60)} 分 {remainingSeconds % 60} 秒
                </div>
              </>
            ) : (
              <div className={css.expired}>调用码已过期，请重新生成</div>
            )}
          </div>
        )}
      </div>

      {props.pendingRequests.length > 0 && (
        <div className={css.section}>
          <div className={css.sectionTitle}>待确认配对请求</div>
          {props.pendingRequests.map(req => (
            <div key={req.requestId} className={css.deviceItem}>
              <div>
                <strong>{req.hostName}</strong>
                <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginLeft: '6px' }}>
                  ({new Date(req.requestedAt).toLocaleTimeString()})
                </span>
              </div>
              <div className={css.buttonGroup}>
                <button
                  type="button"
                  className={css.btnPrimary}
                  onClick={() => props.onConfirmPairing(req.requestId)}
                >
                  接受并记住
                </button>
                <button
                  type="button"
                  className={css.btnDanger}
                  onClick={() => props.onRejectPairing(req.requestId)}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={css.section}>
        <div className={css.sectionTitle}>已配对设备 ({props.pairedDevices.length})</div>
        {props.pairedDevices.length === 0 ? (
          <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>暂无已配对设备</div>
        ) : (
          props.pairedDevices.map(dev => (
            <div key={dev.deviceId} className={css.deviceItem}>
              <span>{dev.hostName}</span>
              <button
                type="button"
                className={css.btnDanger}
                onClick={() => props.onRevokeDevice(dev.deviceId)}
              >
                撤销
              </button>
            </div>
          ))
        )}
      </div>

      <div className={css.section}>
        <div className={css.sectionTitle}>协作任务列表</div>
        {props.tasks.length === 0 ? (
          <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>暂无任务</div>
        ) : (
          props.tasks.map(task => (
            <div key={task.taskId} className={css.taskItem}>
              <div>
                <div><strong>{task.title}</strong></div>
                <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  状态: {task.status} | 来源: {task.remoteHost}
                </div>
              </div>
              {task.status === 'reviewing' && (
                <div className={css.buttonGroup}>
                  <button
                    type="button"
                    className={css.btnPrimary}
                    disabled={!props.isLead}
                    onClick={() => props.onAcceptTask(task.taskId)}
                  >
                    验收通过
                  </button>
                  <button
                    type="button"
                    className={css.btnDanger}
                    disabled={!props.isLead}
                    onClick={() => props.onRejectTask(task.taskId)}
                  >
                    驳回重做
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        {!props.isLead && (
          <div className={css.leadOnlyHint}>
            提示: 仅发起端 Lead 可执行验收通过或驳回操作。
          </div>
        )}
      </div>
    </div>
  )
}
