import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-agent-team-switchable'
const require = createRequire(import.meta.url)
const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { TYPERT } = await import(pathToFileURL(join(root, 'lib/typert.host.js')))
const { TYPERT_REMOTE } = await import(pathToFileURL(join(root, 'lib/typert.remote-client.js')))
const { TEAM_SETTINGS_DOMAIN } = await import(pathToFileURL(join(root, 'lib/types.js')))
const clientCode = await readFile(join(root, 'lib/client.js'), 'utf8')
const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }
const committedView = { teamId: 'lead', revision: 2, defaultModel: selection, members: [{ id: 'child', name: 'worker', phase: 'active', status: 'inactive', currentModel: { provider: 'previous', model: 'last-used' }, nextModel: selection }] }
const plain = value => JSON.parse(JSON.stringify(value))

function browserRealm() {
  let registration
  const styles = []
  const imports = []
  const document = { getElementById: id => styles.find(style => style.id === id), createElement: tag => ({ tagName: tag }), head: { appendChild: style => styles.push(style) } }
  runInNewContext(clientCode, { window: { __ModuleLoader__: { load: contribution => { registration = contribution } } }, document, console })
  assert.equal(registration.id, packageName)
  const sharedRequire = specifier => {
    imports.push(specifier)
    if (['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(specifier)) return require(specifier)
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshot => ({ getSnapshot: () => snapshot, subscribe: () => () => {} }) }
    assert.fail(`Unexpected browser require: ${specifier}`)
  }
  return { styles, imports, execute: () => registration.factory(sharedRequire) }
}

test('additive bundle inserts only its own root and never disables or replaces official rows', async () => {
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.dsh.client.platform, 'web')
  const patch = await readFile(join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: team-model-settings/)
  assert.match(patch, /name: dsh-agent-team-switchable\s*$/m)
  assert.doesNotMatch(patch, /disabled:|@deepseek-ai\/|name:.*\/(?:runtime|tools|client)/)
  assert.equal((patch.match(/\bid:/g) ?? []).length, 1)
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-experimental-agent-team'].optional, true)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-storage-domain'], '0.2.0-rc.2')
})

test('replacement runtime entries and copied team implementation no longer exist', async () => {
  for (const key of ['./runtime', './tools', './invariant']) assert.equal(manifest.exports[key], undefined)
  const sources = await readdir(join(root, 'src'))
  assert.ok(!sources.includes('runtime'))
  assert.ok(!sources.includes('tools'), 'tools.ts is additive; the copied official tools directory is forbidden')
  const built = await readdir(join(root, 'lib'))
  for (const stale of ['runtime.js', 'tools.js', 'invariant.js']) assert.ok(!built.includes(stale), stale)
})

test('own storage unit name conforms to the unmodified public Storage Domain SDK', () => {
  assert.equal(TEAM_SETTINGS_DOMAIN, 'agent_team_model_settings')
  assert.match(TEAM_SETTINGS_DOMAIN, /^[a-z][a-z0-9_]*$/)
})

test('all public exports exist, and browser types include their CSS declaration', async () => {
  for (const [key, target] of Object.entries(manifest.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) assert.ok((await stat(join(root, path))).isFile(), `${key}: ${path}`)
  }
  assert.match(await readFile(join(root, manifest.exports['./client'].types), 'utf8'), /<reference path="\.\/css-modules\.d\.ts"/)
  assert.match(await readFile(join(root, 'src/client/css-modules.d.ts'), 'utf8'), /declare module '\*\.module\.css'/)
})

test('Host and Client use three plugin-owned read/write RPCs, not official namespaces', () => {
  assert.equal(TYPERT.package, packageName)
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(TYPERT.schemas, [])
  assert.deepEqual(TYPERT.model, { services: [], events: [], objects: [] })
  assert.deepEqual(plain(TYPERT.invocations), plain(TYPERT_REMOTE.descriptors))
  assert.deepEqual(TYPERT.invocations.map(value => value.method), ['getSettings', 'selectMemberModel', 'selectTeamDefaultModel'])
  for (const descriptor of TYPERT.invocations) {
    assert.equal(descriptor.id, `${packageName}#team-model-settings/${descriptor.method}`)
    assert.equal(descriptor.service, 'teamModelSettings')
    assert.equal(descriptor.namespace, 'team-model-settings')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.equal(descriptor.parameters[0].source, 'json')
    assert.equal(descriptor.result.typeSymbol, `${packageName}/types#TeamModelSettingsView`)
    for (const codec of [descriptor.parameters[0].codec, descriptor.result]) {
      assert.equal(codec.mode, 'strict')
      assert.equal(codec.create(), codec.create())
    }
  }
})

test('real codecs accept nullable defaults and committed views but reject partial routes', () => {
  for (const descriptors of [TYPERT.invocations, TYPERT_REMOTE.descriptors]) {
    const [read, member, defaults] = descriptors
    assert.deepEqual(read.parameters[0].codec.create().parse({ leadSessionId: 'lead' }), { leadSessionId: 'lead' })
    assert.deepEqual(member.parameters[0].codec.create().parse({ leadSessionId: 'lead', target: 'worker', selection }), { leadSessionId: 'lead', target: 'worker', selection })
    assert.deepEqual(defaults.parameters[0].codec.create().parse({ leadSessionId: 'lead', selection: null }), { leadSessionId: 'lead', selection: null })
    assert.throws(() => member.parameters[0].codec.create().parse({ leadSessionId: 'lead', target: 'worker', selection: { model: 'm' } }))
    assert.throws(() => defaults.parameters[0].codec.create().parse({ leadSessionId: 'lead' }))
    for (const descriptor of descriptors) {
      assert.deepEqual(descriptor.result.create().parse(committedView), committedView)
      assert.throws(() => descriptor.result.create().parse(selection))
    }
  }
})

test('browser factory uses shared singletons and injects its hashed CSS exactly once', () => {
  const realm = browserRealm()
  assert.equal(realm.styles.length, 0)
  const plugin = realm.execute()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plain(plugin.inject), ['slots', 'locale', 'remote', 'modelDirectories'])
  assert.equal(realm.styles.length, 1)
  assert.match(realm.styles[0].id, /^dsh-agent-team-switchable-[a-f0-9]{12}$/)
  assert.match(realm.styles[0].textContent, /\.team_[A-Za-z0-9_-]+_/)
  realm.execute()
  assert.equal(realm.styles.length, 1)
  assert.ok(realm.imports.includes('react/jsx-runtime'))
  assert.ok(realm.imports.includes('@deepseek-ai/dsh-client-store'))
})

test('browser mounts only its own remote/header action and releases owned effects', async () => {
  const plugin = browserRealm().execute()
  const effects = [], slots = []
  let mounted, remoteDisposed = 0, uiDisposed = 0
  const ctx = {
    remote: { async $mount(value) { mounted = value; return async () => { remoteDisposed++ } }, 'team-model-settings': {} },
    locale: { register() { return () => {} } },
    modelDirectories: { directoryFor() { return {} } },
    effect(fn) { effects.push(fn) },
    slots: { inject(_key, fn) { fn() }, register(definition, component) { slots.push({ definition, component }) } },
    inject(keys, fn) {
      assert.deepEqual(plain(keys), ['remote.team-model-settings'])
      fn(ctx)
      return Object.assign(Promise.resolve(), { async dispose() { uiDisposed++ } })
    },
  }
  await plugin.apply(ctx)
  assert.deepEqual(plain(mounted.descriptors), plain(TYPERT_REMOTE.descriptors))
  assert.equal(slots[0].definition.id, 'team-model-settings')
  assert.equal(slots[0].definition.name, 'conversation.session.header.actions')
  await effects.at(-1)()()
  assert.equal(uiDisposed, 1)
  assert.equal(remoteDisposed, 1)
})

test('compiled artifacts contain no Core implementations, personal paths or replacement routes', async () => {
  for (const file of await readdir(join(root, 'lib'))) {
    const text = await readFile(join(root, 'lib', file), 'utf8')
    assert.doesNotMatch(text, /dsh-agent-team-models|\/Users\/|packages\/experimental|\/node_modules\/@deepseek-ai\//, file)
    assert.doesNotMatch(text, /agent-team-models|teamModelController|class TeamRoster|class TeamJournal|class TeamTaskBoard/, file)
  }
  assert.doesNotMatch(clientCode, /require\(["'](?:node:|zod|dsh-agent-team-switchable|@deepseek-ai\/dsh-experimental)/)
  assert.doesNotMatch(clientCode, /typeof require|__require|\bprocess\.|node:/)
})
