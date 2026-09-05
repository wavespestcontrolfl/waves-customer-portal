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
// An UNPAID payment_pending term is invisible to coveredTermsAsOf, but its
// standalone prepay invoice stays payable through the public link — a
// payment landing AFTER the cancellation re-activates the term and
// refreshes/seeds coverage for the service just cancelled
// (syncTermForInvoicePayment). Refuse until the invoice is disposed of; the
// invoice tools own that void. Whole account (scope null): every pending
// term. Scoped: only a pending term whose coverage identity is one of the
// selected families — or whose identity cannot be read (fail closed).
async function findPendingPrepayInvoice(customerId, scope = null) {
  const pending = await db('annual_prepay_terms')
    .where({ customer_id: customerId, status: 'payment_pending' })
    .whereNotNull('prepay_invoice_id')
    .select('id', 'prepay_invoice_id', 'plan_label', 'coverage_service_type');
  if (!pending.length) return null;
  const { familyOfServiceRow } = require('./cancellation-processor');
  for (const p of pending) {
    if (Array.isArray(scope)) {
      const identityFamily = familyOfServiceRow({ service_type: p.coverage_service_type });
      if (identityFamily && !scope.includes(identityFamily)) continue;
    }
    const inv = await db('invoices').where({ id: p.prepay_invoice_id }).first('id', 'status', 'invoice_number');
    if (inv && String(inv.status) !== 'void') return { term: p, invoice: inv };
  }
  return null;
}

async function refusePendingPrepayInvoices(customerId, scope = null) {
  const hit = await findPendingPrepayInvoice(customerId, scope);
  if (!hit) return;
  const { term: p, invoice: inv } = hit;
  throw new CancelPlanError(409, 'pending_prepay_invoice',
    `An unpaid annual-prepay invoice (${inv.invoice_number || inv.id}${p.plan_label ? `, ${p.plan_label}` : ''}) is still payable and would re-activate coverage if paid after this cancellation. Void it from the invoice tools first.`);
}

async function resolveLiveTerm(customerId, wholeAccount) {
  if (!wholeAccount) return null;
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  await refusePendingPrepayInvoices(customerId);
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
    // The echo window starts when the run RESOLVED the acceptance (its
    // close stamps updated_at), not when it was accepted — an acceptance
    // repaired after more than a day open must still echo on the retry
    // that lost the repair's response (codex GH r33 P2).
    query = query.where('updated_at', '>=', new Date(Date.now() - 24 * 60 * 60 * 1000));
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
async function previewVisitFees(pulledVisitKeys, now = new Date()) {
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
      const hold = await CardHolds.cardHoldCancelPreview(id, now);
      if (hold.held) {
        fee = { id, lane: 'card_hold', feeApplies: hold.feeApplies === true, feeAmount: hold.feeAmount ?? null, unresolved: hold.unresolved === true };
      } else {
        const ApptCards = require('./appointment-card-request');
        const appt = await ApptCards.appointmentCardCancelPreview(id, now);
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
    // The displayed retrieval promise: a station added or removed between
    // preview and confirm changes whether staff get a pull task — a fact
    // the card disclosed, so it must trip preview_changed like every other.
    termiteRental: impact ? impact.termiteRental === true : null,
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
  // Integer-cents math (money): dividing the float dollar value can drift a
  // cent under the rounding boundary ($10.01 × 5 ÷ 10 lands just below
  // 500.5¢ and would record $5.00, not $5.01) — and this amount becomes an
  // actionable refund task and case record.
  const prepaidCents = Math.round(base.prepaidAmount * 100);
  const amount = Math.round((prepaidCents * remainingVisits) / base.includedVisits) / 100;
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
  const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id);
  // A SHORT covered set (fewer rows than coverage_visit_count — e.g. a
  // skipped visit whose replacement is not reseeded yet) must refuse: the
  // cancel decision flips the term's status, refreshTermSnapshot stops
  // seeding, and the customer silently loses part of the purchased
  // coverage. Completed rows count toward the set, so a healthy mid-term
  // account always passes.
  if (ids.length < Number.parseInt(term.coverage_visit_count, 10)) {
    throw new CancelPlanError(409, 'coverage_rows_incomplete',
      `The prepay term's covered visits are not fully on the calendar right now (${ids.length} of ${term.coverage_visit_count} — a skipped visit's replacement may still be reseeding). Nothing was cancelled — retry shortly, or cancel effective now with the refund.`);
  }
  return ids;
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
  // A pending, still-payable prepay invoice for a selected family is the
  // scoped twin of the whole-account refusal: the scoped cancel would pull
  // the family's visits and recurrence, and the payment landing later
  // would re-activate the term and reseed the service (codex GH r26 P1).
  await refusePendingPrepayInvoices(customerId, scope);
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
    // The term's COVERAGE IDENTITY conflicts even when no upcoming covered
    // row exists right now (all completed, or a replacement mid-reseed):
    // a scoped cancel of that family would stop the service with no term
    // decision recorded, and the renewal workflow could later renew or
    // charge a service the operator cancelled.
    const identityFamily = familyOfServiceRow({ service_type: t.coverage_service_type });
    if (identityFamily && scope.includes(identityFamily)) return true;
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
      ? await db('services').whereIn('id', serviceIds).select('id', 'service_key', 'name as service_name')
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
// The refund facts the operator approved, component by component: prepaid ÷
// included × remaining can produce the same dollars from different inputs.
function refundFactsMatch(a, b) {
  return !!a && !!b
    && a.needsManualCalc === b.needsManualCalc
    && a.amount === b.amount
    && a.prepaidAmount === b.prepaidAmount
    && a.includedVisits === b.includedVisits
    && a.remainingVisits === b.remainingVisits;
}

// Does an admin END-OF-COVERAGE decision currently govern this account?
// That commit churns the account while deliberately KEEPING its prepaid
// covered visits through the term boundary (keepThrough/keepVisitIds). The
// portal's replay paths (60s dedupe, inactive-account retry) re-run the
// processor for a PORTAL request with no boundary at all — the shared lock
// only serializes them, it does not reconcile a portal row parked behind
// (or created before) the admin run — so they ask here first and park
// instead of sweeping the retained paid visits. In force = an admin
// end_of_coverage acceptance that is still OPEN (in flight or repairing), or
// one accepted alongside the CURRENT churn transition (the acceptance row
// is written moments before the processor stamps pipeline_stage_changed_at;
// the same anchor plan-restart uses). A decision from before a win-back is
// history and does not block a later cancel.
async function adminCoverageBoundaryInForce(customerId) {
  const rows = await db('service_requests')
    .where({ customer_id: customerId, category: 'cancellation', source: 'admin' })
    .orderBy('created_at', 'desc')
    .limit(10)
    .select('id', 'status', 'created_at', 'metadata');
  const boundaries = (rows || []).filter((r) => {
    const cp = requestCancelPlanMeta(r);
    return !!cp && cp.effectiveDate === 'end_of_coverage';
  });
  if (!boundaries.length) return false;
  if (boundaries.some((r) => r.status === 'new')) return true;
  const customer = await db('customers').where({ id: customerId }).first('pipeline_stage', 'pipeline_stage_changed_at');
  if (!customer || customer.pipeline_stage !== 'churned') return false;
  const churnedAt = customer.pipeline_stage_changed_at ? new Date(customer.pipeline_stage_changed_at).getTime() : NaN;
  if (!Number.isFinite(churnedAt)) return true; // unanchored churn — fail safe, keep the paid visits
  return boundaries.some((r) => new Date(r.created_at).getTime() >= churnedAt - 60 * 60 * 1000);
}

// The dedupe identity for a decided prepaid term's end-of-coverage side
// effects (dated termite task, end-of-term confirmation): the TERM and the
// CHURN EPISODE — customers.churn_episode_id, minted by the processor on
// the first churn of an episode and cleared by every reactivation path
// that clears churned_at. The ordinary path takes the id the processor
// just returned and stamps it on the request (metadata.cancel_plan) and
// the case snapshot; a repair reads the REQUEST's own stamp, so an
// acceptance processed in an earlier episode keeps that episode's keys and
// one never processed under any episode (or opened before this shipped)
// has no stamp → no term key → request-keyed dedupe, exactly as before.
// The confirmation leg also carries the coverage BOUNDARY: an admin
// correcting term_end and repeating the cancel must re-tell the customer
// the new date, not dedupe against the old one (the dated task carries its
// date in its own key).
const termEpisodeOf = (term, episodeId, boundary) => (term && episodeId
  ? { termId: term.id, episodeKey: String(episodeId), boundary: dateOnly(boundary) || dateOnly(term.term_end) || null }
  : null);
const termEpisodeSendArgs = (episode) => ({
  prepayTermId: episode ? episode.termId : null,
  termEpisodeKey: episode ? `${episode.episodeKey}:${episode.boundary || 'no-boundary'}` : null,
});
const termEpisodeRaiseArgs = (episode) => (episode ? { termId: episode.termId, episodeKey: episode.episodeKey } : {});
// Durable retry state: the episode the processor churned this request
// under. Written BEFORE the term-keyed side effects so a repair after a
// lost response finds it. Returns whether the stamp stands; on a failed
// write the caller keys this run's side effects on the REQUEST instead
// (the identity its repair will also resolve to), so the pair can never
// double-fire — a term key this run alone knew would let the repair send
// again under the request key.
async function stampRequestEpisode(requestRow, episodeId) {
  const meta = requestCancelPlanMeta(requestRow) || {};
  if (String(meta.churnEpisodeId || '') === String(episodeId)) return true;
  const next = { ...meta, churnEpisodeId: String(episodeId) };
  try {
    await db('service_requests').where({ id: requestRow.id }).update({
      metadata: JSON.stringify({ cancel_plan: next }),
      updated_at: new Date(),
    });
    requestRow.metadata = JSON.stringify({ cancel_plan: next });
    return true;
  } catch (metaErr) {
    logger.warn(`[admin-cancellation] churn episode stamp failed for request ${requestRow.id}: ${metaErr.message}`);
    return false;
  }
}

// The request-scoped history note the processor stamps on every visit this
// request cancels — the immutable retry marker (never the editable reason).
const historyNoteFor = (requestId) => `Admin cancellation request ${requestId}`;

// Visit ids a prior attempt of this acceptance already cancelled: a repair
// retry re-runs the fee rails for them, so the preview and the approved-
// facts view price them alongside the live pull set. Unreadable = none
// (the fingerprint then simply excludes them; the processor's own
// load_prior_cancelled error surfaces a repair-set read failure).
async function repairVisitFeeKeys(customerId, acceptance) {
  if (!acceptance) return [];
  try {
    const { priorCancelledVisits } = require('./cancellation-processor');
    const rows = await priorCancelledVisits(customerId, historyNoteFor(acceptance.id));
    return rows.map((r) => String(r.id));
  } catch (err) {
    logger.warn(`[admin-cancellation] repair-visit fee lookup failed for request ${acceptance.id}: ${err.message}`);
    return [];
  }
}

// The instant the FIRST approval judged the fee windows at, persisted on
// the acceptance — every retry prices the same visits at that instant, so
// a visit that crossed its cutoff between attempts is never charged on a
// retry that the original approval showed fee-free.
function acceptedFeeEvaluationAt(acceptance) {
  const meta = acceptance ? requestCancelPlanMeta(acceptance) : null;
  if (!meta || !meta.feeEvaluationAt) return null;
  const at = new Date(meta.feeEvaluationAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

// One-way protective choices a retry makes — waive the fee, silence the
// customer — ratchet onto the acceptance's durable metadata so a later
// retry keeps them even if this run's case write fails. Returns the
// effective metadata. Never loosens: an accepted waiver or opt-out stays.
async function ratchetAcceptedChoices(requestRow, input, fallbackScope) {
  const meta = requestCancelPlanMeta(requestRow);
  const ratchet = {};
  if (input.waiveLateFee && (!meta || meta.waiveLateFee !== true)) ratchet.waiveLateFee = true;
  if (input.sendConfirmation === false && (!meta || meta.sendConfirmation !== false)) ratchet.sendConfirmation = false;
  if (!Object.keys(ratchet).length) return meta;
  const next = { ...(meta || { scope: fallbackScope }), ...ratchet };
  try {
    await db('service_requests').where({ id: requestRow.id }).update({
      metadata: JSON.stringify({ cancel_plan: next }),
      updated_at: new Date(),
    });
    // The row object is the base every later metadata write on this run
    // merges into (the episode stamp) — a stale copy would silently revert
    // the waiver/opt-out just persisted.
    requestRow.metadata = JSON.stringify({ cancel_plan: next });
  } catch (metaErr) {
    logger.warn(`[admin-cancellation] ${Object.keys(ratchet).join('/')} ratchet failed for request ${requestRow.id}: ${metaErr.message}`);
  }
  return next;
}

// A lost-response retry of a run that already RESOLVED its acceptance
// answers with the recorded case — nothing re-runs. Null when the resolved
// acceptance left no case to echo.
async function echoResolvedCase(customerId, resolved) {
  const priorCase = await db('cancellation_cases')
    .where({ service_request_id: resolved.id })
    .orderBy('created_at', 'desc')
    .first('id', 'status', 'snapshot');
  if (!priorCase) return null;
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

// A clean close means every earlier failure was repaired — the unread
// "needs review" bell for this request must not keep sending staff into
// follow-up that is already done. Best-effort: a missed stamp leaves a
// stale bell, never a lost cancel.
async function resolveReviewBell(requestId) {
  try {
    await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereNull('read_at')
      .whereRaw("metadata->>'dedupeKey' = ?", [`admin_cancel_review:${requestId}`])
      .update({ read_at: new Date() });
  } catch (bellErr) {
    logger.warn(`[admin-cancellation] review-bell resolve failed for request ${requestId}: ${bellErr.message}`);
  }
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
  // Requested-scope acceptance FIRST (mirrors the commit): normalizing
  // against live ownership before the lookup reduces a multi-family retry
  // to the still-visible subset and misses the original acceptance.
  let requestedAcceptance = null;
  if (Array.isArray(input.families) && input.families.length) {
    try {
      requestedAcceptance = await findCancelAcceptance(customerId, false, [...input.families].sort(), 'new');
    } catch (reqErr) {
      logger.warn(`[admin-cancellation] requested-scope preview lookup failed for ${customerId}: ${reqErr.message}`);
    }
    if (requestedAcceptance) {
      const durable = requestCancelPlanMeta(requestedAcceptance);
      if (durable && Array.isArray(durable.scope) && durable.scope.length) input.families = [...durable.scope];
    }
  }
  const { wholeAccount, scope, scopeError } = await resolveScope(customerId, input.families);
  // Repair-retry awareness: a partial run leaves its acceptance open, and
  // the account may now have nothing cancellable (or the scoped family gone
  // from the live rows) — the preview must still present a committable
  // retry, or the dialog's only button stays disabled and the first
  // attempt's failed side effects are stranded. Mirrors the commit gate.
  let repairRetry = false;
  let acceptance = null;
  try {
    acceptance = requestedAcceptance || await findCancelAcceptance(customerId, wholeAccount, scope, 'new');
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
      // The accepted boundary and disposition inherit here too, BEFORE
      // resolvePrepay — the commit runs under them, so a preview from
      // dialog defaults would display and fingerprint an immediate
      // cancel/refund the commit then rejects as preview_changed,
      // leaving the repair unreachable.
      if (requestMeta && requestMeta.effectiveDate) input.effectiveDate = requestMeta.effectiveDate;
      if (requestMeta && 'prepayDisposition' in requestMeta) input.prepayDisposition = requestMeta.prepayDisposition || null;
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
    // A scoped repair whose family already lost its live rows previews as
    // SCOPED (nothing more to pull) — the same option the commit's
    // approved-facts view passes, so the fingerprint matches on retry.
    buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough, keepVisitIds, keepScoped: scopedRetry }),
  ]);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;
  // Fee exposure = the live pull set PLUS the visits run 1 already
  // cancelled under this acceptance (the repair pass re-runs their fee
  // rails), judged at the FIRST approval's instant when one is recorded —
  // the commit's approved-facts view prices exactly the same set the same
  // way, so the fingerprint matches and a retry can never charge a fee the
  // card showed as absent (codex GH r29 P1).
  const repairFeeKeys = await repairVisitFeeKeys(customerId, acceptance);
  const feeNow = acceptedFeeEvaluationAt(acceptance) || new Date();
  const visitFees = await previewVisitFees(
    [...new Set([...(impact && Array.isArray(impact.pulledVisitKeys) ? impact.pulledVisitKeys : []), ...repairFeeKeys].map(String))], feeNow);
  // Every open SCOPED acceptance (any scope): the dialog derives its
  // checkboxes from LIVE rows, so a scoped partial run whose family already
  // lost its rows would otherwise be unreachable from the UI — surface the
  // durable scopes so the dialog can offer the retry directly.
  let openScopedRepairs = [];
  try {
    const openRows = await db('service_requests')
      .where({ customer_id: customerId, category: 'cancellation', source: 'admin', status: 'new' })
      .orderBy('created_at', 'desc')
      .select('*');
    openScopedRepairs = (openRows || [])
      .map((r) => requestCancelPlanMeta(r))
      .filter((m) => m && Array.isArray(m.scope) && m.scope.length)
      .map((m) => ({ families: [...m.scope], labels: m.scope.map(familyLabelOf) }));
  } catch (openErr) {
    logger.warn(`[admin-cancellation] open-scoped-repairs listing failed for ${customerId}: ${openErr.message}`);
  }
  const today = etDateString();
  return {
    previewFingerprint: cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact, visitFees, scope, wholeAccount }),
    enabled: true,
    customer: customerSummary(customer),
    eligible: eligible || repairRetry,
    // The dialog/IB card can say "this retries an unfinished cancellation".
    repairRetry,
    openScopedRepairs,
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
    // Deliverability, not mere presence: a stored landline, an active
    // STOP, disabled email prefs, or a malformed address must not let the
    // card promise "text + email" the send legs will refuse.
    confirmationChannels: await require('./cancellation-confirmations').confirmationChannelAvailability(customer),
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

  // The acceptance is matched on the CALLER'S canonical requested scope
  // FIRST: normalizing against live ownership first would reduce a
  // multi-family retry to the subset still on live rows (the cancelled
  // family's rows are gone), miss the original acceptance, open a second
  // request, and strand run 1's failed side effects forever. Fail closed
  // like the normalized lookup below.
  let requestedAcceptance = null;
  if (Array.isArray(input.families) && input.families.length) {
    try {
      requestedAcceptance = await findCancelAcceptance(customerId, false, [...input.families].sort(), 'new');
    } catch (reqErr) {
      logger.error(`[admin-cancellation] requested-scope acceptance lookup failed for ${customerId}: ${reqErr.message}`);
      throw new CancelPlanError(503, 'acceptance_check_unavailable',
        'Could not verify whether an unfinished cancellation already exists for this customer — nothing was changed. Try again shortly.');
    }
    if (requestedAcceptance) {
      const durable = requestCancelPlanMeta(requestedAcceptance);
      if (durable && Array.isArray(durable.scope) && durable.scope.length) input.families = [...durable.scope];
    }
  }

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
  const openAcceptance = requestedAcceptance || await findOpenAcceptance();
  // Durable approved facts, inherited BEFORE prepay resolution: a
  // fingerprint-exempt repair retry from dialog defaults must never flip a
  // refunded end-now into end-at-term (or move the approved boundary) on
  // facts nobody re-approved — the acceptance carries what the operator
  // accepted, and the retry runs under exactly that.
  if (openAcceptance) {
    const acceptedMeta = requestCancelPlanMeta(openAcceptance);
    if (acceptedMeta && acceptedMeta.effectiveDate && input.effectiveDate !== acceptedMeta.effectiveDate) {
      logger.info(`[admin-cancellation] retry inherits effectiveDate=${acceptedMeta.effectiveDate} from request ${openAcceptance.id}`);
      input.effectiveDate = acceptedMeta.effectiveDate;
    }
    if (acceptedMeta && 'prepayDisposition' in acceptedMeta
      && (acceptedMeta.prepayDisposition || null) !== (input.prepayDisposition || null)) {
      logger.info(`[admin-cancellation] retry inherits prepayDisposition=${acceptedMeta.prepayDisposition || 'none'} from request ${openAcceptance.id}`);
      input.prepayDisposition = acceptedMeta.prepayDisposition || null;
    }
  }
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
    if (!retryAcceptance) {
      // A CLEAN scoped run resolved its acceptance and took the family off
      // the live rows — a lost-response retry for the same family must
      // answer with the recorded case, never scope_not_owned for a
      // cancellation that succeeded (codex GH r29 P2). Keyed on the
      // caller's canonical requested scope inside the 24h echo window.
      if (scopeError === 'scope_not_owned' && Array.isArray(input.families) && input.families.length) {
        try {
          const resolved = await findCancelAcceptance(customerId, false, [...input.families].sort(), 'resolved');
          const echo = resolved ? await echoResolvedCase(customerId, resolved) : null;
          if (echo) return echo;
        } catch (echoErr) {
          logger.warn(`[admin-cancellation] resolved scoped-acceptance echo failed for ${customerId}: ${echoErr.message}`);
        }
      }
      throw scopeErrorToHttp(scopeError);
    }
    logger.info(`[admin-cancellation] scoped repair retry for ${customerId} — open acceptance ${retryAcceptance.id} overrides scope_not_owned`);
  }
  // The accepted family owns no live rows any more: the approved-facts view
  // must stay scoped (mirrors the preview) or it reclassifies to a
  // whole-account impact over the OTHER family's visits, approves ids the
  // repair-only run never pulls, and visits_pulled_beyond_preview parks
  // every retry forever.
  const scopedRetry = !!openAcceptance && scopeError === 'scope_not_owned';
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
        const echo = resolved ? await echoResolvedCase(customerId, resolved) : null;
        if (echo) return echo;
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
  // Same fee set and instant as the preview (see repairVisitFeeKeys /
  // acceptedFeeEvaluationAt): the visits run 1 already cancelled re-enter
  // the fee rails on a retry, at the FIRST approval's clock.
  const repairFeeKeys = await repairVisitFeeKeys(customerId, openAcceptance);
  const acceptedFeeAt = acceptedFeeEvaluationAt(openAcceptance);
  const liveApprovedFacts = async ({ feeNow = new Date() } = {}) => {
    const liveImpact = await buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough, keepVisitIds, keepScoped: scopedRetry });
    const liveVisitFees = await previewVisitFees(
      [...new Set([...(liveImpact && Array.isArray(liveImpact.pulledVisitKeys) ? liveImpact.pulledVisitKeys : []), ...repairFeeKeys].map(String))], feeNow);
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
      // End-now history scans INDEPENDENTLY of the disposition match:
      // find() short-circuits at the first matching case, so an
      // end_now_refund case sitting after the match in the window would
      // never set the flag — and the inverse refusal below must outrank
      // any echo of an older end_at_term case.
      const parsed = (recent || []).map((c) => ({
        c,
        snap: typeof c.snapshot === 'string' ? JSON.parse(c.snapshot) : (c.snapshot || {}),
      }));
      priorEndNow = parsed.some(({ snap }) => String(snap.prepayTermId || '') === String(term.id)
        && String(snap.prepayDisposition || '') === 'end_now_refund');
      const hit = parsed.find(({ snap }) => String(snap.prepayTermId || '') === String(term.id)
        && String(snap.prepayDisposition || '') === String(prepayPlan.prepayDisposition || '')) || null;
      prior = hit ? hit.c : null;
      if (hit) priorSnap = hit.snap;
      // The echo is only for RETRIES of that run — proven by its acceptance
      // being still OPEN (the run owes follow-ups; its repair identity is
      // the request's own stamp + snapshot boundary), or RESOLVED with the
      // SAME IDENTITY: the customer is still churned, in the churn episode
      // that run recorded, and the coverage boundary it told the customer
      // still stands. A historical case, a won-back account cancelling the
      // same still-current term (even inside a day — the live account would
      // otherwise stay billable behind the echo), or an office correction
      // of term_end (the customer must be re-told the new date; the dated
      // task carries it in its key and #3767 retires the stale one) is a
      // NEW cancellation: fall through and process fresh (the decided term
      // reads 'decision_already_recorded'; the refund recounts from the
      // live rows). The echo also stays BOUNDED to the 24h lost-response
      // window: identity narrows it, never extends it — staff can add
      // visits or a recurrence to a still-churned account, and a later
      // cancellation on the same term must reach the processor for them,
      // not a days-old echo. A resolved run with no episode stamp
      // (pre-episode, or a stamp that failed) has only the window + the
      // churned row as its identity.
      if (prior) {
        let tied = false;
        let openTie = false;
        try {
          const priorReq = prior.service_request_id
            ? await db('service_requests').where({ id: prior.service_request_id }).first('id', 'status', 'created_at', 'metadata')
            : null;
          openTie = !!priorReq && priorReq.status === 'new';
          let resolvedTie = false;
          if (!openTie && priorReq && priorReq.status === 'resolved'
            && new Date(priorReq.created_at).getTime() >= Date.now() - 24 * 60 * 60 * 1000) {
            const live = await db('customers').where({ id: customerId }).first('pipeline_stage', 'churn_episode_id');
            const stillChurned = !!live && live.pipeline_stage === 'churned';
            const stamped = (requestCancelPlanMeta(priorReq) || {}).churnEpisodeId || null;
            const sameEpisode = !stamped || String((live && live.churn_episode_id) || '') === String(stamped);
            // Boundary compared only when both sides carry one (a legacy
            // snapshot without effectiveOn has no date to contradict).
            const priorBoundary = priorSnap && priorSnap.effectiveOn ? String(priorSnap.effectiveOn) : null;
            const sameBoundary = !prepayPlan.keepThrough || !priorBoundary || priorBoundary === prepayPlan.keepThrough;
            resolvedTie = stillChurned && sameEpisode && sameBoundary;
            if (!resolvedTie) {
              logger.info(`[admin-cancellation] resolved case ${prior.id} is not this run's identity (churned=${stillChurned} episode=${sameEpisode} boundary=${sameBoundary})`);
            }
          }
          tied = openTie || resolvedTie;
        } catch (tieErr) {
          // Fail CLOSED: unable to tell a retry from a new cancellation, the
          // run must not open a second request/case and re-run the
          // processor on a guess — same posture as the acceptance lookup.
          logger.warn(`[admin-cancellation] latch acceptance check failed for case ${prior.id}: ${tieErr.message}`);
          throw new CancelPlanError(503, 'acceptance_check_unavailable',
            'Could not confirm whether this cancellation was already processed. Try again in a moment.');
        }
        if (!tied) {
          logger.info(`[admin-cancellation] case ${prior.id} has no live acceptance — treating this as a NEW cancellation, not a retry`);
          prior = null;
          priorSnap = null;
        } else if (openTie && !(priorSnap && priorSnap.outcome)) {
          // An OPEN acceptance whose case carries NO outcome is a LOST
          // STAMP (the first run pushed outcome_record_failed and kept the
          // acceptance open), not a finished run to echo: every repair in
          // this latch keys on the recorded outcome, so echoing would
          // answer "processed, 0 pulled, no errors" on every retry while
          // the acceptance never resolves. Fall through instead — the open
          // acceptance carries the retry into the processor's repair pass
          // (which reconstructs the pull set from run 1's cancelled rows),
          // the decided term reads decision_already_recorded, the refund
          // task dedupes by term, and the run re-stamps the outcome.
          logger.info(`[admin-cancellation] case ${prior.id} has an open acceptance but no recorded outcome (lost stamp) — running the repair retry instead of echoing`);
          prior = null;
          priorSnap = null;
        }
      }
    } catch (dupErr) {
      // The latch's own fail-closed verdict (acceptance_check_unavailable)
      // must surface, not degrade into a guessed fresh run.
      if (dupErr instanceof CancelPlanError) throw dupErr;
      logger.warn(`[admin-cancellation] duplicate-case lookup failed for ${customerId}: ${dupErr.message}`);
    }
    // The destructive inverse is REFUSED: after end_now_refund the paid
    // visits are pulled and the refund is in flight, so a later
    // end_at_term commit would re-run the engine and tell the customer
    // those visits remain through the term end. (The intentional
    // end_at_term → end_now_refund transition stays allowed — it still has
    // kept visits to pull and a refund to record.) UNCONDITIONAL on prior:
    // after that allowed transition BOTH cases exist, and an older
    // end_at_term case matching this request must not echo "paid visits
    // remain" for visits the end-now run already pulled and refunded.
    if (priorEndNow && prepayPlan.prepayDisposition === 'end_at_term') {
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
        let approved = refundFactsMatch(proposed, refund);
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
      const hasTermiteErr = !!(outcome && Array.isArray(outcome.errors) && outcome.errors.includes('termite_retrieval_task'));
      if (outcome && (refundRepairedNow || hasTermiteErr
        || (Array.isArray(outcome.errors) && outcome.errors.some(isConfirmErr)))) {
        try {
          const reqRow = prior.service_request_id
            ? await db('service_requests').where({ id: prior.service_request_id }).first('id', 'status', 'created_at', 'metadata')
            : null;
          if (reqRow && reqRow.status === 'new') {
            // A repair-time opt-out is honoured HERE too (codex GH r29 P2):
            // this latch answers before the ratchet on the ordinary path,
            // so the operator's explicit "do not contact" ratchets onto the
            // acceptance now and no resend goes out — the outstanding
            // channel failures are withdrawn, not retried.
            const silenced = input.sendConfirmation === false;
            if (silenced) await ratchetAcceptedChoices(reqRow, input, Array.isArray(outcome.scope) ? outcome.scope : []);
            // A freshly repaired refund task answers the stale disposition
            // error the lost task recorded.
            let promotedErrors = (outcome.errors || []).filter((e) => !(refundRepairedNow
              && (e === 'prepay_term_disposition' || e === 'prepay_refund_task')));
            // A lost DEFERRED retrieval task repairs here too — dated
            // (end-of-coverage) or immediate (end-now): the decided-term
            // latch is the only path a retried run reaches, and without
            // this the stale error echoes forever and the office never
            // gets its pull instruction.
            const datedTermite = priorSnap.effectiveDate === 'end_of_coverage';
            // The repair's identity is the REQUEST's own episode stamp and the
            // snapshot's boundary (the date the resend renders), never the
            // customer's current stamp or a term_end corrected since.
            const repairMeta = requestCancelPlanMeta(reqRow);
            const repairEpisode = termEpisodeOf(term, repairMeta && repairMeta.churnEpisodeId, datedTermite ? priorSnap.effectiveOn : null);
            if (hasTermiteErr && (!datedTermite || priorSnap.effectiveOn)) {
              try {
                const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
                await raiseTermiteRetrievalTask(customerId, reqRow.id, { retrieveAfter: datedTermite ? priorSnap.effectiveOn : null, ...termEpisodeRaiseArgs(repairEpisode) });
                promotedErrors = promotedErrors.filter((e) => e !== 'termite_retrieval_task');
              } catch (termiteErr) {
                logger.warn(`[admin-cancellation] deferred termite retrieval repair failed for request ${reqRow.id}: ${termiteErr.message}`);
              }
            }
            let channels = Array.isArray(outcome.confirmationChannels) ? outcome.confirmationChannels : [];
            let errorsNext = promotedErrors;
            if (silenced) {
              errorsNext = promotedErrors.filter((e) => !isConfirmErr(e));
            } else if (outcome.confirmationRequested === true
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
                ...termEpisodeSendArgs(repairEpisode),
                entryPoint: 'admin_cancel_plan',
                identityTrustLevel: 'admin_operator',
              });
              const stillFailed = [];
              // A definitively BLOCKED channel (opt-out, landline,
              // suppression) is unavailable, not failed — parking the run
              // would retry it forever while the other channel delivered.
              if (customer.phone && !resend.smsSent && !resend.smsBlocked) stillFailed.push('confirmation_sms_not_sent');
              if (customer.email && !resend.emailSent && !resend.emailBlocked) stillFailed.push('confirmation_email_not_sent');
              channels = [...new Set([...channels, ...resend.channels])];
              errorsNext = [...promotedErrors.filter((e) => !isConfirmErr(e)), ...stillFailed];
            }
            const nextOutcome = {
              ...outcome,
              ...(silenced ? { confirmationRequested: false } : {}),
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
                if (closed) await resolveReviewBell(reqRow.id);
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
      // A LOST clean close repairs here (the only path a decided-term
      // retry reaches): the stamped outcome is error-free but the
      // acceptance may still read 'new' — every later cancellation would
      // keep reusing this request, its UNIQUE case, and its dedupe state.
      // Same affected-row posture as the commit close.
      // Clean = a stamped outcome with no errors. A MISSING stamp is a
      // lost write, not a clean run — closing on it would strand repairs.
      const outcomeClean = !!(priorSnap && priorSnap.outcome)
        && !(Array.isArray(priorSnap.outcome.errors) && priorSnap.outcome.errors.length);
      if (outcomeClean && prior.service_request_id) {
        try {
          const openReq = await db('service_requests')
            .where({ id: prior.service_request_id }).first('id', 'status');
          if (openReq && openReq.status === 'new') {
            const closed = await db('service_requests').where({ id: openReq.id, status: 'new' })
              .update({ status: 'resolved', updated_at: new Date() });
            if (closed) await resolveReviewBell(openReq.id);
            else throw new Error('acceptance close updated zero rows');
          }
        } catch (closeErr) {
          // Still 'new' — the next echo retries; resends stay deduped. On
          // the RESPONSE only (codex GH r31 P2): the stored outcome stays
          // clean so the next echo re-attempts this close, but the operator
          // must not read a clean success over a still-reusable request.
          repairErrors.push('acceptance_close_failed');
          logger.warn(`[admin-cancellation] latch close repair failed for request ${prior.service_request_id}: ${closeErr.message}`);
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
  let approvedPulledKeysForMeta = null;
  // The instant the approved facts were validated against live state — the
  // processor's fee rails evaluate their cancel windows at THIS time, so a
  // slow sweep crossing a visit's fee cutoff mid-run cannot charge a fee
  // that was absent from the approved fingerprint.
  let feeEvaluationAt = null;
  // The APPROVED scoped pricing (canonical string): the processor recomputes
  // planScopedWindDown from live rows, and a ledger/hold/tier write landing
  // between validation and the wind-down would apply prices nobody approved
  // — the processor reasserts this snapshot before repricing anything.
  let approvedScopedPricing = null;
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
  // A retry of an accepted run keeps the FIRST approval's clock whether or
  // not it carries a fresh fingerprint: the preview priced the repair set
  // at that instant, and the processor's rails must judge the same visits
  // at the same instant (fingerprint-exempt retries included).
  if (acceptedFeeAt) feeEvaluationAt = acceptedFeeAt;
  if (suppliedFingerprint) {
    // ONE clock for the whole approval: the validation previews judge the
    // fee windows at THIS instant, and the processor's rails reuse it —
    // a visit crossing into its fee window between the preview calls and
    // a later Date.now() could otherwise charge a fee the matching
    // fingerprint approved as absent.
    if (!feeEvaluationAt) feeEvaluationAt = new Date();
    const { liveImpact, fingerprint } = await liveApprovedFacts({ feeNow: feeEvaluationAt });
    if (fingerprint !== suppliedFingerprint) {
      throw new CancelPlanError(409, 'preview_changed',
        'The cancellation facts changed since this preview (a visit completed or appeared, or the prepay term was edited). Re-open the preview and approve the current numbers.');
    }
    if (liveImpact && Array.isArray(liveImpact.pulledVisitKeys)) {
      approvedPulled = liveImpact.pulledVisitKeys.length;
      approvedPulledIds = new Set(liveImpact.pulledVisitKeys.map((k) => String(k).split(':')[0]));
      approvedPulledKeysForMeta = liveImpact.pulledVisitKeys.map(String);
    }
    if (!wholeAccount && liveImpact) {
      approvedScopedPricing = [
        `tier=${liveImpact.tierAfter ?? ''}`,
        `monthly=${liveImpact.accountMonthlyAfter ?? ''}`,
        `rates=${(liveImpact.remaining || []).map((r) => `${r.key}:${r.monthlyBefore}:${r.monthlyAfter}`).sort().join(',')}`,
        `perapp=${(liveImpact.perAppChanges || []).map((p) => `${p.id}:${p.before}:${p.after}`).sort().join(',')}`,
        // Inputs too (cancellation-processor scopedPricingFingerprint): a
        // tier or billing-mode edit during the sweep must be re-approved.
        `tierbefore=${liveImpact.tierBefore ?? ''}`,
        `mode=${liveImpact.billingMode ?? ''}`,
      ].join('|');
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
  // The FIRST attempt's recorded prepay facts (term id, disposition,
  // decision outcome, recorded/proposed refund): a repair retry after the
  // office issued the recorded refund finds NO live term (coveredTermsAsOf
  // omits a fully-refunded one), derives no prepay plan, and must not
  // overwrite the financial record with nulls (codex GH r31 P1).
  let priorPrepayFacts = null;
  // The date the cancellation TOOK EFFECT: on a repair retry the account was
  // churned and its visits pulled by the first attempt, so the case record
  // and the response keep that day — the prior snapshot's, or the accepted
  // request's — never the day the retry happened to run.
  let priorEffectiveOn = null;
  // Run 1's PROPOSED (never recorded) refund: a fingerprint-exempt repair
  // retry may only raise the office task on these approved numbers.
  let priorProposedRefund = null;
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
    // A fingerprint-exempt retry runs bounded by the FIRST approval's pull
    // set: an appointment created after the operator approved is never
    // swept silently — it flags visits_pulled_beyond_preview for office
    // eyes (one-way: approved rows already pulled by run 1 are naturally
    // absent from a repair run's cancels and are not drift).
    if (!suppliedFingerprint && requestMeta && Array.isArray(requestMeta.approvedPulledKeys)) {
      approvedPulled = requestMeta.approvedPulledKeys.length;
      approvedPulledIds = new Set(requestMeta.approvedPulledKeys.map((k) => String(k).split(':')[0]));
    }
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
      priorProposedRefund = snap && !snap.refund && snap.proposedRefund ? snap.proposedRefund : null;
      if (snap && snap.prepayTermId) {
        priorPrepayFacts = {
          prepayTermId: snap.prepayTermId,
          prepayDisposition: snap.prepayDisposition || null,
          prepayTermOutcome: snap.prepayTermOutcome || null,
          refund: snap.refund || null,
          ...(snap.proposedRefund ? { proposedRefund: snap.proposedRefund } : {}),
        };
      }
      if (snap && /^\d{4}-\d{2}-\d{2}$/.test(String(snap.effectiveOn || ''))) priorEffectiveOn = snap.effectiveOn;
      if (snap && snap.waiveLateFee === true && !input.waiveLateFee) {
        input.waiveLateFee = true;
        logger.info(`[admin-cancellation] retry inherits the accepted fee waiver from request ${request.id} (case snapshot)`);
      }
    } catch (priorErr) {
      logger.warn(`[admin-cancellation] prior-case load failed for request ${request.id}: ${priorErr.message}`);
    }
    // No case row survived the first attempt (lost case write): the
    // acceptance itself dates the cancellation.
    if (!priorEffectiveOn && request.created_at) priorEffectiveOn = etDateString(new Date(request.created_at));
    // A retry that ADDS the waiver, or SILENCES the customer, ratchets that
    // choice onto the durable record so a later retry keeps it even if this
    // run's case write fails — both ratchets are one-way in the protective
    // direction (never charge what was waived, never text who was silenced),
    // the same direction the dialog locks its sticky controls.
    await ratchetAcceptedChoices(request, input, wholeAccount ? [] : [...scope].sort());
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
            // The APPROVED facts a fingerprint-exempt retry runs under:
            // boundary and disposition inherit (no silent end-now →
            // end-at-term flip), the approved pull identities bound what a
            // retry's sweep may cancel, and the accepted fingerprint is
            // the audit link back to what the operator saw.
            effectiveDate: input.effectiveDate,
            prepayDisposition: input.prepayDisposition,
            previewFingerprint: suppliedFingerprint,
            // The instant the approved fee exposure was judged at — every
            // retry prices the same visits at this clock.
            feeEvaluationAt: feeEvaluationAt ? feeEvaluationAt.toISOString() : null,
            ...(approvedPulledKeysForMeta ? { approvedPulledKeys: approvedPulledKeysForMeta } : {}),
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
      // What the cancelled ROWS carry — and the public tracker echoes to
      // anyone holding a shared link (track-public cancellation.reason):
      // fixed customer-safe copy, never the operator's internal note or
      // reason code. The note lives only on the request/case (staff) and
      // the churn columns (reason above).
      visitReason: 'Service plan cancelled',
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
      feeEvaluationAt,
      approvedScopedPricing,
      // A term decision follows this run: hold BOTH retrieval tasks (dated
      // and immediate) until it stands — see the deferred block below.
      deferTermiteRetrieval: !!(term && prepayPlan.prepayDisposition),
    });
  } catch (err) {
    logger.error(`[admin-cancellation] processor threw for request ${request.id}: ${err.message}`);
    errors.push('processor_threw');
  }
  const processed = !!(result && result.ok && (result.churned || result.scopedWoundDown));
  if (result && Array.isArray(result.errors)) errors.push(...result.errors);
  // The pending-invoice refusal above is a preflight: annual-prepay term
  // creation (estimate acceptance → estimate-converter / renewals attach)
  // does not take the cancel lock, so a term can appear between that read
  // and the end of the wind-down and stay payable on the churned account
  // (codex GH r28 P1). Re-read at the boundary and make a surfaced invoice
  // UNPAYABLE right here (codex GH r30 P1): the canonical void
  // (InvoiceService.voidInvoice — the same path the invoice tools use;
  // it syncs the never-paid term to cancelled) — a bell alone leaves the
  // public invoice payable until staff act, and a payment in that window
  // re-activates coverage on the churned account. A void that cannot land
  // (already paid, on a finalized statement, unreadable) is the exception
  // the office resolves, never a clean run.
  if (processed) {
    try {
      const surfaced = await findPendingPrepayInvoice(customerId, wholeAccount ? null : scope);
      if (surfaced) {
        try {
          await require('./invoice').voidInvoice(surfaced.invoice.id);
          logger.warn(`[admin-cancellation] pending prepay invoice ${surfaced.invoice.id} (term ${surfaced.term.id}) surfaced during the wind-down for request ${request.id} — voided at the boundary`);
        } catch (voidErr) {
          errors.push('pending_prepay_invoice_appeared');
          logger.error(`[admin-cancellation] pending prepay invoice ${surfaced.invoice.id} (term ${surfaced.term.id}) surfaced during the wind-down for request ${request.id} and could not be voided: ${voidErr.message}`);
        }
      }
    } catch (recheckErr) {
      errors.push('pending_prepay_invoice_appeared');
      logger.error(`[admin-cancellation] pending prepay recheck failed after the wind-down for request ${request.id}: ${recheckErr.message}`);
    }
  }
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
    let beyond = false;
    if (approvedPulledIds && Array.isArray(result?.cancelledIds)) {
      const cancelledSet = new Set(result.cancelledIds.map(String));
      beyond = result.cancelledIds.some((id) => !approvedPulledIds.has(String(id)))
        // Missing-approved-pull drift only under a CURRENT validated
        // fingerprint: a repair retry's approved rows were pulled by run 1
        // and are legitimately absent from this run's cancels.
        || (!!suppliedFingerprint && [...approvedPulledIds].some((id) => !cancelledSet.has(id)));
    } else if (suppliedFingerprint) {
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
          // Written BEFORE the refund task and the case row persist — the
          // note says OWED, never "recorded": a lost task/case write leaves
          // refundRecorded false and bells the office, and a durable
          // renewal note claiming the record exists would contradict it.
          `Cancel plan (${actorLabel}) — ended now; unused-value refund owed to the customer (office refund task + cancellation case follow).`);
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
          if (!suppliedFingerprint && priorProposedRefund && !refundFactsMatch(priorProposedRefund, recount)) {
            // Same posture as the duplicate latch (codex r8 P1): a
            // fingerprint-exempt repair retry (the decided-term lost-stamp
            // bypass lands here too) must never mint an actionable billing
            // task for numbers nobody approved — the recount drifted from
            // run 1's proposal, so the task waits for a fresh preview →
            // commit; the case keeps the recount as PROPOSED only.
            errors.push('refund_facts_changed');
            logger.error(`[admin-cancellation] refund for request ${request.id} drifted from the recorded proposal ($${priorProposedRefund.amount} → ${recount.needsManualCalc ? 'manual' : `$${recount.amount}`}) — task NOT raised without a fresh approved preview`);
          } else {
            await raisePrepayRefundTask({ customer, request, term, refund: recount, actorLabel });
            refundRecorded = true;
          }
        }
      }
    } catch (err) {
      errors.push('prepay_term_disposition');
      logger.error(`[admin-cancellation] prepay term disposition failed for request ${request.id}: ${err.message}`);
    }
  }

  // Deferred termite retrieval: the processor holds the task — DATED for
  // end-of-coverage, IMMEDIATE for an end-now cancel of a prepaid term —
  // until the term decision stands. A conflicting renew decision, or a
  // lost decision write, means the term is still renewable, and staff must
  // never hold an instruction to pull Waves-owned stations from a program
  // that did not end. Skipped on a conflict/failed disposition: that run
  // is already partial (belled), and the repair retry re-runs the
  // processor, which re-derives the pending task from live rows.
  // The episode the processor churned this request under — stamped on the
  // request BEFORE the term-keyed side effects, and carried on the case.
  // A stamp that did not persist is NOT a run error: this run simply stays
  // request-keyed (the identity its repair resolves to as well, so nothing
  // double-fires) and closes on that identity. The only cost is that a
  // repeat commit on the same term after the 24h latch could re-tell the
  // customer — logged by stampRequestEpisode, never a parked acceptance a
  // later win-back cancel would keep reusing.
  const episodeStamped = !!(result && result.churnEpisodeId) && await stampRequestEpisode(request, result.churnEpisodeId);
  const termEpisode = episodeStamped ? termEpisodeOf(term, result.churnEpisodeId, prepayPlan.keepThrough || null) : null;
  if (result && result.termiteRetrievalPending) {
    if (processed && ['ends_at_term', 'ended_now', 'decision_already_recorded'].includes(termOutcome)) {
      try {
        const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
        await raiseTermiteRetrievalTask(customerId, request.id,
          { retrieveAfter: result.termiteRetrievalPending.retrieveAfter, ...termEpisodeRaiseArgs(termEpisode) });
      } catch (termiteErr) {
        errors.push('termite_retrieval_task');
        logger.error(`[admin-cancellation] deferred termite retrieval task failed for request ${request.id}: ${termiteErr.message}`);
      }
    } else {
      logger.warn(`[admin-cancellation] termite retrieval NOT raised for request ${request.id} — term decision not confirmed (${termOutcome || 'no disposition'})`);
    }
  }

  // The durable case (after the wind-down, like the portal path).
  const effectiveOn = prepayPlan.keepThrough || priorEffectiveOn || etDateString();
  // No live term on this run but the first attempt recorded one: the term
  // has since left coverage (refund issued, term cancelled) — its terminal
  // facts are carried, never blanked.
  const carriedPrepay = !term && priorPrepayFacts ? priorPrepayFacts : null;
  const caseSnapshotBody = {
    actor: { type: actorType, userId: actorUserId },
    effectiveDate: prepayPlan.effectiveDate,
    effectiveOn,
    waiveLateFee: input.waiveLateFee,
    prepayDisposition: carriedPrepay ? carriedPrepay.prepayDisposition : prepayPlan.prepayDisposition,
    prepayTermId: carriedPrepay ? carriedPrepay.prepayTermId : (term ? term.id : null),
    prepayTermOutcome: carriedPrepay ? carriedPrepay.prepayTermOutcome : termOutcome,
    // A recorded refund is one whose cancel decision verified AND whose
    // office task persisted; anything else stays PROPOSED-only metadata so
    // the case never claims money that was not promised.
    refund: carriedPrepay ? carriedPrepay.refund : (refundRecorded ? refundFacts : null),
    ...(carriedPrepay
      ? (carriedPrepay.proposedRefund && !carriedPrepay.refund ? { proposedRefund: carriedPrepay.proposedRefund } : {})
      : (refundFacts && !refundRecorded ? { proposedRefund: refundFacts } : {})),
    sendConfirmation: input.sendConfirmation,
    ...(result && result.churnEpisodeId ? { churnEpisodeId: String(result.churnEpisodeId) } : {}),
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
      // The end-of-term confirmation is sent once per (TERM, churn episode),
      // not per request — see termEpisodeOf.
      ...termEpisodeSendArgs(termEpisode),
      entryPoint: 'admin_cancel_plan',
      identityTrustLevel: 'admin_operator',
    });
    // A requested confirmation a REACHABLE channel did not accept is a
    // follow-up failure like a lost case write: without it the dialog says
    // "Done." with the customer untold, no bell rings, and a retry answers
    // from the recorded outcome. The channel errors ride the review-bell
    // rail below (the confirmation verdict itself was already decided —
    // the copy that DID go out stays truthful).
    // Blocked = unavailable (policy refusal — opt-out, landline, hard
    // bounce), never a repairable failure: only transient misses park.
    if (customer.phone && !confirmations.smsSent && !confirmations.smsBlocked) errors.push('confirmation_sms_not_sent');
    if (customer.email && !confirmations.emailSent && !confirmations.emailBlocked) errors.push('confirmation_email_not_sent');
  }

  // Record the run's outcome on the case (best-effort): a later duplicate
  // retry answers from these facts — what was pulled and what the customer
  // was actually sent — instead of reporting "nothing sent" for a run whose
  // response was lost (codex C3 r3 P2). A lost write here only degrades a
  // future duplicate's reporting; the run itself already happened.
  // What this cancellation pulled, MERGED across attempts: a repair retry
  // re-flips nothing, so its own cancelledCount is zero — the first run's
  // recorded count (or, with a lost stamp, the processor's repair set:
  // run 1's cancelled rows under this request's note) carries the truth.
  // One number for the case record AND the response — the operator's
  // repair screen must not read "0 visits pulled" for a cancel that
  // happened.
  const visitsPulled = (priorOutcome
    ? Number(priorOutcome.visitsPulled) || 0
    : (result ? Number(result.repairedCount) || 0 : 0))
    + (result ? Number(result.cancelledCount) || 0 : 0);
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
            visitsPulled,
            scope: (Array.isArray(result?.scope) && result.scope.length)
              ? result.scope
              : (priorOutcome && Array.isArray(priorOutcome.scope) && priorOutcome.scope.length
                ? priorOutcome.scope : (wholeAccount ? [] : scope)),
            tierBefore: priorOutcome?.tierBefore ?? result?.tierBefore ?? (caseSnapshot ? caseSnapshot.waveguard_tier : null),
            tierAfter: result?.tierAfter ?? priorOutcome?.tierAfter ?? null,
            lateFeeWaived: (result ? result.lateFeeWaived === true : false) || priorOutcome?.lateFeeWaived === true,
            // An explicit repair-time opt-out overrides the first attempt's
            // request (codex GH r30 P2) — a lost-response echo must read
            // "nothing, by choice", not "nothing accepted".
            confirmationRequested: input.sendConfirmation === false
              ? false
              : (input.sendConfirmation || priorOutcome?.confirmationRequested === true),
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
      await resolveReviewBell(request.id);
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
          // A retry whose failure set CHANGED (an SMS repaired, a refund
          // task newly lost) refreshes the standing alert's body and error
          // list instead of leaving the office reading obsolete details
          // (codex GH r30 P2).
          refreshOnDedupe: true,
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
    visitsPulled,
    scope: Array.isArray(result?.scope) ? result.scope : (wholeAccount ? [] : scope),
    remaining: Array.isArray(result?.remaining) ? result.remaining : [],
    tierBefore: result?.tierBefore ?? (caseSnapshot ? caseSnapshot.waveguard_tier : null),
    tierAfter: result?.tierAfter ?? null,
    effectiveDate: effectiveOn,
    keptThrough: prepayPlan.keepThrough,
    // The processor's CONFIRMED waiver, never the raw request.
    lateFeeWaived: result ? result.lateFeeWaived === true : false,
    prepayDisposition: caseSnapshotBody.prepayDisposition,
    prepayTermOutcome: caseSnapshotBody.prepayTermOutcome,
    ...(caseSnapshotBody.refund ? { refund: caseSnapshotBody.refund } : {}),
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
  // Portal replay guard (requests.js dedupe + inactive retry): never re-run
  // a portal cancellation without the boundary an admin end-of-coverage
  // decision holds.
  adminCoverageBoundaryInForce,
  // Shared with the admin-dispatch series cancel: an UNPAID payment_pending
  // term's standalone invoice would re-activate coverage for the visits just
  // cancelled if paid afterwards (syncTermForInvoicePayment) — the same
  // refusal this engine applies before its own wind-down.
  findPendingPrepayInvoice,
};
