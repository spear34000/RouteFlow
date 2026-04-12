/**
 * Integration tests for PostgresAdapter — require a live PostgreSQL instance.
 *
 * Set the POSTGRES_TEST_URL environment variable before running:
 *   POSTGRES_TEST_URL=postgresql://user:pass@localhost:5432/testdb pnpm test:integration
 *
 * The test suite creates and drops its own table (reactive_api_test_orders) so it
 * is safe to run against any non-production database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { PostgresAdapter } from './postgres-adapter.js'
import type { ChangeEvent } from '../../core/types.js'

const TEST_URL = process.env['POSTGRES_TEST_URL']

const describeIf = TEST_URL ? describe : describe.skip

describeIf('PostgresAdapter — integration', () => {
  const TABLE = 'reactive_api_test_orders'
  let adapter: PostgresAdapter
  let queryClient: Client

  beforeAll(async () => {
    queryClient = new Client({ connectionString: TEST_URL })
    await queryClient.connect()

    // Create a clean test table
    await queryClient.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await queryClient.query(`
      CREATE TABLE ${TABLE} (
        id      SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        total   NUMERIC NOT NULL DEFAULT 0
      )
    `)

    adapter = new PostgresAdapter({ connectionString: TEST_URL! })
    await adapter.connect()
  })

  afterAll(async () => {
    await adapter.disconnect()
    await queryClient.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await queryClient.end()
  })

  it('receives INSERT event in real-time', async () => {
    const received: ChangeEvent[] = []
    const unsub = adapter.onChange(TABLE, (e) => received.push(e))

    // Small delay to ensure LISTEN + trigger are active
    await new Promise((r) => setTimeout(r, 100))

    await queryClient.query(
      `INSERT INTO ${TABLE} (user_id, total) VALUES ('alice', 42)`,
    )

    // Wait for notification to propagate
    await new Promise((r) => setTimeout(r, 200))

    expect(received.length).toBe(1)
    expect(received[0]!.operation).toBe('INSERT')
    expect((received[0]!.newRow as Record<string, unknown>)['user_id']).toBe('alice')

    unsub()
  })

  it('receives UPDATE event with old and new row', async () => {
    const received: ChangeEvent[] = []
    adapter.onChange(TABLE, (e) => { if (e.operation === 'UPDATE') received.push(e) })

    await new Promise((r) => setTimeout(r, 100))

    const res = await queryClient.query(
      `INSERT INTO ${TABLE} (user_id, total) VALUES ('bob', 10) RETURNING id`,
    )
    const id: unknown = (res.rows[0] as Record<string, unknown>)['id']

    await queryClient.query(`UPDATE ${TABLE} SET total = 99 WHERE id = $1`, [id])

    await new Promise((r) => setTimeout(r, 200))

    expect(received.length).toBe(1)
    expect((received[0]!.newRow as Record<string, unknown>)['total']).toBe('99')
    expect((received[0]!.oldRow as Record<string, unknown>)['total']).toBe('10')
  })

  it('receives DELETE event', async () => {
    const received: ChangeEvent[] = []
    adapter.onChange(TABLE, (e) => { if (e.operation === 'DELETE') received.push(e) })

    await new Promise((r) => setTimeout(r, 100))

    const res = await queryClient.query(
      `INSERT INTO ${TABLE} (user_id, total) VALUES ('carol', 5) RETURNING id`,
    )
    const id: unknown = (res.rows[0] as Record<string, unknown>)['id']

    await queryClient.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id])

    await new Promise((r) => setTimeout(r, 200))

    expect(received.length).toBe(1)
    expect(received[0]!.newRow).toBeNull()
    expect((received[0]!.oldRow as Record<string, unknown>)['user_id']).toBe('carol')
  })
})
