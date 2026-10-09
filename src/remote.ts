/** Plugin-owned RPC contract, independent of the official Agent Teams namespace. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamModelSettingsView, TeamSettingsRequest, TeamSelectDefaultModelRequest, TeamSelectMemberModelRequest } from './types.ts'

const packageName = 'dsh-agent-team-switchable'
const namespace = 'team-model-settings'
const selection = () => z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() })
const sessionId = () => z.intersection(z.string(), z.unknown())
const viewSchema = () => z.object({
  teamId: sessionId(), revision: z.number().int().nonnegative(),
  defaultModel: selection().nullable(),
  members: z.array(z.object({
    id: sessionId(), name: z.string(), description: z.string().optional(),
    phase: z.enum(['provisioning', 'active', 'failed']), status: z.enum(['running', 'inactive']),
    currentModel: selection().optional(), nextModel: selection().optional(),
  })),
})
const lazy = <T>(create: () => T): (() => T) => {
  let value: T | undefined
  return () => (value ??= create())
}
const view = lazy(viewSchema)
const requests = {
  getSettings: { type: 'TeamSettingsRequest', create: lazy(() => z.object({ leadSessionId: sessionId() })) },
  selectMemberModel: { type: 'TeamSelectMemberModelRequest', create: lazy(() => z.object({ leadSessionId: sessionId(), target: z.string(), selection: selection() })) },
  selectTeamDefaultModel: { type: 'TeamSelectDefaultModelRequest', create: lazy(() => z.object({ leadSessionId: sessionId(), selection: selection().nullable() })) },
}

export const descriptors: readonly InvocationDescriptor[] = Object.entries(requests).map<InvocationDescriptor>(([method, request]) => ({
  id: `${packageName}#${namespace}/${method}`,
  service: 'teamModelSettings', namespace, method, invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
    mode: 'strict', typeSymbol: `${packageName}/types#${request.type}`, create: request.create,
  } }],
  result: { mode: 'strict', typeSymbol: `${packageName}/types#TeamModelSettingsView`, create: view },
}))

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$7465616d2d6d6f64656c2d73657474696e6773 {
    getSettings: (request: TeamSettingsRequest) => Promise<RemoteResult<TeamModelSettingsView>>
    selectMemberModel: (request: TeamSelectMemberModelRequest) => Promise<RemoteResult<TeamModelSettingsView>>
    selectTeamDefaultModel: (request: TeamSelectDefaultModelRequest) => Promise<RemoteResult<TeamModelSettingsView>>
  }
  interface TypertRemoteMap {
    'team-model-settings/getSettings': (request: TeamSettingsRequest) => Promise<RemoteResult<TeamModelSettingsView>>
    'team-model-settings/selectMemberModel': (request: TeamSelectMemberModelRequest) => Promise<RemoteResult<TeamModelSettingsView>>
    'team-model-settings/selectTeamDefaultModel': (request: TeamSelectDefaultModelRequest) => Promise<RemoteResult<TeamModelSettingsView>>
  }
  interface TypertRemoteNamespaceMap {
    'team-model-settings': TypertRemoteNamespace$7465616d2d6d6f64656c2d73657474696e6773
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = { package: packageName, descriptors }
export default TYPERT_REMOTE
