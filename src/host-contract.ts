/** Hand-authored manifest using the public Typert contribution shape. */
import { descriptors, TYPERT_REMOTE } from './remote.ts'

// The loader accepts empty reflection arrays; descriptors remain authoritative.
export const TYPERT = {
  package: TYPERT_REMOTE.package,
  face: 'host',
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
} as const
