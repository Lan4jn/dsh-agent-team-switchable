/** Small primitives mock; no Core implementation or SDK adapter. */
import type { ReactNode } from 'react'
export function Modal({ open, title, children }: { open: boolean; title: string; children: ReactNode }) {
  return open ? <div role="dialog" aria-label={title}>{children}</div> : null
}
export function IconCloseOutlineRegular() { return <span aria-hidden="true">×</span> }
export function IconSettingsOutlineRegular() { return <span aria-hidden="true">⚙</span> }
