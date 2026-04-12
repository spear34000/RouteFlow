import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapter/index': 'src/adapter/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  esbuildOptions(options) {
    // Required for reflect-metadata + decorator metadata
    options.keepNames = true
  },
})
