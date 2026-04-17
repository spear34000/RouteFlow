import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ADAPTER_SYMBOL } from '../../core/types.js'

/**
 * Unit tests for PostgresStore + PostgresTable using mocked pg.Pool.
 *
 * Tests cover:
 * - connect(): pool creation, SELECT 1 health-check, CREATE TABLE per registered table
 * - table(): returns PostgresTable with correct ADAPTER_SYMBOL back-reference
 * - PostgresTable.list() — plain, where, orderBy, limit, offset, after
 * - PostgresTable.get() — found / not found
 * - PostgresTable.create() — INSERT + ChangeEvent dispatch
 * - PostgresTable.update() — UPDATE + ChangeEvent dispatch + returns null for missing id
 * - PostgresTable.delete() — DELETE + ChangeEvent dispatch + returns false for missing id
 * - PostgresTable.seed() — skips when table non-empty
 * - onChange() listener registration and unsubscribe
 * - isConnected getter
 * - disconnect() calls pool.end()
 * - assertSafeIdentifier enforced on unsafe table/column names
 */

// ── Mock pg ──────────────────────────────────────────────────────────────────

// We need to mock before importing the module under test.
const mockQuery = vi.fn()
const mockEnd   = vi.fn().mockResolvedValue(undefined)

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: mockQuery, end: mockEnd })),
}))

// Also mock the PostgresAdapter that PostgresStore creates internally.
vi.mock('./postgres-adapter.js', () => ({
  PostgresAdapter: vi.fn().mockImplementation(() => ({
    connect:    vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onChange:   vi.fn().mockReturnValue(() => {}),
  })),
}))

const { PostgresStore } = await import('./postgres-store.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a query mock that returns specific rows for the first `CREATE TABLE` / `SELECT 1`
 *  calls, and then the provided `rows` for the next data query. */
function setupQuery(rowsPerCall: Array<{ rows: Record<string, unknown>[] }>) {
  let call = 0
  mockQuery.mockImplementation(() => {
    const result = rowsPerCall[call] ?? { rows: [] }
    call++
    return Promise.resolve(result)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostgresStore', () => {
  let store: InstanceType<typeof PostgresStore>

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnd.mockResolvedValue(undefined)
    store = new PostgresStore({ connectionString: 'postgresql://localhost/test' })
  })

  it('accepts a plain connection string in constructor', () => {
    const s = new PostgresStore('postgresql://localhost/test')
    expect(s).toBeInstanceOf(PostgresStore)
  })

  it('table() returns a PostgresTable with [ADAPTER_SYMBOL] pointing to the store', () => {
    const t = store.table('orders', { total: 'integer' })
    expect(t[ADAPTER_SYMBOL]).toBe(store)
  })

  it('isConnected is false before connect()', () => {
    expect(store.isConnected).toBe(false)
  })

  it('connect() runs SELECT 1 + CREATE TABLE for each registered table', async () => {
    const s = new PostgresStore({ connectionString: 'postgresql://localhost/test' })
    s.table('orders', { total: 'integer', note: 'text' })
    s.table('users',  { username: 'text' })

    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    await s.connect()

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    // Health check
    expect(queries.some((q) => q.trim() === 'SELECT 1')).toBe(true)
    // Both tables created
    expect(queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS') && q.includes('"orders"'))).toBe(true)
    expect(queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS') && q.includes('"users"'))).toBe(true)
    expect(s.isConnected).toBe(true)
  })

  it('connect() is idempotent', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await store.connect()
    const callCount = mockQuery.mock.calls.length
    await store.connect()
    expect(mockQuery.mock.calls.length).toBe(callCount)
  })

  it('disconnect() ends the pool and clears isConnected', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await store.connect()
    await store.disconnect()
    expect(mockEnd).toHaveBeenCalledOnce()
    expect(store.isConnected).toBe(false)
  })

  it('onChange() registers a listener and returns an unsubscribe fn', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await store.connect()

    const cb = vi.fn()
    const unsub = store.onChange('orders', cb)

    store.dispatchEvent({ table: 'orders', operation: 'INSERT', newRow: { id: 1 }, oldRow: null, timestamp: 0 })
    expect(cb).toHaveBeenCalledOnce()

    unsub()
    store.dispatchEvent({ table: 'orders', operation: 'INSERT', newRow: { id: 2 }, oldRow: null, timestamp: 0 })
    expect(cb).toHaveBeenCalledOnce() // still 1 — not called again
  })

  it('schema default is "public"', () => {
    expect(store.schema).toBe('public')
  })

  it('custom schema and triggerPrefix are stored', () => {
    const s = new PostgresStore({ connectionString: 'x', schema: 'app', triggerPrefix: 'myapp' })
    expect(s.schema).toBe('app')
    expect(s.triggerPrefix).toBe('myapp')
  })
})

// ── PostgresTable ─────────────────────────────────────────────────────────────

describe('PostgresTable', () => {
  let store: InstanceType<typeof PostgresStore>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockEnd.mockResolvedValue(undefined)
    store = new PostgresStore({ connectionString: 'postgresql://localhost/test' })
    mockQuery.mockResolvedValue({ rows: [] })
    await store.connect()
    vi.clearAllMocks() // reset after connect so test counts are clean
  })

  // ── list() ───────────────────────────────────────────────────────────────────

  it('list() — returns rows from SELECT *', async () => {
    const orders = store.table('orders', { total: 'integer', note: 'text' })
    const fakeRows = [{ id: 1, total: 99, note: 'hello' }, { id: 2, total: 50, note: 'world' }]
    // table() called AFTER connect() so ensureTable() is NOT called — first query is SELECT *
    mockQuery.mockResolvedValue({ rows: fakeRows })
    const result = await orders.list()
    expect(result).toEqual(fakeRows)
  })

  it('list({ where }) generates a parameterized WHERE clause', async () => {
    const orders = store.table('orders', { roomId: 'integer', total: 'integer' })
    mockQuery.mockResolvedValue({ rows: [] })
    await orders.list({ where: { roomId: 42 } as any })
    const [sql, params] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/WHERE/)
    expect(sql).toMatch(/"roomId"/)
    expect(params).toContain(42)
  })

  it('list({ orderBy, order, limit, offset }) generates correct SQL clauses', async () => {
    const items = store.table('items', { name: 'text', price: 'real' })
    mockQuery.mockResolvedValue({ rows: [] })
    await items.list({ orderBy: 'price', order: 'desc', limit: 10, offset: 20 })
    const [sql] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/"price" DESC/)
    expect(sql).toMatch(/LIMIT 10/)
    expect(sql).toMatch(/OFFSET 20/)
  })

  it('list({ after }) adds id > $N keyset clause', async () => {
    const messages = store.table('messages', { content: 'text' })
    mockQuery.mockResolvedValue({ rows: [] })
    await messages.list({ after: 100 })
    const [sql, params] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/"id" > \$/)
    expect(params).toContain(100)
  })

  it('list() throws on invalid orderBy column', async () => {
    const items = store.table('items', { name: 'text' })
    await expect(items.list({ orderBy: 'DROP TABLE items--' })).rejects.toThrow('Invalid orderBy column')
  })

  // ── get() ────────────────────────────────────────────────────────────────────

  it('get() returns the row when found', async () => {
    const users = store.table('users', { username: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, username: 'alice' }] })
    const row = await users.get(5)
    expect(row).toEqual({ id: 5, username: 'alice' })
  })

  it('get() returns null when not found', async () => {
    const users = store.table('users', { username: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const row = await users.get(999)
    expect(row).toBeNull()
  })

  // ── create() ─────────────────────────────────────────────────────────────────

  it('create() runs INSERT RETURNING * and emits an INSERT ChangeEvent', async () => {
    const orders = store.table('orders', { total: 'integer' })
    const fakeRow = { id: 1, total: 99 }
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow] })

    const cb = vi.fn()
    store.onChange('orders', cb)

    const created = await orders.create({ total: 99 } as any)

    expect(created).toEqual(fakeRow)
    const [sql] = mockQuery.mock.calls[0]!
    expect(sql).toMatch(/INSERT INTO/)
    expect(sql).toMatch(/RETURNING \*/)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0][0].operation).toBe('INSERT')
    expect(cb.mock.calls[0][0].newRow).toEqual(fakeRow)
  })

  it('create() with JSONB column stores object correctly', async () => {
    const settings = store.table('settings', { meta: 'json' })
    const fakeRow = { id: 1, meta: { key: 'val' } }
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow] })
    const created = await settings.create({ meta: { key: 'val' } } as any)
    expect(created.meta).toEqual({ key: 'val' })
  })

  // ── update() ─────────────────────────────────────────────────────────────────

  it('update() runs UPDATE RETURNING * and emits an UPDATE ChangeEvent', async () => {
    const items = store.table('items', { name: 'text' })
    const oldRow = { id: 3, name: 'apple' }
    const newRow = { id: 3, name: 'mango' }
    // get() returns old row, then UPDATE returns new row
    mockQuery
      .mockResolvedValueOnce({ rows: [oldRow] })   // get()
      .mockResolvedValueOnce({ rows: [newRow] })   // UPDATE

    const cb = vi.fn()
    store.onChange('items', cb)

    const updated = await items.update(3, { name: 'mango' } as any)
    expect(updated).toEqual(newRow)
    expect(cb.mock.calls[0][0].operation).toBe('UPDATE')
    expect(cb.mock.calls[0][0].newRow).toEqual(newRow)
    expect(cb.mock.calls[0][0].oldRow).toEqual(oldRow)
  })

  it('update() returns null when id not found', async () => {
    const items = store.table('items', { name: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [] }) // get() returns nothing
    const result = await items.update(999, { name: 'x' } as any)
    expect(result).toBeNull()
  })

  // ── delete() ─────────────────────────────────────────────────────────────────

  it('delete() runs DELETE RETURNING * and emits a DELETE ChangeEvent', async () => {
    const items = store.table('items', { name: 'text' })
    const oldRow = { id: 7, name: 'banana' }
    mockQuery.mockResolvedValueOnce({ rows: [oldRow] })

    const cb = vi.fn()
    store.onChange('items', cb)

    const ok = await items.delete(7)
    expect(ok).toBe(true)
    expect(cb.mock.calls[0][0].operation).toBe('DELETE')
    expect(cb.mock.calls[0][0].oldRow).toEqual(oldRow)
    expect(cb.mock.calls[0][0].newRow).toBeNull()
  })

  it('delete() returns false when row not found', async () => {
    const items = store.table('items', { name: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const ok = await items.delete(999)
    expect(ok).toBe(false)
  })

  // ── seed() ───────────────────────────────────────────────────────────────────

  it('seed() does nothing when table is non-empty', async () => {
    const config = store.table('config', { key: 'text', value: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '5' }] }) // COUNT returns 5
    await config.seed([{ key: 'x', value: 'y' }] as any)
    expect(mockQuery).toHaveBeenCalledOnce() // only COUNT, no INSERT
  })

  it('seed() inserts rows when table is empty', async () => {
    const config = store.table('config', { key: 'text', value: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] }) // COUNT = 0
    mockQuery.mockResolvedValue({ rows: [] })                // INSERT
    await config.seed([{ key: 'a', value: '1' }, { key: 'b', value: '2' }] as any)
    // 1 COUNT + 2 INSERTs
    expect(mockQuery).toHaveBeenCalledTimes(3)
    const inserts = mockQuery.mock.calls.slice(1).map(c => String(c[0]))
    expect(inserts.every(q => q.includes('INSERT INTO'))).toBe(true)
    expect(inserts.every(q => q.includes('ON CONFLICT DO NOTHING'))).toBe(true)
  })

  // ── getMany() ────────────────────────────────────────────────────────────────

  it('getMany() issues a single WHERE id IN (...) query', async () => {
    const users = store.table('users', { username: 'text' })
    const fakeRows = [{ id: 1, username: 'alice' }, { id: 3, username: 'charlie' }]
    mockQuery.mockResolvedValueOnce({ rows: fakeRows })

    const result = await users.getMany([1, 2, 3])

    const [sql, params] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/WHERE.*id.*IN/i)
    expect(params).toEqual([1, 2, 3])
    // Result order matches input ids; id=2 not found → null
    expect(result).toEqual([
      { id: 1, username: 'alice' },
      null,
      { id: 3, username: 'charlie' },
    ])
  })

  it('getMany([]) returns [] without querying', async () => {
    const users = store.table('users', { username: 'text' })
    const result = await users.getMany([])
    expect(mockQuery).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('getMany() returns null for every missing id', async () => {
    const items = store.table('items', { name: 'text' })
    mockQuery.mockResolvedValueOnce({ rows: [] }) // all missing
    const result = await items.getMany([10, 20])
    expect(result).toEqual([null, null])
  })

  // ── SQL injection safety ─────────────────────────────────────────────────────

  it('rejects unsafe table name at table definition', () => {
    // ensureTable() is called on connect() — just call directly
    const t = store.table('drop_table_users--', { name: 'text' })
    expect(() => t.ensureTable()).rejects.toThrow('Unsafe SQL identifier')
  })
})
