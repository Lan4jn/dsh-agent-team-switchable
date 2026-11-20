import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { createIntegrationHost, createLeadAgent, createTeammateAgent, makeReq, makeRes } from './integration-support.mjs'

const NAME = 'dsh-team-member-model'
const BASE = `/api/${NAME}`
const RPC_CHANNEL = '/dsh-team-member-model'
const RPC = 'team-member-model'
const PEER = { id: 'peer-remote', principal: { kind: 'owner' } }

/** 假 Connection：只提供本插件用到的 admit（返回真 Peer 或 rejection）。 */
function makeConnection(admission) {
  return {
    requestRejection: () => undefined,
    admit: () => admission ?? { peer: PEER },
  }
}

async function setup(options = {}) {
  const host = await createIntegrationHost({ connection: makeConnection(options.admission) })
  const lead = host.registerLead(createLeadAgent('lead-1'))
  host.registerTeammate(lead, createTeammateAgent('member-1', 'lead-1', 'worker-1'), 'worker-1')
  await apply(host.ctx, {})
  const route = host.captured.routes.find(entry => entry.path === RPC_CHANNEL)
  return { host, lead, route }
}

async function http(host, method, path, headers = {}, body = undefined) {
  return host.apiRequest(method, `${BASE}${path}`, headers, body)
}

/** 走真实 RPC 路由：POST channel/<endpoint> + 官方 client-request envelope。 */
async function call(route, endpoint, payload = {}, options = {}) {
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload })
  const req = makeReq('POST', `${RPC_CHANNEL}/${endpoint}`, { 'content-type': 'application/json', ...(options.headers ?? {}) }, envelope)
  const res = makeRes()
  await route.handler(req, res)
  let parsed
  try { parsed = res.body === '' ? undefined : JSON.parse(res.body) } catch { parsed = undefined }
  if (parsed?.type === 'server-response') return { status: res.statusCode, result: parsed.result, envelope: parsed }
  return { status: res.statusCode, text: res.body }
}

test('RPC 路由挂在独立 channel，不再占用官方 /api 单槽，也不在 HTTP prefix 下', async () => {
  const { host, route } = await setup()
  try {
    assert.ok(route, `必须注册 ${RPC_CHANNEL} 路由`)
    assert.equal(route.kind, 'prefix')
    assert.notEqual(route.path, '/api')
    assert.equal(route.path.startsWith(BASE), false, 'RPC channel 不得与 HTTP prefix 重叠')
    const httpRoute = host.captured.routes.find(entry => entry.path === BASE)
    assert.equal(httpRoute.kind, 'prefix', '旧 HTTP 路由仍然存在')
    assert.equal(host.captured.routes.filter(entry => entry.path === RPC_CHANNEL).length, 1, '只注册一次')
  } finally { await host.cleanup() }
})

test('7 个操作与 HTTP 结果一致（同一 executeApi）', async () => {
  const { host, route } = await setup()
  try {
    const pairs = [
      ['state', '/state'],
      ['usage', '/usage'],
      ['efforts', '/efforts?provider=zai-coding-cn&model=glm-5.3', { provider: 'zai-coding-cn', model: 'glm-5.3' }],
      ['teams', '/teams?sessionId=lead-1', { sessionId: 'lead-1' }],
    ]
    for (const [op, path, payload] of pairs) {
      const rpc = await call(route, `${RPC}/${op}`, payload ?? {})
      const viaHttp = await http(host, 'GET', path)
      assert.equal(rpc.result.ok, true, op)
      assert.equal(rpc.result.value.status, viaHttp.status, `${op} status`)
      assert.deepEqual(rpc.result.value.body, viaHttp.body, `${op} body 必须与 HTTP 完全一致`)
    }
  } finally { await host.cleanup() }
})

test('写操作与 HTTP 写同一份状态', async () => {
  const { host, route } = await setup()
  try {
    const policy = { members: [], rules: [] }
    const saved = await call(route, `${RPC}/savePolicy`, { policy })
    assert.equal(saved.result.value.status, 200)
    assert.deepEqual(saved.result.value.body.policy, (await http(host, 'GET', '/state')).body.policy)

    const before = await call(route, `${RPC}/teams`, { sessionId: 'lead-1' })
    const revision = before.result.value.body.view.revision
    const merged = await call(route, `${RPC}/saveTeam`, {
      sessionId: 'lead-1',
      target: 'member-1',
      selection: { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high' },
      revision,
    })
    assert.equal(merged.result.value.status, 200)
    const teamsHttp = await http(host, 'GET', '/teams?sessionId=lead-1')
    assert.deepEqual(teamsHttp.body.view, merged.result.value.body.view)
    assert.equal(merged.result.value.body.view.members[0].nextModel.provider, 'zai-coding-cn')

    const cleared = await call(route, `${RPC}/resetUsage`, {})
    assert.equal(cleared.result.value.body.totals.totalTokens, 0)
    assert.deepEqual((await http(host, 'GET', '/usage')).body, cleared.result.value.body)
  } finally { await host.cleanup() }
})

test('严格 payload：缺字段 / 多字段 / 类型错 / 过大一律业务 400/413', async () => {
  const { host, route } = await setup()
  try {
    const cases = [
      ['state', { extra: 1 }],
      ['efforts', { provider: 'zai-coding-cn' }],
      ['teams', {}],
      ['savePolicy', { policy: 'not-a-document' }],
      ['savePolicy', { policy: { members: [] }, extra: true }],
      ['saveTeam', { sessionId: 'lead-1', target: null, selection: null }],
      ['saveTeam', { sessionId: 'lead-1', target: null, selection: null, revision: '0' }],
      ['saveTeam', { sessionId: 'lead-1', target: null, selection: { provider: 'x' }, revision: 0 }],
      ['saveTeam', { sessionId: 'lead-1', target: 42, selection: null, revision: 0 }],
    ]
    for (const [op, payload] of cases) {
      const result = await call(route, `${RPC}/${op}`, payload)
      assert.equal(result.result.value.status, 400, `${op} ${JSON.stringify(payload)} 必须 400`)
    }
    const huge = await call(route, `${RPC}/savePolicy`, { policy: { members: [], rules: [], match: ['x'.repeat(1024 * 1024)] } })
    assert.equal(huge.status, 413)
    assert.match(huge.text, /请求体过大/)
  } finally { await host.cleanup() }
})

test('官方 admit 拒绝时按官方状态码 fail-closed，不进入业务', async () => {
  for (const [admission, expected] of [[{ rejection: 401 }, 401], [{ rejection: 403 }, 403]]) {
    const { host, route } = await setup({ admission })
    try {
      const result = await call(route, `${RPC}/teams`, { sessionId: 'lead-1' })
      assert.equal(result.status, expected)
      assert.equal(result.envelope, undefined)
    } finally { await host.cleanup() }
  }
})

test('异常请求：非 POST / 非 JSON / 坏 envelope / 未知 endpoint 都有明确结果', async () => {
  const { host, route } = await setup()
  try {
    const getReq = makeReq('GET', `${RPC_CHANNEL}/${RPC}/teams`)
    const getRes = makeRes()
    await route.handler(getReq, getRes)
    assert.equal(getRes.statusCode, 404)

    const badType = await call(route, `${RPC}/teams`, { sessionId: 'lead-1' }, { headers: { 'content-type': 'text/plain' } })
    assert.equal(badType.status, 415)

    const badEnvelope = makeReq('POST', `${RPC_CHANNEL}/${RPC}/teams`, { 'content-type': 'application/json' }, '{"nope":true}')
    const badRes = makeRes()
    await route.handler(badEnvelope, badRes)
    assert.equal(badRes.statusCode, 400)

    const mismatch = makeReq('POST', `${RPC_CHANNEL}/${RPC}/teams`, { 'content-type': 'application/json' }, JSON.stringify({ type: 'client-request', rpcId: 'r', method: `${RPC}/usage`, payload: {} }))
    const mismatchRes = makeRes()
    await route.handler(mismatch, mismatchRes)
    const envelope = JSON.parse(mismatchRes.body)
    assert.equal(envelope.result.error.code, 'gateway/bad-request')

    const unknown = await call(route, `${RPC}/routes`, { routes: [] })
    assert.equal(unknown.result.value.status, 404)
    assert.match(unknown.result.value.body.error, /unknown endpoint/)
  } finally { await host.cleanup() }
})

test('业务授权不因换 carrier 而放宽：跨角色 403、陈旧 409、Lead 不可改', async () => {
  const { host, route } = await setup()
  try {
    const crossRole = await call(route, `${RPC}/saveTeam`, { sessionId: 'member-1', target: null, selection: null, revision: 0 })
    assert.equal(crossRole.result.value.status, 403)

    const stale = await call(route, `${RPC}/saveTeam`, {
      sessionId: 'lead-1', target: 'member-1', selection: { provider: 'zai-coding-cn', model: 'glm-5.3' }, revision: 99,
    })
    assert.equal(stale.result.value.status, 409)
    assert.equal(stale.result.value.body.code, 'stale-revision')

    const leadTarget = await call(route, `${RPC}/saveTeam`, {
      sessionId: 'lead-1', target: 'lead-1', selection: { provider: 'zai-coding-cn', model: 'glm-5.3' }, revision: 0,
    })
    assert.equal(leadTarget.result.value.status, 400)
    assert.match(leadTarget.result.value.body.error, /Lead 不可/)
  } finally { await host.cleanup() }
})

test('RPC 写成员模型有效，可清空为继承默认', async () => {
  const { host, route } = await setup()
  try {
    const current = await call(route, `${RPC}/teams`, { sessionId: 'lead-1' })
    let revision = current.result.value.body.view.revision
    const set = await call(route, `${RPC}/saveTeam`, {
      sessionId: 'lead-1', target: 'member-1', selection: { provider: 'zai-coding-cn', model: 'glm-5.3' }, revision,
    })
    assert.deepEqual(set.result.value.body.view.members.find(m => m.id === 'member-1').nextModel, { provider: 'zai-coding-cn', model: 'glm-5.3' })

    revision = set.result.value.body.view.revision
    const cleared = await call(route, `${RPC}/saveTeam`, { sessionId: 'lead-1', target: 'member-1', selection: null, revision })
    assert.equal(cleared.result.value.body.view.members.find(m => m.id === 'member-1').nextModel, undefined)

    revision = cleared.result.value.body.view.revision
    const defaulted = await call(route, `${RPC}/saveTeam`, { sessionId: 'lead-1', target: null, selection: { provider: 'zai-coding-cn', model: 'glm-5.3' }, revision })
    assert.deepEqual(defaulted.result.value.body.view.defaultModel, { provider: 'zai-coding-cn', model: 'glm-5.3' })
    const inherit = await call(route, `${RPC}/saveTeam`, { sessionId: 'lead-1', target: null, selection: null, revision: defaulted.result.value.body.view.revision })
    assert.equal(inherit.result.value.body.view.defaultModel, null)
  } finally { await host.cleanup() }
})

test('缺 connection.admit 时不注册 RPC 路由，HTTP 设置页照旧可用', async () => {
  const host = await createIntegrationHost({ connection: { requestRejection: () => undefined } })
  try {
    await apply(host.ctx, {})
    assert.equal(host.captured.routes.some(entry => entry.path === RPC_CHANNEL), false)
    const state = await http(host, 'GET', '/state')
    assert.equal(state.status, 200)
  } finally { await host.cleanup() }
})
