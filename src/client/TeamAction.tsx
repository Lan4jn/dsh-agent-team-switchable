import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection,
  TeamTaskView as TeamTask,
} from '../runtime/client.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  IconChevronDownOutlineRegular, IconSettingsOutlineRegular,
  IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, Tag, Tooltip,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import { TeamModelSummary } from './TeamModelSummary.tsx'
import { TeamModelDialog } from './TeamModelDialog.tsx'
import type { TeamModelCatalogState, TeamModelDirectory } from './TeamModelEditor.tsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import css from './TeamAction.module.css'

const emptyCatalogStore = createSnapshotStore<TeamModelCatalogState>({
  groups: [],
  status: 'unavailable',
  error: null,
  failures: [],
})

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Open a roster Session from the current conversation. */
  openTeammate: (sessionId: SessionId, childSessionId: SessionId) => void
  /** Shared, read-only model catalog. Never call its generic select method. */
  modelDirectory?: TeamModelDirectory | undefined
  /** Plugin-owned Remote action; does not update global defaults. */
  selectMemberModel?: ((leadSessionId: SessionId, target: string, selection: ModelSelection) => Promise<void>) | undefined
  /** Plugin-owned Remote action to set or clear the team-wide default model for new members. */
  selectTeamDefaultModel?: ((leadSessionId: SessionId, selection: ModelSelection | null) => Promise<void>) | undefined
}

/** Durable lifecycle overlaid with the member Session's live turn activity. */
type MemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function memberStatusKey(status: MemberStatus): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

function memberDotState(status: Exclude<MemberStatus, 'inactive'>): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning': return 'ongoing'
    case 'failed': return 'error'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

type TeamMemberRowProps = Pick<TeamActionProps,
  'sessionId' | 'useSessions' | 'useSessionStatus' | 'openTeammate' | 't' | 'modelDirectory' | 'selectMemberModel'
> & {
  leadSessionId: SessionId
  member: TeamMemberProjection
  memberCount: number
  onError: (message: string) => void
  editing: boolean
  onEdit: () => void
  onCloseEditor: () => void
}

function TeamMemberRow({
  member, memberCount, sessionId, leadSessionId, useSessions, useSessionStatus, openTeammate, onError, t, modelDirectory, selectMemberModel,
  editing, onEdit, onCloseEditor,
}: TeamMemberRowProps) {
  const projected = useSessions(state => state.projectionsBySession[member.id]?.values.modelSelection)
  const nextSelection = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeamModels?.choices[member.id]?.selection)
  const currentSelection = projected?.lastUsed ?? projected?.next
  const canEdit = member.role === 'teammate' && member.phase === 'active' && selectMemberModel !== undefined
  const running = useSessionStatus(state => state.get(member.id)?.running)
  const summaryRunning = useSessions(state => state.byId[member.id]?.running)
  const status: MemberStatus = member.phase === 'active'
    ? (running ?? summaryRunning) === true ? 'running' : 'inactive'
    : member.phase
  const isCurrent = member.id === sessionId
  const highlightCurrent = isCurrent && memberCount > 1
  const inert = isCurrent || status === 'failed' || status === 'provisioning'

  return (
    <article className={highlightCurrent ? `${css.member} ${css.memberCurrent}` : css.member}>
      <div className={css.memberHeader}>
        <span className={css.memberDot}>
          {status === 'inactive'
            ? <IconUserOutlineRegular size={14} className={css.inactiveIcon} />
            : <StateDot state={memberDotState(status)} />}
        </span>
        <Tooltip label={t('open')} side="bottom" gap={4} disabled={inert}>
          <button
            type="button"
            className={css.memberNavigation}
            aria-label={member.name}
            disabled={inert}
            onClick={() => {
              try { openTeammate(sessionId, member.id) }
              catch (reason) { onError(String(reason)) }
            }}
          >{member.name}</button>
        </Tooltip>
        {isCurrent && <Tag tone="info" className={css.currentTag}>{t('current')}</Tag>}
        <span className={css.memberStatus}>{t(memberStatusKey(status))}</span>
        {canEdit && <button
          type="button"
          className={css.modelSettings}
          aria-label={t('model.settings', { name: member.name })}
          aria-expanded={editing}
          onClick={onEdit}
        ><IconSettingsOutlineRegular size={15} /></button>}
      </div>
      <TeamModelSummary current={currentSelection} next={nextSelection} t={t} />
      {member.error !== undefined && <p className={css.diagnostic}>{member.error}</p>}
      {editing && canEdit && <TeamModelDialog
        name={member.name}
        directory={modelDirectory}
        initial={nextSelection ?? (currentSelection == null ? null : { provider: currentSelection.provider, model: currentSelection.model })}
        save={selection => selectMemberModel(leadSessionId, member.name, selection)}
        onClose={onCloseEditor}
        t={t}
      />}
    </article>
  )
}

/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, t }: { task: TeamTask; t: TranslateNS<typeof NS> }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(statusKey(task.status))}</span>
        </span>
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      <div className={css.meta}>
        {(clamped || expanded || task.blockedBy.length > 0 || task.writeScopes.length > 0) && (
          <button
            type="button"
            className={css.expandToggle}
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {t(expanded ? 'task.collapse' : 'task.expand')}
            <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandToggleOpen : undefined} />
          </button>
        )}
        <span>{task.id}</span>
        <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
      </div>
      {task.writeScopeWarnings.map((warning, index) => <p key={index} className={css.warning}>{warning}</p>)}
      {expanded && <div className={css.taskDetails}>
        {task.blockedBy.length > 0 && <div>
          <span>{t('blockedBy')}</span>
          <ul>{task.blockedBy.map(id => <li key={id}>{id}</li>)}</ul>
        </div>}
        {task.writeScopes.length > 0 && <div>
          <span>{t('writeScopes')}</span>
          <ul>{task.writeScopes.map((scope, index) => <li key={index}>{scope}</li>)}</ul>
        </div>}
      </div>}
    </article>
  )
}

function sameSelection(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

interface PendingDefaultSave {
  readonly leadId: SessionId
  readonly token: number
  readonly before: ModelSelection | null | undefined
}

type EditTarget = { kind: 'member'; id: SessionId } | { kind: 'default' }

/** Render the Team roster and read-only task board. */
export function TeamAction({
  sessionId, useSession, useSessions, useSessionStatus, openTeammate, modelDirectory, selectMemberModel, selectTeamDefaultModel, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const defaultButtonRef = useRef<HTMLButtonElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  const leadSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  const team = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeam)
  const modelFailure = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeamModels?.failure)
  const defaultSelection = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeamModels?.defaultModel)
  const [pendingSave, setPendingSave] = useState<PendingDefaultSave | null>(null)
  const [failedRollback, setFailedRollback] = useState<PendingDefaultSave | null>(null)
  const saveTokenRef = useRef(0)

  useEffect(() => {
    if (failedRollback !== null && failedRollback.leadId === leadSessionId && sameSelection(defaultSelection, failedRollback.before)) {
      setFailedRollback(null)
    }
  }, [failedRollback, leadSessionId, defaultSelection])

  const effectiveDefaultSelection = (pendingSave !== null && pendingSave.leadId === leadSessionId)
    ? pendingSave.before
    : ((failedRollback !== null && failedRollback.leadId === leadSessionId && !sameSelection(defaultSelection, failedRollback.before))
      ? failedRollback.before
      : defaultSelection)

  const opening = useSession(snapshot => snapshot.openState === 'loading')
  const listing = useSessions(state => state.phase === 'pending')
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const activeDirectory = modelDirectory ?? emptyCatalogStore
  const catalog = useSyncExternalStore(activeDirectory.subscribe, activeDirectory.getSnapshot, activeDirectory.getSnapshot)

  const canEditDefault = selectTeamDefaultModel !== undefined
  const isTargetValid = editTarget !== null && (
    (editTarget.kind === 'default' && canEditDefault) ||
    (editTarget.kind === 'member' && selectMemberModel !== undefined && team?.members.some(member =>
      member.id === editTarget.id && member.role === 'teammate' && member.phase === 'active',
    ) === true)
  )
  const editing = open && isTargetValid

  useLayoutEffect(() => {
    if (editing) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = undefined
    } else if (editTarget !== null) setEditTarget(null)
  }, [editing, editTarget])

  const cancelHoverChange = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => {
    cancelHoverChange()
    pinnedRef.current = false
    setOpen(false)
    setError(null)
  }, [sessionId])

  useEffect(() => cancelHoverChange, [])

  useLayoutEffect(() => {
    if (open && positioned && pinnedRef.current) panelRef.current?.focus()
  }, [open, positioned])

  const changeOpen = (next: boolean): void => {
    cancelHoverChange()
    if (!next) pinnedRef.current = false
    setOpen(next)
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverChange()
    if (open) return
    const label = triggerLabelRef.current
    /* v8 ignore next -- the label mounts with the trigger that received the hover. */
    if (label === null) return
    // Icon-only trigger (label collapsed by the header container query):
    // hover-open would surprise on such a small target, so only click opens.
    if (getComputedStyle(label).display === 'none') return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverChange()
    if (pinnedRef.current || editing) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useDismissOnOutsidePointer(rootRef, open && !editing, changeOpen, panelRef)

  useEffect(() => {
    if (!open || editing) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      cancelHoverChange()
      pinnedRef.current = false
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open, editing])

  const compact = team !== undefined && team.members.length === 1 && team.tasks.length === 0

  let defaultSummaryText = ''
  let defaultAriaLabel = ''
  if (effectiveDefaultSelection == null) {
    const inheritSummary = t('defaultModel.inheritSummary')
    defaultSummaryText = t('defaultModel.button', { summary: inheritSummary })
    defaultAriaLabel = t('defaultModel.aria', { summary: t('defaultModel.inherit') })
  } else {
    const matchedGroup = catalog.groups.find(g => g.id === effectiveDefaultSelection.provider)
    const matchedModel = matchedGroup?.models.find(m => m.id === effectiveDefaultSelection.model)
    const matchedEffort = matchedModel?.reasoning?.efforts?.find(e => e.id === effectiveDefaultSelection.reasoningEffort)
    const effortDisplay = effectiveDefaultSelection.reasoningEffort !== undefined
      ? (matchedEffort?.name ?? effectiveDefaultSelection.reasoningEffort)
      : t('model.defaultReasoning')
    const summaryStr = `${effectiveDefaultSelection.model} · ${effortDisplay}`
    defaultSummaryText = t('defaultModel.button', { summary: summaryStr })
    defaultAriaLabel = t('defaultModel.aria', { summary: `${effectiveDefaultSelection.provider}/${effectiveDefaultSelection.model} · ${effortDisplay}` })
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-team-action
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        className={css.trigger}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          cancelHoverChange()
          pinnedRef.current = true
          if (!open) changeOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconUsersOutlineRegular size={14} />
        <span ref={triggerLabelRef} className={css.triggerLabel}>{t('trigger')}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={compact ? `${css.panel} ${css.panelCompact}` : css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
          onMouseEnter={cancelHoverChange}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.body}>
            {error !== null && (
              <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
            )}
            {modelFailure !== undefined && <div className={css.error} role="alert"><StateDot state="error" />{modelFailure}</div>}
            {team === undefined && (
              <div className={css.notice} role="status">
                <StateDot state={opening || listing ? 'ongoing' : 'warning'} />
                {t(opening || listing ? 'loading' : 'unavailable')}
              </div>
            )}
            {team !== undefined && (
              <>
                {team.failure !== undefined && (
                  <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
                )}
                <section>
                  <div className={css.rosterHeader}>
                    <h3>
                      {t('roster')}
                      {team.members.length > 1 && <span className={css.count}>{team.members.length}</span>}
                    </h3>
                    {canEditDefault && (
                      <button
                        type="button"
                        ref={defaultButtonRef}
                        className={css.teamDefaultButton}
                        aria-label={defaultAriaLabel}
                        aria-expanded={editTarget?.kind === 'default'}
                        onClick={() => {
                          cancelHoverChange()
                          setEditTarget({ kind: 'default' })
                        }}
                      >
                        <span className={css.defaultButtonText}>{defaultSummaryText}</span>
                        <IconSettingsOutlineRegular size={14} className={css.defaultSettingsIcon} />
                      </button>
                    )}
                  </div>
                  {editTarget?.kind === 'default' && (
                    <TeamModelDialog
                      key="default"
                      mode="default"
                      directory={modelDirectory}
                      initial={effectiveDefaultSelection ?? null}
                      save={async selection => {
                        const token = ++saveTokenRef.current
                        const before = effectiveDefaultSelection
                        setPendingSave({ leadId: leadSessionId, token, before })
                        setFailedRollback(current => (current?.leadId === leadSessionId ? null : current))
                        try {
                          await selectTeamDefaultModel!(leadSessionId, selection)
                        } catch (err) {
                          setFailedRollback(current => (saveTokenRef.current === token ? { leadId: leadSessionId, token, before } : current))
                          throw err
                        } finally {
                          setPendingSave(current => (current?.token === token ? null : current))
                        }
                      }}
                      onClose={() => { setEditTarget(null) }}
                      t={t}
                    />
                  )}
                  <div className={css.roster}>
                    {team.members.map(member => (
                      <TeamMemberRow
                        key={member.id}
                        member={member}
                        memberCount={team.members.length}
                        leadSessionId={leadSessionId}
                        modelDirectory={modelDirectory}
                        selectMemberModel={selectMemberModel}
                        sessionId={sessionId}
                        useSessions={useSessions}
                        useSessionStatus={useSessionStatus}
                        openTeammate={openTeammate}
                        onError={setError}
                        editing={editing && editTarget?.kind === 'member' && editTarget.id === member.id}
                        onEdit={() => {
                          cancelHoverChange()
                          setEditTarget({ kind: 'member', id: member.id })
                        }}
                        onCloseEditor={() => { setEditTarget(null) }}
                        t={t}
                      />
                    ))}
                  </div>
                </section>
                <section>
                  {team.tasks.length === 0
                    ? <p className={css.emptyNotice}>{t('empty')}</p>
                    : (
                      <>
                        <h3>{t('tasks')}<span className={css.count}>{team.tasks.length}</span></h3>
                        <div className={css.tasks}>
                          {team.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
                        </div>
                      </>
                    )}
                </section>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
