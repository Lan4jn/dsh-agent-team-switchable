import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Optional, ignored local adapter for testing against an existing DSH source SDK.
// Normal source checkouts use their installed public peer dependencies instead.
const localAdapter = resolve('node_modules/.dsh-vitest.config.ts')
export default defineConfig(async () => existsSync(localAdapter)
  ? (await import(pathToFileURL(localAdapter).href)).default
  : {
    resolve: { alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve('tests/client/primitives.tsx') } },
    test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/package.test.mjs'], environment: 'node' },
  },
)
