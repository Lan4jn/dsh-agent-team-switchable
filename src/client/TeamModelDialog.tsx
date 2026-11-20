/** Plugin-owned anchored, non-modal settings menu; no official DOM is changed. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { BulkModelPicker } from './BulkModelPicker.tsx'
import { agreedSelection, applyToMembers, frozenTargets, type BulkOutcome, type BulkSkipReason, type BulkStatus } from './bulk-apply.ts'
import { TeamModelEditor } from './TeamModelEditor.tsx'
import type { TeamModelCatalogLease } from './TeamModelSettingsAction.tsx'
import { TeamModelSummary } from './TeamModelSummary.tsx'
import { TeamSettingsController, TeamSettingsRejectedError } from './settings-controller.ts'
import type { TeamModelSettingsView, TeamModelSelection } from '../types.ts'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

export interface TeamModelDialogProps {
  controller: TeamSettingsController
  anchor: RefObject<HTMLButtonElement>
  acquireCatalog: (signal: AbortSignal) => Promise<TeamModelCatalogLease>
  eligible: boolean
  /** Official projection eligibility, never a synthetic model projection. */
  activeNames: readonly string[]
  onClose: () => void
  t: TranslateNS<typeof NS>
}

export function TeamModelDialog({ controller, anchor, acquireCatalog, eligible, activeNames, onClose, t }: TeamModelDialogProps) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot)
  const [catalog, setCatalog] = useState<TeamModelCatalogLease | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const mounted = useRef(false)
  const catalogRequest = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const lease = useRef<TeamModelCatalogLease | null>(null)
  // Keep effects scoped to this menu lifetime, not to parent callback identity.
  const acquire = useRef(acquireCatalog)
  acquire.current = acquireCatalog
  const panel = useRef<HTMLDivElement>(null)
  const frozenNames = useRef(activeNames)
  const writeGate = useRef(false)
  const [writeRunning, setWriteRunning] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  /** undefined follows the committed view; null is an explicit empty draft. */
  const [bulkSelection, setBulkSelection] = useState<TeamModelSelection | null | undefined>(undefined)
  const [bulkOutcomes, setBulkOutcomes] = useState<readonly BulkOutcome[] | null>(null)
  const [defaultResult, setDefaultResult] = useState<'saved' | 'failed' | 'unknown' | null>(null)
  /** One gate for the whole menu: members, future default, and row autosave never overlap. */
  const busy = (): boolean => writeGate.current || controller.store.getSnapshot().saving
  const beginWrite = (): boolean => {
    if (writeGate.current || controller.store.getSnapshot().saving) return false
    writeGate.current = true
    setWriteRunning(true)
    return true
  }
  const endWrite = (): void => {
    writeGate.current = false
    if (mounted.current) setWriteRunning(false)
  }
  const availableNames = state.saving || writeRunning ? frozenNames.current : activeNames
  const view = state.view

  const refreshCatalog = async (): Promise<void> => {
    const request = ++catalogRequest.current
    setCatalogError(null)
    setCatalogLoading(true)
    try {
      if (lease.current === null) {
        abort.current?.abort()
        const cancellation = new AbortController()
        abort.current = cancellation
        const acquired = await acquire.current(cancellation.signal)
        if (!mounted.current || request !== catalogRequest.current) { acquired.release(); return }
        lease.current = acquired
        setCatalog(acquired)
      }
      await lease.current.load()
    } catch (error) {
      if (mounted.current && request === catalogRequest.current) setCatalogError(String(error))
    } finally {
      if (mounted.current && request === catalogRequest.current) setCatalogLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    if (eligible) {
      controller.activate()
      void refreshCatalog()
    }
    const timer = eligible ? setInterval(() => { void controller.load() }, 1000) : undefined
    return () => {
      mounted.current = false
      ++catalogRequest.current
      if (timer !== undefined) clearInterval(timer)
      abort.current?.abort()
      lease.current?.release()
      lease.current = null
      controller.deactivate()
    }
  }, [controller, eligible])

  // Own portal + anchor only: scroll/resize never access official page nodes.
  useLayoutEffect(() => {
    const menu = panel.current
    if (menu === null) return
    const update = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect === undefined) return
      const margin = 8
      const width = Math.max(1, Math.min(420, window.innerWidth - margin * 2))
      menu.style.width = `${width}px`
      const below = Math.max(0, window.innerHeight - rect.bottom - margin - 6)
      const above = Math.max(0, rect.top - margin - 6)
      const height = Math.min(560, menu.scrollHeight || 560)
      const upwards = below < height && above > below
      const maxHeight = Math.max(1, Math.min(560, upwards ? above : below))
      menu.style.maxHeight = `${maxHeight}px`
      const top = upwards ? rect.top - Math.min(height, maxHeight) - 6 : rect.bottom + 6
      menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - Math.min(height, maxHeight) - margin))}px`
      menu.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(menu)
    menu.focus()
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
      // Do not steal focus from a focusable outside click target.
      if (menu.contains(document.activeElement)) anchor.current?.focus()
    }
  }, [anchor])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target) || anchor.current?.contains(event.target)) return
      if (!busy()) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (!busy()) onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [anchor, controller, onClose])

  const saveMember = async (target: string, selection: TeamModelSelection, memberId: string): Promise<void> => {
    const snapshot = controller.store.getSnapshot()
    if (snapshot.saving) throw new Error(t('model.savePending'))
    if (!eligible) throw new Error(t('unavailable'))
    const currentMember = snapshot.view?.members.find(item => item.id === memberId && item.name === target)
    if (!currentMember || currentMember.phase !== 'active' || !activeNames.includes(currentMember.name)) {
      throw new Error(t('unavailable'))
    }
    frozenNames.current = activeNames
    // The member row takes the same gate as the two buttons, so no write can overlap.
    if (!beginWrite()) throw new Error(t('model.savePending'))
    try {
      await controller.save(target, selection)
    } finally { endWrite() }
  }

  const requestClose = (): void => { if (!busy()) onClose() }

  const bulkCount = (status: BulkStatus): number => bulkOutcomes?.filter(outcome => outcome.status === status).length ?? 0
  const resultKey: Record<BulkStatus, 'bulk.result.saved' | 'bulk.result.failed' | 'bulk.result.skipped' | 'bulk.result.unknown'> = {
    saved: 'bulk.result.saved', failed: 'bulk.result.failed', skipped: 'bulk.result.skipped', unknown: 'bulk.result.unknown',
  }
  const skipKey: Record<BulkSkipReason, 'bulk.skip.phase' | 'bulk.skip.changed'> = {
    phase: 'bulk.skip.phase', changed: 'bulk.skip.changed',
  }

  /** A draft is submittable only while the live catalog still offers that route and effort. */
  const knownSelection = (selection: TeamModelSelection | null): boolean => {
    if (selection === null || catalog === null) return false
    const { provider, model, reasoningEffort } = selection
    return catalog.directory.getSnapshot().groups.some(group => group.id === provider
      && group.models.some(item => item.id === model
        && (reasoningEffort === undefined || item.reasoning?.efforts.some(effort => effort.id === reasoningEffort) === true)))
  }

  // Display-only: the route the executable roster shares in the committed view, or the stored
  // future default when no teammate is executable. It is never a stored draft or a write ack.
  const executable = view === null ? [] : view.members.filter(member => member.phase === 'active' && activeNames.includes(member.name))
  const agreement = view === null ? { kind: 'none' as const } : agreedSelection(view, activeNames)
  const backfill = agreement.kind === 'agreed' && knownSelection(agreement.selection)
    ? agreement.selection
    : executable.length === 0 && view !== null && view.defaultModel !== null && knownSelection(view.defaultModel)
      ? view.defaultModel
      : null
  const effectiveSelection = bulkSelection === undefined ? backfill : bulkSelection
  const draftValid = (): boolean => knownSelection(effectiveSelection)

  /** Button 1: freeze the click-time roster, then commit each executable teammate once. */
  const applyBulk = async (): Promise<void> => {
    const snapshot = controller.store.getSnapshot()
    const selection = effectiveSelection
    if (!eligible || selection === null || snapshot.view === null || executable.length === 0 || !draftValid()) return
    if (!beginWrite()) return
    setBulkOutcomes(null)
    setBulkApplying(true)
    frozenNames.current = activeNames
    try {
      await applyToMembers({
        targets: frozenTargets(snapshot.view),
        selection,
        activeNames,
        getView: () => controller.store.getSnapshot().view,
        save: (name, next) => controller.save(name, next),
        reload: () => controller.load(),
        alive: () => mounted.current,
        report: outcomes => { if (mounted.current) setBulkOutcomes(outcomes) },
      })
    } finally {
      if (mounted.current) setBulkApplying(false)
      endWrite()
    }
  }

  /** Button 2 and the lightweight recovery entry: only the future-teammate default. */
  const applyDefault = async (selection: TeamModelSelection | null): Promise<void> => {
    if (!eligible || (selection !== null && !knownSelection(selection))) return
    if (!beginWrite()) return
    setDefaultResult(null)
    try {
      await controller.save(null, selection)
      if (mounted.current) setDefaultResult('saved')
    } catch (error) {
      if (mounted.current) setDefaultResult(error instanceof TeamSettingsRejectedError ? 'failed' : 'unknown')
    } finally { endWrite() }
  }
  const defaultResultKey: Record<'saved' | 'failed' | 'unknown', 'defaultAction.saved' | 'defaultAction.failed' | 'defaultAction.unknown'> = {
    saved: 'defaultAction.saved', failed: 'defaultAction.failed', unknown: 'defaultAction.unknown',
  }
  const defaultSummary = (value: TeamModelSettingsView): string => value.defaultModel === null
    ? t('defaultModel.inherit')
    : `${value.defaultModel.provider}/${value.defaultModel.model}${value.defaultModel.reasoningEffort === undefined ? '' : ` · ${value.defaultModel.reasoningEffort}`}`

  return createPortal(
    <div ref={panel} role="dialog" aria-label={t('trigger')} tabIndex={-1} className={css.modelDialog}>
      <div className={css.modelDialogHeader}>
        <h2>{t('trigger')}</h2>
        <button type="button" className={css.modelDialogClose} disabled={state.saving || writeRunning} aria-label={t('model.close')} onClick={requestClose}>
          <IconCloseOutlineRegular size={16} />
        </button>
      </div>
      {!eligible && <p role="status">{t('unavailable')}</p>}
      {eligible && <>
        {state.loading && view === null && <p role="status">{t('loading')}</p>}
        {state.error !== null && <div role="alert" className={css.error}>{state.error}
          <button type="button" disabled={state.saving} onClick={() => { void controller.load() }}>{t('retry')}</button>
        </div>}
        {catalogLoading && <p role="status">{t('model.loading')}</p>}
        {catalogError !== null && <div role="alert" className={css.error}>{catalogError}
          <button type="button" disabled={state.saving || catalogLoading} onClick={() => { void refreshCatalog() }}>{t('retry')}</button>
        </div>}
        {state.saving && <p className={css.savePending} role="status">{t('model.savePending')}</p>}
        {view !== null && <>
          <section className={css.bulkSection} role="region" aria-label={t('bulk.title')}>
            <p className={css.bulkHint}>{t('bulk.hint')}</p>
            {catalog === null
              ? <p role="status">{t('model.loading')}</p>
              : <BulkModelPicker directory={catalog.directory} disabled={state.saving || writeRunning} initial={effectiveSelection} onChange={selection => { setBulkSelection(selection) }} t={t} />}
            {agreement.kind === 'mixed' && bulkSelection === undefined && catalog !== null && (
              <p role="status" className={css.bulkHint}>{t('bulk.mixed')}</p>
            )}
            <div className={css.bulkActions}>
              <div>
                <button type="button" className={css.bulkApply} disabled={!eligible || !draftValid() || executable.length === 0 || state.saving || writeRunning} onClick={() => { void applyBulk() }}>
                  {t('bulk.apply')}
                </button>
                <p className={css.bulkScope}>{t('bulk.applyScope')}</p>
              </div>
              <div>
                <button type="button" className={css.bulkApply} disabled={!eligible || !draftValid() || state.saving || writeRunning} onClick={() => { void applyDefault(effectiveSelection) }}>
                  {t('defaultAction.apply')}
                </button>
                <p className={css.bulkScope}>{t('defaultAction.scope')}</p>
              </div>
            </div>
            {bulkApplying && <p role="status">{t('bulk.running')}</p>}
            {defaultResult !== null && <p role="status" data-default-result={defaultResult}>{t(defaultResultKey[defaultResult])}</p>}
            {view.members.length === 0 && <p>{t('bulk.empty')}</p>}
            {bulkOutcomes !== null && (
              <div className={css.bulkResults}>
                <p>{t('bulk.summary', { saved: bulkCount('saved'), failed: bulkCount('failed'), skipped: bulkCount('skipped'), unknown: bulkCount('unknown') })}</p>
                {bulkOutcomes.some(outcome => outcome.status !== 'saved') && <p>{t('bulk.incomplete')}</p>}
                <ul>
                  {bulkOutcomes.map(outcome => (
                    <li key={outcome.id} data-bulk-result={outcome.status}>
                      {`${outcome.name}：${t(resultKey[outcome.status])}`}
                      {outcome.reason === undefined ? '' : ` · ${t(skipKey[outcome.reason])}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <section className={css.defaultSection} role="region" aria-label={t('defaultModel.title')}>
            <p data-committed-default>{t('defaultModel.summary', { summary: defaultSummary(view) })}</p>
            <button type="button" className={css.recoveryAction} disabled={!eligible || view.defaultModel === null || state.saving || writeRunning} onClick={() => { void applyDefault(null) }}>
              {t('defaultAction.recovery')}
            </button>
          </section>
          <section className={css.memberList} aria-label={t('members')}>
            {view.members.length === 0 && <p>{t('empty')}</p>}
            {view.members.map(item => {
              const canEditThisMember = item.phase === 'active' && availableNames.includes(item.name)
              return (
                <article key={item.id} className={css.member} aria-label={item.name}>
                  <div className={css.memberHeading}>
                    <strong>{item.name}</strong>
                    <span>{t(item.phase === 'active' ? (item.status === 'running' ? 'member.running' : 'member.inactive') : (item.phase === 'failed' ? 'member.failed' : 'member.provisioning'))}</span>
                  </div>
                  {item.description !== undefined && <p>{item.description}</p>}
                  <TeamModelSummary current={item.currentModel} next={item.nextModel} t={t} />
                  {catalog !== null && (canEditThisMember ? (
                    <TeamModelEditor
                      key={`member:${item.id}`}
                      directory={catalog.directory}
                      initial={item.nextModel ?? item.currentModel ?? null}
                      disabled={state.saving || writeRunning || !canEditThisMember}
                      isLocked={() => {
                        const latestMember = controller.store.getSnapshot().view?.members.find(m => m.id === item.id)
                        return busy() || !eligible || latestMember?.phase !== 'active' || !activeNames.includes(item.name)
                      }}
                      save={selection => saveMember(item.name, selection, item.id)}
                      t={t}
                    />
                  ) : null)}
                </article>
              )
            })}
          </section>
        </>}
      </>}
    </div>, document.body,
  )
}
