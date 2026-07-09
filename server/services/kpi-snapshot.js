const { etDateString } = require('../utils/datetime-et');
const logger = require('./logger');

// Stable metric key → getter pulling the value out of the /core-kpis result
// object (computeCoreKpis). Keys are the column written to kpi_snapshots.metric;
// keep them stable — the client trend wiring keys off them. Each getter returns
// a number, or null/undefined when the metric was unavailable that day (the
// upstream handler nulls a metric whose query threw or whose window was empty).
//
// Paths mirror the EXACT shape of the /core-kpis res.json (see
// routes/admin-dashboard.js computeCoreKpis): service.*, financial.*, ar.*,
// quality.*, sales.*, retention.*, billing.*, momentum.{customers,mrr}.net.
const SNAPSHOT_METRICS = [
  ['completion_rate', (k) => k.service?.completionRate],
  ['callback_rate', (k) => k.service?.callbackRate],
  ['tech_utilization', (k) => k.financial?.utilization],
  ['stops_per_hour', (k) => k.financial?.stopsPerHour],
  ['revenue_per_job', (k) => k.financial?.revPerJob],
  ['revenue_per_man_hour', (k) => k.financial?.rpmh],
  ['gross_margin', (k) => k.financial?.grossMarginWeighted],
  ['ar_days', (k) => k.ar?.days],
  ['lead_conversion', (k) => k.sales?.conversion],
  ['response_speed_min', (k) => k.sales?.avgResponseMin],
  // csatAvg is a toFixed(1) string ("8.7") or null — parseFloat it.
  ['csat_avg', (k) => (k.quality?.csatAvg != null ? parseFloat(k.quality.csatAvg) : null)],
  ['retention_pct', (k) => k.retention?.pct],
  ['collection_rate', (k) => k.billing?.collectionRate],
  ['autopay_pct', (k) => k.billing?.autopayPct],
  ['net_customers', (k) => k.momentum?.customers?.net],
  ['net_mrr', (k) => k.momentum?.mrr?.net],
];

// Coerce a raw getter value to a finite Number, else null. A metric that is
// unavailable (null/undefined/NaN/Infinity) is recorded as NULL, not 0 — a true
// zero and "no data" must stay distinguishable in the trend. Null/undefined are
// guarded BEFORE Number() because Number(null) === 0 (and Number('') === 0),
// which would silently turn "no data" into a fake zero.
function toFiniteOrNull(v) {
  if (v == null || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * Capture the live MONTH-TO-DATE Core KPIs as the snapshot for `snapshotDate`
 * (an ET YYYY-MM-DD string, default today ET). Upserts one row per metric keyed
 * on (snapshot_date, metric), so a same-day re-run refreshes value + captured_at
 * rather than duplicating. db is lazy-required so this module (and its tests)
 * load without knex.
 *
 * One bad metric getter can't abort the run: values are computed defensively
 * (optional chaining + toFiniteOrNull), so a missing branch yields null instead
 * of throwing.
 *
 * @param {string} [snapshotDate]  ET YYYY-MM-DD (default: today ET)
 * @param {import('knex')} [conn]
 */
async function recordKpiSnapshot(snapshotDate, conn) {
  snapshotDate = snapshotDate || etDateString();
  conn = conn || require('../models/db');

  const k = await require('../routes/admin-dashboard').computeCoreKpis('mtd');

  let written = 0;
  for (const [metric, getter] of SNAPSHOT_METRICS) {
    let value = null;
    try {
      value = toFiniteOrNull(getter(k));
    } catch (err) {
      // Defensive: a getter should never throw (optional chaining), but if one
      // does, record the metric as unavailable rather than aborting the snapshot.
      logger.error(`[kpi-snapshot] metric ${metric} getter failed: ${err.message}`);
      value = null;
    }
    await conn('kpi_snapshots')
      .insert({ snapshot_date: snapshotDate, metric, value, captured_at: new Date() })
      .onConflict(['snapshot_date', 'metric'])
      .merge(); // refresh value + captured_at; keep created_at
    written += 1;
  }

  logger.info(`[kpi-snapshot] ${snapshotDate}: wrote ${written} metrics`);
  return { snapshot_date: snapshotDate, metrics: written };
}

/**
 * Sparkline series for the dashboard KPI tiles: per-metric daily values from
 * kpi_snapshots over the trailing `days` ET window. Values are the cron's
 * month-to-date captures — the same basis the tiles' live numbers use.
 *
 * @param {number|string} [days=90]  Trailing window, clamped to [7, 365].
 * @param {import('knex')} [conn]
 * @returns {Promise<{days:number, series:Object<string, Array<{date:string, value:number|null}>>}>}
 *          Dates ascending; value null when the metric was unavailable that
 *          day (kept so a gap reads as a gap, not a zero).
 */
async function getKpiHistory(days = 90, conn) {
  conn = conn || require('../models/db');
  const clamped = Math.min(365, Math.max(7, parseInt(days, 10) || 90));
  const rows = await conn('kpi_snapshots')
    .where(
      'snapshot_date', '>=',
      // date - int = date in Postgres; ET-anchored "today" matches the cron's
      // etDateString snapshot dates. days-1 back keeps the INCLUSIVE bound to
      // exactly `days` calendar days counting today — subtracting the full
      // count would return days+1 snapshots once today's row exists.
      conn.raw("(NOW() AT TIME ZONE 'America/New_York')::date - ?::int", [clamped - 1]),
    )
    .select(
      conn.raw("to_char(snapshot_date, 'YYYY-MM-DD') as date"),
      'metric',
      'value',
    )
    .orderBy('snapshot_date', 'asc');

  const series = {};
  for (const r of rows) {
    if (!series[r.metric]) series[r.metric] = [];
    series[r.metric].push({
      date: r.date,
      value: r.value == null ? null : parseFloat(r.value),
    });
  }
  return { days: clamped, series };
}

module.exports = { recordKpiSnapshot, getKpiHistory, SNAPSHOT_METRICS };
