import { Pool } from 'pg'
import { createApp } from 'routeflow-api'
import { PostgresAdapter } from 'routeflow-api/adapters/postgres'
import type { TableStore } from 'routeflow-api'
import { registerDemoUi } from './register-demo-ui.js'
import { ItemController, seedItems, type Item } from './shared.js'

// ── PostgreSQL store (implements TableStore<Item>) ────────────────────────
//
// Change events are fired by native Postgres LISTEN/NOTIFY triggers —
// no manual adapter.emit() needed after mutations.

class PostgresItemStore implements TableStore<Item> {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Item[]> {
    const { rows } = await this.pool.query<{ id: number; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM items ORDER BY id ASC',
    )
    return rows.map(toItem)
  }

  async get(id: number): Promise<Item | null> {
    const { rows } = await this.pool.query<{ id: number; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM items WHERE id = $1',
      [id],
    )
    return rows[0] ? toItem(rows[0]) : null
  }

  async create(data: Omit<Item, 'id'>): Promise<Item> {
    const { rows } = await this.pool.query<{ id: number; name: string; created_at: string }>(
      'INSERT INTO items (name, created_at) VALUES ($1, $2) RETURNING id, name, created_at',
      [data.name, data.createdAt],
    )
    return toItem(rows[0])
  }

  async update(id: number, data: Partial<Omit<Item, 'id'>>): Promise<Item | null> {
    const sets: string[] = []
    const vals: unknown[] = []
    if (data.name      != null) { sets.push(`name = $${sets.length + 1}`);       vals.push(data.name) }
    if (data.createdAt != null) { sets.push(`created_at = $${sets.length + 1}`); vals.push(data.createdAt) }
    if (!sets.length) return this.get(id)

    vals.push(id)
    const { rows } = await this.pool.query<{ id: number; name: string; created_at: string }>(
      `UPDATE items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, name, created_at`,
      vals,
    )
    return rows[0] ? toItem(rows[0]) : null
  }

  async delete(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM items WHERE id = $1', [id])
    return (rowCount ?? 0) > 0
  }

  async seed(rows: Omit<Item, 'id'>[]): Promise<void> {
    const { rows: [{ count }] } = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM items',
    )
    if (Number(count) > 0) return
    for (const row of rows) await this.create(row)
  }
}

function toItem(row: { id: number; name: string; created_at: string }): Item {
  return { id: row.id, name: row.name, createdAt: new Date(row.created_at).toISOString() }
}

// ── Server setup ──────────────────────────────────────────────────────────

const connectionString = process.env['ROUTEFLOW_POSTGRES_URL'] ?? 'postgresql://localhost:5432/routeflow'
const transport        = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port             = Number(process.env['PORT'] ?? 3002)

const pool = new Pool({ connectionString })
await ensureSchema(pool, connectionString)

const store = new PostgresItemStore(pool)
await store.seed(seedItems)

// PostgresAdapter handles CDC via LISTEN/NOTIFY — same interface as any other adapter
const adapter = new PostgresAdapter({ connectionString })

// Same controller as SQLite — only the store and adapter wiring differ
const app = createApp({ adapter, transport, port })

registerDemoUi(app, {
  title:    'PostgreSQL adapter, same controller',
  subtitle: '컨트롤러 코드는 SQLite 예제와 동일합니다. 어댑터와 스토어 연결만 다릅니다.',
  transport,
})
app.register(new ItemController(store))
await app.listen()

console.log(`[postgres] Ready on http://localhost:${port} (${transport})`)
console.log('[postgres] POST /items or insert into Postgres to trigger /items/live')

// ── Schema bootstrap ──────────────────────────────────────────────────────

async function ensureSchema(db: Pool, connStr: string): Promise<void> {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS items (
        id         SERIAL PRIMARY KEY,
        name       TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      [
        `PostgreSQL setup failed: ${msg}`,
        `ROUTEFLOW_POSTGRES_URL=${connStr}`,
        'Start PostgreSQL locally or set ROUTEFLOW_POSTGRES_URL.',
      ].join('\n'),
    )
  }
}
