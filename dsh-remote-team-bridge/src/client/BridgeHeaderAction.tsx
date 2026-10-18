import React, { useState } from 'react'
import { BridgePanel } from './BridgePanel.tsx'

export function BridgeHeaderAction(): React.ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          minHeight: '28px',
          padding: '3px 8px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #c2c9d2)',
          fontSize: '12px',
          cursor: 'pointer',
        }}
        aria-label="跨端协作桥"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">🌐</span>
        <span>跨端协作</span>
      </button>

      {open && (
        <BridgePanel
          isListening={true}
          port={19820}
          isLead={true}
          pairedDevices={[]}
          pendingRequests={[]}
          tasks={[]}
          onGenerateCode={() => {}}
          onConfirmPairing={() => {}}
          onRejectPairing={() => {}}
          onRevokeDevice={() => {}}
          onAcceptTask={() => {}}
          onRejectTask={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
