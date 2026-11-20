import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAM_SETTINGS_DOMAIN } from '../../src/types.ts'
import { boot } from './durable-support.ts'

const oldRoute = { provider: 'p', model: 'old', reasoningEffort: 'high' }
const chosen = { provider: 'q', model: 'next', reasoningEffort: 'low' }
const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-team-model-'))
const file = (dir: string) => join(dir, `${TEAM_SETTINGS_DOMAIN}.json`)
const storedRecord = (dir: string, team: string) => JSON.parse(readFileSync(file(dir), 'utf8')).tables.teams[team]

/** Boot the plugin once, save one member choice through the real RPC, then unload it. */
async function warmSave(dir: string) {
  const first = boot(dir)
  const fiber = await first.start()
  expect(first.registry.size).toBe(0)
  const lead = first.agent('lead-1')
  const member = first.agent('member-1', 'worker', lead.live)
  await first.announce(lead.live)
  await first.announce(member.live)
  first.request('member-1', oldRoute)
  first.turn('member-1', 1)
  await first.root.teamModelSettings.selectMemberModel({ leadSessionId: 'lead-1', target: 'worker', selection: chosen })
  return { first, unload: async () => { await fiber.dispose() } }
}

async function coldBoot(dir: string) {
  const second = boot(dir)
  await second.start()
  expect(second.registry.size).toBe(0)
  const lead = second.agent('lead-1')
  const member = second.agent('member-1', 'worker', lead.live)
  second.request('member-1', oldRoute)
  second.turn('member-1', 1)
  await second.announce(lead.live)
  await second.announce(member.live)
  return { second, lead, member }
}

describe('持久化冷恢复与下一轮路由', () => {
  it('choice 写真实 Domain 落盘，关域后重建空 agents 冷载，eff 前保持上一轮、eff+1 才用 chosen，default/Lead 不变', async () => {
    const dir = tempDir()
    const { first, unload } = await warmSave(dir)

    // Real durable medium, not the in-memory committed map: the saved choice is on disk.
    expect(storedRecord(dir, 'lead-1').choices['member-1']).toEqual({ selection: chosen, effectiveAfterTurn: 1 })
    // Saving must not split the turn already in flight: a turn/start at the commit turn
    // (a replayed or queued event for the same turn) still changes nothing.
    first.turn('member-1', 1)
    expect((await first.assemble(first.registry.get('member-1')!)).config).toEqual(oldRoute)
    await unload()

    const { second, lead, member } = await coldBoot(dir)
    // Restored real domain, read back from the file: still the previous round, no invented route.
    expect((await second.assemble(member.live)).config).toEqual(oldRoute)
    // What a reopened settings view reports for a running menu: configured next, current untouched.
    const view = await second.root.teamModelSettings.getSettings({ leadSessionId: 'lead-1' })
    expect(view.defaultModel).toBeNull()
    expect(view.members).toEqual([expect.objectContaining({ id: 'member-1', name: 'worker', currentModel: oldRoute, nextModel: chosen })])
    // The next own turn, and only it, routes the saved choice.
    second.turn('member-1', 2)
    expect((await second.assemble(member.live)).config).toEqual(chosen)
    expect((await second.assemble(member.live)).config).toEqual(chosen)
    // Lead and the team default stay entirely untouched by a member choice.
    expect(view.defaultModel).toBeNull()
    expect(second.roles.get(lead.live)?.role).toBe('lead')
    expect((await second.assemble(lead.live)).config).toEqual({ provider: 'inherited', model: 'base', reasoningEffort: 'high' })
  })

  it('介质中没有 choice 时冷恢复保持官方继承，不把上一轮请求或 default 当选择', async () => {
    const dir = tempDir()
    const { first, unload } = await warmSave(dir)
    await unload()
    const record = storedRecord(dir, 'lead-1')
    writeFileSync(file(dir), JSON.stringify({
      ...JSON.parse(readFileSync(file(dir), 'utf8')),
      tables: { teams: { 'lead-1': { ...record, choices: {} } } },
    }))

    const { second, member } = await coldBoot(dir)
    expect((await second.assemble(member.live)).config).toEqual(oldRoute)
    second.turn('member-1', 2)
    expect((await second.assemble(member.live)).config).toEqual(oldRoute)
    const view = await second.root.teamModelSettings.getSettings({ leadSessionId: 'lead-1' })
    expect(view.defaultModel).toBeNull()
    expect(view.members[0]).not.toHaveProperty('nextModel')
  })
})
