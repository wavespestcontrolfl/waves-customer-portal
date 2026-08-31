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
 *   end_now_refund   pull everything now, cancel the term's coverage, and
 *                    RECORD the refund (prepaid ÷ included visits × remaining
 *                    visits) on the case + an office task to issue it to the
 *                    original method. Never refunds through Stripe itself.
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

async function liveTermFor(customerId) {
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const term = await coveredTermsAsOf(db, etDateString())
    .where('t.customer_id', customerId)
    .first('t.id', 't.term_start', 't.term_end', 't.plan_label', 't.prepay_amount',
      't.coverage_visit_count', 't.coverage_service_type', 't.status', 't.renewal_decision');
  return term || null;
}

const dateOnly = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/**
 * Ruling C-6: prepaid amount ÷ included visits × remaining visits. Included
 * visits = the term's coverage_visit_count; completed = covered visits
 * (annual-prepay stamp) already completed inside the term window. When the
 * count is not on the term the refund is recorded as needing a manual
 * calculation — never invented.
 */
async function computePrepayRefund(term) {
  const { ANNUAL_PREPAY_PREPAID_METHOD } = require('./annual-prepay-renewals');
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
  let completed = [];
  try {
    completed = await db('scheduled_services')
      .where({ customer_id: term.customer_id, status: 'completed', prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD })
      .whereBetween('scheduled_date', [dateOnly(term.term_start), dateOnly(term.term_end)])
      .select('id');
  } catch (err) {
    logger.warn(`[admin-cancellation] covered-visit count failed for term ${term.id}: ${err.message}`);
    return { ...base, reason: 'covered_visit_count_failed' };
  }
  const completedVisits = Array.isArray(completed) ? completed.length : 0;
  const remainingVisits = Math.max(0, base.includedVisits - completedVisits);
  const amount = Math.round((base.prepaidAmount / base.includedVisits) * remainingVisits * 100) / 100;
  return { ...base, completedVisits, remainingVisits, amount, needsManualCalc: false };
}

// Resolve scope against ownership. Returns { wholeAccount, scope, plan,
// scopeError } — scopeError is set (never thrown) so the preview can show it;
// the commit path turns it into a 409.
async function resolveScope(customerId, families) {
  if (!families.length) return { wholeAccount: true, scope: [], plan: null, scopeError: null };
  const plan = await planScopedWindDown(customerId, families);
  if (plan.ok) return { wholeAccount: false, scope: plan.inScope, plan, scopeError: null };
  if (plan.error === 'scope_is_whole_account') return { wholeAccount: true, scope: [], plan: null, scopeError: null };
  return { wholeAccount: false, scope: families, plan: null, scopeError: plan.error };
}

function scopeErrorToHttp(scopeError) {
  if (scopeError === 'scope_not_owned') {
    return new CancelPlanError(409, 'scope_not_owned', 'That service is not on the plan any more. Refresh and try again.');
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
  const [eligible, impact] = await Promise.all([
    hasCancellableWork(customerId),
    buildCancellationImpact(customerId, wholeAccount ? [] : scope),
  ]);
  const term = wholeAccount ? await liveTermFor(customerId) : null;
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;
  const today = etDateString();
  return {
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
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
      dedupeKey: `prepay_refund:${request.id}`,
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

  const term = wholeAccount ? await liveTermFor(customerId) : null;
  const prepayPlan = resolvePrepay(input, term, wholeAccount);
  const refund = term && prepayPlan.prepayDisposition === 'end_now_refund'
    ? await computePrepayRefund({ ...term, customer_id: customerId })
    : null;

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
    result = await processCancellationRequest({
      customerId,
      reason: `Admin cancellation request ${request.id}`,
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

  // Annual-prepay term disposition (whole-account only).
  let termOutcome = null;
  if (term && prepayPlan.prepayDisposition) {
    try {
      if (prepayPlan.prepayDisposition === 'end_at_term') {
        const { recordDecision } = require('./annual-prepay-renewals');
        const decided = await recordDecision({
          termId: term.id,
          action: 'cancel',
          adminUserId: actorUserId,
          notes: `Cancel plan (${actorLabel}) — coverage kept through ${dateOnly(term.term_end)}; no renewal.`,
        });
        termOutcome = decided ? 'ends_at_term' : 'decision_already_recorded';
      } else {
        const ended = await db('annual_prepay_terms')
          .where({ id: term.id })
          .whereIn('status', ANNUAL_PREPAY_TERM_ACTIVE_STATUSES)
          .whereNull('renewal_decision')
          .update({
            status: 'cancelled',
            renewal_notes: `Cancel plan (${actorLabel}) — ended now; unused value refund recorded on the cancellation case.`,
            updated_at: new Date(),
          });
        termOutcome = ended ? 'ended_now' : 'term_not_live';
        await raisePrepayRefundTask({ customer, request, term, refund, actorLabel });
      }
    } catch (err) {
      errors.push('prepay_term_disposition');
      logger.error(`[admin-cancellation] prepay term disposition failed for request ${request.id}: ${err.message}`);
    }
  }

  // The durable case (after the wind-down, like the portal path).
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
      snapshot: {
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
      },
      processed,
    });
  } catch (caseErr) {
    errors.push('case_write');
    logger.warn(`[admin-cancellation] case write failed for request ${request.id}: ${caseErr.message}`);
  }

  let confirmations = { smsSent: false, emailSent: false, channels: [] };
  if (input.sendConfirmation) {
    confirmations = await sendCancellationConfirmations({
      customer,
      request,
      result,
      processed,
      effectiveAt: prepayPlan.keepThrough ? `${prepayPlan.keepThrough}T12:00:00-04:00` : request.created_at,
      entryPoint: 'admin_cancel_plan',
      identityTrustLevel: 'admin_operator',
    });
  }

  // Exception-based: only a partial run bells the office.
  if (!processed) {
    try {
      const NotificationService = require('./notification-service');
      await NotificationService.notifyAdmin(
        'service',
        `Cancel plan did not fully complete for ${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        `${actorLabel} cancelled ${wholeAccount ? 'the whole plan' : scope.map(familyLabelOf).join(', ')} but auto-processing did not fully complete — review the calendar/account manually.`
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
