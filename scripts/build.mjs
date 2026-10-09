import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-agent-team-switchable'
const externalShared = {
  name: 'external-shared',
  setup(builder) {
    // Official Host services and browser singletons stay in the DSH realm.
    builder.onResolve({ filter: /^(?:@deepseek-ai\/|react(?:-dom)?(?:\/|$))/ }, args => ({
      path: args.path, external: true,
    }))
  },
}
const cssModules = {
  name: 'plugin-css-modules',
  setup(builder) {
    builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
      const code = await readFile(path)
      const { code: css, exports } = transform({
        filename: relative(root, path), code, minify: true,
        cssModules: { pattern: 'team_[hash]_[local]' },
      })
      const classes = Object.fromEntries(Object.entries(exports).map(([key, value]) => {
        if (value.composes.length) throw new Error(`CSS composition is not supported: ${key}`)
        return [key, value.name]
      }))
      const id = `${packageName}-${createHash('sha256').update(css).digest('hex').slice(0, 12)}`
      return {
        loader: 'js',
        contents: `const id=${JSON.stringify(id)};\nif(!document.getElementById(id)){const style=document.createElement('style');style.id=id;style.textContent=${JSON.stringify(css.toString())};document.head.appendChild(style);}\nexport default ${JSON.stringify(classes)};`,
      }
    })
  },
}
const common = {
  absWorkingDir: root, bundle: true, write: false, logLevel: 'warning', preserveSymlinks: true,
  sourcemap: false, legalComments: 'none', plugins: [externalShared],
}
const output = join(root, 'lib')
await mkdir(output, { recursive: true })
if (await realpath(output) !== join(await realpath(root), 'lib')) throw new Error('Refusing to clean a redirected output directory')
await rm(output, { recursive: true })
await mkdir(output)
const require = createRequire(import.meta.url)
await writeFile(join(root, 'lib/zod.LICENSE'), await readFile(join(dirname(require.resolve('zod/package.json')), 'LICENSE')))
const entries = {
  index: 'src/index.ts', types: 'src/types.ts',
  'typert.host': 'src/host-contract.ts', 'typert.remote-client': 'src/remote.ts',
}
for (const [name, entry] of Object.entries(entries)) {
  const result = await build({ ...common, entryPoints: [entry], platform: 'node', format: 'esm', target: 'node22', outfile: `lib/${name}.js` })
  await writeFile(join(root, 'lib', `${name}.js`), result.outputFiles[0].contents)
}
const browser = await build({
  ...common, entryPoints: ['src/client/index.ts'], platform: 'browser', format: 'cjs', target: 'es2022',
  jsx: 'automatic', outfile: 'lib/client.js',
  plugins: [
    {
      name: 'own-remote',
      setup(builder) {
        builder.onResolve({ filter: /^dsh-agent-team-switchable\/remote$/ }, () => ({ path: join(root, 'src/remote.ts') }))
      },
    },
    externalShared, cssModules,
  ],
})
await writeFile(join(root, 'lib/client.js'),
  `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${browser.outputFiles[0].text}\nreturn module.exports;}});\n`)
await writeFile(join(root, 'lib/typert.host.d.ts'), "export { TYPERT } from '../src/host-contract.ts'\n")
await writeFile(join(root, 'lib/typert.remote-client.d.ts'), "export { TYPERT_REMOTE, default } from '../src/remote.ts'\n")
console.log(`Built ${packageName}: additive Host/settings/tools, own types/Typert and browser factory`)
