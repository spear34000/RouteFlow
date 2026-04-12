/**
 * RouteFlow MVP proof #2:
 * - The same controller code runs with a real Postgres-backed store
 * - Only the adapter and store wiring change
 */
import { Pool } from 'pg'
import { PostgresAdapter } from '@routeflow/adapter-postgres'
import { createApp } from '@routeflow/core'
import { registerDemoUi } from './register-demo-ui.js'
import { createItemController, seedItems } from './shared.js'
import type { Item, ItemStore } from './shared.js'

class PostgresItemStore implements ItemStore {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Item[]> {
    const result = await this.pool.query<{
      id: number
      name: string
      created_at: Date | string
    }>('select id, name, created_at from items order by id asc')

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
    }))
  }

  async get(id: number): Promise<Item | null> {
    const result = await this.pool.query<{
      id: number
      name: string
      created_at: Date | string
    }>('select id, name, created_at from items where id = $1', [id])

    const row = result.rows[0]
    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
    }
  }

  async create(name: string): Promise<Item> {
    const result = await this.pool.query<{
      id: number
      name: string
      created_at: Date | string
    }>(
      'insert into items (name) values ($1) returning id, name, created_at',
      [name],
    )

    const row = result.rows[0]
    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
    }
  }
}

const connectionString =
  process.env['ROUTEFLOW_POSTGRES_URL'] ?? 'postgresql://localhost:5432/routeflow'
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port = Number(process.env['PORT'] ?? 3002)

const pool = new Pool({ connectionString })
await ensureSchema(pool, connectionString)

const adapter = new PostgresAdapter({ connectionString })
const store = new PostgresItemStore(pool)
const ItemController = createItemController(store)

const app = createApp({
  adapter,
  transport,
  port,
})

registerDemoUi(app, {
  title: 'PostgreSQL adapter, same controller',
  subtitle:
    'The controller contract is unchanged. Only the adapter and store wiring move from memory to PostgreSQL.',
  transport,
})
app.register(ItemController)
await app.listen()

console.log(`[postgres] RouteFlow demo ready on http://localhost:${port} (${transport})`)
console.log('[postgres] POST /items or insert into the items table to trigger /items/live')

async function ensureSchema(db: Pool, activeConnectionString: string): Promise<void> {
  try {
    await db.query(`
      create table if not exists items (
        id serial primary key,
        name text not null,
        created_at timestamptz not null default now()
      )
    `)

    const countResult = await db.query<{ count: string }>('select count(*)::text as count from items')
    if (Number(countResult.rows[0]?.count ?? '0') > 0) return

    for (const item of seedItems) {
      await db.query(
        'insert into items (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing',
        [item.id, item.name, item.createdAt],
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        `PostgreSQL demo setup failed: ${message}`,
        `ROUTEFLOW_POSTGRES_URL=${activeConnectionString}`,
        'Start PostgreSQL locally or pass ROUTEFLOW_POSTGRES_URL to a reachable database.',
        'Example: ROUTEFLOW_POSTGRES_URL=postgresql://user:pass@localhost:5432/routeflow pnpm --filter @routeflow/example-basic start:postgres',
      ].join('\n'),
    )
  }
}
