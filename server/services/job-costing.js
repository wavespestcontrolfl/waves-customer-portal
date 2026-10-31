/**
 * Job Costing Service
 *
 * Calculates per-visit revenue, labor, material, drive, and expense costs
 * for a completed scheduled_service. Writes the result to TWO places:
 *   1. job_costs            — the costing ledger (admin-job-costs / equipment).
 *   2. service_records.*     — the financial columns the Dashboard
 *                              (admin-dashboard core-kpis: Gross Margin,
 *                              Stops/Hour, Tech Utilization, Revenue/Man-Hour)
 *                              and /admin/revenue read. These were never
 *                              populated on completion, so every tile that
 *                              filters `whereNotNull('revenue')` rendered "—".
 *
 * Data sources:
 *   revenue       — see deriveRevenue(): mirrors the completion handler's
 *                   invoiceAmount (estimated_price → monthly_rate, callbacks $0)
 *   labor_cost    — time_entries.duration_minutes (else actual_start/end span,
 *                   else, for a completed visit nothing measured, its scheduled
 *                   estimated_duration_minutes)
 *                   × loaded_labor_rate of the company_financials row in
 *                   effect on the visit's scheduled date
 *   material_cost — product_inventory_movements.cost_used, plus
 *                   property_application_history fallback costs priced by the
 *                   same per-unit rule as the inventory deduction
 *                   (inventory-cost.js)
 *   drive_cost    — drive_cost_per_stop of the company_financials row in
 *                   effect on the visit's scheduled date (once per physical
 *                   stop when a combined-closeout allocation marker is present)
 *   expenses      — expenses WHERE scheduled_service_id=?
 *
 * GATE_TECH_COST_RATES (L11a) on, AND a cost card in effect for the visit's
 * technician on its scheduled date (tech-cost-rates.js): labor_cost = the
 * technician's labor cost per worked hour x (on-job minutes + drive minutes),
 * and drive_cost = per-mile cost x drive miles + the vehicle's fixed cost per
 * worked hour x (on-job minutes + drive minutes). Drive minutes and miles come
 * from the visit's matched visit_gps_legs row when that table and row exist,
 * else the measured per-stop defaults below. Gate off, or no card = the lines
 * above, unchanged.
 *
 * With a card applied, job_costs also keeps the two minute figures the cost was charged for
 * (charged_on_job_minutes, charged_drive_minutes; L11b), which the open time report adds up against a
 * technician's paid day. NULL = no card applied. They are written only when those columns exist, and
 * they change no cost figure.
 *
 * GATE_JOB_COST_STANDARD_MINUTES (owner ruling 2026-10-31) on: a completed lawn visit books 20 on-site
 * minutes and a pest control visit 25 (JOB_COST_STANDARD), a measured span over 480 minutes books the
 * visit's scheduled estimate, the drive to a stop is the Average Drive Time at the loaded labor rate, and
 * revenue falls back to the visit's own annual-prepay share or linked invoice (never today's monthly
 * rate under keepRecordedRevenue). Cost and margin figures only. Off = everything above, unchanged.
 *
 * Idempotent: re-running replaces the prior job_costs row and re-writes the
 * service_records financials for the same scheduled_service_id.
 *
 * A db handle can be passed to every entry point so a migration can run the
 * backfill on its own knex instance (the module never opens the app db
 * singleton unless a call omits the handle).
 */

const logger = require('./logger');
const { isAlwaysFreeServiceType, isConsultationServiceType } = require('./no-cost-visit-types');
const { hasAuthoritativeZeroPrice } = require('./billing-lane');
const { baseQuantityUnit, convertInventoryQuantity } = require('./inventory-units');
const { calculateInventoryCost } = require('./inventory-cost');
// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): read at call time through
// billing-lane's one resolver (lazy, so no require cycle).
const stampedZeroFreeLive = () => require('./billing-lane').stampedZeroFreeLive();

const DEFAULT_LABOR_RATE = 35; // fallback if company_financials empty
const DEFAULT_DRIVE_COST_PER_STOP = 6;
// GATE_TECH_COST_RATES: the drive a visit is charged when no matched GPS leg
// exists for it. The 10-26 measurement: 11 miles and 24 minutes per stop.
const DEFAULT_DRIVE_MINUTES_PER_STOP = 24;
const DEFAULT_DRIVE_MILES_PER_STOP = 11;

// GATE_JOB_COST_STANDARD_MINUTES. Owner ruling 2026-10-31: measured check-in-to-report spans are inflated
// by on-site conversation and by writing the report in the van, and one lawn visit closed weeks after
// check-in carried 528 hours. So a lawn care visit is costed at 20 on-site minutes and a pest control
// visit at 25, whatever the clock says. A service type that also names a specialty or one-off job has no
// standard and keeps its measured time. A measured result over staleSpanMinutes is a stale span and
// books the visit's scheduled estimate instead.
const JOB_COST_STANDARD = Object.freeze({
  rules: Object.freeze([
    Object.freeze({ pattern: /lawn care/i, minutes: 20 }),
    Object.freeze({ pattern: /pest control/i, minutes: 25 }),
  ]),
  excluded: /cockroach|roach|rodent|termite|mosquito|bed ?bug|flea|wasp|bee|wildlife|exclusion|inspection/i,
  staleSpanMinutes: 480,
  defaultDriveMinutes: 20,
});

// Paid annual-prepay term statuses, from annual-prepay-renewals.js: ACTIVE_STATUSES (line 18), the decided
// coverage statuses (line 22, covered while the prepay invoice is paid), payment_pending (line 23, covered
// once the invoice is collected), and PREPAY_INVOICE_COLLECTED_STATUSES (line 2591).
const PREPAY_LIVE_TERM_STATUSES = ['active', 'renewal_pending'];
const PREPAY_DECIDED_TERM_STATUSES = ['renewed', 'switch_plan'];
const PREPAY_INVOICE_COLLECTED_STATUSES = ['paid', 'prepaid'];
// Visit statuses that do not take a share of the prepay (annual-prepay-renewals.js COVERAGE_EXCLUDED_STATUSES, line 218).
const PREPAY_UNCOUNTED_VISIT_STATUSES = ['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled'];
// Invoice statuses that bill nothing (annual-prepay-invoice-statuses.js).
const INVOICE_NO_REVENUE_STATUSES = ['void', 'voided', 'cancelled', 'canceled', 'refunded'];
// A one-time setup, membership or onboarding fee is not the visit's service revenue. Real descriptions:
// "WaveGuard Membership — one-time setup", "One-time setup fee", "setup fee — waived ...". Tax is never a line.
const INVOICE_NON_SERVICE_LINE_RE = /set[- ]?up|onboarding|membership fee|enrollment fee|\btax\b/i;

// Lazy so importing this module (e.g. from a migration) never opens the app's
// db pool — the singleton is only resolved when a caller omits the handle.
function resolveDb(db) {
  return db || require('../models/db');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// service_records.structured_notes is jsonb (object from pg) but historic
// writers and test fixtures also store serialized strings — parse it with the
// same resilient shape the completion route's parseJsonObject uses
// (admin-dispatch.js): object passes through, string parses, anything else
// (arrays, garbage, null) collapses to {}.
function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// DATE cell or 'YYYY-MM-DD' string → 'YYYY-MM-DD', or null when unparseable.
// node-postgres parses a DATE column to a LOCAL-midnight Date (no type parser
// is registered in this app), so a Date is read with LOCAL getters: UTC getters
// or toISOString() would drift a day in any zone east of UTC. Same rule as
// admin-revenue.js effectiveDateStr.
function visitDateString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  return null;
}

// Cost settings in effect on a visit's date: the company_financials row with
// the greatest effective_date <= onDate (same date: newest created_at, then id).
// A visit older than every row reads the OLDEST row. No usable onDate reads the
// newest row. Re-costing an old visit therefore never picks up a rate saved
// later. Table empty or unreadable: the defaults.
async function getFinancials(db, onDate) {
  try {
    const dateStr = visitDateString(onDate);
    const order = (dir) => [
      { column: 'effective_date', order: dir },
      { column: 'created_at', order: 'desc', nulls: 'last' },
      { column: 'id', order: 'desc' },
    ];
    let row = null;
    if (dateStr) {
      row = await db('company_financials')
        .where('effective_date', '<=', dateStr)
        .orderBy(order('desc'))
        .first();
      if (!row) row = await db('company_financials').orderBy(order('asc')).first();
    } else {
      row = await db('company_financials').orderBy(order('desc')).first();
    }
    return {
      laborRate: Number(row?.loaded_labor_rate) || DEFAULT_LABOR_RATE,
      driveCostPerStop: row?.drive_cost_per_stop != null
        ? Number(row.drive_cost_per_stop)
        : DEFAULT_DRIVE_COST_PER_STOP,
    };
  } catch {
    return { laborRate: DEFAULT_LABOR_RATE, driveCostPerStop: DEFAULT_DRIVE_COST_PER_STOP };
  }
}

// GATE_TECH_COST_RATES, read at call time. Lazy and guarded so importing this
// module (a migration backfill) never loads the gate map, and a suite that mocks
// feature-gates without this reader reads "off".
function techCostRatesOn() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.techCostRatesLive === 'function' && gates.techCostRatesLive() === true;
  } catch {
    return false;
  }
}

// GATE_JOB_COST_STANDARD_MINUTES, read at call time with the same guard as techCostRatesOn.
function jobCostStandardOn() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.jobCostStandardMinutesLive === 'function' && gates.jobCostStandardMinutesLive() === true;
  } catch {
    return false;
  }
}

// The standard on-job minutes for a service type name, or null when none applies.
function standardLaborMinutesFor(serviceType) {
  const name = String(serviceType || '');
  if (JOB_COST_STANDARD.excluded.test(name)) return null;
  const rule = JOB_COST_STANDARD.rules.find((r) => r.pattern.test(name));
  return rule ? rule.minutes : null;
}

// The drive cost of one stop with no cost card: gate on, the Average Drive Time at the loaded labor rate
// (20 minutes at $35 = $11.67); gate off, company_financials.drive_cost_per_stop as today.
function standardStopDriveCost({ standardOn, laborRate, driveCostPerStop }) {
  return standardOn ? (standardDriveMinutes() / 60) * laborRate : driveCostPerStop;
}

// The Average Drive Time (pricing_config global_drive_time) in minutes, read at call time.
function standardDriveMinutes() {
  try {
    const value = Number(require('./pricing-engine/constants').GLOBAL.DRIVE_TIME);
    return Number.isFinite(value) && value >= 0 ? value : JOB_COST_STANDARD.defaultDriveMinutes;
  } catch {
    return JOB_COST_STANDARD.defaultDriveMinutes;
  }
}

// visit_gps_legs is created by the trip-link change and may not exist yet. The
// check is one information_schema read (safe inside a transaction, it never
// errors on a missing table). "Exists" is cached for the life of the process;
// "missing" is cached for a minute, so costing does not re-ask for every visit
// and the first deploy after that migration starts using legs without a restart.
const GPS_LEGS_MISSING_RECHECK_MS = 60 * 1000;
let visitGpsLegsTableKnown = false;
let visitGpsLegsMissingAt = 0;
async function visitGpsLegsTableExists(db) {
  if (visitGpsLegsTableKnown) return true;
  if (visitGpsLegsMissingAt && Date.now() - visitGpsLegsMissingAt < GPS_LEGS_MISSING_RECHECK_MS) return false;
  try {
    visitGpsLegsTableKnown = !!(await db.schema.hasTable('visit_gps_legs'));
  } catch {
    visitGpsLegsTableKnown = false;
  }
  visitGpsLegsMissingAt = visitGpsLegsTableKnown ? 0 : Date.now();
  return visitGpsLegsTableKnown;
}

// The two charged-minutes columns on job_costs (L11b). Read per call, like the service_records columns:
// a database or a mock without them gets today's row object, keys and all.
async function chargedMinuteColumns(db) {
  try {
    const info = await db('job_costs').columnInfo();
    return {
      onJob: !!(info && info.charged_on_job_minutes),
      drive: !!(info && info.charged_drive_minutes),
    };
  } catch {
    return { onJob: false, drive: false };
  }
}

// The drive one visit is charged (GATE_TECH_COST_RATES). None for a visit
// that is not completed (it has driven nowhere) or that does not own the
// stop's drive (`ownsDriveCost`, the combined-closeout owner rule
// drive_cost_per_stop follows). Else its matched GPS leg when there is one,
// else the measured per-stop defaults; a matched leg with no miles (a trip
// without a mileage log) takes the default miles, no minutes the default
// minutes. A stop that served several physical visits (one parking spot,
// shared_stop_count N) splits its drive N ways. The members of one grouped
// visit share one leg (one leg_group_key): with no closeout marker
// (`marked` false) only the lowest service id of the group carries it.
async function loadDriveLeg(db, svc, { ownsDriveCost, marked }) {
  const none = { minutes: 0, miles: 0, source: 'none' };
  if (!ownsDriveCost || svc.status !== 'completed') return none;
  const fallback = { minutes: DEFAULT_DRIVE_MINUTES_PER_STOP, miles: DEFAULT_DRIVE_MILES_PER_STOP, source: 'default' };
  try {
    if (!(await visitGpsLegsTableExists(db))) return fallback;
    const leg = await db('visit_gps_legs')
      .where({ scheduled_service_id: svc.id, status: 'matched' })
      .first('drive_minutes', 'drive_miles', 'shared_stop_count', 'leg_group_key');
    if (!leg) return fallback;
    if (!marked && String(leg.leg_group_key) !== String(svc.id)) {
      const first = await db('visit_gps_legs')
        .where({ leg_group_key: leg.leg_group_key, status: 'matched' })
        .orderBy('scheduled_service_id')
        .first('scheduled_service_id');
      if (String(first.scheduled_service_id) !== String(svc.id)) return { ...none, source: 'group_member' };
    }
    const minutes = leg.drive_minutes == null ? NaN : Number(leg.drive_minutes);
    const miles = leg.drive_miles == null ? NaN : Number(leg.drive_miles);
    const sharedBy = Math.max(1, Math.floor(Number(leg.shared_stop_count)) || 1);
    return {
      minutes: (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_DRIVE_MINUTES_PER_STOP) / sharedBy,
      miles: (Number.isFinite(miles) && miles >= 0 ? miles : DEFAULT_DRIVE_MILES_PER_STOP) / sharedBy,
      source: 'gps_leg',
    };
  } catch {
    return fallback;
  }
}

/**
 * deriveRevenue — the per-visit revenue, mirroring the completion handler's
 * `invoiceAmount` (admin-dispatch.js): an explicit visit price wins, else a
 * recurring customer's monthly_rate, else $0. Free visits NEVER fall back to
 * monthly_rate — only an operator-set positive price gives them revenue. Two
 * kinds are free: callbacks/re-services, and INCLUDED follow-ups, which the
 * scheduler creates with estimated_price=0 + followup_included=true and which
 * the completion handler's shouldInvoice gate skips (admin-dispatch.js) — their
 * revenue was already booked on the originating visit, so attributing a full
 * monthly_rate here would double-count. A revenue already written on the record
 * short-circuits so the live recompute stays idempotent — EXCEPT under
 * ignoreExistingRevenue (the backfill mode): historical records were never
 * written by completion, so any existing positive revenue on them is a stale
 * synthetic seed (migration 20260401000027 seeded random revenue), and the
 * backfill must re-derive from the scheduled-service/customer truth rather than
 * compute cost/margin around a fake number. Pure (no I/O), unit-testable.
 */
function deriveRevenue({
  serviceRecord, scheduledService, customer, ignoreExistingRevenue = false, keepRecordedRevenue = false,
} = {}) {
  // A cost-only re-run (keepRecordedRevenue) keeps whatever revenue is already
  // written, $0 included: the positive-only short-circuit below would re-derive
  // a recorded $0 from today's price or plan and rewrite historical revenue.
  if (keepRecordedRevenue && serviceRecord?.revenue != null) {
    const recorded = Number(serviceRecord.revenue);
    if (Number.isFinite(recorded) && recorded >= 0) return round2(recorded);
  }
  if (!ignoreExistingRevenue) {
    const recordRevenue = Number(serviceRecord?.revenue);
    if (Number.isFinite(recordRevenue) && recordRevenue > 0) return round2(recordRevenue);
  }

  // Always-free visit TYPES (re-service / follow-up / appointment / estimate) and
  // included follow-ups are $0 even with a stale/inherited positive
  // estimated_price — the shared no-cost classifier (no-cost-visit-types.js) and
  // the dispatch auto-invoice gate (admin-dispatch.js) both refuse to bill them.
  // So this MUST precede the explicit-price check.
  const serviceType = scheduledService?.service_type || serviceRecord?.service_type;
  if (scheduledService?.followup_included === true || isAlwaysFreeServiceType(serviceType)) {
    return 0;
  }

  const visitPrice = Number(scheduledService?.estimated_price);
  if (Number.isFinite(visitPrice) && visitPrice > 0) return round2(visitPrice);

  // An unpriced consultation (Waves Assessment) bills nothing, so it books $0
  // — never the monthly_rate fallback below (completionInvoiceAmount).
  if (isConsultationServiceType(serviceType)) return 0;

  // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): a stamped 0 (as
  // opposed to a genuinely blank row) records $0 revenue, never the
  // monthly_rate fallback below — same predicate the completion resolver
  // uses (completionInvoiceAmount). Guarded explicitly by the live gate
  // (not just the predicate's own internal check) because this function
  // never consulted the predicate at all before, so it must stay
  // byte-identical while the gate is off.
  if (stampedZeroFreeLive()
    && hasAuthoritativeZeroPrice(scheduledService?.estimated_price, scheduledService?.primary_line_price)) {
    return 0;
  }

  // A callback is free unless the operator set an explicit price (handled above).
  // Detect it from EITHER side: the callback backfill (20260618000002) flags
  // completed re-services on service_records.is_callback but leaves the terminal
  // scheduled_services row false, so checking only the scheduled_service would
  // book a full monthly rate for historical free re-services.
  const isCallback = !!scheduledService?.is_callback || serviceRecord?.is_callback === true;
  const monthly = Number(customer?.monthly_rate);
  if (!isCallback && Number.isFinite(monthly) && monthly > 0) return round2(monthly);

  return 0;
}

function positiveMoney(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function isCallbackVisit(svc, rec) {
  return !!svc.is_callback || rec.is_callback === true;
}

// A stamped zero price (GATE_STAMPED_ZERO_FREE, billing-lane.js): the visit bills nothing.
function isStampedZeroVisit(svc) {
  return stampedZeroFreeLive() && hasAuthoritativeZeroPrice(svc.estimated_price, svc.primary_line_price);
}

// GATE_JOB_COST_STANDARD_MINUTES revenue (owner ruling 2026-10-31). Order:
//   1. a recorded revenue above $0 is kept under keepRecordedRevenue; a recorded $0 falls through to the
//      visit's OWN sources below, never to customers.monthly_rate (today's plan, not this visit's);
//   2. always-free types and included follow-ups are $0, then the explicit visit price, then an unpriced
//      consultation or a callback is $0 (today's order);
//   3. the visit's share of its paid annual-prepay term, BEFORE the stamped-zero rule because covered
//      visits carry estimated_price 0; then its linked invoice's service lines;
//   4. a stamped zero is $0; the monthly_rate fallback runs only when nothing recorded is being kept.
// Pure (no I/O): ownRevenue = { prepayShare, invoiceTotal } is loaded by loadOwnRevenueSources.
function deriveRevenueFromOwnSources({
  serviceRecord, scheduledService, customer, ignoreExistingRevenue, keepRecordedRevenue, ownRevenue,
}) {
  const rec = serviceRecord || {};
  const svc = scheduledService || {};
  const recorded = positiveMoney(rec.revenue);
  if (recorded != null && (keepRecordedRevenue || !ignoreExistingRevenue)) return recorded;

  const serviceType = svc.service_type || rec.service_type;
  if (svc.followup_included === true || isAlwaysFreeServiceType(serviceType)) return 0;
  const visitPrice = positiveMoney(svc.estimated_price);
  if (visitPrice != null) return visitPrice;
  if (isConsultationServiceType(serviceType) || isCallbackVisit(svc, rec)) return 0;

  const ownMoney = positiveMoney(ownRevenue.prepayShare) ?? positiveMoney(ownRevenue.invoiceTotal);
  if (ownMoney != null) return ownMoney;
  if (isStampedZeroVisit(svc)) return 0;
  return (keepRecordedRevenue ? null : positiveMoney(customer?.monthly_rate)) ?? 0;
}

// GATE_JOB_COST_STANDARD_MINUTES: with the visit's own revenue sources loaded (loadOwnRevenueSources), the
// standard rules; without them (null), today's deriveRevenue, untouched.
function deriveVisitRevenue(args) {
  return args.ownRevenue ? deriveRevenueFromOwnSources(args) : deriveRevenue(args);
}

// Is this annual-prepay term paid? Live statuses are. A payment_pending or decided term (renewed,
// switch_plan, or a decided lapse riding out its paid window) counts once its prepay invoice is collected;
// a decided term with no linked invoice is legacy and keeps its covered meaning (coveredTermsAsOf,
// annual-prepay-renewals.js:4016). Cancelled-without-decision, refunded and the rest are not paid.
async function prepayTermIsPaid(db, term) {
  const status = String(term.status || '').toLowerCase();
  if (PREPAY_LIVE_TERM_STATUSES.includes(status)) return true;
  const decided = PREPAY_DECIDED_TERM_STATUSES.includes(status)
    || (status === 'cancelled' && term.renewal_decision === 'cancel');
  if (status !== 'payment_pending' && !decided) return false;
  if (!term.prepay_invoice_id) return decided;
  const invoice = await db('invoices').where({ id: term.prepay_invoice_id }).first('status', 'paid_at');
  return !!invoice && (PREPAY_INVOICE_COLLECTED_STATUSES.includes(String(invoice.status || '').toLowerCase())
    || !!invoice.paid_at);
}

// The visit's share of its paid annual-prepay term: prepay_amount over the larger of the term's covered visit
// count (coverage_visit_count) and its linked visits that still count. Visits not yet scheduled keep their
// share, and the linked visits together never book more than the prepayment.
async function loadPrepayVisitShare(db, svc) {
  if (!svc.annual_prepay_term_id) return 0;
  try {
    const term = await db('annual_prepay_terms').where({ id: svc.annual_prepay_term_id }).first();
    if (!term || !(Number(term.prepay_amount) > 0) || !(await prepayTermIsPaid(db, term))) return 0;
    const counted = await db('scheduled_services')
      .where({ annual_prepay_term_id: term.id })
      .whereNotIn('status', PREPAY_UNCOUNTED_VISIT_STATUSES)
      .count({ c: '*' })
      .first();
    const visits = Math.max(Number(counted?.c) || 0, Number.parseInt(term.coverage_visit_count, 10) || 0);
    return visits >= 1 ? round2(Number(term.prepay_amount) / visits) : 0;
  } catch (err) {
    logger.debug(`[job-costing] prepay share error: ${err.message}`);
    return 0;
  }
}

// The service money on one invoice's line_items (jsonb array of { description, quantity, unit_price, amount,
// category }, written by invoice.js): amount, else unit_price x quantity (the same reading
// estimate-first-application-invoice.js sumPositiveSetupFeeCents uses), minus setup, membership and
// onboarding fee lines and tax. Tax also lives in invoices.tax_amount, never in the lines.
function serviceLineTotal(rawLineItems) {
  let items = rawLineItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, li) => {
    if (INVOICE_NON_SERVICE_LINE_RE.test(`${li?.description || ''} ${li?.category || ''}`)) return sum;
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amount = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

// The newest non-void invoice written for this visit's service record: its service lines. A prepay invoice
// (annual_prepay_term_id set) bills the whole term, not this visit: its share comes from loadPrepayVisitShare.
async function loadLinkedInvoiceTotal(db, record) {
  if (!record?.id) return 0;
  try {
    const invoice = await db('invoices')
      .where({ service_record_id: record.id })
      .whereNotIn('status', INVOICE_NO_REVENUE_STATUSES)
      .whereNull('annual_prepay_term_id')
      .orderBy('created_at', 'desc')
      .first('line_items');
    return invoice ? round2(serviceLineTotal(invoice.line_items)) : 0;
  } catch (err) {
    logger.debug(`[job-costing] linked invoice error: ${err.message}`);
    return 0;
  }
}

// GATE_JOB_COST_STANDARD_MINUTES: the visit's own revenue sources for deriveRevenue, or null when the gate is
// off or the visit is intentionally free (its revenue is $0 whatever the sources say).
async function standardRevenueSources(db, svc, record, {
  standardOn, intentionallyFree, keepRecordedRevenue, recomputeRevenue,
}) {
  if (!standardOn || intentionallyFree) return null;
  const recordedWins = Number(record?.revenue) > 0 && (keepRecordedRevenue || !recomputeRevenue);
  return loadOwnRevenueSources(db, svc, record, { recordedWins });
}

// Only the sources the revenue rules can still reach: a visit with its own price, a recorded revenue above
// $0 under keep mode, or a free type never needs the two queries.
async function loadOwnRevenueSources(db, svc, record, { recordedWins = false } = {}) {
  const visitPrice = Number(svc.estimated_price);
  if (recordedWins || (Number.isFinite(visitPrice) && visitPrice > 0)) return { prepayShare: 0, invoiceTotal: 0 };
  const prepayShare = await loadPrepayVisitShare(db, svc);
  const invoiceTotal = prepayShare > 0 ? 0 : await loadLinkedInvoiceTotal(db, record);
  return { prepayShare, invoiceTotal };
}

/**
 * computeServiceRecordFinancials — pure roll-up of a visit's costs into the
 * derived fields the dashboard reads. margin and rpmh are null (not 0) when
 * revenue or labor is absent, so "no data" stays distinct from "zero". Pure so
 * it is unit-testable.
 */
function computeServiceRecordFinancials({
  revenue = 0,
  laborHours = 0,
  laborCost = 0,
  productsCost = 0,
  driveCost = 0,
  expensesCost = 0,
} = {}) {
  const rev = round2(revenue);
  const matCost = round2(productsCost);
  const labHours = round2(laborHours);
  const labCost = round2(laborCost);
  const drvCost = round2(driveCost);
  const totalCost = round2(labCost + matCost + drvCost + (Number(expensesCost) || 0));
  const grossProfit = round2(rev - totalCost);
  const marginPct = rev > 0 ? round2((grossProfit / rev) * 100) : null;
  const rpmh = labHours > 0 ? round2(rev / labHours) : null;
  return {
    revenue: rev,
    material_cost: matCost,
    labor_hours: labHours,
    labor_cost: labCost,
    drive_cost: drvCost,
    total_job_cost: totalCost,
    gross_profit: grossProfit,
    gross_margin_pct: marginPct,
    revenue_per_man_hour: rpmh,
  };
}

async function calcLaborCost(db, scheduledServiceId, technicianId, startTime, endTime, rate, {
  untrustedLifecycleSpan = false,
  explicitLaborMinutes = null,
  overrideLaborMinutes = null,
  allocatedLaborMinutes,
  estimatedLaborMinutes = null,
} = {}) {
  let minutes = 0;
  const hasAllocatedLabor = allocatedLaborMinutes !== undefined;
  // Authoritative operator correction (admin time-on-site edit): wins over
  // EVERY derived source, including the direct job time entries below — a
  // visit whose closeout was forgotten usually has a forgotten clock-out
  // too, so the linked entry carries the same inflated span the operator
  // just corrected. explicitLaborMinutes stays weaker on purpose (backfill
  // semantics unchanged: a real clock entry still beats a typed backfill
  // duration there).
  {
    const override = Number(overrideLaborMinutes);
    if (Number.isFinite(override) && override > 0) minutes = Math.round(override);
  }
  // A grouped packet allocation is authoritative over per-job clocks and
  // lifecycle spans: those clocks/stamps describe the shared physical stop.
  // Null means the packet had no trustworthy start and therefore contributes
  // zero cost without claiming a measured duration; integer zero is the real
  // rounded allocation. A later admin correction above still wins.
  if (!minutes && hasAllocatedLabor) {
    const allocated = Number(allocatedLaborMinutes);
    minutes = Number.isInteger(allocated) && allocated >= 0 ? allocated : 0;
  }
  try {
    // Prefer the JOB time entries tied directly to this visit. time_entries.job_id
    // IS the scheduled_services id (see time-tracking.js), so this attributes
    // exactly. entry_type='job' excludes the shift/break/drive/admin_time clocks
    // (a shift row spans the whole workday) and voided rows are dropped — the
    // same scoping every other time-tracking consumer uses.
    if (!minutes && !hasAllocatedLabor && scheduledServiceId) {
      const jobEntries = await db('time_entries')
        .where({ job_id: scheduledServiceId, entry_type: 'job' })
        .whereNot('status', 'voided')
        .select('duration_minutes');
      minutes = jobEntries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
    }
    // Else fall back to job entries overlapping the ACTUAL visit window — only
    // when both real bounds exist AND the bounds are trusted. Never a Date.now()
    // window: during the one-time backfill that would scoop up whatever a tech
    // is clocked into at deploy time and mis-attribute it to an old visit.
    if (!minutes && !hasAllocatedLabor && !untrustedLifecycleSpan && technicianId && startTime && endTime) {
      const entries = await db('time_entries')
        .where({ technician_id: technicianId, entry_type: 'job' })
        .whereNot('status', 'voided')
        .whereBetween('clock_in', [
          new Date(new Date(startTime).getTime() - 15 * 60000),
          new Date(new Date(endTime).getTime() + 15 * 60000),
        ])
        .select('duration_minutes');
      minutes = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
    }
  } catch { /* table may be absent */ }

  // Untrusted span (a backdated stale-visit closeout: start = a check-in from
  // days/weeks ago, end = today's office checkout): both the clock-in-window
  // query above and the span math below would fabricate that whole gap as
  // labor, so only the caller's explicit operator-entered minutes count.
  // Absent them, only the scheduled estimate below can apply — never the span.
  if (!minutes && !hasAllocatedLabor && untrustedLifecycleSpan) {
    const explicit = Number(explicitLaborMinutes);
    if (Number.isFinite(explicit) && explicit > 0) minutes = Math.round(explicit);
  }
  // Measured fallback: the actual_start/end span on the scheduled_service.
  if (!minutes && !hasAllocatedLabor && !untrustedLifecycleSpan && startTime && endTime) {
    minutes = Math.max(0, Math.round((new Date(endTime) - new Date(startTime)) / 60000));
  }
  // Last resort, passed only for a COMPLETED visit: its scheduled duration
  // (estimated_duration_minutes) when no source above measured any time — a
  // backdated closeout with no typed time on site, or a close with no start
  // stamp. Booking 0 h there read real visits as free labor and idle time:
  // from late September most closes went that way, so Gross Margin and Tech
  // Utilization drifted far from the truth. A grouped allocation keeps its own
  // answer (its null means "no trustworthy start" for the whole packet).
  let laborEstimated = false;
  if (!minutes && !hasAllocatedLabor) {
    const estimated = Number(estimatedLaborMinutes);
    if (Number.isFinite(estimated) && estimated > 0) {
      minutes = Math.round(estimated);
      laborEstimated = true;
    }
  }

  const hours = minutes / 60;
  return { laborMinutes: minutes, laborHours: hours, laborCost: round2(hours * rate), laborEstimated };
}

// GATE_JOB_COST_STANDARD_MINUTES labor (owner ruling 2026-10-31), applied to the measured result of
// calcLaborCost. Gate off: the measured result, unchanged. Gate on, in order: an admin time-on-site correction
// (overrideLaborMinutes, resolved by the caller) wins; else the standard for the service type of a completed
// visit, which replaces measured time, time entries, backfill minutes and a combined-closeout allocation; else
// the measured result, where one over the stale-span limit books the scheduled estimate (else 0). Pure: no I/O.
function applyStandardLabor(measured, {
  standardOn, svc, rate, overrideLaborMinutes, estimatedLaborMinutes,
}) {
  if (!standardOn) return measured;
  const override = Number(overrideLaborMinutes);
  if (Number.isFinite(override) && override > 0) return measured;
  const priced = (minutes, laborEstimated) => ({
    laborMinutes: minutes, laborHours: minutes / 60, laborCost: round2((minutes / 60) * rate), laborEstimated,
  });
  const standard = svc.status === 'completed' ? standardLaborMinutesFor(svc.service_type) : null;
  if (standard != null) return priced(standard, false);
  if (measured.laborMinutes <= JOB_COST_STANDARD.staleSpanMinutes) return measured;
  const estimated = Math.round(Number(estimatedLaborMinutes)) || 0;
  logger.warn(`[job-costing] ${svc.id} — measured span over ${JOB_COST_STANDARD.staleSpanMinutes} minutes; costing the scheduled estimate`);
  return priced(estimated, estimated > 0);
}

async function calcProductsCost(db, serviceRecordId) {
  let total = 0;
  const breakdown = [];
  const costedInventoryProductIds = new Set();
  try {
    const movementRows = await db('product_inventory_movements as pim')
      .leftJoin('products_catalog as pc', 'pim.product_id', 'pc.id')
      .where({ service_record_id: serviceRecordId, movement_type: 'usage' })
      .select(
        'pim.product_id',
        'pim.quantity',
        'pim.unit',
        'pim.unit_cost',
        'pim.cost_used',
        'pim.stock_after',
        'pc.name as product_name',
      );
    for (const r of movementRows) {
      const line = Number(r.cost_used);
      if (!Number.isFinite(line)) continue;
      total += line;
      if (r.product_id) costedInventoryProductIds.add(r.product_id);
      breakdown.push({
        product_id: r.product_id,
        product_name: r.product_name,
        qty: Number(r.quantity) || 0,
        unit: r.unit,
        unit_cost: r.unit_cost != null ? Number(r.unit_cost) : null,
        line,
        stock_after: r.stock_after != null ? Number(r.stock_after) : null,
        source: 'inventory_movement',
      });
    }
  } catch (err) {
    logger.debug(`[job-costing] inventory movement cost error: ${err.message}`);
  }

  try {
    const rows = await db('property_application_history')
      .where({ service_record_id: serviceRecordId })
      // Retracted applications (recap corrections) carry no material cost.
      .whereNull('retracted_at')
      .select('product_id', 'quantity_applied', 'quantity_unit');

    for (const r of rows) {
      const qty = Number(r.quantity_applied) || 0;
      if (!qty || !r.product_id) continue;
      if (costedInventoryProductIds.has(r.product_id)) continue;

      // Price the amount the way the completion deduction prices an inventory
      // movement (inventory-cost.js): cost_per_unit in its own unit, else the
      // amount's share of one best_price package of unit_size_oz. This loop
      // used to multiply the amount straight by cost_per_unit or by the
      // cheapest vendor_pricing.price — a PACKAGE price — so 31.5 fl oz from a
      // $38.05 2.5-gal jug booked $1,198.57 instead of about $3.83.
      const amountUnit = baseQuantityUnit(r.quantity_unit);
      const prod = await db('products_catalog').where({ id: r.product_id }).first();
      const inventoryUnit = prod?.inventory_unit || amountUnit;
      // best_price is the catalog's per-package winner across vendor rows
      // (recalcBestPrice in admin-inventory.js, lowest $/oz per the owner's
      // 2026-09-30 ruling), so vendor_pricing is not read again here. A product
      // with no catalog price, or an amount no rule can convert, stays uncosted
      // rather than fabricated.
      const { unitCost, costUsed } = calculateInventoryCost({
        product: prod,
        deductedAmount: convertInventoryQuantity(qty, amountUnit, inventoryUnit),
        inventoryUnit,
        amount: qty,
        amountUnit,
      });
      if (costUsed != null) {
        const line = round2(costUsed);
        total += line;
        breakdown.push({ product_id: r.product_id, qty, unit: r.quantity_unit, unit_cost: unitCost, line });
      }
    }
  } catch (err) {
    logger.debug(`[job-costing] products cost error: ${err.message}`);
  }
  return { productsCost: round2(total), breakdown };
}

async function calcExpenses(db, scheduledServiceId) {
  try {
    const rows = await db('expenses')
      .where({ scheduled_service_id: scheduledServiceId })
      .select('amount');
    return rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  } catch { return 0; }
}

/**
 * Resolve the canonical service_record for a scheduled_service. Prefers the
 * direct scheduled_service_id FK (added in 20260427000007) — an unambiguous
 * 1:1 link — over the legacy (customer_id, service_date, service_type) soft-join.
 *
 * Returns { record, viaFk, ambiguous }. The soft-join is `ambiguous` when the
 * tuple maps to more than one service_record OR more than one completed
 * scheduled_service: every such visit would collapse onto the single newest
 * record and clobber each other's financials, leaving the rest blank. The
 * write-through is skipped (logged) for ambiguous matches rather than corrupt
 * them — completion-created records carry the FK, so this only affects pre-FK
 * legacy history during the backfill.
 */
async function resolveServiceRecord(db, svc, srCols) {
  if (srCols.scheduled_service_id) {
    const byFk = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first();
    if (byFk) return { record: byFk, viaFk: true, ambiguous: false };
  }
  const records = await db('service_records')
    .where({ customer_id: svc.customer_id, service_date: svc.scheduled_date, service_type: svc.service_type })
    .orderBy('created_at', 'desc')
    .limit(2);
  const record = records[0] || null;
  let ambiguous = records.length > 1;
  if (record && !ambiguous) {
    const dupServices = await db('scheduled_services')
      .where({
        customer_id: svc.customer_id,
        scheduled_date: svc.scheduled_date,
        service_type: svc.service_type,
        status: 'completed',
      })
      .count({ c: '*' })
      .first();
    if (Number(dupServices?.c) > 1) ambiguous = true;
  }
  return { record, viaFk: false, ambiguous };
}

// Stable comparison key for the canonical record and the persisted allocation
// fields that control drive cost. Array positions avoid depending on JSON object
// key order when historic structured_notes arrive as serialized text.
function serviceRecordDriveAllocationStamp({ record, ambiguous }) {
  const canonicalRecord = ambiguous ? null : record;
  const allocation = parseJsonObject(canonicalRecord?.structured_notes).visitDriveCostAllocation;
  return JSON.stringify([
    ambiguous,
    canonicalRecord?.id ?? null,
    allocation?.version ?? null,
    allocation?.packetId ?? null,
    allocation?.ownerServiceId ?? null,
  ]);
}

/**
 * calculateJobCost(scheduledServiceId, db?, opts?)
 * Upserts a job_costs row AND writes the financials through to service_records.
 * Returns the computed cost object. Pass `db` to run on a specific knex handle
 * (e.g. a migration's); omit it to use the app db singleton. opts.recomputeRevenue
 * (backfill-only) re-derives revenue from source instead of preserving any
 * existing — possibly stale-seeded — service_records.revenue;
 * opts.keepRecordedRevenue (a cost-only re-run) keeps any written revenue,
 * $0 included.
 * opts.untrustedLifecycleSpan (backdated quiet closeouts) blocks the labor
 * fallbacks that derive from the row's actual_start/actual_end bounds — see
 * calcLaborCost; opts.explicitLaborMinutes supplies the operator-entered
 * duration to use instead. Both are ALSO re-derived automatically from the
 * record's persisted structured_notes.backfill marker (and the persisted
 * scheduled_services.service_time_minutes), so recalculations that pass no
 * opts can never resurrect the fabricated span. opts.overrideLaborMinutes
 * (admin time-on-site correction) outranks every derived source including
 * direct job time entries, and is likewise re-derived from the durable
 * structured_notes.timeOnSiteAdjusted marker on no-opts recalculations.
 */
async function calculateJobCost(scheduledServiceId, db, {
  recomputeRevenue = false,
  keepRecordedRevenue = false,
  untrustedLifecycleSpan = false,
  explicitLaborMinutes = null,
  overrideLaborMinutes = null,
  allocatedLaborMinutes,
} = {}) {
  db = resolveDb(db);
  if (!scheduledServiceId) throw new Error('scheduledServiceId required');

  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svc) throw new Error(`scheduled_service ${scheduledServiceId} not found`);

  const srCols = await db('service_records').columnInfo().catch(() => ({}));
  const { record: resolvedRecord, ambiguous } = await resolveServiceRecord(db, svc, srCols);
  // An ambiguous legacy soft-join match contributes NOTHING (codex P2 #3152
  // round 6): the newest of several same-customer/date/type records is an
  // arbitrary pick, and using its revenue/products would attach another
  // visit's financials to this row's job_costs — the same corruption the
  // service_records write-through guard below has always refused. Costing
  // proceeds as a record-less visit: revenue derives from the scheduled
  // service/customer, products contribute nothing, and job_costs carries no
  // service_record_id.
  const record = ambiguous ? null : resolvedRecord;
  if (ambiguous) {
    logger.warn(
      `[job-costing] ${scheduledServiceId} — ambiguous legacy service_record match `
      + '(same customer/date/type duplicates); costing proceeds record-less',
    );
  }
  const customer = await db('customers').where({ id: svc.customer_id }).first();

  // Durable untrusted-span policy: the backfill closeout route passes
  // untrustedLifecycleSpan for its completion-time calc, but every LATER
  // recalculation — admin-job-costs manual recalc, admin-job-expenses CRUD
  // refresh, admin-billing-recovery recompute, admin-projects costing,
  // backfillServiceRecordFinancials — calls with no opts and would fall back
  // to the record's actual_start→closeout span (a stale check-in weeks back
  // against the office checkout, booked at the labor rate) and overwrite the
  // completion-time financials. The completion freezes `backfill: true` into
  // the record's structured_notes (its crash-resume marker), so re-derive the
  // policy from that persisted marker here — the one layer every caller flows
  // through. Labor then comes only from direct job time entries, else the
  // persisted operator-entered duration (scheduled_services.service_time_minutes,
  // which applyBackfillDurationPolicy writes from the explicit timeOnSite or
  // not at all under backfill), else the completed visit's scheduled estimate
  // (estimated_duration_minutes), else 0. The caller option remains honored for
  // any calc made before the completion's record row is committed/visible
  // (belt and braces); caller-supplied explicit minutes win over the column.
  const recordNotes = parseJsonObject(record?.structured_notes);
  if (recordNotes.backfill === true) {
    untrustedLifecycleSpan = true;
  }
  if (untrustedLifecycleSpan && explicitLaborMinutes == null) {
    const persistedMinutes = Number(svc.service_time_minutes);
    if (Number.isFinite(persistedMinutes) && persistedMinutes > 0) {
      explicitLaborMinutes = persistedMinutes;
    }
  }
  // Same durable-policy shape for the admin time-on-site correction (codex
  // P1 #3152): the edit/live-override stamps `timeOnSiteAdjusted: true`
  // beside the corrected duration, and every no-opts recalculation must book
  // labor from that corrected value — NOT from a linked job time entry,
  // which carries the same forgotten-clock-out inflation the operator just
  // corrected (overrideLaborMinutes outranks entries in calcLaborCost;
  // explicitLaborMinutes deliberately does not, so backfill keeps its
  // entries-win behavior).
  if (recordNotes.timeOnSiteAdjusted === true && overrideLaborMinutes == null) {
    const correctedMinutes = Number(svc.service_time_minutes);
    if (Number.isFinite(correctedMinutes) && correctedMinutes > 0) {
      overrideLaborMinutes = correctedMinutes;
    }
  }
  // Second durable home for the same marker (codex P2 #3152 round 5): a
  // corrected visit with NO resolvable record (missing/ambiguous legacy
  // rows) can't carry the structured_notes marker at all, so the correction
  // endpoint stamps scheduled_services.time_on_site_adjusted_minutes — read
  // here off the row already in hand, no extra query. Redundant with the
  // record marker when both exist; the caller's explicit option still wins.
  if (overrideLaborMinutes == null) {
    const stampedMinutes = Number(svc.time_on_site_adjusted_minutes);
    if (Number.isFinite(stampedMinutes) && stampedMinutes > 0) {
      overrideLaborMinutes = stampedMinutes;
    }
  }
  // New combined-closeout records freeze their share of the visit duration
  // beside the record. Re-derive it on every no-options recalculation so a
  // linked shared-stop timer or the truthful shared timestamp span cannot
  // replace the allocation. A later authorized correction wins through the
  // durable correction stamp resolved above.
  if (allocatedLaborMinutes === undefined && recordNotes.visitDurationAllocation?.version === 1) {
    const frozen = recordNotes.visitDurationAllocation.allocatedMinutes;
    allocatedLaborMinutes = Number.isInteger(frozen) && frozen >= 0 ? frozen : null;
  }

  // An operator can dispose a completed visit as intentionally_free in the
  // Billing Recovery workbench (visit_billing_dispositions). That decision is
  // authoritative — never let a derived estimated_price/monthly_rate put revenue
  // on a visit a human marked no-cost. (disposition='billed' keeps the derived
  // value, which approximates the invoice the operator cut.)
  let intentionallyFree = false;
  try {
    const disposition = await db('visit_billing_dispositions')
      .where({ scheduled_service_id: scheduledServiceId })
      .first();
    intentionallyFree = disposition?.disposition === 'intentionally_free';
  } catch { /* table may be absent before 20260619000001 */ }

  const { laborRate, driveCostPerStop } = await getFinancials(db, svc.scheduled_date);
  // GATE_JOB_COST_STANDARD_MINUTES, read once for this call: standard labor minutes, the standard drive
  // cost and the visit's own revenue sources. Off = today's path below, untouched.
  const standardOn = jobCostStandardOn();
  const ownRevenue = await standardRevenueSources(db, svc, record, {
    standardOn, intentionallyFree, keepRecordedRevenue, recomputeRevenue,
  });
  const revenue = intentionallyFree ? 0 : deriveVisitRevenue({
    serviceRecord: record, scheduledService: svc, customer, ignoreExistingRevenue: recomputeRevenue, keepRecordedRevenue, ownRevenue,
  });
  // The scheduled estimate is a last resort for COMPLETED visits only: a
  // pending or future visit costed on an expense entry or a manual recalc has
  // done no work yet and books no labor.
  const estimatedLaborMinutes = svc.status === 'completed'
    ? Number(svc.estimated_duration_minutes) || null
    : null;
  // GATE_TECH_COST_RATES: null unless the gate is on AND the visit's technician
  // has a cost card in effect on the visit date. Null = today's path below.
  // (loadVisitRates answers null for a visit with no technician.)
  const costRates = techCostRatesOn()
    ? await require('./tech-cost-rates').loadVisitRates(db, svc.technician_id, visitDateString(svc.scheduled_date))
    : null;
  const measuredLabor = await calcLaborCost(
    db, scheduledServiceId, svc.technician_id, svc.actual_start_time, svc.actual_end_time, laborRate,
    { untrustedLifecycleSpan, explicitLaborMinutes, overrideLaborMinutes, allocatedLaborMinutes, estimatedLaborMinutes },
  );
  const {
    laborCost: baseLaborCost, laborHours, laborEstimated, laborMinutes,
  } = applyStandardLabor(measuredLabor, {
    standardOn, svc, rate: laborRate, overrideLaborMinutes, estimatedLaborMinutes,
  });
  const { productsCost, breakdown } = record?.id
    ? await calcProductsCost(db, record.id)
    : { productsCost: 0, breakdown: [] };
  const expensesCost = await calcExpenses(db, scheduledServiceId);
  // A versioned combined-closeout marker freezes one drive-cost owner for the
  // physical stop. The owner carries exactly one configured stop cost and all
  // other marked members carry zero on completion and every later recalculation.
  // Unmarked records outside a new packet retain the legacy one-cost-per-visit
  // behavior; same-stop retained reports receive the packet marker at save.
  const driveAllocation = recordNotes.visitDriveCostAllocation;
  const marked = driveAllocation?.version === 1;
  const ownsDriveCost = marked ? svc.id === driveAllocation.ownerServiceId : true;
  let laborCost = baseLaborCost;
  // GATE_JOB_COST_STANDARD_MINUTES: the stop's drive is the Average Drive Time at the loaded labor rate.
  const stopDriveCost = standardStopDriveCost({ standardOn, laborRate, driveCostPerStop });
  let driveCost = ownsDriveCost ? stopDriveCost : 0;
  let costRatesApplied = null;
  // The vehicle fixed cost inside drive_cost (NULL = no cost card applied).
  // service_records keeps it beside drive_cost so the adjusted-EBITDA bridge
  // takes it out of the vehicle overhead (counted once); written with the other
  // financials, so a recalculation without a card clears an earlier share.
  let vehicleFixedCost = null;
  if (costRates) {
    // Each visit's own on-site minutes (its allocated share in a combined
    // closeout) carry the technician's labor and the vehicle's fixed cost; the
    // drive to the stop is charged once per physical stop (loadDriveLeg), so a
    // stop's members add up to the stop's real minutes with nothing counted
    // twice. A card that names no vehicle has zero vehicle rates.
    const driven = await loadDriveLeg(db, svc, { ownsDriveCost, marked });
    const chargedHours = (laborMinutes + driven.minutes) / 60;
    const { vehicle } = costRates;
    laborCost = (costRates.laborPerWorkedHourCents / 100) * chargedHours;
    const fixedPart = (vehicle.fixedPerWorkedHourCents / 100) * chargedHours;
    driveCost = (vehicle.perMileTenThousandths / 10000) * driven.miles + fixedPart;
    vehicleFixedCost = round2(fixedPart);
    costRatesApplied = {
      technicianCardId: costRates.cardId,
      vehicleCardId: vehicle.cardId,
      onJobMinutes: laborMinutes,
      driveMinutes: driven.minutes,
      driveMiles: driven.miles,
      driveSource: driven.source,
      vehicleFixedCost,
    };
  }
  const recordDriveStamp = serviceRecordDriveAllocationStamp({
    record: resolvedRecord,
    ambiguous,
  });

  const fin = computeServiceRecordFinancials({
    revenue, laborHours, laborCost, productsCost, driveCost, expensesCost,
  });

  // 1. job_costs ledger (existing consumers: admin-job-costs, equipment).
  const row = {
    service_record_id: record?.id || null,
    scheduled_service_id: scheduledServiceId,
    technician_id: svc.technician_id,
    customer_id: svc.customer_id,
    service_date: svc.scheduled_date,
    service_type: svc.service_type,
    products_cost: fin.material_cost,
    labor_cost: fin.labor_cost,
    drive_cost: fin.drive_cost,
    equipment_cost: 0,
    total_cost: fin.total_job_cost,
    revenue: fin.revenue,
    gross_profit: fin.gross_profit,
    margin_pct: fin.gross_margin_pct,
    products_used: JSON.stringify(breakdown),
  };
  // L11b: the minutes this cost was charged for, NULL when no cost card applied (a re-cost without a
  // card clears an earlier pair). Only keys whose column exists, so older schemas see today's row.
  const chargedColumns = await chargedMinuteColumns(db);
  if (chargedColumns.onJob) row.charged_on_job_minutes = costRatesApplied ? round2(costRatesApplied.onJobMinutes) : null;
  if (chargedColumns.drive) row.charged_drive_minutes = costRatesApplied ? round2(costRatesApplied.driveMinutes) : null;

  // Correction-stamp fence, ATOMIC with the financial writes (codex P2
  // #3152 rounds 8+9): the durable time_on_site_adjusted_minutes stamp was
  // read ONCE with the svc row, and several async reads ran since — a
  // recalculation that straddled a NEWER correction would land stale labor
  // last. Round 8's standalone re-read still left a window between check
  // and write, so the fence now takes the scheduled_services row lock (FOR
  // UPDATE) in the SAME transaction as both financial writes: a correction
  // commits its stamp through an UPDATE on that row, so it either commits
  // before the lock is granted (fence sees the new stamp → skip) or blocks
  // until these writes commit (its own follow-up recalc then lands the
  // truth). Full-row read on purpose: selecting the column by name would
  // throw in an environment that predates migration 20260801400000, while
  // a missing property compares null === null and proceeds. If the caller
  // passed a transaction handle, this nests as a savepoint.
  let wroteThrough = false;
  let staleSkipped = false;
  await db.transaction(async (trx) => {
    const rowNow = await trx('scheduled_services').where({ id: scheduledServiceId }).forUpdate().first();
    // Completion creates/updates the canonical service record while holding this
    // same scheduled-service lock. Re-resolve through the identical FK/legacy
    // ambiguity path after the lock is granted: a reportless calculation may
    // have started before packet completion, then resumed after the packet's
    // marked non-owner calculation already wrote the correct zero drive cost.
    // Its correction stamps would still match, so record identity + allocation
    // are part of the stale-write fence too.
    const currentResolution = await resolveServiceRecord(trx, rowNow, srCols);
    const currentRecordDriveStamp = serviceRecordDriveAllocationStamp(currentResolution);
    const norm = (v) => (v == null ? null : Number(v));
    // The fence compares the monotonic correction seq as well as the minutes
    // value (codex P2 #3152 round 19): two saves of the SAME minutes are
    // distinct revisions — if the newer save's recalculation (pricing
    // against newer products/expenses state) finishes first, the older run
    // would pass a minutes-only check and land its stale snapshot last.
    // Missing column (pre-migration) compares null === null and proceeds,
    // same as the minutes leg.
    if (norm(rowNow?.time_on_site_adjusted_minutes) !== norm(svc.time_on_site_adjusted_minutes)
      || norm(rowNow?.time_on_site_correction_seq) !== norm(svc.time_on_site_correction_seq)
      || currentRecordDriveStamp !== recordDriveStamp) {
      logger.warn(
        `[job-costing] ${scheduledServiceId} — costing inputs moved during recalculation `
        + `(${norm(svc.time_on_site_adjusted_minutes)} rev ${norm(svc.time_on_site_correction_seq)} → `
        + `${norm(rowNow?.time_on_site_adjusted_minutes)} rev ${norm(rowNow?.time_on_site_correction_seq)}, `
        + `record/drive ${recordDriveStamp} → ${currentRecordDriveStamp}); skipping stale financial writes`,
      );
      staleSkipped = true;
      return;
    }

    const existing = await trx('job_costs').where({ scheduled_service_id: scheduledServiceId }).first();
    if (existing) {
      await trx('job_costs').where({ id: existing.id }).update(row);
    } else {
      await trx('job_costs').insert(row);
    }

    // 2. Write-through to service_records — the table the Dashboard + /admin/revenue
    //    actually read. Each column is guarded by columnInfo so an environment
    //    missing the 20260401000027 financial columns is a no-op, not a crash.
    //    Skipped for ambiguous legacy soft-join matches (multiple same-day visits
    //    collapsing onto one record) — writing would clobber it and blank the rest.
    //    Also skipped when the record itself isn't completed: office-handoff visits
    //    are stored status='incomplete' while their scheduled_service stays
    //    'completed', and the dashboard counts any non-null revenue — an incomplete
    //    visit must not surface revenue/margin.
    // (`ambiguous` here is belt-and-braces — an ambiguous match is already
    // nulled out at resolution above, so it can't reach this write.)
    const recordCompleted = !srCols.status || record?.status === 'completed';
    if (record?.id && !ambiguous && recordCompleted) {
      const upd = {};
      const set = (col, val) => { if (srCols[col]) upd[col] = val; };
      set('revenue', fin.revenue);
      set('material_cost', fin.material_cost);
      set('labor_hours', fin.labor_hours);
      set('labor_cost', fin.labor_cost);
      set('drive_cost', fin.drive_cost);
      set('total_job_cost', fin.total_job_cost);
      set('gross_profit', fin.gross_profit);
      set('gross_margin_pct', fin.gross_margin_pct);
      set('revenue_per_man_hour', fin.revenue_per_man_hour);
      set('vehicle_fixed_cost', vehicleFixedCost);
      if (Object.keys(upd).length) {
        await trx('service_records').where({ id: record.id }).update(upd);
        wroteThrough = true;
      }
    }
  });
  if (staleSkipped) {
    return { ...fin, laborHours: fin.labor_hours, serviceRecordId: null, staleSkipped: true };
  }

  logger.info(
    `[job-costing] ${scheduledServiceId} — revenue $${fin.revenue} cost $${fin.total_job_cost} `
    + `profit $${fin.gross_profit} (${fin.gross_margin_pct ?? '—'}%)`
    + `${laborEstimated ? ' — labor from the scheduled estimate' : ''}`,
  );

  // Bridge the customer's realized revenue/profit/LTV onto their ad-attribution
  // funnel row so /admin/ads ROI views read real numbers. Only on COMPLETION:
  // calculateJobCost also runs for pending/future visits (expense entry, manual
  // recalc), and advancing the funnel + booking revenue for those would mark a
  // lead completed prematurely. Isolated: an attribution failure must never break
  // costing (the costing writes above are committed). The financials backfill
  // drives completed services too, so it keeps attribution in sync as well.
  if (svc.status === 'completed') {
    try {
      const { syncCustomerAdAttribution } = require('./ad-attribution-sync');
      await syncCustomerAdAttribution(svc.customer_id, db);
    } catch (err) {
      logger.warn(`[job-costing] ad-attribution sync failed for ${scheduledServiceId}: ${err.message}`);
    }
  }

  return {
    ...row,
    laborHours: fin.labor_hours,
    serviceRecordId: wroteThrough ? record.id : null,
    costRates: costRatesApplied, // null = today's path (gate off or no card)
  };
}

/**
 * backfillServiceRecordFinancials(db?, { onError, since, keepRecordedRevenue })
 * Recompute costs for every completed scheduled_service that has a
 * service_record and write the financials through. Idempotent. Used by the
 * one-time backfill migration (which passes its own knex) and runnable ad hoc.
 * `since` (YYYY-MM-DD) limits the run to visits on or after that date;
 * keepRecordedRevenue keeps each record's written revenue, $0 included (a
 * re-cost after a costing fix must not re-derive revenue that completion,
 * billing recovery or a refund adjustment already set); without it the run
 * re-derives revenue as the original backfill did.
 */
async function backfillServiceRecordFinancials(db, { onError, since = null, keepRecordedRevenue = false } = {}) {
  db = resolveDb(db);
  const srCols = await db('service_records').columnInfo().catch(() => ({}));
  // Nothing to populate if the financial columns were never added.
  if (!srCols.revenue) return { processed: 0, updated: 0, skipped: 0 };

  // Drive from completed scheduled_services and let calculateJobCost ->
  // resolveServiceRecord attach the right service_record (the scheduled_service_id
  // FK when present, else the legacy customer+date+type soft-join). Driving from
  // service_records.scheduled_service_id alone would SKIP legacy records whose FK
  // was never backfilled — migration 20260427000007 added the column but left
  // older rows NULL — leaving their dashboard/revenue financials blank. We also
  // union in the FK referenced by any completed service_record, so a completed
  // record whose scheduled_service carries a non-completed status is still caught.
  let servicesQuery = db('scheduled_services').where('status', 'completed');
  if (since) servicesQuery = servicesQuery.where('scheduled_date', '>=', since);
  const fromServices = await servicesQuery
    .pluck('id')
    .catch(() => []);
  let fromRecords = [];
  if (srCols.scheduled_service_id) {
    let recordsQuery = db('service_records')
      .whereNotNull('scheduled_service_id')
      .where('status', 'completed');
    if (since) recordsQuery = recordsQuery.where('service_date', '>=', since);
    fromRecords = await recordsQuery
      .distinct('scheduled_service_id')
      .pluck('scheduled_service_id')
      .catch(() => []);
  }
  const ids = [...new Set([...fromServices, ...fromRecords])];

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      // Default: re-derive instead of trusting any existing (possibly
      // synthetic-seeded) service_records.revenue — see deriveRevenue. A
      // costing-fix re-run keeps the written revenue instead.
      const res = await calculateJobCost(
        id, db, keepRecordedRevenue ? { keepRecordedRevenue: true } : { recomputeRevenue: true },
      );
      processed += 1;
      if (res.serviceRecordId) updated += 1;
    } catch (err) {
      skipped += 1;
      if (typeof onError === 'function') onError(id, err);
      logger.warn(`[job-costing] backfill skipped ${id}: ${err.message}`);
    }
  }
  logger.info(`[job-costing] backfill complete — processed ${processed}, updated ${updated}, skipped ${skipped}`);
  return { processed, updated, skipped };
}

module.exports = {
  calculateJobCost,
  calcLaborCost,
  getFinancials,
  calcProductsCost,
  resolveServiceRecord,
  parseJsonObject,
  backfillServiceRecordFinancials,
  deriveRevenue,
  deriveRevenueFromOwnSources,
  computeServiceRecordFinancials,
  JOB_COST_STANDARD,
  standardLaborMinutesFor,
  DEFAULT_DRIVE_MINUTES_PER_STOP,
  DEFAULT_DRIVE_MILES_PER_STOP,
  _resetVisitGpsLegsCache: () => { visitGpsLegsTableKnown = false; visitGpsLegsMissingAt = 0; },
};
