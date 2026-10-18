import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { inject, registerRemoteTeamBridgeUi } from './mount.ts'

export { inject }
export { BridgePanel } from './BridgePanel.tsx'
export type { BridgePanelProps } from './BridgePanel.tsx'
export { BridgeHeaderAction } from './BridgeHeaderAction.tsx'

export function apply(ctx: ClientContext): void {
  ctx.inject(inject, registerRemoteTeamBridgeUi)
}
