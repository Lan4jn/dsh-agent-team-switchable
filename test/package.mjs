/**
 * test/package.mjs
 * 验证 0.7.10 包元数据契约、导出映射、打包文件完整性与离线加载可用性。
 * 运行方式：node --test test/package.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = new URL('..', import.meta.url).pathname
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

test('Package Contract: 版本与 DSH 引擎要求', () => {
  assert.equal(manifest.name, 'dsh-team-member-model')
  assert.equal(manifest.version, '0.7.12')
  assert.equal(manifest.engines?.dsh, '>=0.2.2-rc.3')
})

test('Package Contract: exports 映射包含新增 Host 状态与路由子路径', () => {
  const exportsMap = manifest.exports
  assert.ok(exportsMap, 'package.json 必须定义 exports')
  assert.equal(exportsMap['.']?.default, './lib/index.js')
  assert.equal(exportsMap['./rules']?.default, './lib/rules.js')
  assert.equal(exportsMap['./usage']?.default, './lib/usage.js')
  assert.equal(exportsMap['./skill']?.default, './lib/skill.js')
  assert.equal(exportsMap['./client']?.default, './lib/client.js')
  assert.equal(exportsMap['./team-state']?.default, './lib/team-state.js')
  assert.equal(exportsMap['./team-routing']?.default, './lib/team-routing.js')
  assert.equal(exportsMap['./package.json'], './package.json')
  // 确认已删除的 team-client 不存在于 exports
  assert.equal(exportsMap['./team-client'], undefined)
})

test('Package Contract: files 清单完整包含新增 team 模块且不含已删除文件', () => {
  const files = manifest.files
  assert.ok(Array.isArray(files), 'package.json 必须定义 files 数组')

  const expectedFiles = [
    'lib/index.js',
    'lib/rules.js',
    'lib/usage.js',
    'lib/skill.js',
    'lib/team-state.js',
    'lib/team-routing.js',
    'skills/model-routing/SKILL.md',
    'lib/client.js',
    'cordis.patch.yml',
    'docs/model-routing-guide.md',
    'docs/spec.md',
    'README.md',
  ]

  for (const f of expectedFiles) {
    assert.ok(files.includes(f), `files 清单缺少必要交付文件: ${f}`)
    assert.ok(existsSync(join(root, f)), `文件在磁盘上必须实际存在: ${f}`)
  }

  // 严禁打包已删除的 team-client.js
  assert.ok(!files.includes('lib/team-client.js'), 'files 清单严禁包含已删除的 lib/team-client.js')
})

test('Package Contract: DSH 组合包与 Client 平台注入规范', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  const clientInject = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(clientInject))
  assert.ok(clientInject.includes('@deepseek-ai/dsh-client-ui-slots'))
  // 远端模型设置必须走官方连接通道：Client 半侧 inject 需要它，缺了就只能读本机 origin。
  assert.ok(clientInject.includes('@deepseek-ai/dsh-client-connection'), 'dsh.client.inject 必须声明官方连接包')
})

test('Package Contract: 组合包 cordis.patch.yml 格式有效性', () => {
  const patchPath = join(root, manifest.dsh.bundle.patch)
  assert.ok(existsSync(patchPath), 'cordis.patch.yml 文件必须存在')
  const content = readFileSync(patchPath, 'utf8')
  assert.match(content, /- insert:/)
  assert.match(content, /id: team-member-model/)
  assert.match(content, /name:\s*['"]dsh-team-member-model['"]/)
})

test('Package Contract: 离线静态 require/import 可解析性', async () => {
  // 1. 验证 Host 模块可正常被 Node ESM 导入
  const indexMod = await import('../lib/index.js')
  assert.equal(typeof indexMod.apply, 'function')
  assert.equal(indexMod.name, 'team-member-model')

  const stateMod = await import('../lib/team-state.js')
  assert.equal(typeof stateMod.TeamStateStore, 'function')

  const routingMod = await import('../lib/team-routing.js')
  assert.equal(typeof routingMod.resolveTeamRoute, 'function')

  // 2. 验证 Client 模块可正常在 ModuleLoader 沙箱中加载
  const clientCode = readFileSync(join(root, 'lib/client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          registered = def
        },
      },
    },
    document: {
      head: { appendChild() {} },
      querySelector() { return null },
      createElement() { return { dataset: {}, textContent: '' } },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientCode, sandbox)
  assert.ok(registered, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-team-member-model')
  assert.equal(typeof registered.factory, 'function')
})
