const db = require('../models/db');
const logger = require('./logger');
const { tryLockCustomerComms, withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const AccountMembershipEmail = require('./account-membership-email');

const ACTIVE_STATUSES = ['active', 'renewal_pending'];
// Decided coverage: the renewal decision is recorded but the paid window still
// runs. Covered ONLY while the prepay invoice is actually paid — see the
// decidedCoveredAndPaid branch in coveredTermsAsOf.
const DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const CUSTOMER_NOTICE_DAYS = [30, 15, 7];
// Days BEFORE term_start the unpaid-prepay payment reminder fires (daily cron
// granularity: 3 days out and the day before the first visit).
const PAYMENT_REMINDER_DAYS = [3, 1];
const DEFAULT_ALERT_DAYS = 30;
const LAST_SERVICE_GRACE_DAYS = 14;
const LAST_SERVICE_TERM_END_LOOKBACK_DAYS = 120;
const NOTICE_CLAIM_TTL_MS = 15 * 60 * 1000;
// prepaid_method written when annual-prepay coverage stamps a visit. Stamp
// cleanup filters on this so it never clears an independent cash/Zelle/etc.
// prepayment made through the regular schedule prepay route.
const ANNUAL_PREPAY_PREPAID_METHOD = 'annual_prepay_invoice';
const INVOICE_CANCELLED_STATUSES = new Set(['void', 'cancelled', 'canceled', 'refunded']);
const COVERAGE_EXCLUDED_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled']);
const PREPAID_UPDATE_EXCLUDED_STATUSES = new Set([...COVERAGE_EXCLUDED_STATUSES, 'completed']);

let tableExistsCache = null;
let termColsCache = null;
let scheduledColsCache = null;
let invoiceColsCache = null;

async function annualPrepayTableExists() {
  if (tableExistsCache != null) return tableExistsCache;
  try {
    tableExistsCache = await db.schema.hasTable('annual_prepay_terms');
  } catch (err) {
    logger.warn(`[annual-prepay] table detection failed: ${err.message}`);
    tableExistsCache = false;
  }
  return tableExistsCache;
}

function resetCachesForTests() {
  tableExistsCache = null;
  termColsCache = null;
  scheduledColsCache = null;
  invoiceColsCache = null;
}

async function scheduledServiceColumns() {
  if (scheduledColsCache) return scheduledColsCache;
  try {
    scheduledColsCache = await db('scheduled_services').columnInfo();
  } catch {
    scheduledColsCache = {};
  }
  return scheduledColsCache;
}

async function annualPrepayColumns(conn = db) {
  if (conn === db && termColsCache) return termColsCache;
  let cols = {};
  try {
    cols = await conn('annual_prepay_terms').columnInfo();
  } catch {
    cols = {};
  }
  if (conn === db) termColsCache = cols;
  return cols;
}

async function invoiceColumns() {
  if (invoiceColsCache) return invoiceColsCache;
  try {
    invoiceColsCache = await db('invoices').columnInfo();
  } catch {
    invoiceColsCache = {};
  }
  return invoiceColsCache;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

function parseYmd(value) {
  const ymd = dateOnly(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0, 12, 0, 0)).getUTCDate();
}

function addMonthsSameDay(value, months) {
  const parts = parseYmd(value);
  if (!parts) return null;
  const monthIndex = parts.month - 1 + Number(months || 0);
  const targetYear = parts.year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const targetDay = Math.min(parts.day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function addDaysYmd(value, days) {
  const ymd = dateOnly(value) || etDateString();
  return etDateString(addETDays(parseETDateTime(`${ymd}T12:00`), Number(days || 0)));
}

// Arrival-time helpers for the operator-promised first-visit window. Accepts
// 'HH:MM' or a Postgres 'HH:MM:SS' time and normalizes to 'HH:MM'; anything
// unparseable returns null so the visit falls back to the windowless default.
// Appointment windows START ON THE HOUR (owner rule, AGENTS.md) — an :15/:30
// start is rejected here rather than relying on the input's `step`, so the API
// and the UI can't disagree. window_end is duration-driven and may legitimately
// land off-hour.
function normalizeWindowStart(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes !== 0) return null;
  return `${String(hours).padStart(2, '0')}:00`;
}

// Current Eastern wall-clock time as 'HH:MM' — used to refuse a promised
// arrival hour that has already elapsed on the payment day.
function etNowHHMM(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

// window_end must stay DURATION-driven (AGENTS.md), so a start whose job block
// would cross midnight is rejected rather than clamped into a short visit.
function addMinutesHHMM(value, minutes) {
  const start = normalizeWindowStart(value);
  if (!start) return null;
  const [hours, mins] = start.split(':').map(Number);
  const total = hours * 60 + mins + Number(minutes || 0);
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Conflict guard for a promised first-visit window. Delegates to the canonical
// occupancy module (AGENTS.md booking-conflict rule + occupancy ordering
// contract) rather than hand-rolling a predicate: findConflictingVisits is
// tech-blind — which matters because coverage visits are seeded
// technician-NULL and tech-scoped WHEREs can't see them — and it already
// handles live estimate holds and the nullable window_end.
//
// `adoptableFor` narrowly ignores the ONE row this coverage would adopt: the
// same customer's visit of the same coverage service type at that hour, which
// the exact-date matcher in ensureCoverageRowsForTerm takes over rather than
// duplicating. The exemption mirrors coverageRowsForTerm's eligibility exactly
// — a rescheduled/skipped/no-show row is NOT adoptable there, so it must count
// as occupancy here or the timed insert could overlap it. Every other row —
// including the same customer's OTHER services, which still can't be performed
// simultaneously — counts as occupancy. `excludeServiceIds` skips a specific
// row (the adopted visit itself, when retiming it in place).
async function findVisitWindowConflict(conn, {
  scheduledDate, windowStart, durationMinutes = 60, adoptableFor = null, excludeServiceIds = [],
} = {}) {
  const date = dateOnly(scheduledDate);
  const start = normalizeWindowStart(windowStart);
  const end = addMinutesHHMM(start, durationMinutes);
  if (!date || !start || !end) return null;
  const { findConflictingVisits } = require('./scheduling/occupancy');
  const rows = await findConflictingVisits({
    db: conn,
    date,
    windowStart: start,
    windowEnd: end,
    excludeServiceIds,
  });
  if (!rows || !rows.length) return null;
  const customerId = adoptableFor?.customerId || null;
  const serviceType = adoptableFor?.coverageServiceType || null;
  if (!customerId || !serviceType) return rows[0];
  const blocking = rows.filter((row) => !(
    String(row.customer_id) === String(customerId)
    && serviceMatchesCoverage(row, serviceType)
    // The exemption must be exactly as narrow as ADOPTION (codex r21
    // pre-push P1): a row the coverage refused to adopt (wrong identity,
    // other term) is real occupancy — the timed insert must not overlap
    // it.
    && (typeof adoptableFor?.isAdoptable !== 'function' || adoptableFor.isAdoptable(row))
    && !COVERAGE_EXCLUDED_STATUSES.has(String(row.status || '').toLowerCase())
  ));
  return blocking.length ? blocking[0] : null;
}

function daysUntil(fromYmd, toYmd) {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) return null;
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day, 12, 0, 0);
  const toUtc = Date.UTC(to.year, to.month - 1, to.day, 12, 0, 0);
  return Math.round((toUtc - fromUtc) / 86400000);
}

function normalizeCoverageServiceType(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  // Cap to 100: this value is written verbatim into scheduled_services.service_type
  // (varchar(100)) when coverage rows are seeded, so a longer label would fail
  // activation with a Postgres "value too long" error.
  return cleaned ? cleaned.slice(0, 100) : null;
}

function normalizeCoverageVisitCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 24) : null;
}

function normalizeCoverageCadence(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!cleaned) return null;

  const aliases = {
    bi_monthly: 'bimonthly',
    every_2_months: 'bimonthly',
    every_2_month: 'bimonthly',
    every_two_months: 'bimonthly',
    every_three_months: 'quarterly',
    every_3_months: 'quarterly',
    every_four_months: 'triannual',
    every_4_months: 'triannual',
    every_six_months: 'semiannual',
    every_6_months: 'semiannual',
    every_6_weeks: 'every_6_weeks',
    every_six_weeks: 'every_6_weeks',
    every_42_days: 'every_6_weeks',
    six_weeks: 'every_6_weeks',
    semi_annual: 'semiannual',
    biannual: 'semiannual',
    yearly: 'annual',
  };

  const normalized = aliases[cleaned] || cleaned;
  return ['monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'annual', 'every_6_weeks'].includes(normalized)
    ? normalized
    : null;
}

function coverageCadenceMonths(value) {
  const cadence = normalizeCoverageCadence(value);
  if (cadence === 'monthly') return 1;
  if (cadence === 'bimonthly') return 2;
  if (cadence === 'quarterly') return 3;
  if (cadence === 'triannual') return 4;
  if (cadence === 'semiannual') return 6;
  if (cadence === 'annual') return 12;
  return null;
}

function coverageCadenceDays(value) {
  const cadence = normalizeCoverageCadence(value);
  if (cadence === 'every_6_weeks') return 42;
  return null;
}

// Coverage cadence from a series' recurring_interval_days — the resolution
// for patterns normalizeCoverageCadence can't name ('custom' carrying 42
// days is really every-6-weeks). Lives HERE beside the other coverage-cadence
// helpers rather than in a route file so its one definition serves every
// consumer (moved from admin-invoices.js, which now imports it).
function cadenceFromIntervalDays(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 17) return null; // daily/weekly/biweekly: not coverage cadences
  if (d >= 26 && d <= 35) return 'monthly';        // ~30
  if (d >= 38 && d <= 48) return 'every_6_weeks';  // ~42
  if (d >= 55 && d <= 66) return 'bimonthly';      // ~60
  if (d >= 85 && d <= 96) return 'quarterly';      // ~90/91
  if (d >= 115 && d <= 125) return 'triannual';    // ~120
  if (d >= 170 && d <= 190) return 'semiannual';   // ~180
  if (d >= 350 && d <= 380) return 'annual';       // ~365
  return null;
}

// NOTE: cadence → visits-per-year lives in prepay-cadence.js
// (visitsPerYearForCadence). A copy briefly existed here and was removed —
// it silently disagreed with the shared one on seasonal_feb_oct.

function coverageCadenceSchedule(value) {
  const cadence = normalizeCoverageCadence(value);
  const months = coverageCadenceMonths(cadence);
  if (months) return { unit: 'months', value: months, cadence };
  const days = coverageCadenceDays(cadence);
  if (days) return { unit: 'days', value: days, cadence };
  return null;
}

function inferCoverageCadence(term = {}) {
  const explicit = normalizeCoverageCadence(term?.coverage_cadence);
  if (explicit) return explicit;

  const serviceType = String(term?.coverage_service_type || '').toLowerCase();
  if (/\bbi[-\s]?monthly\b|\bevery\s*2\s*months?\b/.test(serviceType)) return 'bimonthly';
  if (/\bquarterly\b|\bevery\s*3\s*months?\b/.test(serviceType)) return 'quarterly';
  if (/\btri[-\s]?annual\b|\bevery\s*4\s*months?\b/.test(serviceType)) return 'triannual';
  if (/\bsemi[-\s]?annual\b|\bevery\s*6\s*months?\b/.test(serviceType)) return 'semiannual';
  if (/\bannual\b|\byearly\b|\bevery\s*12\s*months?\b/.test(serviceType)) return 'annual';
  if (/\bevery\s*6\s*weeks?\b|\b6\s*weeks\b|\b42\s*days\b/.test(serviceType)) return 'every_6_weeks';
  if (/\bmonthly\b/.test(serviceType)) return 'monthly';

  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  if (coverageVisitCount === 12) return 'monthly';
  if (coverageVisitCount === 6) return 'bimonthly';
  if (coverageVisitCount === 4) return 'quarterly';
  if (coverageVisitCount === 3) return 'triannual';
  if (coverageVisitCount === 2) return 'semiannual';
  if (coverageVisitCount === 1) return 'annual';
  if (coverageVisitCount === 9) return 'every_6_weeks';

  return 'quarterly';
}

function coverageServiceKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(quarterly|monthly|bimonthly|bi-monthly|semiannual|semi-annual|annual|yearly|recurring|general|program|service|visit|application|applications|every|week|weeks|day|days|six|42|6)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function serviceMatchesCoverage(row, coverageServiceType) {
  const target = coverageServiceKey(coverageServiceType);
  const service = coverageServiceKey(row?.service_type);
  if (!target || !service) return false;
  return service === target || service.includes(target) || target.includes(service);
}

function splitCoverageAmount(totalDollars, visitCount) {
  const total = Number(totalDollars);
  const count = Number(visitCount);
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count <= 0) return [];
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;
  return Array.from({ length: count }, (_, index) => (
    (baseCents + (index === count - 1 ? remainder : 0)) / 100
  ));
}

// Anchor the generated coverage series. term_start is the day the prepay
// invoice was MINTED, but visits are generated when it is PAID — so a
// mint-to-payment lag used to back-date the first visit (2026-07 regression:
// an annual prepay paid two days after mint seeded visit 1 of 4 in the past,
// and a past-dated visit is also silently dropped by the reminder sender).
// `firstVisitDate` (an operator-promised first service date)
// wins when present; either way the anchor moves forward to `notBefore`
// (today) as far as the term window allows.
// The date the customer is actually expecting the first visit: the operator's
// promise when one was captured, otherwise the term start (legacy behavior).
// Payment reminders and the coverage anchor must agree on this or the unpaid
// reminder names a date the schedule will never use.
function effectiveFirstVisitDate(term) {
  return dateOnly(term?.first_visit_date) || dateOnly(term?.term_start);
}

function coverageSeriesAnchor(termStart, { firstVisitDate = null, notBefore = null } = {}) {
  const normalizedStart = dateOnly(termStart);
  if (!normalizedStart) return null;
  const promised = dateOnly(firstVisitDate);
  const floor = dateOnly(notBefore);
  // A promise still in the future is honored exactly — it was validated
  // against the term window at mint time and the customer was told this date.
  // A promise that has ALREADY PASSED when payment lands cannot be kept
  // (seeding it would recreate the past-dated visit this function exists to
  // prevent) and falls through to the floor.
  if (promised && promised > normalizedStart && (!floor || promised >= floor)) return promised;
  let anchor = promised || normalizedStart;
  // The floor is INVIOLABLE: a visit dated before the payment day can never be
  // serviced, is skipped by the reminder sender, and reopens the regression
  // this change fixes. When the term window can't absorb the shift the series
  // TRUNCATES at term_end instead (coverageScheduleDates' cutoff) and the
  // seeder logs the shortfall for operator action — a surfaced short schedule
  // beats a silent unserviceable one.
  if (floor && anchor < floor) anchor = floor;
  return anchor < normalizedStart ? normalizedStart : anchor;
}

function coverageScheduleDates(termStart, visitCount, cadence, termEnd = null, options = {}) {
  const normalizedStart = dateOnly(termStart);
  const count = normalizeCoverageVisitCount(visitCount);
  if (!normalizedStart || !count) return [];
  const schedule = coverageCadenceSchedule(cadence) || coverageCadenceSchedule(inferCoverageCadence({ coverage_visit_count: count }));
  if (!schedule) return [];
  const anchor = coverageSeriesAnchor(normalizedStart, options) || normalizedStart;
  const normalizedEnd = termEnd ? dateOnly(termEnd) : null;
  const dates = [];
  for (let index = 0; index < count; index++) {
    const date = schedule.unit === 'days'
      ? addDaysYmd(anchor, index * schedule.value)
      : addMonthsSameDay(anchor, index * schedule.value);
    if (!date) return [];
    if (normalizedEnd && date > normalizedEnd) break;
    dates.push(date);
  }
  return dates;
}

// A scheduled row COMMITTED to a term: linked by id, prepaid-stamped, or
// sharing the term's source estimate (codex r18 pre-push P0 — a
// payment-pending term's reserved/sold first visit carries only
// source_estimate_id; excluding it would seed replacement visits and
// leave the sold visit separately billable).
function rowLinkedToAnotherTerm(term, row) {
  return row.annual_prepay_term_id != null
    && term?.id != null
    && String(row.annual_prepay_term_id) !== String(term.id);
}

function rowCommittedToTerm(term, row) {
  // Direct evidence (term link or prepaid stamp) always commits. Estimate
  // provenance commits ONLY rows that READ recurring (is_recurring /
  // recurring_pattern / recurring_parent_id, stamped at seeding) — for
  // EVERY family (codex r21 pre-push P0): an estimate's extra one-time
  // appointment matching the coverage text must never join the committed
  // set, displace an already-stamped visit in the slice, or absorb a
  // prepaid stamp of its own.
  // A row EXPLICITLY linked to a different term belongs to that term
  // (codex r21 pre-push P0, fourth pass): its prepaid stamp or shared
  // estimate must not let a neighboring/boundary term consume it, or the
  // newly paid term seeds short while the other term's visit double-counts.
  if (rowLinkedToAnotherTerm(term, row)) return false;
  const directCommitment = (term?.id != null && String(row.annual_prepay_term_id) === String(term.id))
    || (Number(row.prepaid_amount) > 0 && row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD);
  if (directCommitment) return true;
  const readsRecurring = row.is_recurring === true
    || !!row.recurring_pattern
    || !!row.recurring_parent_id;
  return readsRecurring
    && term?.source_estimate_id != null && row.source_estimate_id != null
    && String(row.source_estimate_id) === String(term.source_estimate_id);
}

// Palm coverage family detection, shared by coverage matching and the
// seeding identity guard (codex r18 pre-push P0/P1): word-boundary
// fallback keeps 'Palmetto…' service types out when the resolver errors.
function coverageFamilyIsPalm(coverageServiceType) {
  // INJECTION-scoped (codex r20 pre-push P0): the broad family resolver
  // also captures the distinct legacy palm_treatment nutritional program,
  // whose quarterly prepay terms must keep gap-filling untouched.
  try {
    const { isPalmInjectionFamily } = require('./estimate-converter');
    return isPalmInjectionFamily({ name: coverageServiceType, service_type: coverageServiceType });
  } catch (familyErr) {
    logger.warn(`[annual-prepay] palm family detection failed (${familyErr.message}) — falling back to word-boundary test`);
    // Injection-scoped like the resolver (codex r21 pre-push P1): bare
    // historical 'Palm'/'Palm Treatment' labels are the nutritional lane.
    const label = String(coverageServiceType || '');
    return /\bpalm\b/i.test(label)
      && /injection/i.test(label)
      && !/nutritional|fertil/i.test(label);
  }
}

async function coverageRowsForTerm(term, conn = db, { includeTerminalStatuses = false } = {}) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const termStart = dateOnly(term?.term_start);
  const termEnd = dateOnly(term?.term_end);
  if (!term?.customer_id || !coverageServiceType || !coverageVisitCount || !termStart || !termEnd) {
    return [];
  }

  const rows = await conn('scheduled_services')
    .where({ customer_id: term.customer_id })
    .whereBetween('scheduled_date', [termStart, termEnd])
    .orderBy(['scheduled_date', 'window_start', 'id'])
    .select('*');

  const filtered = includeTerminalStatuses
    ? rows
    : rows.filter((row) => !COVERAGE_EXCLUDED_STATUSES.has(String(row.status || '').toLowerCase()));

  const isCommittedToTerm = (row) => rowCommittedToTerm(term, row);
  let matching = filtered.filter((row) => serviceMatchesCoverage(row, coverageServiceType));
  // PALM coverage candidates require identity or provenance (codex r18
  // pre-push P0): matching is by service-type TEXT, and Waves sells
  // genuine one-time palm injections — a name-matched one-time
  // appointment inside the term window must never be adopted into
  // prepaid coverage (attach + stamping both read this set, and the
  // stamp would suppress its separate completion invoice). A palm row
  // qualifies only when it CARRIES the recurring identity (id or
  // snapshot) or already belongs to this term; ambiguous rows are
  // excluded and the seeder creates a correctly-identified visit
  // instead (fail closed).
  if (coverageFamilyIsPalm(coverageServiceType)) {
    // A FAILED identity lookup PROPAGATES (codex r21 P0): swallowing it
    // to null would exclude valid id-carrying palm rows from coverage and
    // seed duplicate visits beside them — the originals then bill at
    // completion. A MISSING row (clean undefined) still resolves null:
    // that is the catalog-missing environment, where the seeding resolve
    // defers before anything is created.
    const semiannualPalmId = (await conn('services').where({ service_key: 'palm_injection_semiannual' }).first('id'))?.id || null;
    const oneTimePalmId = (await conn('services').where({ service_key: 'palm_injection' }).first('id'))?.id || null;
    // ID-FIRST classification (codex r27 pre-push P0): completion trusts
    // service_id before the snapshot, so a FOREIGN id beats a semiannual
    // snapshot (contradictory row — reject), while a semiannual id beats
    // a stray snapshot (correct row — count). Provenance/commitment
    // fallback remains only for rows the backfill can OWN: bare
    // (name-only) or the KNOWN stale one-time identity.
    const palmRowClass = (row) => {
      if (row.service_id) {
        if (semiannualPalmId && row.service_id === semiannualPalmId) return 'recurring';
        if (oneTimePalmId && row.service_id === oneTimePalmId) return 'stale';
        return 'foreign';
      }
      const snap = String(row.service_key_snapshot || '');
      if (snap === 'palm_injection_semiannual') return 'recurring';
      if (snap === 'palm_injection') return 'stale';
      if (snap) return 'foreign';
      return 'bare';
    };
    // A row linked to ANOTHER term never counts (codex r21 pre-push P0,
    // fifth pass): even carrying the recurring identity, it belongs to
    // that term's coverage — counting it here seeds this term short while
    // attach/stamping refuse to move it.
    matching = matching.filter((row) => {
      if (rowLinkedToAnotherTerm(term, row)) return false;
      const cls = palmRowClass(row);
      if (cls === 'recurring') return true;
      if (cls === 'foreign') return false;
      return rowCommittedToTerm(term, row);
    });
  }
  if (matching.length <= coverageVisitCount) return matching;

  // More matching candidates than sold visits: keep the visits already committed
  // to THIS term (linked or annual-prepay-stamped) inside the slice. Plain
  // date-order slicing would let a newly-added earlier matching visit displace an
  // already-stamped later one, which then keeps its orphaned prepaid stamp —
  // leaving more than coverageVisitCount visits prepaid and skipping completion
  // billing on the extra work. Fill any remaining slots with the earliest
  // uncommitted matches, then return the selection in date order.
  const selectedIds = new Set(
    [...matching.filter(isCommittedToTerm), ...matching.filter((row) => !isCommittedToTerm(row))]
      .slice(0, coverageVisitCount)
      .map((row) => row.id),
  );
  return matching.filter((row) => selectedIds.has(row.id));
}

// A promise made on the phone must never change silently: whenever seeding
// drops a promised arrival window or moves a promised date, park a durable
// admin notification (dedupe-keyed per term+reason) alongside the log line so
// the operator resolves it with the customer. Best-effort — a notification
// failure never blocks payment activation.
// Same notice, but deferred until the transaction that owns the write
// COMMITS: fileCoverageException writes through the global connection and
// dedupes per term+reason for 7 days, so a notice filed inside a trx that
// later rolls back (attach/stamp failure downstream in refreshTermSnapshot)
// would outlive the rollback and suppress the correct retry's notice.
// `scope` is the outermost knex transaction (the caller-supplied conn when
// it is one, else the transaction opened here); its executionPromise
// settles at COMMIT (resolves) or ROLLBACK (rejects — nothing is filed).
// A bare connection (or a test double) files immediately.
function fileCoverageExceptionAfterCommit(scope, term, reason, body) {
  const done = scope && scope !== db && scope.executionPromise;
  if (done && typeof done.then === 'function') {
    done.then(() => fileCoverageException(term, reason, body)).catch(() => {});
    return Promise.resolve();
  }
  return fileCoverageException(term, reason, body);
}

async function fileCoverageException(term, reason, body) {
  try {
    // notifyAdmin does not interpret dedupeKey — enforce it here (same
    // pattern as appointment-reminders): one open alert per term+reason per
    // 7 days, so a re-run refresh can't stack duplicates of the same problem.
    const dedupeKey = `annual-prepay-first-visit:${term?.id}:${reason}`;
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - interval '7 days'"))
      .first('id')
      .catch(() => null);
    if (existing) return;
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin(
      'alert',
      'Annual prepay: promised first visit needs attention',
      body,
      {
        link: term?.customer_id ? `/admin/customers/${term.customer_id}` : '/admin/dispatch',
        metadata: {
          dedupeKey,
          customer_id: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          reason,
        },
      },
    );
  } catch (err) {
    logger.warn(`[annual-prepay] coverage exception notification failed for term ${term?.id}: ${err.message}`);
  }
}

async function ensureCoverageRowsForTerm(term, conn = db, { today = etDateString(), nowHHMM = etNowHHMM() } = {}) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const coverageCadence = inferCoverageCadence(term);
  const termStart = dateOnly(term?.term_start);
  const termEnd = dateOnly(term?.term_end);
  // Cheap not-configured guard FIRST: the slide below runs async queries, and
  // a term with no coverage config (renewal notices, legacy terms) must
  // return before touching the database at all.
  if (!term?.customer_id || !coverageServiceType || !coverageVisitCount || !termStart || !termEnd) {
    return { createdCount: 0, targetDates: [], reason: 'coverage_not_configured' };
  }
  const cols = await scheduledServiceColumns();
  if (!cols.scheduled_date || !cols.service_type) {
    return { createdCount: 0, targetDates: [], reason: 'scheduled_columns_missing' };
  }

  // Only count visits that can actually be stamped prepaid downstream:
  // attachScheduledServices() / applyPrepaidCoverageForTerm() use the
  // non-terminal coverage set, so a cancelled / skipped / no-show / rescheduled
  // visit must NOT consume one of the sold coverageVisitCount slots or suppress
  // its generated replacement — otherwise the paid term ends up with fewer
  // covered visits than the admin sold.
  let existingRows = await coverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd }, conn);

  // The floor and window-slide below apply ONCE, at first activation. This
  // function also runs on every schedule-edit refresh of an ACTIVE term, and
  // an always-on today-floor would compound: each later refresh would see a
  // new positive lag and extend term_end again, indefinitely postponing
  // renewal while billing stays suppressed. "Already activated" = ANY row was
  // ever linked to this term (the first activation links its rows via the
  // seed inserts and attachScheduledServices immediately after) — from then
  // on this function is a pure gap-filler on the stored window. Checked with
  // a dedicated any-status query, NOT the eligible coverage set: cancelling
  // every linked visit must not make a later refresh look like a first
  // activation and reopen the compounding slide.
  const alreadyActivated = !!cols.annual_prepay_term_id
    && !!(await conn('scheduled_services').where({ annual_prepay_term_id: term.id }).first('id'));

  // Seeding runs at PAYMENT time, so the past-date floor is today: a term paid
  // days after it was minted must not generate a visit that already happened.
  //
  // When the floor shifts the anchor, the coverage WINDOW slides with it: the
  // customer paid for coverageVisitCount visits, and a fixed term_end would
  // truncate the tail (out-of-window visits are never linked or stamped
  // prepaid — the customer would pay full price for fewer visits). A late
  // payer's year of coverage genuinely starts at their first real visit, so
  // term_end extends by the same lag. Only floor/promise SHIFTS slide the end;
  // a deliberately short custom term (unshifted anchor) still truncates as
  // designed.
  const anchorOptions = {
    firstVisitDate: term?.first_visit_date || null,
    notBefore: alreadyActivated ? null : today,
  };
  const mintAnchor = coverageSeriesAnchor(termStart, { firstVisitDate: term?.first_visit_date || null }) || termStart;
  const paidAnchor = coverageSeriesAnchor(termStart, anchorOptions) || termStart;
  const anchorLagDays = daysUntil(mintAnchor, paidAnchor);
  let effectiveTermEnd = termEnd;
  // The slide only happens where it can also be PERSISTED — an in-memory-only
  // extension would seed visits the stored window doesn't cover.
  if (!alreadyActivated && anchorLagDays != null && anchorLagDays > 0 && (await annualPrepayColumns(conn)).term_end) {
    effectiveTermEnd = addDaysYmd(termEnd, anchorLagDays);
    // Never slide into a successor term: a long-pending invoice can be paid
    // after the customer already bought the NEXT year, and overlapping paid
    // windows would let both terms claim the same visits. Cap at the day
    // before the earliest later term; the resulting shortfall (if any) files
    // the coverage-shortfall exception below for operator reconciliation.
    try {
      // ANY later term caps the slide — status-shape filtering here has
      // already missed the decided-lapse form (status 'cancelled' +
      // renewal_decision 'cancel' still counts as paid coverage in
      // coveredTermsAsOf), and capping on a genuinely dead successor merely
      // under-extends, which the shortfall exception below surfaces. Being
      // conservative can't create overlapping paid coverage; being clever can.
      const successor = await conn('annual_prepay_terms')
        .where({ customer_id: term.customer_id })
        .whereNot({ id: term.id })
        .where('term_start', '>', termEnd)
        .orderBy('term_start', 'asc')
        .first('term_start');
      if (successor && dateOnly(successor.term_start) <= effectiveTermEnd) {
        effectiveTermEnd = addDaysYmd(dateOnly(successor.term_start), -1);
        logger.warn(`[annual-prepay] term ${term.id} window slide capped at ${effectiveTermEnd} — successor term starts ${dateOnly(successor.term_start)}`);
      }
    } catch (err) {
      // Fail SAFE: without certainty about successors, don't extend at all.
      logger.warn(`[annual-prepay] term ${term.id} successor check failed (${err.message}) — coverage window not extended`);
      effectiveTermEnd = termEnd;
    }
  }
  const targetDates = coverageScheduleDates(termStart, coverageVisitCount, coverageCadence, effectiveTermEnd, anchorOptions);
  if (!targetDates.length) {
    return { createdCount: 0, targetDates: [], reason: 'coverage_not_configured' };
  }
  // A slid window can newly cover rows between the old and new end — refetch
  // so tolerance matching sees them instead of seeding alongside.
  if (effectiveTermEnd !== termEnd) {
    existingRows = await coverageRowsForTerm({ ...term, term_start: termStart, term_end: effectiveTermEnd }, conn);
  }

  // Existing in-window matching visits (e.g. the customer's pre-existing route)
  // already satisfy coverage even when they don't land on the exact generated
  // cadence dates. Treat a generated date within half a cadence interval of an
  // existing visit as already covered, so a July-1 target doesn't lay a second
  // series on top of an existing July-15 route. Each existing visit is consumed
  // by at most ONE slot (removed from the pool once matched) — otherwise a single
  // visit sitting midway between two cadence dates would suppress both and leave
  // the paid coverage short. The remaining-count cap stops over-seeding when the
  // customer already has at least the sold number of in-window matching visits.
  const availableExisting = existingRows.filter((row) => dateOnly(row.scheduled_date));
  const cadenceMonths = coverageCadenceMonths(coverageCadence);
  const cadenceIntervalDays = cadenceMonths ? cadenceMonths * 30 : (coverageCadenceDays(coverageCadence) || 30);
  const slotToleranceDays = Math.max(7, Math.floor(cadenceIntervalDays / 2));
  const remainingToSeed = Math.max(0, coverageVisitCount - existingRows.length);
  // The first target carries an operator PROMISE when first_visit_date made it
  // the anchor: only an existing visit on exactly that date may satisfy it (the
  // call-booked visit the promise refers to). Half-cadence tolerance would let
  // an unrelated route visit weeks away suppress the promised date entirely —
  // the customer would be told nothing and nobody would come on the day they
  // were quoted.
  const promisedTarget = dateOnly(term?.first_visit_date) === targetDates[0] ? targetDates[0] : null;
  // The row that satisfied the promised target, if any — it may still need the
  // promised arrival time applied (an adopted call-booked visit can be
  // windowless or sitting at a different hour than the operator quoted).
  let adoptedPromisedRow = null;
  const datesToSeed = [];
  for (const scheduledDate of targetDates) {
    if (datesToSeed.length >= remainingToSeed) break;
    const exactOnly = scheduledDate === promisedTarget;
    const matchIndex = availableExisting.findIndex((row) => {
      const existingDate = dateOnly(row.scheduled_date);
      if (exactOnly) return existingDate === scheduledDate;
      const diff = daysUntil(existingDate, scheduledDate);
      return diff != null && Math.abs(diff) <= slotToleranceDays;
    });
    if (matchIndex !== -1) {
      const [matched] = availableExisting.splice(matchIndex, 1);
      if (exactOnly) adoptedPromisedRow = matched;
      continue;
    }
    datesToSeed.push(scheduledDate);
  }

  const createdRows = [];
  // Rows adopted under the occupancy lock (concurrently-created same-day
  // visits) — collected so the palm identity backfill below can reach
  // them; they are never in existingRows.
  const adoptedConcurrentRows = [];
  // Owner directive (2026-07-03): every service call defaults to 60 minutes.
  const baseDuration = 60;
  const recurringParentId = existingRows[0]?.recurring_parent_id || existingRows[0]?.id || null;
  let createdParentId = recurringParentId;

  // Give seeded visits a billable pre-tax per-visit price (from the prepay
  // invoice subtotal) and flag create_invoice_on_complete, so that if the prepay
  // is later voided/refunded and the prepaid stamp is cleared, completion billing
  // has a price to invoice — prepay customers often have monthly_rate 0, which
  // would otherwise leave these generated visits completing unbilled. While
  // coverage is intact the prepaid stamp (>= this pre-tax price) still suppresses
  // the invoice, so this never double-bills a covered visit.
  let seededVisitPrice = null;
  if (cols.estimated_price && term?.prepay_invoice_id) {
    try {
      const inv = await conn('invoices').where({ id: term.prepay_invoice_id }).first('subtotal', 'total');
      const base = Number(inv?.subtotal) > 0 ? Number(inv.subtotal) : Number(inv?.total) || 0;
      if (base > 0) seededVisitPrice = Math.round((base / coverageVisitCount) * 100) / 100;
    } catch (err) {
      logger.warn(`[annual-prepay] seeded visit price lookup skipped: ${err.message}`);
    }
  }

  // An operator-promised arrival time for the FIRST visit (e.g. "Saturday at
  // 8"). Only the first generated date gets it — the later placeholders stay
  // windowless on purpose, so dispatch still routes them freely. window_end is
  // the job block (baseDuration), NOT the customer-facing promise: the 2-hour
  // arrival window is derived from window_start at display time.
  let firstVisitWindowStart = normalizeWindowStart(term?.first_visit_window_start);
  // A start so late its job block would cross midnight can't produce a
  // duration-driven window_end — drop it rather than store a half-length visit.
  if (firstVisitWindowStart && !addMinutesHHMM(firstVisitWindowStart, baseDuration)) {
    logger.warn(`[annual-prepay] term ${term.id} first-visit window ${firstVisitWindowStart} leaves no room for a ${baseDuration}-minute visit — seeding without a window`);
    firstVisitWindowStart = null;
  }
  const firstTargetDate = targetDates[0] || null;
  // Payment landing on the promised DATE but after the promised HOUR must not
  // create a window that is already over — it can't be serviced or reminded.
  // The visit still seeds today, windowless, for the operator to retime.
  if (firstVisitWindowStart && firstTargetDate === today && firstVisitWindowStart <= nowHHMM) {
    logger.warn(`[annual-prepay] term ${term.id} promised window ${firstVisitWindowStart} on ${firstTargetDate} has already passed (now ${nowHHMM} ET) — seeding today's visit without a window`);
    await fileCoverageException(term, 'window_elapsed',
      `Payment arrived after the promised ${firstVisitWindowStart} arrival time today (${firstTargetDate}). The visit is on the schedule without a time — pick a new time with the customer.`);
    firstVisitWindowStart = null;
  }

  // Payment-seeded PALM visits must carry the recurring catalog identity
  // (codex #3349 r14 P1): a bare service_type 'Palm Injection' misfiles at
  // completion — the exact-name lookup misses and the unique short-name
  // match is the ONE-TIME palm_injection row, so every paid recurring
  // visit would get one-time billing and the token-only portal posture.
  // Mirror the converter/admin identity link (seedingFamilyKey handles the
  // Palmetto substring trap); IDENTITY ONLY — duration stays the 60-minute
  // slot default, never the catalog row's. Runs BEFORE the term-end slide
  // persists (codex r17 pre-push P1): a deferred run must not extend the
  // coverage window — repeated deferrals would otherwise re-apply the
  // payment lag on every refresh and postpone renewal indefinitely.
  let coverageCatalogServiceId = null;
  let coverageCatalogKey = null;
  let staleOneTimePalmId = null;
  // Palm detection runs INDEPENDENTLY of the coverage cadence (codex r18
  // pre-push P1): nesting it under `=== 'semiannual'` let an admin-created
  // palm term with an explicit monthly/quarterly cadence bypass the
  // identity guard entirely and seed name-only visits at the wrong
  // cadence. Detection uncertainty counts as palm when the type names
  // palm (word-boundary — 'Palmetto…' never trips it).
  const coverageIsPalm = coverageFamilyIsPalm(coverageServiceType);
  if (coverageIsPalm) {
    // Palm coverage is semiannual-only (owner ruling 2026-08-11): any
    // other recorded cadence is invalid term data — seeding it would
    // create the wrong series AND misfile completions to the one-time
    // profile. Defer with a durable exception; nothing is created.
    if (coverageCadence !== 'semiannual') {
      logger.error(`[annual-prepay] term ${term.id}: palm coverage records cadence '${coverageCadence}' — palm is semiannual-only, deferring (fail closed)`);
      await fileCoverageException(term, 'palm_coverage_cadence_invalid',
        `This palm term records a '${coverageCadence}' coverage cadence, but the palm program is semiannual-only — correct the term's coverage cadence, then re-save to seed its visits.`);
      return {
        createdCount: 0,
        targetDates,
        existingCount: existingRows.length,
        createdRows: [],
        effectiveTermEnd: termEnd,
        reason: 'palm_coverage_cadence_invalid',
      };
    }
    try {
      const catalogRow = await conn('services')
        .where({ service_key: 'palm_injection_semiannual' })
        .first('id', 'service_key');
      if (catalogRow?.id) {
        coverageCatalogServiceId = catalogRow.id;
        coverageCatalogKey = catalogRow.service_key;
        // The one-time palm row's id (codex r16 P1): an adopted legacy
        // visit booked before the recurring row existed can carry it
        // (estimate-public preserves ids on adoption), and completion
        // trusts the id first. In this definitively semiannual coverage
        // context that KNOWN id is stale — the backfill below retargets
        // it, mirroring the converter's reserved-parent relink.
        const oneTimeRow = await conn('services')
          .where({ service_key: 'palm_injection' })
          .first('id');
        staleOneTimePalmId = oneTimeRow?.id || null;
      } else {
        // FAIL CLOSED (codex r15 pre-push P1): seeding name-only palm
        // visits would knowingly hand them the one-time completion/
        // billing posture. Defer — ensureCoverageRowsForTerm is
        // idempotent and re-runs on every term refresh, and the deduped
        // coverage exception keeps it office-visible until then. Runs
        // BEFORE the term-end slide persists (codex r17 pre-push P1) so
        // repeated deferrals never extend the coverage window.
        logger.error(`[annual-prepay] term ${term.id}: palm_injection_semiannual catalog row missing — deferring palm coverage seeding (fail closed)`);
        await fileCoverageException(term, 'palm_catalog_missing',
          'The recurring palm catalog row (palm_injection_semiannual) is missing, so this term\'s prepaid palm visits were NOT created. Restore the catalog row (migration 20260811000010); the next term refresh seeds them automatically.');
        return {
          createdCount: 0,
          targetDates,
          existingCount: existingRows.length,
          createdRows: [],
          // The ORIGINAL term end: this deferral runs before the
          // late-payment slide persists, and the caller trusts any
          // returned effectiveTermEnd for downstream window math.
          effectiveTermEnd: termEnd,
          reason: 'palm_catalog_missing',
        };
      }
    } catch (err) {
      // Unknown identity state = fail closed for palm too.
      logger.warn(`[annual-prepay] term ${term.id}: palm coverage identity link failed (${err.message}) — deferring`);
      await fileCoverageException(term, 'palm_catalog_missing',
        'The recurring palm catalog identity could not be verified while seeding this term\'s prepaid visits — seeding deferred; the next term refresh retries automatically.');
      return {
        createdCount: 0,
        targetDates,
        existingCount: existingRows.length,
        createdRows: [],
        // Original term end — same rule as the deferral above.
        effectiveTermEnd: termEnd,
        reason: 'palm_catalog_missing',
      };
    }
  }

  // Shared palm identity backfill (codex r15/r16/r17/r18 rounds): rows
  // the seeder matched or adopted still resolve the ONE-TIME catalog row
  // at completion when they are name-only (NULL service_id, no foreign
  // snapshot) or carry the KNOWN stale one-time palm id/snapshot — both
  // retarget to the recurring identity, mirroring the converter's
  // reserved-parent relink. A row whose id/snapshot records a DIFFERENT
  // durable identity was a deliberate booking and stays untouched.
  const backfillPalmIdentity = async (rows, label) => {
    try {
      const oneTimePalmSnapshot = (row) => String(row.service_key_snapshot || '') === 'palm_injection';
      // Retargeting a row that CARRIES the one-time identity requires
      // PROVENANCE (codex r18 pre-push P0): Waves sells genuine one-time
      // palm injections, and coverage matching is by service-type text —
      // an unrelated one-time appointment inside the term window must not
      // be converted to recurring and have its separate billing
      // suppressed. Only a row already attached to THIS term retargets;
      // rows with no identity evidence at all (name-only) remain the
      // original r15 case.
      const committedToTerm = (row) => rowCommittedToTerm(term, row);
      const retargetable = (row) => row && row.id
        && (
          (!row.service_id && !row.service_key_snapshot)
          || (!row.service_id && oneTimePalmSnapshot(row) && committedToTerm(row))
          || (staleOneTimePalmId && row.service_id === staleOneTimePalmId && committedToTerm(row))
        );
      const backfillIds = rows.filter(retargetable).map((row) => row.id);
      if (backfillIds.length) {
        const patch = { service_id: coverageCatalogServiceId };
        if (cols.service_key_snapshot && coverageCatalogKey) patch.service_key_snapshot = coverageCatalogKey;
        await conn('scheduled_services')
          .whereIn('id', backfillIds)
          .where(function retargetScope() {
            this.whereNull('service_id');
            if (staleOneTimePalmId) this.orWhere('service_id', staleOneTimePalmId);
          })
          .update(patch);
      }
      return true;
    } catch (err) {
      logger.error(`[annual-prepay] term ${term.id}: palm coverage identity backfill (${label}) FAILED: ${err.message}`);
      return false;
    }
  };

  // Phase-1 identity backfill — matched/adopted EXISTING rows, BEFORE any
  // seeding or slide persistence (codex r18 pre-push P0): deferring here
  // creates nothing, so the refresh hard-stop leaves no correctly-seeded
  // visit unstamped. Failure files the durable exception and defers; the
  // next idempotent term refresh retries the whole sequence.
  if (coverageCatalogServiceId && cols.service_id) {
    const existingOk = await backfillPalmIdentity(existingRows, 'matched-existing');
    if (!existingOk) {
      await fileCoverageException(term, 'palm_identity_backfill_failed',
        'Adopted palm coverage visits could not be linked to the recurring catalog identity — until the next term refresh succeeds, their completions would bill as one-time work. Re-save the term to retry, or link the visits to Semiannual Palm Injection manually.');
      return {
        createdCount: 0,
        targetDates,
        existingCount: existingRows.length,
        createdRows: [],
        // Original term end — the slide has not persisted yet.
        effectiveTermEnd: termEnd,
        reason: 'palm_identity_backfill_failed',
      };
    }
  }

  // Persist the slid coverage window BEFORE seeding, so the seeded tail is
  // in-window for every downstream consumer (attachScheduledServices,
  // applyPrepaidCoverageForTerm, renewal notices — which correctly move out by
  // the same lag). The in-memory term is mutated too: refreshTermSnapshot
  // passes this same object to the attach/stamp steps that follow.
  if (effectiveTermEnd !== termEnd) {
    await conn('annual_prepay_terms')
      .where({ id: term.id })
      .update({ term_end: effectiveTermEnd, updated_at: new Date() });
    term.term_end = effectiveTermEnd;
    logger.warn(`[annual-prepay] term ${term.id} paid ${anchorLagDays} day(s) after its anchor — coverage window slid to ${effectiveTermEnd} so all ${coverageVisitCount} sold visits stay in-window`);
  }
  // With the window sliding on shift, a shortfall can only mean a deliberately
  // short custom term — pre-existing behavior, surfaced for the operator.
  if (targetDates.length < coverageVisitCount) {
    logger.warn(`[annual-prepay] term ${term.id} only ${targetDates.length} of ${coverageVisitCount} sold visits fit between ${firstTargetDate} and ${dateOnly(term.term_end)} — term needs extending or the remaining visits need manual scheduling`);
    await fileCoverageException(term, 'coverage_shortfall',
      `Only ${targetDates.length} of ${coverageVisitCount} paid visits fit inside the coverage window (through ${dateOnly(term.term_end)}). Extend the term or schedule the remaining visit(s) manually.`);
  }
  // The operator promised a date that had already passed by the time payment
  // landed. The series moved forward instead of seeding a visit that can't be
  // serviced, but somebody has to tell the customer the new date.
  const promisedFirstVisit = dateOnly(term?.first_visit_date);
  if (promisedFirstVisit && firstTargetDate && promisedFirstVisit < today && firstTargetDate !== promisedFirstVisit) {
    logger.warn(`[annual-prepay] term ${term.id} promised first visit ${promisedFirstVisit} had already passed at payment (${today}) — coverage starts ${firstTargetDate} instead; customer needs the new date`);
    await fileCoverageException(term, 'date_passed',
      `The promised first visit (${promisedFirstVisit}) had already passed when payment arrived. Coverage now starts ${firstTargetDate} — confirm the new date with the customer.`);
  }

  const buildInsert = (scheduledDate, windowStart) => {
    const insertData = {
      customer_id: term.customer_id,
      scheduled_date: scheduledDate,
      service_type: coverageServiceType,
      status: 'pending',
      notes: `Annual prepaid ${coverageServiceType} coverage`,
      estimated_duration_minutes: baseDuration,
    };
    if (cols.service_id && coverageCatalogServiceId) insertData.service_id = coverageCatalogServiceId;
    if (cols.service_key_snapshot && coverageCatalogKey) insertData.service_key_snapshot = coverageCatalogKey;
    if (cols.annual_prepay_term_id) insertData.annual_prepay_term_id = term.id;
    if (cols.is_recurring) insertData.is_recurring = true;
    if (cols.recurring_pattern) insertData.recurring_pattern = coverageCadence === 'every_6_weeks' ? 'custom' : coverageCadence;
    if (cols.recurring_interval_days) insertData.recurring_interval_days = coverageCadence === 'every_6_weeks' ? 42 : null;
    if (cols.recurring_ongoing) insertData.recurring_ongoing = false;
    if (cols.recurring_parent_id) {
      if (createdParentId) {
        insertData.recurring_parent_id = createdParentId;
      }
    }
    if (cols.time_window) insertData.time_window = null;
    if (cols.window_start) insertData.window_start = windowStart;
    if (cols.window_end) insertData.window_end = windowStart ? addMinutesHHMM(windowStart, baseDuration) : null;
    if (cols.technician_id) insertData.technician_id = null;
    if (cols.customer_notes) insertData.customer_notes = null;
    if (cols.estimated_price && seededVisitPrice != null) insertData.estimated_price = seededVisitPrice;
    if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = true;
    return insertData;
  };

  // The promise was captured when the invoice was minted; the board may have
  // moved since. The date lock, the conflict read and the timed INSERT must all
  // sit in ONE transaction (occupancy ordering contract) — pg_advisory_xact_lock
  // is transaction-scoped, so checking on a bare connection would release the
  // lock before the insert and let a concurrent booking slip in between. This
  // path is reached from Stripe activation with the root connection, so open a
  // transaction when `conn` isn't already one.
  // r41: resolve → lock → re-resolve — `term` was loaded before any comms
  // fence, so an undo that repointed the journaled term while we waited (or
  // before a try-lock acquire) would seed visits on the stale kept owner
  // with an annual_prepay_term_id the coverage checks then reject. Re-read
  // the owner under the fence; a change defers exactly like a lock miss —
  // the next idempotent term refresh reseeds post-undo.
  const termOwnerMovedUnderFence = async (trx) => {
    // Presence probe (id + owner, distinct alias): a single indexed lookup
    // whose ABSENCE means the term moved or vanished — fail closed either way.
    const fresh = await trx('annual_prepay_terms as apt_owner_probe')
      .where({ id: term.id, customer_id: term.customer_id })
      .first('customer_id');
    if (fresh) return false;
    logger.warn(`[annual-prepay] term ${term.id} owner changed under the comms fence (merge-undo) — deferring visit seeding; the next term refresh retries`);
    await fileCoverageException(term, 'term_owner_changed',
      'A customer-merge undo repointed this term while seeding its visits — seeding deferred; the next term refresh retries automatically. If the visits are still missing tomorrow, re-save the term.');
    return true;
  };

  // Concurrent-adoption filter (codex r18 pre-push P0): same rule as
  // coverageRowsForTerm — a palm row adopted under the occupancy lock
  // must carry the recurring identity or already belong to this term,
  // or a genuine one-time palm appointment on the same day would be
  // swallowed into prepaid coverage.
  const adoptableCoverageRow = (row) => serviceMatchesCoverage(row, coverageServiceType)
    && !rowLinkedToAnotherTerm(term, row)
    && (!coverageIsPalm || (() => {
      // Same ID-FIRST classification as coverage matching (codex r27
      // pre-push P0): a foreign id/snapshot never adopts, even beside a
      // semiannual snapshot.
      if (row.service_id) {
        if (coverageCatalogServiceId && row.service_id === coverageCatalogServiceId) return true;
        if (staleOneTimePalmId && row.service_id === staleOneTimePalmId) return rowCommittedToTerm(term, row);
        return false;
      }
      const snap = String(row.service_key_snapshot || '');
      if (snap === 'palm_injection_semiannual') return true;
      if (snap === 'palm_injection') return rowCommittedToTerm(term, row);
      if (snap) return false;
      return rowCommittedToTerm(term, row);
    })());

  const seedTimedFirstVisit = async (trx, scheduledDate) => {
    let windowStart = firstVisitWindowStart;
    let concurrentAdoptable = null;
    let overlapConflict = null;
    try {
      // SAVEPOINT: Postgres aborts the whole transaction on any statement
      // error, so catching a failed lock/conflict query on `trx` directly would
      // leave it poisoned and take the surrounding payment activation with it.
      // A nested transaction rolls back just this probe. The advisory lock is
      // held by the OUTER transaction once the savepoint commits, so it still
      // covers the insert below.
      await trx.transaction(async (sp) => {
        // TRY-lock, not a blocking acquire: activation already holds
        // invoice/term row locks here, so reaching rung 1 late and WAITING
        // could deadlock against a booking that holds the date lock and wants
        // those rows (AGENTS.md occupancy ordering). Failing to get the lock
        // degrades to a windowless seed (see the catch below) — never a
        // deadlock, never a timed insert behind a writer we could not see.
        const { tryAcquireOccupancyLock } = require('./scheduling/occupancy');
        if (!(await tryAcquireOccupancyLock(sp, scheduledDate))) {
          throw new Error('occupancy date lock unavailable');
        }
        // datesToSeed was computed BEFORE this lock. A concurrent booking or
        // payment sync can have committed an adoptable visit on this exact
        // date in the gap — the conflict filter below would exempt it as
        // adoptable and an unconditional insert would then DUPLICATE it.
        // Re-check under the lock and adopt instead of inserting.
        const sameDay = await sp('scheduled_services')
          .where({ customer_id: term.customer_id, scheduled_date: scheduledDate })
          .whereNotIn('status', Array.from(COVERAGE_EXCLUDED_STATUSES))
          .select('*');
        concurrentAdoptable = (sameDay || []).find((row) => adoptableCoverageRow(row)) || null;
        if (concurrentAdoptable) return;
        const conflict = await findVisitWindowConflict(sp, {
          scheduledDate,
          windowStart,
          durationMinutes: baseDuration,
          adoptableFor: { customerId: term.customer_id, coverageServiceType, isAdoptable: adoptableCoverageRow },
        });
        // ADVISORY (owner ruling 2026-08-27 — schedule overlaps never block
        // or drop a booking): the promised window is kept either way; a hit
        // is surfaced as a coverage exception so the office can eyeball the
        // day's route.
        if (conflict) {
          logger.warn(`[annual-prepay] term ${term.id} first-visit window ${windowStart} on ${scheduledDate} overlaps visit ${conflict.id} — keeping the promised window (overlaps are advisory)`);
          overlapConflict = conflict;
        }
      });
    } catch (err) {
      // A FOUND overlap is advisory (kept above), but an overlap we could
      // not even probe is different: the date lock is held by a concurrent
      // writer whose own capacity check still blocks (public self-booking),
      // and a timed insert behind its probe would commit a second timed
      // visit it never saw (occupancy.js lock contract). Degrade to a
      // windowless seed — the visit still lands on the right date and the
      // exception below tells the office to time it by hand.
      logger.warn(`[annual-prepay] term ${term.id} first-visit overlap probe could not complete (${err.message}) — seeding without a window`);
      windowStart = null;
      // The savepoint died before its adoption recheck ran (e.g. the date
      // lock was held by a concurrent booking — which may be creating exactly
      // the visit we would duplicate). Best-effort unlocked recheck before
      // inserting; a holder that commits after this read can still slip
      // through, but a windowless duplicate beats a skipped visit and the
      // next refresh's tolerance matcher surfaces it.
      try {
        const sameDay = await trx('scheduled_services')
          .where({ customer_id: term.customer_id, scheduled_date: scheduledDate })
          .whereNotIn('status', Array.from(COVERAGE_EXCLUDED_STATUSES))
          .select('*');
        concurrentAdoptable = (sameDay || []).find((row) => adoptableCoverageRow(row)) || null;
      } catch (recheckErr) {
        logger.warn(`[annual-prepay] term ${term.id} post-failure adoption recheck failed (${recheckErr.message})`);
      }
    }
    if (concurrentAdoptable) {
      logger.warn(`[annual-prepay] term ${term.id} found concurrently-created visit ${concurrentAdoptable.id} on ${scheduledDate} under the occupancy lock — adopting it instead of inserting a duplicate`);
      adoptedConcurrentRows.push(concurrentAdoptable);
      return null;
    }
    // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT) — TRY-lock:
    // activation already holds invoice/term row locks, and a merge-undo
    // holds customer-comms while FOR-UPDATE-ing journaled invoices, so a
    // blocking acquire here can deadlock. A miss NEVER seeds unfenced
    // (r27): the undo cannot see the uncommitted visit in its absence
    // probes and buildInsert snapshots neither address nor contacts.
    // Seeding DEFERS instead — ensureCoverageRowsForTerm is idempotent and
    // re-runs on every term refresh (activation retries, renewal sweeps),
    // and the deduped coverage exception keeps it office-visible if no
    // refresh comes.
    if (!(await tryLockCustomerComms(trx, term.customer_id))) {
      logger.warn(`[annual-prepay] term ${term.id} customer-comms lock busy (merge-undo in flight) — deferring visit seeding; the next term refresh retries`);
      await fileCoverageException(term, 'comms_lock_busy',
        'A customer-merge undo was in flight while seeding this term\'s visits — seeding deferred; the next term refresh retries automatically. If the visits are still missing tomorrow, re-save the term.');
      return null;
    }
    if (await termOwnerMovedUnderFence(trx)) return null;
    const [row] = await trx('scheduled_services').insert(buildInsert(scheduledDate, windowStart)).returning('*');
    // Filed only once the visit actually exists: fileCoverageException writes
    // through the global connection and dedupes for 7 days, so a notice
    // emitted before a deferred/aborted insert would outlive the rollback
    // and describe a visit that is not on the calendar.
    const commitScope = conn === db ? trx : conn;
    if (overlapConflict) {
      await fileCoverageExceptionAfterCommit(commitScope, term, 'window_conflict',
        `The promised ${firstVisitWindowStart} arrival on ${scheduledDate} overlaps another job on the schedule. Both are kept on the calendar at their times — confirm the day's route.`);
    } else if (!windowStart && firstVisitWindowStart) {
      await fileCoverageExceptionAfterCommit(commitScope, term, 'window_unverified',
        `The promised ${firstVisitWindowStart} arrival on ${scheduledDate} could not be checked against the schedule while payment landed. The visit is on the schedule without a time — time it by hand.`);
    }
    return row;
  };

  // An adopted promised-date visit satisfied the slot by DATE alone — it can be
  // windowless or sitting at a different hour than the operator quoted. Retime
  // it in place (same lock + conflict shape as the timed insert, the row itself
  // excluded from its own conflict check) so the promise reaches the board.
  // Window only — status/technician stay untouched, and no notification path
  // runs off this direct update.
  // Retiming works with the adopted row's OWN duration — a 90-minute visit
  // retimed to 08:00 must block until 09:30, and window_end must reflect it,
  // or the occupancy predicate would let another job start at 09:00.
  const adoptedDuration = Number(adoptedPromisedRow?.estimated_duration_minutes) > 0
    ? Number(adoptedPromisedRow.estimated_duration_minutes)
    : baseDuration;
  const retimeAdoptedRow = async (trx) => {
    const row = adoptedPromisedRow;
    let windowStart = firstVisitWindowStart;
    let staleAdoption = false;
    let overlapConflict = null;
    try {
      await trx.transaction(async (sp) => {
        // Same late-rung-1 posture as the timed seed: try, never wait.
        const { tryAcquireOccupancyLock } = require('./scheduling/occupancy');
        if (!(await tryAcquireOccupancyLock(sp, promisedTarget))) {
          throw new Error('occupancy date lock unavailable');
        }
        // adoptedPromisedRow is a PRE-lock snapshot. A concurrent reschedule
        // or completion can have moved or closed the row since — updating by
        // id would then stamp the promised time onto a different date (never
        // conflict-checked) or rewrite completed history. Re-read under the
        // lock and abort unless it is still the visit we matched.
        const fresh = await sp('scheduled_services').where({ id: row.id }).first();
        if (!fresh
          || dateOnly(fresh.scheduled_date) !== promisedTarget
          || PREPAID_UPDATE_EXCLUDED_STATUSES.has(String(fresh.status || '').toLowerCase())
          || !serviceMatchesCoverage(fresh, coverageServiceType)) {
          staleAdoption = true;
          return;
        }
        const conflict = await findVisitWindowConflict(sp, {
          scheduledDate: promisedTarget,
          windowStart,
          durationMinutes: adoptedDuration,
          excludeServiceIds: [row.id],
        });
        // ADVISORY (owner ruling 2026-08-27): the adopted visit is retimed
        // to the promise regardless; a hit is filed for the office to see.
        if (conflict) {
          logger.warn(`[annual-prepay] term ${term.id} promised window ${windowStart} on ${promisedTarget} overlaps visit ${conflict.id} — retiming adopted visit ${row.id} anyway (overlaps are advisory)`);
          overlapConflict = conflict;
        }
      });
    } catch (err) {
      // The savepoint died before the identity recheck ran, so the row is
      // unverified — that (not the overlap) is why it is left as-is.
      logger.warn(`[annual-prepay] term ${term.id} adopted-visit recheck failed (${err.message}) — leaving visit ${row.id} as-is`);
      windowStart = null;
    }
    if (staleAdoption) {
      logger.warn(`[annual-prepay] term ${term.id} adopted visit ${row.id} changed under the lock (moved/closed) — leaving it untouched`);
      await fileCoverageException(term, 'adopted_visit_moved',
        `The visit matching the promised first service on ${promisedTarget} was moved or completed while payment landed. Confirm the schedule with the customer.`);
      return;
    }
    if (!windowStart) {
      await fileCoverageException(term, 'adopted_window_unverified',
        `The promised ${firstVisitWindowStart} arrival on ${promisedTarget} could not be applied to the existing visit (the schedule recheck failed). Re-time it by hand.`);
      return;
    }
    const updates = { updated_at: new Date() };
    if (cols.window_start) updates.window_start = windowStart;
    if (cols.window_end) updates.window_end = addMinutesHHMM(windowStart, adoptedDuration);
    // Stale display fields would keep the dispatch board showing the OLD time
    // while occupancy and reminders use the new one — clear them so every
    // surface recomputes from window_start.
    if (cols.time_window) updates.time_window = null;
    if (cols.window_display) updates.window_display = null;
    await trx('scheduled_services').where({ id: row.id }).update(updates);
    // Filed only once the retime is written (same rule as the seed path):
    // the notice claims the visit WAS retimed, so it must never outlive a
    // failed update.
    if (overlapConflict) {
      await fileCoverageExceptionAfterCommit(conn === db ? trx : conn, term, 'adopted_window_conflict',
        `The promised ${firstVisitWindowStart} arrival on ${promisedTarget} overlaps another job on the schedule. The visit was retimed as promised — confirm the day's route.`);
    }
  };
  // Skip when the adopted visit is already completed (or otherwise terminal):
  // annual prepay collected at the completion appointment can adopt the
  // just-serviced row, and rewriting its window would corrupt the recorded
  // history of a job that already happened. Also skip when the promised start
  // leaves no room for the row's own duration before midnight.
  const adoptedRetimeable = adoptedPromisedRow
    && !PREPAID_UPDATE_EXCLUDED_STATUSES.has(String(adoptedPromisedRow.status || '').toLowerCase())
    && !!addMinutesHHMM(firstVisitWindowStart, adoptedDuration);
  if (adoptedRetimeable && firstVisitWindowStart
    && normalizeWindowStart(adoptedPromisedRow.window_start) !== firstVisitWindowStart) {
    if (conn.isTransaction) await retimeAdoptedRow(conn);
    else await conn.transaction((trx) => retimeAdoptedRow(trx));
  }

  for (const scheduledDate of datesToSeed) {
    const wantsWindow = !!firstVisitWindowStart && scheduledDate === firstTargetDate;
    let created;
    if (wantsWindow) {
      created = conn.isTransaction
        ? await seedTimedFirstVisit(conn, scheduledDate)
        : await conn.transaction((trx) => seedTimedFirstVisit(trx, scheduledDate));
    } else if (conn.isTransaction) {
      // Same try-lock DEFER as seedTimedFirstVisit (r27): a miss never
      // seeds unfenced — the date stays unseeded and the next idempotent
      // term refresh seeds it post-undo.
      if (!(await tryLockCustomerComms(conn, term.customer_id))) {
        logger.warn(`[annual-prepay] term ${term.id} customer-comms lock busy (merge-undo in flight) — deferring visit seeding; the next term refresh retries`);
        await fileCoverageException(term, 'comms_lock_busy',
          'A customer-merge undo was in flight while seeding this term\'s visits — seeding deferred; the next term refresh retries automatically. If the visits are still missing tomorrow, re-save the term.');
        created = null;
      } else if (await termOwnerMovedUnderFence(conn)) {
        created = null;
      } else {
        [created] = await conn('scheduled_services').insert(buildInsert(scheduledDate, null)).returning('*');
      }
    } else {
      // Fresh transaction holds nothing yet — a blocking rung-6 acquire is
      // safe here (utils/customer-comms-lock.js).
      [created] = await withCustomerCommsLock(conn, term.customer_id, async (trx) => {
        if (await termOwnerMovedUnderFence(trx)) return [null];
        return trx('scheduled_services').insert(buildInsert(scheduledDate, null)).returning('*');
      });
    }
    if (!created) continue;
    createdRows.push(created);
    if (!createdParentId) {
      createdParentId = created.id;
    }
  }

  // Persist the anchor the seeder ACTUALLY used whenever it differs from what
  // the term fields imply. Every later render of the paid invoice / pay page
  // recomputes the schedule from the term WITHOUT the payment-day floor (a
  // settled document must not drift with the calendar), so a late payment that
  // shifted the series would otherwise display dates that were never created.
  // Best-effort: a failed stamp only affects display, never the schedule.
  if (firstTargetDate && (createdRows.length || adoptedPromisedRow)
    && firstTargetDate !== effectiveFirstVisitDate(term)) {
    try {
      const termCols = await annualPrepayColumns(conn);
      if (termCols.first_visit_date) {
        await conn('annual_prepay_terms')
          .where({ id: term.id })
          .update({ first_visit_date: firstTargetDate, updated_at: new Date() });
      }
    } catch (err) {
      logger.warn(`[annual-prepay] term ${term.id} effective first-visit stamp failed (${err.message}) — paid-invoice dates may not match the seeded schedule`);
    }
  }

  // Register a durable 72h/24h reminder row for each newly-seeded visit in the
  // SAME transaction (a SAVEPOINT, so a reminder hiccup can never roll back the
  // prepay/payment this rides with). Every upcoming visit should get reminders,
  // and these are created here rather than via the normal schedule flow — so
  // register them at birth instead of relying on a backfill. Date-only
  // placeholders default to 08:00 (matching how the scheduler reminds windowless
  // spawns); the time self-corrects if the visit is later given a real window.
  if (createdRows.length) {
    const AppointmentReminders = require('./appointment-reminders');
    for (const created of createdRows) {
      const startHHMM = created.window_start ? String(created.window_start).slice(0, 5) : '08:00';
      try {
        await conn.transaction((sp) =>
          AppointmentReminders.registerVisitReminderInTx(sp, {
            scheduledServiceId: created.id,
            customerId: term.customer_id,
            appointmentTime: `${dateOnly(created.scheduled_date)}T${startHHMM}`,
            serviceType: coverageServiceType,
            source: 'annual_prepay_seed',
          }),
        );
      } catch (err) {
        logger.warn(`[annual-prepay] seeded-visit reminder registration skipped for ${created.id}: ${err.message}`);
      }
    }
  }

  // Phase-2 identity backfill — CONCURRENT adoptions only (codex r18
  // pre-push P0): rows adopted under the occupancy lock mid-loop are not
  // known before seeding. A failure here must NOT hard-stop the refresh —
  // the newly inserted visits carry the correct identity and must still
  // be prepaid-stamped, or completion would invoice a prepaid customer.
  // The unresolved adopted row is quarantined operationally via the
  // durable coverage exception instead.
  if (coverageCatalogServiceId && cols.service_id && adoptedConcurrentRows.length) {
    const concurrentOk = await backfillPalmIdentity(adoptedConcurrentRows, 'concurrent-adoption');
    if (!concurrentOk) {
      await fileCoverageException(term, 'palm_identity_backfill_failed',
        'A concurrently-adopted palm visit could not be linked to the recurring catalog identity — its completion would bill as one-time work. Link the visit to Semiannual Palm Injection manually, or re-save the term to retry.');
      return {
        createdCount: createdRows.length,
        targetDates,
        existingCount: existingRows.length,
        createdRows,
        effectiveTermEnd,
        reason: 'palm_concurrent_backfill_failed',
      };
    }
  }

  return {
    createdCount: createdRows.length,
    targetDates,
    existingCount: existingRows.length,
    createdRows,
    effectiveTermEnd,
  };
}

function noticeColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 30) return 'notice_30_sent_at';
  if (n === 15) return 'notice_15_sent_at';
  if (n === 7) return 'notice_7_sent_at';
  return null;
}

function noticeClaimColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 30) return 'notice_30_claimed_at';
  if (n === 15) return 'notice_15_claimed_at';
  if (n === 7) return 'notice_7_claimed_at';
  return null;
}

function formatDateLabel(ymd) {
  if (!ymd) return '';
  return new Date(`${dateOnly(ymd)}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

function statusAfterDecision(action) {
  if (action === 'renew') return 'renewed';
  if (action === 'cancel') return 'cancelled';
  if (action === 'switch_plan') return 'switch_plan';
  return 'renewal_pending';
}

function invoiceTermStatus(invoice) {
  if (!invoice) return PAYMENT_PENDING_STATUS;
  const status = String(invoice.status || '').toLowerCase();
  if (INVOICE_CANCELLED_STATUSES.has(status)) return 'cancelled';
  if (status === 'paid' || invoice.paid_at) return 'active';
  return PAYMENT_PENDING_STATUS;
}

function parsePaymentMetadata(payment) {
  try {
    return typeof payment?.metadata === 'string'
      ? JSON.parse(payment.metadata || '{}')
      : (payment?.metadata || {});
  } catch {
    return {};
  }
}

async function findInvoiceIdForRefundedPayment(payment, conn = db) {
  const metadata = parsePaymentMetadata(payment);
  let invoiceId = payment?.invoice_id
    || metadata.invoice_id
    || metadata.invoiceId
    || metadata.waves_invoice_id
    || null;
  if (invoiceId) return invoiceId;

  const lookups = [
    ['stripe_payment_intent_id', payment?.stripe_payment_intent_id],
    ['stripe_charge_id', payment?.stripe_charge_id],
  ];
  for (const [column, value] of lookups) {
    if (!value) continue;
    const invoice = await conn('invoices').where({ [column]: value }).first('id');
    if (invoice?.id) return invoice.id;
  }

  return null;
}

function isLastServiceNearTermEnd(term) {
  const termEnd = dateOnly(term.term_end);
  const lastService = dateOnly(term.last_scheduled_service_date);
  const lastServiceToTermEnd = lastService ? daysUntil(lastService, termEnd) : null;
  return lastServiceToTermEnd != null
    && lastServiceToTermEnd >= 0
    && lastServiceToTermEnd <= LAST_SERVICE_TERM_END_LOOKBACK_DAYS;
}

async function findLastScheduledServiceForTerm(customerId, termStart, termEnd, conn = db) {
  if (!customerId || !termStart || !termEnd) return null;
  return conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereBetween('scheduled_date', [termStart, termEnd])
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .orderBy('scheduled_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('id', 'scheduled_date', 'service_type', 'status');
}

async function attachScheduledServices(term, conn = db) {
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !term?.id) return;
  try {
    const coverageServiceType = normalizeCoverageServiceType(term.coverage_service_type);
    const coverageVisitCount = normalizeCoverageVisitCount(term.coverage_visit_count);
    if (coverageServiceType && coverageVisitCount) {
      const rows = await coverageRowsForTerm(term, conn);
      const ids = rows.map((row) => row.id).filter(Boolean);
      if (!ids.length) return;
      await conn('scheduled_services')
        .whereIn('id', ids)
        .where(function () {
          this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
        })
        .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
      return;
    }

    await conn('scheduled_services')
      .where({ customer_id: term.customer_id })
      .whereBetween('scheduled_date', [dateOnly(term.term_start), dateOnly(term.term_end)])
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .where(function () {
        this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
      })
      .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] scheduled service attach skipped: ${err.message}`);
  }
}

async function applyPrepaidCoverageForTerm(term, conn = db) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const totalAmount = Number(term?.prepay_amount);
  if (!term?.id || !coverageServiceType || !coverageVisitCount || !(totalAmount > 0)) {
    return { stampedCount: 0, matchedCount: 0, reason: 'coverage_not_configured' };
  }

  const cols = await scheduledServiceColumns();
  if (!cols.prepaid_amount || !cols.prepaid_method || !cols.prepaid_at) {
    return { stampedCount: 0, matchedCount: 0, reason: 'prepaid_columns_missing' };
  }

  const rows = await coverageRowsForTerm(term, conn);
  const slices = splitCoverageAmount(totalAmount, coverageVisitCount);
  const now = new Date();
  let stampedCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const status = String(row.status || '').toLowerCase();
    if (PREPAID_UPDATE_EXCLUDED_STATUSES.has(status)) continue;
    if (
      row.prepaid_amount != null
      && Number(row.prepaid_amount) > 0
      && (
        // Already covered by a DIFFERENT annual-prepay term.
        (row.annual_prepay_term_id && String(row.annual_prepay_term_id) !== String(term.id))
        // OR independently prepaid (cash/Zelle/etc.) through the regular schedule
        // route — attachScheduledServices may have linked it to this term, but its
        // stamp is a real out-of-band payment. Don't overwrite the method, or the
        // void/unflag cleanup (method-scoped) would later clear an already-collected
        // visit and completion billing would re-invoice it.
        || (row.prepaid_method && row.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD)
      )
    ) {
      continue;
    }

    const visitAmount = slices[index] ?? slices[0] ?? 0;
    const updates = {
      prepaid_amount: visitAmount,
      prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD,
      prepaid_note: `Annual prepaid ${coverageServiceType} (${index + 1} of ${coverageVisitCount})`,
      prepaid_at: row.prepaid_at || now,
    };
    if (cols.annual_prepay_term_id) updates.annual_prepay_term_id = term.id;
    if (cols.updated_at) updates.updated_at = now;

    const updated = await conn('scheduled_services')
      .where({ id: row.id })
      .update(updates)
      .returning(['id']);
    if (Array.isArray(updated) ? updated.length > 0 : updated) stampedCount++;
  }

  return {
    stampedCount,
    matchedCount: rows.length,
    expectedVisitCount: coverageVisitCount,
    perVisitAmount: slices[0] || 0,
  };
}

// A covered-window visit that COMPLETED before the prepay invoice was paid
// billed per application (owner ruling: the pending window bills normally) —
// but the paid annual still prices that visit's slice, and
// applyPrepaidCoverageForTerm deliberately skips completed rows, so without
// reconciliation the customer pays that visit twice: once per-visit, once
// inside the annual. Runs on payment sync for every live term (idempotent —
// the settle no-ops on already-covered invoices and the credit is
// ledger-deduped per term+visit):
//   - completion invoice still OPEN → settle it as coverage (the paid annual
//     IS that visit's payment; settleInvoiceAsAnnualPrepayCovered runs the
//     full PI triage and refuses money-in-flight / paid shapes).
//   - completion invoice PAID / money in flight / settle refused → the annual
//     over-collected exactly that visit's slice: return the slice as account
//     credit.
//   - never invoiced, or invoice voided/refunded → nothing was collected for
//     the visit, so the annual slice IS its payment — no action.
// Best-effort: a failure here must never block the payment sync itself.
const PENDING_COMPLETION_CREDIT_BY = 'system:annual_prepay_pending_completion';

async function reconcilePendingWindowCompletions(term, conn = db) {
  const summary = { settled: 0, credited: 0 };
  try {
    const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
    const totalAmount = Number(term?.prepay_amount);
    if (!term?.id || !term.customer_id || !coverageVisitCount || !(totalAmount > 0)) return summary;
    const rows = await coverageRowsForTerm(term, conn);
    const slices = splitCoverageAmount(totalAmount, coverageVisitCount);
    // This term's OWN prepay invoice, resolved once for the self-referential
    // guard below. `undefined` means the caller handed us a partial term row
    // that never selected the column — that must NOT read as "this term has
    // no prepay invoice", which would silently fail the guard OPEN and mint
    // the very credit it exists to prevent. Every caller passes a full row
    // today; this keeps a future partial select from re-opening the bug.
    let prepayInvoiceId = term.prepay_invoice_id;
    if (prepayInvoiceId === undefined) {
      const fullTerm = await conn('annual_prepay_terms')
        .where({ id: term.id })
        .first('prepay_invoice_id');
      prepayInvoiceId = fullTerm ? fullTerm.prepay_invoice_id : null;
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (String(row.status || '').toLowerCase() !== 'completed') continue;
      // Slice already delivered as coverage (stamped while scheduled, or
      // settled at completion by the active-term dispatch path).
      if (row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD
        && String(row.annual_prepay_term_id || '') === String(term.id)) continue;
      const invoice = await conn('invoices')
        .where({ scheduled_service_id: row.id })
        .whereNotIn('status', ['void', 'canceled', 'cancelled', 'refunded'])
        .orderBy('created_at', 'desc')
        .first();
      if (!invoice) continue;
      // SELF-REFERENTIAL: the visit's invoice IS this term's own prepay
      // invoice. A same-day close bills the completed first visit and sells
      // the annual on ONE invoice — the prepay invoice carries the visit's
      // scheduled_service_id, so the lookup above finds it and its 'paid'
      // status reads as "the visit was separately collected on top of the
      // annual". It wasn't: that payment IS the annual. Crediting the slice
      // here hands back money the customer never paid twice, and settling it
      // would mark the term's own prepay invoice as covered by that term.
      // Compare against the TERM's prepay_invoice_id, not the invoice's
      // annual_prepay_term_id — that column is null on some prepay invoices
      // (verified against prod), so the invoice-side check would miss them.
      if (prepayInvoiceId && String(invoice.id) === String(prepayInvoiceId)) continue;
      // Payer-billed visit: the money (owed or collected) is the PAYER's AR,
      // not the homeowner's — settling it as homeowner coverage or crediting
      // the homeowner a slice for the payer's money are both wrong. The
      // settle helper refuses payer invoices already; skip before the credit
      // leg too and leave the slice for operator follow-up.
      if (invoice.payer_id) {
        logger.warn(`[annual-prepay] pending-completion slice for visit ${row.id} skipped — invoice ${invoice.id} is payer-billed; operator follow-up needed`);
        continue;
      }
      const invoiceStatus = String(invoice.status || '').toLowerCase();
      // Coverage-settled by a prepay term (this or another) — delivered; the
      // refund reopen path owns any reversal. A bare 'prepaid' WITHOUT the
      // coverage marker is different: the account-credit seam flips fully
      // credit-covered invoices to 'prepaid', which CONSUMED the customer's
      // real credit for the visit — that collects money and the annual's
      // slice must still come back below.
      if (invoice.annual_prepay_covered_term_id) continue;
      let settledHere = false;
      const paidForVisit = invoiceStatus === 'paid' || invoiceStatus === 'prepaid';
      // A recorded payment on a still-OPEN invoice is a PARTIAL collection:
      // the in-person prepay application (admin-schedule) reduces the total
      // and stamps payment_recorded_at while leaving the remainder
      // collectible. That's neither fully collected (crediting the whole
      // slice would over-credit a partly-paid visit) nor settleable (the
      // settle helper refuses invoices with payments applied) — leave it
      // unresolved like the other in-flight shapes; when the remainder
      // resolves, the invoice flips 'paid' and the payment webhook re-enters
      // this reconcile.
      const partiallyCollected = !paidForVisit && !!invoice.payment_recorded_at;
      if (!paidForVisit && !partiallyCollected && invoiceStatus !== 'processing') {
        try {
          const res = await require('./invoice').settleInvoiceAsAnnualPrepayCovered(invoice.id, term.id);
          if (res?.settled) { summary.settled += 1; settledHere = true; }
        } catch (err) {
          logger.warn(`[annual-prepay] pending-completion settle failed for invoice ${invoice.id}: ${err.message}`);
        }
      }
      if (settledHere) continue;
      // Only money actually COLLECTED for the visit justifies returning the
      // annual's slice: a 'processing' ACH/card can still fail, and a
      // settle-refused open invoice (add-ons / deposit credit / payer) may
      // yet be voided — crediting now could hand back a slice for a visit
      // the customer never pays. Leave those rows alone; the payment
      // webhook re-enters this reconcile when the invoice resolves.
      if (!paidForVisit) {
        logger.warn(`[annual-prepay] pending-completion slice unresolved for visit ${row.id} (invoice ${invoice.id} status=${invoiceStatus}) — will reconcile when the invoice resolves`);
        continue;
      }
      // Stripe PARTIAL refunds leave the invoice 'paid' — the refund state
      // lives on the payment rows (refund_status/refund_amount; the webhook
      // only flips invoices.status on FULL refunds, which the reversal hook
      // owns). Any refund signal on the visit's payments means the amount
      // actually collected is less than the invoice says: crediting the full
      // slice would over-credit, and the right partial amount is an operator
      // judgment — leave it for follow-up. Fail-closed: if the check itself
      // errors, don't credit on uncertain money.
      try {
        const refundActivity = await conn('payments')
          .where(function linkedToInvoice() {
            this.whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [invoice.id]);
            if (invoice.stripe_payment_intent_id) this.orWhere('stripe_payment_intent_id', invoice.stripe_payment_intent_id);
            if (invoice.stripe_charge_id) this.orWhere('stripe_charge_id', invoice.stripe_charge_id);
          })
          .where(function refundSignal() {
            this.where('status', 'refunded')
              .orWhereNotNull('refund_status')
              .orWhere('refund_amount', '>', 0);
          })
          .first('id');
        if (refundActivity) {
          logger.warn(`[annual-prepay] pending-completion slice for visit ${row.id} skipped — invoice ${invoice.id} has refund activity on its payments; operator follow-up needed`);
          continue;
        }
      } catch (err) {
        logger.warn(`[annual-prepay] pending-completion refund check failed for invoice ${invoice.id}: ${err.message} — slice left unresolved`);
        continue;
      }
      const visitSlice = slices[index] ?? slices[0] ?? 0;
      if (!(visitSlice > 0)) continue;
      const marker = `term ${term.id}, visit ${row.id}`;
      try {
        // Atomic once-only credit: take the SAME customer row lock
        // postCreditMovement writes under BEFORE the marker lookup, so two
        // concurrent payment syncs serialize here — the second waits on the
        // lock, then sees the first's ledger row and skips. A dedupe check
        // outside the lock could pass on both and double-credit.
        const creditOnce = async (t) => {
          await t('customers').where({ id: term.customer_id }).forUpdate().first('id');
          const dup = await t('customer_credit_ledger')
            .where({ customer_id: term.customer_id, created_by: PENDING_COMPLETION_CREDIT_BY })
            .where('note', 'like', `%${marker}%`)
            .first('id');
          if (dup) return false;
          const { postCreditMovement } = require('./customer-credit');
          await postCreditMovement({
            customerId: term.customer_id,
            delta: visitSlice,
            source: 'adjustment',
            invoiceId: invoice.id,
            note: `Annual prepay paid after this visit already billed — the visit's prepay share returned as account credit (${marker})`,
            createdBy: PENDING_COMPLETION_CREDIT_BY,
          }, t);
          return true;
        };
        const credited = conn === db ? await db.transaction(creditOnce) : await creditOnce(conn);
        if (credited) summary.credited += 1;
      } catch (err) {
        logger.warn(`[annual-prepay] pending-completion credit skipped for visit ${row.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[annual-prepay] pending-window completion reconcile skipped for term ${term?.id}: ${err.message}`);
  }
  return summary;
}

// Runs the pending-window reconcile for a term that is ACTIVE at
// creation/refresh time (born already paid). The reconcile's settle leg
// (settleInvoiceAsAnnualPrepayCovered) opens its own global-pool transaction
// and Stripe PI triage, so INSIDE a caller transaction it would stamp
// annual_prepay_covered_term_id against a term row that transaction hasn't
// committed yet — the FK check blocks/fails, the error is swallowed, and the
// covered visit invoice stays collectible. Defer to after the caller's commit
// (trx.executionPromise, the dispatch-alerts pattern); a rollback drops the
// work along with the term. On the global pool it runs inline.
function reconcileBornPaidTerm(term, conn) {
  if (conn === db) return reconcilePendingWindowCompletions(term, db);
  if (conn?.executionPromise) {
    conn.executionPromise
      .then(() => reconcilePendingWindowCompletions(term, db))
      .catch(() => {}); // rolled back — the term never existed
    return Promise.resolve({ settled: 0, credited: 0, deferred: true });
  }
  // No commit hook on this connection (test harness?). The reconcile is
  // idempotent and re-validates every row live, so run it on the pool.
  logger.warn(`[annual-prepay] caller trx has no executionPromise — running born-paid reconcile inline for term ${term?.id}`);
  return reconcilePendingWindowCompletions(term, db);
}

// Refunding/voiding the annual prepay invoice must also claw back any
// pending-window completion credits it issued — the refund returns the FULL
// annual, so a kept visit-slice credit would refund that slice twice.
// Ledger-deduped per original credit's term+visit marker, under the same
// customer row lock the grants use. Reversal is capped at the balance still
// available: credit the customer already SPENT can't be pulled from a
// non-negative balance — reverse what remains and warn the shortfall for
// operator follow-up (a partial reversal still writes its dedupe row, so a
// later retry never claws back more).
const PENDING_COMPLETION_REVERSAL_BY = 'system:annual_prepay_pending_completion_reversal';
// The self-referential backfill (migration 20260808040000) reverses the same
// grants under its OWN identity. This path must count those as already
// reversed: without it, a later refund of the annual would find the original
// positive credit still sitting in the ledger and claw the SAME slice back a
// second time. The migration is frozen and cannot import this constant — the
// literal is duplicated there and pinned by a test in
// annual-prepay-renewals.test.js, so the two can never drift apart.
const PENDING_COMPLETION_BACKFILL_BY = 'system:annual_prepay_self_referential_credit_backfill';
const PENDING_COMPLETION_REVERSAL_IDENTITIES = [
  PENDING_COMPLETION_REVERSAL_BY,
  PENDING_COMPLETION_BACKFILL_BY,
];

async function reversePendingWindowCompletionCredits(term, conn = db, { visitId = null } = {}) {
  let reversedCount = 0;
  try {
    if (!term?.id || !term.customer_id) return reversedCount;
    const work = async (t) => {
      const customer = await t('customers')
        .where({ id: term.customer_id })
        .forUpdate()
        .first('id', 'account_credits');
      if (!customer) return;
      let balance = Number(customer.account_credits) || 0;
      const credits = await t('customer_credit_ledger')
        .where({ customer_id: term.customer_id, created_by: PENDING_COMPLETION_CREDIT_BY })
        // visitId narrows to ONE visit's credit (visit-invoice refund path);
        // without it, every credit the term issued reverses (prepay refund).
        .where('note', 'like', visitId ? `%term ${term.id}, visit ${visitId})%` : `%term ${term.id},%`)
        .where('delta', '>', 0)
        .select('*');
      if (!credits.length) return;
      const reversalNotes = (await t('customer_credit_ledger')
        .where({ customer_id: term.customer_id })
        .whereIn('created_by', PENDING_COMPLETION_REVERSAL_IDENTITIES)
        .select('note')).map((r) => String(r.note || ''));
      const { postCreditMovement } = require('./customer-credit');
      for (const credit of credits) {
        const markerMatch = String(credit.note || '').match(/\(term [^)]*\)/);
        const marker = markerMatch ? markerMatch[0] : `(term ${term.id}, ledger ${credit.id})`;
        if (reversalNotes.some((note) => note.includes(marker))) continue;
        const creditAmount = Number(credit.delta) || 0;
        const reverseAmount = Math.min(balance, creditAmount);
        if (!(reverseAmount > 0)) {
          logger.warn(`[annual-prepay] pending-completion credit ${marker} not reversible — balance exhausted (customer ${term.customer_id}); operator follow-up needed`);
          // The dedupe row must still be written: refund syncs replay (Stripe
          // webhook retries, admin re-records), and without a marker a later
          // retry that runs AFTER unrelated credit lands would claw this
          // already-spent slice out of that new balance. postCreditMovement
          // rejects zero deltas, so write the audit row directly — same trx,
          // customer row already locked above, balance unchanged.
          await t('customer_credit_ledger').insert({
            customer_id: term.customer_id,
            delta: 0,
            balance_after: balance,
            source: 'adjustment',
            invoice_id: credit.invoice_id || null,
            note: `Annual prepay refunded — the visit's pending-completion credit was already spent; nothing reversed, operator follow-up needed ${marker}`,
            created_by: PENDING_COMPLETION_REVERSAL_BY,
          });
          continue;
        }
        if (reverseAmount < creditAmount) {
          logger.warn(`[annual-prepay] pending-completion credit ${marker} only partially reversible ($${reverseAmount.toFixed(2)} of $${creditAmount.toFixed(2)}) — balance exhausted; operator follow-up needed`);
        }
        await postCreditMovement({
          customerId: term.customer_id,
          delta: -reverseAmount,
          source: 'adjustment',
          invoiceId: credit.invoice_id || null,
          note: `Annual prepay refunded — reversing the visit's pending-completion credit ${marker}`,
          createdBy: PENDING_COMPLETION_REVERSAL_BY,
        }, t);
        balance -= reverseAmount;
        reversedCount += 1;
      }
    };
    if (conn === db) await db.transaction(work); else await work(conn);
  } catch (err) {
    logger.warn(`[annual-prepay] pending-completion credit reversal skipped for term ${term?.id}: ${err.message}`);
  }
  return reversedCount;
}

// WaveGuard tier-extension prepaid-difference credits (the extension apply
// mints one grant PER TERM, marker "(term <id>, estimate <id>)", identity
// shared via customer-credit.js). A refunded prepay term must claw its
// grant back — the full-annual refund returns the money the discounted
// allocation was carved from, so a kept credit would pay the tier savings
// twice. Same discipline as the pending-completion reversal above:
// customer row lock, marker-based dedupe (replay-safe against webhook
// retries and admin re-records), balance-capped with a zero-delta dedupe
// row when the credit was already spent. Term-level only by design: a
// single covered VISIT refunding does not unwind the tier extension — the
// term still stands, so there is no visitId narrowing here.
// Per-marker event log: every ledger row of the three class identities that
// carries the marker, oldest first. The LAST event decides what may run
// next — grant/restore (positive) → clawable; reversal (negative or the
// zero-delta exhausted row) → restorable — which keeps arbitrary
// refund → claw → repay → restore → refund cycles correct where a simple
// "reversal marker exists" dedupe would go one-shot.
async function extensionMarkerEvents(t, customerId, marker) {
  const {
    WAVEGUARD_EXTENSION_CREDIT_BY,
    WAVEGUARD_EXTENSION_REVERSAL_BY,
    WAVEGUARD_EXTENSION_RESTORE_BY,
  } = require('./customer-credit');
  // Chronology comes from created_at — ledger ids are RANDOM UUIDs, so
  // ordering by id would shuffle the event log. And because the column
  // DEFAULT now() is transaction-START time (an early-started txn that
  // commits late would stamp its event older than one it followed),
  // every writer of these three classes insert-order-stamps created_at
  // with clock_timestamp() taken while holding the customer row FOR
  // UPDATE — lock-acquisition order IS event order. The id tie-break
  // only makes a same-microsecond fluke deterministic.
  const rows = await t('customer_credit_ledger')
    .where({ customer_id: customerId })
    .whereIn('created_by', [
      WAVEGUARD_EXTENSION_CREDIT_BY,
      WAVEGUARD_EXTENSION_REVERSAL_BY,
      WAVEGUARD_EXTENSION_RESTORE_BY,
    ])
    .where('note', 'like', `%${marker}%`)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('*');
  return rows;
}

async function reverseWaveguardExtensionCredits(term, conn = db) {
  let reversedCount = 0;
  try {
    if (!term?.id || !term.customer_id) return reversedCount;
    const {
      postCreditMovement,
      WAVEGUARD_EXTENSION_CREDIT_BY,
      WAVEGUARD_EXTENSION_REVERSAL_BY,
    } = require('./customer-credit');
    const work = async (t) => {
      const customer = await t('customers')
        .where({ id: term.customer_id })
        .forUpdate()
        .first('id', 'account_credits');
      if (!customer) return;
      let balance = Number(customer.account_credits) || 0;
      const credits = await t('customer_credit_ledger')
        .where({ customer_id: term.customer_id, created_by: WAVEGUARD_EXTENSION_CREDIT_BY })
        .where('note', 'like', `%term ${term.id},%`)
        .where('delta', '>', 0)
        .select('*');
      // Legacy-shape park (guards P0): the pre-guards writer minted ONE
      // aggregate grant naming every term ("(estimate #…; terms: a, b)") —
      // per-term clawback cannot honestly slice it, so it PARKS for the
      // operator instead of being silently skipped. Prod carries zero rows
      // of this class (gate never enabled — verified 2026-08-11), so this
      // is belt-and-braces, deduped by its own marker row.
      const legacyGrants = await t('customer_credit_ledger')
        .where({ customer_id: term.customer_id, created_by: WAVEGUARD_EXTENSION_CREDIT_BY })
        .whereNot('note', 'like', '%(term %')
        .where('note', 'like', `%${term.id}%`)
        .where('delta', '>', 0)
        .select('*');
      for (const legacy of legacyGrants) {
        const parkMarker = `(term ${term.id}, legacy ledger ${legacy.id})`;
        const priorPark = await t('customer_credit_ledger')
          .where({ customer_id: term.customer_id, created_by: WAVEGUARD_EXTENSION_REVERSAL_BY })
          .where('note', 'like', `%${parkMarker}%`)
          .first('id');
        if (priorPark) continue;
        logger.warn(`[annual-prepay] legacy aggregate WaveGuard extension credit ${legacy.id} names refunded term ${term.id} — cannot auto-reverse per-term; operator review needed`);
        await t('customer_credit_ledger').insert({
          customer_id: term.customer_id,
          delta: 0,
          balance_after: balance,
          source: 'adjustment',
          invoice_id: legacy.invoice_id || null,
          note: `Annual prepay refunded — a legacy aggregate WaveGuard extension credit names this term and cannot be auto-reversed per-term; operator review needed ${parkMarker}`,
          created_by: WAVEGUARD_EXTENSION_REVERSAL_BY,
          created_at: t.raw('clock_timestamp()'), // insert-order stamp — see extensionMarkerEvents
        });
      }
      if (!credits.length) return;
      for (const credit of credits) {
        const markerMatch = String(credit.note || '').match(/\(term [^)]*\)/);
        const marker = markerMatch ? markerMatch[0] : `(term ${term.id}, ledger ${credit.id})`;
        const events = await extensionMarkerEvents(t, term.customer_id, marker);
        const last = events[events.length - 1];
        // Clawable only when the marker's last event is a GRANT or a
        // RESTORE. A reversal-last marker (including the zero-delta
        // exhausted row) is settled until a repayment restore re-opens it.
        if (last && last.created_by === WAVEGUARD_EXTENSION_REVERSAL_BY) continue;
        const outstanding = last ? Number(last.delta) || 0 : Number(credit.delta) || 0;
        if (!(outstanding > 0)) continue;
        const reverseAmount = Math.min(balance, outstanding);
        if (!(reverseAmount > 0)) {
          logger.warn(`[annual-prepay] WaveGuard extension credit ${marker} not reversible — balance exhausted (customer ${term.customer_id}); operator follow-up needed`);
          // Settlement row even when nothing reverses — the credit was
          // already SPENT toward bills, so a replayed refund sync must not
          // claw the slice out of unrelated later credit, and a repayment
          // restore must not re-grant value the customer consumed.
          // postCreditMovement rejects zero deltas, so write the audit row
          // directly — same trx, customer row locked.
          await t('customer_credit_ledger').insert({
            customer_id: term.customer_id,
            delta: 0,
            balance_after: balance,
            source: 'adjustment',
            invoice_id: credit.invoice_id || null,
            note: `Annual prepay refunded — the WaveGuard extension credit was already spent; nothing reversed, operator follow-up needed ${marker}`,
            created_by: WAVEGUARD_EXTENSION_REVERSAL_BY,
            created_at: t.raw('clock_timestamp()'), // insert-order stamp — see extensionMarkerEvents
          });
          continue;
        }
        if (reverseAmount < outstanding) {
          logger.warn(`[annual-prepay] WaveGuard extension credit ${marker} only partially reversible ($${reverseAmount.toFixed(2)} of $${outstanding.toFixed(2)}) — balance exhausted; operator follow-up needed`);
        }
        await postCreditMovement({
          customerId: term.customer_id,
          delta: -reverseAmount,
          source: 'adjustment',
          invoiceId: credit.invoice_id || null,
          note: `Annual prepay refunded — reversing the WaveGuard extension credit ${marker}`,
          createdBy: WAVEGUARD_EXTENSION_REVERSAL_BY,
          stampInsertOrder: true,
        }, t);
        balance -= reverseAmount;
        reversedCount += 1;
      }
    };
    // Best-effort demands a SAVEPOINT on a caller's transaction (pre-push
    // P1, codex r5 round): the catch below swallows, but a failed statement
    // leaves a raw caller trx ABORTED — every later statement in that
    // transaction then fails while this helper reports a quiet no-op.
    // conn.transaction() on a knex trx is a savepoint: the failure rolls
    // back to it and the caller's transaction stays healthy.
    if (conn === db) await db.transaction(work);
    else if (conn.isTransaction) await conn.transaction(work);
    else await work(conn);
  } catch (err) {
    logger.warn(`[annual-prepay] WaveGuard extension credit reversal skipped for term ${term?.id}: ${err.message}`);
  }
  return reversedCount;
}

// Repayment restore (guards P0 counterpart to the clawback): a refunded
// prepay invoice that is PAID AGAIN (lost-dispute revival — active and
// decided paths alike) restores coverage, stamps, and billing mode, so the
// clawed extension credit comes back with them. Restores exactly what the
// reversal actually took (a partial claw restores the partial; the
// zero-delta exhausted row restores nothing — that value was already spent
// toward bills before the refund). Idempotent by the same last-event rule
// the clawback uses: only a reversal-last marker is restorable.
async function restoreWaveguardExtensionCredits(term, conn = db) {
  let restoredCount = 0;
  try {
    if (!term?.id || !term.customer_id) return restoredCount;
    const {
      postCreditMovement,
      WAVEGUARD_EXTENSION_REVERSAL_BY,
      WAVEGUARD_EXTENSION_RESTORE_BY,
    } = require('./customer-credit');
    const work = async (t) => {
      const customer = await t('customers')
        .where({ id: term.customer_id })
        .forUpdate()
        .first('id');
      if (!customer) return;
      const reversals = await t('customer_credit_ledger')
        .where({ customer_id: term.customer_id, created_by: WAVEGUARD_EXTENSION_REVERSAL_BY })
        .where('note', 'like', `%term ${term.id},%`)
        .select('*');
      if (!reversals.length) return;
      const seenMarkers = new Set();
      for (const reversal of reversals) {
        const markerMatch = String(reversal.note || '').match(/\(term [^)]*\)/);
        if (!markerMatch) continue;
        const marker = markerMatch[0];
        if (marker.includes('legacy ledger')) continue; // parked, operator-owned
        if (seenMarkers.has(marker)) continue;
        seenMarkers.add(marker);
        const events = await extensionMarkerEvents(t, term.customer_id, marker);
        const last = events[events.length - 1];
        if (!last || last.created_by !== WAVEGUARD_EXTENSION_REVERSAL_BY) continue;
        // Sum what the claw actually took since the last grant/restore —
        // walking back stops at the first positive-class event.
        let clawed = 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const row = events[i];
          if (row.created_by === WAVEGUARD_EXTENSION_REVERSAL_BY) {
            clawed = Math.round((clawed + Math.max(0, -(Number(row.delta) || 0))) * 100) / 100;
          } else break;
        }
        if (!(clawed > 0)) continue;
        await postCreditMovement({
          customerId: term.customer_id,
          delta: clawed,
          source: 'adjustment',
          invoiceId: reversal.invoice_id || null,
          note: `Annual prepay re-paid — restoring the WaveGuard extension credit ${marker}`,
          createdBy: WAVEGUARD_EXTENSION_RESTORE_BY,
          stampInsertOrder: true,
        }, t);
        restoredCount += 1;
      }
    };
    // Savepoint on a caller's transaction — same reasoning as the reversal
    // helper above (pre-push P1, codex r5 round): a swallowed failure must
    // not leave the owning transaction aborted.
    if (conn === db) await db.transaction(work);
    else if (conn.isTransaction) await conn.transaction(work);
    else await work(conn);
  } catch (err) {
    logger.warn(`[annual-prepay] WaveGuard extension credit restore skipped for term ${term?.id}: ${err.message}`);
  }
  return restoredCount;
}

// A dispute on the annual-prepay invoice restores a prior-monthly customer to
// monthly billing (mid-dispute visits must not go out free — GUARD 5 excludes
// dispute-suspended terms), so the monthly cron legitimately collects dues
// while the dispute is open. A WON dispute / re-collection reinstates the
// annual for the same coverage window, so dues collected during the dispute
// double-charge the covered months (Codex #2533 round-3 P1) — return them as
// account credit. Dues payments are matched the same way the cron's own
// already-charged dedupe matches them: metadata.billed_month stamp bounded to
// the term's obligation months, with the legacy description fallback for
// pre-stamp rows; both bounded to the dispute window (dispute_suspended_at →
// now, so an earlier legitimately-billed month can never claw back). Only
// 'paid' collections credit — a 'processing' ACH can still fail, so it defers
// (pending) and the caller keeps the dispute marker; the daily sweep re-enters
// until it resolves. Refund-touched dues rows go to operator follow-up (the
// collectible amount is a judgment call), same as the visit-slice leg.
// Ledger-deduped per term+payment under the customer row lock, same
// atomic-once shape as the pending-completion grants.
const DISPUTE_DUES_CREDIT_BY = 'system:annual_prepay_dispute_dues';

async function reconcileDisputeWindowMonthlyDues(term, conn = db) {
  const summary = { credited: 0, pending: 0 };
  try {
    if (!term?.id || !term.customer_id || !term.dispute_suspended_at) return summary;
    // ET calendar date, NOT dateOnly (Codex round-5 P2): the marker is a
    // timestamptz, and an ET-evening suspension has already rolled to the
    // next UTC day — dateOnly would start the window one day late while
    // payments.payment_date is an ET calendar date, silently skipping dues
    // collected later that same ET evening (and the marker clear would then
    // lose them for good).
    const disputeStartRaw = term.dispute_suspended_at instanceof Date
      ? term.dispute_suspended_at
      : new Date(term.dispute_suspended_at);
    const disputeStartDate = Number.isNaN(disputeStartRaw.getTime()) ? null : etDateString(disputeStartRaw);
    const termEndDate = dateOnly(term.term_end);
    const termStartMonth = String(dateOnly(term.term_start) || '').slice(0, 7);
    const termEndMonth = String(termEndDate || '').slice(0, 7);
    if (!disputeStartDate || !termEndDate || !termStartMonth || !termEndMonth) return summary;
    const duesRows = await conn('payments')
      .where({ customer_id: term.customer_id })
      .whereIn('status', ['paid', 'processing'])
      .where('payment_date', '>=', disputeStartDate)
      // Upper bound = term_end (Codex round-4 P2): a dues charge is only a
      // double-charge if GUARD 4 would have suppressed it absent the
      // dispute, and GUARD 4 only suppresses while coverage is in force —
      // dues collected AFTER term_end were owed regardless (post-coverage
      // service; the cron bills them even with a live term behind it).
      // This also gives the legacy description match, which has no month
      // stamp to bound on, its upper bound. Deliberately conservative: a
      // retry-ladder collection that lands just past term_end for an
      // in-coverage obligation month is left for operator judgment rather
      // than risking a claw-back of legitimately-owed money.
      .where('payment_date', '<=', termEndDate)
      .where(function duesShape() {
        this.where(function stampedDues() {
          this.whereRaw("metadata->>'billed_month' >= ?", [termStartMonth])
            .whereRaw("metadata->>'billed_month' <= ?", [termEndMonth]);
        }).orWhere(function legacyDues() {
          this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
            .where('description', 'like', '%WaveGuard Monthly%');
        });
      })
      .select('id', 'status', 'amount', 'payment_date', 'refund_status', 'refund_amount');
    for (const dues of duesRows) {
      if (String(dues.status || '').toLowerCase() !== 'paid') {
        logger.warn(`[annual-prepay] dispute-window dues payment ${dues.id} still ${dues.status} — credit deferred until it resolves`);
        summary.pending += 1;
        continue;
      }
      if (dues.refund_status || Number(dues.refund_amount) > 0) {
        logger.warn(`[annual-prepay] dispute-window dues payment ${dues.id} has refund activity — operator follow-up needed, not auto-credited`);
        continue;
      }
      const amount = Number(dues.amount) || 0;
      if (!(amount > 0)) continue;
      const marker = `(term ${term.id}, dues payment ${dues.id})`;
      const creditOnce = async (t) => {
        await t('customers').where({ id: term.customer_id }).forUpdate().first('id');
        const dup = await t('customer_credit_ledger')
          .where({ customer_id: term.customer_id, created_by: DISPUTE_DUES_CREDIT_BY })
          .where('note', 'like', `%${marker}%`)
          .first('id');
        if (dup) return false;
        const { postCreditMovement } = require('./customer-credit');
        await postCreditMovement({
          customerId: term.customer_id,
          delta: amount,
          source: 'adjustment',
          note: `Annual prepay reinstated after dispute — monthly dues collected during the dispute window returned as account credit ${marker}`,
          createdBy: DISPUTE_DUES_CREDIT_BY,
        }, t);
        return true;
      };
      try {
        const credited = conn === db ? await db.transaction(creditOnce) : await creditOnce(conn);
        if (credited) summary.credited += 1;
      } catch (err) {
        logger.warn(`[annual-prepay] dispute-window dues credit skipped for payment ${dues.id}: ${err.message}`);
        summary.pending += 1;
      }
    }
  } catch (err) {
    logger.warn(`[annual-prepay] dispute-window dues reconcile skipped for term ${term?.id}: ${err.message}`);
    summary.pending += 1;
  }
  return summary;
}

// Shared tail of every dispute-recovery path (won-dispute reactivation,
// decided-coverage restore, daily sweep): claw back dispute-window dues,
// then — only when nothing deferred — clear the dispute marker. Keeping the
// marker until the follow-ups run clean is what makes the recovery
// re-enterable: a crash, a swallowed error, or an in-flight ACH leaves the
// marker in place and the next sync / daily sweep finishes the job.
async function finishDisputeRecoveryForTerm(term, conn = db) {
  const summary = { credited: 0, pending: 0 };
  if (!term?.id || !term.dispute_suspended_at) return summary;
  const dues = await reconcileDisputeWindowMonthlyDues(term, conn);
  summary.credited += dues.credited;
  summary.pending += dues.pending;
  if (!summary.pending) {
    try {
      await conn('annual_prepay_terms')
        .where({ id: term.id })
        .update({ dispute_suspended_at: null, updated_at: new Date() });
    } catch (err) {
      logger.warn(`[annual-prepay] dispute marker clear skipped for term ${term.id}: ${err.message}`);
    }
  }
  return summary;
}

// When a paid prepay invoice is voided/refunded the term flips to 'cancelled',
// but its not-yet-completed covered visits keep the per-visit prepaid_amount
// stamp that suppresses completion billing — so they'd be serviced free even
// though coverage was cancelled. Clear the stamps on those future visits so they
// bill normally again. Completed/terminal visits (PREPAID_UPDATE_EXCLUDED_STATUSES)
// are left untouched — already serviced and not billable here. The term link is
// kept for audit; billing-skip keys on prepaid_amount, which is now null.
// `throwOnError` (default false) preserves the best-effort behavior used by the
// webhook/void paths. Callers that need the clear to be atomic with a larger
// transaction (e.g. prepaid reversal) pass `{ throwOnError: true }` so a
// transient DB failure rolls the whole unit of work back instead of silently
// leaving future visits stamped prepaid.
async function clearPrepaidStampsForTerm(termId, conn = db, { throwOnError = false } = {}) {
  if (!termId) return 0;
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !cols.prepaid_amount) return 0;
  const updates = { prepaid_amount: null };
  if (cols.prepaid_method) updates.prepaid_method = null;
  if (cols.prepaid_at) updates.prepaid_at = null;
  if (cols.prepaid_note) updates.prepaid_note = null;
  if (cols.updated_at) updates.updated_at = new Date();
  try {
    const q = conn('scheduled_services')
      .where({ annual_prepay_term_id: termId })
      .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES));
    // Only clear stamps that annual prepay set — a visit manually marked prepaid
    // (cash/Zelle) through the regular schedule route keeps its independent stamp.
    if (cols.prepaid_method) q.where('prepaid_method', ANNUAL_PREPAY_PREPAID_METHOD);
    const cleared = await q.update(updates);
    return Array.isArray(cleared) ? cleared.length : cleared;
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[annual-prepay] clear prepaid stamps skipped for term ${termId}: ${err.message}`);
    return 0;
  }
}

// Canonical "is this term's paid coverage live on `coverageDate`" query — the
// single source of truth shared by getActivelyCoveredCustomerIds and the
// completion gate (annualPrepayCoversVisit), so the two can't drift. A term
// counts as covered when: coverageDate is within [term_start, term_end]; the term
// is in a paid-coverage status (or a payment_pending term whose invoice is in fact
// paid, or a renewal *lapse* still inside its already-paid term); the prepay
// invoice is not void/cancelled/refunded; and the prepay payment was not FULLY
// refunded (the Stripe refund webhook flips the PAYMENT row, not invoices.status,
// so we detect it on payments via the invoice's Stripe identifiers). Partial
// refunds (invoice stays 'paid') keep coverage.
// `coverageDate` restricts to terms whose window contains that date (the covered-
// as-of-a-day question). Pass null to skip the window and return EVERY term with
// still-valid paid coverage regardless of window (the audit's "which paid terms
// exist" question) — the invoice/payment refund exclusions still apply.
function coveredTermsAsOf(conn, coverageDate = null) {
  const cancelledStatuses = [...INVOICE_CANCELLED_STATUSES];
  const query = conn('annual_prepay_terms as t')
    .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id');
  if (coverageDate) {
    query.where('t.term_start', '<=', coverageDate).where('t.term_end', '>=', coverageDate);
  }
  return query
    .where(function statusGuard() {
      // Live statuses (active / renewal_pending) carry no invoice condition —
      // legacy born-active terms may predate invoice linkage entirely.
      this.whereIn('t.status', ACTIVE_STATUSES)
        .orWhere(function paidPending() {
          this.where('t.status', PAYMENT_PENDING_STATUS)
            .andWhere(function invoicePaid() {
              this.where('i.status', 'paid').orWhereNotNull('i.paid_at');
            });
        })
        // DECIDED coverage (renewed / switch_plan / a decided lapse riding out
        // its paid window) stays covered ONLY while its prepay invoice is
        // actually PAID. A lost chargeback (or an open dispute) reopens that
        // invoice to 'overdue' WITH ITS PI LINKAGE CLEARED, so neither the
        // cancelled-status exclusion nor the refunded-payment NOT EXISTS below
        // can see the claw-back — this paid gate is what revokes decided
        // coverage on disputed money, and it self-restores when the invoice
        // returns to paid (dispute won / re-collection). A decided term with
        // NO linked invoice (legacy) keeps its historical covered semantics.
        .orWhere(function decidedCoveredAndPaid() {
          this.where(function decidedShape() {
            this.whereIn('t.status', DECIDED_COVERED_STATUSES)
              .orWhere(function lapsedRenewalStillInTerm() {
                this.where('t.status', 'cancelled').andWhere('t.renewal_decision', 'cancel');
              });
          }).andWhere(function decidedInvoicePaid() {
            this.whereNull('t.prepay_invoice_id')
              .orWhere('i.status', 'paid')
              .orWhereNotNull('i.paid_at');
          });
        });
    })
    .whereRaw(
      `lower(coalesce(i.status, 'paid')) not in (${cancelledStatuses.map(() => '?').join(', ')})`,
      cancelledStatuses,
    )
    .whereRaw(
      `not exists (
        select 1 from payments p
        where (p.status = 'refunded' or p.refund_status = 'full')
          and (
            (p.stripe_payment_intent_id is not null and p.stripe_payment_intent_id = i.stripe_payment_intent_id)
            or (p.stripe_charge_id is not null and p.stripe_charge_id = i.stripe_charge_id)
          )
      )`,
    );
}

// Fail-closed coverage test for completion billing. An annual-prepay-stamped
// visit is COVERED when its explicit stamp (prepaid_method === annual_prepay_invoice)
// is backed by a term whose paid coverage is STILL LIVE on the visit date
// (coveredTermsAsOf) — INDEPENDENT of the per-visit prepaid_amount. The stamp is a
// DISCOUNTED allocation slice (splitCoverageAmount divides the discounted invoice
// total across visits), so on a discounted plan the slice is < the visit's
// undiscounted estimated_price; the legacy `prepaid_amount >= amount` gate would
// then wrongly re-bill a prepaid visit (the double-bill this fixes). It is
// fail-closed twice over: (1) requires an explicit stamp AND a live term, so a
// stale stamp left by a best-effort void/refund clear (clearPrepaidStampsForTerm
// swallows errors on the webhook path) can't suppress; (2) revalidates the prepay
// invoice/payment isn't void/refunded, so a term whose status drifts from its
// paid state can't suppress either.
// The stamp is validated against ITS OWN term id with NO date window
// (coveredTermsAsOf(conn, null)): the stamp is the allocation of specific
// prepaid dollars to THIS visit, so re-billing it is double-billing by
// definition regardless of where the visit sits on the calendar. A
// term_start<=date<=term_end window here re-billed an ordinary weather
// reschedule of the final covered visit across term_end — a live completion
// invoice + pay-link SMS for a visit the customer already paid inside the
// prepay (money-path audit P1). Terms that lost their paid state (void/
// refunded/disputed invoice, chargeback claw-back) still fail the query's
// paid-coverage checks, which is what the window was actually guarding.
// Absence/ambiguity => false; the caller then falls back to the numeric
// prepaid_amount >= amount comparison for other (cash/Zelle) methods.
async function annualPrepayCoversVisit(scheduledService, conn = db, { throwOnError = false } = {}) {
  if (!scheduledService) return false;
  if (scheduledService.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD) return false;
  // Strict callers (the extended-completion charging guard): a STAMPED
  // visit whose linkage is incomplete (no amount, no term id, or the terms
  // table itself missing) is UNVERIFIABLE, not validated-stale — billing
  // suppression treats these as uncovered, but the charging side must
  // refuse rather than charge a possibly-prepaid visit (pre-push P0
  // round 11). Only a successful coverage-authority query may return
  // uncovered in strict mode.
  if (!(Number(scheduledService.prepaid_amount) > 0)) {
    if (throwOnError) throw new Error('stamped visit carries no prepaid_amount — coverage unverifiable');
    return false;
  }
  const termId = scheduledService.annual_prepay_term_id;
  if (!termId) {
    if (throwOnError) throw new Error('stamped visit carries no annual_prepay_term_id — coverage unverifiable');
    return false;
  }
  // Strict callers (the extended-completion charging guard) must see a
  // schema-probe failure as UNVERIFIABLE, not as "no table → not covered"
  // (manual-audit P0): annualPrepayTableExists catches probe errors and
  // caches false, which would read a db failure as confirmed-stale
  // coverage on the charging side. Probe directly so the error propagates;
  // a genuinely absent table (fresh env) still returns false.
  if (throwOnError) {
    if (!(await conn.schema.hasTable('annual_prepay_terms'))) {
      throw new Error('annual_prepay_terms table missing for a stamped visit — coverage unverifiable');
    }
  } else if (!(await annualPrepayTableExists())) return false;
  try {
    const term = await coveredTermsAsOf(conn, null)
      .where('t.id', termId)
      // The stamp must belong to THIS visit's customer — a stale stamp pointing at
      // another customer's live term can't suppress.
      .modify((q) => {
        if (scheduledService.customer_id != null) q.where('t.customer_id', scheduledService.customer_id);
      })
      .first('t.id', 't.coverage_service_type');
    if (!term) return false;
    // Defense-in-depth: when the term declares a coverage service, the stamped
    // visit must still be that service (coverage-selection cleanup is best-effort,
    // so a stale stamp left on a dropped/re-typed service must not suppress). The
    // same matcher that APPLIED the stamp gates it here. Legacy no-config terms
    // (no coverage_service_type) never had a service to match, so skip the check.
    if (term.coverage_service_type
      && scheduledService.service_type
      && !serviceMatchesCoverage(scheduledService, normalizeCoverageServiceType(term.coverage_service_type))) {
      return false;
    }
    return true;
  } catch (err) {
    // Fail-closed: if the term/invoice can't be validated, DON'T suppress billing.
    // Callers on the CHARGING side have the opposite fail-closed direction —
    // an unverifiable coverage must refuse the charge, not read as "stale
    // stamp, charge away" (extended completion lane pre-push P0) — so they
    // opt into error propagation and refuse on throw.
    if (throwOnError) throw err;
    logger.warn(`[annual-prepay] coverage validation failed for scheduled service ${scheduledService.id}: ${err.message}`);
    return false;
  }
}

async function refreshTermSnapshot(termOrId, conn = db) {
  if (!(await annualPrepayTableExists())) return null;
  const term = typeof termOrId === 'object'
    ? termOrId
    : await conn('annual_prepay_terms').where({ id: termOrId }).first();
  if (!term) return null;

  const termStart = dateOnly(term.term_start);
  const termEnd = dateOnly(term.term_end);
  const coverageServiceType = normalizeCoverageServiceType(term.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term.coverage_visit_count);
  const coverageCadence = inferCoverageCadence(term);
  // A late payment can SLIDE the coverage window (ensureCoverageRowsForTerm
  // persists the new term_end and reports it back). Every downstream step in
  // this same activation — attach, prepaid stamping, covered-row selection,
  // last-service snapshot — must use the slid end, or the tail visits seeded
  // beyond the original end would never be linked or stamped prepaid and
  // completion would invoice the customer again for visits they prepaid.
  let windowEnd = termEnd;
  if (ACTIVE_STATUSES.includes(term.status)) {
    const ensured = await ensureCoverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd, coverage_cadence: coverageCadence }, conn);
    if (ensured?.effectiveTermEnd) windowEnd = ensured.effectiveTermEnd;
    // Attach + prepaid stamping run even on a palm-identity DEFERRAL
    // (codex r18 pre-push P0, superseding the earlier hard-stop): the
    // prepaid stamp is the anti-double-bill mechanism — an already-booked
    // palm visit left unstamped would invoice at completion after the
    // annual prepay was collected. The MONEY layer therefore always runs;
    // the identity problem (wrong completion profile posture) remains
    // quarantined by the deferral's durable coverage exception until the
    // next refresh restores the catalog identity and re-runs this
    // sequence idempotently.
    await attachScheduledServices({ ...term, term_start: termStart, term_end: windowEnd }, conn);
    await applyPrepaidCoverageForTerm({ ...term, term_start: termStart, term_end: windowEnd }, conn);
    // Callers sync customers.waveguard_renewal_date from the PRE-slide end
    // (or their own normalizedEnd), so renewal workflows would fire while
    // coverage is still running — re-sync from the slid end here.
    if (windowEnd !== termEnd) {
      await syncCustomerRenewalDate(term.customer_id, windowEnd, conn);
    }
  }
  const coveredRows = coverageServiceType && coverageVisitCount
    ? await coverageRowsForTerm({ ...term, term_start: termStart, term_end: windowEnd }, conn)
    : [];
  const lastService = coveredRows.length
    ? coveredRows[coveredRows.length - 1]
    : await findLastScheduledServiceForTerm(term.customer_id, termStart, windowEnd, conn);

  const updates = {
    last_scheduled_service_id: lastService?.id || null,
    last_scheduled_service_date: lastService ? dateOnly(lastService.scheduled_date) : null,
    updated_at: new Date(),
  };

  const [updated] = await conn('annual_prepay_terms')
    .where({ id: term.id })
    .update(updates)
    .returning('*');

  return updated || { ...term, ...updates };
}

async function refreshActiveTermsForCustomer(customerId, conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  if (!customerId) return [];

  const terms = await conn('annual_prepay_terms')
    .where({ customer_id: customerId })
    .whereIn('status', ACTIVE_STATUSES)
    .select('*');

  const refreshed = [];
  for (const term of terms) {
    const snapshot = await refreshTermSnapshot(term, conn);
    if (snapshot) refreshed.push(snapshot);
  }
  return refreshed;
}

async function syncCustomerRenewalDate(customerId, termEnd, conn = db) {
  if (!customerId || !termEnd) return;
  try {
    const customerCols = await conn('customers').columnInfo();
    if (!customerCols.waveguard_renewal_date) return;
    await conn('customers')
      .where({ id: customerId })
      .update({ waveguard_renewal_date: termEnd, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] customer renewal date sync skipped: ${err.message}`);
  }
}

async function syncInvoiceTerm(invoiceId, termId, conn = db) {
  if (!invoiceId || !termId) return;
  const cols = await invoiceColumns();
  if (!cols.annual_prepay_term_id) return;
  try {
    // Real mutation → real stamp (Codex #3109 r26): binding a term to the
    // invoice is billing state the merge-undo's activity gates detect by
    // updated_at; an unstamped sync was invisible to them.
    await conn('invoices').where({ id: invoiceId }).update({ annual_prepay_term_id: termId, updated_at: conn.fn.now() });
  } catch (err) {
    logger.warn(`[annual-prepay] invoice term sync skipped: ${err.message}`);
  }
}

async function statusForPrepayInvoice(invoiceId, conn = db) {
  if (!invoiceId) return 'active';
  try {
    const invoice = await conn('invoices').where({ id: invoiceId }).first('id', 'status', 'paid_at');
    return invoiceTermStatus(invoice);
  } catch (err) {
    logger.warn(`[annual-prepay] invoice status lookup skipped: ${err.message}`);
    return PAYMENT_PENDING_STATUS;
  }
}

async function syncTermForInvoicePayment(invoiceOrId, conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  const invoice = typeof invoiceOrId === 'object'
    ? invoiceOrId
    : await conn('invoices').where({ id: invoiceOrId }).first('id', 'status', 'paid_at');
  if (!invoice?.id) return [];

  const nextStatus = invoiceTermStatus(invoice);
  const terms = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoice.id })
    .whereIn('status', [PAYMENT_PENDING_STATUS, ...ACTIVE_STATUSES])
    .select('*');

  if (nextStatus === 'active') {
    // Lost-dispute revival (Codex #2533 round-4 P1): losing the dispute
    // cancels the term via the refund-shaped sync, but the reopened annual
    // invoice stays collectible in dunning — a customer who then re-pays it
    // has paid for the coverage once (the disputed money went back to them)
    // and must get the term back. The dispute marker identifies exactly this
    // cancel shape: renewal_decision NULL rules out decided lapses (their
    // coverage self-restores through the decided paid-invoice gate), and
    // only the dispute path writes the marker. Reviving into the active
    // loop below reuses the whole restore pipeline — re-attach + re-stamp,
    // pending-window reconcile, billing-mode re-stamp, dues claw-back, and
    // the marker clear. try/catch = pre-migration boots (marker column
    // absent) degrade to no revival, never a failed sync.
    try {
      const revivals = await conn('annual_prepay_terms')
        .where({ prepay_invoice_id: invoice.id, status: 'cancelled' })
        .whereNull('renewal_decision')
        .whereNotNull('dispute_suspended_at')
        .select('*');
      if (Array.isArray(revivals) && revivals.length) terms.push(...revivals);
    } catch (err) {
      logger.warn(`[annual-prepay] dispute-cancel revival lookup skipped for invoice ${invoice.id}: ${err.message}`);
    }
  }

  const results = [];
  for (const term of terms) {
    let current = term;
    if (nextStatus === 'active' && term.status === PAYMENT_PENDING_STATUS) {
      // NOTE: reactivation deliberately does NOT clear dispute_suspended_at
      // here — the marker must survive until the dispute-window follow-ups
      // below (dues claw-back) complete, or a crash between this flip and
      // those follow-ups loses them forever (the retry would find no
      // marker). It is cleared after the follow-ups run clean; GUARD 5 is
      // unaffected either way (it only reads the marker on payment_pending
      // rows).
      const [updated] = await conn('annual_prepay_terms')
        .where({ id: term.id, status: PAYMENT_PENDING_STATUS })
        .update({ status: 'active', updated_at: new Date() })
        .returning('*');
      current = updated || term;
    } else if (nextStatus === 'active' && term.status === 'cancelled') {
      // Lost-dispute revival (see the marker-gated select above). The
      // conditional WHERE keeps it race-safe and replay-idempotent; a miss
      // (someone else already revived) leaves current cancelled and the
      // next sync of this invoice picks the term up as active.
      const [updated] = await conn('annual_prepay_terms')
        .where({ id: term.id, status: 'cancelled' })
        .whereNull('renewal_decision')
        .update({ status: 'active', updated_at: new Date() })
        .returning('*');
      current = updated || term;
      if (updated) {
        logger.warn(`[annual-prepay] term ${term.id} revived (cancelled→active) — dispute-cancelled term's invoice ${invoice.id} was re-paid`);
        // The refund clawed the extension credit; the repayment restores
        // it with the coverage (guards P0). Idempotent (last-event rule).
        await restoreWaveguardExtensionCredits(updated, conn);
      }
    } else if (nextStatus === 'cancelled') {
      const [updated] = await conn('annual_prepay_terms')
        .where({ id: term.id })
        .whereNull('renewal_decision')
        .update({ status: 'cancelled', updated_at: new Date() })
        .returning('*');
      current = updated || term;
      // A true void/refund (no renewal decision) cancels coverage — drop the
      // per-visit prepaid stamps so future covered visits bill normally. A
      // renewal-lapse (renewal_decision set) keeps its paid window, so the
      // whereNull guard leaves `updated` undefined and we don't clear.
      if (updated && updated.status === 'cancelled') {
        // Lock order (deadlock guard, guards round 1): the accept
        // transaction locks the CUSTOMER at entry, before the extension's
        // scheduled_services family lock — while this leg would otherwise
        // take scheduled_services locks (the stamp clears below) first and
        // the customer (credit reversals) last. Same order both sides or a
        // concurrent accept + refund for one customer can deadlock. On
        // autocommit (conn === db) every statement is its own transaction
        // and no multi-statement order exists to invert.
        if (conn.isTransaction && updated.customer_id) {
          await conn('customers').where({ id: updated.customer_id }).forUpdate().first('id');
        }
        await clearPrepaidStampsForTerm(term.id, conn);
        // Also reopen any per-visit invoices this term settled as NON-CASH coverage
        // (status='prepaid' by this term, or a partial with a coverage line) — the
        // prepay was refunded, so the covered work is owed again. Mirrors the stamp
        // clear; best-effort (never blocks the refund sync), and never reopens a
        // cash-paid invoice.
        try {
          await require('./invoice').reopenAnnualPrepayCoveredInvoicesForTerm(term.id, conn);
        } catch (err) {
          logger.warn(`[annual-prepay] invoice coverage reopen skipped for term ${term.id}: ${err.message}`);
        }
        // And claw back the pending-window completion credits this term
        // issued — the full-annual refund would otherwise refund those
        // slices twice (once inside the refund, once as kept credit).
        await reversePendingWindowCompletionCredits(updated, conn);
        // Same double-pay shape for the WaveGuard tier-extension credit:
        // the refund returns the prepaid dollars the discounted allocation
        // was carved from, so the extension's prepaid-difference grant
        // reverses with it.
        await reverseWaveguardExtensionCredits(updated, conn);
        // Coverage is gone — return the customer to a billable mode (the
        // monthly cron skips 'annual_prepay' outright; see GUARD 3b).
        await resetBillingModeAfterTermCancel(updated, conn);
        // An ON-SITE SWITCH retired the accept-minted per-application
        // invoice when this prepay was created; with the prepay dead that
        // AR (setup fee included) must come back, or it is silently gone
        // forever — nothing else ever re-mints it. Marker-keyed and
        // idempotent; best-effort (never blocks the void/refund sync).
        if (updated.prepay_invoice_id) {
          try {
            await require('./invoice').restoreSwitchSupersededInvoicesForPrepay(updated.prepay_invoice_id, conn);
          } catch (err) {
            // The markers are durable, so this is recoverable — but only by a
            // human who knows: the void succeeded and the superseded
            // per-application AR is still missing. ERROR (Sentry-visible),
            // with the fix spelled out (Codex on-site-switch P0 r9: a warn
            // here was a permanent silent AR loss).
            logger.error(`[annual-prepay] FIX: switch-superseded restore FAILED for term ${updated.id} (prepay invoice ${updated.prepay_invoice_id}): ${err.message}. The customer's per-application invoice is still void — re-run POST /admin/schedule/<visitId>/prepay-switch/undo or rebuild it from Invoices.`);
          }
        }
      }
    }

    if (ACTIVE_STATUSES.includes(current.status)) {
      await syncCustomerRenewalDate(current.customer_id, dateOnly(current.term_end), conn);
      const refreshed = await refreshTermSnapshot(current, conn);
      // After attach+stamp: covered-window visits that completed (and billed
      // per application) BEFORE this payment would otherwise be paid twice —
      // settle their open invoices as coverage / credit back their slice.
      // Idempotent, so retried webhooks and later syncs are safe.
      await reconcilePendingWindowCompletions(refreshed || current, conn);
      // Payment confirmed → the customer is now genuinely annual-prepay.
      // Term creation deliberately does NOT stamp payment_pending terms
      // (pre-payment completions bill per application), so this transition
      // is where the pending case picks up its stamp. Idempotent re-stamp
      // for already-active terms; best-effort + column-guarded inside.
      await stampAnnualPrepayBillingMode(current.customer_id, conn, current.id);
      // Dispute-suspended term returning to life (won dispute /
      // re-collection): monthly dues the cron collected during the open
      // dispute double-charge the reinstated coverage — claw them back,
      // then clear the marker once nothing is deferred (Codex round-3 P1).
      if (current.dispute_suspended_at) {
        await finishDisputeRecoveryForTerm(current, conn);
      }
      results.push(refreshed || current);
    } else {
      results.push(current);
    }
  }

  if (nextStatus === 'active') {
    // Decided-coverage terms (renewed / switch_plan / decided lapse) never
    // enter the loop above (it selects pending/active only), but a dispute
    // suspension reset their customer's billing_mode AND cleared their
    // per-visit prepaid stamps — a won dispute / re-collection must restore
    // both, or uncovered completions keep billing per-visit against the
    // renewal-flow ruling. coveredTermsAsOf re-validates the coverage is
    // genuinely paid-backed and live before restoring anything;
    // stampAnnualPrepayBillingMode is idempotent and its first-stamp-wins
    // prior recording never overwrites the original. The coverage re-stamp
    // (applyPrepaidCoverageForTerm) restores stamps only to this term's
    // remaining non-terminal in-window visits (rows covered by a DIFFERENT
    // term or carrying an out-of-band cash/Zelle stamp are skipped), and
    // the reconcile settles/credits visits that completed and billed
    // per-visit while the dispute was open — mirroring the active-term
    // path's refreshTermSnapshot + reconcilePendingWindowCompletions.
    // Both no-op for legacy no-config terms, same as the active path.
    // Best-effort: a miss here self-heals on the next sync of this invoice
    // (and the reconcile leg via the daily covered-term sweep).
    try {
      const decidedTerms = await conn('annual_prepay_terms')
        .where({ prepay_invoice_id: invoice.id })
        .whereNotIn('status', [PAYMENT_PENDING_STATUS, ...ACTIVE_STATUSES])
        .select('*');
      const today = etDateString();
      for (const decidedTerm of decidedTerms) {
        // Null-window validity check (Codex round-4 P2): a dispute won or
        // re-collected AFTER term_end still owes the dispute-window dues
        // claw-back — gating everything on covered-TODAY left the marker
        // and the dues stuck forever once the window passed. Validate the
        // paid backing without the date window, then restore stamps/mode
        // only while today is actually inside the coverage window (an
        // expired term has nothing to stamp, and re-stamping billing_mode
        // 'annual_prepay' on expired coverage is the nothing-bills limbo).
        const validPaid = await coveredTermsAsOf(conn, null)
          .where('t.id', decidedTerm.id)
          .first('t.id');
        if (!validPaid) continue;
        // Repaid backing restores the clawed extension credit with the
        // coverage (guards P0) — not window-gated: the credit was never
        // date-bound, only payment-bound. Idempotent (last-event rule).
        await restoreWaveguardExtensionCredits(decidedTerm, conn);
        const termStart = dateOnly(decidedTerm.term_start);
        const termEnd = dateOnly(decidedTerm.term_end);
        const coveredToday = !!(termStart && termEnd && termStart <= today && today <= termEnd);
        if (coveredToday) {
          await stampAnnualPrepayBillingMode(decidedTerm.customer_id, conn, decidedTerm.id);
          const normalized = { ...decidedTerm, term_start: termStart, term_end: termEnd };
          await applyPrepaidCoverageForTerm(normalized, conn);
          await reconcilePendingWindowCompletions(normalized, conn);
        }
        // Dues claw-back + marker clear LAST: a failure anywhere above
        // leaves the marker set, and the daily sweep's marker legs finish
        // the restore within a day (Codex round-3 P2 — this block is
        // deliberately best-effort because it runs on EVERY paid-invoice
        // sync, so throwing here would poison unrelated payment events).
        if (decidedTerm.dispute_suspended_at) {
          await finishDisputeRecoveryForTerm(decidedTerm, conn);
        }
      }
    } catch (err) {
      logger.warn(`[annual-prepay] decided-coverage restore skipped for invoice ${invoice.id}: ${err.message}`);
    }
  }

  if (nextStatus === 'cancelled') {
    // A refund/void voids the prepaid coverage even for terms whose renewal was
    // already decided (renewed / switch_plan / lapse) — these stay covered through
    // term_end for the renewal flow and the loop above doesn't select them, so
    // their future visits would keep annual-prepay stamps and skip billing after
    // the refund. Clear those stamps too (method-scoped, so manual cash/Zelle
    // stamps survive); the term's renewal-flow status is intentionally left as-is.
    const decidedCoveredTerms = await conn('annual_prepay_terms')
      .where({ prepay_invoice_id: invoice.id })
      .where(function decidedCovered() {
        this.whereIn('status', ['renewed', 'switch_plan'])
          .orWhere(function lapsed() {
            this.where('status', 'cancelled').whereNotNull('renewal_decision');
          });
      })
      .select('id', 'customer_id', 'source_estimate_id', 'prepay_invoice_id');
    for (const decided of decidedCoveredTerms) {
      // Same customer-first lock order as the true-refund cancel branch
      // above (deadlock guard vs the accept transaction).
      if (conn.isTransaction && decided.customer_id) {
        await conn('customers').where({ id: decided.customer_id }).forUpdate().first('id');
      }
      await clearPrepaidStampsForTerm(decided.id, conn);
      // Same as the active loop: reopen any visit invoices this term settled as
      // non-cash coverage — the refund voids their coverage too.
      try {
        await require('./invoice').reopenAnnualPrepayCoveredInvoicesForTerm(decided.id, conn);
      } catch (err) {
        logger.warn(`[annual-prepay] invoice coverage reopen skipped for decided term ${decided.id}: ${err.message}`);
      }
      await reversePendingWindowCompletionCredits(decided, conn);
      // Decided-lapse refund reverses the extension grant too — the paid
      // window the credit rode on is the thing being refunded.
      await reverseWaveguardExtensionCredits(decided, conn);
      // A decided-lapse term (status 'cancelled' + renewal_decision) whose
      // invoice refunds never passes through the active loop's reset — the
      // customer would stay 'annual_prepay' with the cron skipping them and
      // completion refusing to bill: unbilled forever (Codex round-6 P1).
      // The helper self-checks for replacement coverage, so a renewed
      // customer (live follow-on term) keeps their mode.
      await resetBillingModeAfterTermCancel(decided, conn);
      // A DECIDED term's refund removes its coverage too (Codex P0 r30) —
      // an on-site switch's superseded per-application invoice must come
      // back here as well, or the AR is void forever (this loop never runs
      // the true-void branch's restore, and the sweep's covering-term guard
      // reads the decided window as live). The restore itself excludes the
      // refunded prepay's own term from its covering-term decision.
      if (decided.prepay_invoice_id) {
        try {
          await require('./invoice').restoreSwitchSupersededInvoicesForPrepay(decided.prepay_invoice_id, conn);
        } catch (err) {
          logger.error(`[annual-prepay] FIX: switch-superseded restore FAILED for decided term ${decided.id} (prepay invoice ${decided.prepay_invoice_id}): ${err.message}. The customer's per-application invoice is still void — re-run POST /admin/schedule/<visitId>/prepay-switch/undo or rebuild it from Invoices.`);
        }
      }
    }
  }

  // A VISIT invoice resolving can move a pending-window completion slice in
  // either direction — its own payment/refund never matches
  // prepay_invoice_id, so nothing above selects a term for it. Find the
  // covering term through the visit row's attach link:
  //   - resolves PAID → the activation reconcile may have left this slice
  //     unresolved (processing / in-flight / settle-refused) — re-run it.
  //   - resolves REFUNDED/VOID → the customer got the visit payment back, so
  //     the slice credit issued for that paid visit reverses: the annual's
  //     slice becomes the visit's payment again (matching the never-billed
  //     branch). Without this the customer keeps the credit AND the refund.
  // The account-credit seam resolves a fully credit-covered visit invoice as
  // 'prepaid' with NO paid_at — invoiceTermStatus maps that to payment_pending,
  // but consumed account credit IS money collected for the visit (the same rule
  // reconcilePendingWindowCompletions applies via paidForVisit), so it takes
  // the PAID direction here. Coverage-settled 'prepaid' invoices are harmless
  // re-entries: the reconcile skips rows carrying a covered-term marker.
  const visitCollected = nextStatus === 'active'
    || String(invoice.status || '').toLowerCase() === 'prepaid';
  if (!terms.length && (visitCollected || nextStatus === 'cancelled')) {
    try {
      const withLink = invoice.scheduled_service_id !== undefined
        ? invoice
        : await conn('invoices').where({ id: invoice.id }).first('id', 'scheduled_service_id');
      const visitId = withLink?.scheduled_service_id;
      if (visitId) {
        const visitRow = await conn('scheduled_services')
          .where({ id: visitId })
          .first('id', 'annual_prepay_term_id');
        if (visitRow?.annual_prepay_term_id) {
          if (visitCollected) {
            // Covered-coverage semantics, not just ACTIVE_STATUSES: a term
            // whose renewal was already decided (renewed / switch_plan, or a
            // lapse still inside its paid window) stays covered through
            // term_end, and a visit invoice paid late — after the decision —
            // still owes its slice back. coveredTermsAsOf also revalidates
            // the prepay invoice/payment isn't void/refunded, so a refunded
            // term that kept its decided status can never mint a credit here.
            const coveringTerm = await coveredTermsAsOf(conn, null)
              .where('t.id', visitRow.annual_prepay_term_id)
              .first('t.*');
            if (coveringTerm) await reconcilePendingWindowCompletions(coveringTerm, conn);
          } else {
            const coveringTerm = await conn('annual_prepay_terms')
              .where({ id: visitRow.annual_prepay_term_id })
              .first('*');
            if (coveringTerm) await reversePendingWindowCompletionCredits(coveringTerm, conn, { visitId });
          }
        }
      }
    } catch (err) {
      logger.warn(`[annual-prepay] visit-invoice reconcile hook skipped for invoice ${invoice.id}: ${err.message}`);
    }
  }

  return results;
}

async function syncTermForRefundedPayment(payment, conn = db) {
  if (!(await annualPrepayTableExists()) || !payment) return [];
  const invoiceId = await findInvoiceIdForRefundedPayment(payment, conn);
  if (!invoiceId) return [];

  return syncTermForInvoicePayment({
    id: invoiceId,
    status: 'refunded',
    paid_at: null,
  }, conn);
}

async function activatePaidPendingTerms(conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  const rows = await conn('annual_prepay_terms as t')
    .join('invoices as i', 't.prepay_invoice_id', 'i.id')
    .where('t.status', PAYMENT_PENDING_STATUS)
    .where(function () {
      this.where('i.status', 'paid').orWhereNotNull('i.paid_at');
    })
    .select('i.id');

  const activated = [];
  for (const row of rows) {
    const synced = await syncTermForInvoicePayment(row.id, conn);
    activated.push(...synced.filter((term) => ACTIVE_STATUSES.includes(term.status)));
  }
  return activated;
}

/**
 * A chargeback (charge.dispute.created) on the prepay invoice provisionally
 * claws the money back, so paid coverage must SUSPEND — not cancel — while
 * the dispute is open. Flipping active/renewal_pending terms back to
 * payment_pending reuses the existing state machine end to end:
 *   - coveredTermsAsOf stops covering (the reopened invoice is 'overdue',
 *     so the paid-pending branch fails) → completions bill normally and the
 *     monthly cron's covered-set guard no longer suppresses on coverage —
 *     while getPaymentPendingCustomerIds keeps monthly billing suppressed on
 *     the open prepay invoice, so the customer is never double-billed
 *     mid-dispute. billing_mode is restored to the customer's prior mode
 *     (below) so mid-dispute completions actually BILL per
 *     application/monthly instead of hitting the annual-prepay completion
 *     gate's never-invoice branch.
 *   - Dispute WON restores the payment row + invoice to paid → the normal
 *     payment sync flips the term back active and its reconcile makes any
 *     visits that billed during the dispute whole (idempotent).
 *   - Dispute LOST runs the refund-shaped sync (caller's job) → term
 *     cancels with the full claw-back (stamps cleared, covered invoices
 *     reopened, pending-window credits reversed, billing mode reset). The
 *     dispute marker survives that cancel: if the customer later re-pays
 *     the still-collectible reopened invoice, the payment sync's
 *     marker-gated revival flips the cancelled term back active and the
 *     full restore pipeline runs (Codex round-4 P1).
 * A re-collection (customer re-pays the reopened invoice) also flips the
 * term back active through the ordinary paid path.
 * Decided-coverage terms (renewed / switch_plan / decided lapse) are NOT
 * status-flipped — their renewal-flow state would be destroyed. Their
 * coverage suspends anyway: coveredTermsAsOf's decidedCoveredAndPaid
 * branch requires the prepay invoice to be PAID, and the dispute reopen
 * flips it to 'overdue'. A LOST dispute then cancels them outright.
 * Conditional UPDATE = idempotent on Stripe retries. renewal_pending
 * demotes to payment_pending and returns as 'active' on a won dispute;
 * the renewal alert recomputes from dates, so only the contacted flag's
 * status is lost — acceptable, logged.
 * Retry-safe end to end (Codex #2533 round-2): the demotion also stamps
 * dispute_suspended_at, and the follow-up work below re-selects EVERY
 * payment_pending term on this invoice carrying that marker — not just the
 * rows this call's UPDATE demoted. A crash between the status flip and the
 * stamp-clear / mode-reset leaves the event unprocessed; Stripe's retry
 * re-enters here, the UPDATE matches nothing (already payment_pending),
 * and the marker re-selection still runs the follow-ups. The follow-ups
 * themselves are fail-fast (throwOnError) because the webhook caller
 * deliberately has no .catch — a transient DB error must fail the event so
 * Stripe retries it, not get swallowed into a half-suspended term.
 */
async function suspendActiveTermsForDisputedInvoice(invoiceId, conn = db) {
  if (!invoiceId || !(await annualPrepayTableExists())) return [];
  const termCols = await annualPrepayColumns(conn);
  const demotion = { status: PAYMENT_PENDING_STATUS, updated_at: new Date() };
  if (termCols.dispute_suspended_at) demotion.dispute_suspended_at = new Date();
  const suspended = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoiceId })
    .whereIn('status', ACTIVE_STATUSES)
    .update(demotion)
    .returning('*');
  let rows = Array.isArray(suspended) ? suspended : [];
  if (termCols.dispute_suspended_at) {
    // Marker re-selection: pick up terms a crashed earlier attempt demoted
    // without finishing. Pre-migration boots fall back to the demoted rows
    // alone (degraded but never wrong — same column-guard pattern as
    // prior_billing_mode).
    rows = await conn('annual_prepay_terms')
      .where({ prepay_invoice_id: invoiceId, status: PAYMENT_PENDING_STATUS })
      .whereNotNull('dispute_suspended_at')
      .select('*');
  }
  for (const term of rows) {
    logger.warn(`[annual-prepay] term ${term.id} suspended (active→payment_pending) — prepay invoice ${invoiceId} disputed`);
    // Clear the per-visit prepaid stamps exactly like a cancel does
    // (method-scoped, non-terminal rows only). A stamped FUTURE visit that
    // completed mid-dispute would otherwise carry its stamp into the won-
    // dispute reconcile, which skips stamped completed rows as "already
    // delivered" — the per-visit invoice it generated during the dispute
    // would never settle or credit back (double-pay). Won re-pays the
    // invoice → refreshTermSnapshot re-stamps the remaining future visits;
    // completed-during-dispute rows stay unstamped so the reconcile
    // settles/credits them. Pre-dispute covered completions keep their
    // stamps (terminal statuses excluded) and the reconcile skips them via
    // the covered-term invoice marker.
    await clearPrepaidStampsForTerm(term.id, conn, { throwOnError: true });
    // A suspended term must not strand the customer in billing_mode
    // 'annual_prepay': the completion gate deliberately never auto-invoices
    // unpriced annual-prepay visits (uncovered = renewal flow's problem), so
    // a visit completing mid-dispute would be serviced FREE. Restore the
    // prior mode exactly like a cancel does (same replacement-coverage
    // self-check, same prior_billing_mode restore) — completions bill
    // per-application/monthly again while GUARD 5 keeps the monthly cron
    // off the open prepay invoice (dispute-suspended terms excluded — see
    // getPaymentPendingCustomerIds — so prior-monthly customers keep
    // paying dues mid-dispute and the dues-cover suppression stays
    // honest). A won dispute re-pays the invoice and the payment sync's
    // stampAnnualPrepayBillingMode re-stamps the mode (first-stamp-wins
    // keeps the ORIGINAL prior). Fail-fast here (unlike the cancel paths):
    // a swallowed error would leave mid-dispute completions unbillable
    // with nothing retrying, while a thrown one fails the webhook and
    // Stripe re-delivers into the marker re-selection above.
    await resetBillingModeAfterTermCancel(term, conn, { throwOnError: true });
  }
  const decided = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoiceId })
    .where(function decidedShapes() {
      this.whereIn('status', DECIDED_COVERED_STATUSES)
        .orWhere(function decidedLapse() {
          this.where('status', 'cancelled').whereNotNull('renewal_decision');
        });
    })
    .select('*');
  for (const term of decided) {
    logger.warn(`[annual-prepay] term ${term.id} has decided coverage on disputed invoice ${invoiceId} — status kept (renewal state), coverage suspends via the decided paid-invoice gate once the invoice reopens`);
    // Decided terms keep their status but still get the dispute marker: it
    // anchors the dues claw-back window when the dispute is won, and its
    // survival marks an incomplete restore for the daily sweep to finish.
    // whereNull so a webhook replay never slides the window start forward
    // past dues already collected. GUARD 5 is untouched — it only reads the
    // marker on payment_pending rows, and decided statuses never are.
    if (termCols.dispute_suspended_at) {
      await conn('annual_prepay_terms')
        .where({ id: term.id })
        .whereNull('dispute_suspended_at')
        .update({ dispute_suspended_at: new Date(), updated_at: new Date() });
    }
    // Decided-term stamps must clear exactly like the suspended terms above
    // (Codex #2533 round-2 P1): a stamped visit completing mid-dispute
    // bills per-visit (the coverage gate correctly refuses the suspended
    // term), but a surviving stamp makes the won-dispute reconcile skip
    // that row as "already delivered" — the customer pays the annual AND
    // the dispute-window visit invoice. The won-dispute payment sync
    // re-stamps live decided coverage and settles/credits the mid-dispute
    // per-visit charges (see its decided-coverage restore block).
    await clearPrepaidStampsForTerm(term.id, conn, { throwOnError: true });
    // Decided terms keep their status, but the customer must still leave
    // billing_mode 'annual_prepay' or mid-dispute completions hit the
    // never-invoice branch and go out free — same reset as the suspend
    // above (self-checks replacement coverage; 'renewed' terms usually
    // no-op because the successor term IS live coverage). The won-dispute
    // payment sync restores the mode for decided coverage explicitly.
    await resetBillingModeAfterTermCancel(term, conn, { throwOnError: true });
  }
  return rows;
}

/**
 * Daily catch-all for the late-payment reconcile paths that otherwise fire
 * exactly once from a payment/refund event and can be lost to a transient
 * error (every caller swallows; activatePaidPendingTerms can't recover them
 * because the covering term is already ACTIVE and its join only selects
 * payment_pending terms). Also closes the crash window between the term's
 * pending→active flip and its first reconcile, and finishes any
 * dispute-restore a swallowed error left incomplete (marker leg below).
 * Idempotent legs per live covered term:
 *   1. Re-run reconcilePendingWindowCompletions — settles/credits any
 *      pending-window completion whose one-shot hook was lost (the settle
 *      no-ops on covered invoices; the credit is ledger-deduped).
 *   2. Reversal recovery — a visit invoice that REFUNDED/VOIDED after its
 *      slice credit was granted must give the credit back; if that one
 *      webhook sync died, nothing retries it. Re-derive from the ledger:
 *      every grant marker whose visit invoice is now cancelled gets the
 *      (marker-deduped, balance-capped) reversal re-attempted.
 * Best-effort per term; a failure on one term never blocks the rest.
 */
async function reconcileCoveredTermsSweep({ today = etDateString(), conn = db } = {}) {
  const summary = { terms: 0, settled: 0, credited: 0, reversed: 0, disputeRecovered: 0 };
  if (!(await annualPrepayTableExists())) return summary;
  let terms = [];
  try {
    terms = await coveredTermsAsOf(conn, dateOnly(today) || etDateString()).select('t.*');
  } catch (err) {
    logger.warn(`[annual-prepay] covered-term sweep query failed: ${err.message}`);
    return summary;
  }
  for (const term of terms) {
    summary.terms += 1;
    // Dispute-marker leg (Codex round-3 P2): a COVERED term still carrying
    // dispute_suspended_at means the dispute resolved (coverage requires the
    // prepay invoice paid again) but the one-shot won-dispute restore didn't
    // finish — its errors are swallowed on the paid-invoice sync, and
    // nothing else re-enters it. Finish the restore here: re-stamp coverage
    // + billing mode (idempotent; skips foreign-term and out-of-band
    // stamps), claw back dispute-window dues, and clear the marker only
    // when nothing deferred. Bounds any lost restore to one sweep cycle.
    if (term.dispute_suspended_at) {
      try {
        const normalized = { ...term, term_start: dateOnly(term.term_start), term_end: dateOnly(term.term_end) };
        await applyPrepaidCoverageForTerm(normalized, conn);
        await stampAnnualPrepayBillingMode(term.customer_id, conn, term.id);
        const recovery = await finishDisputeRecoveryForTerm(term, conn);
        summary.disputeRecovered += recovery.credited;
      } catch (err) {
        logger.warn(`[annual-prepay] sweep dispute-recovery leg failed for term ${term.id}: ${err.message}`);
      }
    }
    const res = await reconcilePendingWindowCompletions(term, conn);
    summary.settled += res.settled || 0;
    summary.credited += res.credited || 0;
    // Covered = paid-backed (coveredTermsAsOf revalidates the prepay
    // invoice), so any clawed extension credit is owed back — self-heals a
    // repayment whose inline restore was lost (guards P0). Idempotent.
    try {
      summary.credited += await restoreWaveguardExtensionCredits(term, conn);
    } catch (err) {
      logger.warn(`[annual-prepay] sweep extension-credit restore failed for term ${term.id}: ${err.message}`);
    }
    try {
      const grants = await conn('customer_credit_ledger')
        .where({ customer_id: term.customer_id, created_by: PENDING_COMPLETION_CREDIT_BY })
        .where('note', 'like', `%term ${term.id},%`)
        .where('delta', '>', 0)
        .select('note', 'invoice_id');
      for (const grant of grants) {
        const visitMatch = String(grant.note || '').match(/visit ([0-9a-f-]+)\)/i);
        const visitId = visitMatch ? visitMatch[1] : null;
        // The grant row carries the exact invoice the credit was issued
        // against — check THAT invoice, not the visit's latest (a re-invoiced
        // visit must not mask its refunded original, and a pre-grant void
        // must not trigger a reversal).
        if (!visitId || !grant.invoice_id) continue;
        const grantInvoice = await conn('invoices')
          .where({ id: grant.invoice_id })
          .first('id', 'status');
        if (!grantInvoice) continue;
        const status = String(grantInvoice.status || '').toLowerCase();
        if (!INVOICE_CANCELLED_STATUSES.has(status)) continue;
        // The reversal is marker-deduped, so re-running for an
        // already-reversed grant is a no-op.
        summary.reversed += await reversePendingWindowCompletionCredits(term, conn, { visitId });
      }
    } catch (err) {
      logger.warn(`[annual-prepay] sweep reversal recovery failed for term ${term.id}: ${err.message}`);
    }
  }
  // Expired-window marker pass (Codex round-4 P2): the loop above selects
  // covered-TODAY terms, so a dispute resolved AFTER term_end never enters
  // it — its dues claw-back and marker would be stuck forever. Re-select
  // marker-carrying terms with VALID paid backing but no date window
  // (coveredTermsAsOf(null)), skip the ones the dated loop already owns,
  // and run just the dues/marker recovery — no stamp or mode restore, since
  // expired coverage has nothing to stamp. Column-guarded for
  // pre-migration boots.
  try {
    const termCols = await annualPrepayColumns(conn);
    if (termCols.dispute_suspended_at) {
      const todayKey = dateOnly(today) || etDateString();
      const staleMarked = await coveredTermsAsOf(conn, null)
        .whereNotNull('t.dispute_suspended_at')
        .select('t.*');
      for (const term of staleMarked) {
        const termStart = dateOnly(term.term_start);
        const termEnd = dateOnly(term.term_end);
        if (termStart && termEnd && termStart <= todayKey && todayKey <= termEnd) continue;
        const recovery = await finishDisputeRecoveryForTerm(term, conn);
        summary.disputeRecovered += recovery.credited;
      }
    }
  } catch (err) {
    logger.warn(`[annual-prepay] sweep expired-window marker pass failed: ${err.message}`);
  }
  // WaveGuard extension-credit recovery pass: a refund-cancelled term is no
  // longer covered, so it never enters the dated loop above — an extension
  // grant whose in-line clawback was lost (webhook died mid-sync) would
  // strand forever. Re-scan the grant class directly: each grant's
  // invoice_id anchors the term's PREPAY invoice; a cancelled/refunded
  // anchor plus a cancelled term means the clawback is owed. A renewal
  // lapse without a refund keeps its paid invoice, so it never trips this.
  // The reversal is marker-deduped — re-running for an already-reversed
  // grant is a no-op. The class is tiny (grants exist only for tier-raising
  // accepts over prepaid visits), so the class-wide scan stays cheap.
  try {
    const { WAVEGUARD_EXTENSION_CREDIT_BY } = require('./customer-credit');
    // Final lost-dispute backing (codex #3344 r9 P1): closed(lost)
    // deliberately leaves the prepay invoice 'overdue' so recollection can
    // chase it — never a terminal status — and the webhook's inline
    // refund-shaped sync can lose a transient
    // reverseWaveguardExtensionCredits failure AFTER the event was acked.
    // The durable evidence is the payment row the webhook stamped:
    // metadata.dispute_final='lost', bound to this invoice by the recorded
    // dispute_invoice_id or by still owning its PI — the same two arms the
    // webhook's own lostDisputeOwnedInvoice check uses. An OPEN dispute
    // never writes dispute_final, so mid-dispute anchors stay excluded; a
    // recollected invoice leaves 'overdue' and stops matching.
    const lostDisputeBacked = async (c, anchor) => {
      if (String(anchor.status || '').toLowerCase() !== 'overdue') return false;
      const row = await c('payments')
        .whereRaw("metadata->>'dispute_final' = 'lost'")
        .where(function lostBinding() {
          this.whereRaw("metadata->>'dispute_invoice_id' = ?", [String(anchor.id)]);
          if (anchor.stripe_payment_intent_id) {
            this.orWhere('stripe_payment_intent_id', String(anchor.stripe_payment_intent_id));
          }
        })
        .first('id');
      return !!row;
    };
    const extGrants = await conn('customer_credit_ledger')
      .where({ created_by: WAVEGUARD_EXTENSION_CREDIT_BY })
      .where('delta', '>', 0)
      .select('customer_id', 'note', 'invoice_id');
    const seenTerms = new Set();
    for (const grant of extGrants) {
      // Anything up to the marker's comma is the id — prod ids are UUIDs,
      // but the parse must not silently skip a grant over id shape.
      const termMatch = String(grant.note || '').match(/\(term ([^,)]+),/i);
      const termId = termMatch ? termMatch[1] : null;
      if (!termId || seenTerms.has(termId)) continue;
      seenTerms.add(termId);
      // UNANCHORED grants recover too (pre-push P0, codex r5 round): the
      // accept path posts the grant with invoice_id null when its
      // best-effort prepay-invoice lookup failed — filtering on the ledger
      // anchor would leave exactly those grants without any sweep
      // recovery. Resolve the anchor from the term's CURRENT prepay
      // invoice instead; a term with no linked prepay invoice (legacy
      // born-active) has no refundable anchor to detect and keeps its
      // historical covered semantics.
      let anchorInvoiceId = grant.invoice_id;
      if (!anchorInvoiceId) {
        const termRow = await conn('annual_prepay_terms')
          .where({ id: termId })
          .first('id', 'prepay_invoice_id');
        anchorInvoiceId = termRow?.prepay_invoice_id || null;
      }
      if (!anchorInvoiceId) continue;
      // Cheap unlocked pre-check keeps the common case (anchor still
      // collectible) out of the locked path entirely.
      const anchorInvoice = await conn('invoices')
        .where({ id: anchorInvoiceId })
        .first('id', 'status', 'stripe_payment_intent_id');
      if (!anchorInvoice) continue;
      const anchorStatus = String(anchorInvoice.status || '').toLowerCase();
      if (!INVOICE_CANCELLED_STATUSES.has(anchorStatus)
        && !(await lostDisputeBacked(conn, anchorInvoice))) continue;
      // The refunded ANCHOR is the whole evidence (codex #3344 r1 P1): a
      // refunded term that had already decided renewal keeps its
      // 'renewed'/'switch_plan' status through the inline refund path, so
      // requiring status='cancelled' here would permanently skip exactly
      // the grants a lost refund sync strands. The anchor is self-correct
      // the other way too: a re-paid invoice (lost-dispute revival) leaves
      // the cancelled set, and a DISPUTE parks the invoice at 'overdue' —
      // never a mid-dispute clawback. The term row is only needed for its
      // identity; the reversal itself is marker-deduped and balance-capped.
      //
      // Anchor recheck UNDER LOCK (codex #3344 r2): the pre-check above can
      // observe 'refunded' while a lost-dispute repayment is mid-flight —
      // clawing after it commits 'paid' would remove a credit whose backing
      // payment was just restored. Lock the anchor row and re-read inside
      // the same transaction the reversal runs in; the repayment's own
      // invoice UPDATE serializes on the row lock, so whichever commits
      // first, the other sees its final state.
      //
      // Customer BEFORE anchor (codex #3344 r5 P2): the extension accept
      // path holds the customer FOR UPDATE and its ledger insert then takes
      // KEY SHARE on this same prepay invoice via the invoice_id FK —
      // anchor-first here would form the invoice→customer vs
      // customer→invoice cycle Postgres resolves by aborting one side.
      // Hoist the customer FOR UPDATE (the exact lock
      // reverseWaveguardExtensionCredits takes anyway — re-locking in-txn
      // is free) so every extension-credit writer agrees on customer →
      // invoice, matching the mint paths' customer-first order.
      const clawIfStillRefunded = async (t) => {
        const lockedCustomer = await t('customers')
          .where({ id: grant.customer_id })
          .forUpdate()
          .first('id');
        if (!lockedCustomer) return 0;
        const lockedAnchor = await t('invoices')
          .where({ id: anchorInvoiceId })
          .forUpdate()
          .first('id', 'status', 'stripe_payment_intent_id');
        if (!lockedAnchor) return 0;
        const lockedStatus = String(lockedAnchor.status || '').toLowerCase();
        // The lost-dispute arm re-proves under the same lock: a
        // recollection commits 'paid' on the anchor row this transaction
        // now holds, so whichever side wins, the loser sees the final
        // state — a repaid anchor stands down here exactly like a repaid
        // refund would.
        if (!INVOICE_CANCELLED_STATUSES.has(lockedStatus)
          && !(await lostDisputeBacked(t, lockedAnchor))) return 0;
        const term = await t('annual_prepay_terms')
          .where({ id: termId })
          .first('id', 'customer_id', 'status');
        if (!term) return 0;
        return reverseWaveguardExtensionCredits(term, t);
      };
      summary.reversed += conn === db
        ? await db.transaction(clawIfStillRefunded)
        : await clawIfStillRefunded(conn);
    }
  } catch (err) {
    logger.warn(`[annual-prepay] sweep WaveGuard extension-credit recovery failed: ${err.message}`);
  }
  // WaveGuard extension-credit RESTORE recovery pass (codex #3344 r5 P1):
  // the dated loop above restores only covered-TODAY terms, so a refunded
  // anchor REPAID after term_end (late lost-dispute repayment) whose inline
  // restore was lost never re-enters — the expired-window marker pass only
  // runs the dispute recovery, and the inline restore swallows its own
  // errors, so that follow-up can clear the marker with the credit still
  // reversal-last. Mirror of the clawback pass, keyed on the REVERSAL
  // class: each reversal's invoice_id anchors the term's prepay invoice; a
  // paid-again anchor whose term shows valid paid backing
  // (coveredTermsAsOf(null) — decided-repaid restores are deliberately NOT
  // window-gated) means the restore is owed. The restore itself is
  // last-event-idempotent, so overlap with an inline restore racing this
  // sweep is a no-op, and the class is as tiny as the grant class.
  try {
    const { WAVEGUARD_EXTENSION_REVERSAL_BY } = require('./customer-credit');
    const datedLoopTermIds = new Set(terms.map((term) => String(term.id)));
    const reversalRows = await conn('customer_credit_ledger')
      .where({ created_by: WAVEGUARD_EXTENSION_REVERSAL_BY })
      .select('customer_id', 'note', 'invoice_id');
    const seenRestoreTerms = new Set();
    for (const reversal of reversalRows) {
      const termMatch = String(reversal.note || '').match(/\(term ([^,)]+),/i);
      const termId = termMatch ? termMatch[1] : null;
      if (!termId || seenRestoreTerms.has(termId)) continue;
      seenRestoreTerms.add(termId);
      // The dated loop already ran the restore for covered-today terms —
      // this pass owns only the terms outside today's window.
      if (datedLoopTermIds.has(String(termId))) continue;
      // Unanchored reversals resolve their anchor from the term's current
      // prepay invoice — same recovery contract as the clawback pass above
      // (pre-push P0, codex r5 round): a reversal inherits its grant's
      // null invoice_id when the accept-time anchor lookup failed.
      let anchorInvoiceId = reversal.invoice_id;
      if (!anchorInvoiceId) {
        const termRow = await conn('annual_prepay_terms')
          .where({ id: termId })
          .first('id', 'prepay_invoice_id');
        anchorInvoiceId = termRow?.prepay_invoice_id || null;
      }
      if (!anchorInvoiceId) continue;
      // Cheap unlocked pre-check keeps the common case (anchor still
      // refunded — nothing to restore) out of the locked path entirely.
      const anchorInvoice = await conn('invoices')
        .where({ id: anchorInvoiceId })
        .first('id', 'status', 'paid_at');
      if (!anchorInvoice) continue;
      const anchorPaid = String(anchorInvoice.status || '').toLowerCase() === 'paid'
        || anchorInvoice.paid_at != null;
      if (!anchorPaid) continue;
      // Same lock discipline as the clawback pass: customer FOR UPDATE
      // first (the grant path's order — see the r5 P2 note above), then the
      // anchor row so a racing refund's invoice UPDATE serializes, then the
      // paid-backing recheck through coveredTermsAsOf on this transaction —
      // whichever side commits first, the other sees its final state.
      const restoreIfStillPaidBacked = async (t) => {
        const lockedCustomer = await t('customers')
          .where({ id: reversal.customer_id })
          .forUpdate()
          .first('id');
        if (!lockedCustomer) return 0;
        const lockedAnchor = await t('invoices')
          .where({ id: anchorInvoiceId })
          .forUpdate()
          .first('id');
        if (!lockedAnchor) return 0;
        // Paid backing is the term-level authority, not the bare anchor
        // status: coveredTermsAsOf(null) revalidates the prepay invoice AND
        // the refunded-payment exclusion, and its windowless form is exactly
        // the decided-repaid shape the restore rules cover. A term still
        // stuck cancelled-unrevived (lost repayment sync) is out of scope
        // here by design — the revival recoveries own it, and once revived
        // it becomes paid-backed and this pass catches it next sweep.
        const term = await coveredTermsAsOf(t, null)
          .where('t.id', termId)
          .first('t.id', 't.customer_id');
        if (!term) return 0;
        return restoreWaveguardExtensionCredits(term, t);
      };
      summary.credited += conn === db
        ? await db.transaction(restoreIfStillPaidBacked)
        : await restoreIfStillPaidBacked(conn);
    }
  } catch (err) {
    logger.warn(`[annual-prepay] sweep WaveGuard extension-credit restore recovery failed: ${err.message}`);
  }
  if (summary.settled || summary.credited || summary.reversed || summary.disputeRecovered) {
    logger.info(`[annual-prepay] covered-term sweep recovered work: ${JSON.stringify(summary)}`);
  }
  return summary;
}

/**
 * Customer IDs whose prepay coverage is active on `asOf` (ET date string;
 * defaults to today). A customer in this set has paid for the current period up
 * front and MUST be excluded from monthly billing even when active +
 * monthly_rate > 0 + autopay on. The paid coverage term — not a zeroed
 * monthly_rate — is the billing-suppression source of truth.
 *
 * Coverage = today within [term_start, term_end] AND a live (active /
 * renewal_pending) term (or a payment_pending term whose invoice is in fact
 * paid, or a decided renewed/switch_plan/lapsed term whose invoice is STILL
 * paid) AND the prepay invoice is not void/refunded AND the prepay payment was
 * not fully refunded. A refund (invoice flips to refunded / payment
 * refund_status='full') correctly re-enables monthly billing, and so does a
 * chargeback (the dispute reopen flips the invoice off 'paid', which drops
 * decided coverage and — via the term suspend — live coverage).
 */
async function getActivelyCoveredCustomerIds(asOf = etDateString(), conn = db) {
  if (!(await annualPrepayTableExists())) return new Set();
  const coverageDate = dateOnly(asOf) || etDateString();
  // Covered = a paid-coverage status, OR a payment_pending term whose invoice is
  // in fact paid (webhook/reconcile lag — activatePaidPendingTerms() is the
  // canonical recovery, run before this in the billing cron), OR a renewal *lapse*
  // still current through term_end; void/refunded prepay invoices and fully
  // refunded payments are excluded. See coveredTermsAsOf (shared with the
  // completion coverage gate so the two definitions can't drift).
  const rows = await coveredTermsAsOf(conn, coverageDate).distinct('t.customer_id');
  return new Set(rows.filter((row) => row.customer_id != null).map((row) => String(row.customer_id)));
}

// Visit statuses that can no longer complete (and so can no longer charge).
// Mirrors job-status ONE_WAY_FROM_STATUSES + the no-show/reschedule forms the
// coverage set excludes; everything else (pending, confirmed, en_route,
// on_site, …) is still completable and therefore still chargeable.
const CARD_EXPIRY_TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled'];

// 'YYYY-MM-DD' + 1 day. Pure calendar math on validated date strings
// (term_start/term_end are plain DATE columns — no timezone involved).
function dayAfter(ymd) {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1)).toISOString().slice(0, 10);
}

// Completion's charge cap, mirrored CONSERVATIVELY for the card-expiry
// exemption: the completion authority (admin-dispatch) compares the reused
// invoice's subtotal net of discounts against the accepted amount for its
// lane (visit price / per-application fee / membership dues anchor / the
// appointment-card accepted amount) plus a BOUNDED setup-fee allowance,
// and routes an over-cap invoice to office review WITHOUT charging. The
// exemption only needs the safe direction: report over-cap (→ no card
// charge → exempt) only when the invoice exceeds the MOST GENEROUS
// ceiling completion could grant — the max of every anchor plus the full
// setup-fee line (the real allowance is min(line, fee) ≤ the line, and
// the real anchor is one of these candidates). Anything not clearly over
// that bound is treated as chargeable and keeps the warning.
async function openInvoiceClearlyOverCompletionCap(inv, visit, laneMode, conn) {
  const subtotal = inv.subtotal != null ? Number(inv.subtotal) : Number(inv.total || 0);
  const discount = Math.max(0, Number(inv.discount_amount) || 0);
  const netSubtotal = Math.round((subtotal - discount) * 100) / 100;
  const anchors = [visit.estimated_price, visit.per_application_fee, visit.monthly_rate]
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  // Appointment-card one-time accepts cap against the series' accepted
  // amount — search the whole series, like the completion allowance does.
  const seriesParentId = visit.recurring_parent_id || visit.id;
  const apptRows = await conn('appointment_card_requests')
    .whereIn('scheduled_service_id', conn('scheduled_services').where(function series() {
      this.where({ id: seriesParentId }).orWhere({ recurring_parent_id: seriesParentId });
    }).select('id'))
    .select('accepted_amount', 'selected_plan');
  for (const row of apptRows || []) {
    const amt = Number(row.accepted_amount);
    if (Number.isFinite(amt) && amt > 0) anchors.push(amt);
  }
  // No accepted amount under ANY lane → completion never auto-charges
  // uncapped: it routes to office review instead.
  if (!anchors.length) return true;
  // The setup-fee ALLOWANCE mirrors completion's AUTHORIZATION, not just
  // the line text: completion widens the cap only for PER-APPLICATION
  // billing whose line has real provenance — an accept-minted invoice, a
  // durable plan-choice selection on the series, a frozen wizard fee on
  // the linked estimate, or an immutable setup_fee_claims record matching
  // the line to the cent. A stale/office-added setup line earns NO
  // allowance and the over-cap invoice routes to office review without
  // charging — so it must not keep the warning either. The authorized
  // bound uses the full line amount (the real allowance is min(line, fee)
  // ≤ the line — anything inside the bound keeps the warning).
  let setupLineAllowance = 0;
  let setupLineAmt = 0;
  try {
    const lines = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []);
    for (const li of Array.isArray(lines) ? lines : []) {
      if (!/one-time setup fee/i.test(String(li?.description || ''))) continue;
      const amt = Number(li?.amount ?? ((Number(li?.quantity) || 1) * (Number(li?.unit_price) || 0)));
      if (Number.isFinite(amt) && amt > 0) setupLineAmt = Math.max(setupLineAmt, amt);
    }
  } catch (e) { /* unparseable lines grant completion NO allowance — the bound stays valid */ }
  // Provenance lookup errors PROPAGATE (→ the caller's fail-toward-warning
  // catch): a transient read error must not shrink the bound and widen the
  // exemption while completion could still grant the allowance and charge.
  if (setupLineAmt > 0 && laneMode === 'per_application') {
    let authorized = /Auto-generated from accepted estimate #/.test(String(inv.notes || ''));
    if (!authorized) {
      authorized = (apptRows || []).some((row) => row.selected_plan === 'per_application');
    }
    // Deliberately NOT the estimate JSON: completion treats the frozen
    // wizard fee as an amount CAP only, never the allowance PREDICATE —
    // every seeded child keeps source_estimate_id, so estimate-derived
    // authorization would outlive the one-time obligation. The predicate
    // comes from current consent (above) or the immutable claim (below).
    if (!authorized) {
      const claim = await conn('setup_fee_claims').where({ invoice_id: inv.id }).first('amount');
      authorized = !!(claim && Math.round(Number(claim.amount) * 100) > 0
        && Math.round(Number(claim.amount) * 100) === Math.round(setupLineAmt * 100));
    }
    if (authorized) setupLineAllowance = setupLineAmt;
  }
  return netSubtotal > Math.max(...anchors) + setupLineAllowance + 0.005;
}

// True when the union of [start, end] date ranges covers EVERY day of
// [windowStart, windowEnd]. Terms are inclusive on both ends, so a term
// ending 09-30 followed by one starting 10-01 is continuous coverage
// (renewals are written as adjacent rows, not extensions of the old row);
// a missing day between them is a real gap — monthly billing charges the
// card during it — and breaks the span.
function mergedRangesSpan(ranges, windowStart, windowEnd) {
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= dayAfter(last[1])) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged.some(([start, end]) => start <= windowStart && end >= windowEnd);
}

/**
 * Customer IDs that every CARD-EXPIRY surface (dashboard cards_expiring_7d,
 * Monday sendCardExpiryWarnings, daily workflows/payment-expiry) must leave
 * alone: paid prepay coverage spanning the WHOLE window — one term, or
 * several ADJACENT paid terms merged (a renewal term starting the day after
 * the prior term ends is continuous coverage; a term starting inside the
 * window does not cover today, a term ending inside it does not cover the
 * horizon, and two terms with a day's gap between them are not continuous)
 * MINUS customers who still have a card charge coming inside the window
 * anyway.
 * Both subtractions DELEGATE to the billing authorities rather than
 * re-deriving them:
 *
 *   (a) a genuinely collectible retry — classified exactly as the retry sweep
 *       (billing-cron retryFailedPayments) would: armed (failed, not
 *       superseded, retry_count < 3, next_retry_at set) AND, for a WaveGuard
 *       Monthly row, neither "already collected" (a paid/processing sibling
 *       for the same billed month — the sweep disarms it without charging)
 *       nor "absorbed" (the obligation date itself is prepay-covered — the
 *       sweep self-supersedes it), and for any row not "parked" (no
 *       PaymentIntent id + metadata.ambiguous_outcome — the sweep supersedes
 *       it without charging), not Auto-Pay-disabled (autopay_enabled=false —
 *       the sweep disarms the ladder without charging) and not paused
 *       through the horizon (autopay_paused_until >= horizon — the sweep's
 *       pause guard skips the retry on every day of the window). Other
 *       one-time retries are collectible.
 *   (b) a visit completion will bill: every still-completable visit in
 *       [today, horizon] run through predictCompletionBilling (billing-lane,
 *       the shared completion predicate) with the same inputs the schedule
 *       sheet feeds it — lane, payer, callback / always-free service type,
 *       the live annual_prepay_invoice stamp validated by
 *       annualPrepayCoversVisit (a bare annual_prepay_term_id link is NOT
 *       per-application fee, completion-auto-charge gate, and LIVE Auto Pay
 *       eligibility (enrollment flag + pause evaluated against the
 *       horizon — deliberately NOT the candidate card's own expiry, which
 *       must never prove its warning unnecessary). Only kind
 *       'auto_charge' keeps the warning — that is the one outcome that
 *       charges the saved card at completion; 'invoice' (pay-link),
 *       'payer', 'covered_*', 'prepaid' and 'no_charge' do not — and only
 *       when neither the visit's own invoices nor the sibling
 *       first-application invoice of its estimate/date already suppress
 *       the completion charge.
 *
 * A term ending inside the window is not covered at the horizon and stays
 * flagged (that card is needed to renew). Fails toward the warning: any
 * lookup error → empty set (nobody exempt).
 */
// HOT-PATH MEMO (Codex PR r13): the dashboard/bell generator polls its
// cache every 30 seconds per process and the alert cron recomputes on a
// five-minute cadence, while this classification runs a per-visit billing
// audit (payer, eligibility, coverage, invoices, suppressors). Memoized
// per horizon on the DEFAULT connection for a short TTL, sharing in-flight
// computations so concurrent cache misses run ONE scan. A fail-toward-
// warning result (lookup error → empty set) is never cached — a transient
// error must not pin "nobody exempt" for the TTL. Explicit connections
// (transactions) bypass the memo entirely. Freshness bound: an exemption
// state change reaches the dashboard at most TTL late, well inside the
// alert cron's own five-minute cadence; the daily/Monday jobs make one
// call each and are unaffected.
const CARD_EXPIRY_EXEMPT_TTL_MS = 2 * 60 * 1000;
const cardExpiryExemptCache = new Map();

function clearCardExpiryExemptCache() {
  cardExpiryExemptCache.clear();
}

async function getCardExpiryExemptCustomerIds(horizon = etDateString(), conn = db) {
  if (conn !== db) return computeCardExpiryExemptCustomerIds(horizon, conn);
  const hit = cardExpiryExemptCache.get(horizon);
  if (hit && Date.now() - hit.at < CARD_EXPIRY_EXEMPT_TTL_MS) {
    return new Set(await hit.promise);
  }
  // evict expired horizons on insert — callers derive a fresh horizon as
  // calendar time advances, so without eviction the map grows with uptime
  for (const [key, staleEntry] of cardExpiryExemptCache) {
    if (Date.now() - staleEntry.at >= CARD_EXPIRY_EXEMPT_TTL_MS) cardExpiryExemptCache.delete(key);
  }
  const entry = { at: Date.now(), promise: computeCardExpiryExemptCustomerIds(horizon, conn) };
  cardExpiryExemptCache.set(horizon, entry);
  const result = await entry.promise;
  if (result.lookupFailed && cardExpiryExemptCache.get(horizon) === entry) {
    cardExpiryExemptCache.delete(horizon);
  }
  // callers get a plain copy — the cached set stays immutable and the
  // lookupFailed marker never leaks
  return new Set(result);
}

async function computeCardExpiryExemptCustomerIds(horizon = etDateString(), conn = db) {
  const today = etDateString();
  let covered;
  try {
    // Paid coverage must span the whole window [today, horizon], but it may
    // be SPLIT across adjacent terms (createTermForAnnualPrepay writes a
    // renewal as a NEW row starting the day after the old term ends). So:
    // fetch every paid term overlapping the window — same covered-term SQL
    // as getActivelyCoveredCustomerIds (coveredTermsAsOf) — and merge each
    // customer's ranges; "covered today" ∩ "covered at the horizon" alone
    // would miss a mid-window gap during which monthly billing charges the
    // card, and a single-term span test would miss an adjacent renewal.
    const rows = await coveredTermsAsOf(conn, null)
      .where('t.term_start', '<=', horizon)
      .where('t.term_end', '>=', today)
      .select('t.customer_id', 't.term_start', 't.term_end');
    const rangesByCustomer = new Map();
    for (const row of rows || []) {
      if (row.customer_id == null) continue;
      const start = dateOnly(row.term_start);
      const end = dateOnly(row.term_end);
      if (!parseYmd(start) || !parseYmd(end)) continue;
      const key = String(row.customer_id);
      if (!rangesByCustomer.has(key)) rangesByCustomer.set(key, []);
      rangesByCustomer.get(key).push([start, end]);
    }
    covered = new Set();
    for (const [customerId, ranges] of rangesByCustomer) {
      if (mergedRangesSpan(ranges, today, horizon)) covered.add(customerId);
    }
  } catch (err) {
    logger.warn(`[annual-prepay] card-expiry exemption: coverage lookup failed, exempting nobody: ${err.message}`);
    const failed = new Set();
    failed.lookupFailed = true;
    return failed;
  }
  if (!covered.size) return covered;
  try {
    // (a) armed retries, classified like the sweep — bounded to the
    // horizon: the sweep only fires rows with next_retry_at <= now, so a
    // retry armed for AFTER the horizon cannot charge inside this warning
    // window (ET end of the horizon day, exclusive next-midnight bound).
    const retryQuery = conn('payments')
      .whereIn('customer_id', [...covered])
      .where({ status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .where('retry_count', '<', 3)
      .whereNotNull('next_retry_at');
    const horizonNextMidnight = dayAfter(dateOnly(horizon));
    if (horizonNextMidnight) {
      retryQuery.where('next_retry_at', '<', parseETDateTime(`${horizonNextMidnight}T00:00:00`));
    }
    const retrying = await retryQuery
      .select('id', 'customer_id', 'description', 'payment_date', 'metadata', 'stripe_payment_intent_id', 'next_retry_at');
    // The sweep's state guards (billing-cron retryFailedPayments /
    // autopay-eligibility.isPaused): disabled Auto Pay permanently DISARMS
    // the ladder without charging; a paused customer's retries are skipped
    // daily WITHOUT disarming, and the pause is date-INCLUSIVE (paused
    // while paused_until >= today, resumes the day after).
    let retryStateByCustomer = new Map();
    if ((retrying || []).length) {
      const stateRows = await conn('customers')
        .whereIn('id', [...new Set(retrying.map((row) => row.customer_id))])
        .select('id', 'autopay_enabled', 'autopay_paused_until', 'billing_mode', 'waveguard_tier', 'monthly_rate');
      retryStateByCustomer = new Map((stateRows || []).map((row) => [String(row.id), row]));
    }
    const { resolveBillingLane: resolveRetryLane } = require('./billing-lane');
    const coveredOn = new Map();
    let pendingHoldIds = null;
    for (const row of retrying || []) {
      const customerId = String(row.customer_id);
      if (!covered.has(customerId)) continue;
      const state = retryStateByCustomer.get(customerId) || {};
      // Auto Pay disabled → the sweep disarms the ladder without charging;
      // the armed row is not a forthcoming card charge.
      if (state.autopay_enabled === false) continue;
      // Paused through the horizon → the sweep skips this retry on every
      // day of [today, horizon]; nothing charges the card inside the
      // window, so the retry does not revoke the exemption. A pause
      // lapsing INSIDE the window keeps the warning — the retry resumes
      // and can charge before the horizon.
      const pausedUntil = dateOnly(state.autopay_paused_until);
      if (pausedUntil && /^\d{4}-\d{2}-\d{2}$/.test(pausedUntil) && pausedUntil >= horizon) continue;
      let meta = {};
      try { meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {}; } catch (e) { meta = {}; }
      // Ambiguous Stripe outcome (no PaymentIntent id): the sweep PARKS the
      // row — supersedes it and raises a health alert, never re-charges — so
      // it is not a forthcoming card charge.
      if (!row.stripe_payment_intent_id && meta.ambiguous_outcome) continue;
      const isMonthly = String(row.description || '').includes('WaveGuard Monthly');
      if (isMonthly) {
        // GUARD 5 mirror: a pending annual-prepay commitment holds the
        // monthly ladder (skip, stay armed) until it activates or cancels.
        // The sweep selects past-due rows on EVERY later run and its
        // pending guard stops the moment term_end passes — a still-armed
        // retry fires the day the hold lapses — so the hold suppresses the
        // warning only when the commitment covers the ENTIRE horizon.
        if (pendingHoldIds == null) pendingHoldIds = await getPaymentPendingCustomerIds(horizon, conn);
        if (pendingHoldIds.has(customerId)) continue;
        // The sweep's billing-lane guard (GUARD 3b mirror): a monthly
        // obligation row for a customer whose lane is no longer monthly
        // (explicit per_application/per_visit/one_time, or a NULL mode the
        // resolver classifies non-monthly), with NO successfully paid
        // monthly charge on file, is DISARMED without charging (likely
        // mis-created; left for manual triage) — not a forthcoming card
        // charge. A missing customer row skips the guard (keep the
        // warning).
        if (state.id != null) {
          const laneNotMonthly = ['per_application', 'per_visit', 'one_time'].includes(state.billing_mode)
            || (!state.billing_mode && resolveRetryLane(state).mode !== 'monthly_membership');
          if (laneNotMonthly) {
            const paidMonthly = await conn('payments')
              .where({ customer_id: row.customer_id, status: 'paid' })
              .where('description', 'like', '%WaveGuard Monthly%')
              .whereNot({ id: row.id })
              .first('id');
            if (!paidMonthly) continue;
          }
        }
        const paidDate = dateOnly(row.payment_date);
        const obligationMonth = meta.billed_month || (paidDate ? paidDate.slice(0, 7) : null);
        if (obligationMonth) {
          // already collected → the sweep disarms without charging
          const [obYear, obMonth] = obligationMonth.split('-').map(Number);
          const obLastDay = new Date(Date.UTC(obYear, obMonth, 0)).getUTCDate();
          const collected = await conn('payments')
            .where({ customer_id: row.customer_id })
            .whereNot({ id: row.id })
            .whereIn('status', ['paid', 'processing'])
            .where(function alreadyCollected() {
              this.whereRaw("metadata->>'billed_month' = ?", [obligationMonth])
                .orWhere(function legacyRow() {
                  this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
                    .andWhere('payment_date', '>=', `${obligationMonth}-01`)
                    .andWhere('payment_date', '<=', `${obligationMonth}-${String(obLastDay).padStart(2, '0')}`)
                    .andWhere('description', 'like', '%WaveGuard Monthly%');
                });
            })
            .first('id');
          if (collected) continue;
          // absorbed → the sweep self-supersedes without charging
          const obligationDate = (paidDate && paidDate.slice(0, 7) === obligationMonth) ? paidDate : `${obligationMonth}-01`;
          if (!coveredOn.has(obligationDate)) coveredOn.set(obligationDate, await getActivelyCoveredCustomerIds(obligationDate, conn));
          if (coveredOn.get(obligationDate).has(customerId)) continue;
        }
      }
      covered.delete(customerId);
    }
    if (!covered.size) return covered;

    // (b) still-completable visits inside the window, judged by the shared
    // completion predicate with the schedule sheet's inputs.
    const { predictCompletionBilling, resolveBillingLane } = require('./billing-lane');
    const { resolveForInvoice } = require('./payer');
    const { isCardHoldEnabled } = require('./estimate-card-holds');
    const { findFirstApplicationInvoiceForEstimateService } = require('./estimate-first-application-invoice');
    const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
    const completionAutopayChargeEnabled = require('../config/feature-gates').gates.completionAutopayCharge === true;
    // Real columns only: the payer is resolved by the payer authority
    // (scheduled_services.payer_id → self-pay override → customers.payer_id,
    // payer.resolveForInvoice — the same resolver completion uses), and
    // per_application_fee lives on customers.
    // No lower date bound: an OVERDUE nonterminal visit (pending/confirmed/
    // en_route/on_site with a past scheduled_date) is still completable —
    // the completion handler rejects only terminal states — and its
    // auto-charge would land inside the window, today at the earliest.
    const visits = await conn('scheduled_services as ss')
      .join('customers as c', 'c.id', 'ss.customer_id')
      .whereIn('ss.customer_id', [...covered])
      .where(function stillChargeable() {
        this.whereNotIn('ss.status', CARD_EXPIRY_TERMINAL_VISIT_STATUSES)
          // A COMPLETED visit whose completion attempt still has
          // unfinished resumable billing side effects (crash/503 between
          // the durable completion commit and the invoice/charge) is
          // still chargeable — the resume path permits completed→
          // completed and continues the billing. Terminal 'completed'
          // hides the visit only once no such attempt remains.
          .orWhere(function completedUnfinishedBilling() {
            this.where('ss.status', 'completed').whereExists(function unfinishedAttempt() {
              this.from('service_completion_attempts as sca')
                .whereRaw('sca.service_id = ss.id')
                .whereIn('sca.status', ['side_effects_pending', 'side_effects_running'])
                .select('sca.id');
            });
          });
      })
      .where('ss.scheduled_date', '<=', horizon)
      .select(
        'ss.id', 'ss.customer_id', 'ss.status', 'ss.estimated_price', 'ss.is_callback', 'ss.service_type',
        'ss.prepaid_amount', 'ss.prepaid_method', 'ss.annual_prepay_term_id', 'ss.is_recurring',
        'ss.source_estimate_id', 'ss.scheduled_date', 'ss.recurring_parent_id', 'ss.recurring_pattern',
        'c.billing_mode', 'c.waveguard_tier', 'c.monthly_rate', 'c.autopay_enabled',
        'c.autopay_paused_until as customer_autopay_paused_until',
        'c.autopay_payment_method_id as customer_autopay_payment_method_id',
        'c.ach_status as customer_ach_status',
        'c.per_application_fee', 'c.payer_id as customer_payer_id',
      );
    for (const v of visits || []) {
      const customerId = String(v.customer_id);
      if (!covered.has(customerId)) continue;
      // Strict validation, and its failure PROPAGATES to the outer catch:
      // a malformed stamp (no amount / no term) or a failed coverage query
      // must fail toward the warning, not fall back to trusting the stamp
      // (predictCompletionBilling treats null as "trust the stamp").
      const annualCoverageValidated = v.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD
        ? await annualPrepayCoversVisit(v, conn, { throwOnError: true })
        : null;
      const payer = await resolveForInvoice({
        database: conn, customerId: v.customer_id, customer: { id: v.customer_id, payer_id: v.customer_payer_id },
        scheduledServiceId: v.id, throwOnError: true,
      });
      // Auto Pay eligibility for the PREDICTION: the enrollment flag plus
      // the pause — deliberately NOT the live chargeable-method walk. The
      // warning's whole purpose is to prompt replacing a dying card, so
      // the candidate card's own expiry state must not prove the warning
      // unnecessary (an expired card would read as "no chargeable method
      // → pay-link → exempt" and suppress exactly the notice that fixes
      // it); a customer with no method at all keeps the warning too —
      // noise, never a missed charge. The pause suppresses THIS visit's
      // charge only when it covers the ENTIRE remaining completion window
      // (paused_until >= horizon, date-INCLUSIVE): completion rejects only
      // terminal statuses, so a late completion after a shorter pause
      // lapses re-reads the then-current pause and charges.
      const pausedUntilYmd = dateOnly(v.customer_autopay_paused_until);
      const pauseCoversChargeWindow = !!(pausedUntilYmd && /^\d{4}-\d{2}-\d{2}$/.test(pausedUntilYmd) && pausedUntilYmd >= horizon);
      const autopayActive = v.autopay_enabled !== false && !pauseCoversChargeWindow;
      const lane = resolveBillingLane({ billing_mode: v.billing_mode, waveguard_tier: v.waveguard_tier, monthly_rate: v.monthly_rate });
      const prediction = predictCompletionBilling({
        lane: lane.mode,
        billingMode: v.billing_mode || null,
        autopayActive,
        estimatedPrice: v.estimated_price != null ? Number(v.estimated_price) : null,
        monthlyRate: v.monthly_rate,
        perApplicationFee: v.per_application_fee,
        isRecurring: !!v.is_recurring,
        isCallback: !!v.is_callback,
        serviceType: v.service_type,
        payerBilled: !!payer?.payerId,
        prepaidAmount: v.prepaid_amount,
        prepaidMethod: v.prepaid_method || null,
        annualCoverageValidated,
        completionAutopayChargeEnabled,
      });
      // Estimate card holds are NEVER Auto-Pay-gated: completion charges a
      // live ('held') hold against the visit's collectible completion
      // invoice (chargeCardHoldOnCompletion — the same predicate as
      // heldCardForScheduledService), whatever the pause or method
      // eligibility says. So a visit that will produce a priced completion
      // invoice — kind 'auto_charge' OR pay-link 'invoice' — with a live
      // hold keeps the warning even when Auto Pay cannot charge; kinds
      // that mint no invoice (covered_*, prepaid, no_charge) leave the
      // hold nothing to charge, and a payer-billed invoice refuses the
      // hold's self-pay binding.
      // The visit's service records: record-linked invoices take lookup
      // precedence (below), and a COMPLETED visit resumed in FROZEN
      // BACKFILL mode (structured_notes.backfill === true — the committed
      // record's mode wins on resume) skips the entire auto-charge rail:
      // its invoice is deliberately left for operator collection, so no
      // card charge and no warning.
      const serviceRecords = await conn('service_records')
        .where({ scheduled_service_id: v.id })
        .select('id', 'structured_notes');
      // Only records OWNED by an unfinished resumable attempt participate
      // in invoice lookup precedence and the backfill verdict — the resume
      // path loads claim.serviceRecordId, never "any record linked to the
      // visit", so a historical record's invoices must not stand in.
      const attemptRecordIds = new Set();
      if (String(v.status) === 'completed') {
        const unfinishedAttempts = await conn('service_completion_attempts')
          .where({ service_id: v.id })
          .whereIn('status', ['side_effects_pending', 'side_effects_running'])
          .select('service_record_id');
        for (const attempt of unfinishedAttempts || []) {
          if (attempt.service_record_id != null) attemptRecordIds.add(String(attempt.service_record_id));
        }
        // Frozen-backfill exemption: EVERY unfinished attempt must be
        // bound to a record that froze backfill — an attempt on a normal
        // record (or with no committed record yet) can still charge.
        const recordById = new Map((serviceRecords || []).map((record) => [String(record.id), record]));
        const allResumesFrozenBackfill = (unfinishedAttempts || []).length > 0
          && (unfinishedAttempts || []).every((attempt) => {
            const record = attempt.service_record_id != null ? recordById.get(String(attempt.service_record_id)) : null;
            if (!record) return false;
            let notes = record.structured_notes;
            if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
            return notes?.backfill === true;
          });
        if (allResumesFrozenBackfill) continue;
      }
      // The hold rail's charge passes requireCompletedOneTimeVisit — a
      // visit with recurring lineage (is_recurring, recurring_parent_id,
      // or a recurring_pattern) is refused at the Stripe boundary, so a
      // leftover hold on such a visit is no charge vector.
      const oneTimeLineage = v.is_recurring !== true && !v.recurring_parent_id && !v.recurring_pattern;
      let liveHold = null;
      if (oneTimeLineage && isCardHoldEnabled()) {
        // The charge rail's own resolution and admission: it selects the
        // NEWEST 'held' row (heldCardForScheduledService orders by held_at
        // DESC) and THEN refuses a parked row and a missing/non-positive
        // frozen accepted amount (withheld fail-closed) — so the same row
        // the rail would resolve decides here, not some other consent.
        const holdRow = await conn('estimate_card_holds')
          .where({ scheduled_service_id: v.id, status: 'held' })
          .orderBy('held_at', 'desc')
          .first('id', 'accepted_amount', 'parked_at');
        if (holdRow && !holdRow.parked_at) {
          const acceptedRaw = Number(holdRow.accepted_amount);
          liveHold = Number.isFinite(acceptedRaw) && acceptedRaw > 0
            ? { id: holdRow.id, acceptedAmount: acceptedRaw }
            : null;
        }
      }
      // Appointment-card consent state feeds TWO verdicts: the lane's own
      // charge (GATE_APPT_CARD_COMPLETION_CHARGE — a completed/satisfied
      // consent for the visit's CURRENT customer, no hold row, one-time
      // visit — charges even while the generic completion gate is off),
      // and the extended charge's exclusion (requireNoAppointmentCardLane
      // refuses ANY consent row, matching or not). A visit whose consent
      // rows block the extended charge while the lane itself cannot charge
      // has nothing left to touch the card.
      const consentRows = await conn('appointment_card_requests')
        .where({ scheduled_service_id: v.id })
        .select('id', 'customer_id', 'status', 'accepted_amount');
      let apptCardCharge = false;
      let apptLaneChargeable = false;
      let apptAcceptedAmount = null;
      if ((consentRows || []).length) {
        // The hold rail itself passes requireNoAppointmentCardLane — ANY
        // competing consent row refuses the hold charge, so a hold beside
        // consent rows is not a charge vector (and the hold row already
        // excludes the appointment and extended lanes).
        liveHold = null;
        const laneRow = (consentRows || []).find((row) => ['completed', 'satisfied'].includes(String(row.status)));
        const anyHoldRow = await conn('estimate_card_holds')
          .where({ scheduled_service_id: v.id })
          .first('id');
        // The lane's cap is the amount FROZEN at consent — a missing/
        // non-positive accepted_amount routes to office review without
        // charging, so the lane is not chargeable at all.
        const acceptedRaw = laneRow ? Number(laneRow.accepted_amount) : NaN;
        apptAcceptedAmount = Number.isFinite(acceptedRaw) && acceptedRaw > 0 ? acceptedRaw : null;
        apptLaneChargeable = !!laneRow && !anyHoldRow && v.is_recurring !== true
          && apptAcceptedAmount != null
          && String(laneRow.customer_id) === String(v.customer_id)
          && require('../config/feature-gates').isEnabled('apptCardCompletionCharge');
        apptCardCharge = apptLaneChargeable && !liveHold && prediction.kind === 'invoice' && autopayActive;
        if (prediction.kind === 'auto_charge' && lane.mode !== 'per_application' && !liveHold && !apptLaneChargeable) {
          // stale/mismatched/pending/uncapped consent: the extended charge
          // refuses any consent row and the lane cannot charge either →
          // no card charge, no warning
          continue;
        }
      }
      // ANY non-terminal hold row (held/charging/charge_review/parked-held)
      // closes the EXTENDED lane (extendedHoldExcluded — the customer
      // consented to THAT card at THAT amount): on a non-per-application
      // lane the hold rail is then the only remaining vector, so a hold
      // row the rail refuses (parked, no frozen amount) leaves nothing to
      // charge even when the predictor says auto_charge.
      let holdClosesExtended = false;
      if (lane.mode !== 'per_application') {
        holdClosesExtended = !!(await conn('estimate_card_holds')
          .where({ scheduled_service_id: v.id })
          .whereNotIn('status', ['released', 'cancelled', 'failed'])
          .first('id'));
      }
      if (holdClosesExtended && !liveHold && !apptCardCharge) continue;
      if (prediction.kind !== 'auto_charge' && !liveHold && !apptCardCharge) continue;
      // Kinds that MINT no bill (covered_*, prepaid, no_charge — e.g. a
      // callback) can still charge through a live hold, but only against
      // an EXISTING collectible invoice: completion reuses any open
      // invoice it finds and the hold rail does not reject callbacks or
      // free service types. With no existing invoice there is nothing to
      // charge — the invoice checks below decide.
      const mintsNothing = !['auto_charge', 'invoice'].includes(prediction.kind);
      // Completion's invoice state machine (admin-dispatch; route-module
      // helpers, mirrored here with the same status sets):
      //   - completionTerminalInvoiceLookup: a REFUNDED invoice for the visit
      //     parks it — no charge;
      //   - completionSuppressorInvoiceLookup: the most recent NON-cancelled
      //     invoice is reused, and paid / prepaid / processing means already
      //     settled — no second card charge.
      // Either way the expiring card is not what breaks: no warning.
      const visitInvoices = await conn('invoices')
        // Both identifiers, like the completion lookups: a resumed
        // completed visit's invoice may be linked only through its
        // service record.
        .where(function ownedByVisit() {
          this.where({ scheduled_service_id: v.id });
          if (attemptRecordIds.size) {
            this.orWhereIn('service_record_id', [...attemptRecordIds]);
          }
        })
        .orderBy('created_at', 'desc')
        .select('id', 'status', 'subtotal', 'total', 'discount_amount', 'line_items', 'notes', 'payer_id', 'service_record_id', 'scheduled_service_id');
      const statusOf = (inv) => String(inv?.status || '').toLowerCase();
      // The refunded (terminal) check spans BOTH identifiers, like
      // completionTerminalInvoiceLookup.
      if ((visitInvoices || []).some((inv) => statusOf(inv) === 'refunded')) continue;
      // Reuse PRECEDENCE mirrors the completion suppressor chain: the
      // service-record link is checked first, and the scheduled_service_id
      // rows are consulted only when no live record-linked row stands.
      const recordLinked = (visitInvoices || []).filter((inv) => inv.service_record_id != null && attemptRecordIds.has(String(inv.service_record_id)));
      const reused = recordLinked.find((inv) => !CANCELLED_SERVICE_RESOLVED_STATUSES.includes(statusOf(inv)))
        || (visitInvoices || []).find((inv) => !CANCELLED_SERVICE_RESOLVED_STATUSES.includes(statusOf(inv)));
      if (mintsNothing && !reused) continue;
      if (reused && ['paid', 'prepaid', 'processing'].includes(statusOf(reused))) continue;
      if (reused && lane.mode !== 'per_application' && String(reused.scheduled_service_id || '') !== String(v.id)) {
        // An OPEN record-only invoice (no scheduled_service_id binding to
        // THIS visit) cannot be card-charged: the extended money boundary
        // returns invoice_unbound, and the hold/appointment rails re-prove
        // the same binding under their own locks — it is reused as a
        // pay-link only. Settled/refunded record-linked suppressors above
        // still count.
        continue;
      }
      // An explicit "stop collecting this invoice" instruction (disputed
      // bill, check in the mail): the EXTENDED completion charge — the
      // lane that charges existing reused invoices — passes
      // refuseWhenDunningStopped and the Stripe transaction refuses the
      // invoice, so no saved-card charge can occur. Scoped to non-
      // per-application lanes because only the extended charge honors the
      // stop (the per-application path does not pass the flag — keep that
      // warning).
      const dunningStopped = async (inv) => {
        if (lane.mode === 'per_application') return false;
        const seq = await conn('invoice_followup_sequences')
          .where({ invoice_id: inv.id })
          .first('status');
        return !!(seq && String(seq.status || '').toLowerCase() === 'stopped');
      };
      if (reused) {
        // A reused invoice with FROZEN payer ownership is owed by the
        // payer's AP inbox — completion requires !invoice.payer_id before
        // every saved-card charge, whatever the service/customer links
        // currently resolve to (the invoice's stamp is authoritative for
        // the invoice it reuses).
        if (reused.payer_id) continue;
        // An OPEN reused invoice charges only within completion's cap —
        // over the accepted amount it routes to office review instead.
        if (await openInvoiceClearlyOverCompletionCap(reused, v, lane.mode, conn)) continue;
        // the appointment rail does NOT honor the dunning stop — when its
        // lane can charge this visit, the stop does not make the bill safe
        if (!liveHold && !apptLaneChargeable && await dunningStopped(reused)) continue;
        // An ACTIVE payment plan owns this invoice's collection — the
        // shared anchor verdict (verifyExtendedCompletionAnchor) refuses
        // the completion charge with active_payment_plan. Scoped like the
        // dunning stop (extended lanes; the hold rail does not run the
        // anchor verdict, so a live hold keeps the warning).
        // …and, like the dunning stop, never when the appointment lane
        // can charge — that rail does not run the anchor verdict.
        if (!liveHold && !apptLaneChargeable && lane.mode !== 'per_application') {
          const activePlan = await conn('payment_plans')
            .where({ invoice_id: reused.id, status: 'active' })
            .first('id');
          if (activePlan) continue;
        }
      } else {
        // No direct invoice on the visit → completion consults the SIBLING
        // first-application invoice of the same estimate/date
        // (findFirstApplicationInvoiceForEstimateService, the shared
        // service completion itself calls): a refunded match PARKS the
        // completion (manual billing, no charge); a live match is REUSED —
        // settled (paid/prepaid/processing) means no card charge; a
        // canceled setup-fee acceptance invoice with no live replacement
        // also parks (bill both charges by hand). Only "no suppressor at
        // all" or a live OPEN sibling (which completion can still
        // auto-charge, inside the same cap) keeps the warning.
        const sibling = await findFirstApplicationInvoiceForEstimateService(v, conn);
        const siblingStatus = statusOf(sibling.invoice);
        if (siblingStatus === 'refunded') continue;
        if (['paid', 'prepaid', 'processing'].includes(siblingStatus)) continue;
        if (!sibling.invoice && sibling.canceledSetupFee) continue;
        if (sibling.invoice && lane.mode !== 'per_application'
          && String(sibling.invoice.scheduled_service_id || '') !== String(v.id)) {
          // an OPEN invoice bound to a SIBLING visit cannot be charged for
          // THIS one — the extended money boundary returns invoice_unbound
          // and the hold/appointment rails re-prove the same binding; it
          // is reused as a pay-link only
          continue;
        }
        if (sibling.invoice && sibling.invoice.payer_id) continue;
        if (sibling.invoice && await openInvoiceClearlyOverCompletionCap(sibling.invoice, v, lane.mode, conn)) continue;
        if (sibling.invoice && !liveHold && !apptLaneChargeable && await dunningStopped(sibling.invoice)) continue;
      }
      // Frozen-cap verdicts for the consent rails, applied whenever that
      // rail is the ONLY charge vector: the hold rail withholds a bill
      // net-above its accepted_amount (and the hold row itself closes the
      // extended lane, so this holds even when the predictor says
      // auto_charge); the appointment lane routes an over-cap bill to
      // office review the same way. Nothing then touches the card.
      const chargeBasis = reused
        ? Math.round(((reused.subtotal != null ? Number(reused.subtotal) : Number(reused.total || 0))
          - Math.max(0, Number(reused.discount_amount) || 0)) * 100) / 100
        : (v.estimated_price != null ? Number(v.estimated_price) : null);
      if (liveHold && !apptCardCharge
        && (prediction.kind !== 'auto_charge' || holdClosesExtended)) {
        if (chargeBasis != null && chargeBasis > liveHold.acceptedAmount + 0.005) continue;
      }
      const apptLaneIsVector = apptLaneChargeable && !liveHold
        && (apptCardCharge || (prediction.kind === 'auto_charge' && lane.mode !== 'per_application'));
      if (apptLaneIsVector && chargeBasis != null && apptAcceptedAmount != null
        && chargeBasis > apptAcceptedAmount + 0.005) continue;
      // The unminted setup-fee completion hold (owner ruling 2026-08-24,
      // GATE_UNMINTED_SETUP_FEE_PARK): a Mark Won estimate's plan visit
      // that still owes the never-minted setup fee is PARKED for manual
      // billing — both charges — instead of touching the saved card. One
      // parked visit per estimate: when a DIFFERENT visit already holds
      // the parked alert, this one mints and charges normally (keep the
      // warning). A detector error means the completion mints normally
      // too — same catch direction, keep the warning.
      if (v.source_estimate_id && process.env.GATE_UNMINTED_SETUP_FEE_PARK === 'true') {
        let parkedHere = false;
        try {
          const { findUnmintedSetupFeeObligation } = require('./setup-fee-obligation');
          const obligation = await findUnmintedSetupFeeObligation({
            sourceEstimateId: v.source_estimate_id,
            customerId: v.customer_id,
            excludeScheduledServiceId: v.id,
            visitPlanRow: { is_recurring: v.is_recurring, recurring_parent_id: v.recurring_parent_id || null },
          }, conn);
          if (obligation.owed && !obligation.firstVisitAlreadyCompleted) {
            const priorParkedAlert = await conn('notifications')
              .where({ recipient_type: 'admin' })
              .whereRaw("metadata->>'dedupeKey' = ?", [`unminted_setup_fee_manual_billing:${v.source_estimate_id}`])
              .whereRaw("COALESCE(metadata->>'resolvedCovered', '') <> 'true'")
              .first('id', 'metadata');
            const parkedVisitId = priorParkedAlert && (typeof priorParkedAlert.metadata === 'string'
              ? (() => { try { return JSON.parse(priorParkedAlert.metadata)?.scheduledServiceId; } catch { return null; } })()
              : priorParkedAlert.metadata?.scheduledServiceId);
            parkedHere = !priorParkedAlert || String(parkedVisitId || '') === String(v.id);
          }
        } catch (e) { parkedHere = false; }
        if (parkedHere) continue;
      }
      // Only an auto_charge touches the saved card at completion ('invoice'
      // — gate off or a priced callback — goes out as a pay-link).
      covered.delete(customerId);
    }
  } catch (err) {
    logger.warn(`[annual-prepay] card-expiry exemption: charge lookup failed, exempting nobody: ${err.message}`);
    const failed = new Set();
    failed.lookupFailed = true;
    return failed;
  }
  return covered;
}

/**
 * Customer IDs with an annual-prepay commitment whose invoice is still open.
 * These customers have not paid for coverage yet, so they are not "actively
 * covered"; the monthly billing cron still must not charge them while the
 * annual-prepay invoice is pending review/payment. Bounded to terms whose
 * window has not ended and whose linked invoice is still open (not paid, void,
 * cancelled, or refunded) so a stale/void pending row cannot suppress billing
 * indefinitely. Dispute-SUSPENDED terms (identified by the
 * dispute_suspended_at marker the suspend path stamps) are excluded — their
 * money was provisionally clawed back, so normal billing resumes for the
 * dispute window.
 */
async function getPaymentPendingCustomerIds(asOf = etDateString(), conn = db) {
  if (!(await annualPrepayTableExists())) return new Set();
  const coverageDate = dateOnly(asOf) || etDateString();
  const cancelledStatuses = [...INVOICE_CANCELLED_STATUSES];
  const termCols = await annualPrepayColumns(conn);
  const pendingQuery = conn('annual_prepay_terms as t')
    .join('invoices as i', 'i.id', 't.prepay_invoice_id')
    .where('t.status', PAYMENT_PENDING_STATUS)
    .whereNotNull('t.prepay_invoice_id')
    .where('t.term_end', '>=', coverageDate);
  // Dispute-SUSPENDED terms don't suppress monthly billing. Suppression
  // exists so an accept-time prepay commitment isn't monthly-billed while
  // its invoice awaits first payment — but a suspended term's money was
  // provisionally clawed back, and for a prior-monthly customer the
  // suppression here plus the dues-cover completion fiction would leave
  // dispute-window visits entirely unbilled. The dispute_suspended_at
  // marker (stamped by the suspend demotion, cleared on reactivation) is
  // the classifier: accept-pending terms never carry it, so they keep the
  // suppression. It supersedes the prior_billing_mode heuristic — prior is
  // only written at ACTIVATION, so a LEGACY term that activated before
  // that column existed suspends with prior still NULL and the heuristic
  // would wrongly keep suppressing its customer's monthly dues (Codex
  // #2533 round-2). The heuristic remains only as the pre-migration
  // fallback, where it can't be wrong the other way: prior recorded ⟹
  // once-active ⟹ the only pending hop back is a dispute suspension.
  if (termCols.dispute_suspended_at) {
    pendingQuery.whereNull('t.dispute_suspended_at');
  } else if (termCols.prior_billing_mode) {
    pendingQuery.whereNull('t.prior_billing_mode');
  }
  const rows = await pendingQuery
    .whereRaw(
      `lower(coalesce(i.status, 'draft')) not in (${cancelledStatuses.map(() => '?').join(', ')})`,
      cancelledStatuses,
    )
    .whereRaw("lower(coalesce(i.status, 'draft')) <> 'paid'")
    .whereNull('i.paid_at')
    .distinct('t.customer_id');
  return new Set(rows.filter((row) => row.customer_id != null).map((row) => String(row.customer_id)));
}

// Owner ruling 2026-07-09: annual-prepay customers carry billing_mode
// 'annual_prepay' as their classification — it drives autopay enrollment at
// signup (stripe-webhook save-card mirror) and marks them NOT
// per-application for completion billing. Deliberately NOT a billing
// suppressor: the monthly cron keeps trusting its coverage-dated term
// guards, so a later term cancel/refund returns the customer to normal
// billing without this stamp needing cleanup. The estimate converter stamps
// every recurring accept 'per_application'; the term choke point
// (portal accept, prepay-on-book, Customer 360 record-prepay all run through
// createTermForAnnualPrepay) re-stamps the prepay ones — but ONLY once the
// term is ACTIVE (paid). payment_pending terms stay 'per_application' so
// pre-payment completions keep billing per application; the payment sync
// stamps on the pending→active transition. Best-effort + column-guarded:
// term creation must never fail on this stamp.
async function stampAnnualPrepayBillingMode(customerId, conn, termId = null) {
  try {
    if (!(await conn.schema.hasColumn('customers', 'billing_mode'))) return;
    // Record what the customer was BEFORE prepay so a later void/refund can
    // restore it EXACTLY (Codex round-7: a per_application customer buying a
    // MANUAL prepay has no source_estimate_id on the term, and the heuristic
    // alone would wrongly return them to legacy monthly). 'none' = prior
    // mode was NULL; a NULL column value means "not recorded" (pre-column
    // terms) and falls back to the heuristic. First stamp wins — renewal
    // syncs / duplicate webhooks re-stamp the customer but never overwrite
    // the recorded prior with 'annual_prepay'.
    if (termId && (await conn.schema.hasColumn('annual_prepay_terms', 'prior_billing_mode'))) {
      const current = await conn('customers').where({ id: customerId }).first('billing_mode');
      if (current && current.billing_mode !== 'annual_prepay') {
        await conn('annual_prepay_terms')
          .where({ id: termId })
          .whereNull('prior_billing_mode')
          .update({ prior_billing_mode: current.billing_mode || 'none' });
      } else if (current) {
        // Already annual_prepay (a renewal or a second manual term) — carry
        // the ORIGINAL prior forward from the earlier term, or a later
        // refund of this new term would fall back to the heuristic and
        // restore the wrong mode (Codex round-8: a manual renewal term has
        // no source estimate, so a per_application-origin customer would
        // land on legacy monthly).
        const prev = await conn('annual_prepay_terms')
          .where({ customer_id: customerId })
          .whereNot({ id: termId })
          .whereNotNull('prior_billing_mode')
          .orderBy('created_at', 'desc')
          .first('prior_billing_mode');
        if (prev?.prior_billing_mode) {
          await conn('annual_prepay_terms')
            .where({ id: termId })
            .whereNull('prior_billing_mode')
            .update({ prior_billing_mode: prev.prior_billing_mode });
        }
      }
    }
    await conn('customers')
      .where({ id: customerId })
      .update({ billing_mode: 'annual_prepay', updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] billing_mode stamp skipped for customer ${customerId}: ${err.message}`);
  }
}

// A true void/refund cancels the prepay coverage — the customer must return
// to a billable mode, or the monthly cron's 'annual_prepay' skip (GUARD 3b,
// Codex round-5) leaves them unbilled forever. Estimate-flow terms
// (source_estimate_id set) return to per-visit billing; Customer 360 /
// manual prepays (no source estimate — often legacy monthly members who
// prepaid a year) return to legacy monthly semantics (NULL). Guarded on the
// current mode so a customer who already switched models isn't clobbered.
// Best-effort + column-guarded, same contract as the stamp — except the
// dispute-suspend path, which opts into throwOnError so a transient failure
// fails the webhook (Stripe retries) instead of stranding mid-dispute
// completions in the never-invoice branch with nothing to retry.
async function resetBillingModeAfterTermCancel(term, conn, { throwOnError = false } = {}) {
  try {
    if (!(await conn.schema.hasColumn('customers', 'billing_mode'))) return;
    // Replacement coverage keeps the mode — but only a PAID (genuinely
    // covering) term counts: a payment_pending replacement is deliberately
    // NOT stamped (pre-payment completions bill per application/monthly),
    // so keeping 'annual_prepay' for it would strand the customer in a
    // nothing-bills limbo — cron skips the mode, completion refuses it,
    // and the pending invoice may never be paid (Codex round-8 P1). When
    // the pending term DOES pay, syncTermForInvoicePayment re-stamps.
    // Same for a row whose window does not contain TODAY: coveredTermsAsOf
    // only covers dates inside [term_start, term_end], so an EXPIRED
    // active/renewal_pending row (lapsed renewal never decided — Codex
    // round-11) or a paid FUTURE term that hasn't started yet (Codex
    // round-12) is not coverage right now — keeping the stamp for either is
    // the same nothing-bills limbo during the gap. Resetting under a future
    // term is safe: once its window opens, coveredTermsAsOf / prepaidCovered
    // protect covered visits regardless of billing_mode. Live window only,
    // ET date convention.
    const today = etDateString();
    const replacement = await conn('annual_prepay_terms')
      .where({ customer_id: term.customer_id })
      .whereNot({ id: term.id })
      .whereIn('status', ACTIVE_STATUSES)
      .where('term_start', '<=', today)
      .where('term_end', '>=', today)
      .first('id');
    if (replacement) return;
    // Restore the EXACT prior mode when the stamp recorded it ('none' =
    // legacy NULL); pre-column terms fall back to the source heuristic
    // (estimate-flow term → per-visit, manual prepay → legacy monthly).
    let restored;
    if (await conn.schema.hasColumn('annual_prepay_terms', 'prior_billing_mode')) {
      const trow = await conn('annual_prepay_terms').where({ id: term.id }).first('prior_billing_mode');
      if (trow?.prior_billing_mode) {
        restored = trow.prior_billing_mode === 'none' ? null : trow.prior_billing_mode;
      }
    }
    if (restored === undefined) {
      restored = term.source_estimate_id ? 'per_application' : null;
    }
    await conn('customers')
      .where({ id: term.customer_id, billing_mode: 'annual_prepay' })
      .update({
        billing_mode: restored,
        updated_at: new Date(),
      });
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[annual-prepay] billing_mode reset skipped for customer ${term.customer_id}: ${err.message}`);
  }
}

async function createTermForAnnualPrepay({
  customerId,
  sourceEstimateId = null,
  prepayInvoiceId = null,
  planLabel = 'WaveGuard Annual Prepay',
  monthlyRate = null,
  prepayAmount = null,
  termStart = null,
  termEnd = null,
  coverageServiceType = undefined,
  coverageVisitCount = undefined,
  coverageCadence = undefined,
  firstVisitDate = undefined,
  firstVisitWindowStart = undefined,
  conn = db,
} = {}) {
  if (!(await annualPrepayTableExists())) return null;
  if (!customerId) throw new Error('customerId is required');

  const hasExplicitTermStart = termStart !== null && termStart !== undefined && termStart !== '';
  const hasExplicitTermEnd = termEnd !== null && termEnd !== undefined && termEnd !== '';
  const normalizedStart = dateOnly(termStart) || etDateString();
  const normalizedEnd = dateOnly(termEnd) || addMonthsSameDay(normalizedStart, 12);
  if (!normalizedEnd) throw new Error('Could not determine annual prepay term end');
  const nextStatus = await statusForPrepayInvoice(prepayInvoiceId, conn);
  const termCols = await annualPrepayColumns(conn);
  const normalizedCoverageServiceType = coverageServiceType === undefined
    ? undefined
    : normalizeCoverageServiceType(coverageServiceType);
  const normalizedCoverageVisitCount = coverageVisitCount === undefined
    ? undefined
    : normalizeCoverageVisitCount(coverageVisitCount);
  const normalizedCoverageCadence = coverageCadence === undefined
    ? undefined
    : normalizeCoverageCadence(coverageCadence);
  // First-visit intent: the date/time already promised to the customer. Only
  // meaningful inside the coverage window — an out-of-window date would anchor
  // the series outside the term it belongs to, so it is dropped rather than
  // honored.
  const normalizedFirstVisitDate = firstVisitDate === undefined
    ? undefined
    : (() => {
      const value = dateOnly(firstVisitDate);
      if (!value) return null;
      return value >= normalizedStart && value <= normalizedEnd ? value : null;
    })();
  const normalizedFirstVisitWindowStart = firstVisitWindowStart === undefined
    ? undefined
    : normalizeWindowStart(firstVisitWindowStart);

  let existing = null;
  if (sourceEstimateId || prepayInvoiceId) {
    existing = await conn('annual_prepay_terms')
      .where(function () {
        if (sourceEstimateId) this.orWhere({ source_estimate_id: sourceEstimateId });
        if (prepayInvoiceId) this.orWhere({ prepay_invoice_id: prepayInvoiceId });
      })
      .first();
  }
  if (!existing) {
    existing = await conn('annual_prepay_terms')
      .where({
        customer_id: customerId,
        term_start: normalizedStart,
        term_end: normalizedEnd,
      })
      .whereIn('status', ACTIVE_STATUSES)
      .first();
  }

  if (existing) {
    const updates = {
      source_estimate_id: existing.source_estimate_id || sourceEstimateId || null,
      prepay_invoice_id: existing.prepay_invoice_id || prepayInvoiceId || null,
      plan_label: planLabel || existing.plan_label,
      monthly_rate: monthlyRate != null ? monthlyRate : existing.monthly_rate,
      prepay_amount: prepayAmount != null ? prepayAmount : existing.prepay_amount,
      status: existing.renewal_decision ? existing.status : nextStatus,
      updated_at: new Date(),
    };
    // Honor explicitly supplied coverage dates so an edit can correct them.
    // Only the start supplied → recompute the 12-month end from it (normalizedEnd
    // already carries start+12mo when termEnd was blank); neither supplied →
    // leave the existing window untouched (the estimate flow re-runs with null
    // dates and must not have its term reset).
    if (hasExplicitTermStart) updates.term_start = normalizedStart;
    if (hasExplicitTermEnd) updates.term_end = normalizedEnd;
    else if (hasExplicitTermStart) updates.term_end = normalizedEnd;
    if (termCols.coverage_service_type && normalizedCoverageServiceType !== undefined) {
      updates.coverage_service_type = normalizedCoverageServiceType;
    }
    if (termCols.coverage_visit_count && normalizedCoverageVisitCount !== undefined) {
      updates.coverage_visit_count = normalizedCoverageVisitCount;
    }
    if (termCols.coverage_cadence && normalizedCoverageCadence !== undefined) {
      updates.coverage_cadence = normalizedCoverageCadence;
    }
    if (termCols.first_visit_date && normalizedFirstVisitDate !== undefined) {
      updates.first_visit_date = normalizedFirstVisitDate;
    }
    if (termCols.first_visit_window_start && normalizedFirstVisitWindowStart !== undefined) {
      updates.first_visit_window_start = normalizedFirstVisitWindowStart;
    }
    await conn('annual_prepay_terms').where({ id: existing.id }).update(updates);
    // When the coverage window is edited (start/end actually supplied), detach
    // any visits attachScheduledServices() stamped under the old window that now
    // fall outside it — refreshTermSnapshot only re-attaches in-window visits, it
    // never removes out-of-window ones, so a shortened/moved window would keep
    // reporting stale visits as Annual Prepay. Skipped when no dates were given
    // (the estimate re-run path), so it only fires on a real window change.
    if (updates.term_start || updates.term_end) {
      const scCols = await scheduledServiceColumns();
      if (scCols.annual_prepay_term_id) {
        const winStart = dateOnly(updates.term_start || existing.term_start);
        const winEnd = dateOnly(updates.term_end || existing.term_end);
        function detachOutOfWindow() {
          this.where('scheduled_date', '<', winStart).orWhere('scheduled_date', '>', winEnd);
        }
        try {
          // Completion billing keys on prepaid_amount independently of the term
          // link, so a now-out-of-window FUTURE visit would still be treated as
          // prepaid and skip invoicing unless its stamp is cleared too. Clear the
          // stamps on the non-completed out-of-window visits first (while they're
          // still findable by term id); completed/terminal visits keep their
          // historical stamp.
          if (scCols.prepaid_amount) {
            const stampClear = { prepaid_amount: null, updated_at: new Date() };
            if (scCols.prepaid_method) stampClear.prepaid_method = null;
            if (scCols.prepaid_at) stampClear.prepaid_at = null;
            if (scCols.prepaid_note) stampClear.prepaid_note = null;
            const stampQuery = conn('scheduled_services')
              .where({ annual_prepay_term_id: existing.id })
              .andWhere(detachOutOfWindow)
              .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES));
            // Only clear annual-prepay stamps; preserve an independent cash/Zelle
            // prepayment made on the visit through the regular schedule route.
            if (scCols.prepaid_method) stampQuery.where('prepaid_method', ANNUAL_PREPAY_PREPAID_METHOD);
            await stampQuery.update(stampClear);
          }
          await conn('scheduled_services')
            .where({ annual_prepay_term_id: existing.id })
            .andWhere(detachOutOfWindow)
            .update({ annual_prepay_term_id: null, updated_at: new Date() });
        } catch (err) {
          // The completion-billing gate (annualPrepayCoversVisit) is
          // calendar-independent: a stamped visit is covered while its term
          // stays paid, wherever the visit sits on the calendar. That is only
          // sound because THIS detach is the one place a window edit strips
          // stamps from the visits it removed from coverage — a best-effort
          // log-and-continue here left the shrunken window silently
          // suppressing billing for those visits. Fail the edit loudly
          // instead; the operator retries and the detach re-runs. (Partial
          // failure is billing-safe: the stamp clear runs before the
          // term-link detach and the gate requires BOTH fields.)
          throw new Error(`annual prepay window edit for term ${existing.id} could not detach out-of-window visits — edit aborted: ${err.message}`);
        }
      }
    }
    // When the coverage SELECTION changes on an edit (service type / visit count
    // / cadence) — not just the date window handled above — the visits that
    // matched the OLD selection keep their annual-prepay prepaid stamps, since
    // attachScheduledServices/applyPrepaidCoverageForTerm only add+stamp the new
    // matches and never clear the old ones. Completion billing keys on
    // prepaid_amount, so those stale visits would keep skipping billing on top
    // of the newly covered ones. Clear the term's stamps here so the
    // refreshTermSnapshot below re-stamps ONLY the new selection; visits dropped
    // from coverage fall back to normal billing. Method-scoped + non-completed
    // (clearPrepaidStampsForTerm), so manual cash/Zelle stamps and already
    // serviced visits are untouched. Best-effort, mirroring the window block.
    const coverageSelectionChanged = (
      (normalizedCoverageServiceType !== undefined
        && (normalizeCoverageServiceType(existing.coverage_service_type) || null)
          !== (normalizedCoverageServiceType || null))
      || (normalizedCoverageVisitCount !== undefined
        && (normalizeCoverageVisitCount(existing.coverage_visit_count) || null)
          !== (normalizedCoverageVisitCount || null))
      || (normalizedCoverageCadence !== undefined
        && (normalizeCoverageCadence(existing.coverage_cadence) || null)
          !== (normalizedCoverageCadence || null))
    );
    if (coverageSelectionChanged) {
      // Clearing stamps isn't enough: the dropped visits keep their
      // annual_prepay_term_id link, which the repo treats as Annual Prepay for
      // reporting/forecasting (pricing-reality-check) and copies onto recurring
      // children (recurring-appointment-seeder). Detach the term link from the
      // non-completed linked visits too, then let refreshTermSnapshot below
      // re-attach + re-stamp ONLY the new selection — visits dropped from
      // coverage fall fully back to normal billing. Completed/terminal visits
      // keep their historical link + stamp (PREPAID_UPDATE_EXCLUDED_STATUSES).
      //
      // The stamp clear and the link detach must be atomic: if the detach
      // landed but the stamp clear silently failed, those visits would keep a
      // prepaid_amount with no term link — completion billing would still skip
      // them and no term-keyed cleanup could ever find them again. Run both in
      // one (sub)transaction with the stamp clear set to throw, so a failed
      // clear rolls back the detach instead of orphaning the stamps.
      const scCols = await scheduledServiceColumns();
      try {
        await conn.transaction(async (trx) => {
          await clearPrepaidStampsForTerm(existing.id, trx, { throwOnError: true });
          if (scCols.annual_prepay_term_id) {
            await trx('scheduled_services')
              .where({ annual_prepay_term_id: existing.id })
              .whereNotIn('status', Array.from(PREPAID_UPDATE_EXCLUDED_STATUSES))
              .update({ annual_prepay_term_id: null, updated_at: new Date() });
          }
        });
      } catch (err) {
        logger.warn(`[annual-prepay] coverage-change stamp/link cleanup skipped: ${err.message}`);
      }
    }
    await syncInvoiceTerm(prepayInvoiceId, existing.id, conn);
    const refreshed = await refreshTermSnapshot(existing.id, conn);
    if (refreshed && ACTIVE_STATUSES.includes(refreshed.status)) {
      await syncCustomerRenewalDate(customerId, dateOnly(refreshed.term_end), conn);
      // A term that is ACTIVE here was born (or re-anchored) already paid —
      // the Customer 360 flow records the invoice payment BEFORE creating the
      // term, so syncTermForInvoicePayment never fires for it and its
      // pending-window completed visits would stay double-billed. Run the
      // same reconcile the payment sync runs (post-commit when inside a
      // caller trx); idempotent, so terms that DID arrive through the
      // payment sync are unaffected.
      await reconcileBornPaidTerm(refreshed, conn);
      // Stamp only once the term is genuinely ACTIVE (paid). A
      // payment_pending term must leave the customer 'per_application':
      // pending-window completions bill per application until the annual
      // invoice is paid, and the annual_prepay stamp would divert them to
      // the monthly-membership dispatch path (Codex round-2). The payment
      // sync (syncTermForInvoicePayment) stamps on pending→active.
      await stampAnnualPrepayBillingMode(customerId, conn, refreshed.id);
    }
    return refreshed;
  }

  const insert = {
    customer_id: customerId,
    source_estimate_id: sourceEstimateId || null,
    prepay_invoice_id: prepayInvoiceId || null,
    plan_label: planLabel,
    monthly_rate: monthlyRate != null ? monthlyRate : null,
    prepay_amount: prepayAmount != null ? prepayAmount : null,
    term_start: normalizedStart,
    term_end: normalizedEnd,
    status: nextStatus,
  };
  if (termCols.coverage_service_type && normalizedCoverageServiceType !== undefined) {
    insert.coverage_service_type = normalizedCoverageServiceType;
  }
  if (termCols.coverage_visit_count && normalizedCoverageVisitCount !== undefined) {
    insert.coverage_visit_count = normalizedCoverageVisitCount;
  }
  if (termCols.coverage_cadence && normalizedCoverageCadence !== undefined) {
    insert.coverage_cadence = normalizedCoverageCadence;
  }
  if (termCols.first_visit_date && normalizedFirstVisitDate !== undefined) {
    insert.first_visit_date = normalizedFirstVisitDate;
  }
  if (termCols.first_visit_window_start && normalizedFirstVisitWindowStart !== undefined) {
    insert.first_visit_window_start = normalizedFirstVisitWindowStart;
  }

  const [term] = await conn('annual_prepay_terms').insert(insert).returning('*');

  await syncInvoiceTerm(prepayInvoiceId, term.id, conn);
  const refreshed = await refreshTermSnapshot(term.id, conn);
  if (refreshed && ACTIVE_STATUSES.includes(refreshed.status)) {
    await syncCustomerRenewalDate(customerId, normalizedEnd, conn);
    // Born already paid (Customer 360 records the payment before creating the
    // term), so the payment sync's reconcile never fires for this term — run
    // it here (post-commit when inside a caller trx) or its pending-window
    // completed visits stay double-billed.
    await reconcileBornPaidTerm(refreshed, conn);
    // ACTIVE (born-paid) only — a payment_pending term keeps the customer
    // 'per_application' so pre-payment completions bill per application; the
    // payment sync stamps when the invoice pays (Codex round-2).
    await stampAnnualPrepayBillingMode(customerId, conn, refreshed.id);
  }
  return refreshed;
}

function shouldAlertTerm(term, today, daysAhead = DEFAULT_ALERT_DAYS) {
  const termEnd = dateOnly(term.term_end);
  const lastService = dateOnly(term.last_scheduled_service_date);
  const termEndDays = daysUntil(today, termEnd);
  const lastServiceDays = lastService ? daysUntil(today, lastService) : null;
  const termEndTrigger = termEndDays != null && termEndDays >= 0 && termEndDays <= daysAhead;
  const lastServiceTrigger = lastServiceDays != null
    && isLastServiceNearTermEnd(term)
    && lastServiceDays >= -LAST_SERVICE_GRACE_DAYS
    && lastServiceDays <= daysAhead;
  return termEndTrigger || lastServiceTrigger;
}

async function getOpenRenewalAlerts({ daysAhead = DEFAULT_ALERT_DAYS, today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return [];
  await activatePaidPendingTerms();
  const soon = addDaysYmd(today, daysAhead);
  const candidates = await db('annual_prepay_terms as t')
    .leftJoin('customers as c', 't.customer_id', 'c.id')
    .whereIn('t.status', ACTIVE_STATUSES)
    .whereNull('t.renewal_decision')
    .whereNull('c.deleted_at')
    .where(function () {
      this.whereBetween('t.term_end', [today, soon])
        .orWhereBetween('t.last_scheduled_service_date', [addDaysYmd(today, -LAST_SERVICE_GRACE_DAYS), soon]);
    })
    .select(
      't.*',
      'c.first_name',
      'c.last_name',
      'c.phone',
      'c.email'
    )
    .orderBy('t.term_end', 'asc')
    .limit(100);

  const alerts = [];
  for (const candidate of candidates) {
    const refreshed = await refreshTermSnapshot(candidate.id);
    const term = { ...candidate, ...(refreshed || {}) };
    if (!shouldAlertTerm(term, today, daysAhead)) continue;
    const termEnd = dateOnly(term.term_end);
    const lastServiceDate = dateOnly(term.last_scheduled_service_date);
    alerts.push({
      id: term.id,
      source: 'annual_prepay',
      customerId: term.customer_id,
      customerName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim(),
      phone: candidate.phone,
      email: candidate.email,
      planLabel: term.plan_label || 'Annual Prepay',
      termStart: dateOnly(term.term_start),
      termEnd,
      lastScheduledServiceId: term.last_scheduled_service_id,
      lastScheduledServiceDate: lastServiceDate,
      daysUntilTermEnd: daysUntil(today, termEnd),
      daysUntilLastService: lastServiceDate ? daysUntil(today, lastServiceDate) : null,
      status: term.status,
      createdAt: term.created_at,
    });
  }
  return alerts;
}

async function sendCustomerTermNotice(termOrId, daysOut, opts = {}) {
  if (!(await annualPrepayTableExists())) return { sent: false, reason: 'table_missing' };
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const claimCol = noticeClaimColumnForDaysOut(daysOut);
  if (!noticeCol || !claimCol) return { sent: false, reason: 'unsupported_days_out' };

  const refreshed = await refreshTermSnapshot(termOrId);
  const term = refreshed || (typeof termOrId === 'object' ? termOrId : null);
  if (!term || term[noticeCol]) return { sent: false, reason: term ? 'already_sent' : 'term_not_found' };
  const previousStatus = term.status;
  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);

  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNull(noticeCol)
    .where(function noticeClaimAvailable() {
      this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
    })
    .update({
      [claimCol]: now,
      status: term.status === 'active' ? 'renewal_pending' : term.status,
      updated_at: now,
    })
    .returning('*');

  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };

  const releaseClaim = async () => {
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull('renewal_decision')
      .whereNull(noticeCol)
      .update({
        [claimCol]: null,
        status: previousStatus,
        updated_at: new Date(),
      })
      .catch((err) => logger.warn(`[annual-prepay] notice claim release failed for term ${claimedTerm.id}: ${err.message}`));
  };

  let noticeRecorded = false;
  try {
    const customer = await db('customers').where({ id: claimedTerm.customer_id }).first();
    const lastServiceDate = dateOnly(claimedTerm.last_scheduled_service_date);
    if (!customer) {
      await releaseClaim();
      return { sent: false, reason: 'customer_not_found' };
    }

    const sendRenewalEmail = async () => {
      try {
        const result = await AccountMembershipEmail.sendMembershipRenewalReminder({
          customerId: customer.id,
          renewalDate: claimedTerm.term_end,
          daysOut,
          termId: claimedTerm.id,
          lastServiceDate,
        });
        if (result?.sent === false || result?.ok === false) {
          logger.warn(`[annual-prepay] renewal email not sent for term ${claimedTerm.id}: ${result.reason || 'not_sent'}`);
        }
        return result?.sent === true || result?.ok === true;
      } catch (err) {
        logger.warn(`[annual-prepay] renewal email failed for term ${claimedTerm.id}: ${err.message}`);
        return false;
      }
    };
    const markNoticeSent = async (sentAt = new Date()) => {
      await db('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(noticeCol)
        .update({
          [noticeCol]: sentAt,
          [claimCol]: null,
          updated_at: sentAt,
        });
      noticeRecorded = true;
    };

    if (!customer?.phone) {
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false };
      }
      await releaseClaim();
      return { sent: false, reason: 'no_phone' };
    }

    const lastServiceSentence = lastServiceDate && isLastServiceNearTermEnd(claimedTerm)
      ? ` The last service currently on your schedule for this prepaid term is ${formatDateLabel(lastServiceDate)}.`
      : '';
    const body = await renderSmsTemplate(
      'annual_prepay_renewal_reminder',
      {
        first_name: customer.first_name || 'there',
        term_end: formatDateLabel(claimedTerm.term_end),
        last_service_sentence: lastServiceSentence,
      },
      { workflow: 'annual_prepay_renewal_reminder', entity_type: 'annual_prepay_term', entity_id: claimedTerm.id },
    );
    if (!body) {
      logger.warn(`[annual-prepay] annual_prepay_renewal_reminder template missing/disabled for customer ${customer.id}`);
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false, reason: 'missing_sms_template' };
      }
      await releaseClaim();
      return { sent: false, reason: 'missing_sms_template' };
    }

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'retention',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'annual_prepay_renewal',
      consentBasis: {
        status: 'opted_in',
        source: 'customer_retention_preferences',
        capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
      },
      metadata: {
        original_message_type: 'annual_prepay_renewal_reminder',
        annual_prepay_term_id: claimedTerm.id,
        days_out: daysOut,
        ...(opts.metadata || {}),
      },
    });

    if (!smsResult.sent) {
      logger.warn(`[annual-prepay] renewal SMS blocked/failed for term ${claimedTerm.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      const emailSent = await sendRenewalEmail();
      if (emailSent) {
        await markNoticeSent();
        return { sent: true, termId: claimedTerm.id, channel: 'email', sms: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
      }
      await releaseClaim();
      return { sent: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
    }

    const sentAt = new Date();
    await markNoticeSent(sentAt);

    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'sms_outbound',
      channel: 'sms',
      subject: `Annual prepay renewal - ${daysOut}-day reminder`,
      body: `Automated annual prepay renewal reminder sent (${daysOut} days out)`,
    }).catch((err) => logger.warn(`[annual-prepay] interaction insert failed: ${err.message}`));

    void sendRenewalEmail();

    return { sent: true, termId: claimedTerm.id };
  } catch (err) {
    if (!noticeRecorded) await releaseClaim();
    throw err;
  }
}

async function checkAndSend({ today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return { sent: 0 };
  await activatePaidPendingTerms();
  let sent = 0;

  for (const daysOut of CUSTOMER_NOTICE_DAYS) {
    const target = addDaysYmd(today, daysOut);
    const noticeCol = noticeColumnForDaysOut(daysOut);
    const terms = await db('annual_prepay_terms')
      .whereIn('status', ACTIVE_STATUSES)
      .whereNull('renewal_decision')
      .whereNull(noticeCol)
      .where(function noticeClaimAvailable() {
        const claimCol = noticeClaimColumnForDaysOut(daysOut);
        this.whereNull(claimCol).orWhere(claimCol, '<', new Date(Date.now() - NOTICE_CLAIM_TTL_MS));
      })
      // Anchor the reminder on the effective coverage end: term_end, OR the last
      // covered visit when that is the effective end. Finite cadences (e.g. a
      // quarterly term seeds visits at +0/+3/+6/+9mo while term_end is +12mo) end
      // service before term_end, so a term_end-only match would fire the reminder
      // months after coverage actually lapsed (or skip it). Mirrors the
      // getOpenRenewalAlerts last_scheduled_service_date trigger so the automated
      // sender and the admin alert list agree.
      .where(function renewalAnchorMatches() {
        this.where('term_end', target).orWhere('last_scheduled_service_date', target);
      })
      .select('*');

    for (const term of terms) {
      // Only treat the last-visit date as the anchor when it is genuinely near
      // term end (the effective end); a term matched solely by an early
      // last-service date still reminds on term_end instead.
      const onTermEnd = dateOnly(term.term_end) === target;
      if (!onTermEnd && !isLastServiceNearTermEnd(term)) continue;
      try {
        const result = await sendCustomerTermNotice(term, daysOut);
        if (result.sent) sent++;
      } catch (err) {
        logger.error(`[annual-prepay] reminder failed for term ${term.id}: ${err.message}`);
      }
    }
  }

  return { sent };
}

// ── Pre-visit payment reminders for UNPAID accept-time prepay terms ─────────
//
// A prepay-annual accept mints the full-year invoice and a payment_pending
// term, but nothing visit-anchored nudged the customer before the first visit:
// the estimate follow-up cadence stops at accept, and the invoice follow-up
// sequence (d3/d7/d14/d30) is SEND-anchored, so a short accept-to-visit gap
// can ride into service week untouched. These reminders anchor on term_start
// (3 days / 1 day before, matching the daily 10 AM renewal cron's day
// granularity) and set the expectation that an unpaid prepay simply bills the
// visit per-application. Same durable sent/claim column pattern as the
// renewal notices above.

function paymentReminderColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 3) return 'payment_reminder_3d_sent_at';
  if (n === 1) return 'payment_reminder_1d_sent_at';
  return null;
}

function paymentReminderClaimColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 3) return 'payment_reminder_3d_claimed_at';
  if (n === 1) return 'payment_reminder_1d_claimed_at';
  return null;
}

// The invoice follow-up engine (send-anchored dunning) and this visit-anchored
// reminder both text the same pay link, and both crons fire at 10 AM ET — so
// suppress a pre-visit reminder when that invoice's sequence either touched
// the customer in the last ~20h or is DUE to touch them today (deterministic
// regardless of which cron runs first in the shared hour). The 20h window
// (not 24h) keeps yesterday's 10 AM dunning from suppressing today's 10 AM
// reminder on the boundary.
const PAYMENT_REMINDER_DUNNING_SUPPRESS_MS = 20 * 60 * 60 * 1000;
async function invoiceDunningActiveToday(invoiceId, { now = new Date(), todayYmd = null } = {}) {
  try {
    const row = await db('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .first('status', 'last_touch_at', 'next_touch_at');
    if (!row) return false;
    // A REAL recent send suppresses regardless of status — the FINAL step of
    // a sequence stamps last_touch_at and flips the row to 'completed' in the
    // same shared 10 AM hour (invoice followups are registered ahead of the
    // renewal cron), so an active-only check would double-text that morning.
    if (row.last_touch_at && (now - new Date(row.last_touch_at)) < PAYMENT_REMINDER_DUNNING_SUPPRESS_MS) return true;
    // Deliberate dunning controls: a paused / autopay-held / stopped sequence
    // means "no automated payment texts right now" (owner pause, autopay in
    // flight, stop/waive) — the pre-visit reminder honors them too.
    if (['paused', 'autopay_hold', 'stopped'].includes(row.status)) return true;
    // 'completed' (sequence exhausted) falls through: the visit-anchored
    // reminder is the only nudge left, so only the recent-touch window above
    // suppresses it.
    if (row.status !== 'active') return false;
    if (row.next_touch_at) {
      // A due touch only suppresses on a day the follow-up cron can actually
      // fire (Tue–Fri per config.sendWindow). A touch that came due over the
      // weekend would otherwise suppress the Sat 3d AND Mon 1d reminders while
      // no dunning ran either day — the customer would reach the visit with no
      // pre-visit contact at all.
      const followupConfig = require('../config/invoice-followups');
      const sendDays = new Set(followupConfig?.sendWindow?.daysOfWeek || []);
      const today = todayYmd || etDateString();
      const todayEtDow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (sendDays.has(todayEtDow)) {
        const endOfTodayEt = parseETDateTime(`${today} 23:59:59`);
        if (new Date(row.next_touch_at) <= endOfTodayEt) return true;
      }
    }
    return false;
  } catch (err) {
    // Fail open (send the reminder): a read miss must not silence the only
    // visit-anchored nudge; worst case the customer gets dunning + reminder.
    logger.warn(`[annual-prepay] dunning suppression check failed for invoice ${invoiceId}: ${err.message}`);
    return false;
  }
}

async function sendPaymentPendingReminder(termOrId, daysOut, opts = {}) {
  if (!(await annualPrepayTableExists())) return { sent: false, reason: 'table_missing' };
  const sentCol = paymentReminderColumnForDaysOut(daysOut);
  const claimCol = paymentReminderClaimColumnForDaysOut(daysOut);
  if (!sentCol || !claimCol) return { sent: false, reason: 'unsupported_days_out' };
  const cols = await annualPrepayColumns();
  if (!cols[sentCol] || !cols[claimCol]) return { sent: false, reason: 'columns_missing' };

  // The status/sent checks on this row are advisory (the caller's candidate
  // read may be moments old) — the conditional claim UPDATE below re-checks
  // both atomically, and the fresh invoice read below catches a payment the
  // webhook hasn't flipped onto the term yet.
  const term = typeof termOrId === 'object' && termOrId?.id
    ? termOrId
    : await db('annual_prepay_terms').where({ id: termOrId }).first();
  if (!term) return { sent: false, reason: 'term_not_found' };
  if (term.status !== PAYMENT_PENDING_STATUS) return { sent: false, reason: 'not_payment_pending' };
  if (term[sentCol]) return { sent: false, reason: 'already_sent' };
  if (!term.prepay_invoice_id) return { sent: false, reason: 'no_invoice' };

  let invoice = await db('invoices').where({ id: term.prepay_invoice_id }).first();
  if (!invoice) return { sent: false, reason: 'invoice_missing' };
  // Canonical collectibility (invoice-helpers): paid/prepaid/PROCESSING/void/
  // refunded/cancelled all skip — an in-flight ACH must not be asked to pay
  // again, and the pay page would refuse these states anyway.
  const { isInvoiceCollectibleStatus, invoiceAmountDue } = require('./invoice-helpers');
  if (!isInvoiceCollectibleStatus(invoice.status)) {
    return { sent: false, reason: 'invoice_not_collectible' };
  }
  // Never text the homeowner a pay link for a payer-billed invoice — the
  // pay link + AR route to the payer (mirrors InvoiceService.sendViaSMS).
  if (invoice.payer_id) return { sent: false, reason: 'payer_billed' };

  if (await invoiceDunningActiveToday(invoice.id)) {
    return { sent: false, reason: 'dunning_active_today' };
  }

  // Credit already applied to the invoice may fully cover it — nothing to
  // remind (the auto-apply seam itself runs post-claim, see below).
  if (!(invoiceAmountDue(invoice) > 0)) return { sent: false, reason: 'fully_credited' };

  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);
  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id, status: PAYMENT_PENDING_STATUS })
    .whereNull(sentCol)
    .where(function paymentClaimAvailable() {
      this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
    })
    .update({ [claimCol]: now, updated_at: now })
    .returning('*');
  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };

  const releaseClaim = async () => {
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull(sentCol)
      .update({ [claimCol]: null, updated_at: new Date() })
      .catch((err) => logger.warn(`[annual-prepay] payment reminder claim release failed for term ${claimedTerm.id}: ${err.message}`));
  };

  // Credit this reminder draws down must not stay consumed if no touch goes
  // out — mirror the dunning engine: reverse exactly THIS call's increment on
  // any no-channel exit (missing customer/template, blocked SMS, throw). A
  // seam apply that FULLY covers the invoice is a settle event, not a touch —
  // the credit stays (and reverseAppliedCredit refuses 'prepaid' anyway).
  let reminderAppliedCredit = 0;
  const reverseReminderCredit = async () => {
    if (!(reminderAppliedCredit > 0)) return;
    try {
      const { reverseAppliedCredit } = require('./customer-credit');
      await reverseAppliedCredit({ invoiceId: invoice.id, amount: reminderAppliedCredit, createdBy: 'system:prepay_reminder_undelivered' });
    } catch (err) {
      logger.warn(`[annual-prepay] credit reversal after undelivered payment reminder skipped for invoice ${invoice.id}: ${err.message}`);
    }
    reminderAppliedCredit = 0;
  };

  try {
    // Run the same account-credit seam the regular invoice send paths run
    // before asking for money (feature-gated + fail-soft inside), then
    // re-read: available credit may shrink or fully cover the balance, and
    // the reminder must quote the amount Stripe will actually collect, not
    // the gross total. Post-claim so the undelivered-touch reversal above
    // covers every failure exit that follows.
    try {
      const { autoApplyAccountCreditIfEnabled } = require('./customer-credit');
      const creditResult = await autoApplyAccountCreditIfEnabled(invoice.id, { createdBy: 'system:annual_prepay_payment_reminder' });
      reminderAppliedCredit = Number(creditResult?.applied) || 0;
      const freshInvoice = await db('invoices').where({ id: invoice.id }).first();
      if (freshInvoice) invoice = freshInvoice;
    } catch (err) {
      logger.warn(`[annual-prepay] credit seam skipped for invoice ${invoice.id}: ${err.message}`);
    }
    if (!isInvoiceCollectibleStatus(invoice.status)) {
      // Seam flipped the invoice to prepaid/paid (full coverage side effects
      // also activate the term) — settled, keep the credit, free the claim.
      await releaseClaim();
      return { sent: false, reason: 'invoice_not_collectible' };
    }
    const amountDue = invoiceAmountDue(invoice);
    if (!(amountDue > 0)) {
      await releaseClaim();
      return { sent: false, reason: 'fully_credited' };
    }

    // whereNull(deleted_at): a soft-deleted account must not get a pay-link
    // text (mirrors the renewal scan's deleted-customer exclusion).
    const customer = await db('customers')
      .where({ id: claimedTerm.customer_id })
      .whereNull('deleted_at')
      .first();
    if (!customer) {
      await reverseReminderCredit();
      await releaseClaim();
      return { sent: false, reason: 'customer_missing_or_deleted' };
    }
    if (!customer.phone) {
      // The invoice email already carries the pay link (sent at accept, plus
      // the follow-up sequence's email legs) — with no phone there is no SMS
      // nudge to add. Mark sent so the daily cron doesn't re-claim forever;
      // reverse the seam credit (no touch went out to consume it).
      await reverseReminderCredit();
      await db('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(sentCol)
        .update({ [sentCol]: new Date(), [claimCol]: null, updated_at: new Date() });
      return { sent: false, reason: 'no_phone' };
    }

    const { publicPortalUrl } = require('../utils/portal-url');
    const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
    const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice',
      entityType: 'invoices',
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });
    const amountText = Number.isFinite(amountDue) && amountDue > 0
      ? ` for $${amountDue.toFixed(2)}`
      : '';

    const body = await renderSmsTemplate(
      'annual_prepay_payment_reminder',
      {
        first_name: customer.first_name || 'there',
        amount_text: amountText,
        first_visit_date: formatDateLabel(effectiveFirstVisitDate(claimedTerm)),
        pay_link: payUrl,
      },
      { workflow: 'annual_prepay_payment_reminder', entity_type: 'annual_prepay_term', entity_id: claimedTerm.id },
    );
    if (!body) {
      logger.warn(`[annual-prepay] annual_prepay_payment_reminder template missing/disabled for customer ${customer.id}`);
      await reverseReminderCredit();
      await releaseClaim();
      return { sent: false, reason: 'missing_sms_template' };
    }

    // Collections policy consult (codex gh-r1): this reminder is a
    // balance-outreach rail like the dunning engines — a do_not_text /
    // collection_hold / bankruptcy customer must not receive it once the
    // gate is on. Gate off ⇒ permitted without consulting, byte-identical.
    // A denial is an expected hold, not a failure: release the claim so a
    // later day retries once the hold clears.
    const { collectionsChannelPermitted } = require('./collections/rail-guard');
    // invoiceId stays null (codex r7): the plan selector persists this
    // invoice as 'draft', which the eligibility loader never admits — the
    // membership check would kill every prepay reminder under the gate.
    // The validated plan amount rides the off-ledger carve-out instead;
    // flags, suppression, and frequency windows all still apply.
    const policyPermitted = await collectionsChannelPermitted({
      customerId: customer.id,
      invoiceId: null,
      channel: 'sms',
      purpose: 'balance_reminder',
      offLedgerBalanceCents: Math.round(amountDue * 100),
      logTag: 'annual-prepay',
    });
    if (!policyPermitted) {
      await reverseReminderCredit();
      await releaseClaim();
      return { sent: false, reason: 'collections_policy_denied' };
    }

    // RECORD-THEN-SEND (always-on ledger discipline): the row precedes the
    // delivery attempt; an insert failure skips the send and releases the
    // claim for a later retry — no unledgered customer contact.
    const ContactLedger = require('./collections/contact-ledger');
    let prepayLedger;
    try {
      prepayLedger = await ContactLedger.recordContact({
        customerId: customer.id,
        channel: 'sms',
        purpose: 'balance_reminder',
        invoiceIds: [invoice.id],
        source: 'annual_prepay_payment_reminder',
        metadata: { annual_prepay_term_id: claimedTerm.id, days_out: daysOut },
      });
    } catch (ledgerErr) {
      logger.warn(`[annual-prepay] payment reminder skipped for term ${claimedTerm.id} — contact ledger unavailable: ${ledgerErr.message}`);
      await reverseReminderCredit();
      await releaseClaim();
      return { sent: false, reason: 'ledger_unavailable' };
    }

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: customer.id,
      invoiceId: invoice.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'annual_prepay_payment_reminder',
      metadata: {
        original_message_type: 'annual_prepay_payment_reminder',
        annual_prepay_term_id: claimedTerm.id,
        days_out: daysOut,
        ...(opts.metadata || {}),
      },
    });
    if (!smsResult.sent) {
      await ContactLedger.markSendFailed(prepayLedger, { code: smsResult.code || smsResult.reason || 'send_failed' });
      logger.warn(`[annual-prepay] payment reminder SMS blocked/failed for term ${claimedTerm.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      await reverseReminderCredit();
      await releaseClaim();
      return { sent: false, reason: smsResult.code || smsResult.reason || 'send_failed' };
    }

    // Touch DELIVERED — everything past this point is bookkeeping and must
    // never undo the customer-visible send: the text already quoted the
    // post-credit balance, so reversing would make the link charge more than
    // the reminder said, and re-claiming would re-text. Stamp failures log
    // loudly and still report sent; the claim stays held (stale-claim TTL
    // owns the rare retry).
    try {
      const sentAt = new Date();
      await db('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(sentCol)
        .update({ [sentCol]: sentAt, [claimCol]: null, updated_at: sentAt });

      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: 'sms_outbound',
        channel: 'sms',
        subject: `Annual prepay payment - ${daysOut}-day pre-visit reminder`,
        body: `Automated unpaid-prepay payment reminder sent (${daysOut} day(s) before term start)`,
      }).catch((err) => logger.warn(`[annual-prepay] interaction insert failed: ${err.message}`));
    } catch (bookkeepingErr) {
      logger.error(`[annual-prepay] payment reminder SENT but sent-stamp failed for term ${claimedTerm.id} — credit kept, claim held: ${bookkeepingErr.message}`);
    }

    return { sent: true, termId: claimedTerm.id };
  } catch (err) {
    // Only failures BEFORE any channel delivered reach here (the delivered
    // path swallows its bookkeeping errors above).
    await reverseReminderCredit();
    await releaseClaim();
    throw err;
  }
}

async function checkAndSendPaymentReminders({ today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return { sent: 0 };
  // Flip any paid-but-pending terms first so they never remind.
  await activatePaidPendingTerms();
  let sent = 0;

  for (const daysOut of PAYMENT_REMINDER_DAYS) {
    const sentCol = paymentReminderColumnForDaysOut(daysOut);
    const claimCol = paymentReminderClaimColumnForDaysOut(daysOut);
    const cols = await annualPrepayColumns();
    if (!cols[sentCol] || !cols[claimCol]) continue; // migration not run yet
    const target = addDaysYmd(today, daysOut);
    const terms = await db('annual_prepay_terms')
      .where({ status: PAYMENT_PENDING_STATUS })
      .whereNotNull('prepay_invoice_id')
      .whereNull(sentCol)
      .where(function paymentClaimAvailable() {
        this.whereNull(claimCol).orWhere(claimCol, '<', new Date(Date.now() - NOTICE_CLAIM_TTL_MS));
      })
      .where(function firstVisitOn() {
        // Match the date the customer was actually promised. COALESCE keeps
        // legacy terms (no first_visit_date) firing off term_start.
        if (cols.first_visit_date) this.whereRaw('COALESCE(first_visit_date, term_start) = ?', [target]);
        else this.where('term_start', target);
      })
      .select('*');

    for (const term of terms) {
      try {
        const result = await sendPaymentPendingReminder(term, daysOut);
        if (result.sent) sent++;
      } catch (err) {
        logger.error(`[annual-prepay] payment reminder failed for term ${term.id}: ${err.message}`);
      }
    }
  }

  return { sent };
}

async function hasAnnualPrepayRenewal(customerId, termEnd) {
  if (!(await annualPrepayTableExists())) return false;
  const row = await db('annual_prepay_terms')
    .where({ customer_id: customerId, term_end: dateOnly(termEnd) })
    .first('id');
  return !!row;
}

async function recordDecision({ termId, action, adminUserId = null, notes = null } = {}) {
  if (!(await annualPrepayTableExists())) return null;
  const allowed = new Set(['contacted', 'renew', 'cancel', 'switch_plan']);
  if (!allowed.has(action)) throw new Error('invalid annual prepay action');
  const now = new Date();
  if (action === 'contacted') {
    const update = {
      status: 'renewal_pending',
      renewal_contacted_at: now,
      renewal_contacted_by: adminUserId || null,
      updated_at: now,
    };
    if (notes) update.renewal_notes = notes;
    const [term] = await db('annual_prepay_terms')
      .where({ id: termId })
      .whereIn('status', ACTIVE_STATUSES)
      .whereNull('renewal_decision')
      .update(update)
      .returning('*');
    return term || null;
  }

  const update = {
    status: statusAfterDecision(action),
    renewal_decision: action,
    renewal_decision_at: now,
    renewal_decision_by: adminUserId || null,
    updated_at: now,
  };
  if (notes) update.renewal_notes = notes;
  const [term] = await db('annual_prepay_terms')
    .where({ id: termId })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .update(update)
    .returning('*');
  return term || null;
}

module.exports = {
  createTermForAnnualPrepay,
  refreshTermSnapshot,
  refreshActiveTermsForCustomer,
  // Public: the one-step-prepay booking preflight (admin-schedule) matches the
  // booked service against the quoted coverage with the SAME matcher that
  // stamps/gates coverage — destructuring it from the module root must work
  // (it used to live only under _private, which left the route's destructure
  // undefined and 500'd the booking).
  serviceMatchesCoverage,
  syncTermForInvoicePayment,
  syncTermForRefundedPayment,
  activatePaidPendingTerms,
  suspendActiveTermsForDisputedInvoice,
  reconcileCoveredTermsSweep,
  getActivelyCoveredCustomerIds,
  getCardExpiryExemptCustomerIds,
  clearCardExpiryExemptCache,
  getPaymentPendingCustomerIds,
  getOpenRenewalAlerts,
  sendCustomerTermNotice,
  checkAndSend,
  sendPaymentPendingReminder,
  checkAndSendPaymentReminders,
  hasAnnualPrepayRenewal,
  applyPrepaidCoverageForTerm,
  reconcilePendingWindowCompletions,
  reconcileDisputeWindowMonthlyDues,
  finishDisputeRecoveryForTerm,
  reversePendingWindowCompletionCredits,
  reverseWaveguardExtensionCredits,
  restoreWaveguardExtensionCredits,
  clearPrepaidStampsForTerm,
  annualPrepayCoversVisit,
  coveredTermsAsOf,
  ANNUAL_PREPAY_PREPAID_METHOD,
  recordDecision,
  // Root exports (not only _private): the annual-prepay-invoice route
  // validates the operator's first-visit time with the SAME normalizer that
  // persists it and the SAME conflict predicate the seeder re-checks with, so
  // route validation and stored behavior can never drift apart.
  normalizeWindowStart,
  findVisitWindowConflict,
  _private: {
    PENDING_COMPLETION_REVERSAL_IDENTITIES,
    dateOnly,
    addMonthsSameDay,
    addDaysYmd,
    daysUntil,
    noticeColumnForDaysOut,
    noticeClaimColumnForDaysOut,
    paymentReminderColumnForDaysOut,
    paymentReminderClaimColumnForDaysOut,
    invoiceDunningActiveToday,
    shouldAlertTerm,
    isLastServiceNearTermEnd,
    invoiceTermStatus,
    formatDateLabel,
    parsePaymentMetadata,
    findInvoiceIdForRefundedPayment,
    coverageServiceKey,
    serviceMatchesCoverage,
    splitCoverageAmount,
    coverageScheduleDates,
    coverageSeriesAnchor,
    effectiveFirstVisitDate,
    normalizeWindowStart,
    addMinutesHHMM,
    normalizeCoverageCadence,
    cadenceFromIntervalDays,
    coverageCadenceMonths,
    coverageCadenceDays,
    inferCoverageCadence,
    normalizeCoverageServiceType,
    normalizeCoverageVisitCount,
    ensureCoverageRowsForTerm,
    coverageRowsForTerm,
    resetCachesForTests,
  },
};
