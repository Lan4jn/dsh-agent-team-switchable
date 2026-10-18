import { descriptors, TYPERT_REMOTE } from './remote.ts'

export const TYPERT = {
  package: TYPERT_REMOTE.package,
  face: 'host',
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
} as const

export default TYPERT
