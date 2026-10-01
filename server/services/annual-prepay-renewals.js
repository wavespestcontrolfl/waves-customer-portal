const { AsyncLocalStorage } = require('async_hooks');
const { addMonthsSameDay: addMonthsSameDayShared } = require('../utils/date-only');
const { recurringDispatchDuePatch } = require('./scheduling/recurring-dispatch-due');
const db = require('../models/db');
const logger = require('./logger');
const { tryLockCustomerComms, withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { sendCustomerMessage, classifyDeliveryCertainty } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const AccountMembershipEmail = require('./account-membership-email');
const CancellationResolution = require('./cancellation-resolution');
const { portalUrl } = require('../utils/portal-url');

const ACTIVE_STATUSES = ['active', 'renewal_pending'];
// Decided coverage: the renewal decision is recorded but the paid window still
// runs. Covered ONLY while the prepay invoice is actually paid — see the
// decidedCoveredAndPaid branch in coveredTermsAsOf.
const DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
// annual_prepay_terms.cancel_disposition — how a cancel decision ends the
// term (ADMIN-BUG-R18): 'end_at_term' keeps its paid visits through
// term_end; 'end_now_refund' pulled them and owes the unused value back.
const CANCEL_DISPOSITIONS = ['end_at_term', 'end_now_refund'];
// TERMITE renewal successor grace window (owner ruling 2026-09-26, P2-4): an
// unpaid termite renewal successor (renewed_from_term_id NOT NULL,
// annual_plan_version NOT NULL, still payment_pending) stays COVERED through
// this many days — the exact cutoff termite-annual-renewal-charge.js's
// grace-lapse pass (P1-2) also voids on. One constant, one date formula
// (termiteRenewalGraceDeadlineSql / termiteRenewalGraceDeadlineFor below),
// consulted by both coveredTermsAsOf (this file) and the lapse pass (that
// file) — coverage and the lapse can never disagree about the exact day.
const TERMITE_RENEWAL_GRACE_DAYS = 30;

// The successor's own coverage clock doesn't necessarily start exactly on
// term_start — a delayed sweep tick can mint the row days after its nominal
// term_start (immutable, derived from the parent's own term_end). Anchoring
// the deadline on whichever is LATER — term_start or the row's own
// created_at (ET date) — means the successor never gets LESS than a full
// grace window from the moment it actually came into existence.
function termiteRenewalGraceDeadlineSql(alias = 't') {
  // Codex round-1 P1: created_at::date cast in the SQL session's own
  // timezone (typically UTC on Railway) — a mint after 8pm ET reads a day
  // late there, disagreeing with the JS twin below (which explicitly
  // converts to ET first). AT TIME ZONE 'America/New_York' matches the
  // repo's own ET-cast convention (completion-record-invariants.js's
  // TODAY_ET, customer-stages.js's CONVERSION_DATE_SQL, etc.).
  return `(GREATEST(${alias}.term_start, (${alias}.created_at AT TIME ZONE 'America/New_York')::date) + INTERVAL '${TERMITE_RENEWAL_GRACE_DAYS} days')::date`;
}

// JS-side twin for a single already-fetched row (the lapse pass reads
// candidate rows directly rather than through a live query) — same
// GREATEST(term_start, created_at ET-date) + GRACE_DAYS formula.
// THE "unpaid termite renewal successor still inside its own payment grace"
// predicate (P2-4) — coveredTermsAsOf's grace branch reads it, and through
// it termiteGraceCoversVisit, the completion-billing and monthly-dues gates.
// Codex #4971 pre-push P0: a DISPUTE-suspended successor is never in grace.
// A dispute inside the first 30 days demotes the (paid) successor back to
// payment_pending and reopens its invoice with the Stripe identifiers
// cleared, so without this exclusion the grace branch restored the very
// coverage the suspension had just withdrawn — suppressing completion
// charges and monthly dues on clawed-back money. The dispute's own outcome
// (won: re-paid → active; lost: cancelled) owns that term from here.
function whereTermiteRenewalInGrace(builder, alias, onDate) {
  return builder.where(`${alias}.status`, PAYMENT_PENDING_STATUS)
    .whereNotNull(`${alias}.renewed_from_term_id`)
    .whereNotNull(`${alias}.annual_plan_version`)
    // Column-tolerant read of dispute_suspended_at (20260709000012): this
    // predicate sits inside coveredTermsAsOf, the ONE coverage query every
    // billing gate reads, so it must never fail on a schema without the
    // column (pre-migration boots and the narrow scratch schemas many
    // suites build) — a missing column reads as "not suspended".
    .whereRaw(`(to_jsonb(${alias}) ->> 'dispute_suspended_at') IS NULL`)
    .whereRaw(`${termiteRenewalGraceDeadlineSql(alias)} >= ?`, [onDate])
    // Codex #4971 r28 P1: grace is the PARENT's promise carried forward —
    // a successor whose parent was cancelled, refunded or had its window
    // moved after the mint is covered by nothing, and must not keep
    // suppressing completion or monthly billing until a withdrawal sweep
    // (which does not even run while the gate is off) gets to it. The
    // parent must still authorize the renewal: undecided and live, or
    // renewed by a 'renew' decision; its own window still abutting the
    // successor's; its prepay invoice (when it has one) collected and
    // neither cancelled nor fully refunded. Only columns coveredTermsAsOf
    // already reads on its own invoice join are referenced.
    .whereExists(function parentStillAuthorizes() {
      this.select(1)
        .from('annual_prepay_terms as gp')
        .leftJoin('invoices as gpi', 'gpi.id', 'gp.prepay_invoice_id')
        .whereRaw(`gp.id = ${alias}.renewed_from_term_id`)
        .whereRaw(`${alias}.term_start = gp.term_end + 1`)
        .where(function authorizingShape() {
          this.where(function undecidedLive() {
            this.whereIn('gp.status', ACTIVE_STATUSES).whereNull('gp.renewal_decision');
          }).orWhere(function renewedByRenew() {
            this.where('gp.status', 'renewed').where('gp.renewal_decision', 'renew');
          });
        })
        .where(function parentInvoiceCollected() {
          this.whereNull('gp.prepay_invoice_id').orWhere(function collectedNotRevoked() {
            this.where(function collected() { wherePrepayInvoiceCollected(this, 'gpi'); })
              .whereRaw("lower(coalesce(gpi.status, '')) not in ('void', 'cancelled', 'canceled', 'refunded')")
              .whereRaw(`not exists (
                select 1 from payments gpp
                where (gpp.status = 'refunded' or gpp.refund_status = 'full')
                  and ((gpp.stripe_payment_intent_id is not null and gpp.stripe_payment_intent_id = gpi.stripe_payment_intent_id)
                    or (gpp.stripe_charge_id is not null and gpp.stripe_charge_id = gpi.stripe_charge_id))
              )`);
          });
        });
    });
}

function termiteRenewalGraceDeadlineFor(term) {
  const termStartYmd = dateOnly(term?.term_start);
  const createdYmd = term?.created_at ? etDateString(new Date(term.created_at)) : null;
  const later = createdYmd && termStartYmd
    ? (createdYmd > termStartYmd ? createdYmd : termStartYmd)
    : (createdYmd || termStartYmd);
  if (!later) return null;
  return etDateString(addETDays(parseETDateTime(`${later}T12:00`), TERMITE_RENEWAL_GRACE_DAYS));
}
const CUSTOMER_NOTICE_DAYS = [30, 15, 7];
// Termite annual-plan terms (annual_plan_version set) get an EXTRA 45-day
// rung ahead of the shared ladder above (owner ruling §A2: 45 and 30 days
// before the cancellation deadline). Every other term (lawn/mosquito/rodent/
// quarterly prepay — this table is shared) never sees this rung; checkAndSend
// queries it separately, restricted to annual_plan_version IS NOT NULL, so
// CUSTOMER_NOTICE_DAYS itself stays untouched and every non-termite term's
// 30/15/7 behavior is byte-identical to before. Termite-specific COPY
// (disclosing the auto-renew/cancel terms) applies only at 45 and 30 days
// out — 15/7 keep the shared generic reminder even for a termite term.
const TERMITE_EXTRA_NOTICE_DAYS = 45;
const TERMITE_COPY_NOTICE_DAYS = [45, 30];
// A 45-day-rung notice sent fewer than 45 days out (catch-up) — recorded
// here, never as the notice_45_sent_at witness. See noticeWitnessColumn.
const TERMITE_LATE_NOTICE_COLUMN = 'notice_45_late_sent_at';
// Same shape, one rung down: a 30-day-rung notice sent fewer than 30 days
// out — either a genuine retry landing late, or (Codex #4921 r3) the
// single combined send chosen when a term is first seen at <=30 days and
// BOTH rungs are due at once (see processTermiteNoticeObligations). Never
// the notice_30_sent_at witness. The renewal-charge gate (slice 6b) reads
// notice_45_sent_at only, so a late 30-day send does not independently
// block auto-charge the way a late 45-day send does — this column exists
// for the durable record and its own staff escalation.
const TERMITE_30_LATE_NOTICE_COLUMN = 'notice_30_late_sent_at';
// Confirmed-bell witnesses for the two late columns above — same
// confirmed-insert-only pattern as notice_45_late_escalated_at: stamped
// only after notifyAdmin returns non-null, so a transient insert failure
// is retried on the next sweep instead of losing the escalation for good.
const TERMITE_30_LATE_ESCALATION_COLUMN = 'notice_30_late_escalated_at';
// Stamped once a termite term reaches its OWN term_end with the 45-day
// and/or 30-day rung never delivered at all (neither on-time nor late) —
// the durable safety net for a rung whose daily retry never landed before
// the renewal date arrived (Codex #4921 r3 finding #2, generalized).
const TERMITE_NOTICE_MISSED_ESCALATION_COLUMN = 'notice_missed_escalated_at';
// Confirmed-bell witnesses (Codex #4921 r4 P1) for a rung that is still
// UNDELIVERED on or after its own deadline day — today >= term_end - 45 for
// the 45-day rung, today >= term_end - 30 for the 30-day rung (Codex #4921
// r11: the deadline day itself counts, so staff can still deliver by hand
// that day) — while the
// daily send retry keeps failing (e.g. SMS and email both down). Deliberately
// NOT the *_late_escalated_at columns: those mean "the notice DID go out,
// late"; these mean "the notice has NOT gone out and its on-time window is
// gone". A rung can legitimately get both, in that order (undelivered bell,
// then a late bell once a retry finally lands). Added by 20260926000108.
const TERMITE_45_UNDELIVERED_ESCALATION_COLUMN = 'notice_45_undelivered_escalated_at';
const TERMITE_30_UNDELIVERED_ESCALATION_COLUMN = 'notice_30_undelivered_escalated_at';
// Durable witness-conflict record + its confirmed-bell stamp (20260926000109,
// Codex #4921 r10 P2) — an unbelled conflict is re-filed by the daily sweep.
const TERMITE_WITNESS_CONFLICT_COLUMN = 'notice_witness_conflict';
const TERMITE_WITNESS_CONFLICT_BELLED_COLUMN = 'notice_witness_conflict_belled_at';
const DEFAULT_ALERT_DAYS = 30;
const LAST_SERVICE_GRACE_DAYS = 14;
const LAST_SERVICE_TERM_END_LOOKBACK_DAYS = 120;
const NOTICE_CLAIM_TTL_MS = 15 * 60 * 1000;
// prepaid_method written when annual-prepay coverage stamps a visit. Stamp
// cleanup filters on this so it never clears an independent cash/Zelle/etc.
// prepayment made through the regular schedule prepay route.
const ANNUAL_PREPAY_PREPAID_METHOD = 'annual_prepay_invoice';

// A callback is never a SOLD visit. The persisted flag is authoritative for
// rows the scheduler auto-flagged, but a re-service COMPLETED before the
// auto-flag shipped keeps is_callback=false (the 20260618000002 backfill
// flagged non-terminal rows only), so the runtime classifier (re-service.js:
// catalog key or "re-service" label) is consulted too — the same pair the
// backfill and the completion path use (GH Codex #4105 r3 P1).
const { isReService, RE_SERVICE_SERVICE_KEYS } = require('./re-service');
function isCallbackRow(row) {
  return row?.is_callback === true
    || isReService({ serviceKey: row?.service_key_snapshot, serviceType: row?.service_type });
}
// SQL twin of isCallbackRow for the detach UPDATE (mirrors the backfill
// migration's reServiceMatch). Column presence is checked by the caller.
function whereCallbackRow(cols) {
  return function callbackWhere() {
    this.where('is_callback', true)
      .orWhereRaw('service_type ILIKE ?', ['%re-service%'])
      .orWhereRaw('service_type ILIKE ?', ['%reservice%']);
    if (cols.service_key_snapshot) this.orWhereIn('service_key_snapshot', Array.from(RE_SERVICE_SERVICE_KEYS));
  };
}
const { INVOICE_CANCELLED_STATUSES } = require('./annual-prepay-invoice-statuses');
const COVERAGE_EXCLUDED_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled']);
const PREPAID_UPDATE_EXCLUDED_STATUSES = new Set([...COVERAGE_EXCLUDED_STATUSES, 'completed']);

let tableExistsCache = null;
let termColsCache = null;
let scheduledColsCache = null;
let invoiceColsCache = null;

// Only a SUCCESSFUL probe is cached (the same rule annualPrepayColumns
// follows since #4921 r4). A failed probe answers false for THIS call only:
// caching it turned one transient DB error — a local crash recovery, a
// connection blip at boot — into "the table does not exist" for the life of
// the process, so syncTermForInvoicePayment (and every other reader gated
// on this) silently no-oped: a paid invoice left its term payment_pending
// with no error anywhere.
async function annualPrepayTableExists() {
  if (tableExistsCache != null) return tableExistsCache;
  try {
    tableExistsCache = await db.schema.hasTable('annual_prepay_terms');
  } catch (err) {
    logger.warn(`[annual-prepay] table detection failed: ${err.message}`);
    return false;
  }
  return tableExistsCache;
}

function resetCachesForTests() {
  tableExistsCache = null;
  termColsCache = null;
  termColsCacheExpiresAt = 0;
  scheduledColsCache = null;
  invoiceColsCache = null;
  cancelDispositionColumnKnown = false;
}

// ADMIN-BUG-R18: whether annual_prepay_terms.cancel_disposition exists,
// probed STRICTLY — a failed probe throws. annualPrepayColumns reads a
// failure as "no column", which would record a cancel decision with no
// disposition (the upkeep never recognizes it again) or silently skip the
// end-now upgrade. Only a positive answer is cached.
let cancelDispositionColumnKnown = false;
async function cancelDispositionSupported() {
  if (cancelDispositionColumnKnown) return true;
  const cols = await db('annual_prepay_terms').columnInfo();
  const exists = !!cols?.cancel_disposition;
  if (exists) cancelDispositionColumnKnown = true;
  return exists;
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

// Codex #4921 r4 P1: only a SUCCESSFUL, complete probe is cached. This
// used to cache {} forever after one transient columnInfo() failure, which
// silently disabled every column-gated path for the life of the process
// (the termite 45/30 notice pass among them) until a restart. A failed or
// empty probe now returns {} for THIS call only — every caller already
// treats a missing column as "skip the column-gated branch" — and the next
// call probes again.
// An incomplete (mid-rollout) probe is cached briefly, not forever: every
// caller of this shared probe keeps its cache on hot paths, and the termite
// notice columns are re-checked at most once per INCOMPLETE_PROBE_TTL_MS.
const INCOMPLETE_PROBE_TTL_MS = 60 * 1000;
let termColsCacheExpiresAt = 0;
async function annualPrepayColumns(conn = db) {
  if (conn === db && termColsCache && (!termColsCacheExpiresAt || Date.now() < termColsCacheExpiresAt)) return termColsCache;
  let cols = {};
  try {
    cols = (await conn('annual_prepay_terms').columnInfo()) || {};
  } catch (err) {
    logger.warn(`[annual-prepay] annual_prepay_terms column probe failed (not cached): ${err.message}`);
    return {};
  }
  // Codex #4921 r8 P1: a SUCCESSFUL but INCOMPLETE probe (mid rolling
  // deploy, before the termite notice migrations land) is not cached either
  // — caching it would keep termiteNoticeColumnsReady false until a restart.
  if (conn === db && Object.keys(cols).length) {
    termColsCache = cols;
    termColsCacheExpiresAt = termiteNoticeSchemaComplete(cols) ? 0 : Date.now() + INCOMPLETE_PROBE_TTL_MS;
  }
  return cols;
}

// Every termite notice column the notice pass (and its gated undelivered
// sub-pass) queries. Referenced lazily (call time), after module init.
function termiteNoticeSchemaComplete(cols) {
  return TERMITE_NOTICE_PASS_COLUMNS.every((col) => Boolean(cols[col]))
    && Boolean(cols[TERMITE_45_UNDELIVERED_ESCALATION_COLUMN])
    && Boolean(cols[TERMITE_30_UNDELIVERED_ESCALATION_COLUMN])
    && witnessConflictColumnsReady(cols);
}

function witnessConflictColumnsReady(cols) {
  return Boolean(cols[TERMITE_WITNESS_CONFLICT_COLUMN]) && Boolean(cols[TERMITE_WITNESS_CONFLICT_BELLED_COLUMN]);
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

// Shared with the termite annual agreement's coverage end date — one
// clamping rule for every "+ N months" in the repo (utils/date-only.js).
function addMonthsSameDay(value, months) {
  return addMonthsSameDayShared(dateOnly(value), months);
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
// A row exclusively belongs to another term only while that other term
// STILL owns paid coverage on it — i.e. the row itself still carries the
// live annual stamp (prepaid_method === annual_prepay_invoice with a
// positive amount), the same evidence annualPrepayCoversVisit and every
// other coverage-authority check in this file already trust. A refund/void
// (syncTermForInvoicePayment's cancel branch) calls clearPrepaidStampsForTerm,
// which nulls prepaid_method/prepaid_amount on the row but deliberately
// LEAVES annual_prepay_term_id set (kept for audit) — without this check, a
// row whose old term was fully refunded would stay permanently excluded from
// every other term's coverage (a replacement term seeds a brand-new set of
// visits while the released ones sit on the calendar, unbilled and
// uncounted, forever "linked" to a term that no longer covers anything).
// Customer-scoped set of OTHER term ids that have positively RELEASED
// ownership (a true void/refund with no renewal decision —
// syncTermForInvoicePayment's cancel branch, the exact shape
// clearPrepaidStampsForTerm runs against). Computed once per top-level
// coverage call and threaded through rowLinkedToAnotherTerm /
// rowCommittedToTerm: a row's annual_prepay_term_id can be set BEFORE it is
// ever stamped (attachScheduledServices links by date/service match first,
// applyPrepaidCoverageForTerm stamps after), so an UNSTAMPED row linked to
// another term does NOT by itself prove that term let go of it — the other
// term could simply be mid-activation, or have failed partway through
// activation while still fully live. Only a term this query positively
// confirms cancelled-with-no-renewal-decision may have its unstamped rows
// adopted elsewhere; every other case fails closed (still linked).
// Only ever queried for the specific candidate ids the caller already found
// ambiguous (unstamped rows linked to a term other than the current one) —
// never a broad "every other term this customer ever had" scan, so the
// normal case (no such rows at all) costs nothing extra.
async function releasedTermIdsForCustomer(conn, candidateTermIds) {
  if (!candidateTermIds || !candidateTermIds.length) return new Set();
  const rows = await conn('annual_prepay_terms')
    .whereIn('id', candidateTermIds)
    .where({ status: 'cancelled' })
    .whereNull('renewal_decision')
    .select('id');
  return new Set(rows.map((row) => String(row.id)));
}

// The distinct OTHER-term ids among `rows` that are ambiguous under
// rowLinkedToAnotherTerm's own rule: linked to a term other than `term`,
// but NOT carrying that other term's live annual stamp — the only shape
// that needs releasedTermIdsForCustomer's positive-release check at all.
function ambiguousForeignTermIds(term, rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row.annual_prepay_term_id == null || term?.id == null) continue;
    if (String(row.annual_prepay_term_id) === String(term.id)) continue;
    if (row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD && Number(row.prepaid_amount) > 0) continue;
    ids.add(String(row.annual_prepay_term_id));
  }
  return [...ids];
}

function rowLinkedToAnotherTerm(term, row, releasedTermIds = null) {
  if (row.annual_prepay_term_id == null || term?.id == null) return false;
  if (String(row.annual_prepay_term_id) === String(term.id)) return false;
  // The row still carries the LIVE annual stamp from that other term —
  // definitely still owned by it regardless of the other term's own status
  // (a stamp this fresh predates any refund's own clear step).
  if (row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD && Number(row.prepaid_amount) > 0) return true;
  // Unstamped: only release this row to another term's coverage once the
  // other term is POSITIVELY VERIFIED released; otherwise still linked.
  return !(releasedTermIds && releasedTermIds.has(String(row.annual_prepay_term_id)));
}

function rowCommittedToTerm(term, row, releasedTermIds = null) {
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
  if (rowLinkedToAnotherTerm(term, row, releasedTermIds)) return false;
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

// A termite annual (sign-before-pay) ORIGINAL term — identified by the
// annual_plan_version stamp termite-annual-activation.js writes in the same
// transaction that mints the term, before its invoice can be paid (renewal
// successors carry renewed_from_term_id) — whose installation has not
// anchored it yet. Its coverage visits wait for that anchor.
function coverageAwaitsInstallation(term) {
  return !!term?.annual_plan_version && !term.renewed_from_term_id && !term.installation_anchored_at;
}

// A term whose coverage window was FIXED when it was created, so a late
// payment must never slide it: an installation-anchored termite term (its
// window IS the installation date + 12 months), and — Codex #4971 round-3 P1
// (item 5) — a termite renewal SUCCESSOR, whose window is fixed at mint (the
// day after its parent's term_end, through the next anniversary) and whose
// grace coverage already ran from that start. A successor paid on grace day
// 20 has no anchor stamp and usually no linked visit yet (payment_pending
// refreshes deliberately seed nothing), so without this it read as a first
// activation and slid term_end — and every later renewal date — by the
// payment delay: 20 extra, unpaid days per late year.
function windowFixedAtCreation(term) {
  return !!(term?.installation_anchored_at || term?.renewed_from_term_id);
}

function isInstallationAnchorRow(term, row) {
  return term?.installation_anchor_visit_id != null && row?.id != null
    && String(row.id) === String(term.installation_anchor_visit_id);
}

// Codex #4971 pre-push P0 — THE property scope of a termite renewal
// SUCCESSOR's coverage. An original term's visits are its own by estimate
// provenance and its installation anchor; a successor carries neither (it
// never copies source_estimate_id — see termiteRenewalScope), so a
// customer + dates + service-type selection would let a separately billable
// visit at ANOTHER property consume this plan's allowance and take a
// prepaid stamp that suppresses its invoice. Every coverage selection,
// seeding and stamp check therefore resolves a successor's plan identity
// through the ONE lineage resolver the grace path and the renewal notice
// use. Returns null for a non-successor (every caller keeps its exact prior
// behavior), { resolved: false } when the lineage is malformed (cycle,
// another customer's hop, conflicting estimates) or names neither an
// estimate nor a property — callers then select, seed and stamp NOTHING,
// never customer-wide — else { resolved: true, termIds, estimateId,
// propertyId }.
async function successorCoverageScope(term, conn = db) {
  if (!term?.renewed_from_term_id) return null;
  const scope = await termiteRenewalScope(term, term.customer_id, conn);
  if (!scope || (!scope.estimateId && !scope.propertyId)) return { resolved: false };
  return { resolved: true, ...scope };
}

// A visit belongs to a resolved successor scope only on POSITIVE linkage —
// a term in the plan's lineage, the plan's root estimate, or the plan's
// property — and never when it names a DIFFERENT estimate or property. An
// unlinked visit (no term, estimate or property) is never adopted.
function rowInRenewalScope(row, scope) {
  const rowProperty = row.property_id == null ? null : String(row.property_id);
  const rowEstimate = row.source_estimate_id == null ? null : String(row.source_estimate_id);
  if (scope.propertyId && rowProperty && rowProperty !== scope.propertyId) return false;
  if (scope.estimateId && rowEstimate && rowEstimate !== scope.estimateId) return false;
  return (row.annual_prepay_term_id != null && scope.termIds.has(String(row.annual_prepay_term_id)))
    || (!!scope.estimateId && rowEstimate === scope.estimateId)
    || (!!scope.propertyId && rowProperty === scope.propertyId);
}

// The in-window candidate visits coverage selection starts from: every
// customer visit in the window for an ordinary term (unchanged), only the
// plan's own visits for a renewal successor, none for an unresolved one.
async function coverageCandidateRows(term, conn, termStart, termEnd) {
  const scope = await successorCoverageScope(term, conn);
  if (scope && !scope.resolved) return [];
  const rows = await conn('scheduled_services')
    .where({ customer_id: term.customer_id })
    .whereBetween('scheduled_date', [termStart, termEnd])
    .orderBy(['scheduled_date', 'window_start', 'id'])
    .select('*');
  return scope ? rows.filter((row) => rowInRenewalScope(row, scope)) : rows;
}

async function coverageRowsForTerm(term, conn = db, {
  includeTerminalStatuses = false, extraCandidateRows = null, projectFirstActivationOn = null,
} = {}) {
  const coverageServiceType = normalizeCoverageServiceType(term?.coverage_service_type);
  const coverageVisitCount = normalizeCoverageVisitCount(term?.coverage_visit_count);
  const termStart = dateOnly(term?.term_start);
  let termEnd = dateOnly(term?.term_end);
  // projectFirstActivationOn (a YYYY-MM-DD "paid on" day): a read-only
  // caller asking which visits a NOT-yet-activated term would cover if its
  // first activation ran on that day (the re-price guard's pending /secure
  // pick). First activation slides term_end by the payment lag
  // (ensureCoverageRowsForTerm's anchorLagDays — same anchors, same
  // windowFixedAtCreation exemption), so the stored window alone would miss
  // the tail a late payment adds. The successor-term cap is not applied:
  // that only over-reports coverage (a stricter guard), never under.
  if (projectFirstActivationOn && termEnd && termStart && !windowFixedAtCreation(term)) {
    const mintAnchor = coverageSeriesAnchor(termStart, { firstVisitDate: term?.first_visit_date || null }) || termStart;
    const paidAnchor = coverageSeriesAnchor(termStart, {
      firstVisitDate: term?.first_visit_date || null, notBefore: projectFirstActivationOn,
    }) || termStart;
    const lag = daysUntil(mintAnchor, paidAnchor);
    if (lag != null && lag > 0) termEnd = addDaysYmd(termEnd, lag);
  }
  if (!term?.customer_id || !coverageServiceType || !coverageVisitCount || !termStart || !termEnd) {
    return [];
  }

  const rows = await coverageCandidateRows(term, conn, termStart, termEnd);

  // extraCandidateRows: a read-only caller's OWN in-memory rows, substituted
  // for this term's ordinary DB-backed candidates by id — the re-price
  // guard's "would paying this payment_pending term's invoice today stamp
  // THIS visit" question (admin-schedule.js's findBillingCoveredVisits),
  // where the visit's date is about to move in the SAME save the guard is
  // deciding and the live scheduled_services row still carries the OLD one.
  // Put through the exact SAME two gates the DB query already applies —
  // the term's own date window, and (for a renewal successor only) its
  // resolved coverage scope — so an override can only ever stand in for a
  // row the ordinary query would have returned once its date is actually
  // written, never see more than that.
  let candidateRows = rows;
  if (extraCandidateRows && extraCandidateRows.length > 0) {
    let overrides = extraCandidateRows.filter((row) => {
      const d = dateOnly(row?.scheduled_date);
      return !!(d && d >= termStart && d <= termEnd);
    });
    if (overrides.length > 0 && term?.renewed_from_term_id) {
      const scope = await successorCoverageScope(term, conn);
      overrides = !scope ? overrides : (!scope.resolved ? [] : overrides.filter((row) => rowInRenewalScope(row, scope)));
    }
    // Every overridden id leaves the DB list first — an override the gates
    // above dropped (moved OUT of the window or scope) must not survive
    // through its stale in-window DB row — then the eligible overrides go
    // back in, each layered over its DB row so columns the caller did not
    // select (window_start) keep their stored values. The merged list is
    // re-sorted in coverageCandidateRows' own canonical order (scheduled_date,
    // window_start, id): the sold-slot slicing below keeps the EARLIEST rows,
    // so a visit moved earlier must compete for a slot at its new position.
    const overriddenIds = new Set(extraCandidateRows.map((row) => String(row?.id)));
    const dbById = new Map(rows.map((row) => [String(row.id), row]));
    // window_start as Postgres orders a TIME: posted values arrive as
    // "9:00", "09:00" or "09:00:00" (and DB rows as "HH:MM:SS"), so compare
    // a zero-padded HH:MM:SS key, never the raw string (Codex pre-push P1).
    const timeKey = (value) => {
      if (value == null || value === '') return null;
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value).trim());
      if (!m) return String(value);
      return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
    };
    // Postgres ORDER BY ASC: NULLS LAST, plain byte order (never locale).
    const cmp = (a, b) => {
      if (a == null || b == null) return (a == null) - (b == null);
      const x = String(a); const y = String(b);
      return x < y ? -1 : (x > y ? 1 : 0);
    };
    candidateRows = [
      ...rows.filter((row) => !overriddenIds.has(String(row.id))),
      ...overrides.map((row) => ({ ...(dbById.get(String(row.id)) || {}), ...row })),
    ].sort((a, b) => cmp(dateOnly(a.scheduled_date), dateOnly(b.scheduled_date))
      || cmp(timeKey(a.window_start), timeKey(b.window_start))
      || cmp(a.id, b.id));
  }

  // A callback / re-service is never a SOLD visit: it is free by definition
  // and completion never bills it, but its service_type reads as the covered
  // family ("Pest Control Re-Service" → the same coverage key as "Quarterly
  // Pest Control Service"), so text matching adopted one into the slice and
  // pushed the customer's real fourth quarterly visit out of coverage
  // (2026-09-07, prod). Excluded up front, in every mode — a callback must
  // neither consume a sold slot nor count toward the seeder's existing rows.
  const nonCallbackRows = candidateRows.filter((row) => !isCallbackRow(row));
  const filtered = includeTerminalStatuses
    ? nonCallbackRows
    : nonCallbackRows.filter((row) => !COVERAGE_EXCLUDED_STATUSES.has(String(row.status || '').toLowerCase()));

  // Positively-released other terms for this customer (true void/refund,
  // no renewal decision) — see rowLinkedToAnotherTerm's own comment for why
  // an unstamped link alone must never be read as a release. Only queried
  // when an ambiguous row (unstamped, linked elsewhere) actually exists —
  // the normal case has none and costs nothing extra.
  const releasedTermIds = await releasedTermIdsForCustomer(conn, ambiguousForeignTermIds(term, filtered));
  const isCommittedToTerm = (row) => rowCommittedToTerm(term, row, releasedTermIds);
  // The installation visit an anchored termite annual term was anchored to
  // is this term's by explicit identity (installation_anchor_visit_id), not
  // by service-type text — it counts as the coverage year's visit even when
  // it was booked under an installation label the coverage text does not
  // match, so anchoring never seeds a second visit beside it.
  let matching = filtered.filter((row) => isInstallationAnchorRow(term, row)
    || serviceMatchesCoverage(row, coverageServiceType));
  // A row explicitly linked to a DIFFERENT term never counts toward THIS
  // term's coverage, for EVERY coverage family (not only palm — the palm
  // branch below already re-applies this, redundantly but harmlessly, as
  // part of its own identity filter). Without this, a prior term's
  // stamped visit that slips into the new term's window (a rescheduled
  // final quarterly visit, an operator-shortened boundary) is treated as
  // one of THIS term's existing rows: the renewal seeds and stamps one
  // visit short while the prior term's row double-counts (ADMIN-BUG-R19).
  matching = matching.filter((row) => !rowLinkedToAnotherTerm(term, row, releasedTermIds));
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
      if (rowLinkedToAnotherTerm(term, row, releasedTermIds)) return false;
      const cls = palmRowClass(row);
      if (cls === 'recurring') return true;
      if (cls === 'foreign') return false;
      return rowCommittedToTerm(term, row, releasedTermIds);
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

// Codex #4971 pre-push P0: a renewal successor whose plan lineage cannot be
// resolved seeds nothing (coverageRowsForTerm already selects and stamps
// nothing for it) and tells staff — never a customer-wide fallback.
async function renewalLineageRefusal(term, conn, termEnd) {
  const scope = await successorCoverageScope(term, conn);
  if (!scope || scope.resolved) return null;
  logger.warn(`[annual-prepay] term ${term.id} is a renewal whose plan lineage cannot be resolved — coverage visits not seeded or stamped`);
  await fileCoverageExceptionAfterCommit(conn, term, 'renewal_lineage_unresolved',
    'This renewed termite plan cannot be traced back to its original estimate and property (its renewal chain is broken, loops, or crosses to another customer). No coverage visits were scheduled or marked prepaid — confirm which property this plan covers and set its visits up by hand.');
  return { createdCount: 0, targetDates: [], effectiveTermEnd: termEnd, reason: 'renewal_lineage_unresolved' };
}

// The property a seeded coverage visit is booked at: a renewal successor's
// plan property (its resolved lineage — never guessed); otherwise the
// customer's SOLE active property, unchanged (GH codex #3699 r8 P2).
async function coverageSeedPropertyId(term, cols, conn) {
  if (!cols.property_id) return null;
  const scope = await successorCoverageScope(term, conn);
  if (scope) return scope.propertyId || null;
  return require('./customer-properties').soleActivePropertyId(term.customer_id, conn);
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
function fileCoverageExceptionAfterCommit(scope, term, reason, body, options = undefined) {
  const done = scope && scope !== db && scope.executionPromise;
  if (done && typeof done.then === 'function') {
    done.then(() => fileCoverageException(term, reason, body, options)).catch(() => {});
    return Promise.resolve();
  }
  return fileCoverageException(term, reason, body, options);
}

// `dedupeDays` (default 7): how long an open alert for the same term+reason
// suppresses a repeat. null = once ever (the price-drift hold keys its reason
// on the visit id, so it files exactly once per term+visit).
async function fileCoverageException(term, reason, body, {
  title = 'Annual prepay: promised first visit needs attention', dedupeDays = 7,
} = {}) {
  try {
    // notifyAdmin does not interpret dedupeKey — enforce it here (same
    // pattern as appointment-reminders): one open alert per term+reason per
    // 7 days, so a re-run refresh can't stack duplicates of the same problem.
    const dedupeKey = `annual-prepay-first-visit:${term?.id}:${reason}`;
    let existingQuery = db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    if (dedupeDays != null) {
      existingQuery = existingQuery.where('created_at', '>=', db.raw("now() - (? * interval '1 day')", [Number(dedupeDays) || 7]));
    }
    const existing = await existingQuery
      .first('id')
      .catch(() => null);
    if (existing) return;
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin(
      'alert',
      title,
      body,
      {
        link: term?.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch',
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

// The pre-tax per-visit price ensureCoverageRowsForTerm gives a visit IT
// seeds: the prepay invoice subtotal minus one-time setup lines, divided by
// the sold visit count. Shared with the stamp-time price check so the two can
// never disagree on what a seeded visit's own price is. Throws on a failed
// read — the seeder swallows that (it only loses a fallback price), the
// price check lets it propagate (fail closed). null = no derivable price.
async function seededVisitPriceForTerm(term, conn, coverageVisitCount) {
  if (!term?.prepay_invoice_id || !coverageVisitCount) return null;
  const inv = await conn('invoices').where({ id: term.prepay_invoice_id }).first('subtotal', 'total', 'line_items');
  let base = Number(inv?.subtotal) > 0 ? Number(inv.subtotal) : Number(inv?.total) || 0;
  // One-time setup lines (rodent bait-station setup, owner 2026-08-29)
  // ride the prepay invoice but are NOT per-visit coverage money —
  // subtract them before dividing, or the voided-prepay fallback price
  // rebills every visit with a slice of the setup fee. The IMMUTABLE
  // setup_fee_claims record decides first (codex #3591 r71 P1) — a
  // staff-renamed line would otherwise inflate every seeded fallback
  // price by the setup's slice while a later reversal also restores the
  // setup itself; the text scan stays only for pre-ledger invoices.
  let setupTotal = 0;
  try {
    const claimRow = await conn('setup_fee_claims').where({ invoice_id: term.prepay_invoice_id }).first('amount');
    setupTotal = Math.round((Number(claimRow?.amount) || 0) * 100) / 100;
  } catch { /* unreadable ledger — fall back to the line scan */ }
  if (!(setupTotal > 0)) {
    try {
      const lines = typeof inv?.line_items === 'string' ? JSON.parse(inv.line_items) : inv?.line_items;
      if (Array.isArray(lines)) {
        setupTotal = lines
          .filter((li) => /\bsetup\b/i.test(String(li?.description || '')))
          .reduce((s, li) => s + (Number(li?.unit_price) || 0) * (Number(li?.quantity) || 1), 0);
      }
    } catch { /* unparseable line_items — keep the subtotal basis */ }
  }
  if (setupTotal > 0 && setupTotal < base) base = Math.round((base - setupTotal) * 100) / 100;
  return base > 0 ? Math.round((base / coverageVisitCount) * 100) / 100 : null;
}

// seedNotBefore (opt-in, ADMIN-BUG-R18): a gap-fill never seeds a visit
// dated before it; such slots come back in unseededPastDates for the caller
// to hand to the office. gapFillOnly (opt-in, same lane): the term is never
// treated as a first activation — no today floor on the anchor, no window
// slide persisted to term_end — even when no visit is linked to it yet (a
// legacy decided lapse): only slots inside the stored window are filled.
// Unset (every activation / refresh caller), the behavior is unchanged.
// Durable record that a term's coverage window already slid for a late
// payment (see the slide in ensureCoverageRowsForTerm). One row per term; the
// newest wins. Returns { originalTermEnd } or null. A failed read
// THROWS — the caller fails safe (no second slide).
const WINDOW_SLID_ACTION = 'annual_prepay_window_slid';
async function findWindowSlideMarker(term, conn) {
  const row = await conn('activity_log')
    .where({ action: WINDOW_SLID_ACTION })
    .whereRaw("metadata->>'term_id' = ?", [String(term.id)])
    .orderBy('created_at', 'desc')
    .first('metadata');
  if (!row) return null;
  let meta = row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  if (!meta) return null;
  return {
    originalTermEnd: dateOnly(meta.original_term_end),
  };
}

async function ensureCoverageRowsForTerm(term, conn = db, {
  today = etDateString(), nowHHMM = etNowHHMM(), seedNotBefore = null, gapFillOnly = false,
} = {}) {
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
  // Termite annual plan (sign before pay, codex #4819 r6 P1): the signed
  // agreement's coverage year begins at the station installation, and
  // activation books no visit — so nothing is seeded until the term is
  // installation-anchored (termite-annual-activation.js). Seeding at the
  // provisional signature-day start would put a phantom visit on the board
  // that the install-scheduling handoff cannot see. Checked here, the one
  // seeding decision every caller (payment sync, refresh, sweeps) reaches.
  if (coverageAwaitsInstallation(term)) {
    return {
      createdCount: 0, targetDates: [], effectiveTermEnd: termEnd, reason: 'awaiting_installation',
    };
  }
  const lineageRefusal = await renewalLineageRefusal(term, conn, termEnd);
  if (lineageRefusal) return lineageRefusal;
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
  const alreadyActivated = gapFillOnly || (!!cols.annual_prepay_term_id
    && !!(await conn('scheduled_services').where({ annual_prepay_term_id: term.id }).first('id')));

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
  // extension would seed visits the stored window doesn't cover. An
  // installation-anchored termite term never slides: its window IS the
  // installation date + 12 months, and the anchoring sweep runs after the
  // installation, so the lag would otherwise stretch every anchored year.
  // Nor does a termite renewal SUCCESSOR (windowFixedAtCreation).
  // The slide is a pure function of the term's ORIGINAL end and the anchor,
  // never an increment on whatever term_end currently holds. A first
  // activation can persist the slid term_end (below) and then fail (or defer
  // seeding) BEFORE any visit is linked to the term — "already activated" is
  // inferred from linked rows, so the retry would look like a first
  // activation again and add the payment lag to the already-slid end. The
  // slide therefore leaves a durable marker (activity_log, written BEFORE
  // term_end moves) recording the term's original end; a retry recomputes
  // original end + lag(anchor), which is the same value for the same anchor
  // (no change, no double slide) and grows only by what a genuinely later
  // anchor adds.
  let priorSlide = null;
  let slideMarkerUnreadable = false;
  const slideEligible = !alreadyActivated && !windowFixedAtCreation(term)
    && anchorLagDays != null && anchorLagDays > 0 && !!(await annualPrepayColumns(conn)).term_end;
  if (slideEligible) {
    try {
      priorSlide = await findWindowSlideMarker(term, conn);
    } catch (err) {
      // Fail SAFE (same posture as the successor check): without certainty
      // the slide was not already applied, don't slide again.
      slideMarkerUnreadable = true;
      logger.warn(`[annual-prepay] term ${term.id} window-slide marker lookup failed (${err.message}) — coverage window not extended this run`);
    }
  }
  if (slideEligible && !slideMarkerUnreadable) {
    const slideBase = priorSlide?.originalTermEnd || termEnd;
    effectiveTermEnd = addDaysYmd(slideBase, anchorLagDays);
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
        .where('term_start', '>', slideBase)
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
    // A retry never SHRINKS a window an earlier run already persisted.
    if (effectiveTermEnd < termEnd) effectiveTermEnd = termEnd;
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
  const unseededPastDates = [];
  for (const scheduledDate of targetDates) {
    if (datesToSeed.length + unseededPastDates.length >= remainingToSeed) break;
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
    if (seedNotBefore && scheduledDate < seedNotBefore) {
      unseededPastDates.push(scheduledDate);
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
      seededVisitPrice = await seededVisitPriceForTerm(term, conn, coverageVisitCount);
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
    // Marker FIRST (see priorSlide above): if the term_end write then fails,
    // the retry finds the marker and recomputes the same end from the recorded
    // original; the reverse order could slide twice. A retry that already
    // holds the marker does not write another.
    if (!priorSlide) {
      await conn('activity_log').insert({
        customer_id: term.customer_id,
        action: WINDOW_SLID_ACTION,
        description: 'Annual prepay paid after its anchor: coverage window slid once so all sold visits stay in-window.',
        metadata: {
          term_id: term.id,
          original_term_end: termEnd,
          effective_term_end: effectiveTermEnd,
          anchor_date: targetDates[0] || null,
          lag_days: anchorLagDays,
        },
      });
    }
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

  // Property identity for the visit-group stamp (GH codex #3699 r8 P2):
  // prepaid seeds carry no estimate for the linkage regroup, so an
  // unstamped property makes maybeGroupRow refuse forever. Only the
  // customer's SOLE active property is unambiguous (same rule as the
  // manual admin-schedule / admin-leads / availability bookings);
  // multi-property customers stay office-placed. Resolved once per term.
  const seedPropertyId = await coverageSeedPropertyId(term, cols, conn);
  const buildInsert = (scheduledDate, windowStart) => {
    const insertData = {
      customer_id: term.customer_id,
      scheduled_date: scheduledDate,
      service_type: coverageServiceType,
      status: 'pending',
      notes: `Annual prepaid ${coverageServiceType} coverage`,
      estimated_duration_minutes: baseDuration,
    };
    if (cols.property_id && seedPropertyId) insertData.property_id = seedPropertyId;
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
  // A callback is excluded here exactly as in coverageRowsForTerm (GH Codex
  // #4105 P1): a same-day callback adopted under the lock would skip the
  // insert while every later attach/stamp pass filters it back out — the
  // paid term would stay one visit short on every refresh.
  // Deliberately conservative (no releasedTermIds threaded in): this
  // per-row adoption check runs mid-occupancy-lock during first-visit
  // seeding, a narrow enough path that extending it the same release
  // leniency as coverageRowsForTerm's own primary determination isn't
  // worth the async plumbing here — an unstamped row linked elsewhere
  // simply stays excluded, exactly as before this fix (never a regression,
  // just not more lenient in this one edge path).
  const adoptableCoverageRow = (row) => !isCallbackRow(row)
    && serviceMatchesCoverage(row, coverageServiceType)
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
    // Visit groups (visit-group-scope.md §2; owner ruling 2026-08-31):
    // prepaid timed first visits stamp like any other booking — nothing to
    // charge, so no autopay/billing risk, and the shared stop gets one
    // reminder/tracker. Gate-checked + best-effort + self-refusing inside
    // maybeGroupRow (windowless seeds below never stamp — self-refused).
    if (row?.id) await require('./visit-groups').maybeGroupRow(row.id, { database: trx, createdBy: 'seeder' });
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
    let row = adoptedPromisedRow;
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
        row = fresh;
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
    await trx('scheduled_services').where({ id: row.id }).update({ ...updates, ...recurringDispatchDuePatch(row, updates) });
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

  // datesToSeed was computed BEFORE the customer-comms lock every windowless
  // insert below takes. Two refreshes of one term can overlap (the re-stamp
  // sweep against an admin edit or the activation refresh, the daily leg
  // against the hourly one): both would read the same gaps, then insert one
  // after the other and leave DUPLICATE future appointments. Re-evaluated
  // UNDER the lock that serializes the inserts, against what other
  // transactions have committed since: a visit this call has not seen that
  // fills the sold count, or sits within the slot tolerance of this date
  // (exactly on the date for the promised slot), means the slot is taken.
  const seedStillNeeded = async (t, scheduledDate) => {
    // Distinct alias: a presence probe of its own, not a second coverage
    // selection — adoptableCoverageRow is the SAME predicate the same-day
    // adoption under the occupancy lock uses.
    const fresh = await t('scheduled_services as seed_recheck')
      .where({ customer_id: term.customer_id })
      .whereBetween('scheduled_date', [termStart, effectiveTermEnd])
      .where((q) => q.whereNull('status').orWhereNotIn('status', Array.from(COVERAGE_EXCLUDED_STATUSES)))
      .select('*');
    const known = new Set([...existingRows, ...createdRows].map((row) => String(row.id)));
    const concurrent = (fresh || []).filter((row) => !known.has(String(row.id))
      && dateOnly(row.scheduled_date) && adoptableCoverageRow(row));
    if (!concurrent.length) return true;
    if (existingRows.length + createdRows.length + concurrent.length >= coverageVisitCount) return false;
    return !concurrent.some((row) => {
      const existingDate = dateOnly(row.scheduled_date);
      if (scheduledDate === promisedTarget) return existingDate === scheduledDate;
      const diff = daysUntil(existingDate, scheduledDate);
      return diff != null && Math.abs(diff) <= slotToleranceDays;
    });
  };
  const skipConcurrentSeed = (scheduledDate) => {
    logger.info(`[annual-prepay] term ${term.id}: ${scheduledDate} was filled by a concurrent refresh under the lock — not seeding a duplicate`);
  };

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
      } else if (!(await seedStillNeeded(conn, scheduledDate))) {
        skipConcurrentSeed(scheduledDate);
        created = null;
      } else {
        // Visit groups: deliberately NOT stamped — these are windowless
        // seeds (buildInsert(date, null)), which maybeGroupRow refuses by
        // policy; office placement is their grouping moment.
        [created] = await conn('scheduled_services').insert(buildInsert(scheduledDate, null)).returning('*');
      }
    } else {
      // Fresh transaction holds nothing yet — a blocking rung-6 acquire is
      // safe here (utils/customer-comms-lock.js).
      // Visit groups: deliberately NOT stamped — windowless seed (above).
      [created] = await withCustomerCommsLock(conn, term.customer_id, async (trx) => {
        if (await termOwnerMovedUnderFence(trx)) return [null];
        if (!(await seedStillNeeded(trx, scheduledDate))) {
          skipConcurrentSeed(scheduledDate);
          return [null];
        }
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

  // Anchor the prepay's anchor-less setup claim to the covered series root
  // (codex #3591 r77 P1): a Customer 360 coverage-only mint ledgered its
  // claim before any series existed — once seeding creates (or finds) the
  // covered root, the claim belongs HERE. Left anchor-less, a later
  // unrelated rodent booking could adopt it and suppress its own setup.
  // Best-effort (warn, never roll back the seeding): an unanchored claim is
  // recoverable — the adoption path only reads claims of LIVE terms.
  if (term?.prepay_invoice_id && createdParentId) {
    try {
      const claimless = await conn('setup_fee_claims')
        .where({ invoice_id: term.prepay_invoice_id })
        .whereNull('scheduled_service_id')
        .first('id');
      if (claimless) {
        const { anchorSetupFeeClaim } = require('./secure-appointment-plans');
        await anchorSetupFeeClaim(conn, { claimId: claimless.id, anchorId: createdParentId });
        logger.info(`[annual-prepay] term ${term.id}: anchor-less setup claim ${claimless.id} anchored to covered series root ${createdParentId}`);
      }
    } catch (err) {
      logger.warn(`[annual-prepay] term ${term.id}: setup-claim anchoring skipped (${err.message}) — retried on the next term refresh`);
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
        unseededPastDates,
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
    unseededPastDates,
  };
}

function noticeColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 45) return 'notice_45_sent_at';
  if (n === 30) return 'notice_30_sent_at';
  if (n === 15) return 'notice_15_sent_at';
  if (n === 7) return 'notice_7_sent_at';
  return null;
}

function noticeClaimColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === 45) return 'notice_45_claimed_at';
  if (n === 30) return 'notice_30_claimed_at';
  if (n === 15) return 'notice_15_claimed_at';
  if (n === 7) return 'notice_7_claimed_at';
  return null;
}

// Whether this term is a termite annual-plan term at all — the ONLY plan
// family the 45-day rung and the termite-specific 45/30-day copy apply to.
// Same stamp coverageAwaitsInstallation reads, but without its
// renewed_from/anchor conditions: this is a plain "is this ever a termite
// annual term" question for copy selection, not an installation gate.
function isTermiteAnnualPlanTerm(term) {
  return !!term?.annual_plan_version;
}

// The plan's OWN property — a multi-property customer's billing address can
// be a different site, and the termite notice names the protected property.
// Codex #4921 r10 P1 order: the estimate's QUOTED ADDRESS SNAPSHOT
// (`estimates.address`) whenever present — it is the authoritative record of
// what was quoted and never changes, whereas a linked customer_properties row
// is rewritten by syncPrimaryAddress when the customer moves; the linked
// property row only for a legacy estimate with no snapshot (the snapshot
// carries no separate city/state/zip, so it lands whole in address_line1);
// and the customer's primary address (null here) only when the estimate has
// neither.
//
// Codex #4921 r4 P1: a lookup ERROR is NOT absence. It used to be caught and
// turned into null, so a transient DB error silently fell through to the
// customer's primary address — which, for a multi-property customer, names
// the WRONG property in a legal renewal notice. Errors now propagate:
// sendCustomerTermNotice's catch releases the claim and rethrows, the
// sweep logs it per term, and the rung is retried on the next run (with the
// undelivered-past-deadline bell as the durable backstop). null is returned
// ONLY when the data is genuinely absent — no source estimate, no estimate
// row, or neither a linked property address nor an estimate address.
//
// Codex #4971 round-3 (item 8): a renewal SUCCESSOR has no
// source_estimate_id of its own (never copied — see termiteRenewalScope), so
// its plan's estimate is its ROOT ancestor's, recovered through the shared
// customer-scoped, cycle-safe lineage resolver. The root estimate's snapshot
// stays the preferred address, exactly as for the original term. A
// malformed lineage resolves no estimate (null — the notice then uses the
// customer's address, the same answer as a term with no estimate at all).
async function planEstimateIdForTerm(term, conn = db) {
  if (term?.source_estimate_id) return term.source_estimate_id;
  if (!term?.renewed_from_term_id) return null;
  const scope = await termiteRenewalScope(term, term.customer_id, conn);
  return scope?.estimateId || null;
}

async function planPropertyForTerm(term, conn = db) {
  const estimateId = await planEstimateIdForTerm(term, conn);
  if (!estimateId) return null;
  const estimate = await conn('estimates')
    .where('id', estimateId)
    .first('property_id', 'address');
  if (!estimate) return null;
  if (estimate.address) {
    return { address_line1: estimate.address, address_line2: null, city: null, state: null, zip: null };
  }
  if (!estimate.property_id) return null;
  const property = await conn('customer_properties')
    .where('id', estimate.property_id)
    .first('address_line1', 'address_line2', 'city', 'state', 'zip');
  return property?.address_line1 ? property : null;
}

// Matches email-template.js's currency() formatting so the SMS and email
// legs of the same notice render the same figure the same way.
function formatCurrencyLabel(amount) {
  const value = Number(amount || 0);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Fail-closed admin bell for a termite rung skipped because the ORIGINAL
// term is still awaiting its installation anchor (coverageAwaitsInstallation
// — annual_plan_version set, no renewed_from_term_id, no
// installation_anchored_at). Its term_end is only a PROVISIONAL date
// (signature day + 12mo, seeded so the term can exist for the invoice)
// until the installation visit completes and anchorTermToInstallation
// re-anchors it, so a notice here would both quote the wrong renewal
// date/fee and (for an 'active' term) let claimTermNotice flip status to
// renewal_pending — which termite-annual-activation.js's installation sweep
// (ANCHORABLE_TERM_STATUSES: payment_pending/active only) would then never
// anchor, permanently losing the real coverage window. Safer to skip the
// notice entirely and tell staff the install never happened than to send
// one off a date that is not real yet. Same one-open-alert-per-reason-per-
// week dedupe shape as the sibling exceptions below, keyed per term+rung.
// Dedupe window for the three "skipped" termite exceptions below — one open
// alert per term+rung+reason per week. Codex #4921 r3 P1: this used to be a
// standalone SELECT-then-insert probe run BEFORE notifyAdmin, which is not
// atomic across pods/dynos — two concurrent sweeps can both see "no existing
// row" and both insert. notifyAdmin's own dedupeKey (+ dedupeWindowMs for a
// rolling window instead of forever) serializes the probe and insert under
// one Postgres advisory lock inside notifyAdmin's own transaction
// (notification-service.js), so this is now genuinely atomic.
const TERMITE_EXCEPTION_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function fileTermiteAwaitingInstallationException(term, daysOut) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice skipped: installation never completed',
      `The ${daysOut}-day termite renewal notice for term ${term?.id} was skipped because the plan's installation visit has never completed — its term_end is only a provisional placeholder until then. Complete the installation (or fix the term) rather than letting this renew on the wrong date.`,
      {
        link: term?.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch',
        // bell:true — same rationale as the sibling termite exceptions: a
        // skipped notice must ring even under GATE_ADMIN_BELL_POLICY.
        bell: true,
        dedupeKey: `termite-annual-notice:${term?.id}:${daysOut}:awaiting_installation`,
        dedupeWindowMs: TERMITE_EXCEPTION_DEDUPE_WINDOW_MS,
        metadata: {
          customer_id: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          days_out: daysOut,
          reason: 'awaiting_installation',
        },
      },
    );
  } catch (err) {
    logger.warn(`[annual-prepay] termite awaiting-installation exception notification failed for term ${term?.id}: ${err.message}`);
  }
}

// Fail-closed admin bell for a termite rung that could not be sent because
// the portal's cancel-request flow (the disclosure's own cancel link) is
// dark. Same one-open-alert-per-reason-per-week dedupe as
// fileCoverageException, keyed per term+rung so the deploy-wide gate being
// off does not spam a bell per customer per day.
async function fileTermiteCancelLinkException(term, daysOut) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice skipped: cancel flow is off',
      `The ${daysOut}-day termite renewal notice for term ${term?.id} was skipped because the customer portal's cancel-request flow (GATE_CANCEL_FLOW_V2) is off — sending would promise auto-renewal with no working cancel link. Enable the gate or handle this renewal manually.`,
      {
        link: term?.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch',
        // bell:true — a skipped termite notice leaves the renewal without its
        // notice witness, so this must ring even under GATE_ADMIN_BELL_POLICY
        // (the 'alert' category is silenced by default there).
        bell: true,
        dedupeKey: `termite-annual-notice:${term?.id}:${daysOut}:cancel_flow_disabled`,
        dedupeWindowMs: TERMITE_EXCEPTION_DEDUPE_WINDOW_MS,
        metadata: {
          customer_id: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          days_out: daysOut,
          reason: 'cancel_flow_disabled',
        },
      },
    );
  } catch (err) {
    logger.warn(`[annual-prepay] termite cancel-link exception notification failed for term ${term?.id}: ${err.message}`);
  }
}

// Fail-closed admin bell for a termite rung that could not be sent because
// the term has no renewal fee to disclose (prepay_amount NULL/blank) —
// formatCurrencyLabel's Number(amount || 0) fallback would otherwise render
// a live "$0.00" renewal-fee promise in the SMS/email, which is a false
// statement to the customer, not a safe default. Same
// one-open-alert-per-reason-per-week dedupe shape as
// fileTermiteCancelLinkException, keyed per term+rung.
async function fileTermiteMissingFeeException(term, daysOut) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice skipped: no renewal fee on file',
      `The ${daysOut}-day termite renewal notice for term ${term?.id} was skipped because the term has no prepay_amount recorded — sending would state a renewal fee of $0.00 instead of the real amount. Set the term's renewal fee or handle this renewal manually.`,
      {
        link: term?.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch',
        // bell:true — same rationale as fileTermiteCancelLinkException: a
        // skipped termite notice leaves the renewal without its notice
        // witness, so this must ring even under GATE_ADMIN_BELL_POLICY.
        bell: true,
        dedupeKey: `termite-annual-notice:${term?.id}:${daysOut}:missing_prepay_amount`,
        dedupeWindowMs: TERMITE_EXCEPTION_DEDUPE_WINDOW_MS,
        metadata: {
          customer_id: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          days_out: daysOut,
          reason: 'missing_prepay_amount',
        },
      },
    );
  } catch (err) {
    logger.warn(`[annual-prepay] termite missing-fee exception notification failed for term ${term?.id}: ${err.message}`);
  }
}

// The escalation-witness column for a termite rung's late-notice bell —
// mirrors termiteLateColumnForDaysOut for the *_late_escalated_at side.
function termiteLateEscalationColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === TERMITE_EXTRA_NOTICE_DAYS) return 'notice_45_late_escalated_at';
  if (n === 30) return TERMITE_30_LATE_ESCALATION_COLUMN;
  return null;
}

// Admin bell when a termite rung (45 or 30) went out LATE — fewer than its
// own threshold of days before term_end, either a genuine retry landing
// late or the single combined send processTermiteNoticeObligations chooses
// when both rungs are due at once. The customer was told, but the signed
// agreement's notice promise for THIS rung was missed. Only the 45-day
// rung gates the renewal-charge auto-send (slice 6b reads notice_45_sent_at
// only) — the 30-day rung's lateness is a durable record + staff
// escalation on its own, not an independent billing gate.
//
// notifyAdmin returns null on an INSERT failure rather than throwing
// (notification-service.js: "create() returns null on an insert failure …
// spreading that null would report {deduped:false} as if a row landed" —
// it throws inside its own transaction and the outer catch turns that into
// null too). The rung's own late-sent column already permanently blocks
// every retry of the SEND itself, so swallowing a null result here would
// lose the escalation bell for good with no way even to notice, let alone
// retry, it. The escalated stamp is therefore written ONLY on a confirmed
// (non-null) result; a null result leaves it unset so
// termiteLateNoticeEscalationCandidates() retries this same call on the
// next daily sweep (Codex #4921 r2 P1, generalized to 30 in r3).
async function fileTermiteLateNoticeException(term, daysOut) {
  try {
    const n = Number(daysOut);
    const escalatedCol = termiteLateEscalationColumnForDaysOut(n);
    const chargeSentence = n === TERMITE_EXTRA_NOTICE_DAYS
      ? ' this renewal will not be auto-charged — handle it manually.'
      : ' handle this renewal\'s notice timing manually if the 45-day rung was also late.';
    const NotificationService = require('./notification-service');
    const result = await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice went out late',
      `The ${n}-day termite renewal notice for term ${term?.id} (renews ${formatDateLabel(term?.term_end)}) was sent fewer than ${n} days before the renewal date, so the agreement's ${n}-day notice promise was missed. The customer has been told;${chargeSentence}`,
      {
        link: term?.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch',
        bell: true,
        dedupeKey: `termite-annual-notice:${term?.id}:${n}:late`,
        metadata: {
          customerId: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          days_out: n,
          reason: `notice_${n}_late`,
        },
      },
    );
    if (!result) {
      logger.warn(`[annual-prepay] termite late-notice admin bell insert failed for term ${term?.id}; will retry on the next sweep`);
      return false;
    }
    if (term?.id && escalatedCol) {
      const cols = await annualPrepayColumns();
      if (cols[escalatedCol]) {
        await db('annual_prepay_terms')
          .where({ id: term.id })
          .whereNull(escalatedCol)
          .update({ [escalatedCol]: new Date(), updated_at: new Date() });
      }
    }
    return true;
  } catch (err) {
    logger.warn(`[annual-prepay] termite late-notice notification failed for term ${term?.id}: ${err.message}`);
    return false;
  }
}

// Retry point for fileTermiteLateNoticeException's admin-bell insert
// failing (notifyAdmin returning null): every term with a late-sent 45 or
// 30-day rung missing its OWN confirmed escalation stamp. A term can carry
// both (found late, e.g.) — checkAndSend re-files whichever of the two is
// still unescalated on this row. Guarded on the relevant columns existing
// so a DB mid-rollout never 500s here — see checkAndSend.
async function termiteLateNoticeEscalationCandidates({ conn = db } = {}) {
  return conn('annual_prepay_terms')
    .whereNotNull('annual_plan_version')
    .where(function anyLateUnescalated() {
      this.where(function late45() {
        this.whereNotNull(TERMITE_LATE_NOTICE_COLUMN).whereNull('notice_45_late_escalated_at');
      }).orWhere(function late30() {
        this.whereNotNull(TERMITE_30_LATE_NOTICE_COLUMN).whereNull(TERMITE_30_LATE_ESCALATION_COLUMN);
      });
    })
    .select('*');
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

// Codex #4971 r22 P1: the ONE "this term's prepay invoice is collected"
// definition, shared by invoiceTermStatus (JS) and every SQL reader of the
// same fact — coveredTermsAsOf's paid-pending and decided-coverage arms and
// activatePaidPendingTerms' recovery scan. 'prepaid' is a prepay invoice
// settled entirely by auto-applied account credit (no paid_at, no card
// charge — stripe.js's credit-coverage seam): consumed credit is money
// collected. Only a term's own prepay invoice is ever tested here.
const PREPAY_INVOICE_COLLECTED_STATUSES = ['paid', 'prepaid'];
function wherePrepayInvoiceCollected(builder, alias = 'i') {
  return builder.whereIn(`${alias}.status`, PREPAY_INVOICE_COLLECTED_STATUSES).orWhereNotNull(`${alias}.paid_at`);
}

function invoiceTermStatus(invoice) {
  if (!invoice) return PAYMENT_PENDING_STATUS;
  const status = String(invoice.status || '').toLowerCase();
  if (INVOICE_CANCELLED_STATUSES.has(status)) return 'cancelled';
  // Codex #4971 r21 P1: a PREPAY invoice settled entirely by auto-applied
  // account credit is 'prepaid' with NO paid_at (stripe.js's credit-coverage
  // seam — chargeInvoiceWithSavedCard returns covered_by_credit without a
  // card charge and calls syncTermForInvoicePayment with that row). That
  // credit was CONSUMED for this term's year, so it is money collected —
  // the same rule the visit-invoice direction (paidForVisit / visitCollected)
  // already applied — and the term activates. Only a term's own prepay
  // invoice reaches this function; the coverage-settled 'prepaid' a visit
  // invoice carries under a term is never a prepay_invoice_id.
  if (PREPAY_INVOICE_COLLECTED_STATUSES.includes(status) || invoice.paid_at) return 'active';
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

// A legacy term with no coverage config links every customer visit in its
// window. Codex #4971 pre-push P0: never for a renewal successor, whose
// visits are only ever its own plan's (successorCoverageScope) — it links
// nothing here rather than going customer-wide.
async function linkWindowVisitsWithoutCoverageConfig(term, conn) {
  if (term.renewed_from_term_id) return;
  await conn('scheduled_services')
    .where({ customer_id: term.customer_id })
    .whereBetween('scheduled_date', [dateOnly(term.term_start), dateOnly(term.term_end)])
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .where(function () {
      this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
    })
    .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
}

// A row this term must not stamp: already prepaid by another term, or paid
// out-of-band.
function rowPrepaidElsewhere(term, row) {
  return (
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
  );
}

// ---------------------------------------------------------------------------
// STAMP-TIME PRICE CHECK (owner ruling 2026-09-30, secure-prepay rail #5387).
// The re-price guard in admin-schedule.js predicts, at SAVE time, which visits
// a held /secure annual-prepay term will cover once paid — and nine review
// rounds each found another timing gap in that prediction. This is the
// structural backstop at the one place a term actually stamps visits
// (attachScheduledServices / applyPrepaidCoverageForTerm, which every
// activation, refresh, late-payment and end-at-term upkeep path runs): a
// visit whose CURRENT price is not the price the term was sold at is never
// linked or stamped. It stays uncovered (bills as normal) and the office is
// told once per term+visit.
//
// Price-only, cents-compared on estimated_price: a service-only edit at an
// unchanged price is never a reason to hold. A null price is unknown, not
// changed. Visits ALREADY stamped by this term are never un-stamped or
// re-judged (their stamp was legitimate when written; the save-time guard
// owns edits to them). The held visit's sold slot stays UNUSED — the next
// visit does not slide into it — because coverageRowsForTerm's canonical
// selection is the single definition of "which visits this term covers", and
// the save-time guard predicts exactly that selection.
//
// The sold per-visit price is what selectSecurePlan (secure-appointment-plans
// .js) froze into the term's own mint record: the activity_log row it writes
// in the mint transaction carries per_visit_amount, which selectSecurePlan
// re-checked under the customer lock to equal the visit's live
// estimated_price. Only secure-plan terms carry this baseline — every other
// mint path (operator, estimate accept, on-site switch) records a discounted
// slice, not a list price, so there is no per-visit price to compare and
// those terms are left exactly as before.
const SECURE_PLAN_MINT_SOURCE = 'secure_plan_choice';
const PRICE_DRIFT_HELD_REASON = 'price_drift_held';

function priceCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function securePlanSoldPerVisitCents(term, conn) {
  if (!term?.id || !term.customer_id) return null;
  // A failed read PROPAGATES (fail closed): swallowing it would stamp a
  // repriced visit at the old price on a transient error. The stamp runs in
  // the caller's transaction, which a failed select poisons anyway, and the
  // activation / refresh / sweep callers retry on their next run.
  const row = await conn('activity_log')
    .where({ customer_id: term.customer_id, action: 'annual_prepay_invoice_created' })
    .whereRaw("metadata->>'annual_prepay_term_id' = ?", [String(term.id)])
    .whereRaw("metadata->>'source' = ?", [SECURE_PLAN_MINT_SOURCE])
    .orderBy('created_at', 'desc')
    .first('metadata');
  if (!row) return null;
  let meta = row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return null; }
  }
  const sold = priceCents(meta?.per_visit_amount);
  return sold != null && sold > 0 ? sold : null;
}

// Splits `rows` (coverage rows in canonical slot order) into the visits the
// term may stamp and the ones held for a changed price.
async function holdPriceDriftedRows(term, rows, conn, { skipRow = null, includeCompleted = false } = {}) {
  const none = { held: [], heldIds: new Set(), guardedIds: new Set() };
  if (!rows.length) return none;
  const held = [];
  const isLiveStampOfTerm = (row) => row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD
    && Number(row.prepaid_amount) > 0
    && row.annual_prepay_term_id != null
    && String(row.annual_prepay_term_id) === String(term.id);
  // Terminal-status rows are never stamped (PREPAID_UPDATE_EXCLUDED_STATUSES),
  // so there is nothing to hold — EXCEPT for the completion reconcile
  // (`includeCompleted`), which settles/credits a completed unstamped row and
  // so must keep a held (drifted) visit held after it completes. `skipRow` is
  // the caller's own already-covered exemptions (foreign term / out-of-band
  // payment).
  const statusExempt = (row) => {
    const status = String(row.status || '').toLowerCase();
    if (includeCompleted && status === 'completed') return false;
    return PREPAID_UPDATE_EXCLUDED_STATUSES.has(status);
  };
  const eligible = rows.filter((row) => !isLiveStampOfTerm(row) && !statusExempt(row)
    && !(skipRow && skipRow(row)));
  const candidates = eligible.filter((row) => priceCents(row.estimated_price) != null);
  if (!candidates.length) return none;
  const soldCents = await securePlanSoldPerVisitCents(term, conn);
  if (soldCents == null) return none;
  // ONLY the term's own SEEDED visits may carry the discounted per-visit
  // price (ensureCoverageRowsForTerm's seededVisitPrice); every other row must
  // still be at the sold price. Seeded = linked to this term AND carrying the
  // seeder's own notes text (staff never type it; an edited note simply reads
  // as a real visit and is held — fail closed).
  const seedNote = `Annual prepaid ${normalizeCoverageServiceType(term.coverage_service_type)} coverage`;
  const isSeededByTerm = (row) => row.annual_prepay_term_id != null
    && String(row.annual_prepay_term_id) === String(term.id)
    && String(row.notes || '') === seedNote;
  let seededCents;
  const seededPriceCents = async () => {
    if (seededCents === undefined) {
      seededCents = priceCents(await seededVisitPriceForTerm(term, conn, normalizeCoverageVisitCount(term.coverage_visit_count)));
    }
    return seededCents;
  };
  for (const row of candidates) {
    const current = priceCents(row.estimated_price);
    if (current === soldCents) continue;
    if (isSeededByTerm(row) && current === await seededPriceCents()) continue;
    held.push({ row, soldCents });
  }
  // guardedIds: every row a baseline-carrying term may now write to. The
  // writers add the OBSERVED estimated_price to their UPDATE so a price that
  // moves between this read and the write (a writer outside the prepay
  // advisory lock) matches nothing instead of being stamped at the old price.
  return {
    held,
    heldIds: new Set(held.map(({ row }) => String(row.id))),
    guardedIds: new Set(eligible.map((row) => String(row.id))),
  };
}

// UPDATE predicate pinning the estimated_price a stamp/link decision was made
// on (NULL-safe).
function whereObservedPrice(query, row) {
  return query.whereRaw('estimated_price IS NOT DISTINCT FROM ?::numeric', [row.estimated_price ?? null]);
}

async function fileHeldPriceDriftAlerts(term, held, notifyScope) {
  for (const { row, soldCents } of held) {
    const date = dateOnly(row.scheduled_date) || 'undated';
    logger.warn(`[annual-prepay] term ${term.id}: visit ${row.id} (${date}) held out of coverage — repriced to $${(priceCents(row.estimated_price) / 100).toFixed(2)} after the term was sold at $${(soldCents / 100).toFixed(2)} per visit`);
    await fileCoverageExceptionAfterCommit(notifyScope, term, `${PRICE_DRIFT_HELD_REASON}:${row.id}`,
      `The ${date} ${row.service_type || 'service'} visit was repriced to $${(priceCents(row.estimated_price) / 100).toFixed(2)} after this annual prepay was sold at $${(soldCents / 100).toFixed(2)} per visit, so it was NOT marked as covered and will bill normally (its sold slot stays unused). To cover it, edit the visit back to exactly $${(soldCents / 100).toFixed(2)} (the schedule editor allows that) and it is covered on the next refresh; changing it to any other price stays blocked while this prepay is held. Or adjust the term.`,
      { title: 'Annual prepay: repriced visit left uncovered', dedupeDays: null });
  }
}

async function attachScheduledServices(term, conn = db) {
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !term?.id) return;
  try {
    const coverageServiceType = normalizeCoverageServiceType(term.coverage_service_type);
    const coverageVisitCount = normalizeCoverageVisitCount(term.coverage_visit_count);
    if (coverageServiceType && coverageVisitCount) {
      const rows = await coverageRowsForTerm(term, conn);
      const { heldIds, guardedIds } = await holdPriceDriftedRows(term, rows, conn, { skipRow: (r) => rowPrepaidElsewhere(term, r) });
      const linkable = rows.filter((row) => row.id && !heldIds.has(String(row.id)));
      const linkOwnership = function () {
        this.whereNull('annual_prepay_term_id').orWhere('annual_prepay_term_id', term.id);
      };
      const bulkIds = linkable.filter((row) => !guardedIds.has(String(row.id))).map((row) => row.id);
      if (bulkIds.length) {
        await conn('scheduled_services')
          .whereIn('id', bulkIds)
          .where(linkOwnership)
          .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
      }
      // Baseline-carrying term: each link is pinned to the price it was judged
      // on. A zero-row match (price moved since) is simply not linked; the
      // stamp step re-judges the row itself.
      for (const row of linkable.filter((r) => guardedIds.has(String(r.id)))) {
        await whereObservedPrice(conn('scheduled_services').where({ id: row.id }).where(linkOwnership), row)
          .update({ annual_prepay_term_id: term.id, updated_at: new Date() });
      }
      return;
    }
    await linkWindowVisitsWithoutCoverageConfig(term, conn);
  } catch (err) {
    logger.warn(`[annual-prepay] scheduled service attach skipped: ${err.message}`);
  }
}

// `quietTransientExceptions` silences ONE bell — `stamp_raced_completion` —
// for the series generators (booking/estimate seeding and the completion-time
// auto-extend), which call this to stamp the row they just inserted. Those
// runs legitimately catch rows mid-flight, and that race IS self-healing:
// reconcilePendingWindowCompletions settles the completed visit's invoice or
// returns its slice as credit, so a bell per generated visit would bury the
// real exceptions without adding information.
//
// It deliberately does NOT silence `stamp_raced_cancel`. That one reports a
// PAID slot cancelled out from under the stamp, and nothing re-seeds it —
// reconcileCoveredTermsSweep only reconciles COMPLETED visits, so no sweep
// will ever notice. An operator has to schedule the replacement, and if this
// bell is suppressed the customer's paid schedule is permanently short and
// invisible to the office. Never widen this flag to cover it.
//
// Nothing about the STAMPING changes either way, and the warn-level log
// records every race.
// `notifyConn` is the transaction scope the operator exceptions wait on. It
// defaults to `conn`, and only differs for the series generators: they run
// their coverage QUERIES inside a SAVEPOINT (so a failure cannot poison the
// caller), but fileCoverageExceptionAfterCommit keys off the connection's
// executionPromise — and a savepoint's resolves on RELEASE, before the outer
// transaction commits. Filing against the savepoint would let a later
// rollback leave a false alert that then dedupes the retry's real one for
// seven days, which is the exact hazard the deferral exists to prevent.
async function applyPrepaidCoverageForTerm(
  term, conn = db, { quietTransientExceptions = false, notifyConn = null } = {},
) {
  const notifyScope = notifyConn || conn;
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
  // Stamp-time price check: see holdPriceDriftedRows. Only rows this pass
  // would newly stamp are judged (foreign-term / out-of-band-paid rows are
  // exempt, exactly as the loop below skips them).
  const { held: priceHeld, heldIds: priceHeldIds, guardedIds: priceGuardedIds } = await holdPriceDriftedRows(term, rows, conn, { skipRow: (r) => rowPrepaidElsewhere(term, r) });
  // Rows read as eligible whose stamp UPDATE then matched nothing — the
  // status moved in between (#3878 r5). Classified below by re-reading the
  // row: a never-ran status (cancelled / no_show / skipped) is a shortfall
  // the operator must hear about (the earlier coverage_shortfall check runs
  // on target dates and cannot see this race); a COMPLETED-in-between row
  // is a pending-window completion whose invoice may not exist yet when
  // reconcilePendingWindowCompletions runs right after this, so it files
  // its own exception (Codex r2 P1) — the daily sweep settles it, the alert
  // covers the window in which the visit could be paid twice.
  const unmatchedRowIds = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const status = String(row.status || '').toLowerCase();
    if (PREPAID_UPDATE_EXCLUDED_STATUSES.has(status)) continue;
    if (rowPrepaidElsewhere(term, row)) continue;

    // Repriced since the term was sold: never covered at the old price. The
    // slot stays unused (index still advances).
    if (priceHeldIds.has(String(row.id))) continue;

    const visitAmount = slices[index] ?? slices[0] ?? 0;
    const updates = {
      prepaid_amount: visitAmount,
      prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD,
      prepaid_note: `Annual prepaid ${coverageServiceType} (${index + 1} of ${coverageVisitCount})`,
      prepaid_at: row.prepaid_at || now,
    };
    if (cols.annual_prepay_term_id) updates.annual_prepay_term_id = term.id;
    if (cols.updated_at) updates.updated_at = now;

    // The status skip above read a pre-transaction row; re-assert it IN the
    // UPDATE so a visit cancelled between that read and this write (a
    // series cancel committing mid-activation, #3878 r5) is never stamped.
    // A NULL status is a live visit (service-cadence convention) — a bare
    // NOT IN would evaluate unknown and skip it (Codex r2 P1).
    let stampQuery = conn('scheduled_services')
      .where({ id: row.id })
      .where((q) => q.whereNull('status').orWhereNotIn('status', [...PREPAID_UPDATE_EXCLUDED_STATUSES]));
    // Atomic with the price decision: a baseline-carrying term stamps only the
    // price it just judged (see whereObservedPrice).
    if (priceGuardedIds.has(String(row.id))) stampQuery = whereObservedPrice(stampQuery, row);
    const updated = await stampQuery
      .update(updates)
      .returning(['id']);
    if (Array.isArray(updated) ? updated.length > 0 : updated) stampedCount++;
    else unmatchedRowIds.push(row.id);
  }

  let racedRowIds = [];
  let completedRaceIds = [];
  if (unmatchedRowIds.length > 0) {
    const current = await conn('scheduled_services').whereIn('id', unmatchedRowIds)
      .select('id', 'status', 'estimated_price', 'notes', 'annual_prepay_term_id', 'prepaid_method', 'prepaid_amount', 'scheduled_date', 'service_type');
    // A guarded row whose price moved after it was judged matched nothing:
    // re-judge it at its NEW price (held + flagged if that is a drift; a move
    // back to an allowed price is simply stamped by the next refresh).
    const observedById = new Map(rows.map((r) => [String(r.id), r]));
    const movedRows = current
      .filter((r) => priceGuardedIds.has(String(r.id))
        && !COVERAGE_EXCLUDED_STATUSES.has(String(r.status || '').toLowerCase())
        && String(r.status || '').toLowerCase() !== 'completed'
        && priceCents(r.estimated_price) !== priceCents(observedById.get(String(r.id))?.estimated_price))
      .map((r) => ({ ...observedById.get(String(r.id)), ...r }));
    if (movedRows.length) {
      const late = await holdPriceDriftedRows(term, movedRows, conn);
      priceHeld.push(...late.held);
    }
    const statusById = new Map(current.map((r) => [r.id, String(r.status || '').toLowerCase()]));
    racedRowIds = unmatchedRowIds.filter((id) => COVERAGE_EXCLUDED_STATUSES.has(statusById.get(id)) || !statusById.has(id));
    completedRaceIds = unmatchedRowIds.filter((id) => statusById.get(id) === 'completed');
  }
  if (completedRaceIds.length > 0) {
    logger.warn(`[annual-prepay] term ${term.id}: ${completedRaceIds.length} covered visit(s) completed while the prepaid stamp ran (${completedRaceIds.join(', ')}) — left unstamped for pending-window reconciliation`);
    if (!quietTransientExceptions) await fileCoverageExceptionAfterCommit(notifyScope, term, 'stamp_raced_completion',
      `${completedRaceIds.length} paid visit(s) completed while the annual prepay was being applied and are not yet marked as covered. If a completion invoice was issued for that visit, it bills the customer separately until the coverage sweep settles it — check the invoice and settle it as covered or void it.`);
  }
  if (racedRowIds.length > 0) {
    // Durable operator exception (Codex #3882 r1 P1): callers discard this
    // result, so the shortfall must be filed HERE. Same dedupe + bell as the
    // other coverage exceptions; the operator schedules the replacement
    // visit(s) — nothing is re-seeded automatically on a cancelled slot.
    // Filed after the caller's transaction commits (hook P1): a rollback must
    // not leave a false alert that also dedupes the retry's real one for 7d.
    logger.warn(`[annual-prepay] term ${term.id}: ${racedRowIds.length} covered visit(s) were cancelled while the prepaid stamp ran (${racedRowIds.join(', ')}) — ${stampedCount} of ${coverageVisitCount} sold visits stamped; needs replacement scheduling`);
    await fileCoverageExceptionAfterCommit(notifyScope, term, 'stamp_raced_cancel',
      `${racedRowIds.length} paid visit(s) were cancelled while the annual prepay was being applied, so only ${stampedCount} of ${coverageVisitCount} sold visits are covered on the calendar. Schedule the replacement visit(s) or adjust the term.`);
  }

  if (priceHeld.length > 0) await fileHeldPriceDriftAlerts(term, priceHeld, notifyScope);

  return {
    stampedCount,
    matchedCount: rows.length,
    expectedVisitCount: coverageVisitCount,
    perVisitAmount: slices[0] || 0,
    racedRowIds,
    priceHeldRowIds: priceHeld.map(({ row }) => row.id),
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
    // Stamp-time price check, completion side (#5387): a visit held out of the
    // stamp for a changed price stays held after it completes — settling its
    // open (newly priced) invoice as coverage, or crediting a slice for it,
    // would apply the OLD-price prepay to a visit the term never covered.
    // Price-based and recomputed here (a held visit leaves no marker), same
    // alert dedupe key as the stamp-time hold. A failed lookup throws into
    // this function's own catch: nothing is settled or credited (fail closed).
    const completedRows = rows.filter((r) => String(r.status || '').toLowerCase() === 'completed');
    const { held: driftHeld, heldIds: driftHeldIds } = await holdPriceDriftedRows(term, completedRows, conn, {
      includeCompleted: true, skipRow: (r) => rowPrepaidElsewhere(term, r),
    });
    if (driftHeld.length > 0) await fileHeldPriceDriftAlerts(term, driftHeld, conn);
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
      if (driftHeldIds.has(String(row.id))) continue;
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
          summary.failed = true;
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
        summary.failed = true;
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
        summary.failed = true;
        logger.warn(`[annual-prepay] pending-completion credit skipped for visit ${row.id}: ${err.message}`);
      }
    }
  } catch (err) {
    summary.failed = true;
    logger.warn(`[annual-prepay] pending-window completion reconcile skipped for term ${term?.id}: ${err.message}`);
  }
  // `failed` (set only on an error, never on a deliberately-unresolved
  // in-flight slice) lets a caller that must finish this work retry it.
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
// A callback never belongs to a term (coverageRowsForTerm excludes it), but
// before that exclusion a callback inside the window could be adopted into
// the selection: linked to the term and — if still pending — stamped
// prepaid. Dropping it from the selection alone leaves that legacy link and
// stamp behind: five allocations on a four-visit term, inflated
// prepaid-series totals, and resolveCallbackBilling reading a free callback
// as prepaid (GH Codex #4105 r2 P1). Every refresh clears both, in EVERY
// status — a callback's annual-prepay stamp is never billing truth, unlike a
// sold visit's completed stamp. An out-of-band cash/Zelle stamp on a callback
// is not ours to touch: keep the stamp, drop only the link. Best-effort,
// like attachScheduledServices — a miss self-heals on the next refresh.
async function detachCallbacksFromTerm(term, conn = db) {
  if (!term?.id) return 0;
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id || !cols.is_callback || !cols.service_type) return 0;
  try {
    const now = new Date();
    if (cols.prepaid_amount && cols.prepaid_method) {
      const stampClear = { prepaid_amount: null, prepaid_method: null };
      if (cols.prepaid_at) stampClear.prepaid_at = null;
      if (cols.prepaid_note) stampClear.prepaid_note = null;
      if (cols.updated_at) stampClear.updated_at = now;
      await conn('scheduled_services')
        .where({ annual_prepay_term_id: term.id, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD })
        .where(whereCallbackRow(cols))
        .update(stampClear);
    }
    const unlink = { annual_prepay_term_id: null };
    if (cols.updated_at) unlink.updated_at = now;
    const unlinked = await conn('scheduled_services')
      .where({ annual_prepay_term_id: term.id })
      .where(whereCallbackRow(cols))
      .update(unlink);
    const count = Array.isArray(unlinked) ? unlinked.length : Number(unlinked) || 0;
    if (count > 0) {
      logger.info(`[annual-prepay] term ${term.id}: detached ${count} callback visit(s) from coverage`);
    }
    return count;
  } catch (err) {
    logger.warn(`[annual-prepay] callback detach skipped for term ${term.id}: ${err.message}`);
    return 0;
  }
}

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
              wherePrepayInvoiceCollected(this);
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
              .orWhereIn('i.status', PREPAY_INVOICE_COLLECTED_STATUSES)
              .orWhereNotNull('i.paid_at');
          });
        });
      // P2-4 (owner ruling 2026-09-26): an UNPAID termite renewal
      // successor stays covered through its own 30-day payment grace —
      // termiteRenewalGraceDeadlineSql is the SAME cutoff the renewal-
      // charge job's grace-lapse pass voids on, so the two can never
      // disagree. Scoped tight on purpose: payment_pending status, a
      // termite renewal SUCCESSOR specifically (renewed_from_term_id NOT
      // NULL) and the termite marker (annual_plan_version NOT NULL) — a
      // non-termite payment_pending term, or an ORIGINAL (non-successor)
      // termite term still awaiting its first payment, never matches.
      // Once the lapse pass actually voids the invoice, `i.status`
      // flips to a cancelled shape and the whereRaw exclusion below
      // drops this row on its own — no separate revocation needed here.
      //
      // Codex #4971 pre-push P1: DATED only. Grace is a date-bounded
      // promise (30 days from the successor's start), never paid
      // coverage, so the date-less form — "which terms carry still-valid
      // PAID coverage, whatever the window" — never includes it. Every
      // date-less caller (card-expiry exemptions, the setup-fee and
      // cancellation / offboarding / lifecycle guards, the stamped-visit
      // and decided-lapse checks, the sweep's marker legs, …) means
      // paid-backed, and several read the term's FULL term_start/term_end
      // range: card-expiry exemptions used to treat a grace-only
      // successor's 30 days as a whole covered year across their 60-day
      // horizon. A dated caller still gets grace for that one day.
      if (coverageDate) {
        this.orWhere(function termiteRenewalGraceCovered() {
          whereTermiteRenewalInGrace(this, 't', coverageDate);
        });
      }
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

const MAX_RENEWAL_ANCESTRY_DEPTH = 100;

// Renewal successors intentionally do NOT copy source_estimate_id: doing so
// would make createTermForAnnualPrepay find and overwrite the original term.
// Recover the plan scope through the immutable renewed_from_term_id chain
// instead. Every hop is ownership-scoped; malformed ancestry is unusable.
// THE one lineage resolver (Codex #4971 round-3, item 8): renewal grace
// coverage (termiteGraceVisitScope), the lapse/decline retrieval guard
// (otherLiveTermiteCoverage), the renewal notice's protected property
// (planPropertyForTerm) and the portal card's property label
// (termPropertyLabelsForCustomer) all read a successor's plan identity
// through here. Returns null for a malformed chain — a hop owned by another
// customer, a cycle, two different estimates, a missing ancestor, or depth
// past MAX_RENEWAL_ANCESTRY_DEPTH — so every caller fails closed.
async function termiteRenewalScope(term, customerId, conn) {
  const termIds = new Set();
  const estimateIds = new Set();
  let current = term;
  for (let depth = 0; depth < MAX_RENEWAL_ANCESTRY_DEPTH; depth += 1) {
    if (!current?.id || String(current.customer_id) !== String(customerId)) return null;
    const currentId = String(current.id);
    if (termIds.has(currentId)) return null;
    termIds.add(currentId);
    if (current.source_estimate_id) estimateIds.add(String(current.source_estimate_id));
    if (estimateIds.size > 1) return null;
    if (!current.renewed_from_term_id) {
      const estimateId = [...estimateIds][0] || null;
      if (!estimateId) return { termIds, estimateId: null, propertyId: null };
      const estimate = await conn('estimates')
        .where({ id: estimateId, customer_id: customerId })
        .first('property_id');
      if (!estimate) return null;
      return { termIds, estimateId, propertyId: estimate.property_id ? String(estimate.property_id) : null };
    }
    current = await conn('annual_prepay_terms')
      .where({ id: current.renewed_from_term_id, customer_id: customerId })
      .first('id', 'customer_id', 'source_estimate_id', 'renewed_from_term_id');
    if (!current) return null;
  }
  return null;
}

async function termiteGraceVisitScope(scheduledService, conn) {
  let parent = null;
  if (scheduledService.recurring_parent_id) {
    parent = await conn('scheduled_services')
      .where({ id: scheduledService.recurring_parent_id, customer_id: scheduledService.customer_id })
      .first('annual_prepay_term_id', 'source_estimate_id', 'property_id');
    if (!parent) return null;
  }
  const values = (field) => [...new Set(
    [scheduledService[field], parent?.[field]].filter(Boolean).map(String),
  )];
  const termIds = values('annual_prepay_term_id');
  const estimateIds = values('source_estimate_id');
  const propertyIds = values('property_id');
  // A child can carry the successor while its recurring parent still
  // carries a predecessor, so multiple term IDs are validated against
  // one ancestry. Estimates/properties cannot legitimately differ.
  if (estimateIds.length > 1 || propertyIds.length > 1) return null;
  if (!termIds.length && !estimateIds.length && !propertyIds.length) return null;
  return { termIds, estimateId: estimateIds[0] || null, propertyId: propertyIds[0] || null };
}

async function graceTermMatchesVisit(term, visitScope, scheduledService, conn) {
  const termScope = await termiteRenewalScope(term, scheduledService.customer_id, conn);
  if (!termScope) return false;
  if (visitScope.termIds.length && !visitScope.termIds.every((id) => termScope.termIds.has(id))) return false;
  if (visitScope.estimateId && termScope.estimateId !== visitScope.estimateId) return false;
  if (visitScope.propertyId && termScope.propertyId !== visitScope.propertyId) return false;
  return !(term.coverage_service_type && scheduledService.service_type
    && !serviceMatchesCoverage(scheduledService, normalizeCoverageServiceType(term.coverage_service_type)));
}

// Codex round-7 P1: the UNSTAMPED half of termite grace coverage — see the
// call site's own doc in annualPrepayCoversVisit. Reuses coveredTermsAsOf
// (the SAME grace-aware query the mint/charge/lapse passes all key off),
// narrowed to the exact termiteRenewalGraceCovered shape (payment_pending,
// a renewal successor, still inside its own grace deadline as of THIS
// visit's date) so it can never match any of coveredTermsAsOf's OTHER
// covered shapes (a plain paid-pending term, a decided-and-paid term) —
// those already stamp normally via the ACTIVE_STATUSES attach step, so
// reaching them here would be redundant, not wrong, but the narrowing
// keeps this check legible as "grace, specifically". Fails closed (false)
// on any lookup error, matching every other non-strict path here.
async function termiteGraceCoversVisit(scheduledService, conn, { throwOnError = false } = {}) {
  // Scoped to a visit with NO prepay stamp at all — one that already
  // carries SOME prepaid_method (even a malformed/incomplete one) has a
  // stamp from a DIFFERENT coverage decision and must fall through to
  // that stamp's own validation in the caller, never be waved through by
  // an unrelated grace window (Codex round-7 self-review: caught the
  // regression this caused in annual-prepay-card-expiry-exempt and
  // annual-prepay-coverage-gate before it shipped). Checked here, not as
  // an `&&` at the call site, so annualPrepayCoversVisit gets one plain
  // `if (await termiteGraceCoversVisit(...))` — the cheapest call shape,
  // keeping that already-large function's own complexity at the ceiling
  // rather than over it.
  if (scheduledService.prepaid_method) return false;
  if (!scheduledService.customer_id) return false;
  const visitDate = dateOnly(scheduledService.scheduled_date) || dateOnly(scheduledService.completed_at);
  if (!visitDate) return false;
  try {
    // Codex #4971 round-4 (post-merge audit) P0: annualPrepayTableExists()
    // catches its own probe error and CACHES false — a transient DB failure
    // then reads as "table genuinely absent" forever (until the next cache
    // reset), which resolves this whole function to false and lets a strict
    // caller's charging guard bill a grace-covered visit instead of seeing
    // the failure. A strict caller must see the probe error itself, so it
    // propagates to the catch below and gets rethrown (same shape as the
    // stamped branch's own direct-probe fix a few hundred lines down). Only
    // non-strict callers keep the cached, fail-closed probe.
    if (throwOnError) {
      if (!(await conn.schema.hasTable('annual_prepay_terms'))) return false;
    } else if (!(await annualPrepayTableExists())) return false;
    // Resolve the visit's durable plan scope. A recurring child inherits the
    // root's links, but conflicting child/root evidence is ambiguous and must
    // never waive a charge. Property preference/profile rows are deliberately
    // absent: annual coverage belongs to the quoted property/term, not the
    // customer's primary address.
    const visitScope = await termiteGraceVisitScope(scheduledService, conn);
    if (!visitScope) return false;

    const terms = await coveredTermsAsOf(conn, visitDate)
      .where('t.customer_id', scheduledService.customer_id)
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .select('t.id', 't.customer_id', 't.source_estimate_id', 't.renewed_from_term_id', 't.coverage_service_type');
    const matches = [];
    for (const term of terms) {
      if (await graceTermMatchesVisit(term, visitScope, scheduledService, conn)) matches.push(term);
    }
    // Property-only linkage can match two concurrent plans at one site;
    // absence and ambiguity both fail closed rather than choosing `.first()`.
    return matches.length === 1;
  } catch (err) {
    // Codex round-7 P1 (2nd audit round): a strict caller (the extended-
    // completion charging guard, same contract as the stamp-based checks
    // below) needs an unverifiable grace lookup to REFUSE the charge, not
    // read as "no grace coverage, fall through to the stamp check" — which
    // for an unstamped visit resolves uncovered and would charge a visit
    // that may genuinely be in grace. Only a non-strict (billing-
    // suppression) caller may treat a lookup failure as "not covered".
    if (throwOnError) throw err;
    logger.warn(`[annual-prepay] termite grace-coverage check failed for scheduled service ${scheduledService.id}: ${err.message}`);
    return false;
  }
}

// Codex pre-push P1 (follows from the round-1 "decline before install"
// reversal): a decided-lapse term (status 'cancelled', renewal_decision
// 'cancel') that anchors to a LATER-completed installation must still get
// its coverage year seeded/attached/prepaid-stamped — the decline only
// refuses the FUTURE renewal, the coverage year already paid for is
// untouched. This is the SAME "is this decided-lapse term's coverage still
// live" test coveredTermsAsOf uses (paid invoice, not cancelled/refunded) —
// scoped to one row, reused rather than re-derived, so the anchor path can
// never disagree with the completion-billing gate about whether this term
// is covered. A void/refund 'cancelled' term (renewal_decision NULL) is
// never this shape and always returns false.
async function isPaidDecidedLapseTerm(term, conn = db) {
  if (!term?.id || term.status !== 'cancelled' || term.renewal_decision !== 'cancel') return false;
  return isCoveredTerm(term.id, conn);
}

// The same paid/not-refunded/not-disputed coverage test, for any term
// shape (no date window).
async function isCoveredTerm(termId, conn = db) {
  if (!termId) return false;
  const row = await coveredTermsAsOf(conn).where('t.id', termId).first('t.id');
  return !!row;
}

// Has this term's renewal been PROCESSED — a successor term minted from it
// (renewed_from_term_id)? A staff 'renew' decision with no successor yet is
// still supersedable by the customer's own online decline (Codex #4940 r4).
async function hasSuccessorTerm(termId, conn = db) {
  if (!termId) return false;
  const row = await conn('annual_prepay_terms').where({ renewed_from_term_id: termId }).first('id');
  return !!row;
}

// Pre-push audit P1 (slice 6a): a customer with several termite annual
// terms (one per property) needs each portal renewal card — and its decline
// confirmation — to name WHICH property it covers. Returns Map(termId ->
// { label, termTied }) for the given terms, OWNERSHIP-SCOPED to customerId
// at every hop:
// the term itself, its source estimate (e.customer_id), and the estimate's
// linked property (cp.customer_id) must all belong to that customer, so a
// mislinked estimate/property can never leak another account's address.
// Fallback chain per term: the estimate's quoted address SNAPSHOT
// (estimates.address — authoritative for what was quoted, per the estimates
// property-linkage migration; a linked customer_properties row is NOT, since
// syncPrimaryAddress rewrites a primary property when the customer moves)
// -> the linked customer_properties row, only for a legacy estimate with no
// snapshot -> the customer's own address.
// termTied is true only for the first two: the customer's own address says
// nothing about WHICH of several plans this is (Codex #4940 r7), so a
// multi-term caller must treat a profile-address label as unresolved.
// A term with none of those gets no entry (the caller shows no label).
function formatStructuredAddress(line1, line2, city, state, zip) {
  const street = [line1, line2].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean).join(', ');
  if (!street) return null;
  const stateZip = [state, zip].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean).join(' ');
  return [street, city == null ? '' : String(city).trim(), stateZip].filter(Boolean).join(', ');
}

async function termPropertyLabelsForCustomer(customerId, termIds, conn = db) {
  const ids = [...new Set((termIds || []).filter(Boolean))];
  const labels = new Map();
  if (!customerId || !ids.length) return labels;
  const rows = await conn('annual_prepay_terms as t')
    .leftJoin('estimates as e', function ownEstimate() {
      this.on('e.id', '=', 't.source_estimate_id').andOn('e.customer_id', '=', 't.customer_id');
    })
    .leftJoin('customer_properties as cp', function ownProperty() {
      this.on('cp.id', '=', 'e.property_id').andOn('cp.customer_id', '=', 't.customer_id');
    })
    .leftJoin('customers as c', 'c.id', 't.customer_id')
    .where('t.customer_id', customerId)
    .whereIn('t.id', ids)
    .select(
      't.id as term_id', 't.customer_id', 't.source_estimate_id', 't.renewed_from_term_id',
      'cp.address_line1 as cp_line1', 'cp.address_line2 as cp_line2', 'cp.city as cp_city', 'cp.state as cp_state', 'cp.zip as cp_zip',
      'e.address as estimate_address',
      'c.address_line1 as c_line1', 'c.address_line2 as c_line2', 'c.city as c_city', 'c.state as c_state', 'c.zip as c_zip',
    );
  for (const row of rows) {
    const termLabel = estimateLabelFromRow(row) || (await successorLineageLabel(row, customerId, conn));
    const label = termLabel || formatStructuredAddress(row.c_line1, row.c_line2, row.c_city, row.c_state, row.c_zip);
    if (label) labels.set(row.term_id, { label, termTied: !!termLabel });
  }
  return labels;
}

// The plan-tied half of a label: the estimate's quoted snapshot first, its
// linked (ownership-scoped) property only for a legacy snapshot-less
// estimate — see termPropertyLabelsForCustomer's doc.
function estimateLabelFromRow(row) {
  const estimateAddress = row.estimate_address == null ? '' : String(row.estimate_address).trim();
  return estimateAddress
    || formatStructuredAddress(row.cp_line1, row.cp_line2, row.cp_city, row.cp_state, row.cp_zip);
}

// Codex #4971 round-3 (item 8): a renewal SUCCESSOR carries no
// source_estimate_id, so the join above finds nothing for it — its label is
// its ROOT estimate's, reached through the shared lineage resolver
// (termiteRenewalScope — customer-scoped at every hop, null on a cycle or a
// foreign hop). The estimate and its property are re-checked against THIS
// customer exactly like the join above. Anything unresolved returns null,
// so the caller falls back to the customer address with termTied: false.
async function successorLineageLabel(row, customerId, conn) {
  if (row.source_estimate_id || !row.renewed_from_term_id) return null;
  const scope = await termiteRenewalScope({
    id: row.term_id, customer_id: row.customer_id, source_estimate_id: null, renewed_from_term_id: row.renewed_from_term_id,
  }, customerId, conn);
  if (!scope?.estimateId) return null;
  const root = await conn('estimates as e')
    .leftJoin('customer_properties as cp', function ownProperty() {
      this.on('cp.id', '=', 'e.property_id').andOn('cp.customer_id', '=', 'e.customer_id');
    })
    .where({ 'e.id': scope.estimateId, 'e.customer_id': customerId })
    .first(
      'e.address as estimate_address',
      'cp.address_line1 as cp_line1', 'cp.address_line2 as cp_line2', 'cp.city as cp_city', 'cp.state as cp_state', 'cp.zip as cp_zip',
    );
  return root ? estimateLabelFromRow(root) : null;
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
// Defense-in-depth for a STAMPED visit, against the term its stamp names:
// when the term declares a coverage service, the stamped visit must still be
// that service (coverage-selection cleanup is best-effort, so a stale stamp
// left on a dropped/re-typed service must not suppress). The same matcher
// that APPLIED the stamp gates it here. Legacy no-config terms (no
// coverage_service_type) never had a service to match, so skip the check.
// Codex #4971 pre-push P0: a renewal SUCCESSOR's stamp must also sit on a
// visit inside the successor's own plan scope (the same
// successorCoverageScope/rowInRenewalScope selection applied it) — an
// unresolved lineage never suppresses.
async function stampedTermStillCoversVisit(term, scheduledService, conn) {
  if (term.coverage_service_type
    && scheduledService.service_type
    && !serviceMatchesCoverage(scheduledService, normalizeCoverageServiceType(term.coverage_service_type))) {
    return false;
  }
  const scope = await successorCoverageScope(term, conn);
  return !scope || (scope.resolved && rowInRenewalScope(scheduledService, scope));
}

async function annualPrepayCoversVisit(scheduledService, conn = db, { throwOnError = false } = {}) {
  if (!scheduledService) return false;

  // Codex round-7 P1 (owner ruling 2026-09-26, P2-4): an UNPAID termite
  // renewal successor stays covered through its OWN GRACE_DAYS payment
  // window — coveredTermsAsOf's termiteRenewalGraceCovered branch already
  // recognizes this at the query level. But refreshTermSnapshot's
  // attach+stamp step (attachScheduledServices / applyPrepaidCoverageForTerm)
  // is ACTIVE_STATUSES-only, so a successor's own visits NEVER get
  // annual_prepay_term_id/prepaid_amount stamped while it sits
  // payment_pending — every check below REQUIRES that stamp (and the
  // prepaid_method gate right after this one), so without this a visit
  // completed during grace bills normally, directly contradicting the
  // grace-coverage promise. Checked FIRST, independently of any stamp:
  // does a payment_pending termite successor for this SAME customer,
  // still within its own grace window on this visit's date, cover this
  // service? If so, suppress billing even with no stamp at all — never
  // mutates the visit row itself (a full stamp still requires the
  // successor to actually activate; this is a read-only billing-time
  // recognition of the SAME window). termiteGraceCoversVisit itself scopes
  // to an unstamped visit (see its own comment) — never waves through a
  // visit that already carries some other, even malformed, prepay stamp.
  if (await termiteGraceCoversVisit(scheduledService, conn, { throwOnError })) return true;

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
      .first('t.id', 't.customer_id', 't.coverage_service_type', 't.source_estimate_id', 't.renewed_from_term_id');
    if (!term) return false;
    return stampedTermStillCoversVisit(term, scheduledService, conn);
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

// ADMIN-BUG-R18: an end-at-term decided lapse ("End of paid coverage", or a
// renewal-time lapse) is still paid coverage through term_end on the READ
// side (coveredTermsAsOf's lapsedRenewalStillInTerm). recordDecision flips
// the term to 'cancelled' the moment the decision is made, and the write
// side used to stop at ACTIVE_STATUSES right there: a hand-added
// replacement was never stamped prepaid (completion billed it again), and
// a skipped kept visit was never replaced (paid for four, got three). An
// end_now_refund lapse pulled every visit and owes the unused value back —
// it is never touched.
function isEndAtTermLapseInWindow(term, today = etDateString()) {
  const termEnd = dateOnly(term?.term_end);
  return term?.status === 'cancelled'
    && term.renewal_decision === 'cancel'
    && term.cancel_disposition === 'end_at_term'
    && !!termEnd && termEnd >= today;
}

// Keep an end-at-term lapse's paid visits owed through term_end. A per-edit
// refresh only attaches and stamps visits that exist; the nightly sweep
// (reseed) also replaces a skipped one. Either re-decides under locks, in
// one transaction with its writes:
//   - the prepay invoice FOR SHARE, then the paid-coverage check: a dispute
//     or refund rewriting that invoice waits for this transaction or is
//     seen by the check, so stamps are never handed back over contested
//     money (a dispute clears a decided lapse's stamps through that gate);
//   - the term re-read: the disposition may have moved to end_now_refund
//     since the caller read it;
//   - no open end-now Cancel plan run for the customer: one that failed
//     between pulling the visits and recording the disposition leaves the
//     term end_at_term with every visit gone (hasOpenEndNowCancellation);
//   - reseed only: Cancel plan's commit key, try-held — an end-now commit
//     pulls every visit BEFORE it records the disposition, and a reseed
//     interleaved with it would recreate a pulled visit. A busy key skips
//     the term until the next sweep. Attach and stamp create nothing, so
//     the per-edit path needs no key.
async function keepEndAtTermLapseCoverage(termOrId, conn = db, { reseed = false, today = etDateString() } = {}) {
  const termId = typeof termOrId === 'object' ? termOrId?.id : termOrId;
  if (!termId) return { skipped: 'no_term' };
  const run = async (t) => {
    const peek = typeof termOrId === 'object' ? termOrId : await t('annual_prepay_terms').where({ id: termId }).first();
    if (!peek) return { skipped: 'no_term' };
    if (reseed) {
      const { tryHoldCancelCommitLockForTransaction } = require('./admin-cancellation');
      if (!(await tryHoldCancelCommitLockForTransaction(t, peek.customer_id))) return { skipped: 'cancel_commit_in_progress' };
    }
    if (peek.prepay_invoice_id) {
      await t('invoices').where({ id: peek.prepay_invoice_id }).forShare().first('id');
    }
    const term = await t('annual_prepay_terms').where({ id: termId }).first();
    if (!isEndAtTermLapseInWindow(term, today)) return { skipped: 'not_end_at_term_lapse' };
    const { hasOpenEndNowCancellation } = require('./admin-cancellation');
    if (await hasOpenEndNowCancellation(term.customer_id, t)) return { skipped: 'end_now_cancellation_open' };
    if (!(await coveredTermsAsOf(t, today).where('t.id', term.id).first('t.id'))) return { skipped: 'not_paid_coverage' };
    const termStart = dateOnly(term.term_start);
    const termEnd = dateOnly(term.term_end);
    let windowEnd = termEnd;
    let createdCount = 0;
    let unseededPastDates = [];
    if (reseed) {
      // Never a replacement dated in the past (a visit skipped on its day
      // regenerates that day): it could not be serviced, and it would fill
      // the slot on every later sweep. The office books those with the
      // customer — a hand-booked visit is stamped by the next refresh.
      const ensured = await ensureCoverageRowsForTerm({ ...term, term_start: termStart, term_end: termEnd, coverage_cadence: inferCoverageCadence(term) }, t, { seedNotBefore: today, gapFillOnly: true });
      if (ensured?.effectiveTermEnd) windowEnd = ensured.effectiveTermEnd;
      createdCount = ensured?.createdCount || 0;
      unseededPastDates = ensured?.unseededPastDates || [];
    }
    await attachScheduledServices({ ...term, term_start: termStart, term_end: windowEnd }, t);
    await applyPrepaidCoverageForTerm({ ...term, term_start: termStart, term_end: windowEnd }, t);
    if (windowEnd !== termEnd) await syncCustomerRenewalDate(term.customer_id, windowEnd, t);
    // Attach and stamp swallow their own SQL errors, and a failed statement
    // aborts this transaction — its COMMIT would then quietly roll back
    // while the caller counts the visits stamped. This probe fails in an
    // aborted transaction, so the failure reaches the caller instead.
    await t.raw('select 1');
    if (unseededPastDates.length) {
      await fileCoverageException(term, 'lapse_replacement_unscheduled',
        `A paid visit${unseededPastDates.length > 1 ? 's' : ''} on this end-of-coverage plan (${unseededPastDates.join(', ')}) was skipped and its date has passed. Book ${unseededPastDates.length > 1 ? 'replacements' : 'a replacement'} with the customer before coverage ends ${windowEnd} — the plan is paid through then.`,
        { title: 'Annual prepay: a paid visit needs a replacement booked' });
    }
    return { kept: true, createdCount, windowEnd, unseededPastDates };
  };
  return conn.isTransaction ? run(conn) : conn.transaction(run);
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
  // Every refreshed term that could ever have attached or stamped, not only
  // ACTIVE ones (GH Codex #4105 r4 P1): a renewed / switch_plan /
  // decided-lapse term can still be paid coverage (coveredTermsAsOf), and
  // its legacy callback stamp would otherwise stay. A payment_pending term
  // has never attached or stamped — nothing to detach, so it is skipped.
  if (term.status !== PAYMENT_PENDING_STATUS) {
    await detachCallbacksFromTerm(term, conn);
  }
  // A decided-lapse term (status 'cancelled', renewal_decision 'cancel') is
  // still a PAID coverage year through term_end — including a termite
  // annual plan the customer declined online (#4940), whose decline goes
  // through recordDecision / supersedeRenewWithCustomerCancel and so is
  // recorded cancel_disposition 'end_at_term'. ONE mechanism keeps its
  // visits: the ADMIN-BUG-R18 end-at-term upkeep below
  // (isEndAtTermLapseInWindow → keepEndAtTermLapseCoverage — attach +
  // stamp here under the paid-coverage / dispute / end-now guards, and the
  // nightly sweep replaces a skipped visit). A void/refund 'cancelled' row
  // (renewal_decision NULL) or an end_now_refund lapse is never touched.
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
  } else if (isEndAtTermLapseInWindow(term)) {
    // Attach + stamp only; a skipped visit is replaced by the nightly
    // sweep (keepEndAtTermLapseCoverage).
    const kept = await keepEndAtTermLapseCoverage(term, conn);
    if (kept?.windowEnd) windowEnd = kept.windowEnd;
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

  // ADMIN-BUG-R18: plus end-at-term lapses still inside their window — they
  // keep their paid visits stamped (isEndAtTermLapseInWindow). A failed
  // column probe leaves lapses out of this refresh (the nightly sweep
  // reaches them from each term's own row).
  let lapseUpkeep = false;
  try {
    lapseUpkeep = await cancelDispositionSupported();
  } catch (err) {
    logger.warn(`[annual-prepay] cancel_disposition probe failed — end-at-term lapses skipped this refresh for ${customerId}: ${err.message}`);
  }
  const terms = await conn('annual_prepay_terms')
    .where({ customer_id: customerId })
    .where(function liveOrEndAtTermLapse() {
      this.whereIn('status', ACTIVE_STATUSES);
      if (lapseUpkeep) {
        this.orWhere(function endAtTermLapseInWindow() {
          this.where({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' })
            .andWhere('term_end', '>=', etDateString());
        });
      }
    })
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

// Move 14 (docs/annual-prepay-term-states.md): the PARENT's renewal
// decision is recorded 'renew' the moment its successor's own renewal
// invoice is genuinely paid — deliberately NOT at mint (P2-1): a minted
// successor is only a PROPOSED renewal, and an unpaid one can still lapse
// (termite-annual-renewal-charge.js's grace pass), so deciding 'renew'
// before that is known would leave a lapsed-and-cancelled successor
// sitting behind a parent already marked 'renewed'. Reuses the canonical
// recordDecision('renew') writer (the SAME code path an operator's manual
// "renew" click uses — move 6) rather than a parallel status write; its
// own `whereIn(ACTIVE_STATUSES) AND renewal_decision IS NULL` guard makes
// this idempotent no matter how many times invoice-payment sync re-fires
// for the same successor (retries, a replayed webhook, the daily
// reconcile sweep). Best-effort: a miss here self-heals on the NEXT sync
// of this same successor invoice (every one of them re-enters the
// pending→active / cancelled→active branches below).
async function stampParentRenewedForSuccessor(successorTerm, contextLabel, conn = db) {
  if (!successorTerm?.renewed_from_term_id) return;
  // Codex round-2 P1: a SAVEPOINT on the caller's own transaction — the
  // SAME pattern reverseWaveguardExtensionCredits uses (see its own
  // comment above). Running this write through the GLOBAL db handle while
  // the successor's own activation held an outer transaction let the
  // parent stamp commit BEFORE the successor's flip, or survive an outer
  // rollback entirely (Codex round-2 finding). conn.transaction() on a
  // knex trx is a savepoint: a failure here rolls back to it and the
  // caller's transaction (the successor's own flip) stays healthy.
  try {
    await recordParentRenewedIfEligible({ successorId: successorTerm.id, parentTermId: successorTerm.renewed_from_term_id }, conn);
  } catch (err) {
    logger.warn(`[annual-prepay] parent renewed-stamp (${contextLabel}) skipped for successor ${successorTerm.id}: ${err.message}`);
  }
}

// Codex #4971 r6 P1 — the ONE automatic "record the parent renewed" write
// (the paid sync's hook above and reconcileParentRenewedStamps' backstop).
// A parent refund commits its ledger stamp before its separate term-cancel
// sync runs; a successor that settles in that gap used to stamp the
// still-active parent 'renewed' — and a renewed parent is invisible to the
// late-paid alert (leg 7e), so the refund-or-honor alert was lost. Under the
// parent's decision gate (taken first; re-entrant), the parent is re-checked
// with the charge path's own allow-list (resolveParentEligibility: a live or
// renewing status, and its invoice paid and NOT revoked on the payments
// ledger — chokepoint A); an ineligible parent is left undecided for leg 7e.
// A staff "renew" (the admin decide route) is a human decision and does not
// come through here. Runs in its own transaction, or a savepoint on the
// caller's (the successor's activation), so a failure never takes that down.
//
// Codex #4971 pre-push P1: the SUCCESSOR's payment is the other half of the
// evidence — a successor refunded or dispute-suspended between the caller's
// read and the gate must not record the parent renewed either. Both terms'
// keys are gated (sorted; re-entrant), and under them the successor is
// re-read before the parent, through the ONE shared "its payment backs the
// renewal" predicate (termite-annual-renewal-charge.js
// successorPaymentBacksRenewal — the late-paid alert reads the same one).
async function recordParentRenewedIfEligible({ successorId, parentTermId }, conn = db) {
  const work = async (t) => {
    await acquireTermiteGateAtEntry(t, { termIds: [parentTermId, successorId] });
    const Charge = require('./termite-annual-renewal-charge')._private;
    const successor = await t('annual_prepay_terms').where({ id: successorId }).first();
    if (!(await Charge.successorPaymentBacksRenewal(t, successor))) return null;
    // Codex #4971 r17 P2 (finding 5): once the deleted-account conflict
    // below has actually told staff, never re-run that check (or re-ring
    // its bell) for this successor again — see the marker's own doc on the
    // column write just below for why this exists at all.
    if (Object.prototype.hasOwnProperty.call(successor, 'renewal_parent_deleted_conflict_belled_at')
      && successor.renewal_parent_deleted_conflict_belled_at) {
      return null;
    }
    // Codex #4971 r16 P1 (finding 5, DELETION (b)): a deleted account is a
    // late-payment CONFLICT, never a silent renewal — the SAME refund-or-
    // honor staff alert a parent that changed any other way gets
    // (paid_after_parent_ended), not a fact resolveParentEligibility itself
    // tracks (it never reads customers.deleted_at at all). An ACH successor
    // can settle days after its submission — long enough for the account to
    // be deleted in between — and this stamp used to run with no deletion
    // check whatsoever, silently recording the parent 'renewed' under a
    // deleted account with no alert. Gated the SAME way every other
    // deletion-sensitive write now is (acquireTermiteGateAtEntry above takes
    // the SAME advisory key withCustomerDeletionGate holds for every one of
    // the customer's renewable termite parent terms), so this either waits
    // behind an in-flight deletion or is seen by it once it commits.
    const deleted = await Charge.customerDeletedRefusal(t, successor);
    if (deleted) {
      const bell = await Charge.ringRenewalBell(
        successor,
        'paid_after_parent_ended',
        "the customer's account was deleted before the renewal payment settled",
      );
      // Codex #4971 r17 P2 (finding 5): a bell that actually persisted
      // (fresh or deduped — either way staff has been told) is the trigger
      // to exclude this row from reconcileParentRenewedStamps' bounded scan
      // for good — otherwise the parent stays ACTIVE_STATUSES with
      // renewal_decision still null forever, and that scan's own LIMIT page
      // re-selects this SAME row on every tick, starving any newer
      // conflict behind it from ever being reached. The column is written
      // only where the row shows it exists (this migration ships in the
      // same PR) — a missing column must never fail this activation, same
      // convention as renewal_late_paid_belled_at.
      if (bell && Object.prototype.hasOwnProperty.call(successor, 'renewal_parent_deleted_conflict_belled_at')) {
        await t('annual_prepay_terms').where({ id: successor.id })
          .whereNull('renewal_parent_deleted_conflict_belled_at')
          .update({ renewal_parent_deleted_conflict_belled_at: new Date() });
      }
      return null;
    }
    const parent = await t('annual_prepay_terms').where({ id: parentTermId }).first();
    // Codex #4971 r18 P1: the SAME successor-specific predicate the charge
    // and withdrawal paths use — a parent whose term_end moved since the
    // mint (parent_term_moved) must not be stamped renewed against the
    // stale successor window; the late-paid alert handles that conflict.
    if (!(await Charge.parentRefusalForSuccessor(t, successor, parent)).eligible) return null;
    return recordDecision({ termId: parentTermId, action: 'renew', conn: t });
  };
  return typeof conn.transaction === 'function' ? conn.transaction(work) : work(conn);
}

// Codex round-2 P1 (backstop): stampParentRenewedForSuccessor's own
// try/catch is deliberately best-effort — a genuine failure there is
// swallowed to protect the successor's own activation, so nothing else
// ever retries it (the pending→active branch above only fires ONCE per
// successor, on the exact tick its status flips). This reconcile leg finds
// any ACTIVE, PAID termite renewal successor whose PARENT is still
// undecided and completes the stamp — idempotent via recordDecision's own
// `whereIn(ACTIVE_STATUSES) AND renewal_decision IS NULL` guard, so it is
// always safe to re-run.
async function reconcileParentRenewedStamps({ conn = db, limit = 200 } = {}) {
  const summary = { scanned: 0, stamped: 0 };
  if (!(await annualPrepayTableExists())) return summary;
  let candidates = [];
  try {
    // Codex #4971 round-3 P1 (item 3): a paid-LOOKING successor invoice is
    // not proof — a full refund lands on the payments ledger before (or
    // without) the successor's own cancel sync, leaving the successor
    // 'active' with paid_at still set. The SAME settled-and-not-revoked
    // predicate the charge path's parent check reads
    // (termite-annual-renewal-charge.js whereInvoiceSettledNotRevoked —
    // chokepoint A) gates the renew stamp, so returned money never records
    // the parent 'renewed'. The parent must also still be in a status
    // recordDecision can move (ACTIVE_STATUSES): an undecided parent that is
    // already cancelled/payment_pending would guard-miss every tick and pin
    // this bounded page forever.
    // Codex #4971 r6 P1: the PARENT side reads the same chokepoint-A
    // predicate — a parent whose own prepay invoice is revoked on the ledger
    // is never offered to the renew stamp (recordParentRenewedIfEligible
    // re-checks it per row, under the gate, with the JS twin).
    // Codex #4971 r8/pre-push: the successor side is the shared SQL twin
    // (whereSuccessorPaymentBacksRenewal: a live or paid decided-lapse
    // shape, its invoice settled and not revoked).
    const { whereInvoiceSettledNotRevoked, whereSuccessorPaymentBacksRenewal } = require('./termite-annual-renewal-charge')._private;
    candidates = await whereSuccessorPaymentBacksRenewal(
      conn('annual_prepay_terms as s')
        .join('annual_prepay_terms as p', 'p.id', 's.renewed_from_term_id')
        .join('invoices as i', 'i.id', 's.prepay_invoice_id')
        .leftJoin('invoices as pi', 'pi.id', 'p.prepay_invoice_id')
        .whereNotNull('s.renewed_from_term_id')
        .whereIn('p.status', ACTIVE_STATUSES)
        .whereNull('p.renewal_decision')
        // Codex #4971 r17 P2 (finding 5): a successor whose deleted-account
        // conflict already told staff (renewal_parent_deleted_conflict_
        // belled_at) is excluded here directly — its parent never leaves
        // ACTIVE_STATUSES/renewal_decision-null on its own, so without this
        // the SAME row pinned this bounded page forever, starving any newer
        // conflict behind it. A human's own later decision on the parent
        // still moves it out of ACTIVE_STATUSES/renewal_decision-null
        // regardless of this stamp.
        .whereNull('s.renewal_parent_deleted_conflict_belled_at')
        // Codex #4971 r23 P2: a parent whose window was moved after the
        // mint is a TERMINAL conflict here — recordParentRenewedIfEligible
        // refuses it as parent_term_moved every pass, and the late-paid
        // bell (term_window_changed_at) owns it. Excluded in SQL so such
        // rows cannot fill this bounded page and starve valid stamps.
        .whereRaw('s.term_start = p.term_end + 1')
        .where(function parentInvoiceSettled() {
          this.whereNull('p.prepay_invoice_id').orWhere(function settled() { whereInvoiceSettledNotRevoked(this, 'pi'); });
        }),
      's',
      'i',
    )
      .select('s.id as successor_id', 's.renewed_from_term_id as parent_id')
      .limit(limit);
  } catch (err) {
    logger.warn(`[annual-prepay] parent-renewed reconcile scan failed: ${err.message}`);
    return summary;
  }
  summary.scanned = candidates.length;
  for (const row of candidates) {
    try {
      const decided = await recordParentRenewedIfEligible({ successorId: row.successor_id, parentTermId: row.parent_id }, conn);
      if (decided) summary.stamped += 1;
    } catch (err) {
      logger.warn(`[annual-prepay] parent-renewed reconcile failed for successor ${row.successor_id}: ${err.message}`);
    }
  }
  return summary;
}

// Canonical cancel-with-restorations pipeline (lifted out of
// syncTermForInvoicePayment's cancel branch — ADMIN-BUG-R16/R17 direction:
// every writer that cancels an annual-prepay term must run through here, not
// a raw status write). Refuses a DECIDED term (renewal_decision set) — a
// renewal-lapse keeps its paid window; whereNull leaves `updated` undefined
// and the caller sees null back. On success: clears the per-visit prepaid
// stamps, reopens any invoice this term settled as non-cash coverage,
// reverses the pending-window/WaveGuard-extension credits it issued, resets
// customers.billing_mode to the recorded prior mode, and restores any
// switch-superseded per-application invoice / retired setup-fee claim. The
// flip and every restoration commit TOGETHER (codex #3591 r53): an
// autocommitted flip beside a failed restore would strand the claim forever
// (a later sync excludes cancelled terms). `throwOnError` is opt-in
// (default false, matching this pipeline's original void/refund-sync
// behavior) — a caller that must never leave a half-cancelled term (e.g. an
// explicit operator action removing the flag) passes true so a stamp-clear
// or billing_mode-reset failure rolls the whole cancel back instead of
// silently completing it.
async function cancelTermWithRestorations(termId, conn = db, { throwOnError = false } = {}) {
  const runCancel = async (t) => {
    const [updated] = await t('annual_prepay_terms')
      .where({ id: termId })
      .whereNull('renewal_decision')
      .update({ status: 'cancelled', updated_at: new Date() })
      .returning('*');
    if (updated && updated.status === 'cancelled') {
      // Lock order (deadlock guard, guards round 1): the accept transaction
      // locks the CUSTOMER at entry, before the extension's scheduled_services
      // family lock — while this leg would otherwise take scheduled_services
      // locks (the stamp clears below) first and the customer (credit
      // reversals) last. Same order both sides or a concurrent accept +
      // refund for one customer can deadlock. On autocommit (conn === db)
      // every statement is its own transaction and no multi-statement order
      // exists to invert.
      if (t.isTransaction && updated.customer_id) {
        await t('customers').where({ id: updated.customer_id }).forUpdate().first('id');
      }
      await clearPrepaidStampsForTerm(updated.id, t, { throwOnError });
      // Also reopen any per-visit invoices this term settled as NON-CASH coverage
      // (status 'prepaid', stamped with this term) — the prepay is gone, so the
      // covered work is owed again. Mirrors the stamp clear; best-effort (never
      // blocks the cancel), and never reopens a cash-paid invoice.
      try {
        // strict under throwOnError: a per-invoice reopen failure throws
        // (ADMIN-BUG-R17-FINDING-2) instead of being logged inside the
        // helper, so an explicit operator cancel never commits with an
        // invoice still covered by the dead term.
        await require('./invoice').reopenAnnualPrepayCoveredInvoicesForTerm(updated.id, t, { strict: throwOnError });
      } catch (err) {
        if (throwOnError) throw err;
        logger.warn(`[annual-prepay] invoice coverage reopen skipped for term ${updated.id}: ${err.message}`);
      }
      // And claw back the pending-window completion credits this term
      // issued — a full cancel would otherwise refund those slices twice
      // (once inside the cancel, once as kept credit).
      await reversePendingWindowCompletionCredits(updated, t);
      // Same double-pay shape for the WaveGuard tier-extension credit: the
      // cancel returns the prepaid dollars the discounted allocation was
      // carved from, so the extension's prepaid-difference grant reverses
      // with it.
      await reverseWaveguardExtensionCredits(updated, t);
      // Coverage is gone — return the customer to a billable mode (the
      // monthly cron skips 'annual_prepay' outright; see GUARD 3b).
      await resetBillingModeAfterTermCancel(updated, t, { throwOnError });
      // An ON-SITE SWITCH retired the accept-minted per-application invoice
      // when this prepay was created; with the prepay dead that AR (setup
      // fee included) must come back, or it is silently gone forever —
      // nothing else ever re-mints it. Marker-keyed and idempotent;
      // best-effort (never blocks the cancel).
      if (updated.prepay_invoice_id) {
        try {
          await require('./invoice').restoreSwitchSupersededInvoicesForPrepay(updated.prepay_invoice_id, t);
        } catch (err) {
          // The markers are durable, so this is recoverable — but only by a
          // human who knows: the cancel succeeded and the superseded
          // per-application AR is still missing. ERROR (Sentry-visible),
          // with the fix spelled out (Codex on-site-switch P0 r9: a warn
          // here was a permanent silent AR loss).
          logger.error(`[annual-prepay] FIX: switch-superseded restore FAILED for term ${updated.id} (prepay invoice ${updated.prepay_invoice_id}): ${err.message}. The customer's per-application invoice is still void — re-run POST /admin/schedule/<visitId>/prepay-switch/undo or rebuild it from Invoices.`);
        }
        // A DIRECT rodent series' setup rode this prepay as its own line and
        // the mint retired the parent's per-application claim; the fee is
        // owed again now (codex #3591 r34 P1). Record-keyed and one-shot.
        // PROPAGATES on failure (codex #3591 r46 local P0): the term flip
        // and this restore commit TOGETHER — a swallowed error left the
        // cancelled term unselectable by any later sync, the claim record
        // unused, and the fee cleared forever. A throw rolls the whole
        // cancel back and the caller can retry.
        await require('./invoice').restoreRetiredSetupFeeClaimForPrepay(updated.prepay_invoice_id, t, { sourceEstimateId: updated.source_estimate_id || null, customerId: updated.customer_id || null, coverageServiceType: updated.coverage_service_type || null });
      }
    }
    return updated || null;
  };
  // Chokepoint B (Codex #4971 round-3 P1 / pre-push lock order): when this
  // opens its OWN transaction it is the writer's entry point, so the gate is
  // its first lock (acquireTermiteGateAtEntry — before the term, customer,
  // stamp and credit writes below). A caller passing its own transaction
  // took the gate at ITS entry (voidInvoice's sync runs here on the root
  // handle; admin-invoices' remove-flag route acquires it first thing).
  const cancelled = await (typeof conn.transaction === 'function' && !conn.isTransaction
    ? conn.transaction(async (t) => {
      await acquireTermiteGateAtEntry(t, { termIds: [termId] });
      return runCancel(t);
    })
    : runCancel(conn));
  // Synchronous withdrawal (owner ruling 2026-09-28): a termite parent
  // cancelled by a refund / void of its own invoice no longer backs its
  // unpaid renewal — withdraw it right after this commit.
  if (cancelled && cancelled.annual_plan_version) {
    await require('./termite-annual-renewal-charge').afterParentChange(conn, termId, 'the prior term was cancelled (its invoice refunded or voided)');
  }
  return cancelled;
}

// Move 15 (docs/annual-prepay-term-states.md): a payment_pending term the
// customer already DECLINED online (renewal_decision 'cancel', recorded
// without a status change) whose prepay invoice resolves becomes the
// decided-lapse shape — never 'active', so it never renews:
//   - paid: covered through term_end by coveredTermsAsOf's decided-lapse
//     branch; the paid follow-through (attach + stamp through the end-at-term
//     upkeep, pending-window reconcile, dispute recovery) runs as it would
//     for an activated term — the billing-mode stamp only while the term
//     covers today (paid after term_end: the mode is left as it was);
//   - voided / refunded: nothing was ever covered — it simply leaves the
//     pending rails.
// Kept out of syncTermForInvoicePayment's own loop (which only walks
// undecided terms), so that loop's activation/cancel moves stay the
// undecided ones they always were.
async function settleDecidedPendingTerms(decided, nextStatus, conn) {
  if (!decided.length || (nextStatus !== 'active' && nextStatus !== 'cancelled')) return [];
  const settled = [];
  for (const term of decided) {
    const lapse = await settleDecidedPendingTerm(term, nextStatus, conn);
    if (!lapse) continue;
    settled.push(nextStatus === 'active' ? await followThroughPaidDecidedLapse(lapse, conn) : lapse);
  }
  return settled;
}

// One decided pending term's flip. Codex #4971 r8 P2: a renewal SUCCESSOR
// paid in this shape still proves its parent renewed, so the paid flip
// stamps the parent exactly like the activation branches — the renewal
// gate (parent + successor keys) first when this is its own transaction,
// and the stamp on the same transaction / savepoint as the flip. Anything
// else (not paid, or not a successor) keeps its plain conditional update.
async function settleDecidedPendingTerm(term, nextStatus, conn) {
  const { id } = term;
  const paidSuccessor = nextStatus === 'active' && Boolean(term.renewed_from_term_id);
  const flip = async (t) => {
    if (paidSuccessor && t !== conn) await acquireTermiteGateAtEntry(t, { termIds: renewalGateTermIds(term) });
    const [lapse] = await t('annual_prepay_terms')
      .where({ id, status: PAYMENT_PENDING_STATUS, renewal_decision: 'cancel' })
      .update({ status: 'cancelled', updated_at: new Date() })
      .returning('*');
    if (lapse && paidSuccessor) await stampParentRenewedForSuccessor(lapse, 'decided pending->paid', t);
    return lapse;
  };
  const ownTransaction = paidSuccessor && typeof conn.transaction === 'function' && !conn.isTransaction;
  const lapse = ownTransaction ? await conn.transaction(flip) : await flip(conn);
  // Codex #4971 pre-push P1: the same paid hook as the pending -> active
  // branch, after the flip committed (a caller's transaction is left to
  // legs 7d / 7e, as there) — ends the write-ahead charge outcome, and a
  // renewal paid behind a parent that no longer authorizes it gets its one
  // refund-or-honor alert here too, never only from the backstop.
  if (lapse && paidSuccessor) await require('./termite-annual-renewal-charge').onRenewalSuccessorPaid(lapse, conn);
  return lapse;
}

// Paid coverage live TODAY (billing's own test, dated) — the condition for
// stamping billing_mode 'annual_prepay' on a path whose coverage year may
// already have ended (#4940 pre-push P1s): on expired coverage the stamp is
// the nothing-bills limbo (the monthly cron skips the mode).
async function termCoversToday(termId, conn) {
  return !!(await coveredTermsAsOf(conn, etDateString()).where('t.id', termId).first('t.id'));
}

// The pending -> active stamp, skipped when the paid year has already ENDED
// (#4940 pre-push P1: an installation anchor can move a pending term to an
// expired year before the late payment lands) — the stamp there is the
// nothing-bills limbo. A not-yet-started year keeps its stamp, as before.
async function stampUnlessYearEnded(term, conn) {
  if (dateOnly(term.term_end) < etDateString()) return;
  await stampAnnualPrepayBillingMode(term.customer_id, conn, term.id);
}

const PAID_LAPSE_RECONCILED_ACTION = 'annual_prepay_paid_lapse_reconciled';
// One row per term, re-dated on every retry attempt (Codex #4940 r12 P2): the
// retry leg rotates least-recently-attempted first, never-attempted ahead.
const PAID_LAPSE_RECONCILE_ATTEMPT_ACTION = 'annual_prepay_paid_lapse_reconcile_attempt';

// Move 15's historical reconcile (#4940 pre-push P1): settle / credit the
// visits billed per application before the late annual payment. Runs
// whenever the term is PAID (isCoveredTerm — no date window, so an expired
// year still counts), never gated on today's coverage, and records
// PAID_LAPSE_RECONCILED_ACTION only once a run completes with no error. The
// covered-terms sweep retries unmarked ones (retryPaidLapseReconciles).
// Idempotent: settled invoices are skipped (annual_prepay_covered_term_id)
// and credits dedupe on their ledger marker under the customer lock.
//
// Codex #4940 r12 P1: an in-window visit still non-terminal when the late
// payment lands (paid after term_end) must be stamped prepaid too, or its
// later completion bills separately — the end-at-term upkeep
// (keepEndAtTermLapseCoverage) stamps it, evaluated as of the year's own
// last day once that day has passed (its window and paid checks are dated).
// Anything but a kept result withholds the marker, so the sweep retries.
async function reconcilePaidDecidedLapse(term, conn) {
  if (!(await isCoveredTerm(term.id, conn))) return false;
  const asOf = [etDateString(), dateOnly(term.term_end)].sort()[0];
  const kept = await keepEndAtTermLapseCoverage(term.id, conn, { today: asOf });
  if (!kept?.kept) return false;
  const summary = await reconcilePendingWindowCompletions(term, conn);
  if (summary.failed) return false;
  await conn('activity_log').insert({
    customer_id: term.customer_id,
    action: PAID_LAPSE_RECONCILED_ACTION,
    description: 'Annual prepay paid after the online renewal decline: visits billed before the payment reconciled.',
    metadata: { term_id: term.id, settled: summary.settled, credited: summary.credited },
  });
  return true;
}

// The retry leg: paid, portal-declined-while-UNPAID terms (move 15 — the
// decline row carries unpaid) with no completion marker, expired or not.
// Bounded; least-recently-attempted first (the attempt row's created_at,
// never-attempted first), then oldest end, so a term that keeps failing
// rotates instead of starving the others.
async function retryPaidLapseReconciles(conn = db, limit = 50) {
  let done = 0;
  try {
    const lastAttempt = conn('activity_log')
      .where('action', PAID_LAPSE_RECONCILE_ATTEMPT_ACTION)
      .groupByRaw("metadata->>'term_id'")
      .select(conn.raw("metadata->>'term_id' as term_id"), conn.raw('max(created_at) as attempted_at'))
      .as('att');
    const terms = await coveredTermsAsOf(conn, null)
      .leftJoin(lastAttempt, 'att.term_id', conn.raw('t.id::text'))
      .where({ 't.status': 'cancelled', 't.renewal_decision': 'cancel' })
      .whereExists(function unpaidPortalDecline() {
        this.select(conn.raw('1')).from('activity_log as a')
          .where('a.action', CUSTOMER_DECLINE_ACTIVITY_ACTION)
          .whereRaw("a.metadata->>'term_id' = t.id::text")
          .whereRaw("a.metadata->>'unpaid' = 'true'");
      })
      .whereNotExists(function reconciled() {
        this.select(conn.raw('1')).from('activity_log as r')
          .where('r.action', PAID_LAPSE_RECONCILED_ACTION)
          .whereRaw("r.metadata->>'term_id' = t.id::text");
      })
      .orderByRaw('att.attempted_at asc nulls first')
      .orderBy('t.term_end', 'asc')
      .limit(limit)
      .select('t.*');
    for (const term of terms) {
      await stampPaidLapseReconcileAttempt(term, conn);
      if (await reconcilePaidDecidedLapse(term, conn)) done += 1;
    }
    if (done) logger.info(`[annual-prepay] paid-lapse reconcile retry leg completed ${done} term(s)`);
  } catch (err) {
    logger.warn(`[annual-prepay] paid-lapse reconcile retry leg failed: ${err.message}`);
  }
  return done;
}

// Stamped BEFORE the attempt, so a failing term rotates to the back.
async function stampPaidLapseReconcileAttempt(term, conn) {
  const redated = await conn('activity_log')
    .where({ action: PAID_LAPSE_RECONCILE_ATTEMPT_ACTION })
    .whereRaw("metadata->>'term_id' = ?", [String(term.id)])
    .update({ created_at: new Date() });
  if (redated) return;
  await conn('activity_log').insert({
    customer_id: term.customer_id,
    action: PAID_LAPSE_RECONCILE_ATTEMPT_ACTION,
    description: 'Retrying the historical reconcile of an annual prepay paid after the online renewal decline.',
    metadata: { term_id: term.id },
  });
}

async function followThroughPaidDecidedLapse(lapse, conn) {
  const refreshed = await refreshTermSnapshot(lapse, conn);
  await reconcilePaidDecidedLapse(refreshed || lapse, conn);
  // #4940 pre-push P1: the billing-mode stamp only while the term covers
  // TODAY — the decided-coverage restore's coveredToday rule. Paid after
  // term_end, 'annual_prepay' on expired coverage is the nothing-bills limbo
  // (the monthly cron skips the mode); the historical payment is still
  // reconciled above, retried by the sweep until it completes. A pending term was never stamped, so the mode is left.
  if (await termCoversToday(lapse.id, conn)) {
    await stampAnnualPrepayBillingMode(lapse.customer_id, conn, lapse.id);
  }
  if (lapse.dispute_suspended_at) await finishDisputeRecoveryForTerm(lapse, conn);
  return refreshed || lapse;
}

// The renewal gate's keys for a term: its parent's and its own when it is a
// renewal successor; none otherwise.
function renewalGateTermIds(term) {
  return term.renewed_from_term_id ? [term.renewed_from_term_id, term.id] : [];
}

async function syncTermForInvoicePayment(invoiceOrId, conn = db) {
  if (!(await annualPrepayTableExists())) return [];
  const invoice = typeof invoiceOrId === 'object'
    ? invoiceOrId
    : await conn('invoices').where({ id: invoiceOrId }).first('id', 'status', 'paid_at');
  if (!invoice?.id) return [];

  const nextStatus = invoiceTermStatus(invoice);
  const linkedTerms = await conn('annual_prepay_terms')
    .where({ prepay_invoice_id: invoice.id })
    .whereIn('status', [PAYMENT_PENDING_STATUS, ...ACTIVE_STATUSES])
    .select('*');
  // A payment_pending term the customer already declined online settles
  // separately (move 15) — never through activation below.
  const terms = linkedTerms.filter((term) => !term.renewal_decision);
  const decidedPendingResults = await settleDecidedPendingTerms(
    linkedTerms.filter((term) => term.renewal_decision === 'cancel' && term.status === PAYMENT_PENDING_STATUS), nextStatus, conn,
  );

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

  const results = [...decidedPendingResults];
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
      // The flip and the setup cleanup commit TOGETHER (codex #3591 r52
      // P1): many callers pass the global handle, and an auto-committed
      // flip beside a failed cleanup left the restored stamp/replacement
      // live forever (the retry skips an already-active term).
      const reviveFromPending = async (t) => {
        // Own transaction = entry point: the renewal gate first — the
        // parent's key AND this successor's (the parent 'renewed' stamp
        // below writes the parent and re-reads both under them; Codex #4971
        // pre-push P1) — see acquireTermiteGateAtEntry. A term with no
        // parent takes nothing, as before.
        if (t !== conn) await acquireTermiteGateAtEntry(t, { termIds: renewalGateTermIds(term) });
        const [updated] = await t('annual_prepay_terms')
          .where({ id: term.id, status: PAYMENT_PENDING_STATUS })
          .whereNull('renewal_decision')
          .update({ status: 'active', updated_at: new Date() })
          .returning('*');
        if (updated) {
          await require('./invoice').retireRodentSetupObligationForRevivedPrepay(t, invoice.id);
          // …and any switch-restored per-application invoice becomes a
          // duplicate of the revived coverage (codex #3591 r54 P1).
          await require('./invoice')._retireSwitchRestoredInvoicesForRevivedPrepay(t, invoice.id);
          // Termite renewal successor, freshly paid: stamp the PARENT
          // 'renewed' now (move 16) — see stampParentRenewedForSuccessor's
          // own comment. Codex round-2 P1: runs on THIS SAME transaction/
          // savepoint (`t`), not the global `db` handle, so it can never
          // commit out of order with, or survive a rollback of, this exact
          // flip.
          await stampParentRenewedForSuccessor(updated, 'pending->active', t);
        }
        return updated;
      };
      const updated = typeof conn.transaction === 'function' && !conn.isTransaction
        ? await conn.transaction(reviveFromPending)
        : await reviveFromPending(conn);
      current = updated || term;
      // Codex #4971 r4 P1: a termite renewal successor just activated — end
      // its write-ahead charge outcome and alert staff if it was paid behind
      // a parent that no longer authorizes it. Best-effort; the hook itself
      // acts only on a termite successor, on the root handle AFTER the
      // activation committed (a caller's transaction is never touched — the
      // sweep's legs 7d / 7e cover that shape).
      await require('./termite-annual-renewal-charge').onRenewalSuccessorPaid(updated, conn);
    } else if (nextStatus === 'active' && term.status === 'cancelled') {
      // Lost-dispute revival (see the marker-gated select above). The
      // conditional WHERE keeps it race-safe and replay-idempotent; a miss
      // (someone else already revived) leaves current cancelled and the
      // next sync of this invoice picks the term up as active. Flip +
      // credits + setup cleanup commit TOGETHER (codex #3591 r52 P1).
      const reviveFromCancelled = async (t) => {
        if (t !== conn) await acquireTermiteGateAtEntry(t, { termIds: renewalGateTermIds(term) });
        const [updated] = await t('annual_prepay_terms')
          .where({ id: term.id, status: 'cancelled' })
          .whereNull('renewal_decision')
          .update({ status: 'active', updated_at: new Date() })
          .returning('*');
        if (updated) {
          logger.warn(`[annual-prepay] term ${term.id} revived (cancelled→active) — dispute-cancelled term's invoice ${invoice.id} was re-paid`);
          // The refund clawed the extension credit; the repayment restores
          // it with the coverage (guards P0). Idempotent (last-event rule).
          await restoreWaveguardExtensionCredits(updated, t);
          // …and the setup line is live again — retire the restored claim
          // and re-ledger the record (codex #3591 r45 local P0).
          await require('./invoice').retireRodentSetupObligationForRevivedPrepay(t, invoice.id);
          // …and any switch-restored per-application invoice becomes a
          // duplicate of the revived coverage (codex #3591 r54 P1).
          await require('./invoice')._retireSwitchRestoredInvoicesForRevivedPrepay(t, invoice.id);
          // Same stamp as the pending→active branch above, for the (rarer)
          // dispute-revival shape: a termite renewal successor whose OWN
          // invoice was disputed and lost, then re-paid. Same transaction/
          // savepoint (`t`) as this flip, for the same reason.
          await stampParentRenewedForSuccessor(updated, 'cancelled->active revival', t);
        }
        return updated;
      };
      const updated = typeof conn.transaction === 'function' && !conn.isTransaction
        ? await conn.transaction(reviveFromCancelled)
        : await reviveFromCancelled(conn);
      current = updated || term;
    } else if (nextStatus === 'cancelled') {
      // The cancel flip and EVERY restoration commit TOGETHER (codex #3591
      // r53 local P0 — symmetric with the revival branches): on the global
      // handle an autocommitted flip beside a failed restore stranded the
      // claim forever (the next sync excludes cancelled terms). Shared with
      // every other term-cancel writer (DELETE /:id/annual-prepay,
      // ADMIN-BUG-R16) via cancelTermWithRestorations.
      const updated = await cancelTermWithRestorations(term.id, conn);
      current = updated || term;
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
      // Never on a year that has already ended (stampUnlessYearEnded).
      await stampUnlessYearEnded(current, conn);
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
          // Same cleanup refreshTermSnapshot runs — this path stamps
          // directly, so it must detach legacy callbacks first (r4 P1).
          await detachCallbacksFromTerm(normalized, conn);
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
      .select('id', 'customer_id', 'source_estimate_id', 'prepay_invoice_id', 'coverage_service_type');
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
        // Same one-shot claim restore as the true-void branch (codex #3591
        // r34 P1) — a decided term's refund removes the prepay that billed
        // the direct rodent setup, so the per-application claim comes back.
        // PROPAGATES on failure (codex #3591 r46 local P0) — same
        // atomic-with-the-transition posture as the true-refund branch.
        await require('./invoice').restoreRetiredSetupFeeClaimForPrepay(decided.prepay_invoice_id, conn, { sourceEstimateId: decided.source_estimate_id || null, customerId: decided.customer_id || null, coverageServiceType: decided.coverage_service_type || null });
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
  // 'prepaid' with NO paid_at — consumed account credit IS money collected
  // for the visit (the same rule reconcilePendingWindowCompletions applies
  // via paidForVisit, and, since Codex #4971 r21, invoiceTermStatus itself),
  // so it takes the PAID direction here. Coverage-settled 'prepaid' invoices
  // are harmless re-entries: the reconcile skips rows carrying a
  // covered-term marker.
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
      wherePrepayInvoiceCollected(this);
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
  // Chokepoint B (Codex #4971 round-3 P1 / pre-push lock order): the
  // demotion moves a termite term out of charge-eligible state (active ->
  // payment_pending). Both callers (the dispute webhooks) pass their own
  // transaction and take the gate as its FIRST statement
  // (acquireTermiteGateAtEntry). A root-handle call is its own entry point:
  // it is re-entered inside a transaction that takes the gate first — only
  // when a termite term is actually involved (a non-termite invoice keeps
  // its exact old path).
  if (!conn.isTransaction) {
    const termiteTerms = await termiteGateKeys(conn, { termIds: [], invoiceIds: [invoiceId], customerIds: [] });
    if (termiteTerms.length) {
      return conn.transaction(async (trx) => {
        await acquireTermiteGateAtEntry(trx, { invoiceIds: [invoiceId] });
        return suspendActiveTermsForDisputedInvoice(invoiceId, trx);
      });
    }
  }
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
// P2-4 guard, extracted (Codex round-7 P2 self-review, AGENTS.md
// L412-418): coveredTermsAsOf now also matches an UNPAID termite renewal
// successor riding its 30-day grace — that is a "don't cancel it yet"
// signal, not "money collected". Every leg of reconcileCoveredTermsSweep
// below (pending-window completion settle/credit, extension-credit
// restore, dispute recovery) assumes real money landed on the prepay
// invoice; running any of them against a still-unpaid successor would
// settle or credit against a charge that never happened. Confirm the
// invoice actually reads paid before touching a payment_pending row — the
// pre-existing paidPending branch (invoice already paid, term flip just
// lagging) still proceeds untouched; only a genuinely-unpaid grace row is
// skipped.
async function isUnpaidGracePendingTerm(term, conn) {
  if (term.status !== PAYMENT_PENDING_STATUS) return false;
  const invoiceRow = term.prepay_invoice_id
    ? await conn('invoices').where({ id: term.prepay_invoice_id }).first('status', 'paid_at')
    : null;
  const reallyPaid = !!invoiceRow
    && (String(invoiceRow.status || '').toLowerCase() === 'paid' || !!invoiceRow.paid_at);
  return !reallyPaid;
}

// Extracted from reconcileOneCoveredTermInSweep (complexity reduction, no
// behavior change): the pending-completion grant reversal leg, verbatim.
async function reverseCancelledPendingCompletionGrantsInSweep(term, conn, summary) {
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

// Extracted from reconcileCoveredTermsSweep (complexity reduction, no
// behavior change — the eslint complexity/max-depth gate on this diff):
// the per-term body of the sweep's dated loop, unchanged apart from
// `continue` -> `return` (equivalent at the end of a loop body with
// nothing left to run). `todayKey` is `dateOnly(today) || etDateString()`,
// hoisted ONCE by the caller — the original inline calls were the exact
// same pure computation repeated per-term, so reusing one value changes
// nothing observable.
async function reconcileOneCoveredTermInSweep(term, conn, todayKey, summary) {
  summary.terms += 1;
  if (await isUnpaidGracePendingTerm(term, conn)) return;
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
      // Direct stamping path — detach legacy callbacks first (r4 P1).
      await detachCallbacksFromTerm(normalized, conn);
      await applyPrepaidCoverageForTerm(normalized, conn);
      await stampAnnualPrepayBillingMode(term.customer_id, conn, term.id);
      const recovery = await finishDisputeRecoveryForTerm(term, conn);
      summary.disputeRecovered += recovery.credited;
    } catch (err) {
      logger.warn(`[annual-prepay] sweep dispute-recovery leg failed for term ${term.id}: ${err.message}`);
    }
  }
  // ADMIN-BUG-R18: an end-at-term lapse's skipped paid visit is replaced
  // here, once a night — per-edit refreshes only attach and stamp.
  if (isEndAtTermLapseInWindow(term, todayKey)) {
    try {
      const kept = await keepEndAtTermLapseCoverage(term, conn, { reseed: true, today: todayKey });
      if (kept?.createdCount) logger.info(`[annual-prepay] sweep replaced ${kept.createdCount} visit(s) for end-at-term lapse ${term.id}`);
      if (kept?.skipped === 'cancel_commit_in_progress') logger.info(`[annual-prepay] sweep reseed skipped for term ${term.id}: a cancellation is being committed`);
    } catch (err) {
      logger.warn(`[annual-prepay] sweep end-at-term reseed failed for term ${term.id}: ${err.message}`);
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
  await reverseCancelledPendingCompletionGrantsInSweep(term, conn, summary);
}

async function reconcileCoveredTermsSweep({ today = etDateString(), conn = db } = {}) {
  const summary = { terms: 0, settled: 0, credited: 0, reversed: 0, disputeRecovered: 0 };
  if (!(await annualPrepayTableExists())) return summary;
  const todayKey = dateOnly(today) || etDateString();
  let terms = [];
  try {
    terms = await coveredTermsAsOf(conn, todayKey).select('t.*');
  } catch (err) {
    logger.warn(`[annual-prepay] covered-term sweep query failed: ${err.message}`);
    return summary;
  }
  for (const term of terms) {
    await reconcileOneCoveredTermInSweep(term, conn, todayKey, summary);
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
  // Paid-late declined terms whose historical reconcile has not completed —
  // expired ones too (they are outside the dated loop above).
  await retryPaidLapseReconciles(conn);
  if (summary.settled || summary.credited || summary.reversed || summary.disputeRecovered) {
    logger.info(`[annual-prepay] covered-term sweep recovered work: ${JSON.stringify(summary)}`);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// RESTAMP LEG — closes the "activated but never stamped" window.
//
// syncTermForInvoicePayment flips a term pending -> active in its own
// transaction and only THEN stamps its visits (refreshTermSnapshot). When that
// stamp pass throws (a lost price lookup now fails CLOSED, #5387), the Stripe
// webhook only logs: the term is active and paid, its canonical visits are
// unstamped, activatePaidPendingTerms ignores it (it only picks up
// payment_pending terms) and nothing else re-stamps an ordinary active term
// until somebody edits that customer's schedule. A covered visit that
// COMPLETES in that window bills the customer on top of the prepay.
//
// This leg re-runs the SAME stamp path (refreshTermSnapshot) for exactly the
// terms that need it, from the daily workflow that already carries
// reconcileCoveredTermsSweep. Idempotent by construction: a term whose
// canonical visits are all stamped, terminal, prepaid elsewhere or price-held
// is never refreshed, so a second run writes nothing.
//
// A price-held visit (holdPriceDriftedRows) is left held ON PURPOSE: the
// stamp-time price check owns that decision and already told the office once.
// A term that fails is logged and alerted (fileCoverageException's 7-day
// per-term dedupe, no failure counter / migration) and the sweep moves on.
// ---------------------------------------------------------------------------
const RESTAMP_FAILED_REASON = 'restamp_sweep_failed';

function rowStampedByTerm(term, row) {
  return row.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD
    && Number(row.prepaid_amount) > 0
    && row.annual_prepay_term_id != null
    && String(row.annual_prepay_term_id) === String(term.id);
}

// One term: decide from the canonical rows whether a refresh has anything to
// do, then run it under the paid-backing recheck. Returns 'clean' (nothing
// unstamped), 'held' (only price-held rows are unstamped), 'skipped' (no
// longer a paid live term) or 'restamped'.
async function restampOneTerm(term, conn, refresh) {
  const rows = await coverageRowsForTerm(term, conn);
  const open = rows.filter((row) => row.id
    && !PREPAID_UPDATE_EXCLUDED_STATUSES.has(String(row.status || '').toLowerCase())
    && !rowPrepaidElsewhere(term, row)
    && !rowStampedByTerm(term, row));
  if (!open.length) {
    // Nothing unstamped among the canonical rows — but a term whose
    // activation failed BEFORE seeding has no rows at all, and the prefilter
    // admits it for that reason. The marker for "activation never seeded" is
    // the one ensureCoverageRowsForTerm itself uses for "already activated":
    // NO scheduled_services row, in ANY status, was ever linked to the term.
    // A term that ever carried a linked visit is never re-seeded here (the
    // office may have cancelled slots on purpose), nor is one that cannot
    // seed yet (termite awaiting installation, renewal successors).
    if (!(await activationNeverSeeded(term, rows, conn))) return 'clean';
  } else {
    const { held, heldIds } = await holdPriceDriftedRows(term, open, conn, { skipRow: (row) => rowPrepaidElsewhere(term, row) });
    if (!open.some((row) => !heldIds.has(String(row.id)))) {
      // The stamp pass that held these may have thrown before its after-commit
      // alert filed; the hold's dedupe key is per term+visit and never expires,
      // so re-filing here is a no-op once the office has been told.
      await fileHeldPriceDriftAlerts(term, held, conn);
      return 'held';
    }
  }

  // Everything below runs in ONE transaction (a failure rolls the partial
  // attach + stamp back; the next run starts clean) under, in order:
  //   1. share lock on the prepay invoice — serializes against the payment /
  //      dispute-reopen writers, which update the invoice row first;
  //   2. the term row FOR UPDATE — cancelTermWithRestorations (refund / void /
  //      lost dispute) updates this row first, so a cancel either commits
  //      before this point (the paid-backing recheck below then skips the
  //      term) or waits until we commit; it can never clear stamps mid-refresh
  //      and then have us stamp a cancelled term;
  //   3. the customer row FOR UPDATE — the cancel writers take term ->
  //      customer -> scheduled_services, and the accept transaction takes
  //      customer -> scheduled_services; taking the customer before our
  //      scheduled_services writes (and before stampUnlessYearEnded's
  //      customers UPDATE) keeps the same order as both.
  // Inside the refresh the only further cross-transaction waits are try-locks
  // (occupancy date lock, customer-comms), so they cannot join a cycle. The
  // per-customer ANNUAL_PREPAY_LOCK_NS is NOT taken: only mint / re-price
  // paths hold it, and activation's own refresh does not, so it would fence
  // nothing here.
  const run = async (t) => {
    if (term.prepay_invoice_id) {
      await t('invoices').where({ id: term.prepay_invoice_id }).forShare().first('id');
    }
    await t('annual_prepay_terms').where({ id: term.id }).forUpdate().first('id');
    const fresh = await coveredTermsAsOf(t, null)
      .where('t.id', term.id)
      .whereIn('t.status', ACTIVE_STATUSES)
      .first('t.*');
    if (!fresh) return 'skipped';
    if (fresh.customer_id) await t('customers').where({ id: fresh.customer_id }).forUpdate().first('id');
    await refresh(fresh, t);
    // The activation that threw before its stamp also never reached the
    // billing-mode stamp (syncTermForInvoicePayment runs it right after the
    // refresh): without 'annual_prepay' the completion gate does not read the
    // customer as prepaid. Idempotent, first-stamp-wins, skips an ended year.
    await stampUnlessYearEnded(fresh, t);
    // attach / stamp swallow their own SQL errors and a failed statement
    // aborts this transaction (its COMMIT would quietly roll back while we
    // count the term restamped) — this probe fails in an aborted transaction
    // instead.
    await t.raw('select 1');
    return 'restamped';
  };
  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

// "Activation never seeded" — see restampOneTerm. `rows` is the canonical
// coverage set already read.
async function activationNeverSeeded(term, rows, conn) {
  const sold = normalizeCoverageVisitCount(term.coverage_visit_count);
  if (!sold || rows.length >= sold) return false;
  if (coverageAwaitsInstallation(term) || term.renewed_from_term_id) return false;
  const cols = await scheduledServiceColumns();
  if (!cols.annual_prepay_term_id) return false;
  const linked = await conn('scheduled_services').where({ annual_prepay_term_id: term.id }).first('id');
  return !linked;
}

async function restampUnstampedActiveTerms({ today = etDateString(), conn = db, refresh = refreshTermSnapshot } = {}) {
  const summary = { scanned: 0, restamped: 0, held: 0, skipped: 0, failed: 0 };
  if (!(await annualPrepayTableExists())) return summary;
  const todayKey = dateOnly(today) || etDateString();
  let terms = [];
  try {
    const cols = await scheduledServiceColumns();
    if (!cols.annual_prepay_term_id || !cols.prepaid_method || !cols.prepaid_amount) return summary;
    const excluded = [...PREPAID_UPDATE_EXCLUDED_STATUSES];
    // Cheap prefilter: paid-backed (coveredTermsAsOf — the one "which terms
    // hold money" definition) LIVE terms with an open or future window that
    // have at least one non-terminal visit in their window not already
    // stamped by this term. coverageRowsForTerm (the canonical selection)
    // then runs only for those.
    terms = await coveredTermsAsOf(conn, null)
      .whereIn('t.status', ACTIVE_STATUSES)
      .where('t.term_end', '>=', todayKey)
      .whereNotNull('t.coverage_service_type')
      .where('t.coverage_visit_count', '>', 0)
      .where('t.prepay_amount', '>', 0)
      // Settle window: a term flipped active (or edited) in the last 15
      // minutes may still have its own activation / edit refresh in flight —
      // leave it to that run; the next tick covers it.
      .whereRaw(`coalesce(t.updated_at, now() - interval '1 day') < now() - interval '15 minutes'`)
      .whereRaw(
        `(exists (
          select 1 from scheduled_services ss
          where ss.customer_id = t.customer_id
            and ss.scheduled_date between t.term_start and t.term_end
            and lower(coalesce(ss.status, '')) not in (${excluded.map(() => '?').join(', ')})
            and not (
              coalesce(ss.prepaid_method, '') = ?
              and coalesce(ss.prepaid_amount, 0) > 0
              and coalesce(ss.annual_prepay_term_id::text, '') = t.id::text
            )
        )
        -- or a term no visit was EVER linked to (activation failed before
        -- seeding); restampOneTerm decides whether it truly needs seeding
        or not exists (
          select 1 from scheduled_services lk
          where lk.annual_prepay_term_id is not null and lk.annual_prepay_term_id::text = t.id::text
        ))`,
        [...excluded, ANNUAL_PREPAY_PREPAID_METHOD],
      )
      .orderBy('t.term_end', 'asc')
      .select('t.*');
  } catch (err) {
    logger.warn(`[annual-prepay] restamp sweep query failed: ${err.message}`);
    return summary;
  }

  for (const row of terms) {
    summary.scanned += 1;
    try {
      const term = { ...row, term_start: dateOnly(row.term_start), term_end: dateOnly(row.term_end) };
      const outcome = await restampOneTerm(term, conn, refresh);
      if (outcome === 'restamped') {
        summary.restamped += 1;
        logger.info(`[annual-prepay] restamp sweep re-applied coverage for term ${row.id}`);
      } else if (outcome === 'held') summary.held += 1;
      else if (outcome === 'skipped') summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(`[annual-prepay] restamp sweep failed for term ${row.id}: ${err.message}`);
      // After the rolled-back transaction, on the bare connection: a notice
      // filed inside a rolled-back scope would outlive it. 7-day per-term
      // dedupe (fileCoverageException's default) — no failure counter needed.
      await fileCoverageException(row, RESTAMP_FAILED_REASON,
        `This customer's paid annual prepay has visits that are not marked as covered, and the automatic re-check could not fix them (${err.message}). Until they are stamped, a visit that is completed can bill the customer on top of the prepay. Open the customer's schedule and save any visit to re-apply coverage, or check the term.`,
        { title: 'Annual prepay: visits not marked as covered' });
    }
  }
  if (summary.restamped || summary.failed) {
    logger.info(`[annual-prepay] restamp sweep: ${JSON.stringify(summary)}`);
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

// Plain copy for callers — the cached structure stays immutable and the
// lookupFailed marker never leaks.
function copyCardExpiryExemptions(result) {
  return {
    customerIds: new Set(result.customerIds),
    chargeMethodIdsByCustomer: new Map(
      [...result.chargeMethodIdsByCustomer].map(([customerId, ids]) => [customerId, ids instanceof Set ? new Set(ids) : null]),
    ),
  };
}

// Per-method exemption (shape documented in services/card-expiry-exemptions.js):
// { customerIds, chargeMethodIdsByCustomer }. Memoized per horizon exactly
// like the customer-level set below, which is now derived from it.
async function getCardExpiryExemptions(horizon = etDateString(), conn = db) {
  if (conn !== db) return copyCardExpiryExemptions(await computeCardExpiryExemptions(horizon, conn));
  const hit = cardExpiryExemptCache.get(horizon);
  if (hit && Date.now() - hit.at < CARD_EXPIRY_EXEMPT_TTL_MS) {
    return copyCardExpiryExemptions(await hit.promise);
  }
  // evict expired horizons on insert — callers derive a fresh horizon as
  // calendar time advances, so without eviction the map grows with uptime
  for (const [key, staleEntry] of cardExpiryExemptCache) {
    if (Date.now() - staleEntry.at >= CARD_EXPIRY_EXEMPT_TTL_MS) cardExpiryExemptCache.delete(key);
  }
  const entry = { at: Date.now(), promise: computeCardExpiryExemptions(horizon, conn) };
  cardExpiryExemptCache.set(horizon, entry);
  const result = await entry.promise;
  if (result.lookupFailed && cardExpiryExemptCache.get(horizon) === entry) {
    cardExpiryExemptCache.delete(horizon);
  }
  return copyCardExpiryExemptions(result);
}

// Customer-level view: covered customers with NO card charge coming inside
// the window. A covered customer whose charge is coming on SOME method is
// not here — consult isCardExpiryExemptMethod for the per-method verdict.
async function getCardExpiryExemptCustomerIds(horizon = etDateString(), conn = db) {
  return (await getCardExpiryExemptions(horizon, conn)).customerIds;
}

async function computeCardExpiryExemptions(horizon = etDateString(), conn = db) {
  const today = etDateString();
  let covered;
  // Per-covered-customer charge vectors (payment_methods.id each forthcoming
  // charge will use; null = a charge is coming but its method could not be
  // resolved → every method keeps its warning). A covered customer absent
  // from this map has no charge coming → fully exempt.
  const chargeMethodIdsByCustomer = new Map();
  const recordCharge = (customerId, methodId) => {
    const key = String(customerId);
    if (chargeMethodIdsByCustomer.get(key) === null) return;
    if (methodId == null) { chargeMethodIdsByCustomer.set(key, null); return; }
    if (!chargeMethodIdsByCustomer.has(key)) chargeMethodIdsByCustomer.set(key, new Set());
    chargeMethodIdsByCustomer.get(key).add(String(methodId));
  };
  // Still worth evaluating: covered, and not already known to charge an
  // unresolvable method (once every method warns, nothing more can change).
  const evaluable = (customerId) => covered.has(String(customerId)) && chargeMethodIdsByCustomer.get(String(customerId)) !== null;
  const anyEvaluable = () => [...covered].some((customerId) => evaluable(customerId));
  const finish = () => ({
    customerIds: new Set([...covered].filter((customerId) => !chargeMethodIdsByCustomer.has(customerId))),
    chargeMethodIdsByCustomer,
  });
  const failedExemptions = () => ({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map(), lookupFailed: true });
  // The method(s) the Auto Pay rails will charge — the retry sweep
  // (StripeService.charge) and every completion Auto Pay lane
  // (chargeInvoiceWithSavedCard → getChargeableAutopayMethod under lock)
  // walk the SAME pointer-first, newest-default order. TWO walks, both
  // recorded (hook P1): with ignoreCardExpiry the walk lands on the
  // expiring card itself (the card the warning exists to replace —
  // charge()'s expiry fallback would route past it); without, it is the
  // card charge() falls back to TODAY when that pointer/default is
  // already expired — a real charge on a card that must keep its warning
  // too. No method on either walk → [] (unresolved: every method warns —
  // noise, never a missed charge). Lookup failures propagate to the outer
  // catch (exempt nobody). One pair of walks per customer.
  const walkNow = new Date();
  const horizonNoon = parseETDateTime(`${dateOnly(horizon)}T12:00`);
  const autopayWalkMemo = new Map();
  const autopayWalkMethodIds = async (customerLike) => {
    const key = String(customerLike.id);
    if (!autopayWalkMemo.has(key)) {
      const { listChargeableAutopayMethods, isExpiredCardMethod, isBankMethodType } = require('./autopay-eligibility');
      // (a) the expiring card the warning exists to replace; (b) today's
      // eligible methods in walk order, AS FAR AS the horizon can make
      // each predecessor fall through: the charge lands on some date
      // inside the horizon and eligibility only shrinks with time (cards
      // expire), so charge() moves past a method only once it has
      // expired — a method still valid AT the horizon (or a bank row) is
      // selected on every date in the window and nothing behind it can be
      // (GitHub P1 + r2 P2: a pointer valid today but expiring mid-window
      // hands the charge to the next default; a pointer valid through the
      // horizon never does).
      autopayWalkMemo.set(key, Promise.all([
        listChargeableAutopayMethods(customerLike, conn, { rethrow: true, now: walkNow, ignoreCardExpiry: true }),
        listChargeableAutopayMethods(customerLike, conn, { rethrow: true, now: walkNow }),
      ]).then(([expiringFirst, eligibleToday]) => {
        // Expiry as a month index (bank rows never expire). charge() only
        // moves PAST a method once it has expired, so a fallback is
        // reachable only if it is still valid AFTER every method ahead of
        // it has expired — one expiring the same month as (or before) its
        // predecessor is skipped in the same breath (r3 P2).
        const expiryIndex = (m) => {
          if (isBankMethodType(m.method_type)) return Infinity;
          const rawYear = Number(m.exp_year);
          const year = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
          return year * 12 + Number(m.exp_month);
        };
        const reachable = [];
        let latestPredecessorExpiry = -Infinity;
        for (const m of eligibleToday) {
          const expiry = expiryIndex(m);
          if (reachable.length && !(expiry > latestPredecessorExpiry)) continue;
          reachable.push(m);
          latestPredecessorExpiry = Math.max(latestPredecessorExpiry, expiry);
          if (isBankMethodType(m.method_type) || !isExpiredCardMethod(m, horizonNoon)) break;
        }
        return [...new Set(
          [...expiringFirst.slice(0, 1), ...reachable].filter((m) => m?.id != null).map((m) => String(m.id)),
        )];
      }));
    }
    return autopayWalkMemo.get(key);
  };
  const recordAutopayWalk = async (customerId, customerLike) => {
    const ids = await autopayWalkMethodIds(customerLike);
    if (!ids.length) { recordCharge(customerId, null); return; }
    for (const id of ids) recordCharge(customerId, id);
  };
  // A hold charges the card frozen on it. That card is exempt-worthy only
  // when it will still be VALID at charge time (through the horizon) —
  // an expiring hold card is a charge that will fail, and no surface
  // scans hold cards (saved enableAutopay:false), so the Auto Pay card's
  // warning must stay as the customer's only notice (hook P1): record it
  // as unresolved. Malformed expiry reads as expired (isExpiredCardMethod).
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
    return failedExemptions();
  }
  if (!covered.size) return finish();
  try {
    // (a) armed retries, classified by the SAME verdict the sweep acts on
    // (retry-collectibility.js — one implementation, so the two cannot
    // drift), bounded to the horizon: the sweep only fires rows with
    // next_retry_at <= now, so a retry armed for AFTER the horizon cannot
    // charge inside this warning window (ET end of the horizon day,
    // exclusive next-midnight bound). The context evaluates the pause, the
    // pending-prepay hold, and prepay coverage as of the HORIZON: a pause or
    // hold that lapses inside the window lets the retry fire before the
    // horizon, so only one covering the whole window suppresses the
    // warning.
    const {
      loadRetryContext, armedRetryQuery, classifyFailedPaymentRetry,
    } = require('./retry-collectibility');
    const horizonNextMidnight = dayAfter(dateOnly(horizon));
    const retrying = await armedRetryQuery(conn, {
      customerIds: [...covered],
      dueBefore: horizonNextMidnight ? parseETDateTime(`${horizonNextMidnight}T00:00:00`) : null,
    }).select('id', 'customer_id', 'description', 'payment_date', 'metadata', 'stripe_payment_intent_id', 'next_retry_at');
    let retryCustomerById = new Map();
    if ((retrying || []).length) {
      const stateRows = await conn('customers')
        .whereIn('id', [...new Set(retrying.map((row) => row.customer_id))])
        .select('id', 'autopay_enabled', 'autopay_paused_until', 'billing_mode', 'waveguard_tier', 'monthly_rate');
      retryCustomerById = new Map((stateRows || []).map((row) => [String(row.id), row]));
    }
    const retryCtx = loadRetryContext({ asOf: horizon, conn });
    for (const row of retrying || []) {
      const customerId = String(row.customer_id);
      if (!evaluable(customerId)) continue;
      // A missing customer row is unreadable state, not proof the sweep
      // would skip: only the row-level guards may exempt then (the
      // verdict's customer_missing skip is the sweep's own posture).
      const verdict = await classifyFailedPaymentRetry({
        payment: row,
        customer: retryCustomerById.get(customerId) || null,
        ctx: retryCtx,
        conn,
        allowMissingCustomer: true,
      });
      // The sweep charges through StripeService.charge — the Auto Pay walk.
      if (verdict.collectible) await recordAutopayWalk(customerId, { id: customerId });
    }
    // The verdict's prepay lookups fail OPEN for the sweep (collect rather
    // than stall); this surface must fail the other way — a lookup failure
    // exempts nobody (the outer catch keeps every warning).
    if (retryCtx.lookupWarnings.length) {
      throw new Error(`retry-collectibility lookup failed: ${retryCtx.lookupWarnings.map((w) => w.message).join('; ')}`);
    }
    if (!anyEvaluable()) return finish();

    // (b) still-completable visits inside the window, judged by the shared
    // completion predicate with the schedule sheet's inputs.
    const { predictCompletionBilling, resolveBillingLane, perApplicationCompletionVoidHold } = require('./billing-lane');
    const { resolveForInvoice } = require('./payer');
    const { isCardHoldEnabled } = require('./estimate-card-holds');
    const { findFirstApplicationInvoiceForEstimateService } = require('./estimate-first-application-invoice');
    const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
    const { splitTerminalCompletionInvoice, COMPLETION_TERMINAL_INVOICE_STATUSES } = require('./completion-invoice-candidate');
    const { resolveAppointmentCardLane, resolveExtendedLane, resolveCompletionChargeCap } = require('./completion-charge-verdict');
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
        'ss.id', 'ss.customer_id', 'ss.status', 'ss.estimated_price', 'ss.primary_line_price', 'ss.is_callback', 'ss.service_type',
        'ss.prepaid_amount', 'ss.prepaid_method', 'ss.annual_prepay_term_id', 'ss.is_recurring',
        'ss.source_estimate_id', 'ss.scheduled_date', 'ss.recurring_parent_id', 'ss.recurring_pattern',
        // Stamped combined-invoice provenance (PR #5021): the sibling lookup
        // honours it directly; selecting it here spares the lookup's fallback
        // read per visit.
        'ss.first_application_invoice_id',
        'c.billing_mode', 'c.waveguard_tier', 'c.monthly_rate', 'c.autopay_enabled',
        'c.autopay_paused_until as customer_autopay_paused_until',
        'c.autopay_payment_method_id as customer_autopay_payment_method_id',
        'c.ach_status as customer_ach_status',
        'c.per_application_fee', 'c.payer_id as customer_payer_id',
      );
    for (const v of visits || []) {
      const customerId = String(v.customer_id);
      if (!evaluable(customerId)) continue;
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
        primaryLinePrice: v.primary_line_price,
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
      // ── Invoice candidate: completion's own state machine ──────────────
      // Kinds that MINT no bill (covered_*, prepaid, no_charge — e.g. a
      // callback) can still charge through a live hold or the autopay
      // lanes, but only against an EXISTING collectible invoice: completion
      // reuses any open invoice it finds. With no existing invoice there is
      // nothing to charge — the invoice checks below decide.
      const mintsNothing = !['auto_charge', 'invoice'].includes(prediction.kind);
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
      // A REFUNDED invoice on the visit PARKS the completion (no mint, no
      // reuse — completionTerminalInvoiceLookup / reconcileLiveVsRefunded):
      // spans BOTH identifiers.
      if ((visitInvoices || []).some((inv) => COMPLETION_TERMINAL_INVOICE_STATUSES.includes(statusOf(inv)))) continue;
      // Reuse PRECEDENCE mirrors the completion suppressor chain: the
      // service-record link is checked first, and the scheduled_service_id
      // rows are consulted only when no live record-linked row stands.
      const recordLinked = (visitInvoices || []).filter((inv) => inv.service_record_id != null && attemptRecordIds.has(String(inv.service_record_id)));
      let reused = recordLinked.find((inv) => !CANCELLED_SERVICE_RESOLVED_STATUSES.includes(statusOf(inv)))
        || (visitInvoices || []).find((inv) => !CANCELLED_SERVICE_RESOLVED_STATUSES.includes(statusOf(inv)));
      if (!reused) {
        // No direct invoice on the visit → completion consults the SIBLING
        // first-application invoice of the same estimate/date
        // (findFirstApplicationInvoiceForEstimateService, the shared
        // service completion itself calls): a refunded match PARKS the
        // completion; a canceled setup-fee acceptance invoice with no live
        // replacement also parks (bill both charges by hand); a live match
        // is REUSED (splitTerminalCompletionInvoice).
        const sibling = await findFirstApplicationInvoiceForEstimateService(v, conn);
        const split = splitTerminalCompletionInvoice(sibling.invoice);
        if (split.terminal) continue;
        if (!split.existing && sibling.canceledSetupFee) continue;
        // Owner ruling (round 13, codex pre-push P2): "propagate the new
        // void hold to billing projections". findFirstApplicationInvoiceForEstimateService's
        // own query excludes 'void' entirely, so a voided combined invoice
        // with no live replacement reports the SAME `{invoice: null}` as
        // "nothing was ever minted" — this projection would otherwise still
        // treat `prediction.amount` below as an upcoming card charge and
        // keep the card-expiry warning alive for a charge completion's own
        // REFUSE AFTER A VOID guard actually holds for manual review. Same
        // shared, read-only check the Charge Now guard and
        // closeout-status.js's deriveBillingExpectation both use, so all
        // three can never disagree.
        if (!split.existing) {
          const voidHold = await perApplicationCompletionVoidHold({
            isCallback: !!v.is_callback, serviceType: v.service_type, svc: v, dbConn: conn,
          });
          if (voidHold) continue;
        }
        reused = split.existing || null;
      }
      if (mintsNothing && !reused) continue;
      // Settled (paid/prepaid/processing) → no second card charge.
      if (reused && ['paid', 'prepaid', 'processing'].includes(statusOf(reused))) continue;
      // A reused invoice with FROZEN payer ownership is owed by the payer's
      // AP inbox — every saved-card rail requires !invoice.payer_id.
      if (reused && reused.payer_id) continue;
      // Account credit is deliberately NOT a projected exemption: the route
      // applies the customer's balance to this invoice at completion, but
      // that balance is unreserved and fungible — dunning touches, sends
      // and any invoice minted before the visit draw it down first
      // (autoApplyAccountCreditIfEnabled) — so no snapshot can prove a
      // future completion will not reach the card (hook + GitHub P1s).
      // Credit that HAS been applied is already modeled: a fully covered
      // invoice is 'prepaid' and excluded above.
      // The invoice completion will charge: the reused row, else the row it
      // is about to MINT — priced by the same completionInvoiceAmount
      // precedence the prediction reports (the setup-fee allowance rides
      // the cap verdict, so a first-visit fee line cannot push it over).
      const perApplicationBilling = v.billing_mode === 'per_application';
      const annualPrepayBilling = v.billing_mode === 'annual_prepay';
      const explicitMembershipLane = v.billing_mode === 'monthly_membership';
      const invoiceForVerdict = reused || {
        id: `pending-mint:${v.id}`, status: 'draft', subtotal: prediction.amount, total: prediction.amount,
        discount_amount: 0, payer_id: null, notes: '', line_items: [], scheduled_service_id: v.id, service_record_id: null,
      };
      // An OPEN invoice not bound to THIS visit cannot be card-charged on
      // the extended / hold / appointment rails (the money boundaries
      // return invoice_unbound or re-prove the binding under their locks);
      // it is reused as a pay-link only. Per-application keeps the warning.
      const invoiceBoundToVisit = String(invoiceForVerdict.scheduled_service_id || '') === String(v.id);
      if (!invoiceBoundToVisit && !perApplicationBilling) continue;

      // ── Charge lanes: the completion route's OWN admission + cap ───────
      // (services/completion-charge-verdict.js — the same functions the
      // route runs, with the schedule row aliased to the route's cust_*
      // projection). visitPerformed is unknown for a future visit; assume
      // performed (fail toward the warning).
      const svcLike = {
        ...v,
        cust_billing_mode: v.billing_mode,
        cust_monthly_rate: v.monthly_rate,
        cust_per_application_fee: v.per_application_fee,
      };
      const appt = await resolveAppointmentCardLane({
        svc: svcLike, invoice: invoiceForVerdict, alreadyPaid: false, visitPerformed: true,
        perApplicationBilling, annualPrepayBilling, explicitMembershipLane,
        conn, strict: true,
      });
      const ext = await resolveExtendedLane({
        svc: svcLike, invoice: invoiceForVerdict, alreadyPaid: false, visitPerformed: true, perApplicationBilling,
        apptCardOneTimeCharge: appt.apptCardOneTimeCharge, apptCardLaneUnresolved: appt.apptCardLaneUnresolved,
        customerAutopayActive: autopayActive,
        conn, strict: true,
      });
      // The per-application and extended rails charge only when the shared
      // prediction says 'auto_charge': dues / annual-prepay coverage the
      // charge service refuses under its locks (verifyExtendedCompletionAnchor)
      // reads as covered_* there and mints nothing. The appointment lane
      // charges a priced bill ('invoice' — gate off — or 'auto_charge') for
      // an Auto-Pay-active customer; the route gates every rail on
      // customerAutopayActive.
      const perApplicationCharge = perApplicationBilling && autopayActive && prediction.kind === 'auto_charge';
      const apptLaneCharge = appt.apptCardOneTimeCharge && autopayActive && ['invoice', 'auto_charge'].includes(prediction.kind);
      const extendedCharge = ext.extendedChargeCandidate && prediction.kind === 'auto_charge';
      let autopayLaneCharges = perApplicationCharge || apptLaneCharge || extendedCharge;
      if (autopayLaneCharges) {
        const cap = await resolveCompletionChargeCap({
          svc: svcLike, invoice: invoiceForVerdict, perApplicationBilling,
          apptCardOneTimeCharge: appt.apptCardOneTimeCharge, apptCardAcceptedAmount: appt.apptCardAcceptedAmount,
          extendedLaneAnchor: ext.extendedLaneAnchor, secureSetupFee: null,
          conn, strict: true,
        });
        // Over the cap / no accepted amount → office review, nothing charged.
        if (cap.verdict !== 'ok') autopayLaneCharges = false;
      }
      // Lock-boundary refusals the charge service asserts for the EXTENDED
      // lane (chargeInvoiceWithSavedCard; not part of the route's unlocked
      // admission): any appointment-card consent row on the visit
      // (requireNoAppointmentCardLane), an invoice not bound to THIS visit
      // (requireInvoiceScheduledServiceBinding), an explicit stopped-dunning
      // instruction (refuseWhenDunningStopped), and an ACTIVE payment plan
      // owning the invoice (verifyExtendedCompletionAnchor).
      const extendedIsVector = autopayLaneCharges && extendedCharge && !apptLaneCharge && !perApplicationBilling;
      let anyConsentRow = null;
      if (extendedIsVector || isCardHoldEnabled()) {
        anyConsentRow = await conn('appointment_card_requests')
          .where({ scheduled_service_id: v.id })
          .first('id');
      }
      if (extendedIsVector) {
        if (anyConsentRow) autopayLaneCharges = false;
        else if (reused) {
          const seq = await conn('invoice_followup_sequences').where({ invoice_id: reused.id }).first('status');
          if (seq && String(seq.status || '').toLowerCase() === 'stopped') autopayLaneCharges = false;
          else if (await conn('payment_plans').where({ invoice_id: reused.id, status: 'active' }).first('id')) autopayLaneCharges = false;
        }
      }
      // ── Hold rail (chargeCardHoldOnCompletion) ─────────────────────────
      // Never Auto-Pay-gated: completion charges the NEWEST live ('held',
      // not parked) hold against the visit's collectible invoice, capped at
      // the accepted_amount FROZEN on the hold (withheld fail-closed with no
      // frozen amount). Refused at the Stripe boundary for a visit with
      // recurring lineage (requireCompletedOneTimeVisit), beside ANY
      // appointment-card consent row (requireNoAppointmentCardLane), and for
      // an invoice not bound to this visit.
      let holdCharges = false;
      let holdRow = null;
      const oneTimeLineage = v.is_recurring !== true && !v.recurring_parent_id && !v.recurring_pattern;
      if (oneTimeLineage && isCardHoldEnabled() && !anyConsentRow) {
        holdRow = await conn('estimate_card_holds')
          .where({ scheduled_service_id: v.id, status: 'held' })
          .orderBy('held_at', 'desc')
          .first('id', 'accepted_amount', 'parked_at', 'stripe_payment_method_id');
        if (holdRow && !holdRow.parked_at) {
          const acceptedRaw = Number(holdRow.accepted_amount);
          if (Number.isFinite(acceptedRaw) && acceptedRaw > 0) {
            const basis = Math.round(((invoiceForVerdict.subtotal != null ? Number(invoiceForVerdict.subtotal) : Number(invoiceForVerdict.total || 0))
              - Math.max(0, Number(invoiceForVerdict.discount_amount) || 0)) * 100) / 100;
            holdCharges = !(basis > acceptedRaw + 0.005);
          }
        }
      }
      if (!autopayLaneCharges && !holdCharges) continue;
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
      // — gate off or a priced callback — goes out as a pay-link). Record
      // the METHOD each firing rail will use: the Auto Pay lanes charge the
      // walk's method(s); the hold rail charges the card frozen on the hold
      // (attachCardHoldPaymentMethod saves it enableAutopay:false, so it
      // is routinely NOT the Auto Pay card — matched back to its
      // payment_methods row; no row → unresolved, every method warns).
      if (autopayLaneCharges) {
        await recordAutopayWalk(customerId, {
          id: v.customer_id, ach_status: v.customer_ach_status, autopay_payment_method_id: v.customer_autopay_payment_method_id,
        });
      }
      if (holdCharges) {
        const { isExpiredCardMethod } = require('./autopay-eligibility');
        const holdMethod = holdRow?.stripe_payment_method_id
          ? await conn('payment_methods')
            .where({ customer_id: v.customer_id, stripe_payment_method_id: holdRow.stripe_payment_method_id })
            .first('id', 'method_type', 'exp_month', 'exp_year')
          : null;
        const holdCardValidThroughHorizon = holdMethod?.id != null && !isExpiredCardMethod(holdMethod, horizonNoon);
        recordCharge(customerId, holdCardValidThroughHorizon ? String(holdMethod.id) : null);
      }
    }
  } catch (err) {
    logger.warn(`[annual-prepay] card-expiry exemption: charge lookup failed, exempting nobody: ${err.message}`);
    return failedExemptions();
  }
  return finish();
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
async function getPaymentPendingCustomerIds(asOf = etDateString(), conn = db, { throwOnError = false } = {}) {
  // Strict callers (the MRR snapshot writer's pendingPrepayIds) must see a
  // schema-probe FAILURE as unavailable, not as "no table → nobody
  // pending" (Codex #3669 r15; mirrors annualPrepayCoversVisit's
  // throwOnError probe above): annualPrepayTableExists caches false on a
  // failed probe, which would let a month-end snapshot persist minus every
  // pending prepay account. Probing directly lets the error propagate; a
  // genuinely absent table (fresh env) still returns the empty set.
  if (throwOnError) {
    if (!(await conn.schema.hasTable('annual_prepay_terms'))) return new Set();
  } else if (!(await annualPrepayTableExists())) return new Set();
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
    // Read source_estimate_id from THIS row, never only the caller-supplied
    // `term` object (pre-push audit P1): a caller with a partial/minimal
    // term (e.g. just { id, customer_id }, as a route-level demotion
    // handoff might pass) must not silently lose the estimate-flow fallback
    // for a legacy term with no prior_billing_mode recorded.
    let restored;
    let sourceEstimateId = term.source_estimate_id;
    if (await conn.schema.hasColumn('annual_prepay_terms', 'prior_billing_mode')) {
      const trow = await conn('annual_prepay_terms').where({ id: term.id }).first('prior_billing_mode', 'source_estimate_id');
      if (trow?.prior_billing_mode) {
        restored = trow.prior_billing_mode === 'none' ? null : trow.prior_billing_mode;
      }
      if (sourceEstimateId === undefined) sourceEstimateId = trow?.source_estimate_id ?? null;
    }
    if (restored === undefined) {
      restored = sourceEstimateId ? 'per_application' : null;
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

// Renewal-successor carry-forward columns (Codex round-1 P1 / slice 6b),
// extracted (round-7 P2 self-review, AGENTS.md L412-418) so these 2
// additions don't compound createTermForAnnualPrepay's own complexity —
// the SAME "carry forward once, never overwrite" semantics as the
// pre-existing annual_plan_version clause beside them, shared by both the
// update path (`existing` set) and the insert path (`existing` null, so
// `!existing?.col` is always true and never blocks a first write).
// Returns `undefined` for a column that should NOT be set — the caller
// checks `!== undefined` and assigns each field with its OWN plain,
// direct property write (dot notation, never a bulk-merge helper, and
// never touching the status field itself) so annual-prepay-term-states
// .test.js's static status-write-site scanner can still see every write
// shape (it deliberately fails closed on anything less direct than that
// — a caught regression once already, see that test's own comments; NOTE
// TO FUTURE EDITORS: writing the bulk-merge helper's actual name here in
// a comment is exactly what trips its OWN textual scan — it is not
// comment-aware for that one check).
function renewalCarryForwardColumns(termCols, existing, renewedFromTermId, renewalChargeConsentAt) {
  const out = {};
  if (termCols.renewed_from_term_id && renewedFromTermId && !existing?.renewed_from_term_id) {
    out.renewedFromTermId = renewedFromTermId;
  }
  if (termCols.renewal_charge_consent_at && renewalChargeConsentAt && !existing?.renewal_charge_consent_at) {
    out.renewalChargeConsentAt = renewalChargeConsentAt;
  }
  return out;
}

// Whether createTermForAnnualPrepay's result is a paid term that needs the
// born-paid follow-through (renewal-date sync, pending-window reconcile,
// annual_prepay billing stamp): ACTIVE — or, on the installation-anchor
// path only (anchorInstallation), a decided-lapse term (declined before its
// installation) that is still PAID. Its coverage year is untouched by the
// decline; isPaidDecidedLapseTerm applies billing's own paid test.
// The born-paid billing-mode stamp. On the installation-anchor path the
// anchored year can ALREADY have ended (a delayed anchor, #4940 pre-push P1):
// stamp only while the term covers TODAY (the anchored year starts at a
// completed installation, so this only ever skips an expired year). Other
// creates stamp as before (a future-start prepay is stamped at creation).
async function stampBornPaidBillingMode(term, anchorInstallation, conn) {
  if (anchorInstallation && !(await termCoversToday(term.id, conn))) return;
  await stampAnnualPrepayBillingMode(term.customer_id, conn, term.id);
}

async function termCountsAsPaidAfterCreate(term, anchorInstallation, conn) {
  if (!term) return false;
  if (ACTIVE_STATUSES.includes(term.status)) return true;
  return !!anchorInstallation && isPaidDecidedLapseTerm(term, conn);
}

// Extracted from createTermForAnnualPrepay's "existing" edit branch
// (complexity reduction, no behavior change — the eslint complexity gate
// on this diff): detaches out-of-window visits ONLY when the coverage
// window was actually edited (start/end explicitly supplied). Every
// comment and the throw-on-failure rationale are unchanged from the
// original inline block.
async function detachOutOfWindowEditedVisits(existing, updates, conn) {
  // Skipped when no dates were given (the estimate re-run path), so it
  // only fires on a real window change.
  if (!(updates.term_start || updates.term_end)) return;
  const scCols = await scheduledServiceColumns();
  if (!scCols.annual_prepay_term_id) return;
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

// Extracted from createTermForAnnualPrepay's "existing" edit branch
// (complexity reduction, no behavior change): detaches visits dropped by
// a coverage-SELECTION change (service type / visit count / cadence), as
// opposed to a date-window change (handled by detachOutOfWindowEditedVisits
// above). Every comment is unchanged from the original inline block.
async function detachDroppedCoverageSelectionVisits(existing, {
  normalizedCoverageServiceType, normalizedCoverageVisitCount, normalizedCoverageCadence,
}, conn) {
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
  if (!coverageSelectionChanged) return;
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
  // Termite annual plan marker (codex #4819 r7 P1). Written WITH the row so
  // the refreshTermSnapshot below already sees coverageAwaitsInstallation():
  // stamped after this returns, the first refresh would seed a signature-day
  // coverage visit before the installation ever anchors the term.
  annualPlanVersion = undefined,
  // Renewal successor marker (slice 6b, termite-annual-renewal-charge.js).
  // Written WITH the row for the SAME reason as annualPlanVersion above:
  // coverageAwaitsInstallation() reads `!term.renewed_from_term_id` to tell
  // a renewal successor apart from a brand-new signed plan awaiting its
  // installation visit — a renewal never awaits an installation, so this
  // must be present before the refreshTermSnapshot call below runs its
  // seeding decision, or a successor's coverage visits would wrongly defer.
  renewedFromTermId = undefined,
  // Codex round-1 P1: renewal-charge consent provenance (ruling A-13). The
  // ONLY writer of this column is the original signed agreement
  // (termite-annual-activation.js); a renewal successor never signs a new
  // one, so the mint (termite-annual-renewal-charge.js's
  // mintRenewalSuccessor) carries the PARENT's own timestamp forward
  // explicitly — the SAME consent covers every renewal under it, chained
  // year over year (a year-2 successor's own renewalChargeConsentAt is set
  // here too, so its OWN eventual year-3 mint carries it forward again).
  renewalChargeConsentAt = undefined,
  // Codex pre-push P1: set only by anchorTermToInstallation's window-move
  // call — lets a decided-lapse (declined-before-install) term's paid
  // coverage year reconcile/re-stamp exactly like a normal anchored term
  // (termCountsAsPaidAfterCreate). Every other caller leaves it unset
  // (byte-identical to before this option existed).
  anchorInstallation,
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
    // Codex #4971 round-20 P1 (charge.js:1581): stamp the moment this term's
    // OWN window actually moves. parentChangedAtSql (the renewal charge's
    // "when did the parent stop authorizing its renewal" scan, read by both
    // paidAfterParentChanged and leg 7e's late-paid backstop) has no arm for
    // a term-window edit on a parent that otherwise still authorizes its
    // renewal (still active/renewal_pending, or renewed with a 'renew'
    // decision) — so a successor paid after a plain date edit was never
    // dated as "paid after a change", the refund-or-honor bell never rang,
    // and recordParentRenewedIfEligible kept rejecting the same paid
    // successor forever with no escalation. Column-tolerant (a narrow
    // schema without the column just skips the stamp) and VALUE-compared,
    // never presence-compared — resupplying the SAME dates (the estimate
    // re-run path, a no-op save) must not read as a move.
    const startMoved = Object.prototype.hasOwnProperty.call(updates, 'term_start')
      && dateOnly(existing.term_start) !== updates.term_start;
    const endMoved = Object.prototype.hasOwnProperty.call(updates, 'term_end')
      && dateOnly(existing.term_end) !== updates.term_end;
    const windowMoved = startMoved || endMoved;
    if (termCols.term_window_changed_at) {
      if (windowMoved) {
        // Codex #4971 r25 P1: keep the FIRST move made after the current
        // renewal successor was minted. A later correction must not push
        // the stamp past a payment that followed the first invalidating
        // move (paidAfterParentChanged would then read "paid before the
        // change" and lose the refund-or-honor alert). An existing stamp
        // that predates the successor's mint (an installation anchor, an
        // old correction) is not a post-mint move and IS replaced.
        let keepFirstPostMintMove = false;
        if (existing.term_window_changed_at && termCols.renewed_from_term_id) {
          const successor = await conn('annual_prepay_terms')
            .where({ renewed_from_term_id: existing.id })
            .orderBy('created_at', 'desc')
            .first('created_at');
          keepFirstPostMintMove = Boolean(successor?.created_at)
            && new Date(existing.term_window_changed_at).getTime() > new Date(successor.created_at).getTime();
        }
        if (!keepFirstPostMintMove) updates.term_window_changed_at = new Date();
      }
    }
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
    if (termCols.annual_plan_version && annualPlanVersion && !existing.annual_plan_version) {
      updates.annual_plan_version = annualPlanVersion;
    }
    const carryForward = renewalCarryForwardColumns(termCols, existing, renewedFromTermId, renewalChargeConsentAt);
    if (carryForward.renewedFromTermId !== undefined) updates.renewed_from_term_id = carryForward.renewedFromTermId;
    if (carryForward.renewalChargeConsentAt !== undefined) updates.renewal_charge_consent_at = carryForward.renewalChargeConsentAt;
    await conn('annual_prepay_terms').where({ id: existing.id }).update(updates);
    // Synchronous withdrawal (owner ruling 2026-09-28): a window move on a
    // termite parent is a durable parent_term_moved refusal for its unpaid
    // renewal — withdraw it right after this edit commits.
    if (windowMoved && existing.annual_plan_version) {
      // Codex #5197 r1 P1: the edited term may be the unpaid SUCCESSOR
      // itself (edited through its own prepay invoice) — then it is the
      // one that no longer abuts its parent, and it is withdrawn directly.
      const successorItself = Boolean(existing.renewed_from_term_id);
      await require('./termite-annual-renewal-charge').afterParentChange(
        conn, existing.id, successorItself ? 'the renewal dates were changed' : 'the prior term dates were changed', { successorItself },
      );
    }
    // When the coverage window is edited (start/end actually supplied), detach
    // any visits attachScheduledServices() stamped under the old window that now
    // fall outside it — refreshTermSnapshot only re-attaches in-window visits, it
    // never removes out-of-window ones, so a shortened/moved window would keep
    // reporting stale visits as Annual Prepay.
    await detachOutOfWindowEditedVisits(existing, updates, conn);
    await detachDroppedCoverageSelectionVisits(existing, {
      normalizedCoverageServiceType, normalizedCoverageVisitCount, normalizedCoverageCadence,
    }, conn);
    await syncInvoiceTerm(prepayInvoiceId, existing.id, conn);
    const refreshed = await refreshTermSnapshot(existing.id, conn);
    if (await termCountsAsPaidAfterCreate(refreshed, anchorInstallation, conn)) {
      await syncCustomerRenewalDate(customerId, dateOnly(refreshed.term_end), conn);
      // A term that is ACTIVE (or a paid decided-lapse) here was born (or
      // re-anchored) already paid — the Customer 360 flow records the
      // invoice payment BEFORE creating the term, so syncTermForInvoicePayment
      // never fires for it and its pending-window completed visits would
      // stay double-billed. Run the same reconcile the payment sync runs
      // (post-commit when inside a caller trx); idempotent, so terms that
      // DID arrive through the payment sync are unaffected.
      await reconcileBornPaidTerm(refreshed, conn);
      // Stamp only once the term is genuinely paid (ACTIVE, or a paid
      // decided-lapse anchoring its coverage year). A payment_pending term
      // must leave the customer 'per_application': pending-window
      // completions bill per application until the annual invoice is paid,
      // and the annual_prepay stamp would divert them to the
      // monthly-membership dispatch path (Codex round-2). The payment sync
      // (syncTermForInvoicePayment) stamps on pending→active.
      await stampBornPaidBillingMode(refreshed, anchorInstallation, conn);
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
  if (termCols.annual_plan_version && annualPlanVersion) {
    insert.annual_plan_version = annualPlanVersion;
  }
  const insertCarryForward = renewalCarryForwardColumns(termCols, null, renewedFromTermId, renewalChargeConsentAt);
  if (insertCarryForward.renewedFromTermId !== undefined) insert.renewed_from_term_id = insertCarryForward.renewedFromTermId;
  if (insertCarryForward.renewalChargeConsentAt !== undefined) insert.renewal_charge_consent_at = insertCarryForward.renewalChargeConsentAt;

  const [term] = await conn('annual_prepay_terms').insert(insert).returning('*');

  await syncInvoiceTerm(prepayInvoiceId, term.id, conn);
  const refreshed = await refreshTermSnapshot(term.id, conn);
  // A brand-new insert never carries a renewal_decision, so this stays
  // ACTIVE-only in practice (same rule as the "existing" branch above).
  if (await termCountsAsPaidAfterCreate(refreshed, anchorInstallation, conn)) {
    await syncCustomerRenewalDate(customerId, normalizedEnd, conn);
    // Born already paid (Customer 360 records the payment before creating the
    // term), so the payment sync's reconcile never fires for this term — run
    // it here (post-commit when inside a caller trx) or its pending-window
    // completed visits stay double-billed.
    await reconcileBornPaidTerm(refreshed, conn);
    // ACTIVE (born-paid) only — a payment_pending term keeps the customer
    // 'per_application' so pre-payment completions bill per application; the
    // payment sync stamps when the invoice pays (Codex round-2).
    await stampBornPaidBillingMode(refreshed, anchorInstallation, conn);
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

// Termite-only preflight: one decision for whether a rung may send, and
// with which copy. The 45-day rung exists ONLY for termite annual-plan terms
// (checkAndSend's query already restricts it; a direct caller is guarded
// here too). Termite copy (45/30 days out) discloses the auto-renew terms,
// a real renewal fee and a portal cancel link, so it fails closed (skip +
// admin bell) when the cancel flow is off or no fee is on file rather than
// falling back to generic copy that omits the disclosure, or to a "$0.00"
// fee (formatCurrencyLabel treats a missing amount as 0).
async function termiteNoticePreflight(term, daysOut) {
  const n = Number(daysOut);
  const termite = isTermiteAnnualPlanTerm(term);
  if (n === TERMITE_EXTRA_NOTICE_DAYS && !termite) return { blocked: 'not_termite_plan' };
  // Blocks EVERY rung (45/30/15/7), not just the termite-copy ones — see
  // fileTermiteAwaitingInstallationException for why an unanchored original
  // must never get a renewal notice of any shape.
  if (termite && coverageAwaitsInstallation(term)) {
    await fileTermiteAwaitingInstallationException(term, daysOut);
    return { blocked: 'awaiting_installation' };
  }
  const termiteRung = TERMITE_COPY_NOTICE_DAYS.includes(n) && termite;
  if (!termiteRung) return { termiteRung: false };
  if (!CancellationResolution.cancelFlowV2Enabled()) {
    await fileTermiteCancelLinkException(term, daysOut);
    return { blocked: 'cancel_flow_disabled' };
  }
  if (term.prepay_amount == null || term.prepay_amount === '') {
    await fileTermiteMissingFeeException(term, daysOut);
    return { blocked: 'missing_prepay_amount' };
  }
  return { termiteRung: true };
}

// The late-notice column for a termite rung, or null when daysOut isn't
// one of the two termite rungs (45/30).
function termiteLateColumnForDaysOut(daysOut) {
  const n = Number(daysOut);
  if (n === TERMITE_EXTRA_NOTICE_DAYS) return TERMITE_LATE_NOTICE_COLUMN;
  if (n === 30) return TERMITE_30_LATE_NOTICE_COLUMN;
  return null;
}

// Which column a delivered notice is recorded in. Both termite rungs' "on
// time" witnesses (notice_45_sent_at / notice_30_sent_at) are contractual
// proof — the signed v3 agreement promises written notice "at least 45
// days AND again 30 days" before the renewal date (term_end); the renewal-
// charge gate (slice 6b) reads notice_45_sent_at specifically. A send fewer
// than the rung's own threshold out still informs the customer but is
// recorded in the rung's *_late_sent_at column, never as its witness
// (Codex #4921 r1 P1, generalized to 30 in r3). A non-termite term (or a
// non-termite rung: 15/7) never reaches the late branch — the generic
// 30/15/7 loop excludes termite terms from its own 30-day pass, and 15/7
// have no late column at all.
function noticeWitnessColumn(daysOut, term, today = etDateString()) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const lateCol = isTermiteAnnualPlanTerm(term) ? termiteLateColumnForDaysOut(daysOut) : null;
  if (!lateCol) return noticeCol;
  const daysLeft = daysUntil(today, dateOnly(term.term_end));
  return daysLeft != null && daysLeft >= Number(daysOut) ? noticeCol : lateCol;
}

// Every column that means "this rung already went out" — for a termite
// term's 45/30 rungs, a late send counts too, so the daily retry never
// re-sends it.
function noticeDoneColumns(daysOut, term) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const lateCol = isTermiteAnnualPlanTerm(term) ? termiteLateColumnForDaysOut(daysOut) : null;
  return lateCol ? [noticeCol, lateCol] : [noticeCol];
}

async function renderTermNoticeSms({ termiteRung, customer, term, addressShort, cancelLink }) {
  if (termiteRung) {
    return renderSmsTemplate(
      'termite_annual_renewal_notice',
      {
        first_name: customer.first_name || 'there',
        address_short: addressShort,
        renewal_date: formatDateLabel(term.term_end),
        renewal_fee: formatCurrencyLabel(term.prepay_amount),
        cancel_link: cancelLink,
      },
      { workflow: 'termite_annual_renewal_notice', entity_type: 'annual_prepay_term', entity_id: term.id },
    );
  }
  const lastServiceDate = dateOnly(term.last_scheduled_service_date);
  const lastServiceSentence = lastServiceDate && isLastServiceNearTermEnd(term)
    ? ` The last service currently on your schedule for this prepaid term is ${formatDateLabel(lastServiceDate)}.`
    : '';
  return renderSmsTemplate(
    'annual_prepay_renewal_reminder',
    {
      first_name: customer.first_name || 'there',
      term_end: formatDateLabel(term.term_end),
      last_service_sentence: lastServiceSentence,
    },
    { workflow: 'annual_prepay_renewal_reminder', entity_type: 'annual_prepay_term', entity_id: term.id },
  );
}

// The protected property for the notice: a termite plan names its OWN
// property (source estimate); everything else uses the customer's address.
async function termNoticeAddress(termiteRung, term, customer) {
  const planProperty = termiteRung ? await planPropertyForTerm(term) : null;
  const source = planProperty || customer;
  const addressShort = [source.address_line1, source.city].filter(Boolean).join(', ') || 'your property';
  const planAddress = planProperty
    ? [planProperty.address_line1, planProperty.address_line2, planProperty.city, planProperty.state, planProperty.zip].filter(Boolean).join(', ')
    : null;
  return { addressShort, planAddress };
}

// Renewal email leg. Returns true only on a confirmed send. Termite
// renewal-date convention: term_end IS the renewal/charge date, and term_end
// is INCLUSIVE coverage (coveredTermsAsOf reads term_start <= d AND
// term_end >= d; the admin term guard requires a successor's start > the
// prior term_end). So the successor 12-month window starts the day AFTER
// term_end and ends on the next anniversary — no overlap, no drift.
async function sendTermNoticeEmail({
  termiteRung, customer, term, daysOut, cancelLink, planAddress, coversRungs = null,
}) {
  try {
    // newEnd is derived from newStart, not from term_end directly — exactly
    // how createTermForAnnualPrepay defaults a fresh term's end (start +
    // 12mo same-day) — so the notice's stated coverage window never
    // disagrees with the successor slice 6b actually mints. Deriving it
    // from term_end instead would drift by a day whenever the +12mo
    // same-day clamp lands differently for the two start dates (e.g.
    // term_end 2027-02-28 → newStart 2027-03-01: newStart+12mo is
    // 2028-03-01, but term_end+12mo clamps to 2028-02-28 — a full day off).
    const newStart = addDaysYmd(dateOnly(term.term_end), 1);
    const result = termiteRung
      ? await AccountMembershipEmail.sendTermiteRenewalReminder({
        customerId: customer.id,
        termId: term.id,
        daysOut,
        renewalDate: term.term_end,
        renewalFee: term.prepay_amount,
        newStart,
        newEnd: addMonthsSameDay(newStart, 12),
        cancelLink,
        address: planAddress,
        // Combined 30+45 send only: the evidence marker (see sendCustomerTermNotice).
        ...(coversRungs ? { coversRungs } : {}),
        // No annual-inspection date is tracked anywhere yet (the signed
        // annual report is a later slice per the build brief) — always
        // unknown for now, so the email's last-inspection sentence is
        // always omitted rather than guessing at last_scheduled_service_date
        // (which can be a FUTURE scheduled visit, not a completed one).
        lastInspectionDate: null,
      })
      : await AccountMembershipEmail.sendMembershipRenewalReminder({
        customerId: customer.id,
        renewalDate: term.term_end,
        daysOut,
        termId: term.id,
        lastServiceDate: dateOnly(term.last_scheduled_service_date),
      });
    const confirmed = result?.sent === true || result?.ok === true;
    if (!confirmed) logger.warn(`[annual-prepay] renewal email not sent for term ${term.id}: ${result?.reason || 'not_sent'}`);
    return { confirmed, acceptedAt: confirmed ? originalEmailAcceptance(result) : null };
  } catch (err) {
    logger.warn(`[annual-prepay] renewal email failed for term ${term.id}: ${err.message}`);
    return { confirmed: false, acceptedAt: null };
  }
}

// The provider acceptance time of a confirmed email send. Codex #4921 r4
// P1: when the email layer dedupes a retry against an email the provider
// ALREADY accepted (same per-term+rung idempotency key), this is that
// ORIGINAL acceptance time — otherwise an email accepted on time on day 45
// whose witness write failed would be re-stamped from tomorrow's retry as
// LATE. A fresh send carries its own email_messages.sent_at too (pre-push
// P1 class fix: the witness is always decided from the provider's
// acceptance, never an unrelated "now"). A missing/invalid time, or one in
// the future, returns null (caller uses "now").
function originalEmailAcceptance(result) {
  return acceptanceTimeFrom(result?.sentAt);
}

// Codex #4921 r11 P1: the termite 45/30-day rungs are the signed v3
// agreement's REQUIRED renewal notice (renewal date, renewal fee, the
// auto-charge, how to cancel) — account-operational, not marketing. Purpose
// 'retention' is marketing-grade (policy.js: requireConsent 'marketing' +
// seasonal_tips === true), which silently withheld the legally required text
// from every customer who never opted into seasonal tips. They go out as
// 'billing' — transactional, no per-purpose opt-out (owner ruling
// 2026-08-01: account-operational notices, like a receipt) — while STOP
// (sms_enabled=false), suppression, identity and the send window still
// apply, and a customer's explicit billing-channel choice still routes the
// text (the email leg always carries the notice too). The generic 30/15/7
// annual-prepay reminder (non-termite terms, and a termite term's 15/7) is
// unchanged: a courtesy renewal reminder, not a contractual notice.
function termNoticeSmsPolicy(termiteRung, customer) {
  if (termiteRung) {
    return {
      purpose: 'billing',
      consentBasis: { status: 'transactional_allowed', source: 'termite_annual_plan_agreement_v3' },
    };
  }
  return {
    purpose: 'retention',
    consentBasis: {
      status: 'opted_in',
      source: 'customer_retention_preferences',
      capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
    },
  };
}

function sendTermNoticeSms({
  customer, body, smsTemplateKey, term, daysOut, extraMetadata, termiteRung = false,
}) {
  const { purpose, consentBasis } = termNoticeSmsPolicy(termiteRung, customer);
  return sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose,
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'annual_prepay_renewal',
    consentBasis,
    // A termite notice is a billing-purpose send, which activates explicit
    // billing-channel fan-out: declare that this notice's own termite email
    // sender owns the email leg, so an email-selected customer never gets a
    // second, generic billing email (untracked by acceptance recovery). An
    // email-only selection returns CHANNEL_EMAIL_ONLY → the email leg sends.
    ...(termiteRung ? { hasEmailLeg: true } : {}),
    metadata: {
      original_message_type: smsTemplateKey,
      annual_prepay_term_id: term.id,
      days_out: daysOut,
      ...(extraMetadata || {}),
    },
  });
}

async function recordTermNoticeInteraction(customerId, termiteRung, daysOut) {
  await db('customer_interactions').insert({
    customer_id: customerId,
    interaction_type: 'sms_outbound',
    channel: 'sms',
    subject: termiteRung
      ? `Termite annual renewal - ${daysOut}-day notice`
      : `Annual prepay renewal - ${daysOut}-day reminder`,
    body: termiteRung
      ? `Automated termite annual renewal notice sent (${daysOut} days out)`
      : `Automated annual prepay renewal reminder sent (${daysOut} days out)`,
  }).catch((err) => logger.warn(`[annual-prepay] interaction insert failed: ${err.message}`));
}

// Claim a rung for one term (15-minute TTL claim; a stale claim is
// re-claimable). Moves an active term to renewal_pending. Null when another
// sender holds it, the rung already went out, or the term was decided.
// baseline (Codex #4921 r8): the generic ladder's fallback when the termite
// notice schema is NOT ready — the claim then names only baseline columns
// (no late column), so a pre-000106 schema cannot throw here.
async function claimTermNotice(term, daysOut, baseline = false) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const claimCol = noticeClaimColumnForDaysOut(daysOut);
  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);
  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNull(noticeCol)
    .where(lateTermiteSendAbsent(daysOut, term, baseline))
    .where(function noticeClaimAvailable() {
      this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
    })
    .update({
      [claimCol]: now,
      status: term.status === 'active' ? 'renewal_pending' : term.status,
      updated_at: now,
    })
    .returning('*');
  return withClaimStamp(claimedTerm, [claimCol], now);
}

// The claimed row, carrying the exact claim timestamp(s) THIS attempt wrote
// — what the release matches on (Codex #4921 r8), never a later claimer's.
function withClaimStamp(claimedTerm, claimCols, now) {
  if (!claimedTerm) return null;
  const stamped = { ...claimedTerm };
  for (const col of claimCols) stamped[col] = claimedTerm[col] || now;
  return stamped;
}

// Codex #4921 r7 P1: a COMBINED 30+45 notice (both rungs discharged by one
// send, the 45 recorded late) must hold BOTH rungs' claims, taken together
// in ONE conditional UPDATE — both claims available and both rungs wholly
// unrecorded — before anything is sent. Claiming only the 30 let a second
// cron instance concurrently claim the 45 on its own and race its witness
// against the combined send's late-45 record. Literal columns: the combined
// pair is always the 30-day send covering the 45-day rung. Null when the
// term is not in that state (the caller defers to the next run).
async function claimCombinedTermNotice(term) {
  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - NOTICE_CLAIM_TTL_MS);
  const [claimedTerm] = await db('annual_prepay_terms')
    .where({ id: term.id })
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNull('notice_30_sent_at')
    .whereNull('notice_30_late_sent_at')
    .whereNull('notice_45_sent_at')
    .whereNull('notice_45_late_sent_at')
    .where(function claim30Available() {
      this.whereNull('notice_30_claimed_at').orWhere('notice_30_claimed_at', '<', staleClaimCutoff);
    })
    .where(function claim45Available() {
      this.whereNull('notice_45_claimed_at').orWhere('notice_45_claimed_at', '<', staleClaimCutoff);
    })
    .update({
      notice_30_claimed_at: now,
      notice_45_claimed_at: now,
      status: term.status === 'active' ? 'renewal_pending' : term.status,
      updated_at: now,
    })
    .returning('*');
  return withClaimStamp(claimedTerm, ['notice_30_claimed_at', 'notice_45_claimed_at'], now);
}

// Releases BOTH claims a combined send took — the rollback of
// claimCombinedTermNotice, with the same ownership rule as
// releaseTermNoticeClaim: the pre-claim status is restored ONLY while the
// row still holds exactly what THIS attempt wrote (status renewal_pending,
// both claims at this attempt's timestamp); otherwise only this attempt's
// own claim columns are cleared and the status is left alone.
async function releaseCombinedTermNoticeClaim(claimedTerm, previousStatus) {
  const claimedAt30 = claimedTerm.notice_30_claimed_at;
  const claimedAt45 = claimedTerm.notice_45_claimed_at;
  try {
    const restored = await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull('renewal_decision')
      .whereNull('notice_30_sent_at')
      .where('status', 'renewal_pending')
      .where('notice_30_claimed_at', claimedAt30)
      .where('notice_45_claimed_at', claimedAt45)
      .update({
        notice_30_claimed_at: null,
        notice_45_claimed_at: null,
        status: previousStatus,
        updated_at: new Date(),
      });
    if (restored) return;
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .where('notice_30_claimed_at', claimedAt30)
      .update({ notice_30_claimed_at: null, updated_at: new Date() });
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .where('notice_45_claimed_at', claimedAt45)
      .update({ notice_45_claimed_at: null, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] combined notice claim release failed for term ${claimedTerm.id}: ${err.message}`);
  }
}

// Claim for one delivery: the combined pair, or the single rung (baseline
// columns only when the termite notice schema is not ready).
function claimForDelivery(term, daysOut, combined, baseline = false) {
  return combined ? claimCombinedTermNotice(term) : claimTermNotice(term, daysOut, baseline);
}

function releaseForDelivery(claimedTerm, daysOut, previousStatus, combined) {
  return combined
    ? releaseCombinedTermNoticeClaim(claimedTerm, previousStatus)
    : releaseTermNoticeClaim(claimedTerm, daysOut, previousStatus);
}

// For a termite term's 45/30 rung, a late catch-up send also counts as
// "already went out" (its own *_late_sent_at column), so it is never
// re-claimed or re-sent. Every other case (15/7, or a non-termite term at
// any daysOut, including the generic 30-day rung) gets an empty group
// (knex drops it) — a non-termite term never writes either late column in
// the first place, so this is a no-op for it either way.
// baseline: the schema-not-ready fallback names no late column at all.
function lateTermiteSendAbsent(daysOut, term, baseline = false) {
  return function lateTermiteSendAbsentGroup() {
    const lateCol = !baseline && isTermiteAnnualPlanTerm(term) ? termiteLateColumnForDaysOut(daysOut) : null;
    if (lateCol) this.whereNull(lateCol);
  };
}

// Releases a notice claim this process took (the rung still unsent and the
// term undecided), restoring the status the claim moved it from. The ONE
// claim-release status write — shared by the send path and the
// acceptance-recovery path.
//
// Codex #4921 r8 P1: the release is conditional on the state THIS attempt
// wrote. The status is restored only WHERE status = 'renewal_pending' (what
// the claim set) AND the claim column still holds this attempt's exact
// claim timestamp — a refund, void or dispute that moved the status
// meanwhile (or a successor that re-claimed after the TTL) is never
// overwritten. Otherwise only this attempt's own claim is cleared (matched
// by timestamp) and the status is left alone.
async function releaseTermNoticeClaim(claimedTerm, daysOut, previousStatus) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const claimCol = noticeClaimColumnForDaysOut(daysOut);
  const claimedAt = claimedTerm[claimCol];
  try {
    const restored = await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull('renewal_decision')
      .whereNull(noticeCol)
      .where('status', 'renewal_pending')
      .where(claimCol, claimedAt)
      .update({
        [claimCol]: null,
        status: previousStatus,
        updated_at: new Date(),
      });
    if (restored) return;
    await db('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .where(claimCol, claimedAt)
      .update({ [claimCol]: null, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[annual-prepay] notice claim release failed for term ${claimedTerm.id}: ${err.message}`);
  }
}

// THE single place a notice witness is written. The witness column is always
// decided from `sentAt` — the time the provider ACCEPTED the notice (a
// recovered original acceptance, a deduped email's original sent_at, or the
// SMS provider's own acceptance time), never an unrelated "now" — so on-time
// vs late is a fact about delivery, not about when bookkeeping happened.
//
// Combined send (alsoRecordMissedRung): the OTHER rung's late record commits
// in the SAME transaction as this rung's witness, and only while that other
// rung still has NO record at all — neither late nor its own on-time witness
// (Codex #4921 pre-push P1: an on-time 45 recovered from persisted evidence
// must never be overwritten/duplicated as late). Its late bell rings only if
// that late record actually landed; this rung's late bell only if this
// rung's own late record landed.
// missedRungAt: when the other rung's obligation was actually discharged —
// the combined send's own acceptance time (defaults to sentAt; a recovery
// passes the covering evidence's time).
//
// Returns 'stamped' | 'already_recorded' | 'conflict'. Codex #4921 r7 P1: a
// witness UPDATE that matches ZERO rows is never silently "recorded" — the
// term is re-read: the same column already holding a witness (another
// sender recorded the same fact) is benign; anything else (e.g. our on-time
// evidence rejected because a late record landed first) is a witness
// CONFLICT, logged and belled for staff.
//
// Combined: the caller holds BOTH claims (claimCombinedTermNotice), so the
// other rung's claim is cleared with its late record.
// baseline (schema-not-ready fallback, exact-day send): the rung's own
// column only — no late classification, no late predicate.
async function stampTermNoticeWitness(claimedTerm, daysOut, sentAt, { alsoRecordMissedRung = null, missedRungAt = null, baseline = false, freezeNoticedFee = true } = {}) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  const claimCol = noticeClaimColumnForDaysOut(daysOut);
  const sentCol = baseline ? noticeCol : noticeWitnessColumn(daysOut, claimedTerm, etDateString(sentAt));
  const lateCol = alsoRecordMissedRung ? termiteLateColumnForDaysOut(alsoRecordMissedRung) : null;
  const missedRungWitnessCol = alsoRecordMissedRung ? noticeColumnForDaysOut(alsoRecordMissedRung) : null;
  const missedClaimCol = alsoRecordMissedRung ? noticeClaimColumnForDaysOut(alsoRecordMissedRung) : null;
  let stamped = null;
  let otherRecorded = null;
  await db.transaction(async (trx) => {
    // Codex #4971 r23 P1: the termite 45-day rung quotes term.prepay_amount
    // to the customer — freeze that fee WITH the witness
    // (renewal_noticed_fee, 20260928030000) so the renewal mint can refuse
    // to bill or charge a fee the customer was never told. Column-tolerant
    // by ROW SHAPE (the claimed row is the table's own `returning('*')`, so
    // it carries the key exactly when the schema has the column) — no extra
    // probe query on this transaction.
    // Codex #4971 r28 P1: ONLY the live send freezes the fee — it stamps
    // right after rendering it. A witness RECOVERED later from provider
    // acceptance evidence (recoverTermiteNoticeFromAcceptance) was rendered
    // at some earlier moment; the term's fee today may not be the fee that
    // message quoted, so recovery freezes nothing and the mint fails closed
    // (notice_fee_unfrozen) until staff record the quoted fee.
    const freezeFee = freezeNoticedFee && daysOut === TERMITE_EXTRA_NOTICE_DAYS
      && claimedTerm.prepay_amount != null && claimedTerm.prepay_amount !== ''
      && Object.prototype.hasOwnProperty.call(claimedTerm, 'renewal_noticed_fee');
    stamped = await trx('annual_prepay_terms')
      .where({ id: claimedTerm.id })
      .whereNull(noticeCol)
      .where(lateTermiteSendAbsent(daysOut, claimedTerm, baseline))
      .where(ownsNoticeClaims(claimedTerm, [claimCol, missedClaimCol]))
      .update({
        [sentCol]: sentAt,
        [claimCol]: null,
        updated_at: new Date(),
      });
    // Its own plain write, only once the witness actually stamped — the
    // witness update above stays a literal with no spread (the term-states
    // pin test reads every write object on this table).
    if (stamped && freezeFee) {
      await trx('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .update({ renewal_noticed_fee: claimedTerm.prepay_amount });
    }
    if (lateCol && stamped) {
      otherRecorded = await trx('annual_prepay_terms')
        .where({ id: claimedTerm.id })
        .whereNull(lateCol)
        .whereNull(missedRungWitnessCol)
        .update({ [lateCol]: missedRungAt || sentAt, [missedClaimCol]: null, updated_at: new Date() });
    }
  });
  if (!stamped) return resolveUnstampedWitness(claimedTerm, daysOut, sentCol, sentAt);
  if (sentCol === termiteLateColumnForDaysOut(daysOut)) await fileTermiteLateNoticeException(claimedTerm, daysOut);
  // Pre-push audit P1: the combined-send case (both rungs due at once —
  // see processTermiteNoticeObligations) records the OTHER rung as
  // missed/late ONLY here, after THIS rung's send is confirmed delivered —
  // never before attempting the send, so a failed combined send leaves BOTH
  // rungs' columns untouched and simply retries tomorrow. Staff escalation
  // for the other rung comes AFTER the atomic stamp; the late-escalation
  // retry pass re-rings it if this bell fails.
  if (lateCol && otherRecorded) await fileTermiteLateNoticeException(claimedTerm, alsoRecordMissedRung);
  return 'stamped';
}

// Codex #4921 r10 P2: the witness stamp requires that THIS attempt still
// owns its claim(s) — each claim column still equals the exact timestamp
// this attempt wrote (both columns for a combined send), like the release.
// A worker whose lease was lost (reclaimed after the TTL) matches zero rows,
// so it never stamps over — or clears — the new holder's claim; the
// zero-row path then re-reads and classifies.
function ownsNoticeClaims(claimedTerm, claimCols) {
  return function ownsNoticeClaimsGroup() {
    for (const col of claimCols) {
      if (col) this.where(col, claimedTerm[col] ?? null);
    }
  };
}

// A witness UPDATE matched zero rows: re-read and classify (see
// stampTermNoticeWitness). Never throws past a failed bell.
async function resolveUnstampedWitness(claimedTerm, daysOut, sentCol, sentAt) {
  const current = await db('annual_prepay_terms').where({ id: claimedTerm.id }).first();
  const recordedCols = current ? noticeDoneColumns(daysOut, current).filter((col) => current[col]) : [];
  if (recordedCols.includes(sentCol)) {
    logger.info(`[annual-prepay] ${daysOut}-day notice witness for term ${claimedTerm.id} was already recorded (${sentCol}) by another sender`);
    return 'already_recorded';
  }
  logger.error(`[annual-prepay] ${daysOut}-day notice witness CONFLICT for term ${claimedTerm.id}: accepted at ${sentAt.toISOString()} → ${sentCol}, but the term already has ${recordedCols.join(', ') || 'no row'}`);
  const conflict = {
    days_out: Number(daysOut),
    intended_column: sentCol,
    recorded_columns: recordedCols,
    accepted_at: sentAt.toISOString(),
    detected_at: new Date().toISOString(),
  };
  await recordWitnessConflict(claimedTerm.id, conflict);
  await fileTermiteWitnessConflictException(current || claimedTerm, conflict);
  return 'conflict';
}

// ── Witness-conflict record: one entry PER RUNG (pre-push audit P1) ───────
//
// notice_witness_conflict is an object keyed by rung —
//   { "45": { ...details, belled_at? }, "30": { ...details, belled_at? } }
// — merged with jsonb `||`, so a conflict on one rung never erases another
// rung's pending entry or its retry. Each rung's bell confirmation lives in
// its own entry (belled_at); notice_witness_conflict_belled_at is the
// "every rung belled" summary (NULL while any rung is unbelled), so the
// sweep's candidate query is unchanged. Backward compatible: a record in the
// old flat shape (one conflict, top-level days_out, confirmation in the
// summary column) is normalized into the keyed shape on its next write and
// read as a single entry until then. jsonb_exists() rather than `?` — knex
// treats `?` as a binding placeholder.
const WITNESS_CONFLICT_KEYED_SQL = `(CASE WHEN jsonb_exists(notice_witness_conflict, 'days_out')
  THEN jsonb_build_object(notice_witness_conflict->>'days_out', notice_witness_conflict
    || CASE WHEN notice_witness_conflict_belled_at IS NOT NULL
      THEN jsonb_build_object('belled_at', notice_witness_conflict_belled_at) ELSE '{}'::jsonb END)
  ELSE COALESCE(notice_witness_conflict, '{}'::jsonb) END)`;

// Persist the conflict under its rung (replacing only that rung's entry, so
// it is unbelled again) and clear the all-belled summary, so a failed bell is
// re-filed by the daily sweep. Best-effort: a missing column (pre-000109) or
// a write failure still leaves the immediate bell attempt below.
async function recordWitnessConflict(termId, conflict) {
  try {
    const cols = await annualPrepayColumns();
    if (!witnessConflictColumnsReady(cols)) return;
    await db('annual_prepay_terms')
      .where({ id: termId })
      .update({
        notice_witness_conflict: db.raw(`${WITNESS_CONFLICT_KEYED_SQL} || jsonb_build_object(?::text, ?::jsonb)`, [
          String(conflict.days_out), JSON.stringify(conflict),
        ]),
        notice_witness_conflict_belled_at: null,
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[annual-prepay] recording witness conflict failed for term ${termId}: ${err.message}`);
  }
}

// Staff bell for a witness conflict: the customer WAS notified, but the
// term's record disagrees with this delivery's evidence (e.g. on-time
// evidence vs a late record another sender wrote first). The renewal-charge
// gate reads notice_45_sent_at, so staff must reconcile before it renews.
// Codex #4921 r10 P2: the notifyAdmin result is verified — the confirmed-
// bell stamp lands ONLY on a non-null result, so a failed insert leaves the
// persisted conflict unbelled for the daily sweep to re-file. Returns true
// only on a confirmed bell.
async function fileTermiteWitnessConflictException(term, conflict) {
  try {
    const NotificationService = require('./notification-service');
    const result = await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice record conflict',
      `The ${conflict.days_out}-day renewal notice for term ${term.id} (renews ${formatDateLabel(term.term_end)}) was accepted at ${conflict.accepted_at}, which records as ${conflict.intended_column}, but the term already shows ${conflict.recorded_columns.join(' and ') || 'no record'} from another sender. Check the message history and correct the record before this renewal is charged.`,
      {
        link: termiteAlertLink(term),
        bell: true,
        dedupeKey: `termite-annual-notice:${term.id}:${conflict.days_out}:witness_conflict`,
        metadata: {
          customerId: term.customer_id || null,
          annual_prepay_term_id: term.id,
          days_out: conflict.days_out,
          reason: 'notice_witness_conflict',
          intended_column: conflict.intended_column,
          recorded_columns: conflict.recorded_columns,
        },
      },
    );
    if (!result) {
      logger.warn(`[annual-prepay] termite witness-conflict bell insert failed for term ${term.id}; will retry on the next sweep`);
      return false;
    }
    await stampWitnessConflictBelled(term.id, conflict.days_out);
    return true;
  } catch (err) {
    logger.warn(`[annual-prepay] termite witness-conflict notification failed for term ${term?.id}: ${err.message}`);
    return false;
  }
}

// Confirm ONE rung's bell inside the keyed record, then set the all-belled
// summary only once no rung entry is left unbelled (evaluated on the locked
// row, so a conflict recorded concurrently for another rung keeps it NULL).
async function stampWitnessConflictBelled(termId, daysOut) {
  const cols = await annualPrepayColumns();
  if (!witnessConflictColumnsReady(cols)) return;
  const rungKey = String(daysOut);
  const now = new Date();
  await db('annual_prepay_terms')
    .where({ id: termId })
    .whereNotNull('notice_witness_conflict')
    .whereRaw(`jsonb_exists(${WITNESS_CONFLICT_KEYED_SQL}, ?)`, [rungKey])
    .update({
      notice_witness_conflict: db.raw(
        `jsonb_set(${WITNESS_CONFLICT_KEYED_SQL}, ARRAY[?::text], (${WITNESS_CONFLICT_KEYED_SQL} -> ?::text) || jsonb_build_object('belled_at', ?::timestamptz))`,
        [rungKey, rungKey, now.toISOString()],
      ),
      updated_at: now,
    });
  await db('annual_prepay_terms')
    .where({ id: termId })
    .whereNotNull('notice_witness_conflict')
    .whereNull('notice_witness_conflict_belled_at')
    .whereRaw(`NOT EXISTS (SELECT 1 FROM jsonb_each(${WITNESS_CONFLICT_KEYED_SQL}) AS rung WHERE NOT jsonb_exists(rung.value, 'belled_at'))`)
    .update({ notice_witness_conflict_belled_at: now, updated_at: now });
}

// The sweep's retry point: every termite term with a persisted witness
// conflict whose bell was never confirmed.
async function termiteWitnessConflictCandidates({ conn = db } = {}) {
  return conn('annual_prepay_terms')
    .whereNotNull('annual_plan_version')
    .whereNotNull(TERMITE_WITNESS_CONFLICT_COLUMN)
    .whereNull(TERMITE_WITNESS_CONFLICT_BELLED_COLUMN)
    .select('*');
}

function parseWitnessConflict(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The per-rung conflict entries still awaiting a confirmed bell. An old flat
// record is one entry, confirmed by the summary column.
function unbelledWitnessConflicts(term) {
  const record = parseWitnessConflict(term[TERMITE_WITNESS_CONFLICT_COLUMN]);
  if (!record || typeof record !== 'object') return [];
  if (record.days_out != null) {
    return term[TERMITE_WITNESS_CONFLICT_BELLED_COLUMN] ? [] : [record];
  }
  return Object.entries(record)
    .filter(([, entry]) => entry && typeof entry === 'object' && !entry.belled_at)
    .map(([rung, entry]) => ({ ...entry, days_out: Number(entry.days_out ?? rung) }));
}

// Re-file every still-unbelled rung's bell independently; true when any
// bell was confirmed this run.
async function refileWitnessConflictBell(term) {
  let confirmed = false;
  for (const conflict of unbelledWitnessConflicts(term)) {
    if (await fileTermiteWitnessConflictException(term, { ...conflict, recorded_columns: conflict.recorded_columns || [] })) confirmed = true;
  }
  return confirmed;
}

// Codex #4921 pre-push P1 (class fix): persisted acceptance evidence is
// consulted BEFORE any witness is decided or any notice is sent, by EVERY
// caller — the send path, the combined-send decision, and the undelivered/
// missed escalation passes. For a termite 45/30 rung with no witness yet:
// if a provider-accepted SMS or email for this term+rung is on file (an
// earlier attempt whose witness write failed), claim the rung and stamp the
// witness from that ORIGINAL acceptance time — on time or late accordingly
// — and send nothing. Returns null when there is nothing to recover (not a
// recoverable termite rung, already recorded, or no evidence), else the
// recovery result ({ sent:true, recovered:true } or { sent:false,
// reason:'already_claimed' } when another sender holds the rung).
//
// Runs BEFORE termiteNoticePreflight's send-content blocks (cancel flow
// off, missing fee): those stop a NEW send, but a notice that already went
// out is still a fact to record. An unanchored original (provisional
// term_end) is never recovered — nothing could have been sent for it.
// A lookup ERROR throws (no claim is held yet) — callers abort and retry.
//
// Every input it decides from is PERSISTED — never a call-site option:
//   which rung(s) one send covered → the evidence's own covers_rungs marker
//     (SMS audit metadata / email payload_snapshot), so a combined 30+45
//     notice whose witness write failed is recovered as BOTH rungs, in ONE
//     transaction, even when the retry is a plain single-rung call;
//   acceptance time → the evidence's sent_at;
//   on-time vs late → that time against the term row's term_end;
//   what is already recorded / claimed / the status to restore → the term row;
//   whether the covered rung has its OWN earlier acceptance → its own
//     evidence, which then wins (e.g. an on-time 45) over the combined
//     send's late record.
async function recoverTermiteNoticeFromAcceptance(term, daysOut) {
  const n = Number(daysOut);
  if (!term || !isTermiteAnnualPlanTerm(term) || !TERMITE_COPY_NOTICE_DAYS.includes(n) || coverageAwaitsInstallation(term)) return null;
  if (termiteRungRecorded(term, n)) return null;
  const prior = await priorTermiteNoticeAcceptance(term, n);
  if (!prior) {
    // No evidence of its OWN — but the 45 may have been discharged by a
    // combined 30-day send whose evidence says it covered the 45.
    if (n !== TERMITE_EXTRA_NOTICE_DAYS) return null;
    const covering = await priorTermiteNoticeAcceptance(term, 30);
    const coveredAt = covering?.coveredAt?.[TERMITE_EXTRA_NOTICE_DAYS];
    if (!coveredAt) return null;
    // The 30 not yet recorded: recover it — that stamps the 30 AND the
    // covered 45 together, atomically. Already recorded (by some other
    // path): record the covered 45 on its own, at the covering time.
    if (!termiteRungRecorded(term, 30)) {
      const both = await recoverTermiteNoticeFromAcceptance(term, 30);
      return both && both.sent ? { ...both, rungs: [30, TERMITE_EXTRA_NOTICE_DAYS] } : both;
    }
    return claimAndStampRecovered(term, n, { at: coveredAt, channel: covering.channel, coveredAt: {} });
  }
  return claimAndStampRecovered(term, n, prior);
}

function termiteRungRecorded(term, rung) {
  return noticeDoneColumns(rung, term).some((col) => term[col]);
}

// What a recovered stamp of rung n must also record, decided from the
// evidence alone. If that evidence covered the other rung (a combined send)
// and the other rung has no record: the other rung's OWN acceptance wins
// when it has any (ownOther — recovered on its own, e.g. an on-time 45);
// otherwise the combined send's late record for it (coveredOtherAt) lands
// in the SAME transaction as this rung's witness — which requires holding
// BOTH claims (combined).
async function recoveryPlan(term, n, prior) {
  const other = n === TERMITE_EXTRA_NOTICE_DAYS ? 30 : TERMITE_EXTRA_NOTICE_DAYS;
  const coveredOtherAt = prior.coveredAt?.[other] || null;
  if (!coveredOtherAt || termiteRungRecorded(term, other)) return { other, ownOther: null, coveredOtherAt: null, combined: false };
  const ownOther = await priorTermiteNoticeAcceptance(term, other);
  if (ownOther) return { other, ownOther, coveredOtherAt: null, combined: false };
  return { other, ownOther: null, coveredOtherAt, combined: true };
}

// Stamp a CLAIMED rung from its evidence per its plan (the caller holds the
// claims the plan needs). Returns { rungs, witness }.
async function stampPlannedRecovery(claimedTerm, n, prior, plan) {
  const rungs = [n];
  if (plan.ownOther) {
    const otherResult = await claimAndStampRecovered(claimedTerm, plan.other, { ...plan.ownOther, coveredAt: {} });
    if (otherResult.sent) rungs.push(plan.other);
  }
  const witness = await stampTermNoticeWitness(claimedTerm, n, prior.at, plan.combined
    ? { alsoRecordMissedRung: plan.other, missedRungAt: plan.coveredOtherAt, freezeNoticedFee: false }
    : { freezeNoticedFee: false });
  if (plan.combined) rungs.push(plan.other);
  return { rungs, witness };
}

// Claim what the plan needs (BOTH rungs for a combined recovery — Codex
// #4921 r7), then stamp from the evidence; a stamp failure releases the
// claim(s) and rethrows. Another holder → { sent:false, 'already_claimed' }.
async function claimAndStampRecovered(term, n, prior) {
  const plan = await recoveryPlan(term, n, prior);
  const previousStatus = term.status;
  const claimedTerm = await claimForDelivery(term, n, plan.combined);
  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };
  let stamped;
  try {
    stamped = await stampPlannedRecovery(claimedTerm, n, prior, plan);
  } catch (err) {
    await releaseForDelivery(claimedTerm, n, previousStatus, plan.combined);
    throw err;
  }
  logger.info(`[annual-prepay] termite ${n}-day notice for term ${claimedTerm.id} was already accepted (${prior.channel}) at ${prior.at.toISOString()}; stamped rung(s) ${stamped.rungs.join('+')} from that, nothing re-sent`);
  return withWitness({ sent: true, termId: claimedTerm.id, channel: prior.channel, recovered: true, rungs: stamped.rungs }, stamped.witness);
}

// Surfaces a non-'stamped' witness outcome on a result (absent when stamped).
function withWitness(result, witness) {
  return witness === 'stamped' ? result : { ...result, witness };
}

// A provider acceptance time from a send result, if it is a real, non-future
// time; else null (the caller then uses "now").
function acceptanceTimeFrom(value) {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now()) return null;
  return at;
}

// ── sendCustomerTermNotice: gate → claim → deliver ────────────────────────
//
// Stage 1 (no claim held): everything decided before a claim is taken —
// table/rung support, the refreshed term, "already recorded", persisted
// acceptance recovery, the combined-send evidence guard, and the send-
// content preflight. Returns { result } to exit early, else
// { term, termiteRung }.
async function termNoticeGate(termOrId, daysOut, opts) {
  if (!(await annualPrepayTableExists())) return { result: { sent: false, reason: 'table_missing' } };
  if (!noticeColumnForDaysOut(daysOut) || !noticeClaimColumnForDaysOut(daysOut)) {
    return { result: { sent: false, reason: 'unsupported_days_out' } };
  }
  const refreshed = await refreshTermSnapshot(termOrId);
  const term = refreshed || (typeof termOrId === 'object' ? termOrId : null);
  if (!term) return { result: { sent: false, reason: 'term_not_found' } };
  if (termiteRungRecorded(term, daysOut)) return { result: { sent: false, reason: 'already_sent' } };
  // Schema-not-ready fallback (Codex #4921 r8): acceptance recovery and the
  // combined guard both depend on the termite notice columns — skipped; the
  // termite pass owns them once the schema is ready.
  if (opts.baseline) return termNoticePreflightResult(term, daysOut);

  // Persisted acceptance evidence first — before the send-content preflight
  // and before any send (see recoverTermiteNoticeFromAcceptance). A lookup
  // error throws here with no claim held: nothing sent, nothing stamped.
  const recovered = await recoverTermiteNoticeFromAcceptance(term, daysOut);
  if (recovered) return { result: recovered };
  // Combined send: the rung it would record as late must have no acceptance
  // evidence of its own (processTermiteNoticeObligations recovers it first;
  // this closes the race). If it does, do not send — the next run recovers
  // that rung from its own evidence and then sends this one alone.
  if (await missedRungHasOwnAcceptance(term, opts.alsoRecordMissedRung)) {
    return { result: { sent: false, reason: 'missed_rung_has_acceptance' } };
  }

  return termNoticePreflightResult(term, daysOut);
}

async function termNoticePreflightResult(term, daysOut) {
  const preflight = await termiteNoticePreflight(term, daysOut);
  if (preflight.blocked) return { result: { sent: false, reason: preflight.blocked } };
  return { term, termiteRung: preflight.termiteRung };
}

async function missedRungHasOwnAcceptance(term, missedRung) {
  if (!missedRung || !isTermiteAnnualPlanTerm(term) || termiteRungRecorded(term, missedRung)) return false;
  return Boolean(await priorTermiteNoticeAcceptance(term, missedRung));
}

async function sendCustomerTermNotice(termOrId, daysOut, opts = {}) {
  const gate = await termNoticeGate(termOrId, daysOut, opts);
  if (gate.result) return gate.result;
  const { term, termiteRung } = gate;

  // A combined send holds BOTH rungs' claims (Codex #4921 r7 P1): if either
  // is held elsewhere, defer to the next run rather than race it.
  const combined = Boolean(termiteRung && opts.alsoRecordMissedRung);
  const previousStatus = term.status;
  const baseline = Boolean(opts.baseline);
  const claimedTerm = await claimForDelivery(term, daysOut, combined, baseline);
  if (!claimedTerm) return { sent: false, reason: 'already_claimed' };

  // One attempt's delivery context. `recorded` = the witness landed (never
  // release the claim after that); `keepClaimOnError` = an email the
  // provider accepted is in flight, so a failed witness write keeps the
  // claim (TTL governs the retry, whose recovery restores the witness from
  // the evidence) instead of releasing it for an immediate re-send.
  const ctx = {
    claimedTerm,
    daysOut,
    termiteRung,
    opts,
    combined,
    baseline,
    recorded: false,
    keepClaimOnError: false,
    release: () => releaseForDelivery(claimedTerm, daysOut, previousStatus, combined),
  };
  try {
    return await deliverClaimedTermNotice(ctx);
  } catch (err) {
    if (!ctx.recorded && !ctx.keepClaimOnError) await ctx.release();
    throw err;
  }
}

// Stage 2 (claim held): load the recipient and the notice's facts, re-check
// acceptance evidence under the claim, then deliver (email-only when there
// is no phone, else SMS with the email as confirmation/fallback).
async function deliverClaimedTermNotice(ctx) {
  const { claimedTerm, termiteRung } = ctx;
  const customer = await db('customers').where({ id: claimedTerm.customer_id }).first();
  if (!customer) {
    await ctx.release();
    return { sent: false, reason: 'customer_not_found' };
  }
  ctx.customer = customer;
  ctx.cancelLink = termiteRung ? portalUrl('/?tab=plan') : null;
  const { addressShort, planAddress } = await termNoticeAddress(termiteRung, claimedTerm, customer);
  ctx.planAddress = planAddress;
  // Combined send: the evidence itself records that this ONE notice
  // discharges both rungs (SMS audit metadata + email payload), so a
  // recovery after a failed witness write restores the combined
  // obligation without depending on the retry's call-site options.
  ctx.coversRungs = ctx.combined ? [Number(ctx.daysOut), Number(ctx.opts.alsoRecordMissedRung)] : null;

  const recovered = termiteRung && !ctx.baseline ? await recoverTermNoticeUnderClaim(ctx) : null;
  if (recovered) return recovered;

  // Lease check right before any provider call (Codex #4921 r10 P2).
  if (!(await ensureTermNoticeLease(ctx))) return { sent: false, reason: 'claim_lost' };

  if (!customer.phone) {
    const byEmail = await deliverTermNoticeByEmail(ctx, null);
    return byEmail.sent ? byEmail : { sent: false, reason: 'no_phone' };
  }
  return deliverTermNoticeBySms(ctx, addressShort);
}

// Codex #4921 r10 P2: renew this attempt's claim lease right before the
// provider call when it is past half its TTL (a claim younger than that
// cannot have been reclaimed by anyone — others treat it as fresh — so the
// common path costs nothing). The renewal is conditional on the claim(s)
// still holding this attempt's exact timestamp; if the lease was lost, this
// attempt sends nothing and releases nothing (the claim is not ours).
async function ensureTermNoticeLease(ctx) {
  const claimCols = ctx.combined
    ? ['notice_30_claimed_at', 'notice_45_claimed_at']
    : [noticeClaimColumnForDaysOut(ctx.daysOut)];
  const oldest = Math.min(...claimCols.map((col) => new Date(ctx.claimedTerm[col]).getTime()));
  if (!(Date.now() - oldest > NOTICE_CLAIM_TTL_MS / 2)) return true;
  const renewedAt = new Date();
  const renewed = ctx.combined
    ? await renewCombinedNoticeLease(ctx.claimedTerm, renewedAt)
    : await renewNoticeLease(ctx.claimedTerm, claimCols[0], renewedAt);
  if (!renewed) {
    logger.warn(`[annual-prepay] ${ctx.daysOut}-day notice claim for term ${ctx.claimedTerm.id} was lost before sending; not sending`);
    ctx.recorded = true; // nothing of ours to release
    return false;
  }
  for (const col of claimCols) ctx.claimedTerm[col] = renewedAt;
  return true;
}

async function renewNoticeLease(claimedTerm, claimCol, renewedAt) {
  return db('annual_prepay_terms')
    .where({ id: claimedTerm.id })
    .where(claimCol, claimedTerm[claimCol])
    .update({ [claimCol]: renewedAt, updated_at: renewedAt });
}

async function renewCombinedNoticeLease(claimedTerm, renewedAt) {
  return db('annual_prepay_terms')
    .where({ id: claimedTerm.id })
    .where('notice_30_claimed_at', claimedTerm.notice_30_claimed_at)
    .where('notice_45_claimed_at', claimedTerm.notice_45_claimed_at)
    .update({ notice_30_claimed_at: renewedAt, notice_45_claimed_at: renewedAt, updated_at: renewedAt });
}

// Resolves { confirmed, acceptedAt } — acceptedAt is the provider's
// acceptance time (the ORIGINAL one when the email layer deduped this
// attempt against an already-accepted send).
function sendTermNoticeEmailFor(ctx) {
  return sendTermNoticeEmail({
    termiteRung: ctx.termiteRung,
    customer: ctx.customer,
    term: ctx.claimedTerm,
    daysOut: ctx.daysOut,
    cancelLink: ctx.cancelLink,
    planAddress: ctx.planAddress,
    coversRungs: ctx.coversRungs,
  });
}

// A zero-row outcome ('already_recorded' / 'conflict') still counts as
// recorded for claim purposes — the rung HAS a record, so releasing the
// claim would only reset status — but it is surfaced on the result.
async function markTermNoticeSent(ctx, sentAt) {
  ctx.witness = await stampTermNoticeWitness(ctx.claimedTerm, ctx.daysOut, sentAt, {
    alsoRecordMissedRung: ctx.opts.alsoRecordMissedRung,
    baseline: ctx.baseline,
  });
  ctx.recorded = true;
}

// Re-checked UNDER the claim (the pre-claim recovery closes the common case;
// this closes a concurrent sender landing in between). A lookup ERROR
// throws: the caller releases the claim and rethrows, so the attempt aborts
// and retries next run — never a re-send and never a late stamp on an
// unknown. Decided from the EVIDENCE (its own covers_rungs), never from
// this call's opts.alsoRecordMissedRung.
async function recoverTermNoticeUnderClaim(ctx) {
  const { claimedTerm, daysOut } = ctx;
  const prior = await priorTermiteNoticeAcceptance(claimedTerm, daysOut);
  if (!prior) return null;
  const plan = await recoveryPlan(claimedTerm, Number(daysOut), prior);
  // A combined recovery needs BOTH claims; this attempt holds only its own
  // rung's — release it and let the next run's pre-claim recovery take
  // both together (Codex #4921 r7 P1).
  if (plan.combined && !ctx.combined) {
    await ctx.release();
    return { sent: false, reason: 'recovery_needs_both_claims' };
  }
  logger.info(`[annual-prepay] termite ${daysOut}-day notice for term ${claimedTerm.id} was already accepted (${prior.channel}) at ${prior.at.toISOString()}; stamping from that, not re-sending`);
  const stamped = await stampPlannedRecovery(claimedTerm, Number(daysOut), prior, plan);
  ctx.recorded = true;
  return withWitness({ sent: true, termId: claimedTerm.id, channel: prior.channel, recovered: true, rungs: stamped.rungs }, stamped.witness);
}

// Email-only delivery: the witness lands only on a confirmed email send, at
// the provider's acceptance time (a deduped retry of an already-accepted
// email keeps its ORIGINAL time — Codex #4921 r4 P1 — so an on-time send
// whose stamp failed is still recorded on time, not late).
async function deliverTermNoticeByEmail(ctx, reason, { keepClaim = false } = {}) {
  const email = await sendTermNoticeEmailFor(ctx);
  if (email.confirmed) {
    ctx.keepClaimOnError = true;
    await markTermNoticeSent(ctx, email.acceptedAt || new Date());
    return withWitness({ sent: true, termId: ctx.claimedTerm.id, channel: 'email', sms: false, ...(reason ? { reason } : {}) }, ctx.witness);
  }
  if (!keepClaim) await ctx.release();
  return { sent: false, reason: reason || 'email_not_sent' };
}

async function deliverTermNoticeBySms(ctx, addressShort) {
  const { customer, claimedTerm, termiteRung, daysOut } = ctx;
  const smsTemplateKey = termiteRung ? 'termite_annual_renewal_notice' : 'annual_prepay_renewal_reminder';
  const body = await renderTermNoticeSms({
    termiteRung, customer, term: claimedTerm, addressShort, cancelLink: ctx.cancelLink,
  });
  if (!body) {
    logger.warn(`[annual-prepay] ${smsTemplateKey} template missing/disabled for customer ${customer.id}`);
    return deliverTermNoticeByEmail(ctx, 'missing_sms_template');
  }

  const smsResult = await sendTermNoticeSms({
    customer, body, smsTemplateKey, term: claimedTerm, daysOut, extraMetadata: termNoticeSmsMetadata(ctx), termiteRung,
  });
  const fallback = smsEmailFallback(termiteRung, smsResult, claimedTerm.id);
  if (fallback) return deliverTermNoticeByEmail(ctx, fallback.reason, { keepClaim: fallback.keepClaim });
  return recordAcceptedTermNoticeSms(ctx, smsResult);
}

function termNoticeSmsMetadata(ctx) {
  if (!ctx.coversRungs) return ctx.opts.metadata;
  return { ...(ctx.opts.metadata || {}), covers_rungs: ctx.coversRungs };
}

// When the SMS leg does NOT stand as the witness: the email must confirm
// the notice instead. Returns { reason, keepClaim } for that email
// fallback, or null when the SMS is the witness.
//  - sent:false can still be an UNCERTAIN provider handoff for a termite
//    rung (the text may have reached the customer) — keep the claim (TTL
//    governs any retry) rather than releasing it for an immediate re-send.
//  - A termite notice is a legal renewal-notice witness: `sent: true` is not
//    proof the provider accepted it (the owner SMS kill switch returns
//    sent:true with deliveryOutcome 'not_sent' — Codex #4921 r1 P1). Only
//    an ACCEPTED SMS stamps the witness; an uncertain one keeps its claim.
//  - Pre-push audit P1: under 'billing' delivery preferences the notice can
//    be routed to App PUSH. A push is NOT written notice under the
//    agreement, so for a termite rung only the TEXT leg's own result counts
//    (smsLegOf): a push-only acceptance is treated like an SMS that never
//    went out — the email must confirm (stamped at the email's acceptance
//    time), and if it fails nothing is stamped and the claim is released for
//    the retry (the text was never handed to Twilio, so it is not uncertain).
function smsEmailFallback(termiteRung, smsResult, termId) {
  if (!smsResult.sent) {
    const failure = smsResult.code || smsResult.reason;
    logger.warn(`[annual-prepay] renewal SMS blocked/failed for term ${termId}: ${failure || 'unknown'}`);
    const uncertain = termiteRung && classifyDeliveryCertainty(smsResult) === 'unknown' && smsResult.deliveryOutcome === 'uncertain';
    return { reason: failure || 'send_failed', keepClaim: uncertain };
  }
  if (!termiteRung) return null;
  const smsLeg = smsLegOf(smsResult);
  if (!smsLeg) {
    logger.warn(`[annual-prepay] termite renewal notice for term ${termId} was accepted only as an app push (not written notice); requiring email confirmation`);
    return { reason: 'sms_push_only', keepClaim: false };
  }
  const certainty = classifyDeliveryCertainty(smsLeg);
  if (certainty === 'sent') return null;
  logger.warn(`[annual-prepay] termite renewal SMS for term ${termId} not confirmed (${certainty}); requiring email confirmation`);
  return { reason: `sms_${certainty}`, keepClaim: certainty === 'unknown' };
}

// The TEXT leg of a send result, keyed off how sendCustomerMessage reports
// channels (never a guess): a billing fan-out (dispatchBillingChannels)
// reports each leg under channelResults — only channelResults.sms is the
// text; a single send reports its delivered `channel` ('push' when the push
// router delivered it in place of the text). Null when no text leg exists.
function smsLegOf(smsResult) {
  if (smsResult.channelResults) return smsResult.channelResults.sms || null;
  return smsResult.channel === 'push' ? null : smsResult;
}

// An ACCEPTED SMS is the witness, at the SMS provider's own acceptance time
// (a send accepted at 23:59:59 ET on the 45th day is on time even if
// bookkeeping runs after midnight). Codex #4921 r4 P1, SMS leg: when that
// time would classify LATE, await the email leg first — an earlier
// acceptance of it (a dedupe hit) is the witness time instead. The on-time
// path is unchanged (stamp first, email in the background).
async function recordAcceptedTermNoticeSms(ctx, smsResult) {
  const { claimedTerm, termiteRung, daysOut } = ctx;
  // The TEXT leg's own acceptance time (a billing fan-out's top-level result
  // may be another leg's).
  let witnessAt = acceptanceTimeFrom((smsLegOf(smsResult) || smsResult).sentAt) || new Date();
  let emailAlreadyAttempted = false;
  if (termiteRung && !ctx.baseline && noticeWitnessColumn(daysOut, claimedTerm, etDateString(witnessAt)) !== noticeColumnForDaysOut(daysOut)) {
    const email = await sendTermNoticeEmailFor(ctx);
    emailAlreadyAttempted = true;
    if (email.acceptedAt && email.acceptedAt < witnessAt) witnessAt = email.acceptedAt;
  }
  await markTermNoticeSent(ctx, witnessAt);

  await recordTermNoticeInteraction(ctx.customer.id, termiteRung, daysOut);

  if (!emailAlreadyAttempted) void sendTermNoticeEmailFor(ctx);

  return withWitness({ sent: true, termId: claimedTerm.id }, ctx.witness);
}

// Codex #4921 pre-push P1: the earliest provider-ACCEPTED termite renewal
// SMS for this term+rung, from messaging_audit_log (every send attempt the
// wrapper sees; metadata carries the annual_prepay_term_id / days_out /
// original_message_type that sendTermNoticeSms stamps). The audit row keeps
// no deliveryOutcome, so acceptance is proven by a real Twilio message SID —
// the owner kill switch records 'owner-silence', an uncertain handoff
// records no SID, and a blocked attempt records blocked_code. Errors
// propagate (see sendCustomerTermNotice).
const TWILIO_MESSAGE_SID_RE = '^(SM|MM)[0-9a-fA-F]{32}$';
// Returns { at, coversRungs } for the EARLIEST accepted send, or null.
// coversRungs comes from the send's own metadata (covers_rungs, stamped on a
// combined 30+45 notice); [] when absent.
async function priorTermiteSmsAcceptance(term, daysOut) {
  const row = await db('messaging_audit_log')
    .where({ customer_id: term.customer_id, channel: 'sms', provider: 'twilio' })
    .whereNull('blocked_code')
    .whereNotNull('sent_at')
    .whereRaw("metadata->>'original_message_type' = ?", ['termite_annual_renewal_notice'])
    .whereRaw("metadata->>'annual_prepay_term_id' = ?", [String(term.id)])
    .whereRaw("metadata->>'days_out' = ?", [String(Number(daysOut))])
    .whereRaw('provider_message_id ~ ?', [TWILIO_MESSAGE_SID_RE])
    .orderBy('sent_at', 'asc')
    .first('sent_at', db.raw("metadata->'covers_rungs' as covers_rungs"));
  if (!row?.sent_at) return null;
  return { at: new Date(row.sent_at), coversRungs: parseCoversRungs(row.covers_rungs) };
}

function parseCoversRungs(value) {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
}

// Earliest persisted acceptance (SMS or email) for this term+rung, or null:
// { channel, at, coveredAt } where coveredAt maps each OTHER rung a source
// says it covered (a combined send) to the earliest such acceptance time.
// A time in the future or unparseable is ignored (never a witness).
async function priorTermiteNoticeAcceptance(term, daysOut) {
  const sms = await priorTermiteSmsAcceptance(term, daysOut);
  const email = await AccountMembershipEmail.findAcceptedTermiteRenewalReminder({
    customerId: term.customer_id,
    termId: term.id,
    daysOut,
    renewalDate: term.term_end,
  });
  const now = Date.now();
  const candidates = [
    { channel: 'sms', at: sms?.at || null, coversRungs: sms?.coversRungs || [] },
    { channel: 'email', at: email?.sentAt ? new Date(email.sentAt) : null, coversRungs: email?.coversRungs || [] },
  ].filter((c) => c.at && !Number.isNaN(c.at.getTime()) && c.at.getTime() <= now);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.at - b.at);
  const coveredAt = {};
  for (const c of candidates) {
    for (const rung of c.coversRungs) {
      if (rung !== Number(daysOut) && !coveredAt[rung]) coveredAt[rung] = c.at;
    }
  }
  return { channel: candidates[0].channel, at: candidates[0].at, coveredAt };
}

// ── Termite annual-plan notice obligations: ONE pass, both rungs ──────────
//
// Codex #4921 rounds 1–3 found a new edge case each round in the SAME class:
// an exact-day or narrow-window candidate query with no durable record that
// a notice was ever owed. r1/r2 patched the 45-day rung's own window twice;
// r3 found the shared loop's 30-day termite branch had the identical
// exact-day bug, PLUS the 45-day catch-up window's own day-31 cutoff still
// dropped a final failed attempt or a term first discovered inside 30 days.
// Rather than patch a third window, this is ONE candidate query for BOTH
// rungs, and a rung is a candidate every day from when it opens until
// term_end itself — not one exact day, not a bounded catch-up window — so a
// missed cron run or a failed send is retried tomorrow, never dropped.
//
// A rung is DUE the day today reaches term_end minus its own threshold, and
// stays due (retried daily) until it is recorded (on time OR late) or
// term_end arrives. term_end > today is required — once a term reaches its
// own term_end with an undelivered rung, termiteMissedNoticeEscalationCandidates
// below is the safety net, not another send attempt.
function termiteRungDue(term, daysOut, today) {
  const doneCols = noticeDoneColumns(daysOut, term);
  if (doneCols.some((col) => term[col])) return false;
  const daysLeft = daysUntil(today, dateOnly(term.term_end));
  return daysLeft != null && daysLeft <= Number(daysOut);
}

// ONE query for every termite annual-plan term with a due, unclaimed 45- or
// 30-day rung. annual_plan_version IS NOT NULL restricts this to termite
// terms only — no lawn/mosquito/rodent/quarterly prepay term is ever
// considered here. term_end > today excludes a term that has already
// reached its renewal date (the missed-notice sweep owns that case).
async function termiteNoticeObligationCandidates({ today = etDateString(), conn = db } = {}) {
  const staleClaimCutoff = new Date(Date.now() - NOTICE_CLAIM_TTL_MS);
  const claim45 = noticeClaimColumnForDaysOut(TERMITE_EXTRA_NOTICE_DAYS);
  const claim30 = noticeClaimColumnForDaysOut(30);
  const claimAvailable = (claimCol) => function claimAvailableGroup() {
    this.whereNull(claimCol).orWhere(claimCol, '<', staleClaimCutoff);
  };
  return conn('annual_prepay_terms')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNotNull('annual_plan_version')
    .where('term_end', '>', today)
    .where(function anyRungDue() {
      this.where(function rung45Due() {
        this.whereNull('notice_45_sent_at')
          .whereNull(TERMITE_LATE_NOTICE_COLUMN)
          .where('term_end', '<=', addDaysYmd(today, TERMITE_EXTRA_NOTICE_DAYS))
          .where(claimAvailable(claim45));
      }).orWhere(function rung30Due() {
        this.whereNull('notice_30_sent_at')
          .whereNull(TERMITE_30_LATE_NOTICE_COLUMN)
          .where('term_end', '<=', addDaysYmd(today, 30))
          .where(claimAvailable(claim30));
      });
    })
    .orderBy('term_end', 'asc')
    .select('*');
}

// One term's notice-obligation decision. At most ONE customer message per
// run: a term first seen at <=30 days out has BOTH rungs due
// simultaneously, and texting/emailing the same customer twice back to
// back in one sweep (a 45-day notice immediately followed by a 30-day one)
// is more surprising than the alternative chosen here — send the near-term
// 30-day notice (the one that actually discloses the imminent renewal) and
// record the 45-day rung as missed/late with its own staff escalation. The
// 45-day promise is already unkeepable the instant both are due at once —
// there is no "on time" version of it left to attempt — so this is the same
// outcome a genuinely missed 45-day rung gets once day 30 arrives, just
// recognized a few days earlier instead of silently carried forward.
//
// Pre-push audit P1: the 45-day missed/late record is passed to
// sendCustomerTermNotice as alsoRecordMissedRung rather than written here,
// UP FRONT, before the 30-day send is even attempted. Stamping it here
// unconditionally would tell staff "the customer has been told" and
// suppress the missed-notice escalation / clear the campaign cooldown on
// a rung the customer may never actually receive (a disabled cancel flow,
// a missing renewal fee, or a delivery failure all block the send AFTER
// this point) — false delivery evidence. sendCustomerTermNotice now stamps
// it in the SAME confirmed-delivery step (markNoticeSent) that records the
// 30-day witness, so both land together on success and NEITHER lands on
// failure — a failed combined send retries both tomorrow, exactly like any
// other failed send.
//
// coverageAwaitsInstallation blocks EVERY rung (checked here so the
// combined-send option is never even offered for an unanchored original;
// sendCustomerTermNotice's own preflight blocks the send itself the same
// way for a direct single-rung call) — an unanchored original's term_end is
// only a provisional placeholder, so nothing about it should be recorded as
// missed, late, or sent.
async function processTermiteNoticeObligations(term, today) {
  const due45 = termiteRungDue(term, TERMITE_EXTRA_NOTICE_DAYS, today);
  const due30 = termiteRungDue(term, 30, today);
  if (!due45 && !due30) return { sent: false, reason: 'not_due' };

  if (due45 && due30) {
    // Codex #4921 pre-push P1: consult the 45-day rung's persisted
    // acceptance evidence BEFORE choosing the combined send, which would
    // otherwise record it as late. A 45 accepted earlier (its witness write
    // failed) is stamped from its ORIGINAL time — on time or late — and the
    // term then has only the 30 due: sendCustomerTermNotice(term, 30) runs
    // the 30's own recovery first and sends only if the 30 has none. A
    // lookup error throws (nothing sent or stamped; retried next run).
    const recovered45 = await recoverTermiteNoticeFromAcceptance(term, TERMITE_EXTRA_NOTICE_DAYS);
    if (recovered45 && !recovered45.sent) return recovered45; // another sender holds the 45 — retry next run
    if (recovered45) {
      // Recovered via a combined 30-day send's evidence: both rungs recorded.
      if (recovered45.rungs && recovered45.rungs.includes(30)) return recovered45;
      return sendCustomerTermNotice(term, 30);
    }
    const alsoRecordMissedRung = coverageAwaitsInstallation(term) ? null : TERMITE_EXTRA_NOTICE_DAYS;
    return sendCustomerTermNotice(term, 30, { alsoRecordMissedRung });
  }
  if (due30) return sendCustomerTermNotice(term, 30);
  return sendCustomerTermNotice(term, TERMITE_EXTRA_NOTICE_DAYS);
}

// Durable safety net: a termite term that has reached its OWN term_end with
// the 45-day and/or 30-day rung never delivered at all (neither on-time nor
// late — a rung whose daily retry never landed before the renewal date
// arrived). notice_missed_escalated_at guards against re-filing once
// confirmed; a failed notifyAdmin insert leaves it unset so the next sweep
// retries (same confirmed-insert-only pattern as the late-notice escalation).
async function termiteMissedNoticeEscalationCandidates({ today = etDateString(), conn = db } = {}) {
  return conn('annual_prepay_terms')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNotNull('annual_plan_version')
    .where('term_end', '<=', today)
    // An original term still awaiting installation has only a provisional
    // term_end (the send path skips it the same way): never report a missed
    // notice against it — anchoring later moves the real renewal date.
    .where(function anchoredOrSuccessor() {
      this.whereNotNull('installation_anchored_at').orWhereNotNull('renewed_from_term_id');
    })
    .whereNull(TERMITE_NOTICE_MISSED_ESCALATION_COLUMN)
    .where(function anyRungMissing() {
      this.where(function rung45Missing() {
        this.whereNull('notice_45_sent_at').whereNull(TERMITE_LATE_NOTICE_COLUMN);
      }).orWhere(function rung30Missing() {
        this.whereNull('notice_30_sent_at').whereNull(TERMITE_30_LATE_NOTICE_COLUMN);
      });
    })
    .select('*');
}

// Files the durable "renewal notice obligation missed" bell for a term the
// sweep above selected, atomically deduped via notifyAdmin's own dedupeKey
// (never a standalone SELECT — Codex #4921 r3 P1). Stamped only on a
// confirmed (non-null) result so a transient insert failure is retried on
// the next sweep instead of losing the escalation for good.
async function fileTermiteMissedNoticeException(term) {
  try {
    const missing = termiteUnrecordedRungs(term);
    const missing45 = missing.includes(TERMITE_EXTRA_NOTICE_DAYS);
    const missing30 = missing.includes(30);
    const NotificationService = require('./notification-service');
    const result = await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice obligation missed',
      `Term ${term.id} reached its renewal date (${formatDateLabel(term.term_end)}) without ${missedNoticeLabel(missing45, missing30)} ever going out. The v3 agreement's notice obligation was missed — this renewal must be handled by staff, not auto-charged.`,
      {
        link: termiteAlertLink(term),
        bell: true,
        dedupeKey: `termite-annual-notice:${term.id}:missed`,
        metadata: {
          customerId: term.customer_id || null,
          annual_prepay_term_id: term.id || null,
          reason: 'notice_missed',
          missing45,
          missing30,
        },
      },
    );
    if (!result) {
      logger.warn(`[annual-prepay] termite missed-notice admin bell insert failed for term ${term.id}; will retry on the next sweep`);
      return false;
    }
    await stampMissedNoticeEscalation(term.id);
    return true;
  } catch (err) {
    logger.warn(`[annual-prepay] termite missed-notice exception failed for term ${term?.id}: ${err.message}`);
    return false;
  }
}

// Which of a termite term's two rungs have NO record at all (neither the
// on-time witness nor the late record).
const TERMITE_RUNG_RECORD_COLUMNS = {
  [TERMITE_EXTRA_NOTICE_DAYS]: ['notice_45_sent_at', TERMITE_LATE_NOTICE_COLUMN],
  30: ['notice_30_sent_at', TERMITE_30_LATE_NOTICE_COLUMN],
};
function termiteUnrecordedRungs(term) {
  return [TERMITE_EXTRA_NOTICE_DAYS, 30]
    .filter((rung) => !TERMITE_RUNG_RECORD_COLUMNS[rung].some((col) => term[col]));
}

function missedNoticeLabel(missing45, missing30) {
  if (missing45 && missing30) return 'its 45-day AND 30-day notices';
  return missing45 ? 'its 45-day notice' : 'its 30-day notice';
}

function termiteAlertLink(term) {
  return term.customer_id ? `/admin/customers?customerId=${term.customer_id}` : '/admin/dispatch';
}

// Confirmed-insert-only stamp (guarded on the column existing mid-rollout).
async function stampMissedNoticeEscalation(termId) {
  if (!termId) return;
  const cols = await annualPrepayColumns();
  if (!cols[TERMITE_NOTICE_MISSED_ESCALATION_COLUMN]) return;
  await db('annual_prepay_terms')
    .where({ id: termId })
    .whereNull(TERMITE_NOTICE_MISSED_ESCALATION_COLUMN)
    // Literal column name (never computed): a single fixed constant.
    .update({ notice_missed_escalated_at: new Date(), updated_at: new Date() });
}

// Codex #4921 r4 P1: every termite term whose 45- or 30-day rung is still
// undelivered (neither on-time nor late) ON OR AFTER that rung's own
// deadline day — term_end <= today + N, i.e. N or fewer days left — and
// whose per-rung undelivered bell has not been confirmed yet. Codex #4921
// r11: the deadline day itself is included (strict `<` only rang the day
// AFTER, when the notice was already late); ringing then leaves staff the
// rest of that day to deliver it on time by hand. Runs AFTER the day's send
// attempt (runTermiteNoticePass order), so a rung delivered that day — on
// time or late — is recorded first and never belled as undelivered. term_end > today: from the
// renewal date on, termiteMissedNoticeEscalationCandidates owns the case.
// An unanchored original term is excluded (provisional term_end — the send
// path skips it the same way). The daily send retry itself is unaffected.
async function termiteUndeliveredNoticeEscalationCandidates({ today = etDateString(), conn = db } = {}) {
  return conn('annual_prepay_terms')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNotNull('annual_plan_version')
    .where('term_end', '>', today)
    .where(function anchoredOrSuccessor() {
      this.whereNotNull('installation_anchored_at').orWhereNotNull('renewed_from_term_id');
    })
    .where(function anyRungUndeliveredPastDeadline() {
      this.where(function rung45Undelivered() {
        this.whereNull('notice_45_sent_at')
          .whereNull(TERMITE_LATE_NOTICE_COLUMN)
          .whereNull(TERMITE_45_UNDELIVERED_ESCALATION_COLUMN)
          .where('term_end', '<=', addDaysYmd(today, TERMITE_EXTRA_NOTICE_DAYS));
      }).orWhere(function rung30Undelivered() {
        this.whereNull('notice_30_sent_at')
          .whereNull(TERMITE_30_LATE_NOTICE_COLUMN)
          .whereNull(TERMITE_30_UNDELIVERED_ESCALATION_COLUMN)
          .where('term_end', '<=', addDaysYmd(today, 30));
      });
    })
    .orderBy('term_end', 'asc')
    .select('*');
}

// Which of a candidate term's rungs are undelivered past their deadline and
// not yet bell-confirmed — mirrors the query above, per rung.
function termiteUndeliveredRungs(term, today) {
  const daysLeft = daysUntil(today, dateOnly(term?.term_end));
  if (daysLeft == null || daysLeft <= 0) return [];
  const rungs = [];
  if (daysLeft <= TERMITE_EXTRA_NOTICE_DAYS && !term.notice_45_sent_at && !term[TERMITE_LATE_NOTICE_COLUMN]
    && !term[TERMITE_45_UNDELIVERED_ESCALATION_COLUMN]) rungs.push(TERMITE_EXTRA_NOTICE_DAYS);
  if (daysLeft <= 30 && !term.notice_30_sent_at && !term[TERMITE_30_LATE_NOTICE_COLUMN]
    && !term[TERMITE_30_UNDELIVERED_ESCALATION_COLUMN]) rungs.push(30);
  return rungs;
}

// One durable staff bell per rung, the first sweep that rung is
// undelivered past its deadline. Atomically deduped by notifyAdmin's own
// dedupeKey (advisory lock + probe + insert in one transaction — never a
// standalone SELECT) and stamped ONLY on a confirmed (non-null) insert, so
// a failed bell is retried on the next sweep. Literal column names in each
// write (never a computed key).
// The undelivered bell's body. On the deadline day itself the notice can
// still go out on time (Codex #4921 r11), so the copy says so.
function undeliveredNoticeMessage(term, n) {
  const consequence = n === TERMITE_EXTRA_NOTICE_DAYS
    ? ' Delivered on the deadline day it still counts as on time; after that it is recorded as LATE and this renewal will not be auto-charged.'
    : ' Delivered on the deadline day it still counts as on time; after that it is recorded as late.';
  const deadline = formatDateLabel(addDaysYmd(dateOnly(term.term_end), -n));
  return `The ${n}-day termite renewal notice for term ${term.id} (renews ${formatDateLabel(term.term_end)}) has not been confirmed delivered by text or email, and its ${n}-day deadline (${deadline}) is today or has passed. The system keeps retrying daily.${consequence} Check the customer's phone and email on file and contact them directly.`;
}

async function fileTermiteUndeliveredNoticeException(term, daysOut) {
  const n = Number(daysOut);
  if (n !== TERMITE_EXTRA_NOTICE_DAYS && n !== 30) return false;
  try {
    const NotificationService = require('./notification-service');
    const result = await NotificationService.notifyAdmin(
      'alert',
      'Termite annual renewal notice not delivered',
      undeliveredNoticeMessage(term, n),
      {
        link: termiteAlertLink(term),
        bell: true,
        dedupeKey: `termite-annual-notice:${term?.id}:${n}:undelivered`,
        metadata: {
          customerId: term?.customer_id || null,
          annual_prepay_term_id: term?.id || null,
          days_out: n,
          reason: `notice_${n}_undelivered`,
        },
      },
    );
    if (!result) {
      logger.warn(`[annual-prepay] termite undelivered-notice admin bell insert failed for term ${term?.id} (${n}-day); will retry on the next sweep`);
      return false;
    }
    if (term?.id) {
      if (n === TERMITE_EXTRA_NOTICE_DAYS) {
        await db('annual_prepay_terms')
          .where({ id: term.id })
          .whereNull('notice_45_undelivered_escalated_at')
          .update({ notice_45_undelivered_escalated_at: new Date(), updated_at: new Date() });
      } else {
        await db('annual_prepay_terms')
          .where({ id: term.id })
          .whereNull('notice_30_undelivered_escalated_at')
          .update({ notice_30_undelivered_escalated_at: new Date(), updated_at: new Date() });
      }
    }
    return true;
  } catch (err) {
    logger.warn(`[annual-prepay] termite undelivered-notice exception failed for term ${term?.id} (${n}-day): ${err.message}`);
    return false;
  }
}

// Escalation passes (undelivered / missed) consult persisted acceptance
// evidence before ringing "not delivered": true when the rung was just
// recorded from an earlier acceptance (or another sender holds it right
// now), so no bell is due. A lookup ERROR here fails toward staff
// visibility — it is logged and the bell still rings (the bell says "not
// confirmed", which is exactly what an unreadable ledger means) — unlike the
// send path, where an unknown must never become a send or a late stamp.
async function recoveredBeforeEscalation(term, rung) {
  try {
    return !!(await recoverTermiteNoticeFromAcceptance(term, rung));
  } catch (err) {
    logger.warn(`[annual-prepay] termite ${rung}-day acceptance lookup failed for term ${term?.id} before escalation; escalating anyway: ${err.message}`);
    return false;
  }
}

// Every column ANY part of the termite notice pass queries (Pre-push audit
// P1, Codex #4921 r3 structural fix): the readiness check must cover the
// two late-escalation retry columns and the missed-notice column too, not
// just the ones the main candidate query touches — on a database that had
// only run through 000106, termiteLateNoticeEscalationCandidates()'s raw
// reference to notice_30_late_escalated_at threw and (uncaught) aborted
// checkAndSend, generic loop included. The undelivered pass's own two
// columns (000108) are gated separately inside the pass.
const TERMITE_NOTICE_PASS_COLUMNS = [
  'annual_plan_version',
  'notice_45_sent_at',
  'notice_45_claimed_at',
  TERMITE_LATE_NOTICE_COLUMN,
  'notice_45_late_escalated_at',
  'notice_30_sent_at',
  'notice_30_claimed_at',
  TERMITE_30_LATE_NOTICE_COLUMN,
  TERMITE_30_LATE_ESCALATION_COLUMN,
  TERMITE_NOTICE_MISSED_ESCALATION_COLUMN,
];

function termiteNoticeColumnsReady(termCols) {
  return TERMITE_NOTICE_PASS_COLUMNS.every((col) => Boolean(termCols[col]));
}

// The shared "scan → per-row try/catch → count" shape every sweep below
// uses: runs `fn` for each row, isolating a failure to that row (logged as
// "[annual-prepay] <failureLabel> for term <id>: <message>"), and returns
// how many rows `fn` reported truthy for.
async function forEachTermIsolated(rows, failureLabel, fn) {
  let count = 0;
  for (const row of rows) {
    try {
      if (await fn(row)) count++;
    } catch (err) {
      logger.error(`[annual-prepay] ${failureLabel} for term ${row.id}: ${err.message}`);
    }
  }
  return count;
}

// Retry every LATE 45- or 30-day notice whose admin-bell escalation never
// got a confirmed insert (fileTermiteLateNoticeException's notifyAdmin call
// returned null) — otherwise a transient notification-insert failure loses
// that bell for good, since each rung's own late-sent column already blocks
// the send itself from ever retrying.
async function retryLateNoticeEscalations(term) {
  if (term[TERMITE_LATE_NOTICE_COLUMN] && !term.notice_45_late_escalated_at) {
    await fileTermiteLateNoticeException(term, TERMITE_EXTRA_NOTICE_DAYS);
  }
  if (term[TERMITE_30_LATE_NOTICE_COLUMN] && !term[TERMITE_30_LATE_ESCALATION_COLUMN]) {
    await fileTermiteLateNoticeException(term, 30);
  }
}

// Codex #4921 r4 P1: a rung still undelivered AFTER its own deadline rings
// staff the first day it is late-and-undelivered, not only at term_end.
// Evidence first: a rung actually accepted earlier (witness write failed)
// is recorded from that acceptance, not belled as undelivered.
async function escalateUndeliveredRungs(term, today) {
  for (const rung of termiteUndeliveredRungs(term, today)) {
    if (!(await recoveredBeforeEscalation(term, rung))) await fileTermiteUndeliveredNoticeException(term, rung);
  }
}

// A term that reached its OWN term_end with a rung never delivered at all.
// Evidence first (see recoveredBeforeEscalation): a rung accepted before
// term_end whose witness write failed is recorded from that acceptance, and
// the bell rings only for what is still missing (re-read after recovery).
async function escalateMissedNotice(term) {
  let anyRecovered = false;
  for (const rung of termiteUnrecordedRungs(term)) {
    if (await recoveredBeforeEscalation(term, rung)) anyRecovered = true;
  }
  const current = anyRecovered ? await db('annual_prepay_terms').where({ id: term.id }).first() : term;
  if (anyRecovered && !(current && termiteUnrecordedRungs(current).length)) return;
  await fileTermiteMissedNoticeException(current);
}

// Termite annual-plan terms ONLY (annual_plan_version IS NOT NULL): the
// unified 45/30-day notice-obligation pass, then its three durable
// escalation passes. Isolated as a whole: a failure anywhere here (a
// genuinely unexpected error — a missing column is already excluded by the
// readiness gate) must never skip the unrelated generic 30/15/7 loop.
// Returns how many notices went out (or were recovered).
// One termite sub-pass: its candidate query AND per-row work isolated, so a
// failure (even the candidate query itself) never skips the independent
// safety-net passes that follow it the same day.
async function runTermiteSubPass(label, loadCandidates, fn) {
  try {
    return await forEachTermIsolated(await loadCandidates(), `${label} failed`, fn);
  } catch (err) {
    logger.error(`[annual-prepay] ${label} aborted: ${err.message}`);
    return 0;
  }
}

async function runTermiteNoticePass(today, termCols) {
  const sent = await runTermiteSubPass(
    'termite notice-obligation pass',
    () => termiteNoticeObligationCandidates({ today }),
    async (term) => (await processTermiteNoticeObligations(term, today)).sent,
  );
  await runTermiteSubPass(
    'termite late-notice escalation retry',
    () => termiteLateNoticeEscalationCandidates(),
    retryLateNoticeEscalations,
  );
  // Gated on its own two columns (20260926000108) so a DB that has not
  // run that migration yet still gets every other part of this pass.
  if (termCols[TERMITE_45_UNDELIVERED_ESCALATION_COLUMN] && termCols[TERMITE_30_UNDELIVERED_ESCALATION_COLUMN]) {
    await runTermiteSubPass(
      'termite undelivered-notice escalation',
      () => termiteUndeliveredNoticeEscalationCandidates({ today }),
      (term) => escalateUndeliveredRungs(term, today),
    );
  }
  // Durable staff escalation, atomically deduped via notifyAdmin's own
  // dedupeKey (never a standalone SELECT).
  await runTermiteSubPass(
    'termite missed-notice escalation',
    () => termiteMissedNoticeEscalationCandidates({ today }),
    escalateMissedNotice,
  );
  // A witness conflict whose staff bell never got a confirmed insert
  // (Codex #4921 r10 P2) — gated on its own columns (20260926000109).
  if (witnessConflictColumnsReady(termCols)) {
    await runTermiteSubPass(
      'termite witness-conflict bell retry',
      () => termiteWitnessConflictCandidates(),
      refileWitnessConflictBell,
    );
  }
  return sent;
}

// The shared 30/15/7 ladder's candidates for one rung. Anchored on the
// effective coverage end: term_end, OR the last covered visit when that is
// the effective end. Finite cadences (e.g. a quarterly term seeds visits at
// +0/+3/+6/+9mo while term_end is +12mo) end service before term_end, so a
// term_end-only match would fire the reminder months after coverage
// actually lapsed (or skip it). Mirrors the getOpenRenewalAlerts
// last_scheduled_service_date trigger so the automated sender and the admin
// alert list agree.
//
// The 30-day rung is owned ENTIRELY by the termite notice-obligation pass
// for a termite annual-plan term (Codex #4921 r3 — the exact-day-only match
// here was itself the r3 P1 finding). Every non-termite term's 30/15/7
// handling is untouched; termite terms still get 15/7 from this loop.
// Codex #4921 r4 P1: the exclusion applies ONLY when that pass actually ran
// this sweep (excludeTermite30). If the schema probe failed or a column is
// missing, the termite pass is skipped, and excluding termite terms here
// too would leave them with NO 30-day notice at all — so they fall back to
// this exact-day send (sendCustomerTermNotice still picks the termite copy).
function genericNoticeCandidates(daysOut, target, excludeTermite30) {
  const noticeCol = noticeColumnForDaysOut(daysOut);
  return db('annual_prepay_terms')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('renewal_decision')
    .whereNull(noticeCol)
    .where(function noticeClaimAvailable() {
      const claimCol = noticeClaimColumnForDaysOut(daysOut);
      this.whereNull(claimCol).orWhere(claimCol, '<', new Date(Date.now() - NOTICE_CLAIM_TTL_MS));
    })
    .where(function renewalAnchorMatches() {
      this.where('term_end', target).orWhere('last_scheduled_service_date', target);
    })
    .modify((qb) => { if (daysOut === 30 && excludeTermite30) qb.whereNull('annual_plan_version'); })
    .select('*');
}

// Only treat the last-visit date as the anchor when it is genuinely near
// term end (the effective end); a term matched solely by an early
// last-service date still reminds on term_end instead. A termite annual-
// plan term (only reachable here via the schema-readiness fallback) renews
// on term_end — its contractual notice is N days before THAT date, never a
// last-visit anchor (a visit up to 120 days early would stamp the rung and
// suppress the real notice).
function genericNoticeAnchored(term, target) {
  if (dateOnly(term.term_end) === target) return true;
  return !isTermiteAnnualPlanTerm(term) && isLastServiceNearTermEnd(term);
}

async function runGenericNoticeLadder(today, termiteReady) {
  let sent = 0;
  for (const daysOut of CUSTOMER_NOTICE_DAYS) {
    const target = addDaysYmd(today, daysOut);
    // Termite pass ran → it owns the termite 30; not ready → the termite 30
    // falls back here, with baseline columns only for every claim/stamp/
    // release (Codex #4921 r8 — a pre-000106 schema has no late columns).
    const terms = (await genericNoticeCandidates(daysOut, target, termiteReady))
      .filter((term) => genericNoticeAnchored(term, target));
    sent += await forEachTermIsolated(
      terms,
      'reminder failed',
      async (term) => (await sendCustomerTermNotice(term, daysOut, { baseline: !termiteReady })).sent,
    );
  }
  return sent;
}

async function checkAndSend({ today = etDateString() } = {}) {
  if (!(await annualPrepayTableExists())) return { sent: 0 };
  await activatePaidPendingTerms();
  const termCols = await annualPrepayColumns();
  const termiteReady = termiteNoticeColumnsReady(termCols);
  const termiteSent = termiteReady ? await runTermiteNoticePass(today, termCols) : 0;
  const genericSent = await runGenericNoticeLadder(today, termiteReady);
  return { sent: termiteSent + genericSent };
}

async function hasAnnualPrepayRenewal(customerId, termEnd) {
  if (!(await annualPrepayTableExists())) return false;
  const row = await db('annual_prepay_terms')
    .where({ customer_id: customerId, term_end: dateOnly(termEnd) })
    .first('id');
  return !!row;
}

// Codex round-7 P1, redesigned per pre-push audit P1: this per-term
// SESSION-scoped Postgres advisory lock is now used by EXACTLY ONE
// caller — termite-annual-renewal-charge.js's charge path
// (decideAndCharge, right before its Stripe submission), where a
// dedicated pooled connection genuinely needs to hold a lock ACROSS a
// live Stripe network call, which must never happen inside an open DB
// transaction (a held xact lock would pin a pooled connection for the
// whole round trip, and the charge path opens no transaction of its own
// for exactly this reason). recordDecision's OWN write (below) no longer
// calls this — it takes a cheaper, connection-free TRANSACTION-scoped
// pg_advisory_xact_lock on the SAME key namespace instead (see its own
// comment), which still mutually excludes against this session lock
// (Postgres advisory locks share one lock table regardless of which
// acquisition function took them) without ever borrowing a second
// connection for every program's ordinary decision.
//
// Codex round-7 P2 self-review: admin-cancellation.js's own
// acquireCancelCommitLock (the same session-scoped pg_try_advisory_lock +
// explicit pg_advisory_unlock shape) fails IMMEDIATELY (409) on the first
// missed try — correct for a foreground admin click, where "try again" is
// free. Here a miss can mean "a decline landed exactly while the charge is
// mid-flight", and a spurious failure has money/UX consequences a customer
// never asked for. So this uses the BLOCKING pg_advisory_lock instead,
// bounded by a `lock_timeout` set on the SAME connection (via set_config,
// parameterized — `SET lock_timeout = <literal>` cannot take a bind
// parameter) rather than a client-side pg_try_advisory_lock poll loop:
// Postgres queues the waiter and wakes it the instant the lock frees
// (no poll-interval latency), and a miss raises a precise 55P03
// (lock_not_available) we translate into one clear, typed error — still
// fails CLOSED (throws) rather than ever proceeding unserialized. The
// session-level lock_timeout is RESET on this connection before it either
// runs `fn()` or goes back to the pool — a session knex hands to some
// unrelated later borrower must never inherit a 5-second lock ceiling on
// its own unrelated locks.
const PARENT_DECISION_LOCK_NS = 'annual-prepay-parent-decision';
const PARENT_DECISION_LOCK_TIMEOUT_MS = 5000;

// Codex round-7 P1 (2nd audit round): chargeInvoiceWithSavedCard's OWN
// card-on-file success path calls syncTermForInvoicePayment SYNCHRONOUSLY,
// before returning — for a termite renewal successor's invoice, that walks
// straight into stampParentRenewedForSuccessor -> recordDecision('renew')
// on the SAME parent term decideAndCharge's withParentDecisionLock is
// STILL holding (the session lock, on a dedicated connection, exactly
// across this Stripe call). recordDecision would then try to take its OWN
// xact lock on the SAME key from a DIFFERENT connection — a genuine
// self-wait (bounded by its own lock_timeout, so not a permanent hang, but
// a real multi-second stall on every successful synchronous card-on-file
// charge, every time, plus the parent's 'renewed' stamp failing on this
// pass). Threading a "lock already held" flag through
// chargeInvoiceWithSavedCard -> syncTermForInvoicePayment ->
// stampParentRenewedForSuccessor would touch a generic, heavily-used
// Stripe charging function with a termite-only concern. AsyncLocalStorage
// is this codebase's existing idiom for exactly this shape (see
// agent-control/context.js's own doc: "threading ids through every shared
// entry point would touch every call site; a module-level variable would
// leak between concurrent requests; ALS is scoped to the async tree") —
// withParentDecisionLock marks the term it holds for the lifetime of its
// OWN async call tree (including everything synchronously awaited inside
// it, however many layers down); recordDecision checks this BEFORE ever
// asking for its own lock and, for a re-entrant call on the SAME term,
// skips straight to the write — the outer session lock already provides
// all the serialization anyone needs, so a second lock from the SAME
// logical flow would only ever contend with itself.
//
// Codex #4971 r5 P2 (lock order): the store holds a SET of term keys. A
// renewal action (charge, withdrawal, pay link, grace lapse) acts on the
// SUCCESSOR while it guards the PARENT's decision, and its nested writers
// (voidInvoice, cancelTermWithRestorations) take xact gates keyed on the
// successor. Holding only the parent key let a customer-keyed gate (a
// refund, which keys every termite term of the customer, sorted) take the
// successor key and then wait on the parent while the withdrawal held the
// parent and waited on the successor — a cross-session cycle Postgres
// cannot see, broken only by lock_timeout. withParentDecisionLock now takes
// the parent AND successor keys (alsoTermIds) in sorted order on its one
// lock connection, so every writer takes any pair in the one global order,
// and nested gates on either key are skipped as held.
const heldParentDecisionLockStore = new AsyncLocalStorage();
// Codex #4971 r19 P1: the store keeps each session's own keys and loss
// state ({ keys, lockHeld } per session, outermost first). A key counts as
// held only while ITS session is alive — once PostgreSQL has released a lost
// session's locks, nested writers must take their own transaction locks
// again instead of trusting the stale marker.
const heldDecisionSessions = () => heldParentDecisionLockStore.getStore()?.sessions || [];
// Run fn OUTSIDE every held-lock context this async tree captured (review of
// #5197): an after-commit hook attached inside withParentDecisionLock would
// otherwise inherit the store and read the session's keys as still held
// after that session released them cleanly — and then skip its own gate.
const runOutsideParentDecisionLocks = (fn) => heldParentDecisionLockStore.exit(fn);
const heldDecisionKeys = () => {
  const live = new Set();
  for (const session of heldDecisionSessions()) {
    if (!session.lockHeld.lost) session.keys.forEach((key) => live.add(key));
  }
  return live;
};

// Codex #4971 r15 P1: the lock SESSION's own liveness, threaded through the
// same store as the keys it holds. The dedicated raw connection backing
// withParentDecisionLock can emit error/end/close mid-flight — Postgres
// releases every advisory lock the session held the instant that happens,
// but this store's keys alone don't know it, so pooled work inside fn()
// (a Stripe charge submission, a Stripe refund, an SMS/email pay-link send)
// would otherwise sail through believing the gate still serializes it.
// assertParentDecisionLockAlive() is the read; callers run it immediately
// before each such provider boundary — never only once at entry, since the
// loss can land at any point while fn() is running. A no-op outside any
// held gate (nothing to assert).
function assertParentDecisionLockAlive() {
  // Every enclosing session, not just the innermost: a lost OUTER session
  // releases its keys even while a nested one is still alive.
  const lost = heldDecisionSessions().find((session) => session.lockHeld.lost);
  if (lost) {
    throw Object.assign(
      new Error(`the parent-decision lock session for term ${[...lost.keys][0]} was lost before this action reached its provider — never attempted`),
      { code: 'PARENT_DECISION_LOCK_LOST', deliveryNeverAttempted: true },
    );
  }
}

// Extracted from recordDecision (Codex round-7 P2 self-review, AGENTS.md
// L412-418): the transaction-scoped lock acquisition is a genuinely
// self-contained step — bound the wait, acquire, translate a timeout into
// one clear error. See recordDecision's own comment for why an xact lock
// here still mutually excludes the charge path's session lock on the SAME
// key.
async function acquireParentDecisionXactLock(trx, termId) {
  // Codex #4971 round-3 P1 (chokepoint B widened): this lock is now taken
  // inside OTHER writers' larger transactions too (voidInvoice's refund/void
  // sync -> cancelTermWithRestorations, the dispute demotion, the
  // reverse-prepaid route) — a SET LOCAL left at 5s would silently cap every
  // LATER lock wait in the caller's own transaction. Bound only THIS wait:
  // remember the caller's value and put it back once the lock is held.
  const previous = (await trx.raw('SELECT current_setting(\'lock_timeout\') AS previous'))?.rows?.[0]?.previous;
  try {
    await trx.raw('SELECT set_config(\'lock_timeout\', ?, true)', [`${PARENT_DECISION_LOCK_TIMEOUT_MS}ms`]);
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [PARENT_DECISION_LOCK_NS, String(termId)]);
  } catch (err) {
    if (err && err.code === '55P03') {
      const timeout = new Error(`could not acquire the parent-decision lock for term ${termId} within ${PARENT_DECISION_LOCK_TIMEOUT_MS}ms — a decision or charge is already in progress for this term`);
      // Typed so a route can answer 409 (the deletion gate, Codex #4971 r21).
      timeout.code = 'PARENT_DECISION_LOCK_TIMEOUT';
      throw timeout;
    }
    throw err;
  }
  await trx.raw('SELECT set_config(\'lock_timeout\', ?, true)', [previous || '0']);
}

// Codex #4971 pre-push P0/P1 (lock order): the parent-decision gate must be
// the FIRST lock a writer's transaction takes — before any customer /
// invoice / term row lock and before any money-moving write (an invoice
// void and its credit restore, a refund sync's credit reversals, a dispute
// demotion). The renewal charge holds the gate and THEN asks for the
// customer row (chargeInvoiceWithSavedCard), so a writer that took a row
// first and the gate second waited on the charge while the charge waited
// on it — a cross-session wait Postgres cannot see as a deadlock, broken
// only by the 5s lock_timeout aborting the writer. One order everywhere:
// gate → customer → invoice → term. Called as the first statement of the
// writer's own transaction, keyed on every termite term tied to the
// invoice(s) (as their prepay invoice, or the term an invoice itself
// names), term(s) or customer(s) it is about to touch — one plain read (no
// row lock), then the keys in sorted order, so two writers never take the
// same pair in opposite orders. Termite-only (no termite term → nothing
// taken) and re-entrant (a key already held by this async tree's
// withParentDecisionLock is skipped; a key this transaction already holds
// re-grants instantly).
//
// Chokepoint B (Codex #4971 round-3 P1): the renewal charge holds this key
// (withParentDecisionLock, a session lock) from its last parent re-check
// through the Stripe submission, so every writer that can move a termite
// term OUT of charge-eligible state — or commit money the charge could
// consume — either commits before that re-check (which then refuses) or
// waits until the submission is done. Entry points (each takes the gate as
// its transaction's first lock):
//   - voidInvoice, and the cancelled-service auto-void (invoice.js)
//   - cancelTermWithRestorations when it opens its own transaction (the
//     void / refund / lost-dispute syncs through syncTermForInvoicePayment)
//   - the pay sync's revive of a renewal successor (its parent's key — the
//     parent 'renewed' stamp is a write on the parent)
//   - suspendActiveTermsForDisputedInvoice on the root handle, and both
//     dispute webhooks' transactions (stripe-webhook.js)
//   - admin-invoices.js: remove-flag and reverse-prepaid
//   - declineTermiteAnnualRenewal's own transaction
//   - recordDecision on the root handle (writeDecisionUnderTermiteLock)
//   - Codex #4971 r4 P1, every refund / chargeback writer that can revoke a
//     parent's paid evidence (acquireTermiteGateForCharge /
//     acquireTermiteGateForStatement below): charge.refunded's generic
//     transaction, StripeService.refund's stamp and credit restore (the
//     admin refund route), both dispute.closed(lost) invoice reopens, and
//     the statement money lock + cascade reversal (statement refunds and
//     chargebacks). syncTermForRefundedPayment already gates (move 9).
async function acquireTermiteGateAtEntry(trx, { termIds = [], invoiceIds = [], customerIds = [] } = {}) {
  const ids = await termiteGateKeys(trx, { termIds, invoiceIds, customerIds });
  const held = heldDecisionKeys();
  for (const termId of ids) {
    if (!held.has(termId)) await acquireParentDecisionXactLock(trx, termId);
  }
  return ids;
}

// Codex #4971 r4 P1 (refund / chargeback writers): a refund or a lost
// chargeback names a Stripe charge / PaymentIntent (or a payments row), never
// a term — and it is exactly the write that flips the charge's parent
// evidence (parentInvoicePaidAndNotFullyRefunded: a payments row stamped
// 'refunded' / refund_status 'full', or the invoice leaving paid). Resolve
// every invoice and customer that money touches — its payments rows
// (invoice_id, a combined share's metadata.invoice_id, customer_id) and the
// invoices it settled — with plain reads, then take the gate on them as the
// transaction's FIRST lock. The customer keys cover the credit side: a full
// refund returns applied account credit to a balance the renewal charge
// could otherwise consume mid-flight. Termite-only (no termite term on those
// invoices or customers -> nothing taken). Entry points: charge.refunded's
// generic transaction, StripeService.refund's stamp and credit restore
// (the admin refund route), and the lost-dispute invoice reopens.
// Codex #4971 r6 P1 — a money reversal WE issue at the provider holds the
// gate across the provider call, not only across its ledger write: an admin
// refund (StripeService.refund) returns the customer's money at
// stripe.refunds.create, and a renewal charge that took the gate between
// that call and the local stamp would read the parent as still paid. The
// same keys as acquireTermiteGateForCharge, taken as a SESSION lock
// (withParentDecisionLock — the pattern the renewal charge uses across its
// own Stripe call) from before the provider call through the stamp and the
// credit restore; the nested xact gates inside skip the held keys. No
// termite term on the payment → no lock, fn() runs exactly as before. A
// refund issued OUTSIDE our code (the Stripe dashboard) has already moved
// the money by the time charge.refunded arrives, so only its stamp can be
// gated; the renewal charge's own in-gate parent re-check is the limit
// there.
async function withTermiteGateForCharge({ chargeId = null, paymentIntentId = null, paymentIds = [] } = {}, fn) {
  const inputs = await chargeGateInputs(db, {
    chargeId: chargeId || null,
    paymentIntentId: paymentIntentId || null,
    paymentIds: paymentIds.filter(Boolean).map(String),
  });
  const keys = await termiteGateKeys(db, { termIds: [], ...inputs });
  if (!keys.length) return fn();
  return withParentDecisionLock(keys[0], fn, { alsoTermIds: keys.slice(1) });
}

async function acquireTermiteGateForCharge(trx, { chargeId = null, paymentIntentId = null, paymentIds = [] } = {}) {
  const inputs = await chargeGateInputs(trx, {
    chargeId: chargeId || null,
    paymentIntentId: paymentIntentId || null,
    paymentIds: paymentIds.filter(Boolean).map(String),
  });
  return acquireTermiteGateAtEntry(trx, inputs);
}

function paymentMetadataInvoiceId(raw) {
  try {
    const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return meta && meta.invoice_id ? String(meta.invoice_id) : null;
  } catch {
    return null;
  }
}

async function chargeGateInputs(trx, { chargeId, paymentIntentId, paymentIds }) {
  if (!chargeId && !paymentIntentId && !paymentIds.length) return { invoiceIds: [], customerIds: [] };
  const invoiceIds = new Set();
  const customerIds = new Set();
  const add = (set, value) => { if (value) set.add(String(value)); };
  // to_jsonb: payments.invoice_id is read column-tolerantly — this runs at
  // the entry of Stripe money writers, some against schemas without it.
  const payments = await trx('payments as p')
    .where(function paymentKeys() {
      if (chargeId) this.orWhere('p.stripe_charge_id', chargeId);
      if (paymentIntentId) this.orWhere('p.stripe_payment_intent_id', paymentIntentId);
      if (paymentIds.length) this.orWhereIn('p.id', paymentIds);
    })
    .select(trx.raw("to_jsonb(p) ->> 'invoice_id' AS invoice_id"), 'p.customer_id', 'p.metadata');
  for (const row of payments || []) {
    add(invoiceIds, row.invoice_id);
    add(invoiceIds, paymentMetadataInvoiceId(row.metadata));
    add(customerIds, row.customer_id);
  }
  if (chargeId || paymentIntentId) {
    const invoices = await trx('invoices')
      .where(function settledBy() {
        if (chargeId) this.orWhere('stripe_charge_id', chargeId);
        if (paymentIntentId) this.orWhere('stripe_payment_intent_id', paymentIntentId);
      })
      .select('id', 'customer_id');
    for (const row of invoices || []) {
      add(invoiceIds, row.id);
      add(customerIds, row.customer_id);
    }
  }
  return { invoiceIds: [...invoiceIds], customerIds: [...customerIds] };
}

// Codex #4971 r4 P1: the payer-statement money writers' entry gate. A termite
// annual invoice minted at estimate acceptance does not skip statement
// accrual, so a NET-terms payer's statement can carry a termite PARENT's
// prepay invoice as a child — and a statement refund / chargeback reverses
// the cascade (child paid -> draft), revoking the parent's paid evidence.
// withStatementMoneyLock and reverseStatementCascadeForDispute take this
// BEFORE the statement money advisory lock.
async function acquireTermiteGateForStatement(trx, statementId) {
  if (!statementId) return [];
  const invoiceIds = await trx('invoices').where({ payer_statement_id: statementId }).pluck('id');
  return acquireTermiteGateAtEntry(trx, { invoiceIds: invoiceIds || [] });
}

// A text[] parameter as a uuid[] of its well-formed members only.
const GATE_UUID_ARRAY = "ARRAY(SELECT v::uuid FROM unnest(?::text[]) v WHERE v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";

async function termiteGateKeys(trx, { termIds, invoiceIds, customerIds }) {
  const terms = termIds.filter(Boolean).map(String);
  const invoices = invoiceIds.filter(Boolean).map(String);
  const customers = customerIds.filter(Boolean).map(String);
  if (!terms.length && !invoices.length && !customers.length) return [];
  // Postgres array literals ('{a,b}'::text[]) — an empty list is simply
  // '{}' (matches nothing), so the one statement shape holds for every
  // combination. Codex #4971 r5 P2 (index use): this runs at the entry of
  // every refund, statement money op and void, termite customer or not, so
  // each arm compares the uuid COLUMN to a uuid[] (GATE_UUID_ARRAY: only
  // well-formed ids survive, so a malformed one never throws) — the primary
  // key, the prepay_invoice_id / customer_id indexes and the invoices
  // primary key are all usable (a BitmapOr), where the old column::text
  // casts forced a scan. invoices.annual_prepay_term_id is still read
  // column-tolerantly (to_jsonb) — some writers run against schemas without
  // that column.
  const pgArray = (values) => `{${values.join(',')}}`;
  const rows = await trx('annual_prepay_terms')
    .whereNotNull('annual_plan_version')
    .whereRaw(
      `(id = ANY(${GATE_UUID_ARRAY})
        OR prepay_invoice_id = ANY(${GATE_UUID_ARRAY})
        OR id = ANY(ARRAY(SELECT NULLIF(to_jsonb(gi) ->> 'annual_prepay_term_id', '')::uuid FROM invoices gi WHERE gi.id = ANY(${GATE_UUID_ARRAY})))
        OR customer_id = ANY(${GATE_UUID_ARRAY}))`,
      [pgArray(terms), pgArray(invoices), pgArray(invoices), pgArray(customers)],
    )
    .select('id');
  return [...new Set(rows.map((row) => String(row.id)))].sort();
}

// The shared "is this a termite term" peek (annual_plan_version set) — a
// termite decision takes the gate unless this async tree's own
// withParentDecisionLock already holds it.
async function isTermiteTerm(conn, termId) {
  if (!termId) return false;
  const peek = await conn('annual_prepay_terms').where({ id: termId }).first('annual_plan_version');
  return Boolean(peek?.annual_plan_version);
}

// recordDecision's wrapper around the shared gate above: a decision that
// needs no lock (a non-termite term, or a re-entrant call already under
// withParentDecisionLock for this term) stays ONE plain UPDATE, no
// transaction wrapper — byte-identical to before this lane. Otherwise the
// UPDATE runs inside a transaction (a real one on the root handle, a
// SAVEPOINT on a caller's trx — stampParentRenewedForSuccessor's own
// savepoint) that takes the xact lock first. The charge path's session lock
// and this xact lock share one Postgres lock table, so they mutually
// exclude on the SAME key.
// runUpdate receives { termite } — the one peek answers both questions.
async function writeDecisionUnderTermiteLock(conn, termId, runUpdate) {
  const termite = await isTermiteTerm(conn, termId);
  if (!termite || heldDecisionKeys().has(String(termId))) return runUpdate(conn, { termite });
  return conn.transaction(async (trx) => {
    await acquireParentDecisionXactLock(trx, termId);
    return runUpdate(trx, { termite });
  });
}
// `alsoTermIds` (Codex #4971 r5 P2): the renewal successor the caller acts
// on — locked with the parent, sorted, on the same connection (see
// heldParentDecisionLockStore). Keys this async tree already holds are
// skipped; all held → fn() runs directly (re-entrant).
//
// Codex #4971 r12 P1: the session lock lives on a DEDICATED connection
// OUTSIDE the pool (knex's own acquireRawConnection — the same
// connectionSettings, SSL and search_path the pool's connections get),
// never a pooled one. A held gate used to pin a pool slot for its whole
// body, and the gated flows open pooled transactions inside it (the renewal
// charge's invoice transaction, which itself needs one more connection to
// commit its submission marker): with the supported DB_POOL_MAX=2 the
// charge waited on a connection only its own gate could free, until the
// pool timed out. A gate now never consumes a pool slot, so no pool size
// can deadlock a gated flow (the refund gate, the dispute handlers' gate,
// the renewal gate). The connection is always destroyed afterwards — ending
// the session releases anything a failed unlock left held.
//
// Codex #4971 r13 P2: those sessions are BOUNDED — in count and in connect
// time — through the same raw-connection mechanism the reschedule-link send
// interlock uses (raw-connection-slots.js): concurrent refunds, disputes,
// renewal sends and charges would otherwise each open a connection outside
// DB_POOL_MAX with no cap and no connect timeout (lock_timeout only starts
// once connected). A full cap or a connect timeout fails like a lock that
// could not be taken — the error every caller already defers or retries on.
const PARENT_DECISION_LOCK_SESSIONS = require('./raw-connection-slots').rawConnectionSlots({
  max: 8,
  connectMs: 5000,
  logPrefix: '[annual-prepay] parent-decision lock session',
});
async function withParentDecisionLock(termId, fn, { timeoutMs = PARENT_DECISION_LOCK_TIMEOUT_MS, alsoTermIds = [] } = {}) {
  const held = heldDecisionKeys();
  const keys = [...new Set([termId, ...alsoTermIds].filter(Boolean).map(String))].filter((key) => !held.has(key)).sort();
  if (!keys.length) return fn();
  // Internal, code-controlled only (never request-derived) — still clamp
  // defensively before it ever reaches a query, parameterized or not.
  const boundedTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : PARENT_DECISION_LOCK_TIMEOUT_MS;
  let lockConn = null;
  const locked = [];
  try {
    lockConn = await PARENT_DECISION_LOCK_SESSIONS.acquire();
    if (!lockConn) {
      throw new Error(`could not acquire the parent-decision lock for term ${keys[0]} — no lock session is available right now (the session cap is full or the database did not answer in time); retry shortly`);
    }
    // Codex #4971 r17 P1: attach the connection-loss tracker BEFORE any lock
    // query — the same mechanism reschedule-link-promises.js's send
    // interlock uses (raw-connection-slots.js's trackConnectionLoss), so
    // both session-lock users share one implementation. Attaching it only
    // after takeSessionDecisionLocks() returned missed a close/end that
    // landed between the connection's own acquisition and the listener's
    // registration — that loss was silently forgotten and the caller went
    // on believing the lock still held. Attaching it here means the window
    // between acquire() returning and this line is the only gap left, and
    // is checked explicitly below rather than left to chance.
    const lockHeld = { lost: false };
    require('./raw-connection-slots').trackConnectionLoss(lockConn, lockHeld);
    const assertAlive = () => {
      if (lockHeld.lost) {
        throw Object.assign(
          new Error(`the parent-decision lock session for term ${keys[0]} was lost before this action reached its provider — never attempted`),
          { code: 'PARENT_DECISION_LOCK_LOST', deliveryNeverAttempted: true },
        );
      }
    };
    assertAlive();
    await takeSessionDecisionLocks(lockConn, keys, locked, boundedTimeoutMs);
    // Mark these terms as session-lock-held for the lifetime of fn()'s own
    // async tree — see heldParentDecisionLockStore's doc above.
    return await heldParentDecisionLockStore.run(
      { sessions: [...heldDecisionSessions(), { keys: new Set(keys), lockHeld }] },
      () => fn(),
    );
  } finally {
    if (lockConn) await releaseSessionDecisionLocks(lockConn, locked);
  }
}

// Takes each key's session lock in order, recording what it holds in
// `locked` (so the caller's finally releases exactly those, even on a
// failure part-way). The session-level lock_timeout is always cleared
// before the connection is used for anything else.
async function takeSessionDecisionLocks(lockConn, keys, locked, timeoutMs) {
  try {
    await lockConn.query('SELECT set_config(\'lock_timeout\', $1, false)', [`${timeoutMs}ms`]);
    for (const key of keys) {
      await lockConn.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2::text))', [PARENT_DECISION_LOCK_NS, key]);
      locked.push(key);
    }
  } catch (err) {
    if (err && err.code === '55P03') {
      throw new Error(`could not acquire the parent-decision lock for term ${keys[locked.length]} within ${timeoutMs}ms — a decision or charge is already in progress for this term`);
    }
    throw err;
  } finally {
    try { await lockConn.query('RESET lock_timeout'); } catch { /* connection likely already broken; the caller's finally handles it */ }
  }
}

async function releaseSessionDecisionLocks(lockConn, locked) {
  for (const key of [...locked].reverse()) {
    try {
      await lockConn.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', [PARENT_DECISION_LOCK_NS, key]);
    } catch (err) {
      // Ending the dedicated session below is what releases it anyway.
      logger.warn(`[annual-prepay] parent-decision lock release failed for term ${key} — the lock session is closed instead: ${err.message}`);
      break;
    }
  }
  await PARENT_DECISION_LOCK_SESSIONS.release(lockConn);
}

async function recordDecision({ termId, action, adminUserId = null, notes = null, disposition = null, conn = db } = {}) {
  if (!(await annualPrepayTableExists())) return null;
  const allowed = new Set(['contacted', 'renew', 'cancel', 'switch_plan']);
  if (!allowed.has(action)) throw new Error('invalid annual prepay action');
  if (disposition != null && !CANCEL_DISPOSITIONS.includes(disposition)) throw new Error('invalid cancel disposition');
  const now = new Date();
  if (action === 'contacted') {
    const update = {
      status: 'renewal_pending',
      renewal_contacted_at: now,
      renewal_contacted_by: adminUserId || null,
      updated_at: now,
    };
    if (notes) update.renewal_notes = notes;
    const [term] = await conn('annual_prepay_terms')
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
  // ADMIN-BUG-R18: a cancel decision carries its disposition in the SAME
  // statement — the write side's one durable answer to "does this decided
  // lapse keep its paid visits through term_end?". Only Cancel plan's
  // "end now + refund" is end_now_refund; "End of paid coverage" and a
  // renewal-time lapse are end_at_term.
  if (action === 'cancel' && (await cancelDispositionSupported())) {
    update.cancel_disposition = disposition === 'end_now_refund' ? 'end_now_refund' : 'end_at_term';
  }
  // Codex round-2 P1: `conn` (default the global handle, unchanged for
  // every pre-existing caller) lets stampParentRenewedForSuccessor below
  // run this SAME write on the successor's own transaction/savepoint,
  // instead of a separate global-db write that could commit out of order
  // with, or survive a rollback of, the successor's own activation.
  const runUpdate = async (t) => {
    const [term] = await t('annual_prepay_terms')
      .where({ id: termId })
      .whereIn('status', ACTIVE_STATUSES)
      .whereNull('renewal_decision')
      .update(update)
      .returning('*');
    return term || null;
  };

  // Codex #4971 r4 P1: a cancel / switch refused while a renewal payment is
  // clearing — checked INSIDE the gate, right before the write.
  const guardedUpdate = async (t, { termite }) => {
    if (termite && DECISIONS_REFUSED_WHILE_RENEWAL_CLEARING.has(action)) await refuseWhileRenewalClearing(t, termId);
    return runUpdate(t);
  };

  // Codex round-7 P1 (redesigned per pre-push audit P1 — the original
  // design wrapped EVERY program's recordDecision in a dedicated-connection
  // session lock, doubling pool use even when this write already runs
  // inside an open transaction, e.g. stampParentRenewedForSuccessor's
  // `conn: t`) — see writeDecisionUnderTermiteLock's own doc.
  const decided = await writeDecisionUnderTermiteLock(conn, termId, guardedUpdate);
  // Synchronous withdrawal (owner ruling 2026-09-28): a cancel / switch on a
  // termite parent kills its unpaid renewal's pay link right after this
  // decision commits (afterParentChange defers to the outermost commit when
  // `conn` is a transaction). A 'renew' authorizes; 'contacted' changes
  // nothing.
  if (decided && decided.annual_plan_version && (action === 'cancel' || action === 'switch_plan')) {
    await require('./termite-annual-renewal-charge').afterParentChange(conn, termId, `the prior term's renewal was decided '${action}'`);
  }
  return decided;
}

// Codex #4971 r4 P1 — no parent decision while an ACH renewal is clearing.
// A termite parent decided cancel / switch_plan while its renewal successor
// has money in motion (an ACH debit still clearing, a charge submitted to
// Stripe and not resolved, a charge reconciliation pending, or a renewal
// invoice already paid but not yet activated — the charge module's
// renewalMoneyInMotion, the SAME test the successor withdrawal uses) would
// strand that money: the withdrawal must defer on it, so the renewal would
// settle behind a cancelled plan. Every parent-decision writer that can
// cancel or switch a termite parent refuses instead, under the gate:
//   - recordDecision (here): the admin decide route, admin cancel plan's
//     decideTermCancel (whose preflight already refuses a payable pending
//     renewal invoice), the grace lapse's decideParentLapse (after the
//     successor's invoice was voided — nothing left in motion); throws an
//     operational 409 (err.code 'renewal_money_in_motion') that the admin
//     routes surface as-is. Parent side only: recordDecision moves only
//     ACTIVE_STATUSES terms, and a renewal successor whose own payment is
//     clearing is payment_pending — out of its reach;
//   - the portal decline: declineRefusalReason refuses up front, as
//     'renewal_payment_clearing', inside the decline's own gated
//     transaction. Its live case is the renewal SUCCESSOR's own card (Codex
//     #4971 r5 P1): past the prior year's term_end the parent's card is
//     refused as term_ended before this check, while the payment_pending
//     successor stays declinable — so the question covers the term's OWN
//     renewal payment as well as any pending successor of it
//     (renewalMoneyInMotionForTerm).
const DECISIONS_REFUSED_WHILE_RENEWAL_CLEARING = new Set(['cancel', 'switch_plan']);
// Termite terms only (recordDecision's gate peek decides).
async function parentUndecided(conn, termId) {
  const parent = await conn('annual_prepay_terms').where({ id: termId }).first('status', 'renewal_decision');
  return Boolean(parent) && ACTIVE_STATUSES.includes(parent.status) && !parent.renewal_decision;
}

// Codex #4971 r13 P1: the same guard also refuses while a renewal already
// PAID awaits its parent's 'renewed' stamp (renewalMoneyInMotionForParent).
async function refuseWhileRenewalClearing(conn, termId) {
  const Charge = require('./termite-annual-renewal-charge');
  const reason = await Charge.renewalMoneyInMotionForParent(conn, termId);
  if (!reason) return;
  // A paid renewal blocks only while the parent still awaits its stamp
  // (undecided); a parent already decided is past recordDecision's own
  // guard, which answers as it always has.
  if (reason === Charge._private.PAID_RENEWAL_AWAITING_PARENT_STAMP && !(await parentUndecided(conn, termId))) return;
  const err = new Error(reason === Charge._private.PAID_RENEWAL_AWAITING_PARENT_STAMP
    ? 'A renewal payment was received for this plan and is still being recorded — try again shortly, or refund it first.'
    : `The renewal payment is still clearing (${reason}) — wait for it to settle or refund it first.`);
  err.code = 'renewal_money_in_motion';
  err.statusCode = 409;
  err.isOperational = true;
  throw err;
}

// ADMIN-BUG-R18: Cancel plan re-deciding a term whose cancel decision is
// already recorded (an end-at-term lapse now ended early, or a retry). The
// disposition only moves toward end_now_refund — Cancel plan refuses
// end-now → end-at-term (prepay_term_already_ended) — and end_at_term only
// fills a missing value. Returns { changed, disposition } — the term's
// disposition after the call (null when it has no cancel decision) — or
// null before the column exists.
async function recordCancelDisposition({ termId, disposition } = {}, conn = db) {
  if (!CANCEL_DISPOSITIONS.includes(disposition)) throw new Error('invalid cancel disposition');
  if (!(await cancelDispositionSupported())) return null;
  const query = conn('annual_prepay_terms').where({ id: termId, renewal_decision: 'cancel' });
  if (disposition === 'end_now_refund') query.whereRaw("cancel_disposition is distinct from 'end_now_refund'");
  else query.whereNull('cancel_disposition');
  const [term] = await query.update({ cancel_disposition: disposition, updated_at: new Date() }).returning('*');
  if (term) return { changed: true, disposition: term.cancel_disposition };
  const stored = await conn('annual_prepay_terms').where({ id: termId, renewal_decision: 'cancel' }).first('cancel_disposition');
  return { changed: false, disposition: stored ? stored.cancel_disposition : null };
}

// Move 14 (docs/annual-prepay-term-states.md): the CUSTOMER's online
// decline supersedes an UNPROCESSED staff 'renew' decision (Codex #4940 r4
// P1). Agreement v3 lets the customer decline online "at any time before
// the renewal date"; a staff-recorded renew whose successor term has not
// been minted yet (no annual_prepay_terms row with renewed_from_term_id =
// this id) has not happened yet, so it must not strip that right. Guarded
// conditional UPDATE: only a 'renewed'/'renew' row with no successor moves,
// to the same decided-lapse shape recordDecision('cancel') writes; a
// switch_plan decision, or a renew whose successor exists, never moves.
async function supersedeRenewWithCustomerCancel({ termId, conn = db } = {}) {
  const now = new Date();
  const supersede = {
    status: 'cancelled',
    renewal_decision: 'cancel',
    renewal_decision_at: now,
    renewal_decision_by: null,
    updated_at: now,
  };
  // The same disposition recordDecision('cancel') writes for a renewal-time
  // lapse (ADMIN-BUG-R18): the paid year keeps its visits through term_end
  // via the end-at-term upkeep.
  if (await cancelDispositionSupported()) supersede.cancel_disposition = 'end_at_term';
  const [term] = await conn('annual_prepay_terms')
    .where({ id: termId, status: 'renewed', renewal_decision: 'renew' })
    .whereNotExists(function noSuccessorTerm() {
      this.select(conn.raw('1')).from('annual_prepay_terms as successor').whereRaw('successor.renewed_from_term_id = annual_prepay_terms.id');
    })
    .update(supersede)
    .returning('*');
  return term || null;
}

// The CUSTOMER's online decline of a signed plan still payment_pending — an
// unpaid original invoice, or a dispute-suspended one (Codex #4940 r9/r10).
// The decision is recorded WITHOUT touching status: the term stays
// payment_pending, so every pending rail keeps working — the billing cron's
// payment-pending exclusion (getPaymentPendingCustomerIds) selects by status.
// Guarded: only an undecided payment_pending row takes the decision. When
// the prepay invoice later RESOLVES, settleDecidedPendingTermsForInvoice
// (move 15) turns it into the decided-lapse shape — paid: covered through
// term_end, never renewing; voided/refunded: nothing covered.
async function declinePaymentPendingWithCustomerCancel({ termId, conn = db } = {}) {
  const now = new Date();
  const decision = {
    renewal_decision: 'cancel',
    renewal_decision_at: now,
    renewal_decision_by: null,
    updated_at: now,
  };
  if (await cancelDispositionSupported()) decision.cancel_disposition = 'end_at_term';
  const [term] = await conn('annual_prepay_terms')
    .where({ id: termId, status: PAYMENT_PENDING_STATUS })
    .whereNull('renewal_decision')
    .update(decision)
    .returning('*');
  return term || null;
}

// The customer's decline, by the term's current shape: an unprocessed staff
// renew (move 14), an unpaid payment_pending plan (decision only — see
// declinePaymentPendingWithCustomerCancel), or a live term
// (recordDecision('cancel'), move 8). No `notes`: recordDecision would
// OVERWRITE renewal_notes, which may hold staff's own renewal notes (Codex
// r2 P2) — the activity_log row is the record of the online decline.
function recordCustomerDecline(term, { renewDecided, unpaid }, trx) {
  if (renewDecided) return supersedeRenewWithCustomerCancel({ termId: term.id, conn: trx });
  if (unpaid) return declinePaymentPendingWithCustomerCancel({ termId: term.id, conn: trx });
  return recordDecision({ termId: term.id, action: 'cancel', conn: trx });
}

// Slice 6a (termite annual plan, agreement v3 §-decline-online): let the
// CUSTOMER decline renewal for their own termite annual term from the
// portal — "The customer may decline renewal at any time before the
// renewal date online through their customer portal ... never only by
// phone."
//
// NOT gated (Codex r3 P0): GATE_TERMITE_ANNUAL_PLAN + GATE_CANCEL_FLOW_V2
// (termiteAnnualPlanSelectionEnabled) control only the ISSUING of new
// plans. A customer who already holds a termite annual term
// (annual_plan_version NOT NULL) signed an agreement promising online
// nonrenewal, so that promise outlives any later gate flip. The existence
// of such a term IS the eligibility check below — a customer with none
// gets `no_term` / `not_found` (or `disabled` while the gates are off, the
// same not-available answer as before).
//
// Reuses recordDecision's own semantics (status -> 'cancelled',
// renewal_decision -> 'cancel') — it does NOT end coverage early.
// coveredTermsAsOf's decided-lapse branch (status 'cancelled' AND
// renewal_decision set, ~line 2662) and the disputed-invoice decided-shape
// branches (~3193, ~3437) already treat a cancel decision as riding out its
// PAID window through term_end; this is the exact same state an admin's
// "end at term" cancellation puts a term into (admin-cancellation.js
// decideTermCancel). Nothing here touches coverage directly.
//
// Row lock: the eligible term is SELECT ... FOR UPDATE'd inside our own
// transaction before recordDecision's own atomic
// (status IN ACTIVE_STATUSES AND renewal_decision IS NULL) UPDATE runs, so
// a concurrent decide (staff recording the same decision, or a second
// portal tab) can't race past the eligibility checks below (customer
// ownership, term_end, "already decided") that recordDecision itself
// doesn't know how to make.
//
// Idempotent: a repeat call against an already-declined term (status
// 'cancelled', renewal_decision 'cancel') returns the SAME success shape
// (alreadyDeclined: true) instead of erroring — as long as that year is
// still paid (isPaidDecidedLapseTerm). A decline followed by a refund or
// dispute answers `not_covered` instead (Codex r3 P2), so the portal never
// says "Coverage continues through …" for a year billing no longer covers.
const CUSTOMER_DECLINE_ACTIVITY_ACTION = 'termite_annual_renewal_declined';

function declineResultFromRow(term, { alreadyDeclined }) {
  return {
    ok: true,
    termId: term.id,
    termEnd: dateOnly(term.term_end),
    // An un-anchored original term's termEnd is provisional (Codex r3 P2):
    // staff/customer copy says "12 months from installation" instead.
    awaitsInstallation: coverageAwaitsInstallation(term),
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    alreadyDeclined,
  };
}

// Station retrieval for a portal renewal decline — evaluated at DUE TIME
// (Codex #4940 r9). The termite program ends when the paid year does, so the
// Waves-owned stations come out then — but nothing is decided early: the
// decline (and a later installation anchor) raise NOTHING; the decline's own
// staff bell only says the stations will be retrieved after the paid year.
// The daily reconcile sweep (raisePendingDeclineRetrievalTasks) evaluates a
// portal-declined, installed (or renewal) term once its retrieval is DUE:
//   - its paid-through term_end has passed, or
//   - its prepay was fully refunded / voided (coverage revoked — due now).
// At that moment, with fresh facts:
//   - other live termite coverage on the account (another plan, a live
//     termite service, an active bond — otherLiveTermiteCoverage): the task
//     would count EVERY station on the account, so staff are belled to
//     confirm which stations to pull;
//   - otherwise the retrieval task is raised through the SAME helper an
//     admin cancel uses (cancellation-processor raiseTermiteRetrievalTask),
//     keyed on the term + portal-decline episode, dated to the due date
//     (term_end) or immediate after a refund, with the decline's own time as
//     its place in the account's retrieval chronology (eventAt — other
//     request-keyed retrieval rows can still exist).
// The settled marker (activity_log DECLINE_RETRIEVAL_ACTIVITY_ACTION,
// metadata.term_id) is written ONLY once the durable action is confirmed:
// this decline's own task row exists, or the staff bell insert came back
// non-null. Anything else stays a candidate, rotated least-recently-
// attempted first (decline_retrieval_attempted_at). Once settled, the term
// is done: a term_end correction or a refund AFTER the due action is out of
// scope — the stations are already scheduled out. A term_end correction
// BEFORE the due date needs nothing (nothing was raised yet).
// Scope: only PORTAL declines (a termite_annual_renewal_declined activity
// row for the term). An admin-recorded cancel raises its own retrieval task
// through the admin cancellation flow and is never touched here.
const DECLINE_RETRIEVAL_ACTIVITY_ACTION = 'termite_annual_decline_retrieval';
const DECLINE_RETRIEVAL_EPISODE = 'portal_renewal_decline';
const DECLINE_RETRIEVAL_IMMEDIATE = 'immediate';
// A decided lapse, or a plan declined while unpaid whose invoice never
// resolved (payment_pending + 'cancel' — bells staff only).
const DECLINE_RETRIEVAL_STATUSES = ['cancelled', PAYMENT_PENDING_STATUS];
// Outcomes settled WITHOUT a staff bell: a confirmed task row, or an account
// the helper treats as internal test data (nothing is ever raised there).
const DECLINE_RETRIEVAL_SELF_SETTLING = new Set(['raised', 'internal_test_customer']);

// Columns declineRetrievalEnd (and the anchor's installation rule) reads.
const DECLINE_RETRIEVAL_TERM_COLUMNS = [
  'id', 'customer_id', 'source_estimate_id', 'term_start', 'term_end', 'created_at',
  'annual_plan_version', 'renewed_from_term_id', 'installation_anchored_at',
];

// Every read/write here uses the ROOT pool: raiseTermiteRetrievalTask writes
// on its own connection, so it must only ever see committed state.
async function evaluateDueDeclineRetrieval(termId, today = etDateString()) {
  let retrieval = null;
  try {
    const term = await db('annual_prepay_terms').where({ id: termId })
      .first(...DECLINE_RETRIEVAL_TERM_COLUMNS, 'prepay_invoice_id', 'status', 'renewal_decision');
    const due = await dueDeclineRetrieval(term, today);
    if (due.reason) return { raised: false, reason: due.reason };
    retrieval = { termEnd: due.retrievalEnd, retrieveAfterKey: due.key, customerId: term.customer_id };
    // A failed action is belled (settleDeclineRetrieval) but never settled.
    Object.assign(retrieval, await actOnDueDeclineRetrieval(term, due, today).catch((actErr) => {
      logger.error(`[annual-prepay] renewal-decline retrieval action failed for term ${termId}: ${actErr.message}`);
      return { raised: false, reason: 'failed' };
    }));
    await settleDeclineRetrieval(term.id, retrieval);
    return retrieval;
  } catch (err) {
    logger.error(`[annual-prepay] renewal-decline retrieval failed for term ${termId}: ${err.message}`);
    return { ...(retrieval || {}), raised: false, reason: 'failed' };
  }
}

// Whether this term's retrieval is due now — { portalDecline, retrieveAfter,
// key, retrievalEnd, unpaid } — or why not — { reason }. Due = an
// installed, PORTAL-declined decided lapse, not yet settled, whose prepay
// was refunded/voided (immediate: no coverage owed) or whose paid-through
// end (declineRetrievalEnd) has passed (dated). Also due, once that end has
// passed: a plan declined while UNPAID whose invoice never resolved (still
// payment_pending + 'cancel', #4940 pre-push P1) — `unpaid`, which only
// ever bells staff (actOnDueDeclineRetrieval), never raises a task.
async function dueDeclineRetrieval(term, today) {
  if (!term) return { reason: 'not_found' };
  if (!DECLINE_RETRIEVAL_STATUSES.includes(term.status) || term.renewal_decision !== 'cancel') return { reason: 'not_declined' };
  const retrievalEnd = await declineRetrievalEnd(term);
  if (!retrievalEnd) return { reason: 'not_installed' };
  const termIdText = String(term.id);
  const portalDecline = await db('activity_log')
    .where({ action: CUSTOMER_DECLINE_ACTIVITY_ACTION })
    .whereRaw("metadata->>'term_id' = ?", [termIdText])
    .orderBy('created_at', 'asc')
    .first('id', 'created_at', 'metadata');
  if (!portalDecline) return { reason: 'not_portal_decline' };
  const settled = await db('activity_log')
    .where({ action: DECLINE_RETRIEVAL_ACTIVITY_ACTION })
    .whereRaw("metadata->>'term_id' = ?", [termIdText])
    .first('id');
  if (settled) return { reason: 'already_settled' };
  const unpaid = term.status === PAYMENT_PENDING_STATUS;
  if (!unpaid && await isTermPrepayRefunded(term)) return { portalDecline, retrieveAfter: null, key: DECLINE_RETRIEVAL_IMMEDIATE, retrievalEnd };
  if (retrievalEnd < today) {
    return {
      portalDecline, retrieveAfter: retrievalEnd, key: retrievalEnd, retrievalEnd, unpaid,
    };
  }
  return { reason: 'not_due' };
}

// The date a declined term's stations wait for. An anchored or renewal term:
// its term_end. An original term the anchor never landed on still carries a
// PROVISIONAL term_end (#4940 pre-push P1) — if its installation completed
// (stations in the ground, e.g. the anchor was refused), the real end is
// derived by the anchor's own rule (installation date + 12 months, inclusive);
// with no completed installation there is nothing to retrieve (null).
async function declineRetrievalEnd(term) {
  if (!coverageAwaitsInstallation(term)) return dateOnly(term.term_end);
  const { installationTermWindowForTerm } = require('./termite-annual-activation');
  const window = await installationTermWindowForTerm(term, db);
  return window ? window.termEnd : null;
}

async function isTermPrepayRefunded(term) {
  if (!term.prepay_invoice_id) return false;
  const row = await whereTermPrepayRefunded(db('annual_prepay_terms as rt').where('rt.id', term.id), 'rt').first('rt.id');
  return !!row;
}

// A term whose prepay invoice was voided/refunded, or whose payment was fully
// refunded — billing's revocation evidence (coveredTermsAsOf), minus the
// merely-unpaid case a dispute produces (a dispute can still be won, so it
// waits for term_end like any other declined year).
function whereTermPrepayRefunded(builder, alias) {
  const statuses = [...INVOICE_CANCELLED_STATUSES];
  return builder.whereExists(function refundedPrepay() {
    this.select(db.raw('1')).from('invoices as ri')
      .whereRaw('ri.id = ??', [`${alias}.prepay_invoice_id`])
      .where(function revoked() {
        this.whereRaw(`lower(coalesce(ri.status, '')) in (${statuses.map(() => '?').join(', ')})`, statuses)
          .orWhereExists(function fullRefund() {
            this.select(db.raw('1')).from('payments as rp')
              .whereRaw("(rp.status = 'refunded' or rp.refund_status = 'full')")
              .whereRaw(`((rp.stripe_payment_intent_id is not null and rp.stripe_payment_intent_id = ri.stripe_payment_intent_id)
                or (rp.stripe_charge_id is not null and rp.stripe_charge_id = ri.stripe_charge_id))`);
          });
      });
  });
}

// Codex #4940 r4/r7 P1: raiseTermiteRetrievalTask counts EVERY Waves-owned
// termite station on the ACCOUNT (no property or term key), so an automatic
// "pull the stations" task is only safe when this declined plan is the
// account's ONLY live termite coverage. Anything else — another termite
// annual term, a live termite service still on the calendar (a quarterly
// series, a one-off treatment), or an active termite bond, at any property —
// and staff confirm which stations to pull by hand instead. Returns the
// reason (the staff bell's wording) or null. Visits of THIS plan (linked to
// any term in its renewal ancestry, or booked from the original estimate)
// don't count. Renewal successors deliberately have no source_estimate_id,
// so resolve that ancestry before applying either exclusion. A malformed
// chain gets no exclusions: any live termite visit then fails closed to the
// manual handoff instead of risking an account-wide pull.
async function otherLiveTermiteCoverage(term, today = etDateString()) {
  const otherPlan = await db('annual_prepay_terms')
    .where({ customer_id: term.customer_id })
    .whereNot({ id: term.id })
    .whereNotNull('annual_plan_version')
    .where(function stillCovering() {
      this.whereIn('status', [...ACTIVE_STATUSES, PAYMENT_PENDING_STATUS, ...DECIDED_COVERED_STATUSES])
        .orWhere(function decidedLapse() { this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel'); });
    })
    .where((current) => whereTermCurrentOrAwaitingInstallation(current, today))
    .first('id');
  if (otherPlan) return 'other_termite_plan';
  const renewalScope = await termiteRenewalScope(term, term.customer_id, db);
  const liveService = await db('scheduled_services')
    .where({ customer_id: term.customer_id })
    .whereRaw("LOWER(COALESCE(service_type, '')) LIKE '%termite%'")
    .whereNotIn('status', [...PREPAID_UPDATE_EXCLUDED_STATUSES])
    .where('scheduled_date', '>=', today)
    .modify((q) => {
      if (!renewalScope) return;
      q.where((termLink) => termLink.whereNull('annual_prepay_term_id')
        .orWhereNotIn('annual_prepay_term_id', [...renewalScope.termIds]));
      if (renewalScope.estimateId) {
        q.whereRaw('source_estimate_id IS DISTINCT FROM ?', [renewalScope.estimateId]);
      }
    })
    .first('id');
  if (liveService) return 'other_termite_service';
  const bond = await db('termite_bonds').where({ customer_id: term.customer_id, status: 'active' }).first('id');
  return bond ? 'termite_bond' : null;
}

// The due action, with fresh facts: bell staff when other termite coverage
// remains, otherwise raise the task and classify what actually happened —
// { raised: true } only once THIS decline's own task row exists.
async function actOnDueDeclineRetrieval(term, due, today) {
  // Never paid: whether to collect and whether to pull the stations is a
  // staff decision — no automatic task (the bell settles it).
  if (due.unpaid) return { raised: false, reason: 'unpaid_plan' };
  const otherCoverage = await otherLiveTermiteCoverage(term, today);
  if (otherCoverage) return { raised: false, reason: otherCoverage };
  const { raiseTermiteRetrievalTask, termRetrievalDedupeKey } = require('./cancellation-processor');
  // Codex #4940 r6 P1: the decline has no service request, so it passes its
  // real event time — without it the helper ranks it as the OLDEST event
  // and yields to any earlier request-keyed retrieval row (even one staff
  // already acted on), raising nothing.
  const declineMeta = parseActivityMetadata(due.portalDecline.metadata);
  const raised = await raiseTermiteRetrievalTask(term.customer_id, null, {
    retrieveAfter: due.retrieveAfter, termId: term.id, episodeKey: DECLINE_RETRIEVAL_EPISODE, eventAt: declineMeta.decided_at || due.portalDecline.created_at,
  });
  // A NEWER retrieval instruction stands on the account — nothing was
  // created or reopened for THIS decline; staff confirm it covers these.
  if (raised?.supersededByNewer) return { raised: false, reason: 'superseded_by_newer' };
  if (!raised?.raised) return { raised: false, reason: raised?.reason || 'not_raised' };
  const taskRow = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [termRetrievalDedupeKey(term.id, DECLINE_RETRIEVAL_EPISODE, due.retrieveAfter)])
    .first('id');
  return taskRow ? { raised: true } : { raised: false, reason: 'not_raised' };
}

function parseActivityMetadata(metadata) {
  if (typeof metadata !== 'string') return metadata || {};
  try { return JSON.parse(metadata); } catch { return {}; }
}

// Settle ONLY on a confirmed durable action: this decline's task row, or a
// staff bell whose insert came back non-null (every manual outcome). A
// retryable failure (failed / not_raised) is belled at most once per day
// (the bell's dedupe) but never settles — the sweep retries it.
async function settleDeclineRetrieval(termId, retrieval) {
  const outcome = retrieval.raised ? 'raised' : retrieval.reason;
  if (DECLINE_RETRIEVAL_SELF_SETTLING.has(outcome)) {
    await writeDeclineRetrievalMarker(termId, retrieval, outcome);
    return;
  }
  const belled = await ringDeclineRetrievalStaffBell(termId, retrieval);
  if (belled && RETRIEVAL_SENTENCES[outcome]?.manual) await writeDeclineRetrievalMarker(termId, retrieval, outcome);
}

// The staff bell for a due retrieval that could not be raised automatically.
// Returns true only when notifyAdmin confirms a stored row.
async function ringDeclineRetrievalStaffBell(termId, retrieval) {
  const sentence = retrievalSentence(retrieval, formatDateLabel(retrieval.termEnd));
  if (!sentence) return false;
  try {
    const NotificationService = require('./notification-service');
    const bell = await NotificationService.notifyAdmin(
      'service',
      'Termite annual plan — station retrieval needs staff',
      `A termite annual plan declined online has reached its station retrieval. ${sentence}`,
      {
        icon: '🪵',
        link: `/admin/customers?customerId=${retrieval.customerId}`,
        bell: true,
        dedupeKey: `termite-annual-decline-retrieval:${termId}:${retrieval.retrieveAfterKey}:${retrieval.reason}`,
        metadata: {
          customerId: retrieval.customerId,
          termId,
          termEnd: retrieval.termEnd,
          retrieveAfter: retrieval.retrieveAfterKey,
          reason: retrieval.reason,
          source: 'customer_portal',
        },
      },
    );
    return !!(bell && bell.id);
  } catch (bellErr) {
    logger.error(`[annual-prepay] decline retrieval staff bell failed for term ${termId}: ${bellErr.message}`);
    return false;
  }
}

async function writeDeclineRetrievalMarker(termId, retrieval, outcomeKey) {
  const when = retrieval.retrieveAfterKey === DECLINE_RETRIEVAL_IMMEDIATE
    ? 'immediately (prepay refunded)'
    : `after ${retrieval.retrieveAfterKey}`;
  await db('activity_log').insert({
    customer_id: retrieval.customerId,
    action: DECLINE_RETRIEVAL_ACTIVITY_ACTION,
    description: `Station retrieval after the online renewal decline: ${outcomeKey} (retrieve ${when}).`,
    metadata: {
      term_id: termId,
      term_end: retrieval.termEnd,
      retrieve_after: retrieval.retrieveAfterKey,
      outcome: outcomeKey,
      source: 'customer_portal',
    },
  }).catch((markerErr) => {
    // The task itself is idempotent on its key — a lost marker costs one
    // deduped re-evaluation on the next sweep, never a second task.
    logger.warn(`[annual-prepay] decline retrieval marker not written for term ${termId}: ${markerErr.message}`);
  });
}

// Daily sweep (reconcileTermiteAnnualActivations): every portal-declined,
// installed (or renewal) termite term whose retrieval is DUE (term_end
// passed, or prepay refunded/voided) and not yet settled — plus a plan
// declined while unpaid whose invoice never resolved (staff bell only,
// once its installation-derived end has passed). No upper date
// bound — an action that keeps failing is retried until it is confirmed.
// Bounded; least-recently-attempted first (decline_retrieval_attempted_at,
// never-attempted ahead of all), then oldest end, so a term whose action
// keeps failing rotates instead of starving the others.
async function raisePendingDeclineRetrievalTasks({ limit = 50, today = etDateString() } = {}) {
  const attemptTracked = !!(await annualPrepayColumns()).decline_retrieval_attempted_at;
  const candidates = await db('annual_prepay_terms as dt')
    .whereNotNull('dt.annual_plan_version')
    .whereIn('dt.status', DECLINE_RETRIEVAL_STATUSES)
    .where('dt.renewal_decision', 'cancel')
    .where(function installed() {
      // Anchored, a renewal term, or a completed installation visit on file
      // (stations in the ground even when the anchor never landed).
      const { whereTermHasCompletedInstallation } = require('./termite-annual-activation');
      this.whereNotNull('dt.installation_anchored_at').orWhereNotNull('dt.renewed_from_term_id')
        .orWhere((evidence) => whereTermHasCompletedInstallation(evidence, 'dt', db));
    })
    .where(function due() {
      this.where('dt.term_end', '<', today).orWhere((refunded) => whereTermPrepayRefunded(refunded, 'dt'));
    })
    .whereExists(function portalDecline() {
      this.select(db.raw('1')).from('activity_log as a')
        .where('a.action', CUSTOMER_DECLINE_ACTIVITY_ACTION)
        .whereRaw("a.metadata->>'term_id' = dt.id::text");
    })
    .whereNotExists(function alreadySettled() {
      this.select(db.raw('1')).from('activity_log as m')
        .where('m.action', DECLINE_RETRIEVAL_ACTIVITY_ACTION)
        .whereRaw("m.metadata->>'term_id' = dt.id::text");
    })
    .modify((q) => { if (attemptTracked) q.orderBy('dt.decline_retrieval_attempted_at', 'asc', 'first'); })
    .orderBy('dt.term_end', 'asc')
    .limit(limit)
    .select('dt.id');
  let raised = 0;
  for (const row of candidates) {
    if (attemptTracked) {
      // Stamped before the attempt so a failing term rotates to the back.
      await db('annual_prepay_terms').where({ id: row.id }).update({ decline_retrieval_attempted_at: new Date() })
        .catch((stampErr) => logger.warn(`[annual-prepay] decline retrieval attempt stamp failed for term ${row.id}: ${stampErr.message}`));
    }
    const retrieval = await evaluateDueDeclineRetrieval(row.id, today);
    if (retrieval.raised) raised += 1;
  }
  await correctDeclineRetrievalDates(today).catch((err) => {
    logger.error(`[annual-prepay] decline retrieval date correction pass failed: ${err.message}`);
  });
  return { scanned: candidates.length, raised };
}

// Codex #4940 r10 P1: a staff correction to term_end AFTER the due-time task
// was raised. Every dated portal-decline task is checked, READ ones too
// (Codex r11: opening the bell marks it read — that is not the retrieval),
// bounded to tasks dated within the last six months or later. Per term, only
// the LATEST task is compared with the term's current retrieval end
// (declineRetrievalEnd); the same date means it is current — nothing done:
//   - end moved LATER than the task's date: the stations must wait —
//     re-raise dated to the new end through the same helper (its dedupe key
//     includes the date, and it retires the obsolete open row); the marker
//     records the new date, and staff are belled with the correction (they
//     may already have read the old task);
//   - end moved EARLIER: the stations are due sooner and a task already
//     stands — staff are belled with the correction (once per new date).
async function correctDeclineRetrievalDates(today) {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'kind' = 'termite_station_retrieval'")
    .whereRaw("metadata->>'churnEpisode' = ?", [DECLINE_RETRIEVAL_EPISODE])
    .whereRaw("metadata->>'retrieveAfter' >= ?", [addMonthsSameDayShared(today, -6)])
    .orderBy('created_at', 'desc')
    .select('metadata');
  const latestByTerm = new Map();
  for (const row of rows) {
    const meta = parseActivityMetadata(row.metadata);
    if (meta.termId && !latestByTerm.has(meta.termId)) latestByTerm.set(meta.termId, meta);
  }
  for (const latest of latestByTerm.values()) await correctDeclineRetrievalDate(latest, today);
}

async function correctDeclineRetrievalDate(meta, today) {
  const term = await db('annual_prepay_terms').where({ id: meta.termId }).first(...DECLINE_RETRIEVAL_TERM_COLUMNS);
  // The same end the due check used — never a provisional term_end.
  const termEnd = term ? await declineRetrievalEnd(term) : null;
  if (!termEnd || termEnd === meta.retrieveAfter) return;
  const retrieval = { termEnd, customerId: term.customer_id, retrieveAfterKey: termEnd };
  if (termEnd < meta.retrieveAfter) {
    await ringDeclineRetrievalStaffBell(term.id, { ...retrieval, raised: false, reason: 'date_moved_earlier', previousRetrieveAfter: meta.retrieveAfter });
    return;
  }
  const portalDecline = await db('activity_log')
    .where({ action: CUSTOMER_DECLINE_ACTIVITY_ACTION })
    .whereRaw("metadata->>'term_id' = ?", [String(term.id)])
    .orderBy('created_at', 'asc')
    .first('id', 'created_at', 'metadata');
  if (!portalDecline) return;
  Object.assign(retrieval, await actOnDueDeclineRetrieval(term, { portalDecline, retrieveAfter: termEnd, key: termEnd }, today));
  // Re-raised: record the new date and bell the correction. Otherwise (other
  // coverage now, a newer instruction, a failure) staff are belled — once per
  // new date, the bell's dedupe — and the stale row is left for them.
  if (retrieval.raised) {
    await writeDeclineRetrievalMarker(term.id, retrieval, 'raised');
    await ringDeclineRetrievalStaffBell(term.id, { ...retrieval, reason: 'date_moved_later', previousRetrieveAfter: meta.retrieveAfter });
  } else {
    await ringDeclineRetrievalStaffBell(term.id, retrieval);
  }
}

// Staff-facing sentence per due-time outcome. `when` is "after <date>" for a
// retrieval due at term_end, "now" after a refund. `manual` marks outcomes
// that settle once the staff bell is stored (staff now own the action);
// failed / not_raised are belled but retried.
const RETRIEVAL_SENTENCES = {
  unpaid_plan: {
    manual: true,
    text: (_when, retrieval) => `The customer declined renewal and the plan was never paid; its installation-derived end ${formatDateLabel(retrieval.termEnd)} has passed — decide on collection and station retrieval. No retrieval task was raised automatically.`,
  },
  no_rented_stations: { manual: true, text: () => 'No Waves-owned termite stations are on file, so no retrieval task was raised — confirm none need collecting.' },
  other_termite_plan: { manual: true, text: (when) => `This customer has another termite annual plan, so no retrieval task was raised automatically — confirm which stations to pull ${when}.` },
  other_termite_service: { manual: true, text: (when) => `This customer still has termite service on the calendar, so no retrieval task was raised automatically — confirm which stations to pull ${when}.` },
  termite_bond: { manual: true, text: (when) => `This customer has an active termite bond, so no retrieval task was raised automatically — confirm which stations to pull ${when}.` },
  superseded_by_newer: { manual: true, text: (when) => `A newer station-retrieval instruction already stands on this account, so no separate task was raised for this decline — confirm it covers pulling the stations ${when}.` },
  failed: { manual: false, text: (when) => `The station-retrieval task could not be raised yet — it is retried automatically each day; create it by hand ${when === 'now' ? 'now' : `for ${when}`} if it does not appear.` },
  date_moved_later: {
    manual: false,
    text: (when, retrieval) => `Its paid-through date was corrected to ${formatDateLabel(retrieval.termEnd)}, later than the earlier station-retrieval task said (after ${formatDateLabel(retrieval.previousRetrieveAfter)}) — a replacement task was raised: the stations come out ${when}, not before.`,
  },
  date_moved_earlier: {
    manual: false,
    text: (when, retrieval) => `Its paid-through date was corrected to ${formatDateLabel(retrieval.termEnd)}, earlier than the open station-retrieval task says (after ${formatDateLabel(retrieval.previousRetrieveAfter)}) — the stations can come out ${when}.`,
  },
};
RETRIEVAL_SENTENCES.not_raised = RETRIEVAL_SENTENCES.failed;

function retrievalSentence(retrieval, termEndLabel) {
  const entry = RETRIEVAL_SENTENCES[retrieval?.reason];
  if (!entry) return '';
  return entry.text(retrieval.retrieveAfterKey === DECLINE_RETRIEVAL_IMMEDIATE ? 'now' : `after ${termEndLabel}`, retrieval);
}

// The decline bell's retrieval line: nothing is raised now — the stations
// come out once the paid year ends (or at once if the prepay is refunded).
function declineRetrievalPlanSentence(result, formatEnd) {
  const whenEnds = result.awaitsInstallation
    ? 'the 12-month coverage year from the station installation ends'
    : `coverage ends ${formatEnd(result.termEnd)}`;
  return `The stations will be retrieved after ${whenEnds}: a retrieval task is raised then (or staff are asked to confirm which stations, if other termite coverage remains).`;
}

// "Coverage continues through <date>" — or, for an original term not yet
// anchored to its station installation (its term_end is provisional),
// installation-relative wording that quotes no date.
function declineCoverageSentence(awaitsInstallation, termEnd, formatEnd = (d) => d, unpaid = false) {
  // Declined before the prepay was paid (move 15): coverage only if it is.
  if (unpaid) {
    return `The prepay is not paid yet; if it is paid, coverage runs ${awaitsInstallation ? '12 months from the station installation' : `through ${formatEnd(termEnd)}`}`;
  }
  return awaitsInstallation
    ? 'Coverage runs 12 months from the station installation (not yet installed)'
    : `Coverage continues through ${formatEnd(termEnd)}`;
}

async function ringTermiteAnnualDeclineBell(result, customerId, conn) {
  try {
    const NotificationService = require('./notification-service');
    const customer = await conn('customers').where({ id: customerId }).first('first_name', 'last_name').catch(() => null);
    const name = customer ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() : null;
    await NotificationService.notifyAdmin(
      'estimate',
      'Termite annual plan — renewal declined online',
      [
        `${name || 'A customer'} declined renewal for their termite annual plan through the customer portal${result.supersededRenew ? ', replacing the renewal staff had recorded' : ''}.`,
        `${declineCoverageSentence(result.awaitsInstallation, result.termEnd, formatDateLabel, result.unpaid)}.`,
        declineRetrievalPlanSentence(result, formatDateLabel),
      ].filter(Boolean).join(' '),
      {
        icon: '📋',
        link: `/admin/customers?customerId=${customerId}`,
        bell: true,
        dedupeKey: `termite-annual-renewal-decline:${result.termId}`,
        metadata: {
          customerId,
          termId: result.termId,
          // A provisional end date is never recorded as the coverage end.
          termEnd: result.awaitsInstallation ? null : result.termEnd,
          awaitsInstallation: result.awaitsInstallation === true,
          source: 'customer_portal',
        },
        // Only a real caller transaction rides along: on the root pool
        // notifyAdmin must open its own, so its dedupe advisory lock spans
        // the lookup + insert (concurrent retries can't double-bell).
        ...(conn === db ? {} : { trx: conn }),
      },
    );
  } catch (bellErr) {
    logger.error(`[annual-prepay] renewal-decline bell failed for term ${result.termId}: ${bellErr.message}`);
  }
}

// Why an undeclined termite annual term can't be declined online right now
// (null = it can). Shared by the portal GET's canDecline and the decline
// write so the control is never offered for a POST that will refuse:
// - a different decision already on file is never overwritten;
// - a live term (ACTIVE_STATUSES) or a signed plan still payment_pending
//   (an unpaid original invoice, or a dispute-suspended one — Codex #4940
//   r9: agreement v3 lets the customer decline "at any time before the
//   renewal date", paid or not). A declined payment_pending term becomes a
//   decided lapse (move 15): paid later, it covers the paid year and never
//   renews; never paid, nothing is covered;
// - strictly BEFORE the renewal date (agreement v3: "decline renewal at any
//   time before the renewal date") — a term ending today has already
//   reached its renewal date, so it is `term_ended`, not declinable.
// `today` defaults to the ET calendar day so a caller inside an existing
// transaction can still pass the same `today` it resolved once itself.
// Online decline is available BEFORE installation too (codex round-1 P1,
// reversing the earlier "paid, installed plan only" restriction) —
// anchorTermToInstallation / anchorInstalledTerms (termite-annual-
// activation.js) now anchor a decided-lapse original term the same as an
// undecided one, so a decline no longer strands the coverage year.
function termiteDeclineBlockedReason(term, today = etDateString(), { hasSuccessor = true } = {}) {
  // Codex #4940 r4 P1: a staff 'renew' not yet processed (no successor
  // term) is superseded by the customer's decline — the date rule below
  // still applies. The conservative default treats every renew as
  // processed; callers that checked for a successor pass hasSuccessor.
  const supersedableRenew = term.status === 'renewed' && term.renewal_decision === 'renew' && !hasSuccessor;
  if (!supersedableRenew) {
    if (term.renewal_decision) return 'already_decided';
    if (!ACTIVE_STATUSES.includes(term.status) && term.status !== PAYMENT_PENDING_STATUS) return 'not_active';
  }
  // Codex r3 P1: an original term not yet anchored to its installation has
  // a PROVISIONAL term_end — its real renewal date doesn't exist yet, so it
  // is never cut off by that placeholder.
  if (coverageAwaitsInstallation(term)) return null;
  const termEnd = dateOnly(term.term_end);
  if (!termEnd || termEnd <= today) return 'term_ended';
  return null;
}

// The portal's "current term" rule, shared by the GET (property.js) and the
// no-selector decline path: a term not yet past its end date, OR an
// original termite term still awaiting installation (coverageAwaitsInstallation
// — its term_end is a placeholder, never a cutoff). Column names are bare
// unless the caller's query aliases annual_prepay_terms (pass `alias`).
function whereTermCurrentOrAwaitingInstallation(builder, today, alias = null) {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return builder.where(col('term_end'), '>=', today)
    .orWhere(function awaitingInstallation() {
      this.whereNotNull(col('annual_plan_version')).whereNull(col('renewed_from_term_id')).whereNull(col('installation_anchored_at'));
    });
}

// Replay of an already-declined term: the same success shape only while the
// year is still PAID (billing's own test) — a later refund/dispute answers
// not_covered, never "coverage continues".
async function alreadyDeclinedResult(term, conn) {
  if (!(await isPaidDecidedLapseTerm(term, conn))) {
    return { ok: false, reason: 'not_covered', termId: term.id };
  }
  return declineResultFromRow(term, { alreadyDeclined: true });
}

// A term already declined answers the same success shape: the decided-lapse
// shape (cancelled + cancel, re-checked still paid), or an unpaid plan
// already declined (decision on a payment_pending term, status unchanged —
// Codex #4940 r10). null = not declined yet.
async function declineReplayResult(term, trx) {
  if (term.renewal_decision !== 'cancel') return null;
  if (term.status === 'cancelled') return alreadyDeclinedResult(term, trx);
  if (term.status === PAYMENT_PENDING_STATUS) return { ...declineResultFromRow(term, { alreadyDeclined: true }), unpaid: true };
  return null;
}

// The decline's refusal ladder: the term's own shape and dates
// (termiteDeclineBlockedReason), then — Codex #4971 r4/r5 P1 — renewal
// money still clearing on this term ('renewal_payment_clearing': the
// decline waits until it settles). The live case is a renewal successor
// declined while its OWN renewal payment clears; a pending successor of
// this term is checked too (renewalMoneyInMotionForTerm). Read inside the
// decline's transaction, which already holds the gate for the customer's
// termite terms, so no renewal charge can start in between.
async function declineRefusalReason(term, today, options, trx) {
  const blocked = termiteDeclineBlockedReason(term, today, options);
  if (blocked) return blocked;
  const clearing = await require('./termite-annual-renewal-charge').renewalMoneyInMotionForTerm(trx, term);
  return clearing ? 'renewal_payment_clearing' : null;
}

// The refusal shape for each termiteDeclineBlockedReason.
function declineRefusal(term, reason) {
  const detail = {
    already_decided: { decision: term.renewal_decision },
    not_active: { status: term.status },
    term_ended: { termEnd: dateOnly(term.term_end) },
  }[reason];
  return { ok: false, reason, ...detail, termId: term.id };
}

async function declineTermiteAnnualRenewal({ customerId, termId = null, today = etDateString(), conn = db } = {}) {
  if (!customerId) return { ok: false, reason: 'missing_customer' };
  if (!(await annualPrepayTableExists())) return { ok: false, reason: 'disabled' };
  // Not gated — see the header: the gates only control issuing new plans.
  const notFound = () => {
    const { termiteAnnualPlanSelectionEnabled } = require('../config/feature-gates');
    if (!termiteAnnualPlanSelectionEnabled()) return { ok: false, reason: 'disabled' };
    return { ok: false, reason: termId ? 'not_found' : 'no_term' };
  };

  const work = async (trx) => {
    const term = await trx('annual_prepay_terms')
      .where({ customer_id: customerId })
      .whereNotNull('annual_plan_version')
      // No explicit term (internal callers only — the portal POST always
      // names one): the CURRENT term (earliest one not yet ended, or one
      // still awaiting installation, whose term_end is only provisional),
      // never a historical row — the same filter the portal GET uses.
      .modify((q) => {
        if (termId) q.where({ id: termId });
        else q.where((current) => whereTermCurrentOrAwaitingInstallation(current, today));
      })
      .orderBy('term_end', 'asc')
      .forUpdate()
      .first('*');
    if (!term) return notFound();

    // Idempotent replay first — even once its term_end has since passed,
    // rather than a confusing term_ended.
    const replay = await declineReplayResult(term, trx);
    if (replay) return replay;
    const renewDecided = term.status === 'renewed' && term.renewal_decision === 'renew';
    const hasSuccessor = renewDecided ? await hasSuccessorTerm(term.id, trx) : true;
    const blocked = await declineRefusalReason(term, today, { hasSuccessor }, trx);
    if (blocked) return declineRefusal(term, blocked);

    // A superseded staff renew must still be a PAID year — never turn a
    // refunded/disputed renewed term into "coverage continues".
    if (renewDecided && !(await isCoveredTerm(term.id, trx))) {
      return { ok: false, reason: 'not_active', status: term.status, termId: term.id };
    }

    const unpaid = term.status === PAYMENT_PENDING_STATUS;
    const decided = await recordCustomerDecline(term, { renewDecided, unpaid }, trx);
    if (!decided) {
      // The guarded write (recordDecision / move 14 / move 15) didn't match
      // despite our lock — re-read for the idempotent shape rather than
      // report a false failure.
      const reread = await trx('annual_prepay_terms').where({ id: term.id }).first('*');
      if (reread && reread.status === 'cancelled' && reread.renewal_decision === 'cancel') {
        return alreadyDeclinedResult(reread, trx);
      }
      return { ok: false, reason: 'conflict', termId: term.id };
    }

    await trx('activity_log').insert({
      customer_id: customerId,
      action: CUSTOMER_DECLINE_ACTIVITY_ACTION,
      description: `Declined renewal online through the customer portal. ${declineCoverageSentence(coverageAwaitsInstallation(decided), dateOnly(decided.term_end), undefined, unpaid)}.`,
      metadata: {
        term_id: decided.id,
        source: 'customer_portal',
        decided_at: new Date().toISOString(),
        ...(renewDecided ? { superseded_decision: 'renew' } : {}),
        ...(unpaid ? { unpaid: true } : {}),
      },
    });

    return {
      ...declineResultFromRow(decided, { alreadyDeclined: false }),
      ...(renewDecided ? { supersededRenew: true } : {}),
      // Declined before the prepay was paid: the portal says only that the
      // plan will not renew — there is no paid coverage to quote yet.
      ...(unpaid ? { unpaid: true } : {}),
    };
  };

  // Chokepoint B (pre-push lock order): the decline's own transaction takes
  // the gate for the customer's termite terms FIRST — before work() locks
  // the term row — so it can never hold that row while a renewal charge
  // holding the gate waits on it.
  const result = conn === db
    ? await db.transaction(async (trx) => {
      await acquireTermiteGateAtEntry(trx, { customerIds: [customerId] });
      return work(trx);
    })
    : await work(conn);
  if (!result.ok) return result;
  // Nothing is raised at decline time (Codex #4940 r9): the staff bell says
  // when the stations come out, and the daily sweep evaluates the station
  // retrieval once it is due.
  await ringTermiteAnnualDeclineBell(result, customerId, conn);
  const { supersededRenew: _supersededRenew, ...publicResult } = result;
  return publicResult;
}

module.exports = {
  createTermForAnnualPrepay,
  termiteDeclineBlockedReason,
  whereTermCurrentOrAwaitingInstallation,
  // Codex pre-push P1: the portal GET (property.js) and /api/auth/me's
  // paid-through badge (auth.js) both re-check a decided-lapse row
  // (cancelled + renewal_decision 'cancel') with this before ever
  // displaying it as covered — the SAME test coveredTermsAsOf uses, so a
  // refunded or disputed invoice can never leave display and billing
  // disagreeing about whether the term is actually covered.
  isPaidDecidedLapseTerm,
  isCoveredTerm,
  hasSuccessorTerm,
  // Station retrieval for a portal renewal decline — the installation
  // anchor and the daily reconcile raise it (termite-annual-activation.js).
  raisePendingDeclineRetrievalTasks,
  // The portal renewal card's per-term property label (property.js GET
  // /termite-annual-plan) — ownership-scoped, see its definition.
  termPropertyLabelsForCustomer,
  // "Is this term_end still provisional?" (an un-anchored original termite
  // annual term) — the portal card and /me read it so a provisional date
  // is never quoted to the customer.
  coverageAwaitsInstallation,
  refreshTermSnapshot,
  refreshActiveTermsForCustomer,
  // ADMIN-BUG-R18: Cancel plan annotates an already-decided cancel through
  // this (admin-cancellation never writes annual_prepay_terms itself), and
  // the end-at-term lapse upkeep is reachable for its tests.
  recordCancelDisposition,
  isEndAtTermLapseInWindow,
  keepEndAtTermLapseCoverage,
  CANCEL_DISPOSITIONS,
  // Public: the one-step-prepay booking preflight (admin-schedule) matches the
  // booked service against the quoted coverage with the SAME matcher that
  // stamps/gates coverage — destructuring it from the module root must work
  // (it used to live only under _private, which left the route's destructure
  // undefined and 500'd the booking).
  serviceMatchesCoverage,
  // Public for the same reason: admin-cancellation.js destructures the
  // canonical covered-visit identity from the module root (the end-of-coverage
  // keep set, the prepay refund's completed-visit count, the scoped-cancel
  // coverage conflict). Under _private only, all three failed closed: "End
  // of paid coverage" always refused, every refund went to manual
  // calculation, and a scoped cancel on a prepay account refused.
  coverageRowsForTerm,
  syncTermForInvoicePayment,
  syncTermForRefundedPayment,
  activatePaidPendingTerms,
  suspendActiveTermsForDisputedInvoice,
  reconcileCoveredTermsSweep,
  restampUnstampedActiveTerms,
  getActivelyCoveredCustomerIds,
  getCardExpiryExemptCustomerIds,
  getCardExpiryExemptions,
  computeCardExpiryExemptions,
  clearCardExpiryExemptCache,
  getPaymentPendingCustomerIds,
  getOpenRenewalAlerts,
  sendCustomerTermNotice,
  checkAndSend,
  hasAnnualPrepayRenewal,
  applyPrepaidCoverageForTerm,
  securePlanSoldPerVisitCents,
  reconcilePendingWindowCompletions,
  reconcileDisputeWindowMonthlyDues,
  finishDisputeRecoveryForTerm,
  reversePendingWindowCompletionCredits,
  reverseWaveguardExtensionCredits,
  restoreWaveguardExtensionCredits,
  clearPrepaidStampsForTerm,
  annualPrepayCoversVisit,
  coveredTermsAsOf,
  retryPaidLapseReconciles,
  ANNUAL_PREPAY_PREPAID_METHOD,
  recordDecision,
  // Codex round-7 P1: the per-term advisory lock recordDecision itself
  // takes — exported so termite-annual-renewal-charge.js's charge path
  // can hold the SAME lock across its own Stripe submission.
  withParentDecisionLock,
  runOutsideParentDecisionLocks,
  assertParentDecisionLockAlive,
  // Chokepoint B (Codex #4971 round-3 P1 / pre-push lock order): the FIRST
  // lock of a writer's own transaction, keyed on the termite terms tied to
  // what it touches — callers outside this module (voidInvoice and the
  // cancelled-service void, the dispute webhooks, admin-invoices' remove-
  // flag and reverse-prepaid routes) take it at their transaction entry.
  acquireTermiteGateAtEntry,
  acquireTermiteGateForCharge,
  acquireTermiteGateForStatement,
  withTermiteGateForCharge,
  // Termite renewal grace window (P1-2 / P2-4): the ONE shared cutoff
  // between coveredTermsAsOf's grace-coverage branch (here) and
  // termite-annual-renewal-charge.js's own grace-lapse pass.
  TERMITE_RENEWAL_GRACE_DAYS,
  termiteRenewalGraceDeadlineFor,
  termiteRenewalGraceDeadlineSql,
  // Codex round-2 P1 backstop: reconciles an active, paid termite renewal
  // successor whose PARENT never got its 'renewed' stamp (a failure inside
  // stampParentRenewedForSuccessor's own savepoint, swallowed to protect
  // the successor's own activation).
  reconcileParentRenewedStamps,
  declineTermiteAnnualRenewal,
  // Codex #4971 post-push audit round-6 P1 (item 2): reused by the
  // grace-lapse retrieval task, the SAME "is this plan the account's ONLY
  // live termite coverage" guard #4940's own portal-decline retrieval
  // already uses — never a parallel re-derivation of the same check.
  otherLiveTermiteCoverage,
  // ADMIN-BUG-R16/R17: the canonical term-cancel pipeline and its
  // billing_mode restore, both now shared by callers OUTSIDE this module
  // (admin-invoices.js's remove-flag and reverse-prepaid routes) so no
  // writer can flip a term's status or a customer's billing_mode by hand.
  cancelTermWithRestorations,
  resetBillingModeAfterTermCancel,
  // Root exports (not only _private): the annual-prepay-invoice route
  // validates the operator's first-visit time with the SAME normalizer that
  // persists it and the SAME conflict predicate the seeder re-checks with, so
  // route validation and stored behavior can never drift apart.
  normalizeWindowStart,
  findVisitWindowConflict,
  // Root exports: the "still live/undecided" term-status vocabulary
  // (recurring-series-topup's own eligibility scope cut needs the SAME
  // set coveredTermsAsOf treats as live, never a second hand-picked list
  // that can drift from it). ACTIVE_STATUSES excludes payment_pending
  // deliberately (a term stays payment_pending until its invoice is
  // actually paid) — callers that also treat an UNPAID payment_pending
  // term as "still deciding" add PAYMENT_PENDING_STATUS explicitly.
  ACTIVE_STATUSES,
  PAYMENT_PENDING_STATUS,
  // The terminal-visit vocabulary clearPrepaidStampsForTerm treats as
  // "already serviced — leave its stamp for audit" (ADMIN-BUG-R17-FINDING-5):
  // admin-invoices' remove-flag route detaches the term link from a term's
  // scheduled_services rows on removal, and must exclude the SAME statuses
  // clearPrepaidStampsForTerm excludes, or a skipped/rescheduled visit's
  // coverage-history link is severed while its stamp is kept — orphaning the
  // audit trail clearPrepaidStampsForTerm deliberately preserves.
  PREPAID_UPDATE_EXCLUDED_STATUSES,
  // The cadence a term will actually run at (explicit cadence, else the
  // service-type wording, else the stored visit count) — the prepay
  // routes' retired-plan gate reads the same inference the coverage
  // schedule is built from (codex r17 on #4786).
  inferCoverageCadence,
  // Column-existence probe for annual_prepay_terms, cached like the analogous
  // scheduled_services/invoices probes — admin-invoices' reverse-prepaid
  // route needs it to column-guard the SAME dispute_suspended_at marker
  // suspendActiveTermsForDisputedInvoice stamps (ADMIN-BUG-R17-FINDING-1).
  annualPrepayColumns,
  _private: {
    PARENT_DECISION_LOCK_SESSIONS,
    supersedeRenewWithCustomerCancel,
    declinePaymentPendingWithCustomerCancel,
    runTermiteNoticePass,
    noticeWitnessColumn,
    PENDING_COMPLETION_REVERSAL_IDENTITIES,
    dateOnly,
    addMonthsSameDay,
    addDaysYmd,
    daysUntil,
    noticeColumnForDaysOut,
    noticeClaimColumnForDaysOut,
    isTermiteAnnualPlanTerm,
    formatCurrencyLabel,
    termiteNoticeObligationCandidates,
    termiteRungDue,
    processTermiteNoticeObligations,
    termiteMissedNoticeEscalationCandidates,
    fileTermiteMissedNoticeException,
    termiteUndeliveredNoticeEscalationCandidates,
    termiteUndeliveredRungs,
    priorTermiteSmsAcceptance,
    priorTermiteNoticeAcceptance,
    recoverTermiteNoticeFromAcceptance,
    stampTermNoticeWitness,
    claimCombinedTermNotice,
    claimTermNotice,
    releaseCombinedTermNoticeClaim,
    releaseTermNoticeClaim,
    resolveUnstampedWitness,
    termiteWitnessConflictCandidates,
    fileTermiteWitnessConflictException,
    refileWitnessConflictBell,
    unbelledWitnessConflicts,
    recordWitnessConflict,
    stampWitnessConflictBelled,
    ownsNoticeClaims,
    ensureTermNoticeLease,
    termNoticeSmsPolicy,
    smsLegOf,
    smsEmailFallback,
    recoveryPlan,
    recoveredBeforeEscalation,
    fileTermiteUndeliveredNoticeException,
    originalEmailAcceptance,
    TERMITE_45_UNDELIVERED_ESCALATION_COLUMN,
    TERMITE_30_UNDELIVERED_ESCALATION_COLUMN,
    termiteLateColumnForDaysOut,
    termiteLateEscalationColumnForDaysOut,
    planPropertyForTerm,
    termNoticeAddress,
    successorCoverageScope,
    rowInRenewalScope,
    annualPrepayTableExists,
    TERMITE_EXTRA_NOTICE_DAYS,
    TERMITE_COPY_NOTICE_DAYS,
    TERMITE_30_LATE_NOTICE_COLUMN,
    TERMITE_30_LATE_ESCALATION_COLUMN,
    TERMITE_NOTICE_MISSED_ESCALATION_COLUMN,
    shouldAlertTerm,
    isLastServiceNearTermEnd,
    invoiceTermStatus,
    wherePrepayInvoiceCollected,
    PREPAY_INVOICE_COLLECTED_STATUSES,
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
    attachScheduledServices,
    ensureCoverageRowsForTerm,
    coverageRowsForTerm,
    detachCallbacksFromTerm,
    fileCoverageExceptionAfterCommit,
    resetCachesForTests,
    stampParentRenewedForSuccessor,
    annualPrepayColumns,
    coverageAwaitsInstallation,
    termiteNoticePreflight,
    fileTermiteAwaitingInstallationException,
    fileTermiteLateNoticeException,
    termiteLateNoticeEscalationCandidates,
  },
};
