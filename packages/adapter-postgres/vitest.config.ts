import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Exclude integration tests from default run
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
})
