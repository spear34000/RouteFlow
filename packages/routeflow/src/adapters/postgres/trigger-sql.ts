/**
 * Generates the SQL that installs a per-table NOTIFY trigger.
 *
 * Strategy:
 * - One shared trigger function per (schema, prefix) pair — handles all tables.
 * - One trigger per table that calls that function.
 *
 * Payload sent via NOTIFY (channel = `${triggerPrefix}_changes`):
 * ```json
 * {
 *   "table":      "orders",
 *   "operation":  "INSERT",
 *   "new_row":    { "id": 1, ... },
 *   "old_row":    null,
 *   "event_time": 1712345678901
 * }
 * ```
 *
 * `event_time` is a server-side Unix timestamp in **milliseconds** derived from
 * `clock_timestamp()` (wall-clock time, not transaction time). This is more
 * accurate than `Date.now()` on the Node.js side because it is measured at the
 * exact moment of the DB change.
 *
 * IMPORTANT: PostgreSQL NOTIFY payloads are limited to 8000 bytes.
 * When the full row payload exceeds 7900 bytes, row data is omitted and
 * `_truncated: true` is sent.  Callers that need the full row should re-query.
 */

// ── Identifier safety ────────────────────────────────────────────────────────

/**
 * Validate that a SQL identifier (schema, table, prefix, trigger name) contains
 * only safe characters. Prevents SQL injection via identifier interpolation.
 *
 * Allowed: letters, digits, underscore, dollar sign (standard SQL identifier chars).
 * Max length: 63 chars (PostgreSQL limit).
 */
export function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) {
    throw new Error(
      `[RouteFlow] Unsafe SQL identifier for ${label}: "${value}". ` +
        'Identifiers must start with a letter or underscore and contain only letters, digits, underscores, or dollar signs (max 63 chars).',
    )
  }
}

/** Double-quote a validated identifier (handles reserved words and case). */
function qi(identifier: string, label: string): string {
  assertSafeIdentifier(identifier, label)
  return `"${identifier}"`
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Channel name used for LISTEN/NOTIFY — one shared channel for all tables. */
export function notifyChannel(prefix: string): string {
  assertSafeIdentifier(prefix, 'prefix')
  return `${prefix}_changes`
}

/**
 * SQL to create (or replace) the shared trigger function.
 * The function encodes NEW/OLD as JSON and notifies the channel.
 *
 * The payload includes:
 * - `table`      — TG_TABLE_NAME
 * - `operation`  — TG_OP (INSERT | UPDATE | DELETE)
 * - `new_row`    — row_to_json(NEW), null for DELETE
 * - `old_row`    — row_to_json(OLD), null for INSERT
 * - `event_time` — millisecond timestamp from clock_timestamp()
 *
 * When the payload would exceed 7900 bytes (PostgreSQL NOTIFY limit ~8000):
 * - `new_row` and `old_row` are replaced with null
 * - `_truncated: true` is added
 * - `event_time` is still included
 */
export function createTriggerFunctionSQL(schema: string, prefix: string): string {
  const qSchema = qi(schema, 'schema')
  const qFn = `${qSchema}.${qi(`${prefix}_notify_changes`, 'function name')}`
  const channel = notifyChannel(prefix)

  return `
CREATE OR REPLACE FUNCTION ${qFn}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload    TEXT;
  new_row    JSON;
  old_row    JSON;
  event_time BIGINT;
BEGIN
  event_time := (extract(epoch from clock_timestamp()) * 1000)::bigint;

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
    'table',      TG_TABLE_NAME,
    'operation',  TG_OP,
    'new_row',    new_row,
    'old_row',    old_row,
    'event_time', event_time
  )::text;

  -- Truncate gracefully if payload exceeds pg's 8000-byte NOTIFY limit.
  -- event_time is preserved so callers can detect when the truncation happened.
  IF octet_length(payload) > 7900 THEN
    payload := json_build_object(
      'table',      TG_TABLE_NAME,
      'operation',  TG_OP,
      'new_row',    NULL,
      'old_row',    NULL,
      'event_time', event_time,
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
 * Idempotent — only installs if a trigger with this name does not already exist.
 */
export function createTableTriggerSQL(
  schema: string,
  prefix: string,
  table: string,
): string {
  const qSchema = qi(schema, 'schema')
  const qTable = qi(table, 'table')
  const triggerName = qi(`${prefix}_notify_${table}`, 'trigger name')
  const fnName = `${qSchema}.${qi(`${prefix}_notify_changes`, 'function name')}`
  // Use string-literal comparison for tgname — identifiers are validated above
  // so there is no injection risk; the literal matches PostgreSQL's internal name.
  const tgNameLiteral = `'${prefix}_notify_${table}'`

  return `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = ${tgNameLiteral}
      AND tgrelid = ${qSchema}.${qTable}::regclass::oid
  ) THEN
    CREATE TRIGGER ${triggerName}
    AFTER INSERT OR UPDATE OR DELETE ON ${qSchema}.${qTable}
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
  const qSchema = qi(schema, 'schema')
  const qTable = qi(table, 'table')
  const triggerName = qi(`${prefix}_notify_${table}`, 'trigger name')
  return `DROP TRIGGER IF EXISTS ${triggerName} ON ${qSchema}.${qTable};`
}

/**
 * SQL to drop the shared trigger function (used on full adapter teardown).
 */
export function dropTriggerFunctionSQL(schema: string, prefix: string): string {
  const qSchema = qi(schema, 'schema')
  const qFn = qi(`${prefix}_notify_changes`, 'function name')
  return `DROP FUNCTION IF EXISTS ${qSchema}.${qFn}();`
}
