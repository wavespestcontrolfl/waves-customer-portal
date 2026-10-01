'use strict';

/**
 * Annual rate review — APPLY lane (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 3). Stacked
 * on the ranking backend (services/rate-review.js, PR #5468).
 *
 * Two jobs, both dark behind GATE_RATE_REVIEW (rateReviewLive(), read at
 * call time — off = return before any query; kill = unset the variable and
 * every customer simply keeps the lower, current rate):
 *
 *   scheduleNoticeRows(batchKey)   admin POST. Every `approved` ranking row
 *     with a positive delta gets ONE price_change_notices row (status
 *     'draft' — NOTHING IS SENT HERE; the comms PR sends and flips it to
 *     'sent'). The row carries the exact numbers the customer will see
 *     (noticed_current_cents / noticed_new_cents) and the effective date:
 *       per_application   the first open visit of the plan line dated on or
 *                         after the anniversary AND at least MIN_NOTICE_DAYS
 *                         (price-change-notices.js, 30) after the planned
 *                         send; a monthly-cadence line rolls forward visit
 *                         by visit until the 30-day rule holds; no such
 *                         visit → held, no notice.
 *       monthly_membership the first dues day (customers.billing_day) under
 *                         the same two floors.
 *       annual_prepay     the successor term's start (term_end + 1); held
 *                         when that is under 31 days out or a renewal
 *                         reminder already went out for the term. Its
 *                         notice amounts are the ANNUAL totals (the term's
 *                         amount → the successor's), labelled per year —
 *                         the public page shows them as stored; the
 *                         per-application figures ride in metadata.
 *     The ranking row keeps status `approved` and records notice_id; only
 *     the comms PR marks it `sent`.
 *
 *   applyDueRateChanges({ asOf })  nightly 03:10 ET (scheduler.js, under
 *     runExclusive). For every rate-review notice the comms PR has
 *     DELIVERED — status sent | viewed (the public page flips a sent notice
 *     to viewed, and flips an opened DRAFT too, so status alone is never the
 *     evidence) AND sent_at set AND at least one leg (email_sent / sms_sent)
 *     delivered — whose effective date has arrived and that is not applied
 *     yet, ONE transaction per notice: the customer's comms lock, the
 *     customers row FOR UPDATE, the notice row FOR UPDATE (the delivery
 *     evidence re-read under it; MIN_NOTICE_DAYS enforced from the ACTUAL
 *     sent_at day, never the planned send — too recent → hold), then
 *       - any active plan hold on the account → hold 'plan_on_hold' (retried
 *         nightly; the resume restores the pre-hold rate, the next night
 *         applies the increase on top of it — holds.js is never written
 *         around);
 *       - the lane's CURRENT rate is re-read; anything but
 *         noticed_current_cents → hold 'rate_moved_since_notice';
 *       - per_application: the still-upcoming visits of the series dated on
 *         or after the effective date are repriced through the SAME helper
 *         and guards the Edit-appointment "this and following" save uses
 *         (admin-schedule.js propagatePriceServiceToFollowingSiblings →
 *         lockAndGuardFollowingSiblings: visit-row locks, mint try-locks,
 *         refusal while any target holds a live invoice, prepaid money or
 *         a finishing card confirmation), and the series parent's
 *         recurring_template_overrides is stamped so every later extension
 *         spawns at the new price. Only FLAT visits are repriced here —
 *         stamped at exactly the noticed current price, no add-on lines, no
 *         appointment or line discount, primary_line_price absent or equal
 *         to the stamp (the same "price structure this reprice does not
 *         understand → park" posture estimate-converter's re-quote reprice
 *         takes); anything else holds for the Edit-appointment modal.
 *         customers.per_application_fee moves to the new amount ONLY when it
 *         equals the noticed current amount (the one sanctioned writer of
 *         that column outside acceptance — see applyPerApplication); the
 *         family's ledger slice, when one exists, moves by the same delta
 *         (monthly equivalent) under source 'annual_review'.
 *       - monthly_membership: the family's ledger slice (or the legacy
 *         unattributed scalar on a single-line account) and
 *         customers.monthly_rate move by the delta, source 'annual_review'.
 *       - annual_prepay: the live term gets next_term_prepay_amount — the
 *         successor's noticed amount — and nothing else; covered visits are
 *         never touched, the termite program is never reached (its own
 *         contract), and a term whose renewal reminder already went out, or
 *         whose amount moved since the notice, holds ("notified amount is the
 *         charged amount", the termite renewal_noticed_fee invariant).
 *     Then applied_at, the ranking row → `applied`, an activity_log row and
 *     an audit_log row with its OWN action (customer.rate_annual_review).
 *     The ledger source 'annual_review' is deliberately NOT one of
 *     plan-rate-ledger.js MANUAL_RATE_SOURCES and no
 *     customer.rate_manual_override event is ever written, so the cancel
 *     flow's retention offer (manual_override_within_18_months) is not
 *     blocked by an annual review, and next year's ranking does not read it
 *     as a manual edit. Idempotent: an applied notice is never applied
 *     twice (applied_at is set in the same transaction as the writes, under
 *     the row lock). A hold records apply_hold_reason + apply_attempts on
 *     the notice and rings ONE deduped Billing bell per notice and reason.
 *
 * What this module never does: send a customer anything, write a rate with
 * the gate off, touch a prepaid visit, a termite term or a visit that
 * already holds money.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { rateReviewLive, isEnabled } = require('../config/feature-gates');
const { MIN_NOTICE_DAYS } = require('./price-change-notices');
const PlanRateLedger = require('./plan-rate-ledger');
const { hasAuthoritativeZeroPrice } = require('./billing-lane');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  PLAN_LINE_SQL, LEDGER_FAMILIES_FOR_LINE, anniversaryInWindow, familyOfCoverage, visitsPerYearFor, lockBatch,
} = require('./rate-review');

const LANE_PER_APPLICATION = 'per_application';
const LANE_MONTHLY = 'monthly_membership';
const LANE_PREPAY = 'annual_prepay';
const LANES = [LANE_PER_APPLICATION, LANE_MONTHLY, LANE_PREPAY];

// A sent notice stays "sent" when the customer opens the page (the public
// route flips status to 'viewed'); both are notified customers.
const NOTIFIED_STATUSES = ['sent', 'viewed'];
const UPCOMING_STATUSES = ['pending', 'confirmed'];
const LEDGER_SOURCE = 'annual_review';
const AUDIT_ACTION = 'customer.rate_annual_review';
const ACTIVITY_APPLIED = 'rate_review_rate_applied';
const ACTIVITY_SCHEDULED = 'rate_review_notices_scheduled';
const NOTICE_METADATA_SOURCE = 'rate_review';
const BATCH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// Hold reasons (apply_hold_reason / the schedule response). Each maps to
// the prose the Billing bell shows — the bell copy may never carry the code.
const HOLD_COPY = Object.freeze({
  plan_on_hold: 'The plan is on hold, so the noticed rate waits for the restart and is retried nightly.',
  rate_moved_since_notice: 'The rate on file is not the one the customer was told, so nothing was changed.',
  no_future_visit: 'No upcoming visit of this plan is on the schedule to carry the new rate.',
  lane_cleanup: 'The account is not on a sanctioned billing lane, so the rate review cannot apply to it.',
  lane_unknown: 'The billing lane of this plan could not be resolved, so nothing was changed.',
  visit_unpriced: 'An upcoming visit of this plan has no price stamped, so the series was not repriced.',
  visit_has_addons: 'An upcoming visit carries add-on lines, so the series needs the Edit appointment screen.',
  visit_has_discount: 'An upcoming visit carries a discount, so the series needs the Edit appointment screen.',
  visit_price_structure: 'An upcoming visit has a structured price this review cannot move, so nothing was changed.',
  visit_prepaid: 'An upcoming visit is prepaid, so the series was not repriced.',
  visit_in_reschedule: 'An upcoming visit is parked in a reschedule request, so the series was not repriced.',
  multiple_series: 'The plan line runs as more than one series, so it needs a hand reprice.',
  series_template_complex: 'The series template carries add-ons or discounts, so later visits would not spawn at the new price.',
  template_overlay_gate_off: 'Series price overrides are switched off, so later visits would spawn at the old price.',
  series_guard_refused: 'A visit in the series already holds money or is being changed, so the series was not repriced.',
  series_busy: 'The series is being updated right now, so the reprice is retried tonight.',
  target_set_changed: 'The visits of the series changed while the reprice ran, so it was rolled back.',
  reprice_mismatch: 'The repriced visits did not land on the noticed amount, so the change was rolled back.',
  ledger_scalar_mismatch: 'The plan-rate ledger and the account rate disagree, so the dues rate was not changed.',
  ledger_unattributed_multi: 'The account rate cannot be attributed to this plan, so the dues rate was not changed.',
  prepay_term_not_found: 'No live prepaid term for this plan was found, so the renewal amount was not recorded.',
  prepay_term_ambiguous: 'More than one live prepaid term could carry this plan, so the renewal amount was not recorded.',
  renewal_too_soon: 'The prepaid term renews too soon for a 30-day notice, so it is left for the next review.',
  renewal_notice_already_sent: 'The renewal reminder already went out for this term, so its amount stays as noticed.',
  term_not_live: 'The prepaid term is no longer live, so the renewal amount was not recorded.',
  termite_program: 'Termite programs renew under their own agreement and are never repriced here.',
  notice_event_collision: 'A notice with the same amounts and date already exists for this customer.',
  notice_too_recent: 'The notice went out fewer than 30 days before the new rate, so the rate waits.',
  billing_lane_changed: 'The account moved to a different billing lane since the notice, so the rate was not applied.',
  row_not_approved: 'The ranking row is no longer approved, so no notice was created.',
  apply_error: 'The nightly apply hit an error on this account and will retry tonight.',
});

// ── small helpers ───────────────────────────────────────────────────────

function cents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const dollars = (c) => Math.round(Number(c)) / 100;
const roundMoney = (v) => Math.round(Number(v || 0) * 100) / 100;

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

// Calendar arithmetic on YYYY-MM-DD strings (no instants, no zone).
function addDaysYmd(day, days) {
  const [y, m, d] = String(day).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + Number(days || 0), 12));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
function daysBetweenYmd(fromDay, toDay) {
  const [fy, fm, fd] = String(fromDay).split('-').map(Number);
  const [ty, tm, td] = String(toDay).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td, 12) - Date.UTC(fy, fm - 1, fd, 12)) / DAY_MS);
}
// The first day-of-month `billingDay` on or after `fromDay` (billing_day is 1–28).
function nextBillingDayOnOrAfter(fromDay, billingDay) {
  const day = Math.min(Math.max(Number(billingDay) || 1, 1), 28);
  const [y, m, d] = String(fromDay).split('-').map(Number);
  const first = d <= day ? new Date(Date.UTC(y, m - 1, day, 12)) : new Date(Date.UTC(y, m, day, 12));
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(first.getUTCDate()).padStart(2, '0')}`;
}

class HoldError extends Error {
  constructor(code, detail = null) {
    super(HOLD_COPY[code] || code);
    this.name = 'RateReviewHold';
    this.holdCode = code;
    this.detail = detail;
  }
}
const hold = (code, detail) => new HoldError(code, detail);
const isHold = (err) => err instanceof HoldError;
// The series guards throw operational 409s (live invoice, prepaid visit,
// busy series); every one of them is a hold, never a crash.
function holdFromGuard(err) {
  if (isHold(err)) return err;
  const status = err && (err.statusCode || err.status);
  if (status === 409) {
    const busy = err.code === 'VISIT_BUSY_RETRY' || err.code === 'VISIT_CHANGED_RETRY';
    return hold(busy ? 'series_busy' : 'series_guard_refused', String(err.message || '').slice(0, 300));
  }
  return null;
}

function badInput(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The notice's lane, from the ranking row: a live prepaid term priced the
// line → annual_prepay; dues priced it (rate_unit month) → monthly; an
// explicit per_application scalar → per_application. per_visit / NULL lanes
// are the cleanup cohort (plan §5) and never apply.
function laneForRow(row) {
  if (row.current_rate_source === 'prepay_term' || row.billing_lane === LANE_PREPAY) return LANE_PREPAY;
  if (row.rate_unit === 'month') return row.billing_lane === LANE_MONTHLY ? LANE_MONTHLY : null;
  if (row.billing_lane === LANE_PER_APPLICATION) return LANE_PER_APPLICATION;
  return null;
}

// ── reads ───────────────────────────────────────────────────────────────

// The plan line's open recurring visits from `fromDate`, classified with the
// ranking's own line/cadence SQL so the notice targets exactly the visits
// the snapshot priced. Includes 'rescheduled' rows (a parked reschedule
// request) so the apply can refuse rather than leave one at the old price.
async function loadLineOpenVisits(dbh, { customerId, familyKey, cadence, fromDate }) {
  const { LINE_SQL, CADENCE_SQL, RECURRING_SQL } = PLAN_LINE_SQL;
  const { rows } = await dbh.raw(`
    SELECT s.id, s.customer_id, s.scheduled_date, s.status, s.estimated_price, s.primary_line_price,
      s.discount_type, s.discount_amount, s.discount_dollars, s.line_discount_id, s.line_discount_dollars,
      s.annual_prepay_term_id, s.prepaid_amount, s.is_callback, s.is_recurring, s.recurring_parent_id
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    WHERE s.customer_id = ?
      AND s.scheduled_date >= ?
      AND s.status IN ('pending', 'confirmed', 'rescheduled')
      AND ${RECURRING_SQL}
      AND ${LINE_SQL} = ?
      AND ${CADENCE_SQL} = ?
    ORDER BY s.scheduled_date ASC, s.id ASC
  `, [customerId, fromDate, familyKey, cadence]);
  return rows.map((r) => ({ ...r, scheduled_date: ymd(r.scheduled_date) }));
}

// Every UNFINISHED visit of the customer with its plan line — anything a
// completion can still bill (pending, confirmed, a parked reschedule
// request, en_route, on_site; the terminal set is
// customer-lifecycle-guard.js TERMINAL_STATUSES plus the 'canceled'
// spelling). These are the possible consumers of
// customers.per_application_fee: billing-lane.js completionInvoiceAmount
// bills a per-application visit at the fee whenever its own stamp is not a
// price, whatever its family, cadence or date, one-off visits included.
const UNFINISHED_VISIT_SQL = "s.status NOT IN ('completed', 'cancelled', 'canceled', 'skipped', 'no_show')";
async function loadCustomerOpenVisits(dbh, { customerId }) {
  const { LINE_SQL } = PLAN_LINE_SQL;
  const { rows } = await dbh.raw(`
    SELECT s.id, s.scheduled_date, s.status, s.estimated_price, s.primary_line_price, s.is_callback, s.is_recurring, s.recurring_parent_id, ${LINE_SQL} AS line
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    WHERE s.customer_id = ?
      AND ${UNFINISHED_VISIT_SQL}
    ORDER BY s.scheduled_date ASC, s.id ASC
  `, [customerId]);
  return rows.map((r) => ({ ...r, scheduled_date: ymd(r.scheduled_date) }));
}

// billing-lane.js completionInvoiceAmount's precedence, mirrored: a visit
// bills its own stamp when that is a price (> 0) or an authoritative $0
// (hasAuthoritativeZeroPrice — GATE_STAMPED_ZERO_FREE on, or a positive
// primary_line_price base), a callback bills nothing — every other
// per-application visit falls through to customers.per_application_fee.
function consumesPerApplicationFee(visit) {
  if (visit.is_callback) return false;
  if (visit.estimated_price != null && visit.estimated_price !== '' && Number(visit.estimated_price) > 0) return false;
  if (hasAuthoritativeZeroPrice(visit.estimated_price, visit.primary_line_price)) return false;
  return true;
}

// The live prepaid term that carries this line (the ranking's matchPrepayTerm
// posture: the family named by the coverage text; one unlabeled live term
// can only mean the line on a single-line account; two candidates = held).
async function resolvePrepayTerm(dbh, { customerId, familyKey, accountLines, today, termId = null }) {
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const terms = await coveredTermsAsOf(dbh, today)
    .where('t.customer_id', customerId)
    .select('t.*');
  const live = terms.filter((t) => Number(t.prepay_amount) > 0);
  if (termId) {
    const pinned = live.find((t) => String(t.id) === String(termId));
    return pinned ? { term: pinned } : { term: null, reason: 'term_not_live' };
  }
  const byFamily = live.filter((t) => familyOfCoverage(t.coverage_service_type) === familyKey);
  if (byFamily.length === 1) return { term: byFamily[0] };
  if (byFamily.length > 1) return { term: null, reason: 'prepay_term_ambiguous' };
  const unlabeled = live.filter((t) => !familyOfCoverage(t.coverage_service_type));
  if (unlabeled.length === 1 && (accountLines || 1) === 1) return { term: unlabeled[0] };
  return { term: null, reason: unlabeled.length > 1 ? 'prepay_term_ambiguous' : 'prepay_term_not_found' };
}

function termRenewalNoticed(term) {
  return !!(term.notice_30_sent_at || term.notice_15_sent_at || term.notice_7_sent_at
    || (term.renewal_noticed_fee != null && term.renewal_noticed_fee !== ''));
}

// The lane the account bills on NOW, resolved the way the ranking resolved
// it (rate-review.js resolveCurrentRate): a live prepaid term covering the
// line wins over the scalar, then customers.billing_mode. Re-read under the
// customer row lock before any lane's apply, so a notice priced on one
// basis never moves the money of another (a per-application line that
// moved to dues, a line now under a prepaid term, …).
async function resolveLiveLane(dbh, { customer, familyKey, today }) {
  const found = await resolvePrepayTerm(dbh, { customerId: customer.id, familyKey, accountLines: null, today });
  if (found.term || found.reason === 'prepay_term_ambiguous') return LANE_PREPAY;
  if (customer.billing_mode === LANE_MONTHLY) return LANE_MONTHLY;
  if (customer.billing_mode === LANE_PER_APPLICATION) return LANE_PER_APPLICATION;
  return customer.billing_mode || null;
}

async function activePlanHold(dbh, customerId) {
  return dbh('plan_holds').where({ customer_id: customerId, status: 'active' }).first('id', 'family_key', 'resume_on');
}

// ── scheduling ──────────────────────────────────────────────────────────

// Effective date per lane; throws a HoldError when none qualifies.
// `floor` = the later of the anniversary's occurrence in the batch window
// and plannedSend + MIN_NOTICE_DAYS (the 30-day rule, from the send).
function effectiveDateFor(lane, { floor, visits = [], billingDay = 1, term = null, plannedSend }) {
  if (lane === LANE_PER_APPLICATION) {
    const candidate = visits.find((v) => UPCOMING_STATUSES.includes(String(v.status)) && !v.is_callback && v.scheduled_date >= floor);
    if (!candidate) throw hold('no_future_visit', { floor });
    return { effectiveDate: candidate.scheduled_date, firstVisitId: candidate.id };
  }
  if (lane === LANE_MONTHLY) {
    return { effectiveDate: nextBillingDayOnOrAfter(floor, billingDay), firstVisitId: null };
  }
  if (lane === LANE_PREPAY) {
    if (!term) throw hold('prepay_term_not_found');
    const renewalDay = addDaysYmd(ymd(term.term_end), 1);
    // The notice must precede the renewal reminder ladder (30/15/7 days
    // before term_end): at least MIN_NOTICE_DAYS + 1 days before the
    // successor starts = on or before term_end − 30.
    if (daysBetweenYmd(plannedSend, renewalDay) < MIN_NOTICE_DAYS + 1) throw hold('renewal_too_soon', { renewalDay });
    if (termRenewalNoticed(term)) throw hold('renewal_notice_already_sent', { termId: term.id });
    return { effectiveDate: renewalDay, firstVisitId: null };
  }
  throw hold('lane_unknown');
}

function cadenceLabelFor(lane) {
  if (lane === LANE_MONTHLY) return 'month';
  if (lane === LANE_PREPAY) return 'year';
  return 'application';
}

async function flagSnapshotHold(dbh, row, code) {
  const flags = Array.isArray(row.flags) ? row.flags : (() => { try { return JSON.parse(row.flags || '[]'); } catch { return []; } })();
  const next = flags.filter((f) => !String(f).startsWith('notice_hold:'));
  next.push(`notice_hold:${code}`);
  await dbh('rate_review_snapshots').where({ id: row.id }).update({ flags: JSON.stringify(next), updated_at: new Date() });
}

// One approved ranking row → one draft notice row (or a HoldError).
async function scheduleRow(dbh, row, { batch, customer, lane, accountLines, today, plannedSend, noticeFloor, batchId, batchKey, actorId }) {
  if (!customer) throw hold('lane_unknown', 'customer missing');
  if (!lane) throw hold('lane_cleanup', { billingLane: row.billing_lane });
  if (row.family_key === 'termite') throw hold('termite_program');
  const occurrence = anniversaryInWindow(ymd(row.anniversary_date), ymd(batch.window_from), ymd(batch.window_to));
  const floor = occurrence && occurrence > noticeFloor ? occurrence : noticeFloor;
  const metadata = {
    source: NOTICE_METADATA_SOURCE, batch_key: batchKey, planned_send_date: plannedSend, anniversary_occurrence: occurrence,
    rate_unit: row.rate_unit, visits_per_year: row.visits_per_year, current_rate_source: row.current_rate_source,
  };
  let visits = [];
  let term = null;
  if (lane === LANE_PER_APPLICATION) {
    visits = await loadLineOpenVisits(dbh, { customerId: row.customer_id, familyKey: row.family_key, cadence: row.cadence, fromDate: today });
  } else if (lane === LANE_PREPAY) {
    const found = await resolvePrepayTerm(dbh, { customerId: row.customer_id, familyKey: row.family_key, accountLines, today });
    if (!found.term) throw hold(found.reason);
    term = found.term;
    const visitsPerTerm = Number(term.coverage_visit_count) > 0 ? Number(term.coverage_visit_count) : visitsPerYearFor(row.cadence, row.visits_per_year);
    if (!(visitsPerTerm > 0)) throw hold('prepay_term_not_found', 'no coverage visit count');
    Object.assign(metadata, {
      term_id: term.id, term_end: ymd(term.term_end), coverage_visits: visitsPerTerm,
      current_term_amount_cents: cents(term.prepay_amount),
      next_term_amount_cents: Number(row.proposed_rate_cents) * visitsPerTerm,
      per_application_current_cents: Number(row.current_rate_cents),
      per_application_new_cents: Number(row.proposed_rate_cents),
    });
  }
  const { effectiveDate, firstVisitId } = effectiveDateFor(lane, { floor, visits, billingDay: customer.billing_day, term, plannedSend });
  if (firstVisitId) metadata.first_visit_id = firstVisitId;
  // The public page renders current_amount_cents → new_amount_cents "per
  // <cadence_label>" exactly as stored, and the apply charges exactly what
  // was shown: per application for a visit-billed line, per month for dues,
  // and the ANNUAL totals for a prepaid term (the per-application figures
  // stay in metadata for the letter).
  const noticedCurrent = lane === LANE_PREPAY ? metadata.current_term_amount_cents : Number(row.current_rate_cents);
  const noticedNew = lane === LANE_PREPAY ? metadata.next_term_amount_cents : Number(row.proposed_rate_cents);
  // The notice row and the ranking row's link commit together (a savepoint
  // when the caller already holds a transaction): a crash between the two
  // would otherwise leave a draft row the next schedule cannot re-link.
  const noticeId = await dbh.transaction(async (sp) => {
    // The ranking row is locked and re-read here: the candidate list was
    // read before this row's lock, and a concurrent schedule (a different
    // planned send → a different effective date) must find the link, not
    // race it. The partial UNIQUE index on rate_review_row_id is the belt.
    const live = await sp('rate_review_snapshots').where({ id: row.id }).forUpdate().first('notice_id', 'status');
    if (!live || String(live.status) !== 'approved') throw hold('row_not_approved', { status: live ? live.status : null });
    if (live.notice_id) return { alreadyScheduled: true, noticeId: live.notice_id };
    const inserted = await sp('price_change_notices').insert({
      batch_id: batchId,
      customer_id: row.customer_id,
      current_amount_cents: noticedCurrent,
      new_amount_cents: noticedNew,
      cadence_label: cadenceLabelFor(lane),
      effective_date: effectiveDate,
      notice_token: crypto.randomBytes(16).toString('hex'),
      status: 'draft',
      created_by: actorId || null,
      metadata: JSON.stringify(metadata),
      rate_review_row_id: row.id,
      billing_lane: lane,
      family_key: row.family_key,
      noticed_current_cents: noticedCurrent,
      noticed_new_cents: noticedNew,
      apply_attempts: 0,
    }).onConflict(['customer_id', 'effective_date', 'current_amount_cents', 'new_amount_cents']).ignore().returning(['id', 'effective_date']);
    if (!inserted.length) throw hold('notice_event_collision', { effectiveDate });
    await sp('rate_review_snapshots').where({ id: row.id }).update({ notice_id: inserted[0].id, updated_at: new Date() });
    return { noticeId: inserted[0].id };
  });
  if (noticeId.alreadyScheduled) return { alreadyScheduled: true, rowId: row.id };
  return { noticeId: noticeId.noticeId, rowId: row.id, customerId: row.customer_id, familyKey: row.family_key, lane, effectiveDate };
}

/**
 * Create the draft notice rows for a batch's approved rows. Sends nothing.
 * Returns { ok, batchKey, batchId, created, alreadyScheduled, held[],
 * firstEffectiveDate, lastEffectiveDate, approved }.
 */
async function scheduleNoticeRows(batchKey, { plannedSendDate = null, actorId = null, trx = null, now = new Date() } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  if (!BATCH_KEY_RE.test(String(batchKey || ''))) throw badInput('batchKey must be YYYY-MM');
  const today = etDateString(now);
  const plannedSend = plannedSendDate ? String(plannedSendDate).slice(0, 10) : today;
  if (!DATE_RE.test(plannedSend)) throw badInput('plannedSendDate must be YYYY-MM-DD');
  if (plannedSend < today) throw badInput('plannedSendDate must not be in the past');

  // One transaction under the batch lock (rate-review.js lockBatch), the
  // lock the rebuild's write takes too: a rebuild cannot delete rows while
  // their notices are being created, and vice versa.
  const run = (dbh) => scheduleUnderLock(dbh, { batchKey, plannedSend, today, actorId });
  return trx ? run(trx) : db.transaction(run);
}

async function scheduleUnderLock(dbh, { batchKey, plannedSend, today, actorId }) {
  await lockBatch(dbh, batchKey);
  const batch = await dbh('rate_review_batches').where({ batch_key: batchKey }).first();
  if (!batch) {
    const err = new Error('rate review batch not found');
    err.status = 404;
    throw err;
  }
  const rows = await dbh('rate_review_snapshots')
    .where({ batch_key: batchKey, status: 'approved' })
    .orderBy('customer_id', 'asc')
    .orderBy('family_key', 'asc');
  const approved = rows.length;
  const candidates = rows.filter((r) => Number(r.delta_cents) > 0);
  const result = {
    ok: true, batchKey, batchId: crypto.randomUUID(), plannedSendDate: plannedSend, approved,
    created: 0, alreadyScheduled: 0, held: [], firstEffectiveDate: null, lastEffectiveDate: null, notices: [],
  };
  if (!candidates.length) return { ...result, ok: false, reason: approved ? 'no_positive_delta' : 'nothing_approved' };

  const customerIds = [...new Set(candidates.map((r) => r.customer_id))];
  const customers = new Map((await dbh('customers').whereIn('id', customerIds).select('id', 'billing_day', 'billing_mode', 'per_application_fee', 'monthly_rate')).map((c) => [c.id, c]));
  const linesPerCustomer = new Map();
  for (const r of rows) linesPerCustomer.set(r.customer_id, (linesPerCustomer.get(r.customer_id) || 0) + 1);
  const noticeFloor = addDaysYmd(plannedSend, MIN_NOTICE_DAYS);

  for (const row of candidates) {
    if (row.notice_id) { result.alreadyScheduled += 1; continue; }
    try {
      const notice = await scheduleRow(dbh, row, {
        batch, customer: customers.get(row.customer_id), lane: laneForRow(row), accountLines: linesPerCustomer.get(row.customer_id),
        today, plannedSend, noticeFloor, batchId: result.batchId, batchKey, actorId,
      });
      if (notice.alreadyScheduled) { result.alreadyScheduled += 1; continue; }
      result.created += 1;
      result.notices.push(notice);
      if (!result.firstEffectiveDate || notice.effectiveDate < result.firstEffectiveDate) result.firstEffectiveDate = notice.effectiveDate;
      if (!result.lastEffectiveDate || notice.effectiveDate > result.lastEffectiveDate) result.lastEffectiveDate = notice.effectiveDate;
    } catch (err) {
      if (!isHold(err)) throw err;
      result.held.push({ rowId: row.id, customerId: row.customer_id, familyKey: row.family_key, reason: err.holdCode, detail: err.detail == null ? null : err.detail });
      await flagSnapshotHold(dbh, row, err.holdCode);
    }
  }

  if (result.created > 0) {
    try {
      await dbh('activity_log').insert({
        admin_user_id: actorId || null,
        action: ACTIVITY_SCHEDULED,
        description: `Rate review ${batchKey}: ${result.created} notice row(s) created as drafts (nothing sent), ${result.held.length} held, ${result.alreadyScheduled} already scheduled; effective ${result.firstEffectiveDate} → ${result.lastEffectiveDate}.`,
        metadata: JSON.stringify({ batch_key: batchKey, batch_id: result.batchId, planned_send_date: plannedSend, created: result.created, held: result.held.map((h) => ({ rowId: h.rowId, reason: h.reason })) }),
      });
    } catch (logErr) {
      logger.warn(`[rate-review-apply] activity log failed for ${batchKey}: ${logErr.message}`);
    }
  }
  logger.info(`[rate-review-apply] ${batchKey}: ${result.created} notice rows created (draft), ${result.held.length} held, ${result.alreadyScheduled} already scheduled`);
  return result;
}

// ── apply ───────────────────────────────────────────────────────────────

// Delivery evidence, not status: the public page flips ANY opened notice —
// a previewed draft included — to 'viewed', so a notice is applied only
// with sent_at set and at least one leg delivered. Re-read under the row
// lock in applyNotice.
function wasDelivered(notice) {
  return !!(notice && notice.sent_at && NOTIFIED_STATUSES.includes(String(notice.status)) && (notice.email_sent === true || notice.sms_sent === true));
}

async function loadDueNotices(dbh, asOfDay) {
  return dbh('price_change_notices')
    .whereNotNull('rate_review_row_id')
    .whereIn('status', NOTIFIED_STATUSES)
    .whereNotNull('sent_at')
    .where(function delivered() { this.where('email_sent', true).orWhere('sms_sent', true); })
    .whereNull('applied_at')
    .where(function due() {
      // A prepaid renewal amount is recorded as soon as the notice is out
      // (the renewal machinery reads it before the term ends); every other
      // lane waits for its effective date.
      this.where(function dated() { this.whereNot('billing_lane', LANE_PREPAY).where('effective_date', '<=', asOfDay); })
        .orWhere('billing_lane', LANE_PREPAY);
    })
    .orderBy('effective_date', 'asc')
    .orderBy('created_at', 'asc');
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// Ledger slice rows for the line's family keys (plan-rate-ledger keys).
async function loadFamilySlices(trx, customerId, familyKey) {
  const keys = LEDGER_FAMILIES_FOR_LINE[familyKey] || [familyKey];
  const rows = await trx('customer_plan_rates').where({ customer_id: customerId }).select('family_key', 'monthly_rate', 'source');
  return { all: rows, family: rows.filter((r) => keys.includes(r.family_key)), keys };
}

function sumSlices(rows) {
  return roundMoney(rows.reduce((s, r) => s + (Number(r.monthly_rate) || 0), 0));
}

// Move the family's slice by `deltaMonthly` (dollars) and the scalar with
// it; when the ledger has scalar authority the sum of slices must equal the
// scalar afterwards or the whole apply rolls back.
async function moveMonthlySlice(trx, { customer, familyKey, deltaMonthly, requireSlice }) {
  const { all, family, keys } = await loadFamilySlices(trx, customer.id, familyKey);
  const oldScalar = roundMoney(customer.monthly_rate);
  const newScalar = roundMoney(oldScalar + deltaMonthly);
  if (family.length > 0) {
    // The line's own slice (riders such as palm_injection keep their own
    // rows): the first ledger key present carries the delta.
    const primaryKey = keys.find((k) => family.some((r) => r.family_key === k));
    const primary = family.find((r) => r.family_key === primaryKey);
    await PlanRateLedger.upsertComponent(trx, {
      customerId: customer.id, familyKey: primaryKey, monthlyRate: roundMoney(Number(primary.monthly_rate) + deltaMonthly), source: LEDGER_SOURCE,
    });
  } else if (requireSlice) {
    throw hold('ledger_unattributed_multi', { familyKey });
  } else {
    const unattributed = all.filter((r) => r.family_key === PlanRateLedger.UNATTRIBUTED);
    const others = all.filter((r) => r.family_key !== PlanRateLedger.UNATTRIBUTED);
    if (others.length > 0) throw hold('ledger_unattributed_multi', { ledger: all.map((r) => r.family_key) });
    if (unattributed.length > 0) {
      await PlanRateLedger.upsertComponent(trx, {
        customerId: customer.id, familyKey: PlanRateLedger.UNATTRIBUTED, monthlyRate: roundMoney(Number(unattributed[0].monthly_rate) + deltaMonthly), source: LEDGER_SOURCE,
      });
    } else if (newScalar > 0) {
      // Empty ledger: the same reset-to-scalar every blind scalar writer
      // uses (admin edit, IB) — one unattributed slice equal to the scalar.
      await PlanRateLedger.syncScalarWriteToLedger(trx, customer.id, newScalar, { source: LEDGER_SOURCE });
    }
  }
  await trx('customers').where({ id: customer.id }).update({ monthly_rate: newScalar, updated_at: new Date() });
  if (PlanRateLedger.planRateLedgerEnabled()) {
    const after = await trx('customer_plan_rates').where({ customer_id: customer.id }).select('monthly_rate');
    if (after.length && sumSlices(after) !== newScalar) throw hold('ledger_scalar_mismatch', { sum: sumSlices(after), scalar: newScalar });
  }
  return { oldScalar, newScalar };
}

async function applyMonthly(trx, ctx) {
  const { notice, customer } = ctx;
  const { family } = await loadFamilySlices(trx, customer.id, notice.family_key);
  const source = ctx.metadata.current_rate_source;
  // Re-read the lane's current rate the way the ranking resolved it.
  const currentCents = source === 'ledger_slice' ? cents(sumSlices(family)) : cents(customer.monthly_rate);
  if (currentCents !== Number(notice.noticed_current_cents)) throw hold('rate_moved_since_notice', { currentCents, source });
  const deltaMonthly = dollars(Number(notice.noticed_new_cents) - Number(notice.noticed_current_cents));
  const moved = await moveMonthlySlice(trx, { customer, familyKey: notice.family_key, deltaMonthly, requireSlice: source === 'ledger_slice' });
  return { lane: LANE_MONTHLY, before: { monthly_rate: moved.oldScalar }, after: { monthly_rate: moved.newScalar }, deltaMonthly };
}

// Flat-visit rule — the structure this reprice understands. Anything else
// is the Edit-appointment modal's job (its "this and following" save).
function flatVisitRefusal(visit, addonCount, noticedCurrentCents) {
  if (visit.is_callback) return 'visit_price_structure';
  if (String(visit.status) === 'rescheduled') return 'visit_in_reschedule';
  if (visit.annual_prepay_term_id || Number(visit.prepaid_amount) > 0) return 'visit_prepaid';
  const stamped = cents(visit.estimated_price);
  if (stamped == null) return 'visit_unpriced';
  if (stamped !== noticedCurrentCents) return 'rate_moved_since_notice';
  if (addonCount > 0) return 'visit_has_addons';
  if (visit.discount_type || Number(visit.discount_dollars) > 0 || visit.line_discount_id || Number(visit.line_discount_dollars) > 0) return 'visit_has_discount';
  const primary = cents(visit.primary_line_price);
  if (primary != null && primary !== stamped) return 'visit_price_structure';
  return null;
}

// Which series carries the line, locked in the writers' order (series
// maintenance → comms → customer row → visit rows; the comms lock and the
// customers row are already held by the caller) and guarded exactly as the
// modal's 'following' save guards its siblings (live invoice, prepaid money,
// card confirmation in flight, mint locks). Returns the locked targets.
async function lockPerApplicationTargets(trx, { notice, customer, effectiveDate, schedule }) {
  const row = await trx('rate_review_snapshots').where({ id: notice.rate_review_row_id }).first('cadence');
  // Read from the EFFECTIVE date, not today: an overdue, still-pending visit
  // dated between the two is a target of the series helper too, and bills at
  // the new rate when it is finally completed — exactly what the customer
  // was told.
  const visits = await loadLineOpenVisits(trx, { customerId: customer.id, familyKey: notice.family_key, cadence: row ? row.cadence : null, fromDate: effectiveDate });
  if (!visits.length) throw hold('no_future_visit', { effectiveDate });
  const roots = [...new Set(visits.map((v) => String(v.recurring_parent_id || v.id)))];
  if (roots.length > 1) throw hold('multiple_series', { roots });
  const parentId = roots[0];
  let locked;
  try {
    await schedule.acquireRecurringSeriesMaintenanceLock(trx, parentId, false);
    locked = await schedule.lockAndGuardFollowingSiblings(trx, {
      editedId: notice.id, editedRow: null, parentId, fromDateStr: effectiveDate, serviceChanged: false, priceChanged: true, proposedFields: null,
    });
  } catch (err) {
    throw holdFromGuard(err) || err;
  }
  if (!locked.length) throw hold('no_future_visit', { effectiveDate });
  // A parked reschedule request in the window is outside the propagation's
  // target set and would keep the old price — refuse instead.
  const parkedReschedule = visits.find((v) => String(v.status) === 'rescheduled');
  if (parkedReschedule) throw hold('visit_in_reschedule', { visitId: parkedReschedule.id });
  const lockedIds = new Set(locked.map((v) => String(v.id)));
  const expected = new Set(visits.filter((v) => UPCOMING_STATUSES.includes(String(v.status))).map((v) => String(v.id)));
  if (lockedIds.size !== expected.size || [...lockedIds].some((id) => !expected.has(id))) throw hold('target_set_changed', { locked: [...lockedIds], expected: [...expected] });
  return { parentId, locked, lockedIds };
}

// Every target must be a FLAT visit at the noticed current price, and the
// modal's own derivation must land it on the noticed new price.
async function assertFlatTargets(trx, { locked, addonRows, fields, noticedCurrent, noticedNew, schedule }) {
  const addonCounts = new Map();
  for (const a of addonRows) addonCounts.set(String(a.scheduled_service_id), (addonCounts.get(String(a.scheduled_service_id)) || 0) + 1);
  for (const visit of locked) {
    const refusal = flatVisitRefusal(visit, addonCounts.get(String(visit.id)) || 0, noticedCurrent);
    if (refusal) throw hold(refusal, { visitId: visit.id, scheduledDate: ymd(visit.scheduled_date) });
    const scope = await schedule.loadStoredDiscountScope(trx, { ...visit, ...fields }, []);
    const derived = schedule.calculateStoredVisitFinancials({ ...visit, ...fields }, [], [], scope);
    if (cents(derived.price) !== noticedNew) throw hold('reprice_mismatch', { visitId: visit.id, derived: derived.price });
  }
}

// Every later extension spawns from the parent overlaid with the template
// overrides — simulate that spawn and refuse unless it prices at the noticed
// amount (a parent with add-on lines or a discount would not).
async function assertTemplateSpawnsAtNoticed(trx, { parentId, parentAddons, fields, noticedNew, schedule }) {
  const parent = await trx('scheduled_services').where({ id: parentId }).first();
  if (!parent) throw hold('no_future_visit', { parentId });
  const existing = schedule.parseTemplateOverrides(parent.recurring_template_overrides) || {};
  const provenance = schedule.readProvenanceOverrides(parent.recurring_template_overrides);
  const template = { ...parent, ...provenance, ...existing, ...fields };
  const scope = await schedule.loadStoredDiscountScope(trx, template, parentAddons);
  const spawn = schedule.calculateStoredVisitFinancials(template, parentAddons, parentAddons, scope);
  if (cents(spawn.price) !== noticedNew) throw hold('series_template_complex', { spawn: spawn.price, parentAddons: parentAddons.length });
}

// The write: the series helper reprices the targets, the template is
// stamped, and every target is proven to carry the noticed amount.
async function repriceTargets(trx, { notice, parentId, lockedIds, effectiveDate, fields, noticedNew, cols, schedule }) {
  const updatedIds = await schedule.propagatePriceServiceToFollowingSiblings(trx, {
    editedId: notice.id, editedRow: null, parentId, fromDateStr: effectiveDate, fields, serviceChanged: false, priceChanged: true, cols,
  });
  const updated = new Set(updatedIds.map(String));
  if (updated.size !== lockedIds.size || [...lockedIds].some((id) => !updated.has(id))) throw hold('target_set_changed', { updated: [...updated] });
  await schedule.stampRecurringTemplateOverrides(trx, parentId, fields, cols);
  const after = await trx('scheduled_services').whereIn('id', [...lockedIds]).select('id', 'estimated_price');
  const off = after.filter((v) => cents(v.estimated_price) !== noticedNew);
  if (off.length) throw hold('reprice_mismatch', { visitIds: off.map((v) => v.id) });
}

// customers.per_application_fee — the completion fallback when a visit's
// own stamp is not a price (billing-lane.js completionInvoiceAmount) — is
// ACCOUNT-WIDE: every unfinished per-application visit of the customer
// whose stamp is not a price bills it, whatever its family or date. Its
// only writer today is acceptance; this is the one sanctioned non-accept
// writer, and it moves ONLY when every consumer of the fallback is provably
// inside the noticed scope: the fee equals the amount the customer was
// told, every unfinished visit of the account belongs to THIS plan line,
// and no unfinished visit outside the repriced set falls through to the fee
// by billing-lane's own rule (consumesPerApplicationFee: NULL, '', or a
// bare $0 the stamped-zero gate does not make authoritative — a visit before
// the effective date, a one-off, an en_route or on_site stop). Otherwise
// the old fee is left as it was and the reason recorded. A NULL fee stays
// NULL — unpriced is never invented.
async function feeScopeRefusal(trx, { customer, familyKey, repricedIds, noticedCurrent }) {
  const feeCents = cents(customer.per_application_fee);
  if (feeCents == null) return 'no_fee_on_file';
  if (feeCents !== noticedCurrent) return 'fee_differs_from_noticed_current';
  const open = await loadCustomerOpenVisits(trx, { customerId: customer.id });
  if (open.some((v) => v.line !== familyKey)) return 'fee_shared_with_other_lines';
  if (open.some((v) => !repricedIds.has(String(v.id)) && consumesPerApplicationFee(v))) return 'fee_consumers_outside_scope';
  return null;
}

async function moveFeeAndLedger(trx, { notice, customer, metadata, noticedCurrent, noticedNew, repricedIds }) {
  const newDollars = dollars(noticedNew);
  const feeUntouchedReason = await feeScopeRefusal(trx, { customer, familyKey: notice.family_key, repricedIds, noticedCurrent });
  const feeUpdated = feeUntouchedReason == null;
  if (feeUpdated) await trx('customers').where({ id: customer.id }).update({ per_application_fee: newDollars, updated_at: new Date() });
  // Ledger: a per-application account's family slice is a monthly
  // equivalent (annual ÷ 12); move it by the same delta when one exists.
  const vpy = Number(metadata.visits_per_year) || 0;
  let ledger = null;
  const { family } = await loadFamilySlices(trx, customer.id, notice.family_key);
  if (family.length > 0 && vpy > 0) {
    const deltaMonthly = roundMoney((dollars(noticedNew - noticedCurrent) * vpy) / 12);
    ledger = { ...(await moveMonthlySlice(trx, { customer, familyKey: notice.family_key, deltaMonthly, requireSlice: true })), deltaMonthly };
  }
  const feeBefore = customer.per_application_fee == null ? null : Number(customer.per_application_fee);
  return {
    before: { estimated_price: dollars(noticedCurrent), per_application_fee: feeBefore },
    after: { estimated_price: newDollars, per_application_fee: feeUpdated ? newDollars : feeBefore },
    feeUpdated,
    feeUntouchedReason,
    ledger,
  };
}

async function applyPerApplication(trx, ctx) {
  const { notice, customer } = ctx;
  // The route module exports its helper bag as `_test` (router._test).
  const schedule = require('../routes/admin-schedule')._test;
  if (!isEnabled('editApptPriceServiceScope')) throw hold('template_overlay_gate_off');
  const effectiveDate = ymd(notice.effective_date);
  const noticedCurrent = Number(notice.noticed_current_cents);
  const noticedNew = Number(notice.noticed_new_cents);
  const newDollars = dollars(noticedNew);
  const fields = { primary_line_price: newDollars, estimated_price: newDollars };

  const { parentId, locked, lockedIds } = await lockPerApplicationTargets(trx, { notice, customer, effectiveDate, schedule });
  const cols = await trx('scheduled_services').columnInfo();
  const addonRows = await trx('scheduled_service_addons').whereIn('scheduled_service_id', [...lockedIds, parentId]).select('*');
  await assertFlatTargets(trx, { locked, addonRows, fields, noticedCurrent, noticedNew, schedule });
  const parentAddons = addonRows.filter((a) => String(a.scheduled_service_id) === String(parentId));
  await assertTemplateSpawnsAtNoticed(trx, { parentId, parentAddons, fields, noticedNew, schedule });
  await repriceTargets(trx, { notice, parentId, lockedIds, effectiveDate, fields, noticedNew, cols, schedule });
  const money = await moveFeeAndLedger(trx, { notice, customer, metadata: ctx.metadata, noticedCurrent, noticedNew, repricedIds: lockedIds });
  const first = locked.slice().sort((a, b) => String(ymd(a.scheduled_date)).localeCompare(String(ymd(b.scheduled_date))))[0];
  return { lane: LANE_PER_APPLICATION, appliesFromVisitId: first.id, visitIds: [...lockedIds], parentId, ...money };
}

async function applyPrepay(trx, ctx) {
  const { notice, customer, today, metadata } = ctx;
  if (notice.family_key === 'termite') throw hold('termite_program');
  const found = await resolvePrepayTerm(trx, { customerId: customer.id, familyKey: notice.family_key, today, termId: metadata.term_id || null });
  if (!found.term) throw hold(found.reason || 'prepay_term_not_found');
  const term = found.term;
  if (term.annual_plan_version) throw hold('termite_program', { termId: term.id });
  if (term.renewal_decision) throw hold('term_not_live', { termId: term.id, decision: term.renewal_decision });
  // The notice carries the ANNUAL totals: the term's amount the customer
  // saw and the successor amount they were told — the renewal charges
  // exactly the latter.
  if (cents(term.prepay_amount) !== Number(notice.noticed_current_cents)) throw hold('rate_moved_since_notice', { termAmountCents: cents(term.prepay_amount) });
  const visitsPerTerm = Number(term.coverage_visit_count) > 0 ? Number(term.coverage_visit_count) : Number(metadata.coverage_visits);
  if (visitsPerTerm !== Number(metadata.coverage_visits)) throw hold('rate_moved_since_notice', { coverageVisits: visitsPerTerm });
  // The per-application figure the letter quotes must still describe the
  // term (the ranking's own derivation, resolveCurrentRate, to the cent).
  if (metadata.per_application_current_cents != null
    && Math.round((Number(term.prepay_amount) / visitsPerTerm) * 100) !== Number(metadata.per_application_current_cents)) {
    throw hold('rate_moved_since_notice', { perApplication: true });
  }
  // "Notified amount is the charged amount": once the renewal reminder is
  // out (or a termite fee was frozen), the term's amount is spoken for.
  if (termRenewalNoticed(term)) throw hold('renewal_notice_already_sent', { termId: term.id });
  const nextAmount = dollars(Number(notice.noticed_new_cents));
  if (term.next_term_prepay_amount != null && term.next_term_prepay_amount !== '' && roundMoney(term.next_term_prepay_amount) !== nextAmount) {
    throw hold('rate_moved_since_notice', { nextTermPrepayAmount: Number(term.next_term_prepay_amount) });
  }
  await trx('annual_prepay_terms').where({ id: term.id }).update({ next_term_prepay_amount: nextAmount, updated_at: new Date() });
  return {
    lane: LANE_PREPAY, termId: term.id,
    before: { prepay_amount: Number(term.prepay_amount), next_term_prepay_amount: term.next_term_prepay_amount == null ? null : Number(term.next_term_prepay_amount) },
    after: { prepay_amount: Number(term.prepay_amount), next_term_prepay_amount: nextAmount },
  };
}

async function finalizeApplied(trx, ctx, outcome, now) {
  const { notice, customer } = ctx;
  const { recordAuditEvent } = require('./audit-log');
  await trx('price_change_notices').where({ id: notice.id }).update({
    applied_at: now,
    apply_hold_reason: null,
    apply_attempts: Number(notice.apply_attempts || 0) + 1,
    applies_from_visit_id: outcome.appliesFromVisitId || null,
    updated_at: now,
  });
  await trx('rate_review_snapshots').where({ id: notice.rate_review_row_id }).update({ status: 'applied', updated_at: now });
  // Distinct action from customer.rate_manual_override: the cancel flow's
  // retention-offer cooldown reads that one, never this one.
  await recordAuditEvent({
    actor_type: 'system',
    action: AUDIT_ACTION,
    resource_type: 'customer',
    resource_id: customer.id,
    metadata: {
      notice_id: notice.id, rate_review_row_id: notice.rate_review_row_id, family_key: notice.family_key, billing_lane: notice.billing_lane,
      noticed_current_cents: Number(notice.noticed_current_cents), noticed_new_cents: Number(notice.noticed_new_cents), effective_date: ymd(notice.effective_date),
      source: LEDGER_SOURCE, ...outcome,
    },
    trx,
    critical: true,
  });
  await trx('activity_log').insert({
    customer_id: customer.id,
    action: ACTIVITY_APPLIED,
    description: `Annual rate review applied (${notice.family_key}, ${notice.billing_lane}): $${dollars(notice.noticed_current_cents).toFixed(2)} → $${dollars(notice.noticed_new_cents).toFixed(2)} per ${notice.cadence_label || 'application'} from ${ymd(notice.effective_date)}.`,
    metadata: JSON.stringify({ notice_id: notice.id, rate_review_row_id: notice.rate_review_row_id, lane: notice.billing_lane, ...outcome }),
  });
}

// One notice, one transaction. Returns { applied: true } or
// { applied: false, hold: code, detail }.
async function applyNotice(noticeRow, { now = new Date(), dbh = db } = {}) {
  const today = etDateString(now);
  const outcomeBox = {};
  try {
    await dbh.transaction(async (trx) => {
      // Lock order: comms advisory lock first, then the customers row (the
      // ledger helpers and every rate writer take them in this order), then
      // the notice row. The per-application lane adds the series maintenance
      // lock before touching any visit.
      await lockCustomerComms(trx, noticeRow.customer_id);
      const customer = await trx('customers').where({ id: noticeRow.customer_id }).forUpdate().first();
      if (!customer || customer.deleted_at) throw hold('rate_moved_since_notice', 'customer gone');
      const notice = await trx('price_change_notices').where({ id: noticeRow.id }).forUpdate().first();
      if (!notice || notice.applied_at || !wasDelivered(notice)) { outcomeBox.skipped = true; return; }
      if (!LANES.includes(notice.billing_lane)) throw hold('lane_unknown', { lane: notice.billing_lane });
      // The 30-day rule is measured from the DELIVERY the customer actually
      // got, never from the day the owner planned to send.
      const sentDay = etDateString(new Date(notice.sent_at));
      if (daysBetweenYmd(sentDay, ymd(notice.effective_date)) < MIN_NOTICE_DAYS) throw hold('notice_too_recent', { sentDay, effectiveDate: ymd(notice.effective_date) });
      const activeHold = await activePlanHold(trx, customer.id);
      if (activeHold) throw hold('plan_on_hold', { holdId: activeHold.id, familyKey: activeHold.family_key, resumeOn: ymd(activeHold.resume_on) });
      const liveLane = await resolveLiveLane(trx, { customer, familyKey: notice.family_key, today });
      if (liveLane !== notice.billing_lane) throw hold('billing_lane_changed', { noticed: notice.billing_lane, live: liveLane });
      const ctx = { notice, customer, today, metadata: parseMetadata(notice.metadata) };
      let outcome;
      if (notice.billing_lane === LANE_MONTHLY) outcome = await applyMonthly(trx, ctx);
      else if (notice.billing_lane === LANE_PER_APPLICATION) outcome = await applyPerApplication(trx, ctx);
      else outcome = await applyPrepay(trx, ctx);
      await finalizeApplied(trx, ctx, outcome, now);
      outcomeBox.outcome = outcome;
    });
  } catch (err) {
    const h = holdFromGuard(err) || (isHold(err) ? err : null);
    if (h) return { applied: false, hold: h.holdCode, detail: h.detail };
    logger.error(`[rate-review-apply] notice ${noticeRow.id} failed: ${err.message}`);
    return { applied: false, hold: 'apply_error', detail: String(err.message || '').slice(0, 300) };
  }
  if (outcomeBox.skipped) return { applied: false, skipped: true };
  return { applied: true, outcome: outcomeBox.outcome };
}

async function recordHold(dbh, noticeRow, code, detail, now) {
  const metadata = parseMetadata(noticeRow.metadata);
  await dbh('price_change_notices').where({ id: noticeRow.id }).whereNull('applied_at').update({
    apply_hold_reason: code,
    apply_attempts: Number(noticeRow.apply_attempts || 0) + 1,
    metadata: JSON.stringify({ ...metadata, last_hold: { reason: code, detail: detail == null ? null : detail, at: now.toISOString() } }),
    updated_at: now,
  });
}

async function raiseHoldAlert(noticeRow, code) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    await raiseAdminAlert('billing', {
      area: 'Billing',
      action: 'finish an annual rate change by hand',
      why: HOLD_COPY[code] || HOLD_COPY.apply_error,
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(noticeRow.customer_id)}`,
      subject: { type: 'customer', id: String(noticeRow.customer_id) },
      doneWhen: 'rate_review_notice_applied',
      who: 'person',
    }, {
      dedupeKey: `rate-review-apply-hold:${noticeRow.id}:${code}`,
      refreshOnDedupe: true,
      metadata: { noticeId: noticeRow.id, rateReviewRowId: noticeRow.rate_review_row_id, familyKey: noticeRow.family_key, reason: code },
    });
  } catch (err) {
    logger.warn(`[rate-review-apply] hold alert failed for notice ${noticeRow.id}: ${err.message}`);
  }
}

/**
 * Nightly apply. Gate off → returns before any query. Returns
 * { ok, asOf, due, applied, held, skipped, holds: [{ noticeId, reason }] }.
 */
async function applyDueRateChanges({ asOf = new Date(), now = null, dbh = db } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  const at = now || asOf;
  const asOfDay = etDateString(asOf);
  const due = await loadDueNotices(dbh, asOfDay);
  const out = { ok: true, asOf: asOfDay, due: due.length, applied: 0, held: 0, skipped: 0, holds: [] };
  for (const noticeRow of due) {
    const result = await applyNotice(noticeRow, { now: at, dbh });
    if (result.applied) { out.applied += 1; continue; }
    if (result.skipped) { out.skipped += 1; continue; }
    out.held += 1;
    out.holds.push({ noticeId: noticeRow.id, customerId: noticeRow.customer_id, familyKey: noticeRow.family_key, reason: result.hold });
    try {
      await recordHold(dbh, noticeRow, result.hold, result.detail, at);
    } catch (err) {
      logger.error(`[rate-review-apply] could not record hold for notice ${noticeRow.id}: ${err.message}`);
    }
    await raiseHoldAlert(noticeRow, result.hold);
  }
  logger.info(`[rate-review-apply] ${asOfDay}: ${out.due} due, ${out.applied} applied, ${out.held} held, ${out.skipped} skipped`);
  return out;
}

// Undo before the send: delete the batch's UNDELIVERED notice rows (a
// draft, or a draft the public page flipped to 'viewed' on a preview — no
// sent_at, no delivered leg) and clear the ranking rows' links, so the
// batch can be rebuilt or re-scheduled. A delivered notice is never
// touched (reported as kept). The notices are locked, judged by the same
// delivery evidence the apply uses (wasDelivered), deleted under those
// same guards in the DELETE's own predicate, and unlinked — one
// transaction under the batch lock.
async function retireDraftNotices(batchKey, { dbh = db } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  if (!BATCH_KEY_RE.test(String(batchKey || ''))) throw badInput('batchKey must be YYYY-MM');
  return dbh.transaction(async (trx) => {
    await lockBatch(trx, batchKey);
    const rows = await trx('rate_review_snapshots').where({ batch_key: batchKey }).whereNotNull('notice_id').select('id', 'notice_id');
    const noticeIds = rows.map((r) => r.notice_id);
    if (!noticeIds.length) return { ok: true, batchKey, retired: 0, keptDelivered: 0 };
    const linked = await trx('price_change_notices').whereIn('id', noticeIds).forUpdate().select('id', 'status', 'sent_at', 'email_sent', 'sms_sent');
    const undeliveredIds = linked.filter((n) => !wasDelivered(n) && !n.sent_at && !n.email_sent && !n.sms_sent).map((n) => n.id);
    let retired = 0;
    if (undeliveredIds.length) {
      await trx('rate_review_snapshots').where({ batch_key: batchKey }).whereIn('notice_id', undeliveredIds).update({ notice_id: null, updated_at: new Date() });
      retired = await trx('price_change_notices').whereIn('id', undeliveredIds)
        .whereIn('status', ['draft', 'viewed']).whereNull('sent_at').where('email_sent', false).where('sms_sent', false)
        .delete();
    }
    logger.info(`[rate-review-apply] ${batchKey}: ${retired} undelivered notice rows retired, ${linked.length - undeliveredIds.length} delivered kept`);
    return { ok: true, batchKey, retired, keptDelivered: linked.length - undeliveredIds.length };
  });
}

// The non-termite renewal consumer of next_term_prepay_amount: an admin
// recording a renewal (routes/admin-customers.js, the collected-prepay and
// draft-invoice routes) must charge the amount the customer was noticed for
// THAT term's successor, or say so (acknowledgeNoticedAmount). The
// predecessor is resolved, never guessed: the customer's terms carrying a
// noticed amount, in the requested coverage's family (an unlabeled term only
// when the request names no family either), neither cancelled nor already
// renewed, whose term_end sits within 60 days either side of the new term's
// start (a successor starts the day after its predecessor ends); with more
// than one candidate the one ending nearest the new start is the
// predecessor. Returns null when nothing applies or the amount matches,
// else { termId, termEnd, noticedAmount }.
// `lock` (inside the caller's write transaction): the candidate rows are
// read FOR UPDATE, so a concurrent nightly apply writing
// next_term_prepay_amount serializes against the renewal that reads it.
async function noticedRenewalAmountConflict(dbh, { customerId, amount, coverageServiceType = null, termStart = null, today, lock = false }) {
  if (!customerId || !(Number(amount) > 0)) return null;
  const start = ymd(termStart) || today;
  const family = familyOfCoverage(coverageServiceType);
  const query = dbh('annual_prepay_terms')
    .where({ customer_id: customerId })
    .whereNotNull('next_term_prepay_amount')
    .where('term_end', '>=', addDaysYmd(start, -60))
    .where('term_end', '<=', addDaysYmd(start, 60))
    .whereNotIn('status', ['cancelled', 'canceled', 'refunded', 'renewed', 'switch_plan']);
  if (lock) query.forUpdate();
  const terms = await query.select('id', 'term_end', 'next_term_prepay_amount', 'coverage_service_type', 'renewal_decision');
  const candidates = terms
    .filter((t) => !['cancel', 'renew', 'switch_plan'].includes(String(t.renewal_decision || '')))
    .filter((t) => (family ? familyOfCoverage(t.coverage_service_type) === family : !familyOfCoverage(t.coverage_service_type)))
    .sort((a, b) => Math.abs(daysBetweenYmd(ymd(a.term_end), start)) - Math.abs(daysBetweenYmd(ymd(b.term_end), start)));
  const term = candidates[0];
  if (!term) return null;
  const noticedCents = cents(term.next_term_prepay_amount);
  if (noticedCents == null || noticedCents === Math.round(Number(amount) * 100)) return null;
  return { termId: term.id, termEnd: ymd(term.term_end), noticedAmount: dollars(noticedCents) };
}

// Held rate-review notices (sent, not applied, with a recorded hold).
async function listApplyHolds({ dbh = db } = {}) {
  const rows = await dbh('price_change_notices as n')
    .leftJoin('rate_review_snapshots as r', 'r.id', 'n.rate_review_row_id')
    .whereNotNull('n.rate_review_row_id')
    .whereNull('n.applied_at')
    .whereNotNull('n.apply_hold_reason')
    .orderBy('n.effective_date', 'asc')
    .select('n.id', 'n.customer_id', 'n.family_key', 'n.billing_lane', 'n.effective_date', 'n.status', 'n.noticed_current_cents', 'n.noticed_new_cents',
      'n.apply_hold_reason', 'n.apply_attempts', 'n.metadata', 'n.rate_review_row_id', 'r.batch_key', 'r.cadence');
  return rows.map((n) => ({
    noticeId: n.id,
    customerId: n.customer_id,
    rateReviewRowId: n.rate_review_row_id,
    batchKey: n.batch_key || null,
    familyKey: n.family_key,
    cadence: n.cadence || null,
    billingLane: n.billing_lane,
    status: n.status,
    effectiveDate: ymd(n.effective_date),
    noticedCurrentCents: n.noticed_current_cents,
    noticedNewCents: n.noticed_new_cents,
    holdReason: n.apply_hold_reason,
    holdCopy: HOLD_COPY[n.apply_hold_reason] || null,
    attempts: n.apply_attempts,
    lastHold: parseMetadata(n.metadata).last_hold || null,
  }));
}

module.exports = {
  LANES,
  NOTIFIED_STATUSES,
  LEDGER_SOURCE,
  AUDIT_ACTION,
  HOLD_COPY,
  scheduleNoticeRows,
  applyDueRateChanges,
  listApplyHolds,
  retireDraftNotices,
  noticedRenewalAmountConflict,
  _private: {
    laneForRow, effectiveDateFor, nextBillingDayOnOrAfter, addDaysYmd, daysBetweenYmd, flatVisitRefusal, holdFromGuard, HoldError,
    loadLineOpenVisits, loadCustomerOpenVisits, consumesPerApplicationFee, feeScopeRefusal, resolvePrepayTerm, resolveLiveLane, applyNotice, loadDueNotices, wasDelivered, cadenceLabelFor, termRenewalNoticed, moveMonthlySlice, scheduleRow,
  },
};
