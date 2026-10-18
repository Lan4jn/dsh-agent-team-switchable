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
      return transform(code, {
        loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
        target: 'es2022',
        jsx: 'automatic',
        sourcefile: id,
        sourcemap: true,
      })
    },
  }],
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
  },
})
