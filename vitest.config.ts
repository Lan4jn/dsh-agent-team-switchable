import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/package.test.mjs'], environment: 'node' },
})
