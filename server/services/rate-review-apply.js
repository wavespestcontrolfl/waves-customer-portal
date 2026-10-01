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
 *                         reminder already went out for the term.
 *     The ranking row keeps status `approved` and records notice_id; only
 *     the comms PR marks it `sent`.
 *
 *   applyDueRateChanges({ asOf })  nightly 03:10 ET (scheduler.js, under
 *     runExclusive). For every rate-review notice the comms PR has SENT
 *     (status sent | viewed — the public page flips a sent notice to viewed)
 *     whose effective date has arrived and that is not applied yet, ONE
 *     transaction per notice: the customer's comms lock, the customers row
 *     FOR UPDATE, the notice row FOR UPDATE, then
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
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  PLAN_LINE_SQL, LEDGER_FAMILIES_FOR_LINE, anniversaryInWindow, familyOfCoverage, visitsPerYearFor,
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
    });
  }
  const { effectiveDate, firstVisitId } = effectiveDateFor(lane, { floor, visits, billingDay: customer.billing_day, term, plannedSend });
  if (firstVisitId) metadata.first_visit_id = firstVisitId;
  const inserted = await dbh('price_change_notices').insert({
    batch_id: batchId,
    customer_id: row.customer_id,
    current_amount_cents: Number(row.current_rate_cents),
    new_amount_cents: Number(row.proposed_rate_cents),
    cadence_label: cadenceLabelFor(lane),
    effective_date: effectiveDate,
    notice_token: crypto.randomBytes(16).toString('hex'),
    status: 'draft',
    created_by: actorId || null,
    metadata: JSON.stringify(metadata),
    rate_review_row_id: row.id,
    billing_lane: lane,
    family_key: row.family_key,
    noticed_current_cents: Number(row.current_rate_cents),
    noticed_new_cents: Number(row.proposed_rate_cents),
    apply_attempts: 0,
  }).onConflict(['customer_id', 'effective_date', 'current_amount_cents', 'new_amount_cents']).ignore().returning(['id', 'effective_date']);
  if (!inserted.length) throw hold('notice_event_collision', { effectiveDate });
  await dbh('rate_review_snapshots').where({ id: row.id }).update({ notice_id: inserted[0].id, updated_at: new Date() });
  return { noticeId: inserted[0].id, rowId: row.id, customerId: row.customer_id, familyKey: row.family_key, lane, effectiveDate };
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

  const dbh = trx || db;
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

async function loadDueNotices(dbh, asOfDay) {
  return dbh('price_change_notices')
    .whereNotNull('rate_review_row_id')
    .whereIn('status', NOTIFIED_STATUSES)
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

// customers.per_application_fee — the completion fallback when a visit
// carries no stamp (billing-lane.js completionInvoiceAmount step 4). Its
// only writer today is acceptance; this is the one sanctioned non-accept
// writer, and it moves ONLY when the fee is exactly the amount the customer
// was told (a two-line account's fee may belong to the other line; a stale
// fee is left as it was and flagged). A NULL fee stays NULL — unpriced is
// never invented.
async function moveFeeAndLedger(trx, { notice, customer, metadata, noticedCurrent, noticedNew }) {
  const newDollars = dollars(noticedNew);
  const feeCents = cents(customer.per_application_fee);
  const feeUpdated = feeCents != null && feeCents === noticedCurrent;
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
    feeUntouchedReason: feeUpdated ? null : (feeCents == null ? 'no_fee_on_file' : 'fee_differs_from_noticed_current'),
    ledger,
  };
}

async function applyPerApplication(trx, ctx) {
  const { notice, customer } = ctx;
  const schedule = require('../routes/admin-schedule')._private;
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
  const money = await moveFeeAndLedger(trx, { notice, customer, metadata: ctx.metadata, noticedCurrent, noticedNew });
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
  if (cents(term.prepay_amount) !== Number(metadata.current_term_amount_cents)) throw hold('rate_moved_since_notice', { termAmountCents: cents(term.prepay_amount) });
  const visitsPerTerm = Number(term.coverage_visit_count) > 0 ? Number(term.coverage_visit_count) : Number(metadata.coverage_visits);
  if (visitsPerTerm !== Number(metadata.coverage_visits)) throw hold('rate_moved_since_notice', { coverageVisits: visitsPerTerm });
  // The per-application figures the customer saw must still describe the term.
  if (Math.round(Number(term.prepay_amount) * 100 / visitsPerTerm) !== Number(notice.noticed_current_cents)) throw hold('rate_moved_since_notice', { perApplication: true });
  // "Notified amount is the charged amount": once the renewal reminder is
  // out (or a termite fee was frozen), the term's amount is spoken for.
  if (termRenewalNoticed(term)) throw hold('renewal_notice_already_sent', { termId: term.id });
  const nextAmount = dollars(Number(notice.noticed_new_cents) * visitsPerTerm);
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
      if (!notice || notice.applied_at || !NOTIFIED_STATUSES.includes(String(notice.status))) { outcomeBox.skipped = true; return; }
      if (!LANES.includes(notice.billing_lane)) throw hold('lane_unknown', { lane: notice.billing_lane });
      const activeHold = await activePlanHold(trx, customer.id);
      if (activeHold) throw hold('plan_on_hold', { holdId: activeHold.id, familyKey: activeHold.family_key, resumeOn: ymd(activeHold.resume_on) });
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
  _private: {
    laneForRow, effectiveDateFor, nextBillingDayOnOrAfter, addDaysYmd, daysBetweenYmd, flatVisitRefusal, holdFromGuard, HoldError,
    loadLineOpenVisits, resolvePrepayTerm, applyNotice, loadDueNotices, cadenceLabelFor, termRenewalNoticed, moveMonthlySlice,
  },
};
