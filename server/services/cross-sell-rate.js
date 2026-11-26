/**
 * The cross-sell number (owner approved 2026-11-26): the share of recurring customers who have two or more kinds of
 * recurring service. Read-only: sends nothing, charges nothing, writes nothing, calls no paid API. The monthly snapshot
 * (monthly-financial-snapshot.js computeMonthSnapshot) stores crossSellForMonthEnd's result on the 2nd of each month; the
 * dashboard reads today's value live and the stored months for the trend.
 *
 * Counting rule. A scheduled_services row counts when is_recurring is true, is_callback is not true and status is not
 * 'cancelled'. Each row maps to a service family:
 *   service_key_snapshot starts with pest_general -> pest, lawn_care -> lawn, tree_shrub -> tree_shrub, mosquito -> mosquito,
 *   termite -> termite, rodent_bait -> rodent_bait. Any other stored key (cockroach_control, flea_tick, rodent_trapping...)
 *   has no family and is ignored.
 *   No stored key (NULL): the service_type text decides: lawn -> lawn, tree or shrub -> tree_shrub, mosquito -> mosquito,
 *   termite or bait -> termite, pest -> pest; nothing else counts.
 * For a day M a customer HAS a family when a row of that family is scheduled within 95 days either side of M, so a quarterly
 * customer between two visits still counts. Customers counted: not deleted, and not churned on or before M.
 * recurring_customers = customers with at least one family; multi_service_customers = customers with two or more.
 *
 * Source of the added service. For each multi-service customer the "added" service is the family whose earliest recurring
 * visit (by created_at, any date) is the newest. How that earliest visit came in (classifySource):
 *   its estimate (scheduled_services.source_estimate_id -> estimates.source):
 *       one_tap_purchase, plan_start   -> app          (the Waves app Billing tab: one-tap purchase or a priced plan quote;
 *                                                       the receipt and tracker add-a-service cards only open that tab)
 *       service_report_cta             -> service_report_card
 *       quote_wizard                   -> website_quote
 *       any other estimate             -> estimate
 *   no estimate: scheduled_services.source starting quote-wizard -> website_quote;
 *   source_call_log_id set or booking_source phone_call -> phone_call; source ending _import_YYYY_MM or _cleanup_YYYY_MM -> imported; else office.
 */
const { dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');

const WINDOW_DAYS = 95;

// Stored service key prefix -> family. Table-driven so the SQL below and the tests read one list.
const FAMILY_BY_KEY_PREFIX = [
  ['pest_general', 'pest'],
  ['lawn_care', 'lawn'],
  ['tree_shrub', 'tree_shrub'],
  ['mosquito', 'mosquito'],
  ['termite', 'termite'],
  ['rodent_bait', 'rodent_bait'],
];
// service_type words (case-insensitive) -> family, first match wins; only used when no key is stored.
const FAMILY_BY_SERVICE_TYPE_WORD = [
  ['lawn', 'lawn'],
  ['tree', 'tree_shrub'],
  ['shrub', 'tree_shrub'],
  ['mosquito', 'mosquito'],
  ['termite', 'termite'],
  ['rodent%bait', 'rodent_bait'],
  ['bait', 'termite'],
  ['pest', 'pest'],
];

// estimates.source -> bucket. Anything not listed (and not empty) is a plain "estimate".
const SOURCE_BY_ESTIMATE_SOURCE = {
  one_tap_purchase: 'app',
  plan_start: 'app',
  service_report_cta: 'service_report_card',
  quote_wizard: 'website_quote',
};
const SOURCE_BUCKETS = ['app', 'service_report_card', 'website_quote', 'estimate', 'phone_call', 'imported', 'office'];

const PEST_ONLY_LIMIT = 500;

// Both lists are constants in this file, never user input, so they are written into the SQL as literals.
const sqlLiteral = (text) => `'${String(text).replaceAll("'", "''")}'`;

function familySql(alias = 'ss') {
  const byKey = FAMILY_BY_KEY_PREFIX
    .map(([prefix, family]) => `WHEN starts_with(${alias}.service_key_snapshot, ${sqlLiteral(prefix)}) THEN ${sqlLiteral(family)}`)
    .join(' ');
  const byType = FAMILY_BY_SERVICE_TYPE_WORD
    .map(([word, family]) => `WHEN ${alias}.service_type ILIKE ${sqlLiteral(`%${word}%`)} THEN ${sqlLiteral(family)}`)
    .join(' ');
  return `CASE WHEN ${alias}.service_key_snapshot IS NOT NULL THEN CASE ${byKey} END ELSE CASE ${byType} END END`;
}

// The counted visits, each with its family; and the (customer, family) pairs held on day `as of` (?, ?, ?).
const COUNTED_VISITS_SQL = `
  v AS (
    SELECT ss.id, ss.customer_id, ss.scheduled_date, ss.created_at, ss.service_key_snapshot, ss.service_type,
           ss.source_estimate_id, ss.source, ss.source_call_log_id, ss.booking_source, ${familySql('ss')} AS fam
    FROM scheduled_services ss
    WHERE ss.is_recurring = true AND COALESCE(ss.is_callback, false) = false AND ss.status <> 'cancelled'
  ),
  held AS (
    SELECT v.customer_id, v.fam
    FROM v
    JOIN customers c ON c.id = v.customer_id AND c.deleted_at IS NULL
      -- A churn stamp on or before the day drops the customer, unless this visit was booked after it (a reactivation).
      AND (c.churned_at IS NULL OR c.churned_at > CAST(? AS date) OR v.created_at > c.churned_at)
    WHERE v.fam IS NOT NULL
      -- Only visits already booked by the end of the day (ET): a later purchase never rewrites a closed month.
      AND v.created_at < (CAST(? AS date) + 1)::timestamp AT TIME ZONE 'America/New_York'
      AND v.scheduled_date BETWEEN CAST(? AS date) - ${WINDOW_DAYS} AND CAST(? AS date) + ${WINDOW_DAYS}
    GROUP BY v.customer_id, v.fam
  )`;

function asOfBindings(asOf) {
  return [asOf, asOf, asOf, asOf];
}

function requireDate(value) {
  const day = dateOnlyString(value);
  if (!day) throw new Error(`cross-sell-rate: "${value}" is not a calendar date`);
  return day;
}

const startsWith = (value, prefix) => typeof value === 'string' && value.startsWith(prefix);
// The June 2026 bulk loads of visits from the old booking system stamp source '<name>_import_2026_06' or '<name>_cleanup_2026_06'.
const IMPORT_SOURCE_RE = /_(?:import|cleanup)_\d{4}_\d{2}$/;

/** How a service came in, from the earliest visit's fields (see the header). */
function classifySource({ estimateId, estimateSource, source, sourceCallLogId, bookingSource } = {}) {
  if (estimateId) return SOURCE_BY_ESTIMATE_SOURCE[estimateSource] || 'estimate';
  if (startsWith(source, 'quote-wizard')) return 'website_quote';
  if (sourceCallLogId || bookingSource === 'phone_call') return 'phone_call';
  if (typeof source === 'string' && IMPORT_SOURCE_RE.test(source)) return 'imported';
  return 'office';
}

const emptySources = () => Object.fromEntries(SOURCE_BUCKETS.map((bucket) => [bucket, 0]));
const createdAtMs = (row) => (row.created_at ? new Date(row.created_at).getTime() : Number.NEGATIVE_INFINITY);

/** The customer's added service: the family whose earliest recurring visit is the newest (ties: the later family name). */
function addedServiceVisit(visits) {
  return visits.reduce((newest, visit) => {
    const delta = createdAtMs(visit) - createdAtMs(newest);
    if (delta > 0 || (delta === 0 && String(visit.fam) > String(newest.fam))) return visit;
    return newest;
  });
}

function summarizeHeldFamilies(rows) {
  const byCustomer = new Map();
  for (const row of rows) {
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
    byCustomer.get(row.customer_id).push(row);
  }
  const sources = emptySources();
  let multiServiceCustomers = 0;
  for (const visits of byCustomer.values()) {
    if (visits.length < 2) continue;
    multiServiceCustomers += 1;
    const added = addedServiceVisit(visits);
    sources[classifySource({
      estimateId: added.source_estimate_id,
      estimateSource: added.estimate_source,
      source: added.source,
      sourceCallLogId: added.source_call_log_id,
      bookingSource: added.booking_source,
    })] += 1;
  }
  return { recurringCustomers: byCustomer.size, multiServiceCustomers, sources };
}

/**
 * Cross-sell counts for the day `monthEndDate` ('YYYY-MM-DD' or a Date; a month's last day, or today):
 * { recurringCustomers, multiServiceCustomers, sources }. One read; `db` may be a transaction.
 */
async function crossSellForMonthEnd(db, monthEndDate) {
  const asOf = requireDate(monthEndDate);
  const { rows } = await db.raw(`
    WITH ${COUNTED_VISITS_SQL},
    first_visit AS (
      SELECT DISTINCT ON (v.customer_id, v.fam)
             v.customer_id, v.fam, v.created_at, v.source_estimate_id, v.source, v.source_call_log_id, v.booking_source
      FROM v
      JOIN held h ON h.customer_id = v.customer_id AND h.fam = v.fam
      ORDER BY v.customer_id, v.fam, v.created_at NULLS LAST, v.id
    )
    SELECT f.*, e.source AS estimate_source
    FROM first_visit f
    LEFT JOIN estimates e ON e.id = f.source_estimate_id
  `, asOfBindings(asOf));
  return summarizeHeldFamilies(rows);
}

/**
 * Customers whose only family of recurring service on `asOfDate` is pest: { id, firstName, lastName, city, pestServiceKey },
 * by last name, at most 500. pestServiceKey is the stored key of their latest pest visit (the service type text when no key is stored).
 */
async function pestOnlyCustomers(db, asOfDate) {
  const asOf = requireDate(asOfDate);
  const { rows } = await db.raw(`
    WITH ${COUNTED_VISITS_SQL},
    pest_only AS (
      SELECT customer_id FROM held GROUP BY customer_id HAVING COUNT(*) = 1 AND MIN(fam) = 'pest'
    ),
    latest_pest AS (
      SELECT DISTINCT ON (v.customer_id) v.customer_id, COALESCE(v.service_key_snapshot, v.service_type) AS pest_service_key
      FROM v
      JOIN pest_only p ON p.customer_id = v.customer_id
      WHERE v.fam = 'pest'
      ORDER BY v.customer_id, v.scheduled_date DESC, v.id
    )
    SELECT c.id, c.first_name, c.last_name, c.city, l.pest_service_key
    FROM latest_pest l
    JOIN customers c ON c.id = l.customer_id
    ORDER BY LOWER(c.last_name), LOWER(c.first_name), c.id
    LIMIT ${PEST_ONLY_LIMIT}
  `, asOfBindings(asOf));
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    city: r.city,
    pestServiceKey: r.pest_service_key,
  }));
}

/** A crossSellForMonthEnd result as the three monthly_financial_snapshots columns. */
function snapshotColumns(result) {
  return {
    recurring_customers: result.recurringCustomers,
    multi_service_customers: result.multiServiceCustomers,
    multi_service_sources: JSON.stringify(result.sources),
  };
}

/** The snapshot columns for a month: counts and the source split. */
async function crossSellColumns(db, monthEndDate) {
  return snapshotColumns(await crossSellForMonthEnd(db, monthEndDate));
}

const share = (multi, recurring) => (recurring > 0 ? Math.round((multi / recurring) * 10000) / 10000 : null);

function seriesPoint(row) {
  const recurringCustomers = Number(row.recurring_customers);
  const multiServiceCustomers = Number(row.multi_service_customers) || 0;
  return {
    month: dateOnlyString(row.month),
    recurringCustomers,
    multiServiceCustomers,
    share: share(multiServiceCustomers, recurringCustomers),
  };
}

/**
 * The dashboard card's payload: the last `months` stored months (oldest first; a row stored before the columns existed is
 * left out), today's live value with its source split, and the pest-only customers. Three reads, no writes.
 */
async function getCrossSellSummary({ months = 12, db = require('../models/db'), today = etDateString() } = {}) {
  const limit = Math.max(1, Math.min(36, parseInt(months, 10) || 12));
  const stored = await db('monthly_financial_snapshots')
    .whereNotNull('recurring_customers')
    // A month before the June 2026 visit import holds no booked visits (0 of 0): it is not a reading.
    .where('recurring_customers', '>', 0)
    .orderBy('month', 'desc')
    .limit(limit)
    .select('month', 'recurring_customers', 'multi_service_customers');
  const live = await crossSellForMonthEnd(db, today);
  const pestOnly = await pestOnlyCustomers(db, today);
  return {
    series: stored.map(seriesPoint).reverse(),
    now: {
      asOf: today,
      recurringCustomers: live.recurringCustomers,
      multiServiceCustomers: live.multiServiceCustomers,
      share: share(live.multiServiceCustomers, live.recurringCustomers),
    },
    sources: live.sources,
    pestOnly,
  };
}

module.exports = {
  WINDOW_DAYS,
  PEST_ONLY_LIMIT,
  FAMILY_BY_KEY_PREFIX,
  FAMILY_BY_SERVICE_TYPE_WORD,
  SOURCE_BUCKETS,
  familySql,
  classifySource,
  addedServiceVisit,
  summarizeHeldFamilies,
  crossSellForMonthEnd,
  pestOnlyCustomers,
  snapshotColumns,
  crossSellColumns,
  share,
  getCrossSellSummary,
};
