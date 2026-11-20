/** Additive compact header action. Official Team tools and components remain untouched. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamModelDialog } from './TeamModelDialog.tsx'
import type { TeamModelDirectory } from './TeamModelEditor.tsx'
import { TeamSettingsController, type TeamSettingsApi } from './settings-controller.ts'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

export interface TeamModelCatalogLease {
  directory: TeamModelDirectory
  load: () => Promise<unknown>
  release: () => void
}
export interface TeamModelSettingsInjected {
  api: TeamSettingsApi
  /** Acquire the Lead's Client lifetime only while the menu is open. */
  acquireCatalogFor: (leadSessionId: SessionId, signal: AbortSignal) => Promise<TeamModelCatalogLease>
}
export type TeamModelSettingsProps = PropsRuntime<'conversation.session.header.actions'> & TeamModelSettingsInjected & PropsLocale<typeof NS>

/** Minimal read-only face of the official projection, not registered or written here. */
interface EligibilityTeam {
  members: readonly { id: SessionId; name: string; role: string; phase: string }[]
}

export function TeamModelSettingsAction(props: TeamModelSettingsProps) {
  const address = props.useSession(snapshot => snapshot.subagent?.address)
  const leadSessionId = address?.parentSessionId ?? props.sessionId
  const team = props.useSessions(state => (state.projectionsBySession[leadSessionId]?.values as unknown as { agentTeam?: EligibilityTeam } | undefined)?.agentTeam)
  // An absent projection is not a retirement signal. Keep the entry available,
  // but never expose an editor to an unverified/non-Team addressed worker.
  const eligible = address === undefined || (team !== undefined && team.members.some(member => member.id === props.sessionId && member.role === 'teammate' && member.phase === 'active'))
  if (address !== undefined && team !== undefined && !eligible) return null
  return <SettingsHeader key={`${props.sessionId}:${leadSessionId}`} {...props} leadSessionId={leadSessionId} eligible={eligible} activeNames={team?.members.filter(member => member.role === 'teammate' && member.phase === 'active').map(member => member.name) ?? []} />
}

function SettingsHeader({ api, acquireCatalogFor, leadSessionId, activeNames, eligible, t }: TeamModelSettingsInjected & PropsLocale<typeof NS> & { leadSessionId: SessionId; activeNames: readonly string[]; eligible: boolean }) {
  const controller = useMemo(() => new TeamSettingsController(leadSessionId, api), [leadSessionId, api])
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => () => { controller.deactivate() }, [controller])
  const committedDefault = state.view?.defaultModel
  const summary = committedDefault == null ? t('defaultModel.inherit') : `${committedDefault.provider}/${committedDefault.model}${committedDefault.reasoningEffort === undefined ? '' : ` · ${committedDefault.reasoningEffort}`}`
  const close = (): void => { if (!controller.store.getSnapshot().saving) setOpen(false) }
  return <>
    <button ref={trigger} type="button" className={css.trigger} aria-label={t('trigger')} title={state.view === null ? t('trigger') : t('defaultModel.summary', { summary })} aria-haspopup="dialog" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true) }}>
      <IconSettingsOutlineRegular size={14} />
      <span>{t('trigger')}</span>
    </button>
    {open && <TeamModelDialog key={String(eligible)} controller={controller} anchor={trigger} acquireCatalog={signal => acquireCatalogFor(leadSessionId, signal)} eligible={eligible} activeNames={activeNames} onClose={close} t={t} />}
  </>
}
