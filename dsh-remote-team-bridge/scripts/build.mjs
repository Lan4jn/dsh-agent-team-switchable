import { build } from 'esbuild'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-remote-team-bridge'
const output = join(root, 'lib')

await mkdir(output, { recursive: true })
if (await realpath(output) !== join(await realpath(root), 'lib')) {
  throw new Error('Refusing to clean a redirected output directory')
}
await rm(output, { recursive: true })
await mkdir(output)

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [
    '@deepseek-ai/*',
    'cordis',
    'node:*',
  ],
})

console.log(`Built ${packageName}`)
