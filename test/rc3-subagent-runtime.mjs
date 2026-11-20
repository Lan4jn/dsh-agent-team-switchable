import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { createIntegrationHost, createLeadAgent, createTeammateAgent } from './integration-support.mjs'

// Contract-shaped doubles exercise the real production HTTP handler; the real
// SDK lifecycle integration is a separate required acceptance test.
test('rc3 team settings resolve an authenticated root through subagents', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('rc3-lead')
    host.registerLead(lead)
    const prior = host.ctx.get
    host.ctx.get = (name) => {
      if (name === 'agentTeams') return { isEnabled: (agent) => agent === lead }
      if (name === 'subagents') return {
        rootOf: (agent) => { if (agent !== lead) throw new Error('unauthorized'); return lead },
        listDescendants: async () => [],
      }
      return prior.call(host.ctx, name)
    }
    await apply(host.ctx, {})
    const response = await host.apiRequest('GET', '/api/dsh-team-member-model/teams?sessionId=rc3-lead')
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.view.teamId, 'rc3-lead')
  } finally { await host.cleanup() }
})

test('cold catalog member is unavailable without resuming or altering stored choice', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('unavailable-root')
    const member = createTeammateAgent('unavailable-child', lead.id, 'worker')
    host.registerLead(lead)
    host.registerTeammate(lead, member, 'worker')
    const prior = host.ctx.get
    let childResolves = 0
    host.ctx.get = (name) => name === 'sessionController' ? {
      resolveAgent: async id => { if (id === lead.id) return { agent: lead }; childResolves++; throw new Error('must not resume child') },
    } : prior.call(host.ctx, name)
    await apply(host.ctx, {})
    const headers = { 'content-type': 'application/json', 'x-dsh-team-member-model': '1' }
    const saved = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', headers, {
      sessionId: lead.id, target: member.id, revision: 0, selection: { provider: 'p-new', model: 'm-new' },
    })
    assert.equal(saved.status, 200)
    host.agentRegistry.delete(member.id)
    const read = await host.apiRequest('GET', `/api/dsh-team-member-model/teams?sessionId=${lead.id}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.view.members[0].phase, 'unavailable')
    assert.equal(read.body.view.members[0].currentModel, undefined)
    assert.equal(read.body.view.members[0].nextModel.model, 'm-new')
    const write = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', headers, {
      sessionId: lead.id, target: member.id, revision: read.body.view.revision, selection: { provider: 'p-default', model: 'm-default' },
    })
    assert.equal(write.status, 403)
    assert.equal(childResolves, 0)
    const disk = JSON.parse(await (await import('node:fs/promises')).readFile(`${host.dshHome}/team-member-model/teams.json`, 'utf8'))
    assert.equal(disk[lead.id].choices[member.id].selection.model, 'm-new')
  } finally { await host.cleanup() }
})

test('rc3 local activation reserves a stable child identity', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('reserve-lead')
    host.registerLead(lead)
    const raw = host.ctx.reflect._getImpl('subagents').value
    raw.getProvider = () => ({ name: 'spawn', capabilities: { agentOptions: true }, prepareContinuable: async () => ({}) })
    let received
    raw.startActivation = async (spec) => { received = spec; return { childId: spec.childId, name: spec.name } }
    const prior = host.ctx.get
    host.ctx.get = (name) => name === 'agentTeams' ? { isEnabled: (agent) => agent === lead } : name === 'subagents' ? raw : prior.call(host.ctx, name)
    raw.rootOf = (agent) => { if (agent !== lead) throw new Error('unauthorized'); return lead }
    raw.listDescendants = async () => []
    await apply(host.ctx, {})
    const spec = { provider: 'spawn', name: 'worker', label: 'task', parent: lead, prompt: [], delivery: 'parent', signal: new AbortController().signal }
    const result = await raw.startActivation(spec)
    assert.match(received.childId, /^[0-9a-f-]{36}$/i)
    assert.equal(result.childId, received.childId)
    assert.equal(spec.childId, undefined)
  } finally { await host.cleanup() }
})

test('rc3 member write uses live root identity and current revision', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('rc3-lead')
    const member = createTeammateAgent('rc3-child', 'rc3-lead', 'worker')
    host.registerLead(lead)
    host.registerTeammate(lead, member, 'worker')
    const prior = host.ctx.get
    let readCount = 0
    host.ctx.get = (name) => {
      if (name === 'agentTeams') return { isEnabled: (agent) => agent === lead }
      if (name === 'subagents') return {
        rootOf: (agent) => { if (agent !== lead && agent !== member) throw new Error('unauthorized'); return lead },
        listDescendants: async () => {
          if (++readCount === 2) member._setTurn(7)
          return [{ kind: 'child', id: member.id, mode: 'continuable', activity: 'inactive', name: 'worker', parentId: lead.id, depth: 1, hasChildren: false }]
        },
      }
      return prior.call(host.ctx, name)
    }
    await apply(host.ctx, {})
    const headers = { 'content-type': 'application/json', 'x-dsh-team-member-model': '1' }
    const result = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', headers, {
      sessionId: lead.id, target: member.id, revision: 0, selection: { provider: 'p-new', model: 'm-new' },
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.view.members[0].nextModel.model, 'm-new')
    const disk = JSON.parse(await (await import('node:fs/promises')).readFile(`${host.dshHome}/team-member-model/teams.json`, 'utf8'))
    assert.equal(disk[lead.id].choices[member.id].effectiveAfterTurn, 7)
    const invalid = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams', headers, {
      sessionId: lead.id, target: member.id, revision: result.body.view.revision,
      selection: { provider: 'p-new', model: 'm-new', reasoningEffort: 'not-advertised' },
    })
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body))
  } finally { await host.cleanup() }
})

test('published subagent start binds stored choice before first claimed step', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('cold-root')
    const member = createTeammateAgent('cold-child', lead.id, 'worker')
    host.registerLead(lead)
    host.registerTeammate(lead, member, 'worker')
    await apply(host.ctx, {})
    const result = await host.apiRequest('PUT', '/api/dsh-team-member-model/teams',
      { 'content-type': 'application/json', 'x-dsh-team-member-model': '1' },
      { sessionId: lead.id, target: member.id, revision: 0, selection: { provider: 'p-new', model: 'm-new' } })
    assert.equal(result.status, 200)
    member._emitClaimed = undefined
    member._setTurn(2)
    await host.emitEvent('subagent/start', { id: member.id, local: true, parentSessionId: lead.id, provider: 'spawn', runId: 'r' })
    assert.deepEqual(member.model.current(), { provider: 'p-new', model: 'm-new' })
  } finally { await host.cleanup() }
})

test('cold child is rebound only after managed publication', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('cold-publish-root')
    const member = createTeammateAgent('cold-publish-child', lead.id, 'worker')
    host.registerLead(lead)
    host.registerTeammate(lead, member, 'worker')
    const { TeamStateStore } = await import('../lib/team-state.js')
    const store = new TeamStateStore(`${host.dshHome}/team-member-model`)
    await store.init()
    await store.updateTeam(lead.id, (team) => {
      team.choices[member.id] = { selection: { provider: 'p-new', model: 'm-new' }, effectiveAfterTurn: 1 }
      return team
    })
    member._emitClaimed = undefined
    member._setTurn(1)
    let published = false
    const prior = host.ctx.get
    host.ctx.get = (name) => {
      if (name === 'subagents') return {
        rootOf: (agent) => { if (agent === lead) return lead; if (agent === member && published) return lead; throw new Error('UNAUTHORIZED') },
        listDescendants: async () => [],
      }
      return prior.call(host.ctx, name)
    }
    await apply(host.ctx, {})
    await host.emitAgentCreated(member)
    assert.equal(member.model.current(), undefined)
    published = true
    await host.emitEvent('subagent/start', { id: member.id, local: true, parentSessionId: lead.id, provider: 'spawn', runId: 'cold' })
    assert.deepEqual(member.model.current(), { provider: 'p-new', model: 'm-new' })
  } finally { await host.cleanup() }
})

test('rc3 modeled teammate uses the public direct activation spec', async () => {
  const host = await createIntegrationHost()
  try {
    const lead = createLeadAgent('tool-lead')
    host.registerLead(lead)
    const raw = host.ctx.reflect._getImpl('subagents').value
    raw.getProvider = () => ({ name: 'spawn', capabilities: { agentOptions: true }, prepareContinuable: async () => ({}) })
    let received
    raw.startActivation = async (spec) => { received = spec; return { childId: spec.childId, name: spec.name, messageId: 'm1' } }
    raw.rootOf = (agent) => { if (agent !== lead) throw new Error('unauthorized'); return lead }
    raw.listDescendants = async () => []
    const prior = host.ctx.get
    host.ctx.get = (name) => name === 'agentTeams' ? { isEnabled: (agent) => agent === lead } : name === 'subagents' ? raw : prior.call(host.ctx, name)
    await apply(host.ctx, {})
    const tool = host.captured.tools.find(item => item.name === 'spawn_modeled_teammate')
    assert.ok(tool)
    await tool.execute({ name: 'worker', description: 'test', prompt: 'do work' }, { agent: lead, signal: new AbortController().signal })
    assert.equal(received.parent, lead)
    assert.equal(received.name, 'worker')
    assert.equal(received.delivery, 'parent')
    assert.equal(received.request, undefined)
    assert.match(received.childId, /^[0-9a-f-]{36}$/i)
  } finally { await host.cleanup() }
})
