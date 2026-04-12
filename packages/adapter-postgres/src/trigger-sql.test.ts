import { describe, it, expect } from 'vitest'
import {
  notifyChannel,
  createTriggerFunctionSQL,
  createTableTriggerSQL,
  dropTableTriggerSQL,
  dropTriggerFunctionSQL,
} from './trigger-sql.js'

describe('notifyChannel', () => {
  it('appends _changes suffix', () => {
    expect(notifyChannel('reactive_api')).toBe('reactive_api_changes')
  })

  it('uses custom prefix', () => {
    expect(notifyChannel('myapp')).toBe('myapp_changes')
  })
})

describe('createTriggerFunctionSQL', () => {
  it('contains CREATE OR REPLACE FUNCTION', () => {
    const sql = createTriggerFunctionSQL('public', 'reactive_api')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION')
  })

  it('references the correct channel name', () => {
    const sql = createTriggerFunctionSQL('public', 'reactive_api')
    expect(sql).toContain("pg_notify('reactive_api_changes'")
  })

  it('includes truncation guard', () => {
    const sql = createTriggerFunctionSQL('public', 'reactive_api')
    expect(sql).toContain('_truncated')
    expect(sql).toContain('7900')
  })

  it('uses custom schema', () => {
    const sql = createTriggerFunctionSQL('myschema', 'reactive_api')
    expect(sql).toContain('myschema.reactive_api_notify_changes')
  })
})

describe('createTableTriggerSQL', () => {
  it('creates a trigger on the specified table', () => {
    const sql = createTableTriggerSQL('public', 'reactive_api', 'orders')
    expect(sql).toContain('CREATE TRIGGER reactive_api_notify_orders')
    expect(sql).toContain('public.orders')
  })

  it('covers INSERT OR UPDATE OR DELETE', () => {
    const sql = createTableTriggerSQL('public', 'reactive_api', 'orders')
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE')
  })

  it('is idempotent (wrapped in DO $$ IF NOT EXISTS)', () => {
    const sql = createTableTriggerSQL('public', 'reactive_api', 'orders')
    expect(sql).toContain('IF NOT EXISTS')
  })
})

describe('dropTableTriggerSQL', () => {
  it('generates DROP TRIGGER IF EXISTS', () => {
    const sql = dropTableTriggerSQL('public', 'reactive_api', 'orders')
    expect(sql).toContain('DROP TRIGGER IF EXISTS reactive_api_notify_orders')
    expect(sql).toContain('public.orders')
  })
})

describe('dropTriggerFunctionSQL', () => {
  it('generates DROP FUNCTION IF EXISTS', () => {
    const sql = dropTriggerFunctionSQL('public', 'reactive_api')
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.reactive_api_notify_changes')
  })
})
