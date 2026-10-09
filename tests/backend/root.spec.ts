import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, TeamModelSettingsService } from '../../src/index.ts'
import { TEAM_SETTINGS_DOMAIN } from '../../src/types.ts'
import type { TeamSettingsRecord } from '../../src/domain.ts'
import { deferred } from '../support/backend-fixtures.ts'

describe('纯增强 root 生命周期', () => {
  it('仅依赖公开注入，await domain open 后注册 hooks/service；不安装官方插件，dispose 关闭自己 domain', async () => {
    const ctx = new Context()
    const events: string[] = []; const table = new Map<string, TeamSettingsRecord>(); const gate = deferred()
    const open = vi.fn(async (spec: { name: string; version: number }) => {
      expect(spec.name).toBe(TEAM_SETTINGS_DOMAIN); expect(spec.version).toBe(1)
      events.push('opening'); await gate.promise; events.push('opened')
      return { table: () => ({ get: (id: string) => table.get(id), put: async (id: string, value: TeamSettingsRecord) => { table.set(id, value) } }), close: async () => { events.push('closed') } }
    })
    ctx.provide('agents', { list: () => [], get: () => undefined } as never)
    ctx.provide('agentTeams', { tryMembership: () => undefined } as never)
    ctx.provide('llm', {} as never)
    ctx.provide('storageDomain', { open } as never)
    ctx.provide('tools', {} as never)
    ctx.provide('systemPrompt', {} as never)
    ctx.provide('sessionController', {} as never)
    const on = vi.spyOn(ctx, 'on')
    const plugin = vi.spyOn(ctx, 'plugin')
    const rootPlugin = { name: 'backend-lifecycle-fixture', apply }
    const fiber = ctx.plugin(rootPlugin)
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['opening'])
    expect(on.mock.calls.some(([name]) => name === 'session/event')).toBe(false)
    gate.resolve(); await fiber
    expect(events).toEqual(['opening', 'opened'])
    expect(on.mock.calls.some(([name]) => name === 'session/event')).toBe(true)
    expect(ctx.teamModelSettings).toBeInstanceOf(TeamModelSettingsService)
    expect(plugin.mock.calls.every(([entry]) => entry === rootPlugin || entry === TeamModelSettingsService)).toBe(true)
    await fiber.dispose()
    expect(events.at(-1)).toBe('closed')
  })

  it('open 尚未完成时 dispose 也不泄露自己的域', async () => {
    const ctx = new Context(); const gate = deferred(); const close = vi.fn(async () => {})
    for (const key of ['agents', 'agentTeams', 'llm', 'tools', 'systemPrompt', 'sessionController']) {
      ctx.provide(key, { list: () => [], get: () => undefined, tryMembership: () => undefined } as never)
    }
    ctx.provide('storageDomain', { open: async () => { await gate.promise; return { table: () => ({ get: () => undefined, put: async () => {} }), close } } } as never)
    const fiber = ctx.plugin({ apply })
    await Promise.resolve(); await Promise.resolve()
    const disposal = fiber.dispose()
    gate.resolve()
    await disposal
    expect(close).toHaveBeenCalledOnce()
  })

  it('插件 Config 只提供独立 transport 默认，不依赖官方修改模型工具', () => {
    expect(Config({})).toEqual({ freshProvider: 'spawn', forkProvider: 'fork' })
  })
})
