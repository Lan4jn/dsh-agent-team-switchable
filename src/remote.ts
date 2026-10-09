/** Explicit plugin-local Host-for-Client contract; no Core generator is bundled. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamModelSelection, TeamSelectDefaultModelRequest, TeamSelectMemberModelRequest } from './types.ts'

const packageName = 'dsh-agent-team-switchable'
const selection = () => z.object({
  provider: z.string().readonly(),
  model: z.string().readonly(),
  reasoningEffort: z.string().readonly().optional(),
})
const sessionId = () => z.intersection(z.string(), z.unknown()).readonly()
const lazy = <T>(create: () => T): (() => T) => {
  let value: T | undefined
  return () => (value ??= create())
}
const memberRequest = lazy(() => z.object({
  leadSessionId: sessionId(), target: z.string().readonly(), selection: selection().readonly(),
}))
const memberResult = lazy(selection)
const defaultRequest = lazy(() => z.object({
  leadSessionId: sessionId(), selection: z.union([z.literal(null), selection()]).readonly(),
}))
const defaultResult = lazy(() => z.union([z.literal(null), selection()]))

/** Public protocol descriptors shared by this package's two faces. */
export const descriptors: readonly InvocationDescriptor[] = [
  {
    id: `${packageName}#agent-team-models/selectMemberModel`,
    service: 'teamModelController', namespace: 'agent-team-models', method: 'selectMemberModel',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: { mode: 'strict', typeSymbol: `${packageName}/types#TeamSelectMemberModelRequest`, create: memberRequest },
    }],
    result: { mode: 'strict', typeSymbol: `${packageName}/types#TeamModelSelection`, create: memberResult },
  },
  {
    id: `${packageName}#agent-team-models/selectTeamDefaultModel`,
    service: 'teamModelController', namespace: 'agent-team-models', method: 'selectTeamDefaultModel',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: { mode: 'strict', typeSymbol: `${packageName}/types#TeamSelectDefaultModelRequest`, create: defaultRequest },
    }],
    result: {
      mode: 'strict', typeSymbol: `${packageName}#agent-team-models/selectTeamDefaultModel:result`, create: defaultResult,
    },
  },
]

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6167656e742d7465616d2d6d6f64656c73 {
    selectMemberModel: (request: TeamSelectMemberModelRequest) => Promise<RemoteResult<TeamModelSelection>>
    selectTeamDefaultModel: (request: TeamSelectDefaultModelRequest) => Promise<RemoteResult<TeamModelSelection | null>>
  }
  interface TypertRemoteMap {
    'agent-team-models/selectMemberModel': (request: TeamSelectMemberModelRequest) => Promise<RemoteResult<TeamModelSelection>>
    'agent-team-models/selectTeamDefaultModel': (request: TeamSelectDefaultModelRequest) => Promise<RemoteResult<TeamModelSelection | null>>
  }
  interface TypertRemoteNamespaceMap {
    'agent-team-models': TypertRemoteNamespace$6167656e742d7465616d2d6d6f64656c73
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = { package: packageName, descriptors }
export default TYPERT_REMOTE
