/** Additive compact header action. Official Team tools and components remain untouched. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamModelDialog } from './TeamModelDialog.tsx'
import type { TeamModelDirectory } from './TeamModelEditor.tsx'
import { TeamSettingsController, type TeamSettingsApi } from './settings-controller.ts'
import { NS } from './locales.ts'
import css from './TeamModelSettings.module.css'

export interface TeamModelSettingsInjected {
  api: TeamSettingsApi
  modelDirectoryFor: (leadSessionId: SessionId) => TeamModelDirectory
  loadCatalogFor: (leadSessionId: SessionId) => Promise<unknown>
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
  const eligible = team !== undefined && (address === undefined || team.members.some(member => member.id === props.sessionId && member.role === 'teammate' && member.phase === 'active'))
  if (!eligible) return null
  // Changing conversation/session remounts and invalidates every pending callback.
  return <SettingsHeader key={`${props.sessionId}:${leadSessionId}`} {...props} leadSessionId={leadSessionId} activeNames={team.members.filter(member => member.role === 'teammate' && member.phase === 'active').map(member => member.name)} />
}

function SettingsHeader({ api, modelDirectoryFor, loadCatalogFor, leadSessionId, activeNames, t }: TeamModelSettingsInjected & PropsLocale<typeof NS> & { leadSessionId: SessionId; activeNames: readonly string[] }) {
  const controller = useMemo(() => new TeamSettingsController(leadSessionId, api), [leadSessionId, api])
  const directory = useMemo(() => modelDirectoryFor(leadSessionId), [leadSessionId, modelDirectoryFor])
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot)
  const [open, setOpen] = useState(false)
  useEffect(() => () => { controller.deactivate() }, [controller])
  const committedDefault = state.view?.defaultModel
  const summary = committedDefault == null ? t('defaultModel.inherit') : `${committedDefault.provider}/${committedDefault.model}${committedDefault.reasoningEffort === undefined ? '' : ` · ${committedDefault.reasoningEffort}`}`
  return <>
    <button type="button" className={css.trigger} aria-label={t('trigger')} title={state.view === null ? t('trigger') : t('defaultModel.summary', { summary })} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>
      <IconSettingsOutlineRegular size={14} />
      <span>{t('trigger')}</span>
    </button>
    {open && <TeamModelDialog controller={controller} directory={directory} activeNames={activeNames} loadCatalog={() => loadCatalogFor(leadSessionId)} onClose={() => { setOpen(false) }} t={t} />}
  </>
}
