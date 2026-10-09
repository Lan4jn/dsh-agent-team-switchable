/** One plugin-owned dialog for defaults and teammates, not an official Team panel. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TeamModelEditor, type TeamModelDirectory } from './TeamModelEditor.tsx'
import { TeamModelSummary } from './TeamModelSummary.tsx'
import { TeamSettingsController } from './settings-controller.ts'
import type { TeamModelSettingsView } from '../types.ts'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

export interface TeamModelDialogProps {
  controller: TeamSettingsController
  directory: TeamModelDirectory
  /** Official projection eligibility, never a synthetic model projection. */
  activeNames: readonly string[]
  loadCatalog: () => Promise<unknown>
  onClose: () => void
  t: TranslateNS<typeof NS>
}

export function TeamModelDialog({ controller, directory, activeNames, loadCatalog, onClose, t }: TeamModelDialogProps) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot)
  const [target, setTarget] = useState<string | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const mounted = useRef(false)
  const catalogRequest = useRef(0)
  const frozenNames = useRef(activeNames)
  const availableNames = state.saving ? frozenNames.current : activeNames
  const view = state.view
  const member = target === null ? undefined : view?.members.find(item => item.name === target)
  const canEditMember = member?.phase === 'active' && availableNames.includes(member.name)

  const refreshCatalog = (): void => {
    const request = ++catalogRequest.current
    setCatalogError(null)
    void loadCatalog().catch(error => {
      if (mounted.current && request === catalogRequest.current) setCatalogError(String(error))
    })
  }

  useEffect(() => {
    mounted.current = true
    controller.activate()
    refreshCatalog()
    const timer = setInterval(() => { void controller.load() }, 1000)
    return () => {
      mounted.current = false
      ++catalogRequest.current
      clearInterval(timer)
      controller.deactivate()
    }
  }, [controller])

  useEffect(() => {
    if (!state.saving && target !== null && !canEditMember) {
      setTarget(null)
      setEditorVersion(version => version + 1)
    }
  }, [state.saving, target, canEditMember])

  const resetEditor = (): void => { if (mounted.current) setEditorVersion(version => version + 1) }
  const save = async (selection: Parameters<TeamSettingsController['save']>[1]): Promise<void> => {
    frozenNames.current = activeNames
    await controller.save(target, selection)
  }
  const requestClose = (): void => { if (!controller.store.getSnapshot().saving) onClose() }
  const defaultSummary = (value: TeamModelSettingsView): string => value.defaultModel === null
    ? t('defaultModel.inherit')
    : `${value.defaultModel.provider}/${value.defaultModel.model}${value.defaultModel.reasoningEffort === undefined ? '' : ` · ${value.defaultModel.reasoningEffort}`}`

  return (
    <Modal open headless title={t('trigger')} onClose={requestClose} className={css.modelDialog ?? ''}>
      <div className={css.modelDialogHeader}>
        <h2>{t('trigger')}</h2>
        <button type="button" className={css.modelDialogClose} disabled={state.saving} aria-label={t('model.close')} onClick={requestClose}>
          <IconCloseOutlineRegular size={16} />
        </button>
      </div>
      {state.loading && view === null && <p role="status">{t('loading')}</p>}
      {state.error !== null && <div role="alert" className={css.error}>{state.error}
        <button type="button" disabled={state.saving} onClick={() => { void controller.load() }}>{t('retry')}</button>
      </div>}
      {catalogError !== null && <div role="alert" className={css.error}>{catalogError}
        <button type="button" disabled={state.saving} onClick={refreshCatalog}>{t('retry')}</button>
      </div>}
      {state.saving && <p className={css.savePending} role="status">{t('model.savePending')}</p>}
      {view !== null && <>
        <p data-committed-default>{t('defaultModel.summary', { summary: defaultSummary(view) })}</p>
        <label className={css.target}>{t('target')}
          <select aria-label={t('target')} disabled={state.saving} value={target === null ? 'default' : `member:${target}`} onChange={event => {
            setTarget(event.target.value === 'default' ? null : event.target.value.slice(7))
            setEditorVersion(version => version + 1)
          }}>
            <option value="default">{t('defaultModel.title')}</option>
            {view.members.map(item => <option key={item.id} value={`member:${item.name}`} disabled={item.phase !== 'active' || !availableNames.includes(item.name)}>{item.name}</option>)}
          </select>
        </label>
        {target === null
          ? <TeamModelEditor key={`default:${editorVersion}`} mode="default" directory={directory} initial={view.defaultModel} save={save} cancel={resetEditor} t={t} />
          : canEditMember && <TeamModelEditor key={`member:${target}:${editorVersion}`} mode="member" directory={directory} initial={member?.nextModel ?? member?.currentModel ?? null} save={save} cancel={resetEditor} t={t} />}
        <section className={css.memberList} aria-label={t('members')}>
          {view.members.length === 0 && <p>{t('empty')}</p>}
          {view.members.map(item => <article key={item.id} className={css.member}>
            <div className={css.memberHeading}><strong>{item.name}</strong><span>{t(item.phase === 'active' ? (item.status === 'running' ? 'member.running' : 'member.inactive') : (item.phase === 'failed' ? 'member.failed' : 'member.provisioning'))}</span></div>
            {item.description !== undefined && <p>{item.description}</p>}
            <TeamModelSummary current={item.currentModel} next={item.nextModel} t={t} />
          </article>)}
        </section>
      </>}
    </Modal>
  )
}
