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
  const terms = await coveredTermsAsOf(db, etDateString())
    .where('t.customer_id', customerId)
    .orderBy('t.term_end', 'desc')
    .select('t.id', 't.term_start', 't.term_end', 't.plan_label', 't.prepay_amount',
      't.coverage_visit_count', 't.coverage_service_type', 't.status', 't.renewal_decision');
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

// The facts the operator approves on the preview (visit count, refund
// dollars, term, boundary, scope) — fingerprinted so the commit can refuse
// with 409 preview_changed when a covered visit completes, a visit appears,
// or the term is edited during the confirmation window (codex C3 r3 P2).
// Both surfaces carry it: the dialog echoes previewFingerprint into the
// commit body; the IB pending action pins it at proposal time.
function cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact, scope, wholeAccount }) {
  const crypto = require('crypto');
  const facts = {
    scope: wholeAccount ? [] : [...scope].sort(),
    termId: term ? String(term.id) : null,
    termEnd: term ? dateOnly(term.term_end) : null,
    disposition: prepayPlan ? prepayPlan.prepayDisposition : null,
    keepThrough: prepayPlan ? prepayPlan.keepThrough : null,
    refundAmount: refund ? refund.amount : null,
    refundManual: refund ? refund.needsManualCalc : null,
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

// A scoped cancel must never pull PREPAID visits: resolveLiveTerm only
// guards whole-account cancels, so a scope that selects the covered family
// would cancel already-paid visits while the term stays live — no decision,
// no refund. The term cannot be mapped to a family safely, but the covered
// ROWS can (stamp / term id — the canonical coverage identity): refuse when
// any live-covered upcoming visit falls inside the scope (fail closed).
async function scopedCoverageConflict(customerId, scope) {
  const { coveredTermsAsOf, ANNUAL_PREPAY_PREPAID_METHOD } = require('./annual-prepay-renewals');
  const terms = await coveredTermsAsOf(db, etDateString())
    .where('t.customer_id', customerId)
    .select('t.id');
  if (!terms || !terms.length) return false;
  const { familyOfServiceRow } = require('./cancellation-processor');
  const { CANCELLABLE_STATUSES } = require('./cancellation-eligibility');
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', CANCELLABLE_STATUSES)
    .where('s.scheduled_date', '>=', etDateString())
    .where(function coveredIdentity() {
      this.where('s.prepaid_method', ANNUAL_PREPAY_PREPAID_METHOD).orWhereNotNull('s.annual_prepay_term_id');
    })
    .select('s.*', 'sv.service_key', 'sv.service_name');
  return (rows || []).some((r) => scope.includes(familyOfServiceRow(r)));
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
      logger.warn(`[admin-cancellation] cancel lock release failed for ${customerId} (session end clears it): ${err.message}`);
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
  const term = await resolveLiveTerm(customerId, wholeAccount);
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  // The preview's "visits pulled" must count what pressing the button pulls:
  // an end-of-coverage cancel KEEPS dated visits through term_end (the
  // processor's keepThrough floor), so the impact math gets the same boundary.
  const [eligible, impact] = await Promise.all([
    hasCancellableWork(customerId),
    buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough }),
  ]);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;
  const today = etDateString();
  return {
    previewFingerprint: cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact, scope, wholeAccount }),
    enabled: true,
    customer: customerSummary(customer),
    eligible,
    wholeAccount,
    scope,
    scopeLabels: scope.map(familyLabelOf),
    scopedSupported: wholeAccount ? null : !scopeError,
    scopeError,
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
  if (scopeError) throw scopeErrorToHttp(scopeError);
  if (!(await hasCancellableWork(customerId))) {
    throw new CancelPlanError(400, 'nothing_to_cancel',
      'There is no active plan, recurring service, or upcoming visit on this account to cancel.');
  }

  const term = await resolveLiveTerm(customerId, wholeAccount);
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;

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
    try {
      const recent = await db('cancellation_cases')
        .where({ customer_id: customerId })
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('id', 'service_request_id', 'status', 'snapshot');
      prior = (recent || []).find((c) => {
        const snap = typeof c.snapshot === 'string' ? JSON.parse(c.snapshot) : (c.snapshot || {});
        const match = String(snap.prepayTermId || '') === String(term.id)
          && String(snap.prepayDisposition || '') === String(prepayPlan.prepayDisposition || '');
        if (match) priorSnap = snap;
        return match;
      }) || null;
    } catch (dupErr) {
      logger.warn(`[admin-cancellation] duplicate-case lookup failed for ${customerId}: ${dupErr.message}`);
    }
    if (prior) {
      logger.info(`[admin-cancellation] duplicate cancel for customer ${customerId} matched case ${prior.id} — returning the recorded outcome`);
      // The recorded run's facts (what was pulled, what the customer was
      // sent) answer the retry — a lost response must not be reported as
      // "nothing pulled / nothing sent". Cases predating the outcome record
      // fall back to the conservative zeros.
      const outcome = priorSnap && priorSnap.outcome ? priorSnap.outcome : null;
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
        errors: [],
      };
    }
  }

  // Approved-facts check (409 preview_changed): when the caller carries the
  // preview's fingerprint, the live facts must still match what the operator
  // saw — a visit that completed/appeared or an edited term changes the
  // visit pull and the refund dollars, and pressing Confirm must not
  // silently commit different numbers. Checked before any write.
  const suppliedFingerprint = raw.previewFingerprint == null || raw.previewFingerprint === ''
    ? null : String(raw.previewFingerprint);
  if (suppliedFingerprint) {
    const liveImpact = await buildCancellationImpact(customerId, wholeAccount ? [] : scope, { after: prepayPlan.keepThrough });
    const liveFingerprint = cancelPlanFactsFingerprint({ term, prepayPlan, refund, impact: liveImpact, scope, wholeAccount });
    if (liveFingerprint !== suppliedFingerprint) {
      throw new CancelPlanError(409, 'preview_changed',
        'The cancellation facts changed since this preview (a visit completed or appeared, or the prepay term was edited). Re-open the preview and approve the current numbers.');
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
  const [request] = await db('service_requests')
    .insert({
      customer_id: customerId,
      category: 'cancellation',
      subject: wholeAccount ? `Cancel plan (${actorLabel})` : `Cancel ${scope.map(familyLabelOf).join(', ')} (${actorLabel})`,
      description: input.note || '',
      urgency: 'routine',
      location_on_property: null,
      photos: JSON.stringify([]),
      status: 'new',
      source: 'admin',
    })
    .returning('*');
  logger.info(`[admin-cancellation] request ${request.id} opened for customer ${customerId} by ${actorLabel}`);

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
      requestId: request.id,
      families: wholeAccount ? [] : scope,
      actor: { type: actorType, userId: actorUserId },
      keepThrough: prepayPlan.keepThrough,
      waiveLateFee: input.waiveLateFee,
    });
  } catch (err) {
    logger.error(`[admin-cancellation] processor threw for request ${request.id}: ${err.message}`);
    errors.push('processor_threw');
  }
  const processed = !!(result && result.ok && (result.churned || result.scopedWoundDown));
  if (result && Array.isArray(result.errors)) errors.push(...result.errors);

  // Annual-prepay term disposition (whole-account only) — GATED on a
  // successful wind-down: deciding the term (or raising the refund task)
  // after a failed processor run would suppress renewal / promise money on
  // an account that did NOT cancel. A failed run bells the office below and
  // the operator retries; the retry re-runs processor-then-disposition in
  // the documented order.
  let termOutcome = null;
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
          await raisePrepayRefundTask({ customer, request, term, refund, actorLabel });
        }
      }
    } catch (err) {
      errors.push('prepay_term_disposition');
      logger.error(`[admin-cancellation] prepay term disposition failed for request ${request.id}: ${err.message}`);
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
    refund,
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
          outcome: {
            visitsPulled: result ? Number(result.cancelledCount) || 0 : 0,
            scope: Array.isArray(result?.scope) ? result.scope : (wholeAccount ? [] : scope),
            tierBefore: result?.tierBefore ?? (caseSnapshot ? caseSnapshot.waveguard_tier : null),
            tierAfter: result?.tierAfter ?? null,
            lateFeeWaived: input.waiveLateFee,
            confirmationRequested: input.sendConfirmation,
            confirmation: confirmations.smsSent ? 'sms' : (confirmations.emailSent ? 'email' : null),
            confirmationChannels: confirmations.channels,
          },
        }),
        updated_at: new Date(),
      });
    } catch (outcomeErr) {
      logger.warn(`[admin-cancellation] outcome record failed for case ${caseRow.id}: ${outcomeErr.message}`);
    }
  }

  // Exception-based: a partial run OR any post-processor failure (refund
  // task, term disposition, case write) bells the office — a missing refund
  // task must never disappear into logs behind a green processor result.
  if (!processed || errors.length) {
    try {
      const NotificationService = require('./notification-service');
      await NotificationService.notifyAdmin(
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
    } catch (notifErr) {
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
        refund_amount: refund ? refund.amount : null,
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
    lateFeeWaived: input.waiveLateFee,
    prepayDisposition: prepayPlan.prepayDisposition,
    prepayTermOutcome: termOutcome,
    ...(refund ? { refund } : {}),
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
};
