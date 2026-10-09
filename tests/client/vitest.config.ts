import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: { alias: {
    '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./primitives.tsx', import.meta.url)),
  } },
  test: { include: ['tests/client/**/*.spec.{ts,tsx}'], environment: 'node' },
})
