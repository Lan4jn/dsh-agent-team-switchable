/** Bulk draft picker: a controlled draft that never saves by itself. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamModelSelection } from '../types.ts'
import type { TeamModelDirectory } from './TeamModelEditor.tsx'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

export interface BulkModelPickerProps {
  directory: TeamModelDirectory
  disabled: boolean
  /** Display-only initial from the committed view; never an RPC acknowledgement. */
  initial: TeamModelSelection | null
  onChange: (selection: TeamModelSelection | null) => void
  t: TranslateNS<typeof NS>
}

export function BulkModelPicker({ directory, disabled, initial, onChange, t }: BulkModelPickerProps) {
  const catalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const [route, setRoute] = useState('')
  const [effort, setEffort] = useState('')
  const [invalidated, setInvalidated] = useState(false)
  // Only an untouched draft follows the view; a hand-edited or retired draft is the user's.
  const pristine = useRef(true)
  const options = catalog.groups.flatMap(group => group.models.map(model => ({
    key: JSON.stringify([group.id, model.id]), group, model,
  })))
  const selected = options.find(option => option.key === route)

  const emit = (nextRoute: string, nextEffort: string): void => {
    const option = options.find(item => item.key === nextRoute)
    if (option === undefined) { onChange(null); return }
    onChange({ provider: option.group.id, model: option.model.id, ...(nextEffort === '' ? {} : { reasoningEffort: nextEffort }) })
  }
  // A catalog refresh can retire the drafted route or its effort: clear the draft and ask again
  // instead of submitting (or silently downgrading) a stale choice.
  const routeRetired = route !== '' && selected === undefined
  const effortRetired = route !== '' && selected !== undefined && effort !== ''
    && !(selected.model.reasoning?.efforts.some(item => item.id === effort) ?? false)
  useEffect(() => {
    if (!routeRetired && !effortRetired) return
    pristine.current = false
    setRoute('')
    setEffort('')
    setInvalidated(true)
    onChange(null)
  }, [routeRetired, effortRetired, onChange])

  const initialRoute = initial === null ? '' : JSON.stringify([initial.provider, initial.model])
  const initialEffort = initial?.reasoningEffort ?? ''
  useEffect(() => {
    if (!pristine.current) return
    if (route === initialRoute && effort === initialEffort) return
    setRoute(initialRoute)
    setEffort(initialEffort)
    setInvalidated(false)
  }, [initialRoute, initialEffort, route, effort])

  const changeModel = (value: string): void => {
    pristine.current = false
    setInvalidated(false)
    setRoute(value)
    setEffort('')
    emit(value, '')
  }
  const changeEffort = (value: string): void => {
    pristine.current = false
    setInvalidated(false)
    if (value !== '' && (selected?.model.reasoning === undefined || !selected.model.reasoning.efforts.some(item => item.id === value))) return
    setEffort(value)
    emit(route, value)
  }

  return <div className={css.bulkPicker}>
    {invalidated && <p role="status" className={css.bulkHint}>{t('bulk.reselect')}</p>}
    <label>{t('bulk.model')}
      <select aria-label={t('bulk.model')} disabled={disabled} value={route} onChange={event => { changeModel(event.target.value) }}>
        <option value="">{t('bulk.choose')}</option>
        {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
          {options.filter(option => option.group.id === group.id).map(option => <option key={option.key} value={option.key}>{option.model.name}</option>)}
        </optgroup>)}
      </select>
    </label>
    {selected?.model.reasoning !== undefined && (
      <label>{t('model.reasoning')}
        <select aria-label={t('model.reasoning')} disabled={disabled} value={effort} onChange={event => { changeEffort(event.target.value) }}>
          <option value="">{t('model.defaultReasoning')}</option>
          {selected.model.reasoning.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
    )}
  </div>
}
