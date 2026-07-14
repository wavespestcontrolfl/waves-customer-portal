/**
 * Reconcile time-tracking tables created by the retired admin-route runtime
 * DDL with the canonical migration shape.
 *
 * The route-era tables omitted columns now written unconditionally by the
 * time-tracking and payroll services. This migration is deliberately
 * non-destructive and idempotent: it adds omissions, widens known legacy
 * columns, and repairs defaults/nullability only after proving the existing
 * values are safe. Missing derived-summary columns are only safe to add
 * automatically while their table is empty; inventing zero values for an
 * existing approved payroll snapshot would be data corruption.
 *
 * Keep this migration ordered before staff_auth_hardening. If reconciliation
 * cannot acquire its locks or finds data that needs operator remediation, the
 * deployment must stop before any staff sessions or push subscriptions are
 * revoked.
 */

const TABLES = [
  'time_entries',
  'time_entry_daily_summary',
  'time_weekly_summary',
];

const REQUIRED_COLUMNS = {
  time_entries: [
    'clock_in_address',
    'edited_at',
    'original_clock_in',
    'original_clock_out',
    'staff_write_generation',
    'approval_status',
    'approved_by',
    'approved_at',
    'approval_notes',
  ],
  time_entry_daily_summary: [
    'total_admin_minutes',
    'first_clock_in',
    'last_clock_out',
    'rpmh_actual',
    'approved_by',
    'approved_at',
    'notes',
  ],
  time_weekly_summary: [
    'total_job_minutes',
    'total_drive_minutes',
    'total_revenue',
    'avg_rpmh',
    'utilization_pct',
    'approved_by',
    'approved_at',
    'approval_notes',
    'tech_signed_at',
    'tech_signature',
  ],
};

// These values are derived from historical time entries. Adding them with
// their canonical zero defaults to an existing summary would make unknown
// payroll data look authoritative. Approval/sign-off fields are different:
// they are nullable audit facts, so adding them to existing rows as NULL
// truthfully records that no approval or signature was captured in this
// schema.
const SUMMARY_COLUMNS_REQUIRING_EMPTY_TABLE = {
  time_entry_daily_summary: [
    'total_admin_minutes',
    'first_clock_in',
    'last_clock_out',
    'rpmh_actual',
  ],
  time_weekly_summary: [
    'total_job_minutes',
    'total_drive_minutes',
    'total_revenue',
    'avg_rpmh',
    'utilization_pct',
  ],
};

// Exact shapes owned by this reconciliation. These cover every column added
// here plus every material difference between the retired runtime DDL and the
// canonical migration. Base columns whose route-era and canonical definitions
// already match remain outside this list.
//
// `repair` is intentionally narrow. The migration widens the known legacy
// shapes, but an unrelated type is an operator-visible blocker rather than an
// invitation to coerce payroll/audit data speculatively.
const AUDITED_COLUMN_SHAPES = [
  { table: 'time_entries', column: 'entry_type', dataType: 'text', nullable: false, defaultKind: 'none', repair: 'text' },
  { table: 'time_entries', column: 'status', dataType: 'text', nullable: false, defaultKind: 'text', defaultValue: 'active', repair: 'text' },
  { table: 'time_entries', column: 'clock_in', dataType: 'timestamp with time zone', nullable: false, defaultKind: 'current_timestamp' },
  { table: 'time_entries', column: 'duration_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'none', repair: 'numeric_widen' },
  { table: 'time_entries', column: 'clock_in_address', dataType: 'text', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'service_type', dataType: 'character varying', characterMaximumLength: 255, nullable: true, defaultKind: 'none', repair: 'varchar_widen' },
  { table: 'time_entries', column: 'pay_type', dataType: 'character varying', characterMaximumLength: 255, nullable: true, defaultKind: 'text', defaultValue: 'hourly', repair: 'varchar_widen' },
  { table: 'time_entries', column: 'edited_by', dataType: 'uuid', nullable: true, defaultKind: 'none', repair: 'edited_by_uuid' },
  { table: 'time_entries', column: 'edited_at', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'original_clock_in', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'original_clock_out', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'source', dataType: 'character varying', characterMaximumLength: 255, nullable: true, defaultKind: 'text', defaultValue: 'app', repair: 'varchar_widen' },
  { table: 'time_entries', column: 'staff_write_generation', dataType: 'integer', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'approval_status', dataType: 'character varying', characterMaximumLength: 20, nullable: true, defaultKind: 'text', defaultValue: 'pending' },
  { table: 'time_entries', column: 'approved_by', dataType: 'uuid', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'approved_at', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entries', column: 'approval_notes', dataType: 'text', nullable: true, defaultKind: 'none' },

  { table: 'time_entry_daily_summary', column: 'total_shift_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'total_job_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'total_drive_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'total_break_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'total_admin_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'first_clock_in', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entry_daily_summary', column: 'last_clock_out', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entry_daily_summary', column: 'overtime_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'utilization_pct', dataType: 'numeric', numericPrecision: 5, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'revenue_generated', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'rpmh_actual', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_entry_daily_summary', column: 'status', dataType: 'character varying', characterMaximumLength: 20, nullable: false, defaultKind: 'text', defaultValue: 'pending' },
  { table: 'time_entry_daily_summary', column: 'approved_by', dataType: 'uuid', nullable: true, defaultKind: 'none' },
  { table: 'time_entry_daily_summary', column: 'approved_at', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_entry_daily_summary', column: 'notes', dataType: 'text', nullable: true, defaultKind: 'none' },

  { table: 'time_weekly_summary', column: 'total_shift_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'total_job_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'total_drive_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'regular_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'overtime_minutes', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'total_revenue', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'avg_rpmh', dataType: 'numeric', numericPrecision: 10, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'utilization_pct', dataType: 'numeric', numericPrecision: 5, numericScale: 2, nullable: true, defaultKind: 'zero', repair: 'numeric_widen' },
  { table: 'time_weekly_summary', column: 'status', dataType: 'character varying', characterMaximumLength: 20, nullable: false, defaultKind: 'text', defaultValue: 'pending' },
  { table: 'time_weekly_summary', column: 'approved_by', dataType: 'uuid', nullable: true, defaultKind: 'none' },
  { table: 'time_weekly_summary', column: 'approved_at', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_weekly_summary', column: 'approval_notes', dataType: 'text', nullable: true, defaultKind: 'none' },
  { table: 'time_weekly_summary', column: 'tech_signed_at', dataType: 'timestamp with time zone', nullable: true, defaultKind: 'none' },
  { table: 'time_weekly_summary', column: 'tech_signature', dataType: 'character varying', characterMaximumLength: 200, nullable: true, defaultKind: 'none' },
];

const REQUIRED_ENTRY_INDEXES = [
  {
    columns: ['technician_id'],
    name: 'time_entries_staff_technician_id_idx',
    definition: '(technician_id)',
  },
  {
    columns: ['technician_id', 'clock_in'],
    name: 'time_entries_staff_technician_clock_in_idx',
    definition: '(technician_id, clock_in)',
  },
  { columns: ['job_id'], name: 'time_entries_staff_job_id_idx', definition: '(job_id)' },
  { columns: ['status'], name: 'time_entries_staff_status_idx', definition: '(status)' },
  { columns: ['entry_type'], name: 'time_entries_staff_entry_type_idx', definition: '(entry_type)' },
  { columns: ['clock_in'], name: 'time_entries_staff_clock_in_idx', definition: '(clock_in)' },
];

const ALLOWED_TIME_ENTRY_VALUES = {
  entry_type: ['shift', 'job', 'break', 'drive', 'admin_time'],
  status: ['active', 'completed', 'edited', 'voided'],
};

function rowsFrom(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function columnShapeKey(table, column) {
  return `${table}.${column}`;
}

function normalizeColumnDefault(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .toLowerCase()
    .replace(/::(?:character varying|text|numeric|integer|timestamp with time zone)/g, '')
    .replace(/[\s()]/g, '');
}

function columnDefaultMatches(actual, expected) {
  const normalized = normalizeColumnDefault(actual);
  if (expected.defaultKind === 'none') return normalized === null;
  if (expected.defaultKind === 'current_timestamp') {
    return normalized === 'now' || normalized === 'current_timestamp';
  }
  if (expected.defaultKind === 'zero') {
    const numericLiteral = normalized?.replace(/^'([^']+)'$/, '$1');
    return numericLiteral !== null
      && /^[+-]?\d+(?:\.\d+)?$/.test(numericLiteral)
      && Number(numericLiteral) === 0;
  }
  if (expected.defaultKind === 'text') {
    return normalized === normalizeColumnDefault(sqlStringLiteral(expected.defaultValue));
  }
  throw new Error(`Unknown Staff schema default kind: ${expected.defaultKind}`);
}

function columnTypeMatches(actual, expected) {
  if (actual.data_type !== expected.dataType) return false;
  if (expected.characterMaximumLength !== undefined) {
    if (Number(actual.character_maximum_length) !== expected.characterMaximumLength) return false;
  }
  if (expected.numericPrecision !== undefined) {
    if (Number(actual.numeric_precision) !== expected.numericPrecision) return false;
  }
  if (expected.numericScale !== undefined) {
    if (Number(actual.numeric_scale) !== expected.numericScale) return false;
  }
  return true;
}

function expectedTypeSql(expected) {
  if (expected.dataType === 'character varying') {
    return `varchar(${expected.characterMaximumLength})`;
  }
  if (expected.dataType === 'numeric') {
    return `numeric(${expected.numericPrecision}, ${expected.numericScale})`;
  }
  if (expected.dataType === 'timestamp with time zone') return 'timestamptz';
  return expected.dataType;
}

function canRepairColumnType(actual, expected) {
  if (expected.repair === 'text') {
    return actual.data_type === 'character varying';
  }
  if (expected.repair === 'varchar_widen') {
    return actual.data_type === 'character varying'
      && actual.character_maximum_length !== null
      && Number(actual.character_maximum_length) <= expected.characterMaximumLength;
  }
  if (expected.repair === 'numeric_widen') {
    return actual.data_type === 'numeric'
      && actual.numeric_precision !== null
      && Number(actual.numeric_precision) <= expected.numericPrecision
      && Number(actual.numeric_scale) === expected.numericScale;
  }
  if (expected.repair === 'edited_by_uuid') {
    return actual.data_type === 'character varying' || actual.data_type === 'text';
  }
  return false;
}

async function loadAuditedColumnShapes(knex) {
  const result = await knex.raw(`
    SELECT table_name,
           column_name,
           data_type,
           character_maximum_length,
           numeric_precision,
           numeric_scale,
           is_nullable,
           column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(?::text[])
  `, [TABLES]);
  return new Map(rowsFrom(result).map((row) => [
    columnShapeKey(row.table_name, row.column_name),
    row,
  ]));
}

async function assertColumnHasNoNulls(knex, expected) {
  const result = await knex.raw(`
    SELECT COUNT(*)::integer AS null_count
    FROM ${expected.table}
    WHERE ${expected.column} IS NULL
  `);
  const nullCount = Number(rowsFrom(result)[0]?.null_count || 0);
  if (nullCount > 0) {
    throw new Error(
      `${expected.table}.${expected.column} contains ${nullCount} NULL value(s); `
      + 'backfill an operator-approved value before Staff schema reconciliation',
    );
  }
}

async function assertEditedByValuesAreUuid(knex) {
  const result = await knex.raw(`
    SELECT COUNT(*)::integer AS invalid_count
    FROM time_entries
    WHERE edited_by IS NOT NULL
      AND NOT pg_input_is_valid(BTRIM(edited_by::text), 'uuid')
  `);
  const invalidCount = Number(rowsFrom(result)[0]?.invalid_count || 0);
  if (invalidCount > 0) {
    throw new Error(
      `time_entries.edited_by contains ${invalidCount} non-UUID value(s); `
      + 'map them to technician UUIDs before Staff schema reconciliation',
    );
  }
}

async function repairColumnType(knex, actual, expected) {
  if (expected.repair === 'edited_by_uuid') await assertEditedByValuesAreUuid(knex);
  const typeSql = expectedTypeSql(expected);
  await knex.raw(`
    ALTER TABLE ${expected.table}
    ALTER COLUMN ${expected.column} TYPE ${typeSql}
    USING ${expected.column}::${typeSql}
  `);
}

async function reconcileAuditedColumnShapes(knex) {
  const actualShapes = await loadAuditedColumnShapes(knex);
  for (const expected of AUDITED_COLUMN_SHAPES) {
    const key = columnShapeKey(expected.table, expected.column);
    const actual = actualShapes.get(key);
    if (!actual) {
      throw new Error(`${key} is missing after Staff schema column reconciliation`);
    }

    if (!columnTypeMatches(actual, expected)) {
      if (!canRepairColumnType(actual, expected)) {
        throw new Error(
          `${key} has unsupported type ${actual.data_type}; expected ${expectedTypeSql(expected)}`,
        );
      }
      await repairColumnType(knex, actual, expected);
    }

    const isNullable = actual.is_nullable === 'YES';
    if (!expected.nullable && isNullable) {
      await assertColumnHasNoNulls(knex, expected);
      await knex.raw(`
        ALTER TABLE ${expected.table}
        ALTER COLUMN ${expected.column} SET NOT NULL
      `);
    } else if (expected.nullable && !isNullable) {
      // Widening nullability cannot invalidate or rewrite an existing value.
      await knex.raw(`
        ALTER TABLE ${expected.table}
        ALTER COLUMN ${expected.column} DROP NOT NULL
      `);
    }

    if (!columnDefaultMatches(actual.column_default, expected)) {
      const defaultClause = expected.defaultKind === 'none'
        ? 'DROP DEFAULT'
        : `SET DEFAULT ${expected.defaultKind === 'text'
          ? sqlStringLiteral(expected.defaultValue)
          : (expected.defaultKind === 'zero' ? '0' : 'CURRENT_TIMESTAMP')}`;
      await knex.raw(`
        ALTER TABLE ${expected.table}
        ALTER COLUMN ${expected.column} ${defaultClause}
      `);
    }
  }
}

async function loadColumnNames(knex) {
  const result = await knex.raw(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(?::text[])
  `, [TABLES]);
  const columns = new Map(TABLES.map((table) => [table, new Set()]));
  for (const row of rowsFrom(result)) {
    columns.get(row.table_name)?.add(row.column_name);
  }
  return columns;
}

async function indexShapeExists(knex, table, columns, { unique = false, primary = false } = {}) {
  const result = await knex.raw(`
    WITH index_shapes AS (
      SELECT i.indisunique,
             i.indisprimary,
             i.indisvalid,
             i.indisready,
             i.indpred IS NULL AS unfiltered,
             i.indexprs IS NULL AS plain_columns,
             am.amname AS access_method,
             ARRAY(
               SELECT a.attname::text
               FROM unnest(string_to_array(BTRIM(i.indkey::text), ' ')::smallint[])
                    WITH ORDINALITY AS key(attnum, position)
               JOIN pg_attribute a
                 ON a.attrelid = i.indrelid
                AND a.attnum = key.attnum
               WHERE key.position <= i.indnkeyatts
               ORDER BY key.position
             ) AS key_columns
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_am am ON am.oid = idx.relam
      WHERE n.nspname = current_schema()
        AND t.relname = ?
    )
    SELECT EXISTS (
      SELECT 1
      FROM index_shapes
      WHERE indisvalid
        AND indisready
        AND unfiltered
        AND plain_columns
        AND access_method = 'btree'
        AND key_columns = ?::text[]
        AND (?::boolean = false OR indisunique)
        AND (?::boolean = false OR indisprimary)
    ) AS exists
  `, [table, columns, unique, primary]);
  return rowsFrom(result)[0]?.exists === true;
}

async function tableHasPrimaryKey(knex, table) {
  const result = await knex.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = ?
        AND c.contype = 'p'
    ) AS exists
  `, [table]);
  return rowsFrom(result)[0]?.exists === true;
}

async function assertKeyData(knex, table, uniqueColumns = []) {
  const uniqueGroup = uniqueColumns.length
    ? `EXISTS (
        SELECT 1 FROM ${table}
        GROUP BY ${uniqueColumns.join(', ')}
        HAVING COUNT(*) > 1
      )`
    : 'false';
  const nullUnique = uniqueColumns.length
    ? `EXISTS (
        SELECT 1 FROM ${table}
        WHERE ${uniqueColumns.map((column) => `${column} IS NULL`).join(' OR ')}
      )`
    : 'false';
  const result = await knex.raw(`
    SELECT EXISTS (SELECT 1 FROM ${table} WHERE id IS NULL) AS null_id,
           EXISTS (
             SELECT 1 FROM ${table} GROUP BY id HAVING COUNT(*) > 1
           ) AS duplicate_id,
           ${nullUnique} AS null_unique_key,
           ${uniqueGroup} AS duplicate_unique_key
  `);
  const row = rowsFrom(result)[0] || {};
  if (row.null_id || row.duplicate_id || row.null_unique_key || row.duplicate_unique_key) {
    throw new Error(
      `${table} has null or duplicate identity values; run the Staff rollout audit and reconcile the rows manually`,
    );
  }
}

async function ensureGeneratedIntegerId(knex, table, sequenceName) {
  const result = await knex.raw(`
    SELECT pg_get_serial_sequence(
             FORMAT('%I.%I', current_schema(), ?::text),
             'id'
           ) AS sequence_name,
           column_default,
           is_identity
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ?
      AND column_name = 'id'
  `, [table, table]);
  const identity = rowsFrom(result)[0] || {};
  let ownedSequence = identity.sequence_name;

  if (!ownedSequence) {
    await knex.raw(`CREATE SEQUENCE IF NOT EXISTS ${sequenceName}`);
    await knex.raw(`ALTER SEQUENCE ${sequenceName} OWNED BY ${table}.id`);
    ownedSequence = sequenceName;
  }
  if (identity.is_identity !== 'YES') {
    // PostgreSQL utility statements do not accept bind parameters in a column
    // default. `ownedSequence` comes from pg_get_serial_sequence (or the fixed
    // internal name above); escape it as a regclass string literal. Always set
    // the canonical generator: retaining an unrelated pre-existing default can
    // make inserts collide even though the sequence itself was repaired.
    await knex.raw(`
      ALTER TABLE ${table}
      ALTER COLUMN id SET DEFAULT nextval(${sqlStringLiteral(ownedSequence)}::regclass)
    `);
  }

  // A restored table can have ids beyond its owned sequence. Never move an
  // already-ahead sequence backward; only advance it when its next value
  // would collide with an existing row.
  const stateResult = await knex.raw(`
    SELECT (SELECT MAX(id)::bigint FROM ??) AS max_id,
           last_value::bigint,
           is_called
    FROM ??
  `, [table, ownedSequence]);
  const state = rowsFrom(stateResult)[0] || {};
  if (state.max_id !== null && state.max_id !== undefined) {
    const maxId = Number(state.max_id);
    const lastValue = Number(state.last_value);
    const nextValue = state.is_called ? lastValue + 1 : lastValue;
    if (nextValue <= maxId) {
      await knex.raw('SELECT setval(?::regclass, ?::bigint, true)', [
        ownedSequence,
        Math.max(maxId, lastValue),
      ]);
    }
  }
}

async function ensureGeneratedUuidId(knex, table) {
  const result = await knex.raw(`
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ?
      AND column_name = 'id'
  `, [table]);
  const defaultExpression = String(rowsFrom(result)[0]?.column_default || '')
    .toLowerCase()
    .replace(/["\s]/g, '');
  if (/^(?:[a-z_][a-z0-9_]*[.]){0,1}gen_random_uuid[(][)](?:::uuid)?$/.test(defaultExpression)) {
    return;
  }
  await knex.raw(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
}

function normalizeCheckConstraintDefinition(definition) {
  return String(definition || '')
    .toLowerCase()
    .replace(/::(?:character varying|text|bpchar|smallint|integer|bigint)(?:\[\])?/g, '')
    .replace(/\bcheck\b/g, '')
    .replace(/["\s()]/g, '')
    // PostgreSQL renders `x IS NOT DISTINCT FROM y` from pg_get_constraintdef
    // as the equivalent `NOT x IS DISTINCT FROM y`. Canonicalize that server
    // spelling so an idempotent rerun does not replace a correct constraint.
    .replace(/not([a-z_][a-z0-9_.]*)isdistinctfrom/g, '$1isnotdistinctfrom');
}

async function loadNamedCheckConstraints(knex, table, names) {
  const result = await knex.raw(`
    SELECT c.conname,
           c.convalidated,
           c.connoinherit,
           pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = ?
      AND c.contype = 'c'
      AND c.conname = ANY(?::text[])
  `, [table, names]);
  return rowsFrom(result);
}

function exactCheckConstraint(constraint, expectedDefinition) {
  return constraint.convalidated === true
    && constraint.connoinherit !== true
    && normalizeCheckConstraintDefinition(constraint.definition)
      === normalizeCheckConstraintDefinition(expectedDefinition);
}

async function reconcileNamedCheckConstraint(
  knex,
  { table, names, reconcileName, expectedDefinition, expression },
) {
  const constraints = await loadNamedCheckConstraints(knex, table, names);
  let hasExactConstraint = false;
  for (const constraint of constraints) {
    if (exactCheckConstraint(constraint, expectedDefinition)) {
      hasExactConstraint = true;
      continue;
    }
    // A familiar name is not evidence of familiar semantics. Remove only the
    // two owned names, under the migration's exclusive lock, before adding the
    // exact canonical predicate.
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint.conname}`);
  }
  if (!hasExactConstraint) {
    await knex.raw(`
      ALTER TABLE ${table}
      ADD CONSTRAINT ${reconcileName} CHECK (${expression})
    `);
  }
}

async function ensureAllowedTimeEntryValues(knex, column, allowedValues) {
  const canonicalName = `time_entries_${column}_check`;
  const reconcileName = `time_entries_staff_${column}_check`;
  const literals = allowedValues.map((value) => sqlStringLiteral(value)).join(', ');
  const expectedDefinition = `CHECK (${column} = ANY (ARRAY[${literals}]::text[]))`;
  const constraints = await loadNamedCheckConstraints(
    knex, 'time_entries', [canonicalName, reconcileName],
  );
  const hasExactConstraint = constraints.some((constraint) => (
    exactCheckConstraint(constraint, expectedDefinition)
  ));

  if (!hasExactConstraint) {
    const placeholders = allowedValues.map(() => '?').join(', ');
    const invalidResult = await knex.raw(`
      SELECT EXISTS (
        SELECT 1
        FROM time_entries
        WHERE ${column} IS NULL
           OR ${column} NOT IN (${placeholders})
      ) AS exists
    `, allowedValues);
    if (rowsFrom(invalidResult)[0]?.exists) {
      throw new Error(
        `time_entries.${column} contains values outside the Staff payroll contract; reconcile them manually`,
      );
    }
  }

  await reconcileNamedCheckConstraint(knex, {
    table: 'time_entries',
    names: [canonicalName, reconcileName],
    reconcileName,
    expectedDefinition,
    expression: `${column} IN (${literals})`,
  });
}

async function ensurePrimaryKey(knex, table, constraintName) {
  if (await indexShapeExists(knex, table, ['id'], { unique: true, primary: true })) return;
  if (await tableHasPrimaryKey(knex, table)) {
    throw new Error(`${table} has a primary key that is not exactly (id)`);
  }
  await knex.raw(`ALTER TABLE ${table} ALTER COLUMN id SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} PRIMARY KEY (id)`);
}

async function ensureUniqueKey(knex, table, columns, constraintName) {
  if (await indexShapeExists(knex, table, columns, { unique: true })) return;
  for (const column of columns) {
    await knex.raw(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
  }
  await knex.raw(`
    ALTER TABLE ${table}
    ADD CONSTRAINT ${constraintName} UNIQUE (${columns.join(', ')})
  `);
}

async function ensureTimeEntryIndexes(knex) {
  for (const index of REQUIRED_ENTRY_INDEXES) {
    // Semantic inspection avoids accepting a wrong same-named index and also
    // avoids duplicating an equivalent index with a noncanonical legacy name.
    if (await indexShapeExists(knex, 'time_entries', index.columns)) continue;
    await knex.raw(`CREATE INDEX ${index.name} ON time_entries ${index.definition}`);
  }
}

async function addMissingColumns(knex, missing) {
  if (missing.time_entries.length) {
    await knex.schema.alterTable('time_entries', (table) => {
      if (missing.time_entries.includes('clock_in_address')) table.text('clock_in_address');
      if (missing.time_entries.includes('edited_at')) table.timestamp('edited_at');
      if (missing.time_entries.includes('original_clock_in')) table.timestamp('original_clock_in');
      if (missing.time_entries.includes('original_clock_out')) table.timestamp('original_clock_out');
      if (missing.time_entries.includes('staff_write_generation')) {
        table.integer('staff_write_generation');
      }
      // Add approval_status without its default first so historical rows keep
      // an explicit unknown (NULL). Shape reconciliation installs the
      // canonical 'pending' default only for future inserts.
      if (missing.time_entries.includes('approval_status')) {
        table.string('approval_status', 20).nullable();
      }
      if (missing.time_entries.includes('approved_by')) table.uuid('approved_by').nullable();
      if (missing.time_entries.includes('approved_at')) table.timestamp('approved_at').nullable();
      if (missing.time_entries.includes('approval_notes')) table.text('approval_notes').nullable();
    });
  }

  if (missing.time_entry_daily_summary.length) {
    await knex.schema.alterTable('time_entry_daily_summary', (table) => {
      if (missing.time_entry_daily_summary.includes('total_admin_minutes')) {
        table.decimal('total_admin_minutes', 10, 2).defaultTo(0);
      }
      if (missing.time_entry_daily_summary.includes('first_clock_in')) table.timestamp('first_clock_in');
      if (missing.time_entry_daily_summary.includes('last_clock_out')) table.timestamp('last_clock_out');
      if (missing.time_entry_daily_summary.includes('rpmh_actual')) {
        table.decimal('rpmh_actual', 10, 2).defaultTo(0);
      }
      if (missing.time_entry_daily_summary.includes('approved_by')) table.uuid('approved_by');
      if (missing.time_entry_daily_summary.includes('approved_at')) table.timestamp('approved_at');
      if (missing.time_entry_daily_summary.includes('notes')) table.text('notes');
    });
  }

  if (missing.time_weekly_summary.length) {
    await knex.schema.alterTable('time_weekly_summary', (table) => {
      if (missing.time_weekly_summary.includes('total_job_minutes')) {
        table.decimal('total_job_minutes', 10, 2).defaultTo(0);
      }
      if (missing.time_weekly_summary.includes('total_drive_minutes')) {
        table.decimal('total_drive_minutes', 10, 2).defaultTo(0);
      }
      if (missing.time_weekly_summary.includes('total_revenue')) {
        table.decimal('total_revenue', 10, 2).defaultTo(0);
      }
      if (missing.time_weekly_summary.includes('avg_rpmh')) {
        table.decimal('avg_rpmh', 10, 2).defaultTo(0);
      }
      if (missing.time_weekly_summary.includes('utilization_pct')) {
        table.decimal('utilization_pct', 5, 2).defaultTo(0);
      }
      if (missing.time_weekly_summary.includes('approved_by')) {
        table.uuid('approved_by').nullable();
      }
      if (missing.time_weekly_summary.includes('approved_at')) {
        table.timestamp('approved_at').nullable();
      }
      if (missing.time_weekly_summary.includes('approval_notes')) {
        table.text('approval_notes').nullable();
      }
      if (missing.time_weekly_summary.includes('tech_signed_at')) {
        table.timestamp('tech_signed_at').nullable();
      }
      if (missing.time_weekly_summary.includes('tech_signature')) {
        table.string('tech_signature', 200).nullable();
      }
    });
  }
}

async function ensureActiveWriterGenerationConstraint(knex) {
  const constraintName = 'time_entries_staff_active_write_generation_check';
  // Completed historical rows may remain NULL. Only a writer from the Phase-A
  // application generation may create/reopen an active timer after this
  // migration commits; the pre-reconciliation application omits the column
  // and therefore fails closed during the cutover gap.
  const expression = `
      status <> 'active'
      OR staff_write_generation IS NOT DISTINCT FROM 1
  `;
  await reconcileNamedCheckConstraint(knex, {
    table: 'time_entries',
    names: [constraintName],
    reconcileName: constraintName,
    expectedDefinition: `CHECK (${expression})`,
    expression,
  });
}

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      throw new Error(`${table} is missing; apply the canonical time-tracking migrations first`);
    }
  }

  // Knex wraps this migration in a transaction. The short timeout fails the
  // pre-deploy cleanly instead of waiting behind a long-running timer write.
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw(`
    LOCK TABLE time_entries,
               time_entry_daily_summary,
               time_weekly_summary
    IN ACCESS EXCLUSIVE MODE
  `);

  // Close the audit-to-deploy race under the same lock that protects the DDL.
  // The generation constraint installed below then keeps the pre-reconcile
  // application from starting a timer after this transaction commits.
  const activeTimerResult = await knex.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM time_entries
      WHERE status = 'active'
    ) AS exists
  `);
  if (rowsFrom(activeTimerResult)[0]?.exists) {
    throw new Error('Active Staff timers must be clocked out before schema reconciliation');
  }

  const existing = await loadColumnNames(knex);
  const missing = Object.fromEntries(TABLES.map((table) => [
    table,
    REQUIRED_COLUMNS[table].filter((column) => !existing.get(table)?.has(column)),
  ]));
  const missingDerived = Object.fromEntries(
    Object.entries(SUMMARY_COLUMNS_REQUIRING_EMPTY_TABLE).map(([table, columns]) => [
      table,
      columns.filter((column) => missing[table].includes(column)),
    ]),
  );

  if (missingDerived.time_entry_daily_summary.length || missingDerived.time_weekly_summary.length) {
    const countResult = await knex.raw(`
      SELECT (SELECT COUNT(*)::integer FROM time_entry_daily_summary) AS daily_count,
             (SELECT COUNT(*)::integer FROM time_weekly_summary) AS weekly_count
    `);
    const counts = rowsFrom(countResult)[0] || {};
    if (missingDerived.time_entry_daily_summary.length && Number(counts.daily_count) > 0) {
      throw new Error(
        'time_entry_daily_summary contains rows but lacks derived payroll columns; reconcile them before deployment',
      );
    }
    if (missingDerived.time_weekly_summary.length && Number(counts.weekly_count) > 0) {
      throw new Error(
        'time_weekly_summary contains rows but lacks derived payroll columns; reconcile them before deployment',
      );
    }
  }

  await addMissingColumns(knex, missing);
  await reconcileAuditedColumnShapes(knex);

  for (const [column, allowedValues] of Object.entries(ALLOWED_TIME_ENTRY_VALUES)) {
    await ensureAllowedTimeEntryValues(knex, column, allowedValues);
  }
  await ensureActiveWriterGenerationConstraint(knex);

  const hasTimeEntryPrimary = await indexShapeExists(
    knex,
    'time_entries',
    ['id'],
    { unique: true, primary: true },
  );
  if (!hasTimeEntryPrimary) await assertKeyData(knex, 'time_entries');
  await ensureGeneratedUuidId(knex, 'time_entries');
  await ensurePrimaryKey(knex, 'time_entries', 'time_entries_staff_reconcile_pkey');

  const hasDailyPrimary = await indexShapeExists(
    knex,
    'time_entry_daily_summary',
    ['id'],
    { unique: true, primary: true },
  );
  const hasDailyUnique = await indexShapeExists(
    knex,
    'time_entry_daily_summary',
    ['technician_id', 'work_date'],
    { unique: true },
  );
  if (!hasDailyPrimary || !hasDailyUnique) {
    await assertKeyData(
      knex,
      'time_entry_daily_summary',
      ['technician_id', 'work_date'],
    );
  }
  await ensureGeneratedIntegerId(
    knex,
    'time_entry_daily_summary',
    'time_entry_daily_summary_staff_id_seq',
  );
  await ensurePrimaryKey(
    knex,
    'time_entry_daily_summary',
    'time_entry_daily_summary_staff_reconcile_pkey',
  );
  await ensureUniqueKey(
    knex,
    'time_entry_daily_summary',
    ['technician_id', 'work_date'],
    'time_entry_daily_summary_staff_tech_date_key',
  );

  const hasWeeklyPrimary = await indexShapeExists(
    knex,
    'time_weekly_summary',
    ['id'],
    { unique: true, primary: true },
  );
  const hasWeeklyUnique = await indexShapeExists(
    knex,
    'time_weekly_summary',
    ['technician_id', 'week_start'],
    { unique: true },
  );
  if (!hasWeeklyPrimary || !hasWeeklyUnique) {
    await assertKeyData(
      knex,
      'time_weekly_summary',
      ['technician_id', 'week_start'],
    );
  }
  await ensureGeneratedIntegerId(
    knex,
    'time_weekly_summary',
    'time_weekly_summary_staff_id_seq',
  );
  await ensurePrimaryKey(
    knex,
    'time_weekly_summary',
    'time_weekly_summary_staff_reconcile_pkey',
  );
  await ensureUniqueKey(
    knex,
    'time_weekly_summary',
    ['technician_id', 'week_start'],
    'time_weekly_summary_staff_tech_week_key',
  );

  await ensureTimeEntryIndexes(knex);
};

exports.down = async function down() {
  // Intentionally forward-only. This migration repairs environment-dependent
  // drift and cannot know which columns, constraints, sequences, or indexes
  // were inherited from the canonical migration. Dropping any of them could
  // destroy payroll/audit data and break the still-supported application.
};

exports.AUDITED_COLUMN_SHAPES = AUDITED_COLUMN_SHAPES;
exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
exports.REQUIRED_ENTRY_INDEXES = REQUIRED_ENTRY_INDEXES;
exports.columnDefaultMatches = columnDefaultMatches;
exports.columnTypeMatches = columnTypeMatches;
exports.exactCheckConstraint = exactCheckConstraint;
exports.indexShapeExists = indexShapeExists;
exports.normalizeCheckConstraintDefinition = normalizeCheckConstraintDefinition;
exports.rowsFrom = rowsFrom;
exports.sqlStringLiteral = sqlStringLiteral;
