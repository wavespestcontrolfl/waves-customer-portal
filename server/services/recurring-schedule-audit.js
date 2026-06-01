const db = require('../models/db');

const MONTH_RECURRENCE_INTERVALS = {
  monthly_nth_weekday: 1,
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  triannual: 4,
  semiannual: 6,
  biannual: 6,
  annual: 12,
  yearly: 12,
};

function normalizeLimit(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 100;
  return Math.min(Math.max(parsed, 1), 500);
}

function formatDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value).split('T')[0];
}

function buildRecurringScheduleAnomalySql({ includeCompleted = false, limit = 100 } = {}) {
  const terminalStatuses = includeCompleted
    ? ['cancelled', 'rescheduled']
    : ['cancelled', 'rescheduled', 'completed'];
  const statusPlaceholders = terminalStatuses.map(() => '?').join(', ');
  const intervalsValues = Object.entries(MONTH_RECURRENCE_INTERVALS)
    .map(() => '(?::text, ?::integer)')
    .join(', ');
  const intervalBindings = Object.entries(MONTH_RECURRENCE_INTERVALS)
    .flatMap(([pattern, months]) => [pattern, months]);

  return {
    sql: `
      WITH intervals(pattern, months) AS (
        VALUES ${intervalsValues}
      ),
      active_series AS (
        SELECT
          s.id,
          s.customer_id,
          concat_ws(' ', c.first_name, c.last_name) AS customer_name,
          s.service_type,
          s.scheduled_date::date AS scheduled_date,
          s.status,
          s.recurring_parent_id,
          COALESCE(p.recurring_pattern, s.recurring_pattern) AS pattern,
          COALESCE(p.scheduled_date, s.scheduled_date)::date AS parent_date,
          COALESCE(p.skip_weekends, s.skip_weekends) AS skip_weekends,
          COALESCE(p.weekend_shift, s.weekend_shift) AS weekend_shift
        FROM scheduled_services s
        LEFT JOIN scheduled_services p ON p.id = s.recurring_parent_id
        LEFT JOIN customers c ON c.id = s.customer_id
        JOIN intervals i ON i.pattern = COALESCE(p.recurring_pattern, s.recurring_pattern)
        WHERE s.is_recurring = true
          AND s.status NOT IN (${statusPlaceholders})
      ),
      child_anomalies AS (
        SELECT
          'child_anchor' AS check_type,
          a.customer_name,
          a.customer_id,
          a.id AS appointment_id,
          a.recurring_parent_id,
          a.service_type,
          a.status,
          a.pattern,
          a.parent_date AS reference_date,
          a.scheduled_date,
          (a.scheduled_date - a.parent_date) AS diff_days,
          a.skip_weekends,
          a.weekend_shift,
          CASE
            WHEN a.scheduled_date <= a.parent_date THEN 'child_on_or_before_parent'
            WHEN (a.scheduled_date - a.parent_date) < (i.months * 21) THEN 'child_too_close_to_parent'
          END AS issue
        FROM active_series a
        JOIN intervals i ON i.pattern = a.pattern
        WHERE a.recurring_parent_id IS NOT NULL
          AND (
            a.scheduled_date <= a.parent_date
            OR ((a.scheduled_date - a.parent_date) > 0 AND (a.scheduled_date - a.parent_date) < (i.months * 21))
          )
      ),
      sequenced AS (
        SELECT
          a.*,
          lag(a.scheduled_date) OVER (
            PARTITION BY COALESCE(a.recurring_parent_id, a.id)
            ORDER BY a.scheduled_date, a.id
          ) AS prev_date
        FROM active_series a
      ),
      consecutive_anomalies AS (
        SELECT
          'consecutive' AS check_type,
          s.customer_name,
          s.customer_id,
          s.id AS appointment_id,
          s.recurring_parent_id,
          s.service_type,
          s.status,
          s.pattern,
          s.prev_date AS reference_date,
          s.scheduled_date,
          (s.scheduled_date - s.prev_date) AS diff_days,
          s.skip_weekends,
          s.weekend_shift,
          'consecutive_too_close' AS issue
        FROM sequenced s
        JOIN intervals i ON i.pattern = s.pattern
        WHERE s.prev_date IS NOT NULL
          AND (s.scheduled_date - s.prev_date) > 0
          AND (s.scheduled_date - s.prev_date) < (i.months * 21)
      )
      SELECT * FROM child_anomalies
      UNION ALL
      SELECT * FROM consecutive_anomalies
      ORDER BY customer_name, check_type, scheduled_date
      LIMIT ?
    `,
    bindings: [...intervalBindings, ...terminalStatuses, normalizeLimit(limit)],
  };
}

function formatAnomaly(row) {
  return {
    checkType: row.check_type,
    issue: row.issue,
    customerId: row.customer_id,
    customerName: row.customer_name || null,
    appointmentId: row.appointment_id,
    recurringParentId: row.recurring_parent_id || null,
    serviceType: row.service_type || null,
    status: row.status || null,
    pattern: row.pattern || null,
    referenceDate: formatDateOnly(row.reference_date),
    scheduledDate: formatDateOnly(row.scheduled_date),
    diffDays: row.diff_days != null ? Number(row.diff_days) : null,
    skipWeekends: !!row.skip_weekends,
    weekendShift: row.weekend_shift || null,
  };
}

async function auditRecurringScheduleAnomalies(options = {}, conn = db) {
  const includeCompleted = options.includeCompleted === true;
  const limit = normalizeLimit(options.limit);
  const { sql, bindings } = buildRecurringScheduleAnomalySql({ includeCompleted, limit });
  const result = await conn.raw(sql, bindings);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const anomalies = rows.map(formatAnomaly);
  return {
    checkedAt: new Date().toISOString(),
    status: anomalies.length > 0 ? 'attention' : 'ok',
    includeCompleted,
    limit,
    anomalyCount: anomalies.length,
    anomalies,
  };
}

module.exports = {
  MONTH_RECURRENCE_INTERVALS,
  auditRecurringScheduleAnomalies,
  buildRecurringScheduleAnomalySql,
  formatAnomaly,
  formatDateOnly,
  normalizeLimit,
};
