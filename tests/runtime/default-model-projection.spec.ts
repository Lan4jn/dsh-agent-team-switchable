import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../../src/runtime/projection.ts'
import { teamModelsProjectionDefinition } from '../../src/runtime/model-selection.ts'
import { TeamId } from '../../src/runtime/types.ts'

const header = { version: SESSION_FORMAT_VERSION, id: SessionId('lead'), createdAt: 0, isSeeded: false }
const route = { provider: 'other', model: 'careful', reasoningEffort: 'high' }
function config(defaultModel: unknown = route, extra: Record<string, unknown> = {}): SessionEvent {
  return { type: 'team/member', seq: SessionSeq(0), time: 0, data: { version: 4, teamId: TeamId(header.id), defaultModel, ...extra } } as unknown as SessionEvent
}

describe('团队默认模型配置投影', () => {
  it('专用v4保持完整roster/tasks原引用，模型独立保存与清除', () => {
    const roster = teamProjectionDefinition.init(header)
    expect(teamProjectionDefinition.apply(roster, config())).toBe(roster)
    const initial = teamModelsProjectionDefinition.init(header)
    const saved = teamModelsProjectionDefinition.apply(initial, config())
    expect(saved.defaultModel).toEqual(route)
    expect(saved.choices).toBe(initial.choices)
    expect(teamModelsProjectionDefinition.wire.view(saved)).toEqual({ choices: {}, defaultModel: route })
    const cleared = teamModelsProjectionDefinition.apply(saved, config(null))
    expect(cleared).not.toHaveProperty('defaultModel')
    expect(cleared.choices).toBe(initial.choices)
    expect(teamModelsProjectionDefinition.stateVersion).toBe(2)
  })
  it('成员v3选择与默认v4交错时互不丢字段', () => {
    const initial = teamModelsProjectionDefinition.apply(teamModelsProjectionDefinition.init(header), config())
    const member = { id: SessionId('child'), name: 'coder', description: '任务', provider: 'spawn', context: 'fresh' as const, phase: 'active' as const }
    const choice = { selection: { provider: 'mock', model: 'fast' }, effectiveAfterTurn: 2 }
    const memberEvent = { ...config(), data: { version: 3, teamId: TeamId(header.id), member, modelChoice: choice } } as SessionEvent
    const changed = teamModelsProjectionDefinition.apply(initial, memberEvent)
    expect(changed.defaultModel).toEqual(route)
    const cleared = teamModelsProjectionDefinition.apply(changed, config(null))
    expect(cleared.choices.child).toEqual(choice)
  })
  it('foreign v4事件不污染本团队，即使payload非法', () => {
    const event = config({}, { teamId: TeamId('foreign'), member: {} })
    const roster = teamProjectionDefinition.init(header)
    const models = teamModelsProjectionDefinition.init(header)
    expect(teamProjectionDefinition.apply(roster, event)).toBe(roster)
    expect(teamModelsProjectionDefinition.apply(models, event)).toBe(models)
  })
  it.each([0, 5, '4', null])('拒绝未知或非法团队配置版本%j', version => {
    const event = config(route, { version })
    expect(teamProjectionDefinition.apply(teamProjectionDefinition.init(header), event).failure).toBeDefined()
    expect(teamModelsProjectionDefinition.apply(teamModelsProjectionDefinition.init(header), event).failure).toBeDefined()
  })

  it('version1模型checkpoint从日志重放，不遗漏默认且保留成员choice', async () => {
    const ctx = new Context()
    const registry = ctx.plugin(SessionProjectionRegistry)
    try {
      await registry
      ctx.sessionProjections.register(teamModelsProjectionDefinition)
      const choice = { selection: { provider: 'mock', model: 'fast' }, effectiveAfterTurn: 2 }
      const member = { id: SessionId('child'), name: 'coder', description: '任务', provider: 'spawn', context: 'fresh', phase: 'active' }
      const first = { ...config(), data: { version: 3, teamId: TeamId(header.id), member, modelChoice: choice } } as SessionEvent
      const second = { ...config(), seq: SessionSeq(1) }
      const restored = ctx.sessionProjections.restore(
        { agentTeamModels: { ver: 1, seq: SessionSeq(1), val: { rootId: header.id, choices: { child: choice } } } },
        [first, second], SessionLogOffset(0), header, SessionLogOffset(0),
      )
      const state = teamModelsProjectionDefinition.stateSchema.parse(restored.checkpoint.agentTeamModels!.val)
      expect(state.defaultModel).toEqual(route)
      expect(state.choices.child).toEqual(choice)
    } finally { await registry.dispose() }
  })

  it.each([
    [{}, {}], [undefined, {}], [{ provider: '', model: 'fast' }, {}],
    [{ provider: 'mock', model: 'fast', reasoningEffort: '' }, {}],
    [{ provider: 'mock', model: 'fast', reasoningEffort: '   ' }, {}],
    [{ provider: 'mock', model: 'fast', extra: true }, {}],
    [route, { member: {} }], [route, { extra: true }], [route, { teamId: '' }],
  ])('拒绝非法v4配置%j/%j', (value, extra) => {
    const event = config(value, extra)
    if (value === undefined) (event.data as { defaultModel?: unknown }).defaultModel = undefined
    expect(teamProjectionDefinition.apply(teamProjectionDefinition.init(header), event).failure).toBeDefined()
    expect(teamModelsProjectionDefinition.apply(teamModelsProjectionDefinition.init(header), event).failure).toBeDefined()
  })
})
