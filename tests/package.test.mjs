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
const clientCode = await readFile(join(root, 'lib/client.js'), 'utf8')
const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }
const plain = value => JSON.parse(JSON.stringify(value))

function browserRealm() {
  let registration
  const styles = []
  const imports = []
  const document = {
    getElementById: id => styles.find(style => style.id === id),
    createElement: tag => ({ tagName: tag }),
    head: { appendChild: style => styles.push(style) },
  }
  runInNewContext(clientCode, {
    window: { __ModuleLoader__: { load: contribution => { registration = contribution } } },
    document, console,
  })
  assert.equal(registration.id, packageName)
  const sharedRequire = specifier => {
    imports.push(specifier)
    if (['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(specifier)) return require(specifier)
    // Only smoke the boundary; do not copy or execute shared Core services.
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (specifier === '@deepseek-ai/dsh-client-store') return {
      createSnapshotStore: snapshot => ({ getSnapshot: () => snapshot, subscribe: () => () => {} }),
    }
    assert.fail(`Unexpected browser require: ${specifier}`)
  }
  return { registration, styles, imports, execute: () => registration.factory(sharedRequire) }
}

test('manifest declares a web bundle and exact independent package identity', async () => {
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('src/'))
  assert.ok(manifest.files.includes('lib/'))
  const patch = await readFile(join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /name: dsh-agent-team-switchable\/runtime\s/)
  assert.match(patch, /name: dsh-agent-team-switchable\/tools\s/)
  assert.match(patch, /name: dsh-agent-team-switchable\s*$/m)
  assert.doesNotMatch(patch, /name: dsh-agent-team-switchable\/client/)
})

test('public client type entry explicitly includes its published CSS module declaration', async () => {
  const entry = await readFile(join(root, manifest.exports['./client'].types), 'utf8')
  assert.match(entry, /<reference path="\.\/css-modules\.d\.ts"/)
  const declaration = await readFile(join(root, 'src/client/css-modules.d.ts'), 'utf8')
  assert.match(declaration, /declare module '\*\.module\.css'/)
  assert.match(declaration, /export default classes/)
  assert.ok(manifest.files.includes('src/'))
})

test('all export targets exist, including own Typert declaration wrappers', async () => {
  for (const [key, target] of Object.entries(manifest.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
      assert.ok((await stat(join(root, path))).isFile(), `${key}: ${path}`)
    }
  }
  assert.equal(manifest.exports['./remote'].types, './lib/typert.remote-client.d.ts')
  assert.equal(manifest.exports['./typert'].types, './lib/typert.host.d.ts')
  assert.match(await readFile(join(root, manifest.exports['./remote'].types), 'utf8'), /src\/remote\.ts/)
  assert.match(await readFile(join(root, manifest.exports['./typert'].types), 'utf8'), /src\/host-contract\.ts/)
})

test('Host and Client descriptors agree and use only the plugin-owned namespace identity', () => {
  assert.equal(TYPERT.package, packageName)
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(TYPERT.schemas, [])
  assert.deepEqual(TYPERT.model, { services: [], events: [], objects: [] })
  assert.equal(TYPERT_REMOTE.package, packageName)
  assert.deepEqual(plain(TYPERT.invocations), plain(TYPERT_REMOTE.descriptors))
  assert.equal(TYPERT.invocations.length, 2)
  for (const descriptor of TYPERT.invocations) {
    assert.equal(descriptor.id, `${packageName}#agent-team-models/${descriptor.method}`)
    assert.equal(descriptor.service, 'teamModelController')
    assert.equal(descriptor.namespace, 'agent-team-models')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.equal(descriptor.parameters.length, 1)
    assert.equal(descriptor.parameters[0].name, 'request')
    assert.equal(descriptor.parameters[0].wire, 'request')
    assert.equal(descriptor.parameters[0].source, 'json')
    for (const codec of [descriptor.parameters[0].codec, descriptor.result]) {
      assert.equal(codec.mode, 'strict')
      assert.ok(codec.typeSymbol.startsWith(packageName))
      assert.equal(codec.create(), codec.create(), 'schema must be lazy and cached')
    }
  }
  const [member, defaults] = TYPERT.invocations
  assert.equal(member.parameters[0].codec.typeSymbol, `${packageName}/types#TeamSelectMemberModelRequest`)
  assert.equal(member.result.typeSymbol, `${packageName}/types#TeamModelSelection`)
  assert.equal(defaults.parameters[0].codec.typeSymbol, `${packageName}/types#TeamSelectDefaultModelRequest`)
  assert.equal(defaults.result.typeSymbol, `${packageName}#agent-team-models/selectTeamDefaultModel:result`)
})

test('real Zod codecs validate full routes, optional effort, nullable defaults and both faces', () => {
  const rejects = (schema, value) => assert.throws(() => schema.parse(value), error => error.name === 'ZodError' && Array.isArray(error.issues))
  for (const descriptors of [TYPERT.invocations, TYPERT_REMOTE.descriptors]) {
    const [member, defaults] = descriptors
    const memberRequest = member.parameters[0].codec.create()
    const defaultRequest = defaults.parameters[0].codec.create()
    const request = { leadSessionId: 'lead', target: 'worker', selection }
    assert.deepEqual(memberRequest.parse(request), request)
    assert.deepEqual(member.result.create().parse(selection), selection)
    assert.deepEqual(member.result.create().parse({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
    assert.deepEqual(defaultRequest.parse({ leadSessionId: 'lead', selection: null }), { leadSessionId: 'lead', selection: null })
    assert.equal(defaults.result.create().parse(null), null)
    assert.deepEqual(defaults.result.create().parse(selection), selection)
    assert.deepEqual(defaultRequest.parse({ leadSessionId: 'lead', selection }), { leadSessionId: 'lead', selection })
    rejects(memberRequest, { ...request, leadSessionId: 42 })
    rejects(memberRequest, { ...request, target: null })
    rejects(memberRequest, { ...request, selection: null })
    rejects(memberRequest, { ...request, selection: { model: 'm' } })
    rejects(member.result.create(), { provider: 'p' })
    rejects(member.result.create(), { ...selection, reasoningEffort: 3 })
    rejects(defaultRequest, { leadSessionId: 'lead' })
    rejects(defaults.result.create(), { model: 'm' })
    // Original generated z.object strips unknown fields; strict is the codec mode.
    assert.deepEqual(member.result.create().parse({ ...selection, extra: true }), selection)
  }
})

test('browser factory executes without global Node require and injects hashed CSS once', () => {
  const realm = browserRealm()
  assert.equal(realm.styles.length, 0, 'factory should not execute at registration')
  const plugin = realm.execute()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plain(plugin.inject), ['sessions', 'uiWorkspace', 'slots', 'locale', 'remote', 'modelDirectories'])
  assert.equal(realm.styles.length, 1)
  assert.equal(realm.styles[0].tagName, 'style')
  assert.match(realm.styles[0].id, /^dsh-agent-team-switchable-[a-f0-9]{12}$/)
  assert.match(realm.styles[0].textContent, /\.team_[A-Za-z0-9_-]+_root/)
  realm.execute()
  assert.equal(realm.styles.length, 1, 'CSS injection is idempotent')
  assert.ok(realm.imports.includes('@deepseek-ai/dsh-client-ui-primitives'))
  assert.ok(realm.imports.includes('@deepseek-ai/dsh-client-store'))
  assert.ok(realm.imports.includes('react/jsx-runtime'))
})

test('browser apply mounts own Remote, publishes UI and disposes both registrations', async () => {
  const plugin = browserRealm().execute()
  let mounted
  let remoteDisposed = 0
  let uiDisposed = 0
  let dictionaries = 0
  const effects = []
  const slots = []
  const ctx = {
    remote: { async $mount(contribution) { mounted = contribution; return async () => { remoteDisposed++ } } },
    sessions: {}, uiWorkspace: {}, modelDirectories: {},
    locale: { register() { dictionaries++; return () => {} } },
    effect(fn) { effects.push(fn) },
    slots: { inject(key, fn) { fn() }, register(definition, component) { slots.push({ definition, component }) } },
    inject(keys, fn) {
      assert.deepEqual(plain(keys), ['remote.agent-team-models'])
      fn(ctx)
      return Object.assign(Promise.resolve(), { async dispose() { uiDisposed++ } })
    },
  }
  await plugin.apply(ctx)
  assert.equal(mounted.package, packageName)
  assert.deepEqual(plain(mounted.descriptors), plain(TYPERT_REMOTE.descriptors))
  assert.equal(slots[0].definition.name, 'conversation.session.header.actions')
  assert.equal(typeof slots[0].component, 'function')
  effects[0]()
  assert.equal(dictionaries, 1)
  await effects[1]()()
  assert.equal(uiDisposed, 1)
  assert.equal(remoteDisposed, 1)
})

test('artifacts contain neither copied Core implementations nor original-package routes', async () => {
  for (const file of await readdir(join(root, 'lib'))) {
    const text = await readFile(join(root, 'lib', file), 'utf8')
    assert.doesNotMatch(text, /dsh-agent-team-models|\/Users\/|packages\/experimental|@deepseek-ai\/dsh-experimental/, file)
    assert.doesNotMatch(text, /\/node_modules\/@deepseek-ai\//, file)
  }
  assert.doesNotMatch(clientCode, /require\(["'](?:node:|zod|dsh-agent-team-switchable|@deepseek-ai\/dsh-experimental)/)
  assert.doesNotMatch(clientCode, /typeof require|__require|\bprocess\.|node:/)
})
