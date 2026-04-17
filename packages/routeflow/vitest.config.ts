import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      sqlite: 'node:sqlite',
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        // Keep the built-in SQLite module external. In some Vite/Vitest resolution
        // paths the `node:` scheme is normalized away, so externalize both forms.
        external: ['node:sqlite', 'sqlite'],
      },
    },
  },
})
