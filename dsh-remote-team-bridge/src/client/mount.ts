import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { BridgeHeaderAction } from './BridgeHeaderAction.tsx'

export const inject = ['slots']

export function registerRemoteTeamBridgeUi(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'remote-team-bridge',
        order: -18,
      },
      BridgeHeaderAction,
    ),
  )
}
