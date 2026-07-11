#!/usr/bin/env node

/**
 * Read-only production preflight for the Staff authentication/payroll rollout.
 *
 * Default output is counts only. `--details` adds structural identifiers and
 * payroll timing metadata, so use it only in a restricted operator terminal.
 * Run against the intended Railway database before enabling the Staff
 * migration or adding the deferred active-timer partial unique index.
 */
const db = require('../models/db');

const SAMPLE_LIMIT = 25;

function rowsFrom(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
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
    description: 'Staff time entry type/status nullability or allowed-value constraint is missing',
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
      required_checks(invariant, constraint_names) AS (
        VALUES
          (
            'time entry type allowed values',
            ARRAY['time_entries_entry_type_check', 'time_entries_staff_entry_type_check']::text[]
          ),
          (
            'time entry status allowed values',
            ARRAY['time_entries_status_check', 'time_entries_staff_status_check']::text[]
          ),
          (
            'active timer writer generation fence',
            ARRAY['time_entries_staff_active_write_generation_check']::text[]
          )
      ),
      missing_checks AS (
        SELECT required.invariant
        FROM required_checks required
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'time_entries'
            AND c.contype = 'c'
            AND c.convalidated
            AND c.conname = ANY(required.constraint_names)
        )
      )
      SELECT invariant FROM missing_not_null
      UNION ALL
      SELECT invariant FROM missing_checks
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
          ABS(COALESCE(w.total_shift_minutes, 0) - COALESCE(e.shift_minutes, 0)) > 0.02
          OR (
            jsonb_exists(w.week_json, 'total_job_minutes')
            AND ABS(
              COALESCE(NULLIF(w.week_json ->> 'total_job_minutes', '')::numeric, 0)
              - COALESCE(e.job_minutes, 0)
            ) > 0.02
          )
          OR (
            jsonb_exists(w.week_json, 'total_drive_minutes')
            AND ABS(
              COALESCE(NULLIF(w.week_json ->> 'total_drive_minutes', '')::numeric, 0)
              - COALESCE(e.drive_minutes, 0)
            ) > 0.02
          )
          OR ABS(COALESCE(w.regular_minutes, 0) - LEAST(COALESCE(e.shift_minutes, 0), 2400)) > 0.02
          OR ABS(COALESCE(w.overtime_minutes, 0) - GREATEST(COALESCE(e.shift_minutes, 0) - 2400, 0)) > 0.02
          OR COALESCE(w.job_count, 0) <> COALESCE(e.job_count, 0)
          OR COALESCE(w.days_worked, 0) <> COALESCE(e.days_worked, 0)
        )
      ORDER BY w.week_start, w.technician_id
    `,
  },
  {
    key: 'invalid_active_staff_identity',
    description: 'Active staff account cannot authenticate or request a reset with its stored email',
    sql: `
      SELECT id AS technician_id, role,
             CASE
               WHEN email IS NULL OR BTRIM(email) = '' THEN 'missing_email'
               WHEN LENGTH(BTRIM(email)) > 254 THEN 'email_too_long'
               ELSE 'invalid_email_format'
             END AS reason
      FROM technicians
      WHERE role IN ('admin', 'technician')
        AND active = true
        AND (
          email IS NULL
          OR BTRIM(email) = ''
          OR LENGTH(BTRIM(email)) > 254
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
      // eslint-disable-next-line no-await-in-loop
      results.push(await runCheck(trx, check));
    }
    for (const check of dataChecks) {
      // Deliberately sequential so one repeatable-read snapshot backs the report.
      // eslint-disable-next-line no-await-in-loop
      results.push(await runCheck(trx, check));
    }
    return { target, results };
  });
  const { target, results: report } = snapshot;

  const blockers = report.filter((item) => item.blocking && item.count > 0);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: blockers.length === 0,
      blockers: blockers.length,
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
      const label = item.count === 0 ? 'PASS' : (item.blocking ? 'BLOCK' : 'WARN');
      process.stdout.write(`${label} ${item.key}: ${item.count} — ${item.description}\n`);
      if (details && item.count > 0) {
        process.stdout.write(`${JSON.stringify(item.rows, null, 2)}\n`);
      }
    }
    if (!details && report.some((item) => item.count > 0)) {
      process.stdout.write('Finding samples withheld; re-run with --details only in a restricted operator terminal.\n');
    }
    process.stdout.write(`\n${blockers.length === 0 ? 'Staff rollout preflight passed.' : `Staff rollout blocked by ${blockers.length} check(s).`}\n`);
  }

  if (blockers.length > 0) process.exitCode = 1;
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
  checks,
  main,
  rowsFrom,
  runCheck,
};
