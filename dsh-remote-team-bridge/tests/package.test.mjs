import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-remote-team-bridge'

test('package manifest and exports comply with DSH plugin specification', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './lib/index.js')
})

test('build script cleanly generates independent lib/index.js artifact', async () => {
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(build.status, 0, `Build failed:\n${build.stdout}\n${build.stderr}`)

  const libStat = await stat(join(root, 'lib/index.js'))
  assert.ok(libStat.isFile(), 'lib/index.js must be a regular file')

  const content = await readFile(join(root, 'lib/index.js'), 'utf8')
  assert.doesNotMatch(content, /\/Users\/[a-zA-Z0-9_-]+\//, 'Build artifact must not contain local user directory paths')

  const builtModule = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  assert.equal(builtModule.PACKAGE_TAG, packageName)
  assert.equal(builtModule.name, packageName)
  assert.equal(typeof builtModule.Config, 'function')
  assert.equal(typeof builtModule.apply, 'function')
})

test('Host and remote Typert descriptors conform to the plugin RPC contract', async () => {
  const { TYPERT } = await import(pathToFileURL(join(root, 'src/typert.host.ts')).href)
  const { TYPERT_REMOTE } = await import(pathToFileURL(join(root, 'src/typert.remote-client.ts')).href)

  assert.equal(TYPERT.package, packageName)
  assert.equal(TYPERT.face, 'host')
  assert.equal(TYPERT_REMOTE.package, packageName)

  const methods = TYPERT.invocations.map(inv => inv.method)
  assert.ok(methods.includes('getStatus'))
  assert.ok(methods.includes('createPairingCode'))
  assert.ok(methods.includes('listPairedDevices'))
  assert.ok(methods.includes('revokePairedDevice'))

  for (const descriptor of TYPERT.invocations) {
    assert.equal(descriptor.namespace, 'remote-team-bridge')
    assert.equal(descriptor.service, 'remoteTeamBridge')
    assert.equal(descriptor.id, `${packageName}#remote-team-bridge/${descriptor.method}`)
  }
})
