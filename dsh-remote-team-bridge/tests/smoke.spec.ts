import { expect, it } from 'vitest'
import { PACKAGE_TAG } from '../src/index.ts'

it('exposes the package tag', () => {
  expect(PACKAGE_TAG).toBe('dsh-remote-team-bridge')
})
