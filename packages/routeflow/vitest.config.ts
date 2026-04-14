import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    server: {
      deps: {
        // node:sqlite is a Node.js 22.5+ built-in — must not be bundled by Vite.
        external: ['node:sqlite'],
      },
    },
  },
})
