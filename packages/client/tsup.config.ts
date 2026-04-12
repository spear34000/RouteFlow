import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Keep browser-compatible output — no Node.js builtins
  platform: 'browser',
  target: 'es2022',
})
