const db = require('../models/db');
const { createHash } = require('node:crypto');
const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');

const MONTH_RECURRENCE_INTERVALS = {
  monthly_nth_weekday: 1,
  monthly: 1,
  // Seasonal mosquito (9x Feb–Oct): monthly spacing IN season, so the 1-month
  // too-close threshold (21 days) applies; the Oct→Feb winter gap is longer
  // than any threshold and can never false-positive (the checks only flag
  // gaps SMALLER than the minimum). Absent from this map the inner join
  // dropped every seasonal row before the duplicate/too-close checks ran.
  seasonal_feb_oct: 1,
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

// This check starts at ACCEPTANCE, including reservations that never acquired
// is_recurring. It only reports evidence for staff review: a later manual
// amendment can legitimately differ from the accepted snapshot.
function acceptedScheduleFindings(estimate, visits, stoppedRoots = new Set(), { todayET = etDateString(), heldFamilies = new Set() } = {}) {
  const converter = require('./estimate-converter');
  const seeder = require('./recurring-appointment-seeder');
  const { inferFrequencyKeyFromEstimateData } = require('./billing-cadence');
  const data = typeof estimate.estimate_data === 'string'
    ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {});
  if (estimate.accepted_service_mode === 'one_time') return [];
  const services = converter.recurringServicesFromEstimateData(data);
  if (converter.shouldSuppressRecurringConversion({
    monthlyRate: estimate.monthly_total, annualTotal: estimate.annual_total,
    oneTimeTotal: estimate.onetime_total, recurringServices: services, estimateData: data,
  })) return [];
  const acceptedFrequency = data.customerSelection?.frequency || null;
  const fallback = acceptedFrequency || inferFrequencyKeyFromEstimateData(data);
  const { remaining, combos, standalone } = converter.combineRecurringServicesForScheduling(services, {
    acceptFrequency: acceptedFrequency,
    supplementalCompanions: converter.supplementalCompanionLines(data),
  });
  // Keep the combiner's resolved cadence/count while checking each covered
  // family. Bond riders share the bait family and must not become extra visits.
  const units = [
    ...[...remaining, ...standalone.map((unit) => unit.service)]
      .map((service) => ({ service, family: converter.seedingFamilyKey(service) })),
    ...combos.flatMap((combo) => [...new Set(combo.combinedFrom.map((line) => converter.seedingFamilyKey(line)))]
      .map((family) => ({ service: combo.service, family }))),
  ];
  const findings = [];
  for (const { service, family } of units) {
    if (heldFamilies.has(family)) continue;
    const pattern = converter.converterFollowUpSeedingPattern(service, {}, fallback, acceptedFrequency);
    // Commercial, billing riders and contradictory custom terms already use
    // office scheduling. Do not invent a cadence for them from today's prices.
    if (!pattern) continue;
    const matching = visits.filter((row) => {
      if (row.catalog_billing_type === 'one_time') return false;
      const identity = row.catalog_service_key || row.service_key_snapshot;
      const families = converter.comboRouteFamiliesFromCatalogKey(identity);
      const matches = families.length ? families.includes(family)
        : converter.seedingFamilyKey({ service: identity, name: row.service_type }) === family;
      return matches && !row.is_callback && !row.followup_included;
    });
    if (matching.length && matching.every((row) => stoppedRoots.has(row.recurring_parent_id || row.id))) continue;
    const rows = matching.filter((row) => !stoppedRoots.has(row.recurring_parent_id || row.id));
    const finding = classifyAcceptedSchedule({ estimate, family, pattern, rows, todayET, seeder });
    if (finding) findings.push(finding);
  }
  return findings;
}

function classifyAcceptedSchedule({ estimate, family, pattern, rows, todayET, seeder }) {
  const live = rows.filter((row) => !['cancelled', 'rescheduled', 'skipped', 'no_show'].includes(row.status));
  const expectedVisits = seeder.plannedVisitCountForPattern(pattern);
  const issues = [];
  if (!rows.length) issues.push('missing_schedule');
  else if (!live.length) issues.push('cancelled_schedule_needs_review');
  else {
    if (live.some((row) => !row.is_recurring || !row.recurring_pattern)) issues.push('missing_recurrence');
    if (live.some((row) => {
      const stored = seeder.normalizeRecurringPattern(row.recurring_pattern);
      const sameInterval = (stored === 'custom' && Number(row.recurring_interval_days) === 42 && pattern === 'every_6_weeks')
        || (stored === 'monthly_nth_weekday' && pattern === 'monthly');
      return row.recurring_pattern && stored !== pattern && !sameInterval;
    })) {
      issues.push('cadence_differs_from_acceptance');
    }
    if (live.length < expectedVisits) issues.push('missing_applications');
    if (hasAcceptedScheduleSpacingGap(live, pattern, seeder)) issues.push('application_spacing_needs_review');
    const upcoming = live.filter((row) => formatDateOnly(row.scheduled_date) >= todayET && row.status !== 'completed');
    if (!upcoming.length && live.some((row) => row.recurring_ongoing)) issues.push('ongoing_plan_has_no_future_visit');
    if (estimate.property_id && live.some((row) => row.property_id !== estimate.property_id)) issues.push('property_link_needs_review');
  }
  if (!issues.length) return null;
  // The watchdog dedupes forever. Include the offending row state so a new
  // schedule regression after repair can ring again without ringing daily.
  const evidenceKey = createHash('sha256').update(JSON.stringify({
    issues, pattern, expectedVisits,
    rows: rows.map((row) => [row.id, row.status, row.recurring_pattern, row.is_recurring,
      row.recurring_interval_days, row.recurring_ongoing, row.date_exception, formatDateOnly(row.date_exception_cadence_date),
      row.recurring_nth, row.recurring_weekday, row.skip_weekends, row.weekend_shift,
      // A correction followed by the SAME bad state must be a new incident.
      row.row_revision, row.property_id, formatDateOnly(row.scheduled_date)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })).digest('hex').slice(0, 20);
  return { estimateId: estimate.id, customerId: estimate.customer_id, serviceFamily: family,
    pattern, expectedVisits, recordedVisits: live.length, issues, evidenceKey,
    appointmentIds: rows.map((row) => row.id) };
}

function hasAcceptedScheduleSpacingGap(rows, pattern, seeder) {
  // Rebooker's stored cadence position keeps an exception in its original
  // slot even if the actual appointment moved past another application.
  const sorted = rows.map((row) => row.date_exception && row.date_exception_cadence_date
    ? { ...row, scheduled_date: formatDateOnly(row.date_exception_cadence_date), date_exception: false }
    : row).sort((a, b) => formatDateOnly(a.scheduled_date).localeCompare(formatDateOnly(b.scheduled_date)));
  let anchorIndex = 0;
  let expectedTerm = [];
  return sorted.some((row, index) => {
    // Older exceptions may lack their canonical position. Break only at
    // that unknown position; the following known run still gets span checks.
    if (row.date_exception) {
      anchorIndex = index + 1;
      return false;
    }
    if (index === anchorIndex) {
      expectedTerm = seeder.buildRecurringFollowUpRows(row, {
        pattern, plannedCount: sorted.length - index,
      });
      return false;
    }
    const previous = sorted[index - 1];
    const previousDate = formatDateOnly(previous.scheduled_date);
    const currentDate = formatDateOnly(row.scheduled_date);
    if (currentDate <= previousDate) return true;
    const [next] = seeder.buildRecurringFollowUpRows({ ...previous, scheduled_date: previousDate }, { pattern, plannedCount: 2 });
    if (!next) return false;
    // Ordinary rescheduling/weekend drift has room; a monthly plan with
    // quarterly dates still pages even if all its stored patterns say monthly.
    const expectedDates = [next.scheduled_date];
    // Small delays cannot accumulate into an 18-month "year" of service.
    const anchored = expectedTerm[index - anchorIndex - 1];
    if (anchored) expectedDates.push(anchored.scheduled_date);
    return expectedDates.some((date) => {
      const expected = parseETDateTime(`${date}T12:00`);
      const earliest = etDateString(addETDays(expected, -14));
      const latest = etDateString(addETDays(expected, 14));
      return currentDate < earliest || currentDate > latest;
    });
  });
}

async function findAcceptedRecurringScheduleGaps({ now = new Date() } = {}, conn = db) {
  // Let the accept/conversion transaction settle before paging. A real Date
  // binds a timestamptz cutoff independently of Railway's UTC process zone.
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
  const estimates = await conn('estimates as e')
    .join('customers as c', 'c.id', 'e.customer_id')
    .where('e.status', 'accepted').whereNull('e.archived_at')
    .where('e.accepted_at', '<=', cutoff).where('c.active', true)
    .whereNull('c.deleted_at')
    .where(function includeUnconvertedStage() {
      this.whereNotIn('c.pipeline_stage', FORMER_CUSTOMER_STAGES).orWhereNull('c.pipeline_stage');
    })
    .select('e.id', 'e.customer_id', 'e.property_id', 'e.estimate_data', 'e.accepted_service_mode',
      'e.monthly_total', 'e.annual_total', 'e.onetime_total')
    .orderBy('e.accepted_at', 'desc');
  if (!estimates.length) return [];
  const customerIds = [...new Set(estimates.map((row) => row.customer_id))];
  // Include children with no source_estimate_id: maintenance/seeding can link
  // them only through their parent. Never borrow another customer's series.
  const visits = await conn('scheduled_services as s')
    .leftJoin('services as catalog', 'catalog.id', 's.service_id')
    .whereIn('s.customer_id', customerIds)
    .select('s.id', 's.customer_id', 's.property_id', 's.source_estimate_id', 's.recurring_parent_id',
      's.service_type', 's.service_key_snapshot', 's.is_callback', 's.followup_included',
      's.status', 's.is_recurring', 's.recurring_pattern', 's.recurring_ongoing',
      's.date_exception', 's.recurring_nth', 's.recurring_weekday', 's.recurring_interval_days', 's.skip_weekends', 's.weekend_shift',
      'catalog.service_key as catalog_service_key', 'catalog.billing_type as catalog_billing_type',
      // Some existing writers omit updated_at. xmin tracks the actual tuple
      // transaction, so a later repair/regression gets fresh alert evidence.
      conn.raw('s.xmin::text as row_revision'),
      conn.raw("to_char(s.date_exception_cadence_date, 'YYYY-MM-DD') as date_exception_cadence_date"),
      conn.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date"));
  const retainedSeries = await conn('activity_log').whereIn('customer_id', customerIds)
    .where('action', 'recurring_series_skipped').select('customer_id', 'metadata');
  const todayET = etDateString(now);
  const holds = await conn('plan_holds').whereIn('customer_id', customerIds).where('status', 'active')
    .where('starts_on', '<=', todayET).where('resume_on', '>', todayET).select('customer_id', 'family_key');
  const decisions = await conn('recurring_plan_alerts').whereIn('customer_id', customerIds)
    .whereNotNull('resolved_at').orderBy('resolved_at', 'desc')
    .select('recurring_parent_id', 'resolved_action');
  // Query is newest-first; Map's last value wins after reversing it.
  const latestDecision = new Map(decisions.map((row) => [row.recurring_parent_id, row.resolved_action]).reverse());
  const stopped = new Set([...latestDecision].filter(([, action]) => ['cancel_series', 'let_lapse'].includes(action)).map(([id]) => id));
  // Index history once: each estimate only walks its explicitly linked roots.
  const customers = new Map(customerIds.map((id) => [id, { roots: new Map(), holds: new Set() }]));
  const estimatesById = new Map(estimates.map((estimate) => [estimate.id, { estimate, roots: new Set() }]));
  for (const row of visits) {
    const root = row.recurring_parent_id || row.id;
    const series = customers.get(row.customer_id).roots;
    if (!series.has(root)) series.set(root, []);
    series.get(root).push(row);
    const target = estimatesById.get(row.source_estimate_id);
    if (target?.estimate.customer_id === row.customer_id) target.roots.add(root);
  }
  for (const event of retainedSeries) {
    const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
    const target = estimatesById.get(metadata?.estimateId);
    if (target?.estimate.customer_id === event.customer_id && metadata.existingParentId) target.roots.add(metadata.existingParentId);
  }
  for (const hold of holds) customers.get(hold.customer_id).holds.add(hold.family_key);
  const findings = [];
  for (const { estimate, roots } of estimatesById.values()) {
    // Pre-mode acceptances and pre-lineage schedules were never backfilled.
    // Without either evidence, "no link" cannot establish "no schedule".
    if (!estimate.accepted_service_mode && !roots.size) continue;
    const customer = customers.get(estimate.customer_id);
    const linkedRows = [...roots].flatMap((root) => customer.roots.get(root) || []);
    findings.push(...acceptedScheduleFindings(estimate, linkedRows, stopped, { todayET, heldFamilies: customer.holds }));
  }
  return findings;
}

module.exports = {
  MONTH_RECURRENCE_INTERVALS,
  auditRecurringScheduleAnomalies,
  buildRecurringScheduleAnomalySql,
  formatAnomaly,
  formatDateOnly,
  normalizeLimit,
  acceptedScheduleFindings,
  findAcceptedRecurringScheduleGaps,
};
