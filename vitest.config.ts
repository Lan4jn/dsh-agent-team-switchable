import { resolve } from 'node:path'
import { transform } from 'esbuild'
import { defineConfig } from 'vitest/config'

const sourceRoot = `${resolve('src')}/`

export default defineConfig({
  plugins: [{
    name: 'standard-decorators',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.startsWith(sourceRoot) || !/\.tsx?$/.test(id)) return
      // Vite 8's OXC preserves standard decorators; match the production build
      // transform instead of opting into incompatible legacy decorator semantics.
      return transform(code, {
        loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
        target: 'es2022', jsx: 'automatic', sourcefile: id, sourcemap: true,
      })
    },
  }],
  resolve: { alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve('tests/client/primitives.tsx') } },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/package.test.mjs'], environment: 'node' },
})
