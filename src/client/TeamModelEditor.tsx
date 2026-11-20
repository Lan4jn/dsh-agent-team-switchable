/** Inline member model form over the shared read-only model catalog store. */
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
  disabled?: boolean
  isLocked?: () => boolean
  initial?: ModelSelection | null
  save: (selection: ModelSelection) => Promise<void>
  t: TranslateNS<typeof NS>
}

const sameSelection = (
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean =>
  a == null || b == null
    ? a == null && b == null
    : a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

const selectionWithEffort = (
  provider: string,
  model: string,
  effort: string,
): ModelSelection => ({
  provider,
  model,
  ...(effort === '' ? {} : { reasoningEffort: effort }),
})

/** Member autosave editor with retry and next-turn semantics. */
export function TeamModelEditor(props: TeamModelEditorProps) {
  const { directory, initial, t } = props

  const toRoute = (selection: ModelSelection | null | undefined): string =>
    selection == null ? '' : JSON.stringify([selection.provider, selection.model])

  const toEffort = (selection: ModelSelection | null | undefined): string =>
    selection?.reasoningEffort ?? ''

  const mounted = useRef(true)
  const requestSeq = useRef(0)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const statusRef = useRef(status)
  statusRef.current = status

  const [route, setRoute] = useState(() => toRoute(initial))
  const [effort, setEffort] = useState(() => toEffort(initial))
  const [error, setError] = useState<string | null>(null)

  const savingRef = useRef(false)
  const lastAttemptRef = useRef<ModelSelection | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++requestSeq.current
    }
  }, [])

  const liveCatalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const frozenCatalog = useRef(liveCatalog)
  const catalog = status === 'saving' ? frozenCatalog.current : liveCatalog

  const prevInitialRef = useRef(initial)
  useEffect(() => {
    const prev = prevInitialRef.current
    prevInitialRef.current = initial
    if (savingRef.current || statusRef.current === 'failed') return
    if (!sameSelection(prev, initial)) {
      setRoute(toRoute(initial))
      setEffort(toEffort(initial))
      setStatus('idle')
      setError(null)
    }
  }, [initial])

  const options = catalog.groups.flatMap(group => group.models.map(model => ({
    key: JSON.stringify([group.id, model.id]), group, model,
  })))
  const selected = options.find(option => option.key === route)
  const retainedRoute = route === '' ? null : JSON.parse(route) as [string, string]
  const loading = catalog.status === 'idle' || catalog.status === 'loading'

  const isEffortInvalid = selected !== undefined && effort !== '' && (
    selected.model.reasoning === undefined ||
    !selected.model.reasoning.efforts.some(item => item.id === effort)
  )

  const locked = Boolean(props.disabled || (props.isLocked?.() ?? false))
  const isSaving = status === 'saving' || savingRef.current
  const selectDisabled = locked || isSaving || options.length === 0
  const reasoningDisabled = locked || isSaving

  const canRetry = (): boolean => {
    const target = lastAttemptRef.current
    if (target === undefined) return false
    const opt = options.find(o => o.group.id === target.provider && o.model.id === target.model)
    if (opt === undefined) return false
    if (target.reasoningEffort !== undefined && (opt.model.reasoning === undefined || !opt.model.reasoning.efforts.some(e => e.id === target.reasoningEffort))) {
      return false
    }
    return true
  }

  const executeSubmit = async (selection: ModelSelection): Promise<void> => {
    if (props.disabled || (props.isLocked?.() ?? false) || savingRef.current) return
    lastAttemptRef.current = selection
    frozenCatalog.current = liveCatalog
    const reqId = ++requestSeq.current
    savingRef.current = true
    setStatus('saving')
    setError(null)

    try {
      await props.save(selection)
      if (!mounted.current || reqId !== requestSeq.current) return
      savingRef.current = false
      setStatus('saved')
      setError(null)
    } catch (reason) {
      if (!mounted.current || reqId !== requestSeq.current) return
      savingRef.current = false
      setStatus('failed')
      setError(String(reason))
    }
  }

  const handleModelChange = (newRoute: string, target?: HTMLSelectElement) => {
    if (props.disabled || (props.isLocked?.() ?? false) || savingRef.current) {
      if (target) target.value = route
      return
    }
    if (newRoute === route) return

    const nextOption = options.find(opt => opt.key === newRoute)
    if (nextOption === undefined) {
      if (target) target.value = route
      return
    }

    setRoute(newRoute)
    setEffort('')
    void executeSubmit(selectionWithEffort(nextOption.group.id, nextOption.model.id, ''))
  }

  const handleEffortChange = (newEffort: string, target?: HTMLSelectElement) => {
    if (props.disabled || (props.isLocked?.() ?? false) || savingRef.current) {
      if (target) target.value = effort
      return
    }
    if (newEffort === effort) return
    if (selected === undefined) {
      if (target) target.value = effort
      return
    }

    if (newEffort !== '' && (selected.model.reasoning === undefined || !selected.model.reasoning.efforts.some(e => e.id === newEffort))) {
      if (target) target.value = effort
      return
    }

    setEffort(newEffort)
    void executeSubmit(selectionWithEffort(selected.group.id, selected.model.id, newEffort))
  }

  const handleRetry = () => {
    if (props.disabled || (props.isLocked?.() ?? false) || savingRef.current) return
    if (!canRetry()) return
    void executeSubmit(lastAttemptRef.current!)
  }

  return (
    <div className={css.modelEditor}>
      <p>{t('model.nextTurnHint')}</p>
      {loading && <p role="status">{t('model.loading')}</p>}
      {!loading && options.length === 0 && <p role="status">{t('model.unavailable')}</p>}
      {catalog.error !== null && <p className={css.error} role="alert">{catalog.error}</p>}
      {catalog.failures.map(failure => <p key={failure.id} className={css.warning}>{failure.name}: {failure.message}</p>)}
      <label>{t('model')}
        <select aria-label={t('model')} disabled={selectDisabled} value={route} onChange={event => {
          handleModelChange(event.target.value, event.target)
        }}>
          <option value="">{t('model.choose')}</option>
          {route !== '' && selected === undefined && <option value={route}>{retainedRoute?.join('/')} · {t('model.unavailable')}</option>}
          {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
            {options.filter(option => option.group.id === group.id).map(option => <option key={option.key} value={option.key}>{option.model.name}</option>)}
          </optgroup>)}
        </select>
      </label>
      {(selected?.model.reasoning !== undefined || isEffortInvalid) && (
        <label>{t('model.reasoning')}
          <select aria-label={t('model.reasoning')} disabled={reasoningDisabled} value={effort} onChange={event => {
            handleEffortChange(event.target.value, event.target)
          }}>
            <option value="">{t('model.defaultReasoning')}</option>
            {isEffortInvalid && (
              <option value={effort}>{effort} · {t('model.unavailable')}</option>
            )}
            {selected?.model.reasoning?.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      {status === 'saving' && <p role="status" className={css.savePending}>{t('model.saving')}</p>}
      {status === 'saved' && <p role="status">{t('model.saved')}</p>}
      {status === 'failed' && error !== null && (
        <div role="alert" className={css.error}>
          <span>{error}</span>
          <button type="button" disabled={selectDisabled || !canRetry()} onClick={handleRetry}>{t('retry')}</button>
        </div>
      )}
    </div>
  )
}
