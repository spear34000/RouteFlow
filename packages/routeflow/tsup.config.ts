import { defineConfig } from 'tsup'

// ── Shared settings ──────────────────────────────────────────────────────────

const sharedNode = {
  format: ['esm', 'cjs'] as const,
  dts: true,
  splitting: false,
  sourcemap: true,
  platform: 'node' as const,
}

// ── Node.js server build ─────────────────────────────────────────────────────

const nodeExternal = [
  'node:sqlite', 'sqlite',
  'node:fs', 'node:path', 'node:crypto',
  'pg', 'mongodb', 'mysql2', 'ioredis',
  '@aws-sdk/client-dynamodb',
  '@elastic/elasticsearch',
  '@opensearch-project/opensearch',
  'snowflake-sdk', 'cassandra-driver',
  'kafkajs', 'fastify',
]

// ── React/browser build ──────────────────────────────────────────────────────

export default defineConfig([
  // ── Server bundle ─────────────────────────────────────────────────────────
  {
    ...sharedNode,
    entry: {
      index:                     'src/index.ts',
      sqlite:                    'src/sqlite.ts',
      'client/index':            'src/client/index.ts',
      'adapters/postgres':       'src/adapters/postgres.ts',
      'adapters/mongodb':        'src/adapters/mongodb.ts',
      'adapters/mysql':          'src/adapters/mysql.ts',
      'adapters/redis':          'src/adapters/redis.ts',
      'adapters/dynamodb':       'src/adapters/dynamodb.ts',
      'adapters/elasticsearch':  'src/adapters/elasticsearch.ts',
      'adapters/opensearch':     'src/adapters/opensearch.ts',
      'adapters/snowflake':      'src/adapters/snowflake.ts',
      'adapters/cassandra':      'src/adapters/cassandra.ts',
      'adapters/kafka':          'src/adapters/kafka.ts',
      'adapters/webhook':        'src/adapters/webhook.ts',
    },
    clean: true,
    external: nodeExternal,
    // Fix node:sqlite import alias used in the SQLite entry
    async onSuccess() {
      const { execSync } = await import('node:child_process')
      execSync(
        "sed -i '' 's/from \"sqlite\"/from \"node:sqlite\"/g; s/require(\"sqlite\")/require(\"node:sqlite\")/g' dist/sqlite.js dist/sqlite.cjs",
        { stdio: 'inherit' },
      )
    },
  },

  // ── React / browser bundle ─────────────────────────────────────────────────
  {
    entry: {
      'react/index': 'src/react/index.ts',
    },
    format: ['esm', 'cjs'] as const,
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,            // do not wipe the server build artifacts
    platform: 'browser' as const,
    external: ['react', 'react-dom'],
  },
])
