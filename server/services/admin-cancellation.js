'use strict';

/**
 * Admin-side "Cancel plan" (cancel-flow lane C3) — the SAME engine the
 * customer portal runs (cancellation-processor + cancellation-resolution),
 * driven by the office instead of the customer. Two entry points share it:
 * the Customer 360 dialog (routes/admin-customers.js) and the Intelligence
 * Bar `cancel_plan` write tool (preview → pending card → /confirm-action).
 *
 *   previewCancelPlan(...)  read-only: before/after facts (impact.js), scope
 *                           feasibility, live annual-prepay term + the
 *                           ruling C-6 refund math, channel availability.
 *   commitCancelPlan(...)   service_requests row (category 'cancellation',
 *                           source 'admin') → processor → prepay term
 *                           disposition → cancellation_cases row →
 *                           confirmations (if flagged) → truthful outcome.
 *
 * Ordering rule (same as routes/requests.js): MONEY OUTRANKS DURABILITY.
 * Scoped feasibility is proven BEFORE the request row exists (a fail-closed
 * plan must not leave a "cancellation" ticket behind); the processor's
 * billing wind-down runs the instant the request persists; the case write
 * and every send come after.
 *
 * Prepay disposition (ruling C-6) — whole-account cancels only; a scoped
 * cancel leaves the term alone:
 *   end_at_term      keep every covered visit through term_end
 *                    (processor keepThrough), decide the term 'cancel' so
 *                    it never renews — coverage rides out its paid window.
 *   end_now_refund   pull everything now, decide the term 'cancel' (move 8)
 *                    and RECORD the refund (prepaid ÷ included visits ×
 *                    remaining visits) on the case + an office task to issue
 *                    it to the original method. Never refunds through Stripe
 *                    itself; the refund landing later fires the renewal
 *                    module's own coverage revocation (move 9).
 *
 * Dark behind GATE_CANCEL_FLOW_V2 (call-time read). Kill switch = unset.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const CancellationResolution = require('./cancellation-resolution');
const { REASON_CODE_VALUES, isReasonCode } = require('./cancellation-resolution/reason-codes');
const { buildCancellationImpact } = require('./cancellation-resolution/impact');
const { processCancellationRequest, planScopedWindDown } = require('./cancellation-processor');
const { hasCancellableWork } = require('./cancellation-eligibility');
const { sendCancellationConfirmations, familyLabelOf } = require('./cancellation-confirmations');

const EFFECTIVE_DATES = ['now', 'end_of_coverage'];
const PREPAY_DISPOSITIONS = ['end_at_term', 'end_now_refund'];
// prepaid_method the annual-prepay coverage stamp writes on a covered visit
// (annual-prepay-renewals.ANNUAL_PREPAY_PREPAID_METHOD) — read lazily; the
// renewal module is heavy and requires the processor's graph.
const ANNUAL_PREPAY_TERM_ACTIVE_STATUSES = ['active', 'renewal_pending'];

class CancelPlanError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

function normalizeInput(raw = {}) {
  const families = Array.isArray(raw.families)
    ? [...new Set(raw.families.map((f) => String(f || '').trim()).filter(Boolean))].slice(0, 8)
    : [];
  const effectiveDate = raw.effectiveDate == null ? 'now' : String(raw.effectiveDate);
  if (!EFFECTIVE_DATES.includes(effectiveDate)) {
    throw new CancelPlanError(400, 'invalid_effective_date', `effectiveDate must be one of ${EFFECTIVE_DATES.join(', ')}`);
  }
  const prepayDisposition = raw.prepayDisposition == null || raw.prepayDisposition === '' ? null : String(raw.prepayDisposition);
  if (prepayDisposition && !PREPAY_DISPOSITIONS.includes(prepayDisposition)) {
    throw new CancelPlanError(400, 'invalid_prepay_disposition', `prepayDisposition must be one of ${PREPAY_DISPOSITIONS.join(', ')}`);
  }
  const reasonCode = raw.reasonCode == null || raw.reasonCode === '' ? null : String(raw.reasonCode);
  if (reasonCode && !isReasonCode(reasonCode)) {
    throw new CancelPlanError(400, 'invalid_reason_code', 'reasonCode is not a known cancellation reason');
  }
  const note = stripHtml(raw.note || '').trim().slice(0, 2000);
  return {
    families,
    effectiveDate,
    prepayDisposition,
    waiveLateFee: raw.waiveLateFee === true,
    sendConfirmation: raw.sendConfirmation !== false,
    reasonCode,
    note,
  };
}

// Deposit-stage accounts belong to the DEDICATED signup-cancellation flow
// (customer-offboarding.cancelSignupAndRefundDeposit): the generic plan
// cancel would churn the account and pull the booked visits WITHOUT
// refunding the received deposit. Refuse and point at the right action.
// Fail closed: an unverifiable deposit-stage check refuses the cancel as
// retryable — proceeding on a probe error could churn a deposit-stage
// account without refunding the deposit.
async function refuseDepositStageAccount(customerId) {
  let signup = null;
  try {
    const { previewCancelSignup } = require('./customer-offboarding');
    signup = await previewCancelSignup(customerId);
  } catch (probeErr) {
    logger.warn(`[admin-cancellation] signup-cancel probe failed for ${customerId}: ${probeErr.message}`);
    throw new CancelPlanError(503, 'deposit_check_unavailable',
      'Could not verify this account is past the deposit stage — cancellation not processed. Try again shortly.');
  }
  if (signup && signup.eligible === true) {
    throw new CancelPlanError(409, 'use_cancel_signup',
      'This account is still at the deposit stage — use "Cancel signup & refund deposit" so the deposit is refunded, instead of a plan cancellation.');
  }
  // Blocked is not clearance: a deposit still owed back (refund in flight,
  // unapplied money, or a credit the signup flow could recover by voiding
  // its invoice) makes this a deposit-stage account even when blockers put
  // the dedicated flow out of reach — the generic churn would pull the
  // booked visits and keep the deposit. Resolve the deposit first.
  if (signup && signup.depositOutstanding === true) {
    const why = Array.isArray(signup.blockers) && signup.blockers.length ? ` (${signup.blockers[0]})` : '';
    throw new CancelPlanError(409, 'deposit_outstanding',
      `A customer deposit is still outstanding on this account — resolve it before a plan cancellation${why}.`);
  }
}

async function loadCustomer(customerId) {
  const customer = await db('customers')
    .where({ id: customerId })
    .whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'phone', 'email', 'active', 'pipeline_stage',
      'waveguard_tier', 'monthly_rate', 'billing_mode');
  if (!customer) throw new CancelPlanError(404, 'customer_not_found', 'Customer not found');
  return customer;
}

// The canonical coverage query (same one billing reads) admits more term
// shapes than this lane can END truthfully: a paid `payment_pending` row the
// activation sweep has not flipped, a decided `renewed`/`switch_plan` row, a
// decided lapse riding out its window, or several covered terms at once. A
// shape recordDecision's guard would silently miss is REFUSED here, before
// any write — never "processed" with the term left live.
async function resolveLiveTerm(customerId, wholeAccount) {
  if (!wholeAccount) return null;
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  // ALL still-paid terms, current AND future: a renewal is a NEW row
  // starting the day after the old term ends, so an as-of-today query would
  // dispose only the current term while the sweep pulls the paid
  // successor's visits and leaves that term live. Two live terms refuse
  // below (multiple_prepay_terms) — dispose the extra one first.
  const terms = await coveredTermsAsOf(db, null)
    .where('t.term_end', '>=', etDateString())
    .where('t.customer_id', customerId)
    .orderBy('t.term_end', 'desc')
    .select('t.id', 't.term_start', 't.term_end', 't.plan_label', 't.prepay_amount',
      't.coverage_visit_count', 't.coverage_service_type', 't.status', 't.renewal_decision',
      't.prepay_invoice_id');
  if (!terms || !terms.length) return null;
  if (terms.length > 1) {
    throw new CancelPlanError(409, 'multiple_prepay_terms',
      'This account has more than one live annual-prepay term — a whole-plan cancel cannot pick one. Dispose of the extra term from the invoice tools first.');
  }
  const term = terms[0];
  if (term.renewal_decision && term.renewal_decision !== 'cancel') {
    throw new CancelPlanError(409, 'prepay_term_decided',
      `The annual-prepay term is already decided "${term.renewal_decision}". Clear that renewal decision first, then cancel.`);
  }
  if (!term.renewal_decision && !ANNUAL_PREPAY_TERM_ACTIVE_STATUSES.includes(String(term.status))) {
    throw new CancelPlanError(409, 'prepay_term_not_actionable',
      `The annual-prepay term is "${term.status}" right now and cannot take a cancel decision. Retry once it activates, or dispose of it from the invoice tools.`);
  }
  return term;
}

const dateOnly = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

// Acceptance matching is by CUSTOMER + canonical SCOPE SET, carried in the
// request's own metadata (written at acceptance time, BEFORE any
// processing) — never the presentation subject, which embeds the proposing
// operator and the caller's family order; another admin, the other surface
// (Customer 360 ↔ Intelligence Bar), or a reordered family list must still
// land the repair on the first attempt's request. OPEN acceptances match
// with NO age cutoff: 'new' means the run still owes follow-ups (a clean
// run stamps 'resolved'), and a partial cancellation revisited after a
// weekend must still reach the repair pass. RESOLVED echoes stay bounded
// to 24h — a lost response retries promptly, and an old resolved
// acceptance must not answer for a genuinely empty account months later.
const cancelScopeKey = (wholeAccount, scope) => JSON.stringify(wholeAccount ? [] : [...scope].sort());
function requestCancelPlanMeta(row) {
  try {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || null);
    return meta && meta.cancel_plan ? meta.cancel_plan : null;
  } catch { return null; }
}
async function findCancelAcceptance(customerId, wholeAccount, scope, status) {
  const wanted = cancelScopeKey(wholeAccount, scope);
  let query = db('service_requests')
    .where({ customer_id: customerId, category: 'cancellation', source: 'admin', status })
    .orderBy('created_at', 'desc');
  if (status !== 'new') {
    query = query.where('created_at', '>=', new Date(Date.now() - 24 * 60 * 60 * 1000));
  }
  const candidates = await query.select('*');
  for (const row of candidates || []) {
    const cp = requestCancelPlanMeta(row);
    if (cp && JSON.stringify(Array.isArray(cp.scope) ? [...cp.scope].sort() : null) === wanted) return row;
  }
  return null;
}

// coverageRowsForTerm returns [] BOTH for "no covered rows" and for a term
// whose coverage identity is unreadable (coverage_service_type /
// coverage_visit_count are nullable legacy columns) — the two must never be
// conflated on this lane: an unresolvable identity read as a valid EMPTY
// keep set pulls paid visits NOW while the confirmation says they ride out,
// and a zero completed-visit count overstates the refund. Mirrors the
// module's own guard (it bails to [] when any of these is missing).
const termCoverageResolvable = (term) => !!(term
  && String(term.coverage_service_type || '').trim()
  && Number.parseInt(term.coverage_visit_count, 10) > 0
  && term.term_start && term.term_end);

// The facts the operator approves on the preview (visit count, refund
// dollars, term, boundary, scope) — fingerprinted so the commit can refuse
// with 409 preview_changed when a covered visit completes, a visit appears,
// or the term is edited during the confirmation window (codex C3 r3 P2).
// Both surfaces carry it: the dialog echoes previewFingerprint into the
// commit body; the IB pending action pins it at proposal time.
// Scheduled-visit fee exposure on the visits this cancel pulls: BOTH card
// fee lanes (estimate card hold + /secure appointment card — mutually
// exclusive per visit) judged by the SAME preview helpers the dispatch
// cancel prompt uses (cardHoldCancelPreview / appointmentCardCancelPreview),
// so the operator sees the fee-or-waive choice BEFORE the money-moving
// commit. Unverifiable = fee-may-apply, never a silent "no fee" (a thrown
// preview matches the helpers' own posture); only fee-applying visits are
// listed. Rides the approved-facts fingerprint.
async function previewVisitFees(pulledVisitKeys) {
  const ids = (Array.isArray(pulledVisitKeys) ? pulledVisitKeys : [])
    .map((k) => String(k).split(':')[0]).filter(Boolean);
  const visits = [];
  let unresolved = false;
  let total = 0;
  let totalKnown = true;
  for (const id of ids) {
    let fee = null;
    try {
      const CardHolds = require('./estimate-card-holds');
      const hold = await CardHolds.cardHoldCancelPreview(id);
      if (hold.held) {
        fee = { id, lane: 'card_hold', feeApplies: hold.feeApplies === true, feeAmount: hold.feeAmount ?? null, unresolved: hold.unresolved === true };
      } else {
        const ApptCards = require('./appointment-card-request');
        const appt = await ApptCards.appointmentCardCancelPreview(id);
        if (appt.secured) fee = { id, lane: 'appointment_card', feeApplies: appt.feeApplies === true, feeAmount: appt.feeAmount ?? null, unresolved: appt.unresolved === true };
      }
    } catch (err) {
      logger.warn(`[admin-cancellation] fee preview failed for visit ${id}: ${err.message}`);
      fee = { id, lane: null, feeApplies: true, feeAmount: null, unresolved: true };
    }
    if (!fee || !fee.feeApplies) continue;
    visits.push(fee);
    if (fee.unresolved) unresolved = true;
    if (fee.feeAmount != null && Number.isFinite(Number(fee.feeAmount))) total += Number(fee.feeAmount);
    else totalKnown = false;
  }
  return {
    applies: visits.length > 0,
    unresolved,
    total: visits.length && totalKnown ? Math.round(total * 100) / 100 : null,
    visits,
  };
}

function cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact, visitFees, scope, wholeAccount }) {
  const crypto = require('crypto');
  const facts = {
    // The fee-or-waive exposure the operator approved (id, lane, amount,
    // resolvability per fee-applying visit).
    visitFees: visitFees
      ? visitFees.visits.map((v) => `${v.id}:${v.lane}:${v.feeAmount}:${v.unresolved}`).sort()
      : null,
    scope: wholeAccount ? [] : [...scope].sort(),
    termId: term ? String(term.id) : null,
    termEnd: term ? dateOnly(term.term_end) : null,
    disposition: prepayPlan ? prepayPlan.prepayDisposition : null,
    keepThrough: prepayPlan ? prepayPlan.keepThrough : null,
    // Every displayed refund COMPONENT, not just the total: prepaid ÷
    // included × remaining can produce the same dollars from different
    // inputs, and the operator approved the inputs too.
    refundAmount: refund ? refund.amount : null,
    refundManual: refund ? refund.needsManualCalc : null,
    refundPrepaid: refund ? refund.prepaidAmount : null,
    refundIncluded: refund ? refund.includedVisits : null,
    refundCompleted: refund ? refund.completedVisits : null,
    refundRemaining: refund ? refund.remainingVisits : null,
    // The dialog shows the open balance beside the cancel — a payment or
    // new invoice during the window changes what the operator approved.
    openBalance: impact ? (impact.openBalance ?? null) : null,
    visitsPulled: impact ? (impact.visitsCancelled ?? null) : null,
    // Stable visit identities: a reschedule, or one visit completing while
    // another appears, keeps the count identical — the ids+dates don't.
    pulledVisitKeys: impact && Array.isArray(impact.pulledVisitKeys) ? impact.pulledVisitKeys : null,
    // Every displayed billing output the operator approves: tier and
    // monthly before/after, and each remaining service's repriced rate (a
    // plan-ledger edit changes these with the visit count unchanged).
    tierBefore: impact ? (impact.tierBefore ?? null) : null,
    tierAfter: impact ? (impact.tierAfter ?? null) : null,
    monthlyBefore: impact ? (impact.accountMonthlyBefore ?? null) : null,
    monthlyAfter: impact ? (impact.accountMonthlyAfter ?? null) : null,
    remaining: impact && Array.isArray(impact.remaining)
      ? impact.remaining.map((r) => `${r.key}:${r.monthlyBefore}:${r.monthlyAfter}`)
      : null,
    // Per-application repricing of surviving visits — approved per row.
    perApp: impact && Array.isArray(impact.perAppChanges)
      ? impact.perAppChanges.map((r) => `${r.id}:${r.before}:${r.after}`).sort()
      : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/**
 * Ruling C-6: prepaid amount ÷ included visits × remaining visits. Included
 * visits = the term's coverage_visit_count; completed = the term's coverage
 * rows (coverageRowsForTerm — the canonical identity, which includes a
 * pre-activation completion the stamp misses) already completed. When the
 * count is not on the term the refund is recorded as needing a manual
 * calculation — never invented.
 */
async function computePrepayRefund(term) {
  const prepaidAmount = term && term.prepay_amount != null ? Number(term.prepay_amount) : null;
  const includedVisits = Number.parseInt(term && term.coverage_visit_count, 10);
  const base = {
    prepaidAmount: Number.isFinite(prepaidAmount) ? prepaidAmount : null,
    includedVisits: Number.isInteger(includedVisits) && includedVisits > 0 ? includedVisits : null,
    completedVisits: null,
    remainingVisits: null,
    amount: null,
    needsManualCalc: true,
    reason: null,
  };
  if (!(base.prepaidAmount > 0)) return { ...base, reason: 'prepay_amount_missing' };
  if (!base.includedVisits) return { ...base, reason: 'coverage_visit_count_missing' };
  // Unreadable coverage identity ⇒ coverageRowsForTerm returns [] and the
  // completed count reads zero — overstating remainingVisits. Manual, never
  // an invented full refund.
  if (!termCoverageResolvable(term)) return { ...base, reason: 'coverage_identity_missing' };
  // Prior refund activity on the prepay payment: Stripe PARTIAL refunds
  // leave the invoice 'paid' — the refund state lives on the payment rows
  // (same signal move 9's reconciler reads). The C-6 formula assumes the
  // full prepay_amount was collected and kept, so an earlier refund makes
  // "prepaid ÷ included × remaining" over-promise (combined refunds could
  // exceed what the customer paid). Allocating a partial refund is an
  // operator judgment — record manual; a failed check is uncertain money,
  // also manual (fail closed).
  if (term.prepay_invoice_id) {
    try {
      const invoice = await db('invoices').where({ id: term.prepay_invoice_id })
        .first('id', 'stripe_payment_intent_id', 'stripe_charge_id');
      const refundActivity = invoice ? await db('payments')
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
        .first('id') : null;
      if (refundActivity) return { ...base, reason: 'prior_refund_activity' };
    } catch (err) {
      logger.warn(`[admin-cancellation] prior-refund check failed for term ${term.id}: ${err.message}`);
      return { ...base, reason: 'refund_activity_check_failed' };
    }
  }
  let completedRows = [];
  try {
    // Canonical coverage identity (coverageRowsForTerm — the mechanism the
    // renewal module itself counts with): a coverage visit that COMPLETED
    // before the prepay invoice was paid is deliberately UNSTAMPED (its
    // invoice is settled/credited at reconciliation), so the stamp-based
    // count missed it and inflated remainingVisits — refunding a slice the
    // customer already consumed.
    const { coverageRowsForTerm } = require('./annual-prepay-renewals');
    const rows = await coverageRowsForTerm({ ...term });
    completedRows = (Array.isArray(rows) ? rows : []).filter((r) =>
      String(r.status || '').toLowerCase() === 'completed'
      // Overlapping terms: a visit committed to ANOTHER term never consumes
      // THIS term's slices (rows predating the term-id stamp stay counted).
      && (r.annual_prepay_term_id == null || String(r.annual_prepay_term_id) === String(term.id)));
  } catch (err) {
    logger.warn(`[admin-cancellation] covered-visit count failed for term ${term.id}: ${err.message}`);
    return { ...base, reason: 'covered_visit_count_failed' };
  }
  const completedVisits = completedRows.length;
  const remainingVisits = Math.max(0, base.includedVisits - completedVisits);
  const amount = Math.round((base.prepaidAmount / base.includedVisits) * remainingVisits * 100) / 100;
  return { ...base, completedVisits, remainingVisits, amount, needsManualCalc: false };
}

// The LIVE term's canonical covered visit ids (coverageRowsForTerm — the
// renewal module's own identity). A stamp/term-id classifier is NOT
// coverage: a refunded prior term deliberately RETAINS
// annual_prepay_term_id for audit while its stamps are cleared, so a
// customer who later buys another term would have dead-term rows read as
// covered. An unresolvable set REFUSES the end-of-coverage cancel — never
// guess which visits are paid for (fail closed, before any write).
async function liveCoveredKeepIds(term, customerId) {
  if (!termCoverageResolvable(term)) {
    throw new CancelPlanError(409, 'prepay_coverage_unresolvable',
      'The annual-prepay term does not carry a readable coverage identity (service type / visit count), so the visits it covers cannot be resolved. Repair the term from the invoice tools, or cancel effective now.');
  }
  let rows;
  try {
    const { coverageRowsForTerm } = require('./annual-prepay-renewals');
    rows = await coverageRowsForTerm({ ...term, customer_id: customerId });
  } catch (err) {
    logger.error(`[admin-cancellation] covered-row set failed for term ${term.id}: ${err.message}`);
    throw new CancelPlanError(409, 'coverage_rows_unavailable',
      'Could not resolve which visits the prepay term covers. Nothing was cancelled — try again.');
  }
  return (Array.isArray(rows) ? rows : []).map((r) => r.id);
}

// A scoped cancel must never pull PREPAID visits: resolveLiveTerm only
// guards whole-account cancels, so a scope that selects the covered family
// would cancel already-paid visits while the term stays live — no decision,
// no refund. The term cannot be mapped to a family safely, but its covered
// ROWS can (coverageRowsForTerm): refuse when any live term's upcoming
// covered visit falls inside the scope (fail closed — a failed covered-row
// read also refuses).
async function scopedCoverageConflict(customerId, scope) {
  const { coveredTermsAsOf, coverageRowsForTerm } = require('./annual-prepay-renewals');
  // Current AND future still-paid terms — a paid successor's covered visits
  // are just as untouchable as the live term's.
  const terms = await coveredTermsAsOf(db, null)
    .where('t.term_end', '>=', etDateString())
    .where('t.customer_id', customerId)
    .select('t.id', 't.term_start', 't.term_end', 't.coverage_service_type', 't.coverage_visit_count');
  if (!terms || !terms.length) return false;
  const { familyOfServiceRow } = require('./cancellation-processor');
  const { CANCELLABLE_STATUSES } = require('./cancellation-eligibility');
  const today = etDateString();
  for (const t of terms) {
    // A live term whose coverage identity cannot be read could cover ANY of
    // the selected families — same fail-closed refusal as a failed read.
    if (!termCoverageResolvable(t)) return true;
    let covered;
    try {
      covered = await coverageRowsForTerm({ ...t, customer_id: customerId });
    } catch (err) {
      logger.error(`[admin-cancellation] scoped coverage check failed for term ${t.id}: ${err.message}`);
      return true; // unknown coverage = refuse the scoped cancel
    }
    const upcoming = (Array.isArray(covered) ? covered : []).filter((r) =>
      CANCELLABLE_STATUSES.includes(String(r.status))
      && (String(r.scheduled_date).slice(0, 10) >= today || r.status === 'rescheduled'));
    if (!upcoming.length) continue;
    // Catalog identity improves family classification when present.
    const serviceIds = [...new Set(upcoming.map((r) => r.service_id).filter(Boolean))];
    const services = serviceIds.length
      ? await db('services').whereIn('id', serviceIds).select('id', 'service_key', 'service_name')
      : [];
    const byId = new Map(services.map((s) => [s.id, s]));
    if (upcoming.some((r) => scope.includes(familyOfServiceRow({ ...r, ...(byId.get(r.service_id) || {}) })))) {
      return true;
    }
  }
  return false;
}

// Resolve scope against ownership. Returns { wholeAccount, scope, plan,
// scopeError } — scopeError is set (never thrown) so the preview can show it;
// the commit path turns it into a 409.
async function resolveScope(customerId, families) {
  if (!families.length) return { wholeAccount: true, scope: [], plan: null, scopeError: null };
  const plan = await planScopedWindDown(customerId, families);
  if (plan.ok) {
    if (await scopedCoverageConflict(customerId, plan.inScope)) {
      return { wholeAccount: false, scope: plan.inScope, plan: null, scopeError: 'scoped_covers_prepaid' };
    }
    return { wholeAccount: false, scope: plan.inScope, plan, scopeError: null };
  }
  if (plan.error === 'scope_is_whole_account') return { wholeAccount: true, scope: [], plan: null, scopeError: null };
  return { wholeAccount: false, scope: families, plan: null, scopeError: plan.error };
}

function scopeErrorToHttp(scopeError) {
  if (scopeError === 'scope_not_owned') {
    return new CancelPlanError(409, 'scope_not_owned', 'That service is not on the plan any more. Refresh and try again.');
  }
  if (scopeError === 'scoped_covers_prepaid') {
    return new CancelPlanError(409, 'scoped_covers_prepaid',
      'Upcoming visits in that selection are covered by the annual prepay term. Cancel the whole plan (which disposes of the term and records the refund), or leave the covered service in place.');
  }
  return new CancelPlanError(409, 'scoped_cancellation_unattributed',
    'The services that would stay cannot be priced from the ledger. Cancel the whole plan, or repair the plan-rate ledger first.');
}

// Prepay options apply to whole-account cancels only (a scoped cancel leaves
// the term alone). Derives the disposition from the effective date when the
// caller left it blank, and refuses a contradictory pair.
function resolvePrepay(input, term, wholeAccount) {
  if (!term || !wholeAccount) {
    if (input.effectiveDate === 'end_of_coverage') {
      throw new CancelPlanError(400, 'no_paid_coverage',
        term ? 'End of paid coverage applies to a whole-account cancel only.' : 'This account has no live annual-prepay coverage to run out.');
    }
    return { effectiveDate: 'now', prepayDisposition: null, keepThrough: null };
  }
  const derived = input.effectiveDate === 'end_of_coverage' ? 'end_at_term' : 'end_now_refund';
  const disposition = input.prepayDisposition || derived;
  if (disposition !== derived) {
    throw new CancelPlanError(400, 'prepay_disposition_mismatch',
      'end_at_term goes with effectiveDate end_of_coverage; end_now_refund goes with effectiveDate now.');
  }
  return {
    effectiveDate: input.effectiveDate,
    prepayDisposition: disposition,
    keepThrough: disposition === 'end_at_term' ? dateOnly(term.term_end) : null,
  };
}

// One commit per customer at a time (codex C3 r2 P1): the duplicate-cancel
// latch below is read-then-act, so two overlapping commits could both pass
// it, open two requests, run the processor twice and text the customer
// twice. A session-scoped advisory try-lock (same pattern as the content
// engine's publish lock) serializes the WHOLE commit — held across the
// processor and the case write, released in the caller's finally. Busy or
// unacquirable = refuse, never proceed unlocked (money path fails closed).
const CANCEL_LOCK_NS = 'admin-cancel-plan';
async function acquireCancelCommitLock(customerId) {
  let conn = null;
  let locked = false;
  try {
    conn = await db.client.acquireConnection();
    const res = await conn.query(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2::text)) AS locked',
      [CANCEL_LOCK_NS, String(customerId)]
    );
    locked = res && res.rows && res.rows[0] && res.rows[0].locked === true;
  } catch (err) {
    if (conn) { try { await db.client.releaseConnection(conn); } catch { /* pool reaps */ } }
    logger.error(`[admin-cancellation] cancel lock unavailable for ${customerId}: ${err.message}`);
    throw new CancelPlanError(503, 'cancel_lock_unavailable',
      'Could not serialize this cancellation against concurrent attempts. Try again in a moment.');
  }
  if (!locked) {
    try { await db.client.releaseConnection(conn); } catch { /* pool reaps */ }
    throw new CancelPlanError(409, 'cancel_in_progress',
      'Another cancellation for this customer is already being processed. Wait for it to finish, then refresh.');
  }
  return async function release() {
    try {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', [CANCEL_LOCK_NS, String(customerId)]);
    } catch (err) {
      // A failed unlock on a still-usable session would return the
      // connection to the pool WITH the advisory lock held — every later
      // cancel for this customer reads cancel_in_progress until the
      // process restarts. Poison the connection instead: knex destroys a
      // __knex__disposed connection rather than handing it out again, and
      // ending the session is what actually releases the lock.
      conn.__knex__disposed = err;
      logger.warn(`[admin-cancellation] cancel lock release failed for ${customerId} — connection poisoned so the pool destroys it: ${err.message}`);
    }
    try { await db.client.releaseConnection(conn); } catch { /* pool reaps */ }
  };
}

// Decide the term 'cancel' through move 8 and VERIFY the outcome (codex C3
// r2 P1): the guarded recordDecision returns null both when the decision was
// already 'cancel' AND when a racing renew/switch_plan decision landed after
// our read — only a re-read separates "already recorded" from a conflict
// that must fail the disposition (and, for end_now_refund, must not promise
// a refund on a term that is renewing).
async function decideTermCancel(term, actorUserId, notes) {
  const { recordDecision } = require('./annual-prepay-renewals');
  const decided = term.renewal_decision === 'cancel'
    ? null
    : await recordDecision({ termId: term.id, action: 'cancel', adminUserId: actorUserId, notes });
  if (decided) return { verified: true, fresh: true };
  const reread = await db('annual_prepay_terms').where({ id: term.id }).first('renewal_decision');
  if (reread && reread.renewal_decision === 'cancel') return { verified: true, fresh: false };
  return { verified: false, fresh: false, conflictingDecision: reread ? reread.renewal_decision || null : null };
}

function customerSummary(customer) {
  return {
    id: customer.id,
    name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    active: customer.active !== false,
    pipelineStage: customer.pipeline_stage || null,
    waveguardTier: customer.waveguard_tier || null,
    billingMode: customer.billing_mode || null,
    monthlyRate: customer.monthly_rate == null ? null : Number(customer.monthly_rate),
  };
}

async function previewCancelPlan({ customerId, ...raw } = {}) {
  if (!CancellationResolution.cancelFlowV2Enabled()) {
    throw new CancelPlanError(404, 'cancel_flow_v2_off', 'Cancel flow V2 is not enabled');
  }
  if (!customerId) throw new CancelPlanError(400, 'customer_id_required', 'customerId is required');
  const input = normalizeInput(raw);
  const customer = await loadCustomer(customerId);
  const { wholeAccount, scope, scopeError } = await resolveScope(customerId, input.families);
  // Repair-retry awareness: a partial run leaves its acceptance open, and
  // the account may now have nothing cancellable (or the scoped family gone
  // from the live rows) — the preview must still present a committable
  // retry, or the dialog's only button stays disabled and the first
  // attempt's failed side effects are stranded. Mirrors the commit gate.
  let repairRetry = false;
  try {
    const acceptance = await findCancelAcceptance(customerId, wholeAccount, scope, 'new');
    repairRetry = !!acceptance;
    if (acceptance) {
      // The commit inherits the FIRST attempt's accepted choices (sticky
      // waiver from request metadata or the case snapshot; sticky
      // no-communication) — the preview must present those EFFECTIVE
      // values, or the card says "fee charged, customer texted" while the
      // retry waives and stays silent. Same restore rules as the commit.
      const requestMeta = requestCancelPlanMeta(acceptance);
      if (requestMeta && requestMeta.waiveLateFee === true) input.waiveLateFee = true;
      if (requestMeta && requestMeta.sendConfirmation === false) input.sendConfirmation = false;
      if (!input.waiveLateFee) {
        try {
          const priorCase = await db('cancellation_cases')
            .where({ service_request_id: acceptance.id })
            .orderBy('created_at', 'desc')
            .first('snapshot');
          const snap = priorCase
            ? (typeof priorCase.snapshot === 'string' ? JSON.parse(priorCase.snapshot) : (priorCase.snapshot || {}))
            : null;
          if (snap && snap.waiveLateFee === true) input.waiveLateFee = true;
        } catch (snapErr) {
          logger.warn(`[admin-cancellation] prior-case preview load failed for request ${acceptance.id}: ${snapErr.message}`);
        }
      }
    }
  } catch (retryErr) {
    logger.warn(`[admin-cancellation] retry-acceptance preview lookup failed for ${customerId}: ${retryErr.message}`);
  }
  const scopedRetry = repairRetry && scopeError === 'scope_not_owned';
  // A deposit-stage account routes to the signup-cancellation flow — but a
  // repair retry of a partial generic cancel finishes what already started.
  if (!repairRetry) await refuseDepositStageAccount(customerId);
  const term = await resolveLiveTerm(customerId, wholeAccount);
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  // The preview's "visits pulled" must count what pressing the button pulls:
  // an end-of-coverage cancel KEEPS the live term's covered visits through
  // term_end (the processor's keepThrough floor + covered-id set), so the
  // impact math gets the same boundary and the same set.
  const keepVisitIds = prepayPlan.keepThrough ? await liveCoveredKeepIds(term, customerId) : null;
  const [eligible, impact] = await Promise.all([
    hasCancellableWork(customerId),
    buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough, keepVisitIds }),
  ]);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;
  const visitFees = await previewVisitFees(impact ? impact.pulledVisitKeys : null);
  const today = etDateString();
  return {
    previewFingerprint: cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact, visitFees, scope, wholeAccount }),
    enabled: true,
    customer: customerSummary(customer),
    eligible: eligible || repairRetry,
    // The dialog/IB card can say "this retries an unfinished cancellation".
    repairRetry,
    wholeAccount,
    scope,
    scopeLabels: scope.map(familyLabelOf),
    scopedSupported: wholeAccount ? null : (!scopeError || scopedRetry),
    scopeError: scopedRetry ? null : scopeError,
    impact,
    effectiveDate: prepayPlan.effectiveDate,
    effectiveOn: prepayPlan.keepThrough || today,
    prepay: term ? {
      termId: term.id,
      planLabel: term.plan_label || null,
      termStart: dateOnly(term.term_start),
      termEnd: dateOnly(term.term_end),
      prepaidAmount: term.prepay_amount == null ? null : Number(term.prepay_amount),
      includedVisits: term.coverage_visit_count == null ? null : Number(term.coverage_visit_count),
      disposition: prepayPlan.prepayDisposition,
      refund,
    } : null,
    waiveLateFee: input.waiveLateFee,
    visitFees,
    sendConfirmation: input.sendConfirmation,
    confirmationChannels: { sms: !!customer.phone, email: !!customer.email },
    reasonCode: input.reasonCode,
    reasonCodes: [...REASON_CODE_VALUES],
    note: input.note,
  };
}

async function raisePrepayRefundTask({ customer, request, term, refund, actorLabel }) {
  const NotificationService = require('./notification-service');
  const amountLine = refund && !refund.needsManualCalc
    ? `Refund $${refund.amount.toFixed(2)} to the original payment method (prepaid $${refund.prepaidAmount.toFixed(2)} ÷ ${refund.includedVisits} included visits × ${refund.remainingVisits} remaining).`
    : `Refund the unused annual-prepay value to the original payment method — the amount needs a manual calculation (${(refund && refund.reason) || 'coverage_visit_count_missing'}).`;
  const result = await NotificationService.notifyAdmin(
    'billing',
    'Refund unused annual prepay after cancellation',
    `${amountLine} Term ${term.plan_label || term.id} (${dateOnly(term.term_start)} to ${dateOnly(term.term_end)}) was ended now by ${actorLabel}. Nothing has been refunded automatically.`,
    {
      // Office TASK, never an FYI — must survive the bell policy allowlist.
      // Deduped by TERM, not by request: a retry after a lost case write
      // opens a new request, and a request-keyed task would hand staff two
      // independently actionable refund instructions for the same term
      // (double-refund risk). One term ends now exactly once; a deduped
      // result (the prior task stands) counts as persisted.
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
      dedupeKey: `prepay_refund:term:${term.id}`,
      metadata: {
        kind: 'annual_prepay_refund',
        customerId: customer.id,
        requestId: request.id,
        termId: term.id,
        refund,
      },
    }
  );
  if (!result || result.suppressed || !result.id) throw new Error('refund office task did not persist');
}

async function commitCancelPlan({ customerId, actor = null, ...raw } = {}) {
  if (!CancellationResolution.cancelFlowV2Enabled()) {
    throw new CancelPlanError(404, 'cancel_flow_v2_off', 'Cancel flow V2 is not enabled');
  }
  if (!customerId) throw new CancelPlanError(400, 'customer_id_required', 'customerId is required');
  const release = await acquireCancelCommitLock(customerId);
  try {
    return await commitCancelPlanLocked({ customerId, actor, ...raw });
  } finally {
    await release();
  }
}

async function commitCancelPlanLocked({ customerId, actor = null, ...raw } = {}) {
  const input = normalizeInput(raw);
  const actorType = actor && actor.type === 'ib' ? 'ib' : 'admin';
  const actorUserId = actor && actor.userId ? String(actor.userId) : null;
  const actorLabel = `${actorType === 'ib' ? 'Intelligence Bar' : 'Admin'}${actorUserId ? ` (user ${actorUserId})` : ''}`;

  const customer = await loadCustomer(customerId);

  // Scoped feasibility BEFORE the request row exists (fail closed).
  const { wholeAccount, scope, scopeError } = await resolveScope(customerId, input.families);
  const subject = wholeAccount ? `Cancel plan (${actorLabel})` : `Cancel ${scope.map(familyLabelOf).join(', ')} (${actorLabel})`;
  // The still-open acceptance from a recent attempt for the SAME customer +
  // scope set (actor- and order-independent) — reused by retries so the
  // processor's repair pass can find the first attempt's rows, and honored
  // by the eligibility gate below.
  const findOpenAcceptance = async () => {
    try {
      return await findCancelAcceptance(customerId, wholeAccount, scope, 'new');
    } catch (reuseErr) {
      // Unverified is NOT "none": proceeding without proof either strands a
      // prior partial run's repairs (nothing_to_cancel skips its failed
      // side effects forever) or opens a SECOND request whose
      // request-keyed dedupe double-bells the office. Fail closed,
      // retryable — nothing has been written yet.
      logger.error(`[admin-cancellation] open-acceptance lookup failed for ${customerId}: ${reuseErr.message}`);
      throw new CancelPlanError(503, 'acceptance_check_unavailable',
        'Could not verify whether an unfinished cancellation already exists for this customer — nothing was changed. Try again shortly.');
    }
  };
  const openAcceptance = await findOpenAcceptance();
  // Deposit-stage accounts belong to the dedicated signup-cancel flow; an
  // open acceptance means a generic cancel already partially ran — finish
  // its repairs instead of stranding them.
  if (!openAcceptance) await refuseDepositStageAccount(customerId);
  if (scopeError) {
    // A scoped retry whose first run already pulled every selected visit no
    // longer OWNS those families — refusing scope_not_owned here would
    // strand the first attempt's failed per-visit side effects forever. An
    // open acceptance for the same scoped subject is the proof this is a
    // retry: proceed, and the processor itself verifies the prior-cancelled
    // rows (repair-only mode) and still refuses a genuinely un-owned scope.
    // Every OTHER scope refusal (covered prepaid visits, unattributable
    // ledger) stands regardless.
    const retryAcceptance = scopeError === 'scope_not_owned' ? openAcceptance : null;
    if (!retryAcceptance) throw scopeErrorToHttp(scopeError);
    logger.info(`[admin-cancellation] scoped repair retry for ${customerId} — open acceptance ${retryAcceptance.id} overrides scope_not_owned`);
  }
  if (!(await hasCancellableWork(customerId))) {
    // A prior partial run may have already wound the account down and then
    // lost a follow-up step (case write, refund task, confirmation) —
    // nothing cancellable is left, but the retry must still reach the
    // idempotent processor repair pass and the durable records. A recent
    // open acceptance is that proof; without one this really is an account
    // with nothing to cancel.
    if (!openAcceptance) {
      // A CLEAN run resolved its acceptance — a lost-response retry must
      // still answer with the recorded outcome, never nothing_to_cancel
      // (the operator cannot tell a completed cancel from an empty
      // account). Keyed on the same subject/actor/24h window, and only the
      // recorded case echoes — nothing re-runs; a genuine post-win-back
      // cancel has cancellable work and never reaches this branch.
      try {
        const resolved = await findCancelAcceptance(customerId, wholeAccount, scope, 'resolved');
        const priorCase = resolved ? await db('cancellation_cases')
          .where({ service_request_id: resolved.id })
          .orderBy('created_at', 'desc')
          .first('id', 'status', 'snapshot') : null;
        if (priorCase) {
          const snap = typeof priorCase.snapshot === 'string' ? JSON.parse(priorCase.snapshot) : (priorCase.snapshot || {});
          const outcome = snap.outcome || null;
          logger.info(`[admin-cancellation] retry after a resolved clean run for ${customerId} — echoing case ${priorCase.id}`);
          return {
            requestId: resolved.id,
            caseId: priorCase.id,
            duplicate: true,
            processed: priorCase.status !== 'open',
            visitsPulled: outcome ? Number(outcome.visitsPulled) || 0 : 0,
            scope: outcome && Array.isArray(outcome.scope) ? outcome.scope : [],
            remaining: [],
            tierBefore: outcome ? outcome.tierBefore ?? null : null,
            tierAfter: outcome ? outcome.tierAfter ?? null : null,
            effectiveDate: snap.effectiveOn || etDateString(),
            keptThrough: snap.effectiveDate === 'end_of_coverage' ? snap.effectiveOn || null : null,
            lateFeeWaived: outcome ? outcome.lateFeeWaived === true : false,
            prepayDisposition: snap.prepayDisposition || null,
            prepayTermOutcome: snap.prepayTermOutcome || null,
            ...(snap.refund ? { refund: snap.refund } : {}),
            confirmation: outcome ? outcome.confirmation ?? null : null,
            confirmationChannels: outcome && Array.isArray(outcome.confirmationChannels) ? outcome.confirmationChannels : [],
            confirmationRequested: outcome ? outcome.confirmationRequested === true : false,
            errors: outcome && Array.isArray(outcome.errors) ? outcome.errors : [],
          };
        }
      } catch (echoErr) {
        logger.warn(`[admin-cancellation] resolved-acceptance echo failed for ${customerId}: ${echoErr.message}`);
      }
      throw new CancelPlanError(400, 'nothing_to_cancel',
        'There is no active plan, recurring service, or upcoming visit on this account to cancel.');
    }
    logger.info(`[admin-cancellation] no cancellable work for ${customerId} but an open acceptance exists — proceeding as a repair retry`);
  }

  const term = await resolveLiveTerm(customerId, wholeAccount);
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;
  // The LIVE term's covered visit ids — resolved BEFORE any write; an
  // unresolvable set refuses the commit (liveCoveredKeepIds throws 409).
  const keepVisitIds = prepayPlan.keepThrough ? await liveCoveredKeepIds(term, customerId) : null;

  const suppliedFingerprint = raw.previewFingerprint == null || raw.previewFingerprint === ''
    ? null : String(raw.previewFingerprint);
  // The live approved-facts view (impact + fee exposure + fingerprint) —
  // shared by the pre-write preview_changed check and the duplicate latch's
  // refund-task repair, which must never mint a task from numbers nobody
  // approved.
  const liveApprovedFacts = async () => {
    const liveImpact = await buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough, keepVisitIds });
    const liveVisitFees = await previewVisitFees(liveImpact ? liveImpact.pulledVisitKeys : null);
    return {
      liveImpact,
      fingerprint: cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact: liveImpact, visitFees: liveVisitFees, scope, wholeAccount }),
    };
  };

  // Idempotency latch: an end-of-coverage cancel leaves the account with
  // cancellable work (the kept covered visits), so a retry or double-click
  // sails past the eligibility gate. The durable proof a prior run finished
  // is the term's decided-'cancel' state PLUS its recorded case FOR THE SAME
  // DISPOSITION — an earlier end_at_term case must not swallow a new
  // end_now_refund request (which still has paid visits to pull and a refund
  // to record). Reuse a matching outcome; never open a second request, run
  // the processor again, or text the customer twice for the same cancel.
  if (term && term.renewal_decision === 'cancel') {
    let prior = null;
    let priorSnap = null;
    let priorEndNow = false;
    try {
      const recent = await db('cancellation_cases')
        .where({ customer_id: customerId })
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('id', 'service_request_id', 'status', 'snapshot');
      prior = (recent || []).find((c) => {
        const snap = typeof c.snapshot === 'string' ? JSON.parse(c.snapshot) : (c.snapshot || {});
        if (String(snap.prepayTermId || '') === String(term.id)
          && String(snap.prepayDisposition || '') === 'end_now_refund') priorEndNow = true;
        const match = String(snap.prepayTermId || '') === String(term.id)
          && String(snap.prepayDisposition || '') === String(prepayPlan.prepayDisposition || '');
        if (match) priorSnap = snap;
        return match;
      }) || null;
      // The echo is only for RETRIES of that run — proven by its acceptance
      // being still open, or resolved within the echo window (codex r16
      // P0). A historical case whose acceptance closed long ago must not
      // swallow a NEW cancellation: a re-won-back account with the same
      // decided term still current would read "cancelled" while billing
      // stays live. No provable tie → fall through and process fresh (the
      // decided term reads 'decision_already_recorded'; the refund recounts
      // from the live rows).
      if (prior) {
        let tied = false;
        try {
          const priorReq = prior.service_request_id
            ? await db('service_requests').where({ id: prior.service_request_id }).first('id', 'status', 'created_at')
            : null;
          tied = !!priorReq && (priorReq.status === 'new'
            || (priorReq.status === 'resolved'
              && new Date(priorReq.created_at).getTime() >= Date.now() - 24 * 60 * 60 * 1000));
        } catch (tieErr) {
          logger.warn(`[admin-cancellation] latch acceptance check failed for case ${prior.id}: ${tieErr.message}`);
        }
        if (!tied) {
          logger.info(`[admin-cancellation] case ${prior.id} has no live acceptance — treating this as a NEW cancellation, not a retry`);
          prior = null;
          priorSnap = null;
        }
      }
    } catch (dupErr) {
      logger.warn(`[admin-cancellation] duplicate-case lookup failed for ${customerId}: ${dupErr.message}`);
    }
    // The destructive inverse is REFUSED: after end_now_refund the paid
    // visits are pulled and the refund is in flight, so a later
    // end_at_term commit would re-run the engine and tell the customer
    // those visits remain through the term end. (The intentional
    // end_at_term → end_now_refund transition stays allowed — it still has
    // kept visits to pull and a refund to record.)
    if (!prior && priorEndNow && prepayPlan.prepayDisposition === 'end_at_term') {
      throw new CancelPlanError(409, 'prepay_term_already_ended',
        'This term was already ended now with a recorded refund — its paid visits were pulled and the refund is in flight. End of paid coverage no longer applies; review the refund task instead.');
    }
    if (prior) {
      logger.info(`[admin-cancellation] duplicate cancel for customer ${customerId} matched case ${prior.id} — returning the recorded outcome`);
      // Repair a lost refund task before answering the retry: a prior
      // end_now_refund run whose term decision landed but whose office task
      // did not persist recorded refund: null — echoing that outcome as
      // clean would leave the unused-value refund without its actionable
      // billing task forever (this latch is the only path a retry reaches).
      // The task is deduped by TERM, so raising it here is idempotent when
      // it actually exists; `refund` is computed above from the now-terminal
      // covered rows, so the recorded amount is the post-sweep truth.
      let repairedRefund = priorSnap && priorSnap.refund ? priorSnap.refund : null;
      let refundRepairedNow = false;
      const repairErrors = [];
      if (prepayPlan.prepayDisposition === 'end_now_refund' && !repairedRefund) {
        // The repaired task must carry facts somebody APPROVED (codex r8
        // P1): this latch answers before any fingerprint check, so a
        // coverage / term / payment-refund change between attempts could
        // otherwise mint an actionable billing task for numbers nobody saw.
        // Approved = the live recount still matches the FIRST run's recorded
        // proposal, OR the caller carries a fingerprint matching the live
        // facts (the operator just re-approved them from a fresh preview).
        // Neither → refund_facts_changed; a fresh preview → commit is the
        // approval path.
        const proposed = priorSnap && priorSnap.proposedRefund ? priorSnap.proposedRefund : null;
        let approved = !!proposed && !!refund
          && proposed.needsManualCalc === refund.needsManualCalc
          && proposed.amount === refund.amount
          && proposed.prepaidAmount === refund.prepaidAmount
          && proposed.includedVisits === refund.includedVisits
          && proposed.remainingVisits === refund.remainingVisits;
        if (!approved && suppliedFingerprint) {
          try {
            approved = (await liveApprovedFacts()).fingerprint === suppliedFingerprint;
          } catch (factsErr) {
            logger.warn(`[admin-cancellation] live-facts check failed during repair for case ${prior.id}: ${factsErr.message}`);
          }
        }
        if (!approved) {
          repairErrors.push('refund_facts_changed');
          logger.error(`[admin-cancellation] refund repair for case ${prior.id} refused — the live refund matches neither the recorded proposal nor an approved preview`);
        } else try {
          await raisePrepayRefundTask({
            customer, request: { id: prior.service_request_id }, term, refund, actorLabel,
          });
          repairedRefund = refund;
          refundRepairedNow = true;
          try {
            const snap = { ...priorSnap, refund };
            delete snap.proposedRefund;
            await db('cancellation_cases').where({ id: prior.id })
              .update({ snapshot: JSON.stringify(snap), updated_at: new Date() });
          } catch (snapErr) {
            // Task persisted (term-deduped) — a lost snapshot stamp only
            // means the next retry re-raises into the dedupe.
            logger.warn(`[admin-cancellation] refund repair stamp failed for case ${prior.id}: ${snapErr.message}`);
          }
        } catch (repairErr) {
          repairErrors.push('prepay_refund_task_missing');
          logger.error(`[admin-cancellation] refund task repair failed for case ${prior.id}: ${repairErr.message}`);
        }
      }
      // Failed follow-ups REPAIR on retry, stamp-first (codex r14/r15 P2):
      // a prior run whose SMS/email did not accept — or whose refund task
      // was just repaired above — must not echo its stale partial outcome
      // forever. The send-once probes (audit-log for SMS, class-keyed email
      // idempotency) make re-sends safe: only what is missing goes out. The
      // case outcome is STAMPED BEFORE any in-memory state clears or the
      // acceptance closes — a lost stamp leaves everything retryable.
      const outcome = priorSnap && priorSnap.outcome ? priorSnap.outcome : null;
      const isConfirmErr = (e) => String(e).startsWith('confirmation_');
      if (outcome && (refundRepairedNow
        || (Array.isArray(outcome.errors) && outcome.errors.some(isConfirmErr)))) {
        try {
          const reqRow = prior.service_request_id
            ? await db('service_requests').where({ id: prior.service_request_id }).first('id', 'status', 'created_at')
            : null;
          if (reqRow && reqRow.status === 'new') {
            // A freshly repaired refund task answers the stale disposition
            // error the lost task recorded.
            const promotedErrors = (outcome.errors || []).filter((e) => !(refundRepairedNow
              && (e === 'prepay_term_disposition' || e === 'prepay_refund_task')));
            let channels = Array.isArray(outcome.confirmationChannels) ? outcome.confirmationChannels : [];
            let errorsNext = promotedErrors;
            if (outcome.confirmationRequested === true
              && (promotedErrors.some(isConfirmErr) || refundRepairedNow)) {
              // The verdict the copy carries: clean once only channel
              // failures remain — a refund repair promotes the manual
              // "closing out by hand" run to its completed confirmation.
              const verdictClean = prior.status !== 'open' && promotedErrors.every(isConfirmErr);
              const resend = await sendCancellationConfirmations({
                customer,
                request: reqRow,
                result: {
                  scope: Array.isArray(outcome.scope) ? outcome.scope : [],
                  remaining: [],
                  tierAfter: outcome.tierAfter ?? null,
                  lateFeeWaived: outcome.lateFeeWaived === true,
                },
                processed: verdictClean,
                effectiveAt: priorSnap.effectiveDate === 'end_of_coverage' && priorSnap.effectiveOn
                  ? `${priorSnap.effectiveOn}T12:00:00-04:00` : null,
                keptThrough: priorSnap.effectiveDate === 'end_of_coverage',
                entryPoint: 'admin_cancel_plan',
                identityTrustLevel: 'admin_operator',
              });
              const stillFailed = [];
              if (customer.phone && !resend.smsSent) stillFailed.push('confirmation_sms_not_sent');
              if (customer.email && !resend.emailSent) stillFailed.push('confirmation_email_not_sent');
              channels = [...new Set([...channels, ...resend.channels])];
              errorsNext = [...promotedErrors.filter((e) => !isConfirmErr(e)), ...stillFailed];
            }
            const nextOutcome = {
              ...outcome,
              confirmationChannels: channels,
              confirmation: channels.includes('sms') ? 'sms' : (channels.includes('email') ? 'email' : null),
              errors: errorsNext,
            };
            await db('cancellation_cases').where({ id: prior.id })
              .update({
                snapshot: JSON.stringify({
                  ...priorSnap,
                  ...(repairedRefund ? { refund: repairedRefund, proposedRefund: undefined } : {}),
                  outcome: nextOutcome,
                }),
                updated_at: new Date(),
              });
            Object.assign(outcome, nextOutcome);
            if (!outcome.errors.length && !repairErrors.length) {
              try {
                const closed = await db('service_requests').where({ id: reqRow.id, status: 'new' })
                  .update({ status: 'resolved', updated_at: new Date() });
                if (!closed) {
                  // Same affected-row check as the commit path: a zero-row
                  // close with the row still 'new' is a LOST close, not a
                  // benign race — a stale 'new' acceptance hands the next
                  // cancellation this request and its dedupe state.
                  const live = await db('service_requests').where({ id: reqRow.id }).first('status');
                  if (!live || live.status === 'new') throw new Error('acceptance close updated zero rows');
                }
              } catch (closeErr) {
                // Leaves 'new' — surfaced on the echo so the response never
                // claims a clean resolution for a still-reusable request;
                // the next retry re-lands here, the resends dedupe, and the
                // close is re-attempted.
                outcome.errors = [...(outcome.errors || []), 'acceptance_close_failed'];
                logger.warn(`[admin-cancellation] acceptance close after repair failed for request ${reqRow.id}: ${closeErr.message}`);
              }
            }
          }
        } catch (repairFlowErr) {
          // Nothing was cleared in memory before the stamp — the response
          // echoes the original errors and a later retry repairs again.
          logger.warn(`[admin-cancellation] follow-up repair failed for case ${prior.id}: ${repairFlowErr.message}`);
        }
      }
      return {
        requestId: prior.service_request_id || null,
        caseId: prior.id,
        duplicate: true,
        processed: prior.status !== 'open',
        visitsPulled: outcome ? Number(outcome.visitsPulled) || 0 : 0,
        scope: outcome && Array.isArray(outcome.scope) ? outcome.scope : [],
        remaining: [],
        tierBefore: outcome ? outcome.tierBefore ?? null : null,
        tierAfter: outcome ? outcome.tierAfter ?? null : null,
        effectiveDate: prepayPlan.keepThrough || etDateString(),
        keptThrough: prepayPlan.keepThrough,
        lateFeeWaived: outcome ? outcome.lateFeeWaived === true : false,
        prepayDisposition: prepayPlan.prepayDisposition,
        prepayTermOutcome: 'decision_already_recorded',
        confirmation: outcome ? outcome.confirmation ?? null : null,
        confirmationChannels: outcome && Array.isArray(outcome.confirmationChannels) ? outcome.confirmationChannels : [],
        confirmationRequested: outcome ? outcome.confirmationRequested === true : false,
        ...(repairedRefund ? { refund: repairedRefund } : {}),
        // The FIRST run's follow-up failures ride along — a lost-response
        // retry must not show "Done" for a run that belled the office.
        errors: [...(outcome && Array.isArray(outcome.errors) ? outcome.errors : []), ...repairErrors],
      };
    }
  }

  // Approved-facts check (409 preview_changed): when the caller carries the
  // preview's fingerprint, the live facts must still match what the operator
  // saw — a visit that completed/appeared, an edited term, or a changed fee
  // exposure changes what pressing Confirm does, and it must not silently
  // commit different numbers. Checked before any write.
  let approvedPulled = null;
  let approvedPulledIds = null;
  // The approval boundary is MANDATORY for new destructive commits: both
  // first-party surfaces always carry the preview's fingerprint, so a
  // commit without one is a stale or hand-built call bypassing the facts
  // the operator approves. The one exception is a repair retry of an open
  // acceptance — its original approved facts are durable on the request,
  // and the run is idempotent repairs.
  if (!suppliedFingerprint && !openAcceptance) {
    throw new CancelPlanError(400, 'preview_fingerprint_required',
      'This commit must carry the previewFingerprint from a current preview — re-open the preview and confirm from it.');
  }
  if (suppliedFingerprint) {
    const { liveImpact, fingerprint } = await liveApprovedFacts();
    if (fingerprint !== suppliedFingerprint) {
      throw new CancelPlanError(409, 'preview_changed',
        'The cancellation facts changed since this preview (a visit completed or appeared, or the prepay term was edited). Re-open the preview and approve the current numbers.');
    }
    if (liveImpact && Array.isArray(liveImpact.pulledVisitKeys)) {
      approvedPulled = liveImpact.pulledVisitKeys.length;
      approvedPulledIds = new Set(liveImpact.pulledVisitKeys.map((k) => String(k).split(':')[0]));
    }
  }

  let caseSnapshot = null;
  try {
    caseSnapshot = await db('customers').where({ id: customerId })
      .first('waveguard_tier', 'monthly_rate', 'billing_mode', 'pipeline_stage');
  } catch (snapErr) {
    logger.warn(`[admin-cancellation] case snapshot failed for ${customerId}: ${snapErr.message}`);
  }

  // Durable acceptance — cases and retries key on this id like the portal path.
  // A retry after a PARTIAL run must land on the SAME accepted request: a
  // note-less cancel's recorded reason embeds the request id, and the
  // processor's repair pass finds the first attempt's cancelled rows by that
  // exact note — a fresh request would skip their failed side effects
  // forever (and per-request dedupe keys would double-bell).
  let request = openAcceptance;
  let priorOutcome = null;
  if (request) {
    logger.info(`[admin-cancellation] retry reuses accepted request ${request.id} for customer ${customerId} by ${actorLabel}`);
    // The FIRST attempt's recorded facts: its accepted waiver is STICKY on
    // repairs (a retry from the dialog's default unchecked state must not
    // push already-waived rows through the ordinary charge path), and its
    // outcome merges into this run's record so the case never regresses to
    // "0 visits pulled" repair facts.
    // The DURABLE waiver lives on the request's own metadata (written at
    // acceptance, before anything could fail); the case snapshot is only a
    // fallback — a run that lost BOTH a fee side effect and its case write
    // must still restore the waiver the operator accepted.
    const requestMeta = requestCancelPlanMeta(request);
    if (requestMeta && requestMeta.waiveLateFee === true && !input.waiveLateFee) {
      input.waiveLateFee = true;
      logger.info(`[admin-cancellation] retry inherits the accepted fee waiver from request ${request.id}`);
    }
    // The accepted NO-communication choice is inherited the same way — a
    // fresh dialog defaults the checkbox on, and a repair retry must not
    // text a customer the original operator explicitly silenced.
    if (requestMeta && requestMeta.sendConfirmation === false && input.sendConfirmation) {
      input.sendConfirmation = false;
      logger.info(`[admin-cancellation] retry inherits the no-confirmation choice from request ${request.id}`);
    }
    try {
      const priorCase = await db('cancellation_cases')
        .where({ service_request_id: request.id })
        .orderBy('created_at', 'desc')
        .first('snapshot');
      const snap = priorCase
        ? (typeof priorCase.snapshot === 'string' ? JSON.parse(priorCase.snapshot) : (priorCase.snapshot || {}))
        : null;
      priorOutcome = snap && snap.outcome ? snap.outcome : null;
      if (snap && snap.waiveLateFee === true && !input.waiveLateFee) {
        input.waiveLateFee = true;
        logger.info(`[admin-cancellation] retry inherits the accepted fee waiver from request ${request.id} (case snapshot)`);
      }
    } catch (priorErr) {
      logger.warn(`[admin-cancellation] prior-case load failed for request ${request.id}: ${priorErr.message}`);
    }
    // A retry that ADDS the waiver ratchets it onto the durable record so a
    // later retry keeps it even if this run's case write fails.
    if (input.waiveLateFee && (!requestMeta || requestMeta.waiveLateFee !== true)) {
      try {
        await db('service_requests').where({ id: request.id }).update({
          metadata: JSON.stringify({ cancel_plan: { ...(requestMeta || { scope: wholeAccount ? [] : [...scope].sort() }), waiveLateFee: true } }),
          updated_at: new Date(),
        });
      } catch (metaErr) {
        logger.warn(`[admin-cancellation] waiver ratchet failed for request ${request.id}: ${metaErr.message}`);
      }
    }
  } else {
    [request] = await db('service_requests')
      .insert({
        customer_id: customerId,
        category: 'cancellation',
        subject,
        description: input.note || '',
        urgency: 'routine',
        location_on_property: null,
        photos: JSON.stringify([]),
        status: 'new',
        source: 'admin',
        // Durable retry state, written BEFORE any processing: the canonical
        // scope set keys acceptance matching, and the accepted waiver must
        // survive a lost case write (it is money the operator promised).
        metadata: JSON.stringify({
          cancel_plan: {
            scope: wholeAccount ? [] : [...scope].sort(),
            waiveLateFee: input.waiveLateFee,
            // The accepted communication choice: a repair retry must not
            // text a customer the original operator explicitly chose not
            // to contact.
            sendConfirmation: input.sendConfirmation,
          },
        }),
      })
      .returning('*');
    logger.info(`[admin-cancellation] request ${request.id} opened for customer ${customerId} by ${actorLabel}`);
  }

  // NOTHING between the acceptance and the billing wind-down.
  const errors = [];
  let result = null;
  try {
    const reasonParts = [input.reasonCode, input.note].filter(Boolean);
    result = await processCancellationRequest({
      customerId,
      // The recorded reason feeds customers.churn_reason_detail and the AI
      // churn classification — boilerplate here misclassifies every
      // admin-driven churn (the Pareto reads the customer columns).
      reason: reasonParts.length ? reasonParts.join(' — ') : `Admin cancellation request ${request.id}`,
      // Immutable retry marker: repairs match on THIS, never on the
      // operator's editable reason/note — a retry with a reworded note must
      // still find the first attempt's cancelled rows.
      historyNote: `Admin cancellation request ${request.id}`,
      requestId: request.id,
      families: wholeAccount ? [] : scope,
      actor: { type: actorType, userId: actorUserId },
      keepThrough: prepayPlan.keepThrough,
      keepVisitIds,
      waiveLateFee: input.waiveLateFee,
    });
  } catch (err) {
    logger.error(`[admin-cancellation] processor threw for request ${request.id}: ${err.message}`);
    errors.push('processor_threw');
  }
  const processed = !!(result && result.ok && (result.churned || result.scopedWoundDown));
  if (result && Array.isArray(result.errors)) errors.push(...result.errors);
  // Approved-facts reconcile after the sweep (codex r8 P2, r10 P2): the
  // recurrence stop's straggler re-sweep can catch an occurrence minted
  // after the fingerprint check — correctly cancelled (its series is
  // ending), but a visit the operator never saw. IDENTITIES, not counts: a
  // completed-approved-visit + minted-occurrence swap keeps the count equal
  // while pulling a different appointment. Any pull outside the approved
  // set is an exception for office eyes, not a clean "Done."
  if (processed && approvedPulled != null) {
    // SET EQUALITY, both directions: an unapproved pull (minted occurrence)
    // AND a missing approved pull (the visit completed mid-run and was
    // delivered — now payable, not cancelled as shown) are both changed
    // facts the operator never approved.
    let beyond;
    if (approvedPulledIds && Array.isArray(result?.cancelledIds)) {
      const cancelledSet = new Set(result.cancelledIds.map(String));
      beyond = result.cancelledIds.some((id) => !approvedPulledIds.has(String(id)))
        || [...approvedPulledIds].some((id) => !cancelledSet.has(id));
    } else {
      beyond = Number(result?.cancelledCount) > approvedPulled;
    }
    if (beyond) {
      errors.push('visits_pulled_beyond_preview');
      logger.warn(`[admin-cancellation] request ${request.id} pulled a different visit set than the approved preview (${result?.cancelledCount} pulled vs ${approvedPulled} approved)`);
    }
  }

  // Annual-prepay term disposition (whole-account only) — GATED on a
  // successful wind-down: deciding the term (or raising the refund task)
  // after a failed processor run would suppress renewal / promise money on
  // an account that did NOT cancel. A failed run bells the office below and
  // the operator retries; the retry re-runs processor-then-disposition in
  // the documented order.
  let termOutcome = null;
  // The refund is a RECORDED money fact only after the cancel decision is
  // verified AND the office task persisted — a conflicting renew decision
  // (or a lost task) must not put "Refund recorded" on the case, the
  // response, or the IB card for a term that stands.
  let refundRecorded = false;
  // What actually gets recorded: the pre-commit snapshot until the sweep
  // runs, then the post-sweep recount (see the end_now_refund branch).
  let refundFacts = refund;
  if (term && prepayPlan.prepayDisposition && !processed) {
    termOutcome = 'skipped_processor_failed';
    errors.push('prepay_term_disposition_skipped');
  }
  if (term && prepayPlan.prepayDisposition && processed) {
    try {
      if (prepayPlan.prepayDisposition === 'end_at_term') {
        const decision = await decideTermCancel(term, actorUserId,
          `Cancel plan (${actorLabel}) — coverage kept through ${dateOnly(term.term_end)}; no renewal.`);
        if (!decision.verified) {
          termOutcome = 'decision_conflict';
          errors.push('prepay_term_decision_conflict');
          logger.error(`[admin-cancellation] term ${term.id} carries a conflicting decision "${decision.conflictingDecision}" — cancel not recorded (request ${request.id})`);
        } else {
          termOutcome = decision.fresh ? 'ends_at_term' : 'decision_already_recorded';
        }
      } else {
        // end_now_refund: decide the term 'cancel' through the SAME move-8
        // guard the renewals module owns — this file must never write
        // annual_prepay_terms.status directly (the term state machine's
        // writer set is pinned by docs/annual-prepay-term-states.md and its
        // guard test). Coverage formally ends when the office issues the
        // recorded refund: the refund landing on the prepay invoice fires
        // move 9 (syncTermForRefundedPayment), which revokes coverage and
        // clears the prepaid stamps. Until then the decided term rides out
        // with no visits left — the processor pulled them above.
        const decision = await decideTermCancel(term, actorUserId,
          `Cancel plan (${actorLabel}) — ended now; unused-value refund recorded on the cancellation case.`);
        if (!decision.verified) {
          // A racing renew/switch_plan decision means the term is NOT
          // cancelled — recording a refund task for it would promise money
          // on a plan that stands. Fail the disposition; the bell below
          // hands it to the office.
          termOutcome = 'decision_conflict';
          errors.push('prepay_term_decision_conflict');
          logger.error(`[admin-cancellation] term ${term.id} carries a conflicting decision "${decision.conflictingDecision}" — refund NOT recorded (request ${request.id})`);
        } else {
          termOutcome = decision.fresh ? 'ended_now' : 'decision_already_recorded';
          // Post-sweep truth: the cancel lock serializes admin commits, not
          // technician completion — a covered visit can complete between the
          // pre-commit refund snapshot and the sweep reaching it (the sweep
          // skips the newly terminal row benignly and still returns ok), and
          // the stale remainingVisits would refund a slice the customer just
          // consumed. Every covered row is terminal after the sweep, so this
          // recount is stable; an unreadable recount degrades the task to
          // the manual-calculation wording, and a changed amount flags the
          // run for office review instead of silently recording numbers the
          // operator never approved.
          const recount = await computePrepayRefund({ ...term, customer_id: customerId });
          if (refund && !refund.needsManualCalc
            && (recount.needsManualCalc || recount.amount !== refund.amount)) {
            errors.push('refund_recomputed_after_sweep');
            logger.warn(`[admin-cancellation] refund recomputed after sweep for request ${request.id}: $${refund.amount} → ${recount.needsManualCalc ? 'manual' : `$${recount.amount}`}`);
          }
          refundFacts = recount;
          await raisePrepayRefundTask({ customer, request, term, refund: recount, actorLabel });
          refundRecorded = true;
        }
      }
    } catch (err) {
      errors.push('prepay_term_disposition');
      logger.error(`[admin-cancellation] prepay term disposition failed for request ${request.id}: ${err.message}`);
    }
  }

  // Deferred DATED termite retrieval (end-of-coverage): the processor holds
  // the dated task until the term decision stands — a conflicting renew
  // decision means the program continues, and staff must never hold an
  // instruction to pull Waves-owned stations on a date the plan no longer
  // ends. Skipped on a conflict/failed disposition: that run is already
  // partial (belled), and the repair retry re-runs the processor, which
  // re-derives the pending task from live rows.
  if (result && result.termiteRetrievalPending) {
    if (processed && (termOutcome === 'ends_at_term' || termOutcome === 'decision_already_recorded')) {
      try {
        const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
        await raiseTermiteRetrievalTask(customerId, request.id,
          { retrieveAfter: result.termiteRetrievalPending.retrieveAfter });
      } catch (termiteErr) {
        errors.push('termite_retrieval_task');
        logger.error(`[admin-cancellation] deferred termite retrieval task failed for request ${request.id}: ${termiteErr.message}`);
      }
    } else {
      logger.warn(`[admin-cancellation] dated termite retrieval NOT raised for request ${request.id} — term decision not confirmed (${termOutcome || 'no disposition'})`);
    }
  }

  // The durable case (after the wind-down, like the portal path).
  const caseSnapshotBody = {
    actor: { type: actorType, userId: actorUserId },
    effectiveDate: prepayPlan.effectiveDate,
    effectiveOn: prepayPlan.keepThrough || etDateString(),
    waiveLateFee: input.waiveLateFee,
    prepayDisposition: prepayPlan.prepayDisposition,
    prepayTermId: term ? term.id : null,
    prepayTermOutcome: termOutcome,
    // A recorded refund is one whose cancel decision verified AND whose
    // office task persisted; anything else stays PROPOSED-only metadata so
    // the case never claims money that was not promised.
    refund: refundRecorded ? refundFacts : null,
    ...(refundFacts && !refundRecorded ? { proposedRefund: refundFacts } : {}),
    sendConfirmation: input.sendConfirmation,
    tier_before: caseSnapshot ? caseSnapshot.waveguard_tier : null,
    monthly_rate_before: caseSnapshot ? caseSnapshot.monthly_rate : null,
    billing_mode: caseSnapshot ? caseSnapshot.billing_mode : null,
  };
  let caseRow = null;
  try {
    caseRow = await CancellationResolution.openCancellationCase({
      customerId,
      serviceRequestId: request.id,
      families: Array.isArray(result?.scope) && result.scope.length ? result.scope : (wholeAccount ? [] : scope),
      reasonCode: input.reasonCode,
      reasonText: input.note || null,
      resolution: null,
      resolutionOutcome: null,
      snapshot: caseSnapshotBody,
      processed,
    });
  } catch (caseErr) {
    errors.push('case_write');
    logger.warn(`[admin-cancellation] case write failed for request ${request.id}: ${caseErr.message}`);
  }

  // Confirmation verdict (codex C3 r2 P1): the customer hears "done" only
  // when the wind-down AND every durable follow-up landed. A lost term
  // decision, refund task, or case row means the office is still finishing
  // this by hand (the review bell below) — the end_at_term copy would even
  // claim "will not renew" with the decision unpersisted. Any accumulated
  // error downgrades to the manual-review wording; the API response keeps
  // the honest processor verdict + errors for the operator.
  const confirmationVerdict = processed && errors.length === 0;
  let confirmations = { smsSent: false, emailSent: false, channels: [] };
  if (input.sendConfirmation) {
    confirmations = await sendCancellationConfirmations({
      customer,
      request,
      result,
      processed: confirmationVerdict,
      effectiveAt: prepayPlan.keepThrough ? `${prepayPlan.keepThrough}T12:00:00-04:00` : request.created_at,
      // End-of-coverage keeps paid visits on the calendar — the generic
      // "upcoming visits are off the calendar" copy would be false, so the
      // senders switch to the end-of-term wording.
      keptThrough: !!prepayPlan.keepThrough,
      entryPoint: 'admin_cancel_plan',
      identityTrustLevel: 'admin_operator',
    });
    // A requested confirmation a REACHABLE channel did not accept is a
    // follow-up failure like a lost case write: without it the dialog says
    // "Done." with the customer untold, no bell rings, and a retry answers
    // from the recorded outcome. The channel errors ride the review-bell
    // rail below (the confirmation verdict itself was already decided —
    // the copy that DID go out stays truthful).
    if (customer.phone && !confirmations.smsSent) errors.push('confirmation_sms_not_sent');
    if (customer.email && !confirmations.emailSent) errors.push('confirmation_email_not_sent');
  }

  // Record the run's outcome on the case (best-effort): a later duplicate
  // retry answers from these facts — what was pulled and what the customer
  // was actually sent — instead of reporting "nothing sent" for a run whose
  // response was lost (codex C3 r3 P2). A lost write here only degrades a
  // future duplicate's reporting; the run itself already happened.
  if (caseRow) {
    try {
      await db('cancellation_cases').where({ id: caseRow.id }).update({
        snapshot: JSON.stringify({
          ...caseSnapshotBody,
          // MERGED with the first attempt's outcome on repair retries: a
          // retry re-flips nothing (repairs don't count) and a scoped
          // repair-only run has no plan, so its bare facts would rewrite
          // "3 visits pulled, Silver → Bronze" into "0 pulled" — the case
          // and lost-response echoes must keep what actually happened.
          outcome: {
            visitsPulled: (priorOutcome ? Number(priorOutcome.visitsPulled) || 0 : 0)
              + (result ? Number(result.cancelledCount) || 0 : 0),
            scope: (Array.isArray(result?.scope) && result.scope.length)
              ? result.scope
              : (priorOutcome && Array.isArray(priorOutcome.scope) && priorOutcome.scope.length
                ? priorOutcome.scope : (wholeAccount ? [] : scope)),
            tierBefore: priorOutcome?.tierBefore ?? result?.tierBefore ?? (caseSnapshot ? caseSnapshot.waveguard_tier : null),
            tierAfter: result?.tierAfter ?? priorOutcome?.tierAfter ?? null,
            lateFeeWaived: (result ? result.lateFeeWaived === true : false) || priorOutcome?.lateFeeWaived === true,
            confirmationRequested: input.sendConfirmation || priorOutcome?.confirmationRequested === true,
            confirmation: (confirmations.smsSent ? 'sms' : (confirmations.emailSent ? 'email' : null))
              ?? priorOutcome?.confirmation ?? null,
            confirmationChannels: [...new Set([...(priorOutcome?.confirmationChannels || []), ...confirmations.channels])],
            // Follow-up failures ride the record: a lost-response retry must
            // answer with the run's real verdict, not a clean "Done."
            errors: [...errors],
          },
        }),
        updated_at: new Date(),
      });
    } catch (outcomeErr) {
      // A lost outcome stamp is NOT a clean run: closing the acceptance
      // below would hand a lost-response retry the resolved-acceptance echo
      // with NO snapshot.outcome — "0 visits, no confirmation" for a
      // destructive cancellation that happened. Ride the errors list so the
      // acceptance stays open (the retry's repair pass recomputes and
      // re-stamps the durable result) and the office is belled.
      errors.push('outcome_record_failed');
      logger.error(`[admin-cancellation] outcome record failed for case ${caseRow.id}: ${outcomeErr.message}`);
    }
  }

  // A CLEAN run closes its acceptance: findOpenAcceptance keys reuse on
  // status 'new', so leaving a finished request open would hand a SECOND
  // cancellation inside 24h (a win-back cancelled again) the prior run's
  // request id, its UNIQUE case, and its request-scoped dedupe state. A
  // partial/errored run stays 'new' — that is exactly the repairable
  // acceptance the retry path needs. Best-effort: a lost stamp only risks
  // an unnecessary reuse, never a lost cancel.
  if (processed && errors.length === 0) {
    try {
      const closed = await db('service_requests').where({ id: request.id })
        .update({ status: 'resolved', updated_at: new Date() });
      if (!closed) throw new Error('acceptance close updated zero rows');
    } catch (closeErr) {
      // A stale 'new' acceptance would hand the NEXT cancellation in 24h
      // this request/case and its dedupe keys — a lost close is a
      // follow-up failure (review bell below), never a silent clean run.
      errors.push('acceptance_close_failed');
      logger.error(`[admin-cancellation] acceptance close failed for request ${request.id}: ${closeErr.message}`);
    }
  }

  // Exception-based: a partial run OR any post-processor failure (refund
  // task, term disposition, case write) bells the office — a missing refund
  // task must never disappear into logs behind a green processor result.
  if (!processed || errors.length) {
    try {
      const NotificationService = require('./notification-service');
      const reviewAlert = await NotificationService.notifyAdmin(
        'service',
        `Cancel plan needs review for ${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        `${actorLabel} cancelled ${wholeAccount ? 'the whole plan' : scope.map(familyLabelOf).join(', ')}`
          + (processed
            ? ' — the plan wound down, but a follow-up step failed'
            : ' but auto-processing did not fully complete — review the calendar/account manually.')
          + (errors.length ? ` (failed: ${errors.join(', ')})` : ''),
        {
          bell: true,
          link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
          dedupeKey: `admin_cancel_review:${request.id}`,
          metadata: { requestId: request.id, customerId, processingErrors: errors },
        }
      );
      // notifyAdmin resolves NULL on failure (its documented contract) —
      // an awaited null would read as "alert raised" while the failures
      // live only in logs. Surface it so the response never claims the
      // office review alert has the details when no alert landed.
      if (!reviewAlert || (reviewAlert.suppressed && reviewAlert.reason)) {
        errors.push('review_alert_failed');
        logger.error(`[admin-cancellation] review alert did not persist for request ${request.id}${reviewAlert && reviewAlert.reason ? ` (${reviewAlert.reason})` : ''}`);
      }
    } catch (notifErr) {
      errors.push('review_alert_failed');
      logger.error(`[admin-cancellation] review alert failed for request ${request.id}: ${notifErr.message}`);
    }
  }

  try {
    const { recordAuditEvent } = require('./audit-log');
    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: actorUserId,
      action: 'customer.cancel_plan',
      resource_type: 'customer',
      resource_id: customerId,
      metadata: {
        via: actorType,
        request_id: request.id,
        scope: wholeAccount ? [] : scope,
        effective_date: prepayPlan.effectiveDate,
        keep_through: prepayPlan.keepThrough,
        waive_late_fee: input.waiveLateFee,
        prepay_disposition: prepayPlan.prepayDisposition,
        refund_amount: refundRecorded && refundFacts ? refundFacts.amount : null,
        send_confirmation: input.sendConfirmation,
        processed,
      },
      critical: true,
    });
  } catch (auditErr) {
    logger.warn(`[admin-cancellation] audit event failed for request ${request.id}: ${auditErr.message}`);
  }

  return {
    requestId: request.id,
    caseId: caseRow ? caseRow.id : null,
    processed,
    visitsPulled: result ? Number(result.cancelledCount) || 0 : 0,
    scope: Array.isArray(result?.scope) ? result.scope : (wholeAccount ? [] : scope),
    remaining: Array.isArray(result?.remaining) ? result.remaining : [],
    tierBefore: result?.tierBefore ?? (caseSnapshot ? caseSnapshot.waveguard_tier : null),
    tierAfter: result?.tierAfter ?? null,
    effectiveDate: prepayPlan.keepThrough || etDateString(),
    keptThrough: prepayPlan.keepThrough,
    // The processor's CONFIRMED waiver, never the raw request.
    lateFeeWaived: result ? result.lateFeeWaived === true : false,
    prepayDisposition: prepayPlan.prepayDisposition,
    prepayTermOutcome: termOutcome,
    ...(refundRecorded && refundFacts ? { refund: refundFacts } : {}),
    confirmation: confirmations.smsSent ? 'sms' : (confirmations.emailSent ? 'email' : null),
    confirmationChannels: confirmations.channels,
    confirmationRequested: input.sendConfirmation,
    errors,
  };
}

module.exports = {
  CancelPlanError,
  EFFECTIVE_DATES,
  PREPAY_DISPOSITIONS,
  previewCancelPlan,
  commitCancelPlan,
  computePrepayRefund,
  // Shared with the renew-decision route (admin-schedule): every writer of
  // a term's renewal decision serializes on this lock so a renew can never
  // land between the cancel's destructive wind-down and its term decision.
  acquireCancelCommitLock,
};
