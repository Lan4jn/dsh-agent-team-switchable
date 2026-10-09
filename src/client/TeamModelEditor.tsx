/** Inline model form over the existing read-only model catalog store. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup, ModelCatalogFailure } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TeamModelSelection as ModelSelection } from '../types.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

/** Read-only face of the shared model directory; selection remains team-local. */
export interface TeamModelCatalogState {
  groups: readonly ModelProviderGroup[]
  status: string
  error: string | null
  failures: readonly ModelCatalogFailure[]
}
export type TeamModelDirectory = ObservableSnapshot<TeamModelCatalogState>

export type TeamModelEditorProps = {
  directory: TeamModelDirectory
  cancel: () => void
  t: TranslateNS<typeof NS>
} & (
  | {
      mode?: 'member'
      initial?: ModelSelection | null
      save: (selection: ModelSelection) => Promise<void>
    }
  | {
      mode: 'default'
      initial?: ModelSelection | null
      save: (selection: ModelSelection | null) => Promise<void>
    }
)

/** Model editor with explicit save/cancel and next-turn semantics. */
export function TeamModelEditor(props: TeamModelEditorProps) {
  const { directory, initial, cancel, t } = props
  const mode = props.mode ?? 'member'
  const isDefault = mode === 'default'
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const liveCatalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const frozenCatalog = useRef(liveCatalog)
  const [route, setRoute] = useState(
    initial == null
      ? (isDefault ? '__inherit__' : '')
      : JSON.stringify([initial.provider, initial.model]),
  )
  const [effort, setEffort] = useState(initial?.reasoningEffort ?? '')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const catalog = saving ? frozenCatalog.current : liveCatalog
  const [error, setError] = useState<string | null>(null)
  const options = catalog.groups.flatMap(group => group.models.map(model => ({
    key: JSON.stringify([group.id, model.id]), group, model,
  })))
  const selected = options.find(option => option.key === route)
  const isInherit = isDefault && route === '__inherit__'
  const retainedRoute = route === '' || route === '__inherit__' ? null : JSON.parse(route) as [string, string]
  const loading = catalog.status === 'idle' || catalog.status === 'loading'
  const submit = async (): Promise<void> => {
    if (savingRef.current) return
    frozenCatalog.current = liveCatalog
    if (isInherit) {
      if (props.mode !== 'default') return
      savingRef.current = true
      setSaving(true)
      setError(null)
      try {
        await props.save(null)
        if (mounted.current) cancel()
      } catch (reason) {
        if (!mounted.current) return
        setError(String(reason))
        savingRef.current = false
        setSaving(false)
      }
      return
    }
    if (selected === undefined || isEffortInvalid) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await props.save({ provider: selected.group.id, model: selected.model.id, ...(effort === '' ? {} : { reasoningEffort: effort }) })
      if (mounted.current) cancel()
    } catch (reason) {
      if (!mounted.current) return
      setError(String(reason))
      savingRef.current = false
      setSaving(false)
    }
  }
  const isEffortInvalid = selected !== undefined && effort !== '' && (
    selected.model.reasoning === undefined ||
    !selected.model.reasoning.efforts.some(item => item.id === effort)
  )
  const saveDisabled = saving || isEffortInvalid || (isDefault ? (!isInherit && selected === undefined) : selected === undefined)
  const selectDisabled = saving || (!isDefault && options.length === 0)

  return (
    <div className={css.modelEditor}>
      <p>{t(isDefault ? 'defaultModel.hint' : 'model.nextTurnHint')}</p>
      {loading && <p role="status">{t('model.loading')}</p>}
      {!loading && options.length === 0 && <p role="status">{t('model.unavailable')}</p>}
      {catalog.error !== null && <p className={css.error} role="alert">{catalog.error}</p>}
      {catalog.failures.map(failure => <p key={failure.id} className={css.warning}>{failure.name}: {failure.message}</p>)}
      <label>{t('model')}
        <select aria-label={t('model')} disabled={selectDisabled} value={route} onChange={event => {
          const key = event.target.value
          setRoute(key)
          setEffort('')
        }}>
          {isDefault
            ? <option value="__inherit__">{t('defaultModel.inherit')}</option>
            : <option value="">{t('model.choose')}</option>}
          {route !== '' && route !== '__inherit__' && selected === undefined && <option value={route}>{retainedRoute?.join('/')} · {t('model.unavailable')}</option>}
          {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
            {options.filter(option => option.group.id === group.id).map(option => <option key={option.key} value={option.key}>{option.model.name}</option>)}
          </optgroup>)}
        </select>
      </label>
      {isInherit ? (
        <label>{t('model.reasoning')}
          <select aria-label={t('model.reasoning')} disabled value="">
            <option value="">{t('defaultModel.inheritReasoning')}</option>
          </select>
        </label>
      ) : (
        (selected?.model.reasoning !== undefined || isEffortInvalid) && (
          <label>{t('model.reasoning')}
            <select aria-label={t('model.reasoning')} disabled={saving} value={effort} onChange={event => { setEffort(event.target.value) }}>
              <option value="">{t('model.defaultReasoning')}</option>
              {isEffortInvalid && (
                <option value={effort}>{effort} · {t('model.unavailable')}</option>
              )}
              {selected?.model.reasoning?.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )
      )}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.modelButtons}>
        <button type="button" disabled={saving} onClick={cancel}>{t('model.cancel')}</button>
        <button type="button" disabled={saveDisabled} onClick={() => { void submit() }}>{t(saving ? 'model.saving' : 'model.save')}</button>
      </div>
    </div>
  )
}
