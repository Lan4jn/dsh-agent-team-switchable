import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { name, Config, apply, PACKAGE_TAG } from '../src/index.ts'
import { TYPERT } from '../src/typert.host.ts'
import { TYPERT_REMOTE } from '../src/typert.remote-client.ts'

describe('dsh-remote-team-bridge plugin assembly & RPC', () => {
  it('exposes standard plugin metadata and default configuration', () => {
    expect(name).toBe('dsh-remote-team-bridge')
    expect(PACKAGE_TAG).toBe('dsh-remote-team-bridge')

    const defaults = Config({})
    expect(defaults).toEqual({
      enabled: false,
      port: 19820,
      host: '::',
      maxDedicatedTeams: 5,
    })
  })

  it('exposes authoritative host and remote Typert descriptors under remote-team-bridge namespace', () => {
    expect(TYPERT.package).toBe('dsh-remote-team-bridge')
    expect(TYPERT.face).toBe('host')
    expect(TYPERT_REMOTE.package).toBe('dsh-remote-team-bridge')

    const methods = TYPERT.invocations.map(inv => inv.method)
    expect(methods).toContain('getStatus')
    expect(methods).toContain('createPairingCode')
    expect(methods).toContain('listPairedDevices')
    expect(methods).toContain('revokePairedDevice')

    for (const descriptor of TYPERT.invocations) {
      expect(descriptor.namespace).toBe('remote-team-bridge')
      expect(descriptor.id).toBe(`dsh-remote-team-bridge#remote-team-bridge/${descriptor.method}`)
    }
  })

  it('does not throw when optional services are absent and remains inert when enabled is false', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ name, Config, apply }, { enabled: false })
    await Promise.resolve()
    expect(fiber).toBeDefined()
    await fiber.dispose()
  })
})
