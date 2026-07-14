#!/usr/bin/env node

/**
 * Read-only production verification for the deployed Staff authentication,
 * session-revocation, and payroll contract.
 *
 * Default output is counts only. `--details` adds structural identifiers and
 * payroll timing metadata, so use it only in a restricted operator terminal.
 * For machine-readable output, keep npm's own script banner off stdout:
 * `npm run --silent audit:staff-rollout -- --json`.
 * During a controlled rollout, run the previous release's copy before its
 * migration, then run this release's copy after the new application is live.
 */
const db = require('../models/db');
const {
  ACTIVE_WRITE_GENERATION,
  WEEKLY_OT_THRESHOLD_MINUTES: WEEKLY_OVERTIME_THRESHOLD_MINUTES,
} = require('../constants/staff-time');
const {
  AUDITED_COLUMN_SHAPES,
  normalizeCheckConstraintDefinition,
  sqlStringLiteral,
} = require('../models/migrations/20260711000002_staff_time_schema_reconciliation');
const {
  RESET_LINK_TTL_MINUTES,
} = require('../services/staff-password-reset-email');
const {
  MAX_STAFF_EMAIL_LENGTH,
} = require('../utils/staff-identity');

const SAMPLE_LIMIT = 25;
const SCHEMA_DEPENDENCY_ERROR_CODES = new Set(['42P01', '42703']);

const AUDITED_COLUMN_SHAPE_VALUES = AUDITED_COLUMN_SHAPES.map((shape) => `(
  ${sqlStringLiteral(shape.table)},
  ${sqlStringLiteral(shape.column)},
  ${sqlStringLiteral(shape.dataType)},
  ${shape.characterMaximumLength ?? 'NULL'}::integer,
  ${shape.numericPrecision ?? 'NULL'}::integer,
  ${shape.numericScale ?? 'NULL'}::integer,
  ${shape.nullable}::boolean,
  ${sqlStringLiteral(shape.defaultKind)},
  ${shape.defaultValue === undefined ? 'NULL' : sqlStringLiteral(shape.defaultValue)}
)`).join(',\n');

const EXPECTED_CHECK_DEFINITIONS = {
  entryType: normalizeCheckConstraintDefinition(`
    CHECK (entry_type = ANY (ARRAY['shift', 'job', 'break', 'drive', 'admin_time']::text[]))
  `),
  status: normalizeCheckConstraintDefinition(`
    CHECK (status = ANY (ARRAY['active', 'completed', 'edited', 'voided']::text[]))
  `),
  activeWriter: normalizeCheckConstraintDefinition(`
    CHECK (
      status <> 'active'
      OR staff_write_generation IS NOT DISTINCT FROM ${Number(ACTIVE_WRITE_GENERATION)}
    )
  `),
};

function rowsFrom(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

function expectedDailyOvertimeMinutes(priorWeekShiftMinutes, dayShiftMinutes) {
  const prior = Number(priorWeekShiftMinutes) || 0;
  const day = Number(dayShiftMinutes) || 0;
  const overtime = Math.max(
    0,
    Math.min(day, prior + day - WEEKLY_OVERTIME_THRESHOLD_MINUTES),
  );
  return Math.round(overtime * 100) / 100;
}

async function runCheck(trx, check) {
  // Count in PostgreSQL and return only a bounded sample. Several checks can
  // legitimately find thousands of historical rows; transferring all of them
  // to Node defeats the purpose of a low-impact production preflight.
  const result = await trx.raw(`
    SELECT findings.*, COUNT(*) OVER()::integer AS __total_count
    FROM (${check.sql}) AS findings
    LIMIT ?
  `, [SAMPLE_LIMIT]);
  const rawRows = rowsFrom(result);
  const count = rawRows.length ? Number(rawRows[0].__total_count) : 0;
  const rows = rawRows.map(({ __total_count: _totalCount, ...row }) => row);
  return {
    key: check.key,
    description: check.description,
    blocking: check.blocking !== false,
    count,
    rows,
  };
}

async function runDataCheck(trx, check) {
  try {
    // A nested Knex transaction is a SAVEPOINT. If a legacy schema makes one
    // query fail, rolling back to it keeps the outer repeatable-read snapshot
    // usable so the audit can report every remaining blocker.
    return await trx.transaction((savepoint) => runCheck(savepoint, check));
  } catch (error) {
    if (!SCHEMA_DEPENDENCY_ERROR_CODES.has(error.code)) throw error;
    return {
      key: check.key,
      description: `${check.description} (not evaluated because required schema is missing)`,
      blocking: true,
      count: 1,
      rows: [],
      incomplete: true,
      errorCode: error.code,
    };
  }
}

const checks = [
  {
    key: 'staff_time_schema_columns',
    description: 'Required Staff time-tracking columns are missing; apply schema reconciliation first',
    schema: true,
    sql: `
      WITH required(table_name, column_name) AS (
        VALUES
          ('time_entries', 'id'),
          ('time_entries', 'technician_id'),
          ('time_entries', 'entry_type'),
          ('time_entries', 'status'),
          ('time_entries', 'clock_in'),
          ('time_entries', 'clock_out'),
          ('time_entries', 'duration_minutes'),
          ('time_entries', 'job_id'),
          ('time_entries', 'customer_id'),
          ('time_entries', 'clock_in_lat'),
          ('time_entries', 'clock_in_lng'),
          ('time_entries', 'clock_out_lat'),
          ('time_entries', 'clock_out_lng'),
          ('time_entries', 'clock_in_address'),
          ('time_entries', 'service_type'),
          ('time_entries', 'pay_type'),
          ('time_entries', 'notes'),
          ('time_entries', 'edit_reason'),
          ('time_entries', 'edited_by'),
          ('time_entries', 'edited_at'),
          ('time_entries', 'original_clock_in'),
          ('time_entries', 'original_clock_out'),
          ('time_entries', 'staff_write_generation'),
          ('time_entries', 'source'),
          ('time_entries', 'created_at'),
          ('time_entries', 'updated_at'),
          ('time_entries', 'approval_status'),
          ('time_entries', 'approved_by'),
          ('time_entries', 'approved_at'),
          ('time_entries', 'approval_notes'),
          ('time_entry_daily_summary', 'id'),
          ('time_entry_daily_summary', 'technician_id'),
          ('time_entry_daily_summary', 'work_date'),
          ('time_entry_daily_summary', 'total_shift_minutes'),
          ('time_entry_daily_summary', 'total_job_minutes'),
          ('time_entry_daily_summary', 'total_drive_minutes'),
          ('time_entry_daily_summary', 'total_break_minutes'),
          ('time_entry_daily_summary', 'total_admin_minutes'),
          ('time_entry_daily_summary', 'job_count'),
          ('time_entry_daily_summary', 'first_clock_in'),
          ('time_entry_daily_summary', 'last_clock_out'),
          ('time_entry_daily_summary', 'overtime_minutes'),
          ('time_entry_daily_summary', 'utilization_pct'),
          ('time_entry_daily_summary', 'revenue_generated'),
          ('time_entry_daily_summary', 'rpmh_actual'),
          ('time_entry_daily_summary', 'status'),
          ('time_entry_daily_summary', 'approved_by'),
          ('time_entry_daily_summary', 'approved_at'),
          ('time_entry_daily_summary', 'notes'),
          ('time_entry_daily_summary', 'created_at'),
          ('time_entry_daily_summary', 'updated_at'),
          ('time_weekly_summary', 'id'),
          ('time_weekly_summary', 'technician_id'),
          ('time_weekly_summary', 'week_start'),
          ('time_weekly_summary', 'week_end'),
          ('time_weekly_summary', 'total_shift_minutes'),
          ('time_weekly_summary', 'total_job_minutes'),
          ('time_weekly_summary', 'total_drive_minutes'),
          ('time_weekly_summary', 'regular_minutes'),
          ('time_weekly_summary', 'overtime_minutes'),
          ('time_weekly_summary', 'days_worked'),
          ('time_weekly_summary', 'job_count'),
          ('time_weekly_summary', 'total_revenue'),
          ('time_weekly_summary', 'avg_rpmh'),
          ('time_weekly_summary', 'utilization_pct'),
          ('time_weekly_summary', 'status'),
          ('time_weekly_summary', 'created_at'),
          ('time_weekly_summary', 'updated_at'),
          ('time_weekly_summary', 'approved_by'),
          ('time_weekly_summary', 'approved_at'),
          ('time_weekly_summary', 'approval_notes'),
          ('time_weekly_summary', 'tech_signed_at'),
          ('time_weekly_summary', 'tech_signature')
      )
      SELECT required.table_name, required.column_name
      FROM required
      LEFT JOIN information_schema.columns existing
        ON existing.table_schema = current_schema()
       AND existing.table_name = required.table_name
       AND existing.column_name = required.column_name
      WHERE existing.column_name IS NULL
      ORDER BY required.table_name, required.column_name
    `,
  },
  {
    key: 'staff_auth_schema_columns',
    description: 'Required Staff authentication/session-revocation columns are missing; apply auth hardening first',
    schema: true,
    sql: `
      WITH required(table_name, column_name) AS (
        VALUES
          ('technicians', 'auth_token_version'),
          ('technicians', 'must_change_password'),
          ('technicians', 'password_changed_at'),
          ('technicians', 'password_reset_token_hash'),
          ('technicians', 'password_reset_expires_at'),
          ('technicians', 'password_reset_requested_at'),
          ('push_subscriptions', 'staff_token_version')
      )
      SELECT required.table_name, required.column_name
      FROM required
      LEFT JOIN information_schema.columns existing
        ON existing.table_schema = current_schema()
       AND existing.table_name = required.table_name
       AND existing.column_name = required.column_name
      WHERE existing.column_name IS NULL
      ORDER BY required.table_name, required.column_name
    `,
  },
  {
    key: 'staff_auth_schema_column_shapes',
    description: 'Staff authentication/session-revocation column shape differs from the Phase B contract',
    schema: true,
    sql: `
      WITH expected(
        table_name,
        column_name,
        data_type,
        character_maximum_length,
        nullable,
        normalized_default
      ) AS (
        VALUES
          ('technicians', 'auth_token_version', 'integer', NULL::integer, false, '1'),
          ('technicians', 'must_change_password', 'boolean', NULL::integer, false, 'false'),
          ('technicians', 'password_changed_at', 'timestamp with time zone', NULL::integer, true, NULL),
          ('technicians', 'password_reset_token_hash', 'character varying', 64, true, NULL),
          ('technicians', 'password_reset_expires_at', 'timestamp with time zone', NULL::integer, true, NULL),
          ('technicians', 'password_reset_requested_at', 'timestamp with time zone', NULL::integer, true, NULL),
          ('push_subscriptions', 'staff_token_version', 'integer', NULL::integer, true, NULL)
      ), existing AS (
        SELECT columns.*,
               REGEXP_REPLACE(
                 REGEXP_REPLACE(
                   LOWER(columns.column_default),
                   '::(boolean|integer)',
                   '',
                   'g'
                 ),
                 '[[:space:]()]',
                 '',
                 'g'
               ) AS normalized_default
        FROM information_schema.columns columns
        WHERE columns.table_schema = current_schema()
          AND columns.table_name IN ('technicians', 'push_subscriptions')
      )
      SELECT expected.table_name,
             expected.column_name,
             expected.data_type AS expected_data_type,
             existing.data_type AS actual_data_type,
             expected.character_maximum_length AS expected_character_maximum_length,
             existing.character_maximum_length AS actual_character_maximum_length,
             expected.nullable AS expected_nullable,
             existing.is_nullable = 'YES' AS actual_nullable,
             expected.normalized_default AS expected_default,
             existing.column_default AS actual_default
      FROM expected
      LEFT JOIN existing
        ON existing.table_name = expected.table_name
       AND existing.column_name = expected.column_name
      WHERE existing.column_name IS NULL
         OR existing.data_type IS DISTINCT FROM expected.data_type
         OR (
           expected.character_maximum_length IS NOT NULL
           AND existing.character_maximum_length
                 IS DISTINCT FROM expected.character_maximum_length
         )
         OR (existing.is_nullable = 'YES') IS DISTINCT FROM expected.nullable
         OR (
           expected.normalized_default IS NULL
           AND existing.column_default IS NOT NULL
         )
         OR (
           expected.normalized_default IS NOT NULL
           AND existing.normalized_default
                 IS DISTINCT FROM expected.normalized_default
         )
      ORDER BY expected.table_name, expected.column_name
    `,
  },
  {
    key: 'staff_auth_schema_indexes',
    description: 'Required Staff authentication/session-revocation index is missing or invalid',
    schema: true,
    sql: `
      WITH required(table_name, index_name, should_be_unique, key_columns) AS (
        VALUES
          (
            'technicians',
            'technicians_staff_email_canonical_uidx',
            true,
            NULL::text[]
          ),
          (
            'technicians',
            'technicians_password_reset_token_hash_idx',
            false,
            ARRAY['password_reset_token_hash']::text[]
          ),
          (
            'push_subscriptions',
            'push_subscriptions_staff_token_version_idx',
            false,
            ARRAY['admin_user_id', 'staff_token_version']::text[]
          )
      ), existing AS (
        SELECT table_class.relname AS table_name,
               index_class.relname AS index_name,
               access_method.amname AS access_method,
               index_meta.indisunique,
               index_meta.indisvalid,
               index_meta.indisready,
               index_meta.indnatts,
               index_meta.indnkeyatts,
               ARRAY(
                 SELECT attribute.attname::text
                 FROM unnest(
                   string_to_array(BTRIM(index_meta.indkey::text), ' ')::smallint[]
                 ) WITH ORDINALITY indexed_key(attnum, ordinal_position)
                 LEFT JOIN pg_attribute attribute
                   ON attribute.attrelid = index_meta.indrelid
                  AND attribute.attnum = indexed_key.attnum
                 WHERE indexed_key.ordinal_position <= index_meta.indnkeyatts
                 ORDER BY indexed_key.ordinal_position
               ) AS key_columns,
               PG_GET_INDEXDEF(index_meta.indexrelid) AS index_definition,
               PG_GET_EXPR(index_meta.indexprs, index_meta.indrelid) AS index_expression,
               PG_GET_EXPR(index_meta.indpred, index_meta.indrelid) AS index_predicate
        FROM pg_index index_meta
        JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
        JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
        JOIN pg_am access_method ON access_method.oid = index_class.relam
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = current_schema()
      )
      SELECT required.table_name,
             required.index_name,
             required.should_be_unique,
             required.key_columns AS expected_key_columns,
             existing.access_method,
             existing.indisunique,
             existing.indisvalid,
             existing.indisready,
             existing.key_columns AS actual_key_columns,
             existing.index_definition,
             existing.index_expression,
             existing.index_predicate
      FROM required
      LEFT JOIN existing
        ON existing.table_name = required.table_name
       AND existing.index_name = required.index_name
      WHERE existing.index_name IS NULL
         OR existing.indisvalid IS NOT true
         OR existing.indisready IS NOT true
         OR existing.access_method IS DISTINCT FROM 'btree'
         OR existing.indisunique IS DISTINCT FROM required.should_be_unique
         OR existing.indnatts IS DISTINCT FROM existing.indnkeyatts
         OR (
           required.key_columns IS NOT NULL
           AND (
             existing.key_columns IS DISTINCT FROM required.key_columns
             OR existing.index_expression IS NOT NULL
             OR existing.index_predicate IS NOT NULL
           )
         )
         OR (
           required.index_name = 'technicians_staff_email_canonical_uidx'
           AND (
             existing.index_definition IS NULL
             OR existing.index_expression IS NULL
             OR existing.index_predicate IS NULL
             OR existing.indnkeyatts IS DISTINCT FROM 1
             OR POSITION('lower' IN LOWER(existing.index_expression)) = 0
             OR POSITION('btrim' IN LOWER(existing.index_expression)) = 0
             OR POSITION('email' IN LOWER(existing.index_expression)) = 0
             OR POSITION('role' IN LOWER(existing.index_predicate)) = 0
             OR POSITION('admin' IN LOWER(existing.index_predicate)) = 0
             OR POSITION('technician' IN LOWER(existing.index_predicate)) = 0
             OR POSITION('email is not null' IN LOWER(existing.index_predicate)) = 0
             OR POSITION('btrim' IN LOWER(existing.index_predicate)) = 0
             OR POSITION('<>' IN existing.index_predicate) = 0
           )
         )
      ORDER BY required.table_name, required.index_name
    `,
  },
  {
    key: 'staff_time_schema_column_shapes',
    description: 'Staff time-tracking type, length, precision, nullability, or default differs from the canonical schema',
    schema: true,
    sql: `
      WITH required(
        table_name,
        column_name,
        data_type,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        nullable,
        default_kind,
        default_value
      ) AS (
        VALUES
          ${AUDITED_COLUMN_SHAPE_VALUES}
      ), existing AS (
        SELECT columns.*,
               REGEXP_REPLACE(
                 REGEXP_REPLACE(
                   LOWER(columns.column_default),
                   '::(character varying|text|numeric|integer|timestamp with time zone)',
                   '',
                   'g'
                 ),
                 '[[:space:]()]',
                 '',
                 'g'
               ) AS normalized_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN (
            'time_entries',
            'time_entry_daily_summary',
            'time_weekly_summary'
          )
      )
      SELECT CONCAT(required.table_name, '.', required.column_name) AS column_name,
             required.data_type AS expected_data_type,
             existing.data_type AS actual_data_type,
             required.character_maximum_length AS expected_character_maximum_length,
             existing.character_maximum_length AS actual_character_maximum_length,
             required.numeric_precision AS expected_numeric_precision,
             existing.numeric_precision AS actual_numeric_precision,
             required.numeric_scale AS expected_numeric_scale,
             existing.numeric_scale AS actual_numeric_scale,
             required.nullable AS expected_nullable,
             existing.is_nullable = 'YES' AS actual_nullable,
             required.default_kind AS expected_default_kind,
             existing.column_default AS actual_default
      FROM required
      LEFT JOIN existing
        ON existing.table_name = required.table_name
       AND existing.column_name = required.column_name
      WHERE existing.column_name IS NULL
         OR existing.data_type IS DISTINCT FROM required.data_type
         OR (
           required.character_maximum_length IS NOT NULL
           AND existing.character_maximum_length
                 IS DISTINCT FROM required.character_maximum_length
         )
         OR (
           required.numeric_precision IS NOT NULL
           AND existing.numeric_precision IS DISTINCT FROM required.numeric_precision
         )
         OR (
           required.numeric_scale IS NOT NULL
           AND existing.numeric_scale IS DISTINCT FROM required.numeric_scale
         )
         OR (existing.is_nullable = 'YES') IS DISTINCT FROM required.nullable
         OR CASE required.default_kind
              WHEN 'none' THEN existing.column_default IS NOT NULL
              WHEN 'text' THEN existing.normalized_default
                                  IS DISTINCT FROM QUOTE_LITERAL(required.default_value)
              WHEN 'current_timestamp' THEN existing.normalized_default IS NULL
                OR existing.normalized_default NOT IN ('now', 'current_timestamp')
              WHEN 'zero' THEN NOT CASE
                WHEN REPLACE(existing.normalized_default, '''', '')
                       ~ '^[+-]{0,1}[0-9]+([.][0-9]+){0,1}$'
                  THEN REPLACE(existing.normalized_default, '''', '')::numeric = 0
                ELSE false
              END
              ELSE true
            END
      ORDER BY required.table_name, required.column_name
    `,
  },
  {
    key: 'staff_time_schema_id_generators',
    description: 'Staff time identifier type or canonical UUID/owned-sequence generator is missing',
    schema: true,
    sql: `
      WITH required(table_name, generator_kind) AS (
        VALUES
          ('time_entries', 'uuid'),
          ('time_entry_daily_summary', 'integer'),
          ('time_weekly_summary', 'integer')
      ), columns AS (
        SELECT required.*,
               info.data_type,
               info.is_identity,
               info.column_default,
               attrdef.oid AS attrdef_oid,
               TO_REGCLASS(PG_GET_SERIAL_SEQUENCE(
                 FORMAT('%I.%I', current_schema(), required.table_name),
                 'id'
               )) AS owned_sequence_oid
        FROM required
        LEFT JOIN information_schema.columns info
          ON info.table_schema = current_schema()
         AND info.table_name = required.table_name
         AND info.column_name = 'id'
        LEFT JOIN pg_class table_class
          ON table_class.relnamespace = TO_REGNAMESPACE(current_schema())
         AND table_class.relname = required.table_name
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = table_class.oid
         AND attribute.attname = 'id'
         AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef attrdef
          ON attrdef.adrelid = table_class.oid
         AND attrdef.adnum = attribute.attnum
      ), integer_maxima(table_name, max_id) AS (
        SELECT 'time_entry_daily_summary', MAX(id)::bigint
        FROM time_entry_daily_summary
        UNION ALL
        SELECT 'time_weekly_summary', MAX(id)::bigint
        FROM time_weekly_summary
      ), generator_shapes AS (
        SELECT columns.*,
               sequence_dependency.refobjid AS default_sequence_oid,
               maxima.max_id,
               sequence_catalog.start_value,
               sequence_catalog.increment_by,
               sequence_catalog.last_value,
               CASE WHEN sequence_catalog.last_value IS NULL
                 THEN sequence_catalog.start_value
                 ELSE sequence_catalog.last_value + sequence_catalog.increment_by
               END AS next_sequence_value,
               LOWER(REGEXP_REPLACE(
                 COALESCE(columns.column_default, ''),
                 '["[:space:]]',
                 '',
                 'g'
               )) AS normalized_default
        FROM columns
        LEFT JOIN pg_depend sequence_dependency
          ON sequence_dependency.classid = 'pg_attrdef'::regclass
         AND sequence_dependency.objid = columns.attrdef_oid
         AND sequence_dependency.refclassid = 'pg_class'::regclass
         AND sequence_dependency.deptype = 'n'
        LEFT JOIN pg_class sequence_class
          ON sequence_class.oid = sequence_dependency.refobjid
         AND sequence_class.relkind = 'S'
        LEFT JOIN pg_class owned_sequence
          ON owned_sequence.oid = columns.owned_sequence_oid
         AND owned_sequence.relkind = 'S'
        LEFT JOIN pg_namespace owned_namespace
          ON owned_namespace.oid = owned_sequence.relnamespace
        LEFT JOIN pg_sequences sequence_catalog
          ON sequence_catalog.schemaname = owned_namespace.nspname
         AND sequence_catalog.sequencename = owned_sequence.relname
        LEFT JOIN integer_maxima maxima ON maxima.table_name = columns.table_name
        WHERE sequence_class.oid IS NOT NULL
           OR sequence_dependency.refobjid IS NULL
      )
      SELECT table_name, generator_kind, data_type, is_identity,
             column_default, owned_sequence_oid, default_sequence_oid,
             max_id, increment_by, next_sequence_value
      FROM generator_shapes
      WHERE data_type IS NULL
         OR (
           generator_kind = 'uuid'
           AND (
             data_type <> 'uuid'
             OR normalized_default !~
               '^([a-z_][a-z0-9_]*[.]){0,1}gen_random_uuid[(][)](::uuid){0,1}$'
           )
         )
         OR (
           generator_kind = 'integer'
           AND (
             data_type NOT IN ('smallint', 'integer', 'bigint')
             OR owned_sequence_oid IS NULL
             OR NOT (
               is_identity = 'YES'
               OR (
                 default_sequence_oid = owned_sequence_oid
                 AND normalized_default ~ '^nextval[(].*::regclass[)]$'
               )
             )
             OR increment_by IS DISTINCT FROM 1
             OR (
               max_id IS NOT NULL
               AND next_sequence_value <= max_id
             )
           )
         )
      ORDER BY table_name
    `,
  },
  {
    key: 'staff_time_schema_indexes',
    description: 'Required Staff time-tracking primary, unique, or lookup index is missing',
    schema: true,
    sql: `
      WITH index_shapes AS (
        SELECT t.relname AS table_name,
               i.indisunique,
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
          AND t.relname IN (
            'time_entries',
            'time_entry_daily_summary',
            'time_weekly_summary'
          )
      ),
      required(invariant, table_name, key_columns, unique_required, primary_required) AS (
        VALUES
          ('time_entries primary key', 'time_entries', ARRAY['id']::text[], true, true),
          ('time entries by technician', 'time_entries', ARRAY['technician_id']::text[], false, false),
          ('time entries by technician/time', 'time_entries', ARRAY['technician_id', 'clock_in']::text[], false, false),
          ('time entries by job', 'time_entries', ARRAY['job_id']::text[], false, false),
          ('time entries by status', 'time_entries', ARRAY['status']::text[], false, false),
          ('time entries by type', 'time_entries', ARRAY['entry_type']::text[], false, false),
          ('time entries by clock-in', 'time_entries', ARRAY['clock_in']::text[], false, false),
          ('daily summary primary key', 'time_entry_daily_summary', ARRAY['id']::text[], true, true),
          ('daily summary technician/date uniqueness', 'time_entry_daily_summary', ARRAY['technician_id', 'work_date']::text[], true, false),
          ('weekly summary primary key', 'time_weekly_summary', ARRAY['id']::text[], true, true),
          ('weekly summary technician/week uniqueness', 'time_weekly_summary', ARRAY['technician_id', 'week_start']::text[], true, false)
      )
      SELECT required.invariant, required.table_name, required.key_columns
      FROM required
      WHERE NOT EXISTS (
        SELECT 1
        FROM index_shapes existing
        WHERE existing.table_name = required.table_name
          AND existing.indisvalid
          AND existing.indisready
          AND existing.unfiltered
          AND existing.plain_columns
          AND existing.access_method = 'btree'
          AND existing.key_columns = required.key_columns
          AND (required.unique_required = false OR existing.indisunique)
          AND (required.primary_required = false OR existing.indisprimary)
      )
      ORDER BY required.table_name, required.invariant
    `,
  },
  {
    key: 'staff_time_schema_value_constraints',
    description: 'Staff time entry nullability or check-constraint semantics differ from the rollout contract',
    schema: true,
    sql: `
      WITH required_not_null(invariant, column_name) AS (
        VALUES
          ('time entry type is required', 'entry_type'),
          ('time entry status is required', 'status')
      ),
      missing_not_null AS (
        SELECT required.invariant
        FROM required_not_null required
        LEFT JOIN information_schema.columns existing
          ON existing.table_schema = current_schema()
         AND existing.table_name = 'time_entries'
         AND existing.column_name = required.column_name
         AND existing.is_nullable = 'NO'
        WHERE existing.column_name IS NULL
      ),
      required_checks(invariant, constraint_names, normalized_definition) AS (
        VALUES
          (
            'time entry type allowed values',
            ARRAY['time_entries_entry_type_check', 'time_entries_staff_entry_type_check']::text[],
            ${sqlStringLiteral(EXPECTED_CHECK_DEFINITIONS.entryType)}
          ),
          (
            'time entry status allowed values',
            ARRAY['time_entries_status_check', 'time_entries_staff_status_check']::text[],
            ${sqlStringLiteral(EXPECTED_CHECK_DEFINITIONS.status)}
          ),
          (
            'active timer writer generation fence',
            ARRAY['time_entries_staff_active_write_generation_check']::text[],
            ${sqlStringLiteral(EXPECTED_CHECK_DEFINITIONS.activeWriter)}
          )
      ),
      constraint_shapes AS (
        SELECT c.conname,
               c.convalidated,
               c.connoinherit,
               REGEXP_REPLACE(
                 REPLACE(
                   REGEXP_REPLACE(
                     REGEXP_REPLACE(
                       LOWER(pg_get_constraintdef(c.oid, true)),
                       '::(character varying|text|bpchar|smallint|integer|bigint)(\\[\\]){0,1}',
                       '',
                       'g'
                     ),
                     '["[:space:]()]',
                     '',
                     'g'
                   ),
                   'check',
                   ''
                 ),
                 'not([a-z_][a-z0-9_.]*)isdistinctfrom',
                 '\\1isnotdistinctfrom',
                 'g'
               ) AS normalized_definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'time_entries'
          AND c.contype = 'c'
      ),
      missing_checks AS (
        SELECT required.invariant
        FROM required_checks required
        WHERE NOT EXISTS (
          SELECT 1
          FROM constraint_shapes existing
          WHERE existing.conname = ANY(required.constraint_names)
            AND existing.convalidated
            AND NOT existing.connoinherit
            AND existing.normalized_definition = required.normalized_definition
        )
      ),
      misdefined_owned_checks AS (
        SELECT CONCAT(required.invariant, ': ', existing.conname) AS invariant
        FROM required_checks required
        JOIN constraint_shapes existing
          ON existing.conname = ANY(required.constraint_names)
        WHERE NOT (
          existing.convalidated
          AND NOT existing.connoinherit
          AND existing.normalized_definition = required.normalized_definition
        )
      )
      SELECT invariant FROM missing_not_null
      UNION ALL
      SELECT invariant FROM missing_checks
      UNION ALL
      SELECT invariant FROM misdefined_owned_checks
      ORDER BY invariant
    `,
  },
  {
    key: 'active_staff_timers',
    description: 'A Staff time entry is still active; deploy only after every timer is closed',
    sql: `
      SELECT id AS entry_id, technician_id, entry_type, clock_in
      FROM time_entries
      WHERE status = 'active'
      ORDER BY clock_in, id
    `,
  },
  {
    key: 'duplicate_active_timers',
    description: 'More than one active shift/job/break for a technician and type',
    sql: `
      SELECT technician_id, entry_type, COUNT(*)::integer AS active_count,
             (ARRAY_AGG(id ORDER BY clock_in))[1:25] AS entry_ids
      FROM time_entries
      WHERE status = 'active'
        AND entry_type IN ('shift', 'job', 'break')
      GROUP BY technician_id, entry_type
      HAVING COUNT(*) > 1
      ORDER BY technician_id, entry_type
    `,
  },
  {
    key: 'active_subtimer_without_shift',
    description: 'Active job/break timer without an active shift',
    sql: `
      SELECT child.technician_id, child.id AS entry_id, child.entry_type,
             child.clock_in
      FROM time_entries child
      WHERE child.status = 'active'
        AND child.entry_type IN ('job', 'break')
        AND NOT EXISTS (
          SELECT 1
          FROM time_entries shift
          WHERE shift.technician_id = child.technician_id
            AND shift.entry_type = 'shift'
            AND shift.status = 'active'
        )
      ORDER BY child.clock_in, child.id
    `,
  },
  {
    key: 'malformed_completed_entries',
    description: 'Completed/edited entry has missing, negative, or inconsistent duration',
    sql: `
      SELECT id AS entry_id, technician_id, entry_type, status, clock_in,
             clock_out, duration_minutes,
             ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in)) / 60)::numeric, 2)
               AS interval_minutes
      FROM time_entries
      WHERE status IN ('completed', 'edited')
        AND (
          clock_out IS NULL
          OR duration_minutes IS NULL
          OR duration_minutes <= 0
          OR clock_out <= clock_in
          OR ABS(
            duration_minutes
            - (EXTRACT(EPOCH FROM (clock_out - clock_in)) / 60)
          ) > 0.02
        )
      ORDER BY clock_in, id
    `,
  },
  {
    key: 'completed_child_without_containing_shift',
    description: 'Completed child time is not contained by a completed shift in the same ET payroll week',
    sql: `
      SELECT child.id AS entry_id, child.technician_id, child.entry_type,
             child.clock_in, child.clock_out
      FROM time_entries child
      WHERE child.status IN ('completed', 'edited')
        AND child.entry_type IN ('job', 'break', 'drive', 'admin_time')
        AND NOT EXISTS (
          SELECT 1
          FROM time_entries shift
          WHERE shift.technician_id = child.technician_id
            AND shift.entry_type = 'shift'
            AND shift.status IN ('completed', 'edited')
            AND child.clock_in >= shift.clock_in
            AND child.clock_out <= shift.clock_out
            AND DATE_TRUNC(
              'week',
              child.clock_in::timestamptz AT TIME ZONE 'America/New_York'
            )::date = DATE_TRUNC(
              'week',
              shift.clock_in::timestamptz AT TIME ZONE 'America/New_York'
            )::date
        )
      ORDER BY child.clock_in, child.id
    `,
  },
  {
    key: 'overlapping_same_type_entries',
    description: 'Historical non-void shift/job/break entries overlap for one technician',
    sql: `
      WITH ordered AS (
        SELECT technician_id, entry_type, id AS entry_id, clock_in, clock_out,
               MAX(clock_out) OVER (
                 PARTITION BY technician_id, entry_type
                 ORDER BY clock_in, id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ) AS prior_max_clock_out
        FROM time_entries
        WHERE entry_type IN ('shift', 'job', 'break')
          AND status <> 'voided'
          AND clock_out IS NOT NULL
      )
      SELECT technician_id, entry_type, entry_id, clock_in, clock_out,
             prior_max_clock_out
      FROM ordered
      WHERE clock_in < prior_max_clock_out
      ORDER BY technician_id, entry_type, clock_in, entry_id
    `,
  },
  {
    key: 'missing_daily_summaries',
    description: 'A worked ET date has time entries but no daily summary row',
    sql: `
      WITH worked_dates AS (
        SELECT DISTINCT technician_id,
          (clock_in::timestamptz AT TIME ZONE 'America/New_York')::date AS work_date
        FROM time_entries
        WHERE status IN ('completed', 'edited')
      )
      SELECT w.technician_id, w.work_date
      FROM worked_dates w
      LEFT JOIN time_entry_daily_summary d
        ON d.technician_id = w.technician_id
       AND d.work_date = w.work_date
      WHERE d.id IS NULL
      ORDER BY w.work_date, w.technician_id
    `,
  },
  {
    key: 'daily_summary_total_mismatch',
    description: 'Daily summary totals or timestamps differ from entries grouped by ET work date',
    sql: `
      WITH entry_raw AS (
        SELECT technician_id,
          (clock_in::timestamptz AT TIME ZONE 'America/New_York')::date AS work_date,
          COALESCE(SUM(duration_minutes) FILTER (
            WHERE entry_type = 'shift'
          ), 0) AS shift_minutes,
          COALESCE(SUM(duration_minutes) FILTER (
            WHERE entry_type = 'job'
          ), 0) AS job_minutes,
          COALESCE(SUM(duration_minutes) FILTER (
            WHERE entry_type = 'drive'
          ), 0) AS drive_minutes,
          COALESCE(SUM(duration_minutes) FILTER (
            WHERE entry_type = 'break'
          ), 0) AS break_minutes,
          COALESCE(SUM(duration_minutes) FILTER (
            WHERE entry_type = 'admin_time'
          ), 0) AS admin_minutes,
          COUNT(*) FILTER (
            WHERE entry_type = 'job'
          )::integer AS job_count,
          MIN(clock_in::timestamptz) FILTER (
            WHERE entry_type = 'shift'
          ) AS first_clock_in,
          MAX(clock_out::timestamptz) FILTER (
            WHERE entry_type = 'shift'
          ) AS last_clock_out
        FROM time_entries
        WHERE status IN ('completed', 'edited')
        GROUP BY technician_id, work_date
      ), job_revenue AS (
        SELECT jobs.technician_id, jobs.work_date,
               COALESCE(SUM(services.estimated_price), 0)::numeric AS revenue_generated
        FROM (
          SELECT DISTINCT technician_id,
            (clock_in::timestamptz AT TIME ZONE 'America/New_York')::date AS work_date,
            job_id
          FROM time_entries
          WHERE status IN ('completed', 'edited')
            AND entry_type = 'job'
            AND job_id IS NOT NULL
        ) jobs
        LEFT JOIN scheduled_services services ON services.id = jobs.job_id
        GROUP BY jobs.technician_id, jobs.work_date
      ), entry_totals AS (
        SELECT raw.technician_id, raw.work_date,
               ROUND(raw.shift_minutes, 2) AS shift_minutes,
               ROUND(raw.job_minutes, 2) AS job_minutes,
               ROUND(raw.drive_minutes, 2) AS drive_minutes,
               ROUND(raw.break_minutes, 2) AS break_minutes,
               ROUND(raw.admin_minutes, 2) AS admin_minutes,
               raw.job_count, raw.first_clock_in, raw.last_clock_out,
               CASE WHEN raw.shift_minutes > 0
                 THEN ROUND((raw.job_minutes / raw.shift_minutes) * 100, 2)
                 ELSE 0::numeric
               END AS utilization_pct,
               ROUND(COALESCE(revenue.revenue_generated, 0), 2) AS revenue_generated,
               CASE WHEN raw.shift_minutes > 0
                 THEN ROUND(
                   COALESCE(revenue.revenue_generated, 0) / (raw.shift_minutes / 60),
                   2
                 )
                 ELSE 0::numeric
               END AS rpmh_actual
        FROM entry_raw raw
        LEFT JOIN job_revenue revenue
          ON revenue.technician_id = raw.technician_id
         AND revenue.work_date = raw.work_date
      ), daily_running AS (
        SELECT summary.*, to_jsonb(summary) AS day_json,
               DATE_TRUNC('week', summary.work_date::timestamp)::date AS week_start,
               COALESCE(
                 SUM(COALESCE(summary.total_shift_minutes, 0)) OVER (
                   PARTITION BY summary.technician_id,
                     DATE_TRUNC('week', summary.work_date::timestamp)::date
                   ORDER BY summary.work_date, summary.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                 ),
                 0::numeric
               ) AS prior_week_shift_minutes
        FROM time_entry_daily_summary summary
      ), daily AS (
        SELECT daily_running.*,
               ROUND(
                 GREATEST(
                   0::numeric,
                   LEAST(
                     COALESCE(total_shift_minutes, 0),
                     prior_week_shift_minutes
                       + COALESCE(total_shift_minutes, 0)
                       - ${WEEKLY_OVERTIME_THRESHOLD_MINUTES}
                   )
                 ),
                 2
               ) AS expected_overtime_minutes
        FROM daily_running
      )
      SELECT d.id AS daily_summary_id, d.technician_id, d.work_date,
             d.total_shift_minutes, e.shift_minutes AS entry_shift_minutes,
             d.total_job_minutes, e.job_minutes AS entry_job_minutes,
             d.total_drive_minutes, e.drive_minutes AS entry_drive_minutes,
             d.total_break_minutes, e.break_minutes AS entry_break_minutes,
             NULLIF(d.day_json ->> 'total_admin_minutes', '')::numeric AS total_admin_minutes,
             e.admin_minutes AS entry_admin_minutes,
             d.job_count, e.job_count AS entry_job_count,
             NULLIF(d.day_json ->> 'first_clock_in', '')::timestamptz AS first_clock_in,
             e.first_clock_in AS entry_first_clock_in,
             NULLIF(d.day_json ->> 'last_clock_out', '')::timestamptz AS last_clock_out,
             e.last_clock_out AS entry_last_clock_out,
             d.utilization_pct, e.utilization_pct AS entry_utilization_pct,
             d.revenue_generated, e.revenue_generated AS entry_revenue_generated,
             d.rpmh_actual, e.rpmh_actual AS entry_rpmh_actual,
             d.overtime_minutes,
             d.expected_overtime_minutes
      FROM daily d
      LEFT JOIN entry_totals e
        ON d.technician_id = e.technician_id
       AND d.work_date = e.work_date
      WHERE d.total_shift_minutes
              IS DISTINCT FROM COALESCE(e.shift_minutes, 0::numeric)
         OR d.total_job_minutes
              IS DISTINCT FROM COALESCE(e.job_minutes, 0::numeric)
         OR d.total_drive_minutes
              IS DISTINCT FROM COALESCE(e.drive_minutes, 0::numeric)
         OR d.total_break_minutes
              IS DISTINCT FROM COALESCE(e.break_minutes, 0::numeric)
         OR NULLIF(d.day_json ->> 'total_admin_minutes', '')::numeric
              IS DISTINCT FROM COALESCE(e.admin_minutes, 0::numeric)
         OR d.job_count IS DISTINCT FROM COALESCE(e.job_count, 0)
         OR NULLIF(d.day_json ->> 'first_clock_in', '')::timestamptz
              IS DISTINCT FROM e.first_clock_in
         OR NULLIF(d.day_json ->> 'last_clock_out', '')::timestamptz
              IS DISTINCT FROM e.last_clock_out
         OR d.utilization_pct
              IS DISTINCT FROM COALESCE(e.utilization_pct, 0::numeric)
         OR d.revenue_generated
              IS DISTINCT FROM COALESCE(e.revenue_generated, 0::numeric)
         OR d.rpmh_actual
              IS DISTINCT FROM COALESCE(e.rpmh_actual, 0::numeric)
         OR d.overtime_minutes
              IS DISTINCT FROM d.expected_overtime_minutes
      ORDER BY d.work_date, d.technician_id, d.id
    `,
  },
  {
    key: 'weekly_overtime_payroll_mismatch',
    description: 'Weekly payroll summary is missing, orphaned, stale, or inconsistent with its ET-dated daily summaries',
    sql: `
      WITH weekly_allocations AS (
        SELECT technician_id, week_start,
               (week_start + INTERVAL '6 days')::date AS expected_week_end,
               ROUND(SUM(COALESCE(total_shift_minutes, 0)), 2) AS expected_shift_minutes,
               ROUND(SUM(COALESCE(total_job_minutes, 0)), 2) AS expected_job_minutes,
               ROUND(SUM(COALESCE(total_drive_minutes, 0)), 2) AS expected_drive_minutes,
               ROUND(SUM(COALESCE(overtime_minutes, 0)), 2) AS stored_daily_overtime_minutes,
               LEAST(
                 ROUND(SUM(COALESCE(total_shift_minutes, 0)), 2),
                 ${WEEKLY_OVERTIME_THRESHOLD_MINUTES}
               ) AS expected_regular_minutes,
               GREATEST(
                 ROUND(SUM(COALESCE(total_shift_minutes, 0)), 2)
                   - ${WEEKLY_OVERTIME_THRESHOLD_MINUTES},
                 0::numeric
               ) AS expected_overtime_minutes,
               COUNT(*) FILTER (
                 WHERE COALESCE(total_shift_minutes, 0) > 0
               )::integer AS expected_days_worked,
               SUM(COALESCE(job_count, 0))::integer AS expected_job_count,
               ROUND(SUM(COALESCE(revenue_generated, 0)), 2) AS expected_revenue,
               CASE WHEN SUM(COALESCE(total_shift_minutes, 0)) > 0
                 THEN ROUND(
                   SUM(COALESCE(revenue_generated, 0))
                     / (SUM(COALESCE(total_shift_minutes, 0)) / 60),
                   2
                 )
                 ELSE 0::numeric
               END AS expected_avg_rpmh,
               CASE WHEN SUM(COALESCE(total_shift_minutes, 0)) > 0
                 THEN ROUND(
                   (SUM(COALESCE(total_job_minutes, 0))
                     / SUM(COALESCE(total_shift_minutes, 0))) * 100,
                   2
                 )
                 ELSE 0::numeric
               END AS expected_utilization_pct
        FROM (
          SELECT summary.*,
                 DATE_TRUNC('week', summary.work_date::timestamp)::date AS week_start
          FROM time_entry_daily_summary summary
        ) daily
        GROUP BY technician_id, week_start
      )
      SELECT w.id AS weekly_summary_id, w.technician_id, w.week_start, w.status,
             a.technician_id AS daily_technician_id,
             a.week_start AS daily_week_start,
             w.week_end, a.expected_week_end,
             w.total_shift_minutes, a.expected_shift_minutes,
             w.total_job_minutes, a.expected_job_minutes,
             w.total_drive_minutes, a.expected_drive_minutes,
             w.regular_minutes, a.expected_regular_minutes,
             w.overtime_minutes AS weekly_overtime_minutes,
             COALESCE(a.stored_daily_overtime_minutes, 0) AS stored_daily_overtime_minutes,
             COALESCE(a.expected_overtime_minutes, 0) AS expected_overtime_minutes,
             w.days_worked, a.expected_days_worked,
             w.job_count, a.expected_job_count,
             w.total_revenue, a.expected_revenue,
             w.avg_rpmh, a.expected_avg_rpmh,
             w.utilization_pct, a.expected_utilization_pct
      FROM time_weekly_summary w
      FULL OUTER JOIN weekly_allocations a
        ON a.technician_id = w.technician_id
       AND a.week_start = w.week_start
      WHERE w.id IS NULL
         OR a.technician_id IS NULL
         OR w.week_start IS DISTINCT FROM
              DATE_TRUNC('week', w.week_start::timestamp)::date
         OR w.week_end IS DISTINCT FROM a.expected_week_end
         OR COALESCE(w.total_shift_minutes, 0::numeric)
              IS DISTINCT FROM a.expected_shift_minutes
         OR COALESCE(w.total_job_minutes, 0::numeric)
              IS DISTINCT FROM a.expected_job_minutes
         OR COALESCE(w.total_drive_minutes, 0::numeric)
              IS DISTINCT FROM a.expected_drive_minutes
         OR COALESCE(w.regular_minutes, 0::numeric)
              IS DISTINCT FROM a.expected_regular_minutes
         OR w.overtime_minutes
              IS DISTINCT FROM COALESCE(a.expected_overtime_minutes, 0::numeric)
         OR COALESCE(a.stored_daily_overtime_minutes, 0::numeric)
              IS DISTINCT FROM COALESCE(a.expected_overtime_minutes, 0::numeric)
         OR w.days_worked IS DISTINCT FROM a.expected_days_worked
         OR w.job_count IS DISTINCT FROM a.expected_job_count
         OR COALESCE(w.total_revenue, 0::numeric)
              IS DISTINCT FROM a.expected_revenue
         OR COALESCE(w.avg_rpmh, 0::numeric)
              IS DISTINCT FROM a.expected_avg_rpmh
         OR COALESCE(w.utilization_pct, 0::numeric)
              IS DISTINCT FROM a.expected_utilization_pct
      ORDER BY COALESCE(w.week_start, a.week_start),
               COALESCE(w.technician_id, a.technician_id), w.id
    `,
  },
  {
    key: 'duplicate_daily_summary_ids',
    description: 'Daily summary identifier is null or duplicated',
    sql: `
      SELECT id AS daily_summary_id, COUNT(*)::integer AS row_count
      FROM time_entry_daily_summary
      GROUP BY id
      HAVING id IS NULL OR COUNT(*) > 1
      ORDER BY id NULLS FIRST
    `,
  },
  {
    key: 'duplicate_daily_summaries',
    description: 'More than one daily summary exists for a technician and ET work date',
    sql: `
      SELECT technician_id, work_date, COUNT(*)::integer AS row_count,
             (ARRAY_AGG(id ORDER BY id))[1:25] AS daily_summary_ids
      FROM time_entry_daily_summary
      GROUP BY technician_id, work_date
      HAVING COUNT(*) > 1
      ORDER BY work_date, technician_id
    `,
  },
  {
    key: 'unresolvable_timesheet_review_states',
    description: 'A retired daily/weekly review state has no safe transition in the canonical weekly workflow',
    sql: `
      SELECT 'daily'::text AS summary_scope,
             d.id::text AS summary_id,
             d.technician_id,
             d.work_date AS period_start,
             d.status,
             CASE
               WHEN d.status = 'disputed' THEN 'disputed_day_without_disputed_entry'
               ELSE 'retired_daily_status'
             END AS reason
      FROM time_entry_daily_summary d
      WHERE d.status IS NULL
         OR d.status NOT IN ('pending', 'approved', 'disputed')
         OR (
           d.status = 'disputed'
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT entry.*, to_jsonb(entry) AS entry_json
               FROM time_entries entry
             ) e
             WHERE e.technician_id = d.technician_id
               AND e.status <> 'voided'
               AND (e.clock_in::timestamptz AT TIME ZONE 'America/New_York')::date = d.work_date
               AND COALESCE(e.entry_json ->> 'approval_status', 'pending') = 'disputed'
           )
         )
      UNION ALL
      SELECT 'weekly'::text AS summary_scope,
             w.id::text AS summary_id,
             w.technician_id,
             w.week_start AS period_start,
             w.status,
             'retired_weekly_status'::text AS reason
      FROM time_weekly_summary w
      WHERE w.status IS NULL
         OR w.status NOT IN ('pending', 'approved')
      ORDER BY period_start, technician_id, summary_scope, summary_id
    `,
  },
  {
    key: 'approved_incomplete_staff_weeks',
    description: 'An approved payroll snapshot covers the current or a future ET week that can still receive time',
    sql: `
      SELECT w.id AS weekly_summary_id,
             w.technician_id,
             w.week_start,
             COALESCE(
               NULLIF(to_jsonb(w) ->> 'week_end', '')::date,
               (w.week_start + INTERVAL '6 days')::date
             ) AS week_end,
             (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date AS current_et_date
      FROM time_weekly_summary w
      WHERE w.status = 'approved'
        AND COALESCE(
          NULLIF(to_jsonb(w) ->> 'week_end', '')::date,
          (w.week_start + INTERVAL '6 days')::date
        ) >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
      ORDER BY w.week_start, w.technician_id, w.id
    `,
  },
  {
    key: 'orphan_approved_daily_summaries',
    description: 'Daily summary is approved without an approved canonical weekly summary',
    sql: `
      SELECT d.id AS daily_summary_id, d.technician_id, d.work_date,
             w.id AS weekly_summary_id, w.status AS weekly_status
      FROM time_entry_daily_summary d
      LEFT JOIN time_weekly_summary w
        ON w.technician_id = d.technician_id
       AND d.work_date >= w.week_start
       AND d.work_date < (w.week_start + INTERVAL '7 days')
      WHERE d.status = 'approved'
        AND COALESCE(w.status, '') <> 'approved'
      ORDER BY d.work_date, d.technician_id
    `,
  },
  {
    key: 'approved_week_nonapproved_daily_summaries',
    description: 'Approved weekly summary contains a daily summary not marked approved',
    sql: `
      SELECT w.id AS weekly_summary_id, w.technician_id, w.week_start,
             d.id AS daily_summary_id, d.work_date, d.status AS daily_status
      FROM time_weekly_summary w
      JOIN time_entry_daily_summary d
        ON d.technician_id = w.technician_id
       AND d.work_date >= w.week_start
       AND d.work_date < (w.week_start + INTERVAL '7 days')
      WHERE w.status = 'approved'
        AND d.status IS DISTINCT FROM 'approved'
      ORDER BY w.week_start, w.technician_id, d.work_date, d.id
    `,
  },
  {
    key: 'approved_week_pending_entries',
    description: 'Approved weekly summary contains a non-approved non-void entry',
    sql: `
      SELECT w.technician_id, w.week_start, e.id AS entry_id,
             e.entry_type, e.approval_status
      FROM time_weekly_summary w
      JOIN time_entries e
        ON e.technician_id = w.technician_id
       AND DATE_TRUNC(
         'week',
         e.clock_in::timestamptz AT TIME ZONE 'America/New_York'
       )::date = w.week_start
      WHERE w.status = 'approved'
        AND e.status <> 'voided'
        AND (
          e.status NOT IN ('completed', 'edited')
          OR COALESCE(e.approval_status, 'pending') <> 'approved'
        )
      ORDER BY w.week_start, w.technician_id, e.clock_in
    `,
  },
  {
    key: 'approved_week_total_mismatch',
    description: 'Approved weekly snapshot totals differ from its approved entries',
    sql: `
      WITH entry_totals AS (
        SELECT technician_id,
          DATE_TRUNC(
            'week',
            clock_in::timestamptz AT TIME ZONE 'America/New_York'
          )::date AS week_start,
          SUM(duration_minutes) FILTER (WHERE entry_type = 'shift') AS shift_minutes,
          SUM(duration_minutes) FILTER (WHERE entry_type = 'job') AS job_minutes,
          SUM(duration_minutes) FILTER (WHERE entry_type = 'drive') AS drive_minutes,
          COUNT(*) FILTER (WHERE entry_type = 'job')::integer AS job_count,
          COUNT(DISTINCT (
            clock_in::timestamptz AT TIME ZONE 'America/New_York'
          )::date) FILTER (WHERE entry_type = 'shift')::integer AS days_worked
        FROM time_entries
        WHERE status <> 'voided'
          AND approval_status = 'approved'
        GROUP BY technician_id, week_start
      )
      SELECT w.technician_id, w.week_start,
             w.total_shift_minutes, COALESCE(e.shift_minutes, 0) AS entry_shift_minutes,
             NULLIF(w.week_json ->> 'total_job_minutes', '')::numeric AS total_job_minutes,
             COALESCE(e.job_minutes, 0) AS entry_job_minutes,
             NULLIF(w.week_json ->> 'total_drive_minutes', '')::numeric AS total_drive_minutes,
             COALESCE(e.drive_minutes, 0) AS entry_drive_minutes,
             w.regular_minutes,
             LEAST(COALESCE(e.shift_minutes, 0), 2400) AS entry_regular_minutes,
             w.overtime_minutes,
             GREATEST(COALESCE(e.shift_minutes, 0) - 2400, 0) AS entry_overtime_minutes,
             w.job_count, COALESCE(e.job_count, 0) AS entry_job_count,
             w.days_worked, COALESCE(e.days_worked, 0) AS entry_days_worked
      FROM (
        SELECT summary.*, to_jsonb(summary) AS week_json
        FROM time_weekly_summary summary
      ) w
      LEFT JOIN entry_totals e
        ON e.technician_id = w.technician_id
       AND e.week_start = w.week_start
      WHERE w.status = 'approved'
        AND (
          COALESCE(w.total_shift_minutes, 0::numeric)
            IS DISTINCT FROM COALESCE(e.shift_minutes, 0::numeric)
          OR (
            jsonb_exists(w.week_json, 'total_job_minutes')
            AND COALESCE(
              NULLIF(w.week_json ->> 'total_job_minutes', '')::numeric,
              0::numeric
            ) IS DISTINCT FROM COALESCE(e.job_minutes, 0::numeric)
          )
          OR (
            jsonb_exists(w.week_json, 'total_drive_minutes')
            AND COALESCE(
              NULLIF(w.week_json ->> 'total_drive_minutes', '')::numeric,
              0::numeric
            ) IS DISTINCT FROM COALESCE(e.drive_minutes, 0::numeric)
          )
          OR COALESCE(w.regular_minutes, 0::numeric) IS DISTINCT FROM
            LEAST(COALESCE(e.shift_minutes, 0::numeric), 2400::numeric)
          OR COALESCE(w.overtime_minutes, 0::numeric) IS DISTINCT FROM
            GREATEST(COALESCE(e.shift_minutes, 0::numeric) - 2400::numeric, 0::numeric)
          OR COALESCE(w.job_count, 0) <> COALESCE(e.job_count, 0)
          OR COALESCE(w.days_worked, 0) <> COALESCE(e.days_worked, 0)
        )
      ORDER BY w.week_start, w.technician_id
    `,
  },
  {
    key: 'invalid_staff_auth_versions',
    description: 'Staff account has an invalid credential version and cannot enforce session revocation',
    sql: `
      SELECT id AS technician_id, role, auth_token_version
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND (
          auth_token_version IS NULL
          OR auth_token_version < 1
        )
      ORDER BY id
    `,
  },
  {
    key: 'inconsistent_staff_password_reset_state',
    description: 'Staff password-reset state is partial or contains an invalid token hash/expiry',
    sql: `
      SELECT id AS technician_id,
             password_reset_expires_at,
             password_reset_requested_at,
             CASE
               WHEN password_reset_token_hash IS NOT NULL
                    AND password_reset_token_hash !~ '^[a-f0-9]{64}$'
                 THEN 'invalid_token_hash'
               WHEN password_reset_token_hash IS NULL
                    AND (
                      password_reset_expires_at IS NOT NULL
                      OR password_reset_requested_at IS NOT NULL
                    )
                 THEN 'partial_reset_state'
               WHEN password_reset_token_hash IS NOT NULL
                    AND (
                      password_reset_expires_at IS NULL
                      OR password_reset_requested_at IS NULL
                    )
                 THEN 'partial_reset_state'
               WHEN password_reset_expires_at <= password_reset_requested_at
                 THEN 'invalid_reset_window'
               WHEN password_reset_expires_at
                    > password_reset_requested_at
                      + INTERVAL '${Number(RESET_LINK_TTL_MINUTES)} minutes'
                 THEN 'reset_window_too_long'
               WHEN password_reset_requested_at
                    > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
                 THEN 'reset_requested_in_future'
               ELSE 'invalid_reset_state'
             END AS reason
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND (
          (
            password_reset_token_hash IS NOT NULL
            AND password_reset_token_hash !~ '^[a-f0-9]{64}$'
          )
          OR (
            password_reset_token_hash IS NULL
            AND (
              password_reset_expires_at IS NOT NULL
              OR password_reset_requested_at IS NOT NULL
            )
          )
          OR (
            password_reset_token_hash IS NOT NULL
            AND (
              password_reset_expires_at IS NULL
              OR password_reset_requested_at IS NULL
            )
          )
          OR password_reset_expires_at <= password_reset_requested_at
          OR password_reset_expires_at
               > password_reset_requested_at
                 + INTERVAL '${Number(RESET_LINK_TTL_MINUTES)} minutes'
          OR password_reset_requested_at
               > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
        )
      ORDER BY id
    `,
  },
  {
    key: 'invalid_forced_password_change_state',
    description: 'Staff account requires a password change but has no credential to replace',
    sql: `
      SELECT id AS technician_id, role
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND active = true
        AND must_change_password = true
        AND (password_hash IS NULL OR BTRIM(password_hash) = '')
      ORDER BY id
    `,
  },
  {
    key: 'missing_active_admin',
    description: 'No active admin exists to recover Staff access or reach admin-only controls',
    sql: `
      SELECT 'missing_active_admin' AS invariant
      WHERE NOT EXISTS (
        SELECT 1
        FROM technicians
        WHERE role = 'admin'
          AND active = true
      )
    `,
  },
  {
    key: 'invalid_active_staff_identity',
    description: 'Active staff account cannot authenticate or request a reset with its stored email',
    sql: `
      SELECT id AS technician_id, role,
             CASE
               WHEN email IS NULL OR BTRIM(email) = '' THEN 'missing_email'
               WHEN LENGTH(BTRIM(email)) > ${Number(MAX_STAFF_EMAIL_LENGTH)} THEN 'email_too_long'
               WHEN email IS DISTINCT FROM LOWER(BTRIM(email)) THEN 'noncanonical_email'
               ELSE 'invalid_email_format'
             END AS reason
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND active = true
        AND (
          email IS NULL
          OR BTRIM(email) = ''
          OR LENGTH(BTRIM(email)) > ${Number(MAX_STAFF_EMAIL_LENGTH)}
          OR email IS DISTINCT FROM LOWER(BTRIM(email))
          OR BTRIM(email) !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
        )
      ORDER BY id
    `,
  },
  {
    key: 'duplicate_staff_emails',
    description: 'Staff authentication email is duplicated after trim/lower canonicalization',
    sql: `
      SELECT COUNT(*)::integer AS account_count,
             (ARRAY_AGG(id ORDER BY id))[1:25] AS technician_ids
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND email IS NOT NULL
        AND BTRIM(email) <> ''
      GROUP BY LOWER(BTRIM(email))
      HAVING COUNT(*) > 1
      ORDER BY MIN(id::text)
    `,
  },
  {
    key: 'stale_staff_push_session_versions',
    description: 'Active Staff push subscription is not bound to the account current credential version',
    sql: `
      SELECT p.admin_user_id AS technician_id,
             p.id AS subscription_id,
             p.staff_token_version,
             t.auth_token_version
      FROM push_subscriptions p
      LEFT JOIN technicians t ON t.id = p.admin_user_id
      WHERE p.active = true
        AND p.admin_user_id IS NOT NULL
        AND (
          t.id IS NULL
          OR t.active IS NOT true
          OR t.role NOT IN ('admin', 'technician')
          OR p.staff_token_version IS DISTINCT FROM t.auth_token_version
        )
      ORDER BY p.admin_user_id, p.id
    `,
  },
  {
    key: 'inactive_staff_push_subscriptions',
    description: 'Inactive staff account still has an active push subscription',
    sql: `
      SELECT p.admin_user_id AS technician_id,
             (ARRAY_AGG(p.id ORDER BY p.id))[1:25] AS subscription_ids
      FROM push_subscriptions p
      JOIN technicians t ON t.id = p.admin_user_id
      WHERE p.active = true
        AND t.active IS NOT true
      GROUP BY p.admin_user_id
      ORDER BY p.admin_user_id
    `,
  },
];

async function main() {
  const json = process.argv.includes('--json');
  const details = process.argv.includes('--details');
  const snapshot = await db.transaction(async (trx) => {
    await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await trx.raw("SET LOCAL statement_timeout = '30s'");
    await trx.raw("SET LOCAL TIME ZONE 'UTC'");
    const targetResult = await trx.raw(`
      SELECT current_database() AS database_name,
             COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
             inet_server_port() AS server_port,
             current_user AS database_user
    `);
    const target = rowsFrom(targetResult)[0];
    const results = [];
    const schemaChecks = checks.filter((check) => check.schema);
    const dataChecks = checks.filter((check) => !check.schema);
    for (const check of schemaChecks) {
      // Deliberately sequential so one repeatable-read snapshot backs the report.
      results.push(await runCheck(trx, check));
    }
    for (const check of dataChecks) {
      // Deliberately sequential so one repeatable-read snapshot backs the report.
      results.push(await runDataCheck(trx, check));
    }
    return { target, results };
  });
  const { target, results: report } = snapshot;

  const blockers = report.filter((item) => item.blocking && item.count > 0);
  const incomplete = report.filter((item) => item.incomplete);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: blockers.length === 0 && incomplete.length === 0,
      blockers: blockers.length,
      incomplete: incomplete.length,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development',
      target,
      checks: report.map((item) => (
        details ? item : { ...item, rows: undefined }
      )),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Target database: ${target.database_name} on ${target.server_address}:${target.server_port || 'default'} `
      + `(user=${target.database_user}, env=${process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development'}, read-only)\n`,
    );
    for (const item of report) {
      const label = item.incomplete
        ? 'ERROR'
        : (item.count === 0 ? 'PASS' : (item.blocking ? 'BLOCK' : 'WARN'));
      process.stdout.write(`${label} ${item.key}: ${item.count} — ${item.description}\n`);
      if (details && item.count > 0) {
        process.stdout.write(`${JSON.stringify(item.rows, null, 2)}\n`);
      }
    }
    if (!details && report.some((item) => item.count > 0)) {
      process.stdout.write('Finding samples withheld; re-run with --details only in a restricted operator terminal.\n');
    }
    const verdict = incomplete.length > 0
      ? `Staff rollout audit incomplete: ${incomplete.length} check(s) could not be evaluated.`
      : (blockers.length === 0
        ? 'Staff rollout preflight passed.'
        : `Staff rollout blocked by ${blockers.length} check(s).`);
    process.stdout.write(`\n${verdict}\n`);
  }

  if (incomplete.length > 0) process.exitCode = 2;
  else if (blockers.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`Staff rollout audit failed: ${error.message}\n`);
      process.exitCode = 2;
    })
    .finally(async () => {
      await db.destroy();
    });
}

module.exports = {
  ACTIVE_WRITE_GENERATION,
  MAX_STAFF_EMAIL_LENGTH,
  RESET_LINK_TTL_MINUTES,
  WEEKLY_OVERTIME_THRESHOLD_MINUTES,
  checks,
  expectedDailyOvertimeMinutes,
  main,
  rowsFrom,
  runCheck,
  runDataCheck,
};
