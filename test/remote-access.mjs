import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { createIntegrationHost } from './integration-support.mjs'

const base = '/api/dsh-team-member-model'

for (const [title, verdict, expected] of [
  ['认证通过的远程 Host', undefined, 200],
  ['认证缺失', 401, 401],
  ['跨来源被官方拒绝', 403, 403],
]) {
  test(title, async () => {
    const seen = []
    const host = await createIntegrationHost({ connection: { requestRejection(request) { seen.push(request.headers); return verdict } } })
    try {
      await apply(host.ctx, {})
      const result = await host.apiRequest('GET', `${base}/state`, { host: 'remote.example:443', origin: 'https://remote.example' })
      assert.equal(result.status, expected)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].host, 'remote.example:443')
      if (verdict) assert.equal(result.body.ok, false)
    } finally { await host.cleanup() }
  })
}

test('缺少官方连接服务或方法时关闭所有接口', async () => {
  for (const connection of [undefined, {}]) {
    const host = await createIntegrationHost({ connection })
    try {
      await apply(host.ctx, {})
      for (const [method, path] of [['GET','/state'], ['GET','/efforts'], ['GET','/usage'], ['GET','/teams'], ['PUT','/policy'], ['PUT','/teams'], ['PUT','/usage/reset']]) {
        const result = await host.apiRequest(method, base + path)
        assert.equal(result.status, 503, `${method} ${path}`)
      }
    } finally { await host.cleanup() }
  }
})

test('官方拒绝写入时不落盘策略', async () => {
  const host = await createIntegrationHost({ connection: { requestRejection: () => 403 } })
  try {
    await apply(host.ctx, {})
    const before = await host.apiRequest('PUT', `${base}/policy`, { 'x-dsh-team-member-model': '1' }, { members: [] })
    assert.equal(before.status, 403)
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(host.dshHome, { recursive: true })
    assert.ok(!files.some(name => String(name).endsWith('policy.json')))
  } finally { await host.cleanup() }
})
