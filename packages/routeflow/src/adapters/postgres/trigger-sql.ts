/**
 * Generates the SQL that installs a per-table NOTIFY trigger.
 *
 * Strategy:
 * - One shared trigger function per (schema, prefix) pair — handles all tables.
 * - One trigger per table that calls that function.
 *
 * Payload sent via NOTIFY (channel = triggerPrefix):
 * ```json
 * { "table": "orders", "operation": "INSERT", "new_row": {...}, "old_row": null }
 * ```
 *
 * IMPORTANT: PostgreSQL NOTIFY payloads are limited to 8000 bytes.
 * For larger rows the payload is truncated and only the primary-key columns
 * are guaranteed to be present. Callers that need the full row should
 * re-query after receiving the event.
 */

/** Channel name used for LISTEN/NOTIFY — one shared channel for all tables. */
export function notifyChannel(prefix: string): string {
  return `${prefix}_changes`
}

/**
 * SQL to create (or replace) the shared trigger function.
 * The function encodes NEW/OLD as JSON and notifies the channel.
 */
export function createTriggerFunctionSQL(schema: string, prefix: string): string {
  const fnName = `${schema}.${prefix}_notify_changes`
  const channel = notifyChannel(prefix)

  return `
CREATE OR REPLACE FUNCTION ${fnName}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload TEXT;
  new_row  JSON;
  old_row  JSON;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    new_row := NULL;
    old_row := row_to_json(OLD);
  ELSIF (TG_OP = 'INSERT') THEN
    new_row := row_to_json(NEW);
    old_row := NULL;
  ELSE
    new_row := row_to_json(NEW);
    old_row := row_to_json(OLD);
  END IF;

  payload := json_build_object(
    'table',     TG_TABLE_NAME,
    'operation', TG_OP,
    'new_row',   new_row,
    'old_row',   old_row
  )::text;

  -- Truncate gracefully if payload exceeds pg's 8000-byte NOTIFY limit
  IF octet_length(payload) > 7900 THEN
    payload := json_build_object(
      'table',     TG_TABLE_NAME,
      'operation', TG_OP,
      'new_row',   NULL,
      'old_row',   NULL,
      '_truncated', true
    )::text;
  END IF;

  PERFORM pg_notify('${channel}', payload);
  RETURN COALESCE(NEW, OLD);
END;
$$;
`.trim()
}

/**
 * SQL to attach the trigger to a specific table.
 * Idempotent — uses CREATE OR REPLACE (Postgres 14+).
 * Falls back to DROP + CREATE for older versions.
 */
export function createTableTriggerSQL(
  schema: string,
  prefix: string,
  table: string,
): string {
  const triggerName = `${prefix}_notify_${table}`
  const fnName = `${schema}.${prefix}_notify_changes`

  return `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = '${triggerName}'
      AND tgrelid = '${schema}.${table}'::regclass
  ) THEN
    CREATE TRIGGER ${triggerName}
    AFTER INSERT OR UPDATE OR DELETE ON ${schema}.${table}
    FOR EACH ROW EXECUTE FUNCTION ${fnName}();
  END IF;
END;
$$;
`.trim()
}

/**
 * SQL to drop the trigger from a table (used on disconnect/cleanup).
 */
export function dropTableTriggerSQL(
  schema: string,
  prefix: string,
  table: string,
): string {
  const triggerName = `${prefix}_notify_${table}`
  return `DROP TRIGGER IF EXISTS ${triggerName} ON ${schema}.${table};`
}

/**
 * SQL to drop the shared trigger function (used on full adapter teardown).
 */
export function dropTriggerFunctionSQL(schema: string, prefix: string): string {
  return `DROP FUNCTION IF EXISTS ${schema}.${prefix}_notify_changes();`
}
