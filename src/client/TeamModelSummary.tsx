/** Compact, lossless display of current and team-local next-turn routes. */
import { useId, useState } from 'react'
import type { TeamModelSelection as ModelSelection } from '../types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

function sameRoute(current: ModelSelection, next: ModelSelection): boolean {
  return current.provider === next.provider && current.model === next.model
    && current.reasoningEffort === next.reasoningEffort
}

function ModelRoute({ selection, label, t }: {
  selection: ModelSelection
  label?: string | undefined
  t: TranslateNS<typeof NS>
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  return (
    <div className={css.modelRoute}>
      <div className={css.modelLine}>
        {label !== undefined && <span className={css.modelLabel}>{label}</span>}
        <button
          type="button"
          className={css.modelName}
          aria-label={`${label === undefined ? '' : `${label} · `}${t(expanded ? 'model.collapseDetails' : 'model.expandDetails', { model: `${selection.provider}/${selection.model}` })}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => { setExpanded(value => !value) }}
        >{selection.model}</button>
        <span className={css.modelBadge} title={selection.provider}>{selection.provider}</span>
        {selection.reasoningEffort !== undefined && <span className={css.modelBadge}>{selection.reasoningEffort}</span>}
      </div>
      {expanded && <div id={detailsId} className={css.modelDetails}>
        <code>{selection.provider}/{selection.model}</code>
        {selection.reasoningEffort !== undefined && <span>{t('model.reasoning')}: {selection.reasoningEffort}</span>}
      </div>}
    </div>
  )
}

/** Compare all three fields without guessing adapter defaults or unknown current values. */
export function TeamModelSummary({ current, next, t }: {
  current?: ModelSelection | null | undefined
  next?: ModelSelection | null | undefined
  t: TranslateNS<typeof NS>
}) {
  const different = current != null && next != null && !sameRoute(current, next)
  if (current == null && next == null) return null
  return (
    <div className={css.modelSummary}>
      {current != null && <ModelRoute selection={current} label={t('model.current')} t={t} />}
      {next != null && (current == null || different) && <ModelRoute selection={next} label={t('model.next')} t={t} />}
      {different && <p className={css.nextTurnHint}>{t('model.pendingHint')}</p>}
    </div>
  )
}
