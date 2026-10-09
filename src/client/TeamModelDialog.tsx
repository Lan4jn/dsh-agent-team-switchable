/** A plugin-owned settings layer; keyboard/focus ownership stays with DSH Modal. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TeamModelEditor, type TeamModelCatalogState, type TeamModelDirectory } from './TeamModelEditor.tsx'
import { NS } from './locales.ts'
import css from './TeamAction.module.css'

export type TeamModelDialogProps = {
  directory?: TeamModelDirectory | undefined
  onClose: () => void
  t: TranslateNS<typeof NS>
} & (
  | {
      mode?: 'member'
      name: string
      initial: ModelSelection | null
      save: (selection: ModelSelection) => Promise<void>
    }
  | {
      mode: 'default'
      name?: never
      initial: ModelSelection | null
      save: (selection: ModelSelection | null) => Promise<void>
    }
)

export function TeamModelDialog(props: TeamModelDialogProps) {
  const { directory, onClose, t } = props
  const mode = props.mode ?? 'member'
  const isDefault = mode === 'default'
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [saving, setSaving] = useState(false)
  const requestClose = (): void => { if (!saving) onClose() }
  const title = isDefault ? t('defaultModel.title') : t('model.settings', { name: props.name })

  const fallbackDirectory = useMemo(() => createSnapshotStore<TeamModelCatalogState>({
    groups: [],
    status: 'unavailable',
    error: null,
    failures: [],
  }), [])

  const effectiveDirectory = isDefault ? (directory ?? fallbackDirectory) : directory

  return (
    <Modal open headless title={title} onClose={requestClose} className={css.modelDialog ?? ''}>
      <div className={css.modelDialogHeader}>
        <h2>{title}</h2>
        <button type="button" className={css.modelDialogClose} disabled={saving} aria-label={t('model.close')} onClick={requestClose}>
          <IconCloseOutlineRegular size={16} />
        </button>
      </div>
      {saving && <p className={css.savePending} role="status">{t('model.savePending')}</p>}
      {effectiveDirectory === undefined
        ? <div className={css.modelEditor}>
            <p role="status">{t('model.unavailable')}</p>
            <div className={css.modelButtons}><button type="button" onClick={requestClose}>{t('model.cancel')}</button></div>
          </div>
        : (props.mode === 'default' ? (
            <TeamModelEditor
              mode="default"
              directory={effectiveDirectory}
              initial={props.initial}
              save={async selection => {
                setSaving(true)
                try { await props.save(selection) }
                finally { if (mounted.current) setSaving(false) }
              }}
              cancel={onClose}
              t={t}
            />
          ) : (
            <TeamModelEditor
              mode="member"
              directory={effectiveDirectory}
              initial={props.initial}
              save={async selection => {
                setSaving(true)
                try { await props.save(selection) }
                finally { if (mounted.current) setSaving(false) }
              }}
              cancel={onClose}
              t={t}
            />
          ))}
    </Modal>
  )
}
