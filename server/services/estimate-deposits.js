/**
 * Required estimate-acceptance deposits.
 *
 * Policy (owner decision 2026-06-12): every estimate acceptance requires a
 * deposit — recurring, one-time, with or without a booked slot — EXCEPT:
 *   - prepay-annual acceptances (paying in full at accept), and
 *   - existing plan customers (WaveGuard Bronze and up), who skip the
 *     deposit but MUST book an appointment to accept.
 * The deposit is 25% of the first visit, clamped to $50–$99, charged before
 * acceptance commits, and credited toward the first invoice as a negative
 * line item. The deposit protects the accepted estimate from becoming a
 * soft "maybe", not just the calendar slot.
 *
 * DARK BY DEFAULT: the accept gate enforces only when
 * ESTIMATE_DEPOSIT_REQUIRED=true (rollout: ship dark → land the payment UI →
 * flip). The clamp keeps amount math deliberately simple: it derives from the
 * persisted estimate totals, is FIXED when the intent is created, and is not
 * re-litigated at accept — any verified received deposit satisfies the gate.
 *
 * Trust boundary: the gate never believes the client. A deposit counts only
 * when (a) the Stripe webhook recorded payment_intent.succeeded, or (b) the
 * accept request names a PaymentIntent that we retrieve LIVE from Stripe and
 * whose metadata pins it to this estimate — (b) closes the webhook race
 * without trusting the caller.
 */

const db = require('../models/db');
const logger = require('./logger');
const StripeService = require('./stripe');

const DEPOSIT_RATE = 0.25;
const DEPOSIT_FLOOR = 50;
const DEPOSIT_CAP = 99;

function isDepositEnforced() {
  const flag = process.env.ESTIMATE_DEPOSIT_REQUIRED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// 25% of the first-visit anchor, clamped to $50–$99. The anchor uses the
// persisted server-authoritative totals (one-time total for one-time work,
// else the monthly total as the recurring first-visit proxy) — the clamp is
// tight enough that replaying the full pricing cascade buys nothing.
function computeDepositAmount(estimate) {
  const oneTime = Number(estimate?.onetime_total);
  const monthly = Number(estimate?.monthly_total);
  const base = (Number.isFinite(oneTime) && oneTime > 0) ? oneTime
    : (Number.isFinite(monthly) && monthly > 0) ? monthly
    : null;
  if (!base) return DEPOSIT_FLOOR;
  return Math.min(DEPOSIT_CAP, Math.max(DEPOSIT_FLOOR, Math.round(base * DEPOSIT_RATE)));
}

// Resolve what acceptance requires for this estimate + chosen payment
// preference. membership comes from buildEstimateMembershipContext —
// isExistingCustomer means the customer already has qualifying recurring
// plan services (WaveGuard Bronze+). oneTimeUninvoiced = a one-time accept
// on a non-invoice-mode estimate: no invoice is created at accept, so there
// is nothing to credit the deposit against — exempt until completion-invoice
// crediting exists (otherwise the customer pays deposit + full visit).
function resolveDepositPolicy({ estimate, paymentMethodPreference, membership, oneTimeUninvoiced = false }) {
  if (!isDepositEnforced()) {
    return { enforced: false, required: false, slotRequired: false, exemptReason: 'feature_disabled' };
  }
  if (paymentMethodPreference === 'prepay_annual') {
    return { enforced: true, required: false, slotRequired: false, exemptReason: 'prepay_annual' };
  }
  if (membership?.isExistingCustomer) {
    // No deposit for plan customers — their commitment gate is booking the
    // appointment itself.
    return { enforced: true, required: false, slotRequired: true, exemptReason: 'existing_plan_customer' };
  }
  if (oneTimeUninvoiced) {
    return { enforced: true, required: false, slotRequired: false, exemptReason: 'one_time_pay_at_visit' };
  }
  return {
    enforced: true,
    required: true,
    slotRequired: false,
    exemptReason: null,
    amount: computeDepositAmount(estimate),
  };
}

async function receivedDepositTotal(estimateId) {
  const row = await db('estimate_deposits')
    .where({ estimate_id: estimateId })
    .whereIn('status', ['received', 'credited'])
    .sum({ total: 'amount' })
    .first();
  return Number(row?.total) || 0;
}

// Mark a deposit PaymentIntent received — idempotent on the unique PI id, so
// the webhook and accept-time verification can both fire in any order.
// MONOTONIC: only a pending row can advance to received. Accept can verify
// and credit the deposit before the webhook arrives; a late webhook must
// never downgrade credited (or refunded/failed) back to received, which
// would make the same money eligible for a second credit.
async function markDepositReceived({ paymentIntentId, estimateId, amountDollars }) {
  await db('estimate_deposits')
    .insert({
      estimate_id: estimateId,
      amount: amountDollars,
      stripe_payment_intent_id: paymentIntentId,
      status: 'received',
      received_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict('stripe_payment_intent_id')
    .ignore();
  await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntentId, status: 'pending' })
    .update({
      status: 'received',
      received_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
}

// A live-retrieved PaymentIntent counts only when Stripe says it succeeded
// AND its metadata pins it to THIS estimate — the id arrives from the
// client, so everything about it must be re-derived server-side.
function depositIntentMatchesEstimate(paymentIntent, estimateId) {
  return !!paymentIntent
    && paymentIntent.status === 'succeeded'
    && paymentIntent.metadata?.purpose === 'estimate_deposit'
    && String(paymentIntent.metadata?.estimate_id) === String(estimateId)
    && Number(paymentIntent.amount_received) > 0;
}

// Accept-time check: webhook-recorded deposit, else live verification of the
// PaymentIntent the client just paid (closes the webhook race). Returns
// { satisfied, receivedTotal }.
async function ensureDepositSatisfied({ estimate, depositPaymentIntentId = null }) {
  const recorded = await receivedDepositTotal(estimate.id);
  if (recorded > 0) return { satisfied: true, receivedTotal: recorded };

  if (depositPaymentIntentId) {
    let paymentIntent = null;
    try {
      paymentIntent = await StripeService.retrievePaymentIntent(depositPaymentIntentId);
    } catch (err) {
      logger.warn('[estimate-deposits] live PI verification failed', { error: err.message });
    }
    if (depositIntentMatchesEstimate(paymentIntent, estimate.id)) {
      const amountDollars = Math.round(paymentIntent.amount_received) / 100;
      await markDepositReceived({
        paymentIntentId: paymentIntent.id,
        estimateId: estimate.id,
        amountDollars,
      });
      // Ledger state is the authority, not Stripe's status: a refunded PI
      // still reports succeeded/amount_received, the monotonic mark above
      // touches 0 rows for it, and a refunded deposit must never unlock
      // acceptance.
      const row = await db('estimate_deposits')
        .where({ stripe_payment_intent_id: paymentIntent.id })
        .first('status', 'amount');
      if (row && ['received', 'credited'].includes(row.status)) {
        return { satisfied: true, receivedTotal: Number(row.amount) || amountDollars };
      }
      logger.warn('[estimate-deposits] PI succeeded on Stripe but ledger row is not received/credited — refusing to satisfy');
    }
  }

  return { satisfied: false, receivedTotal: 0 };
}

// Create (or idempotently reuse) the deposit PaymentIntent for an estimate
// and track it as pending. Returns { clientSecret, amount } for the payment
// UI, or null when Stripe isn't configured.
async function createDepositIntentForEstimate(estimate) {
  const amount = computeDepositAmount(estimate);
  const paymentIntent = await StripeService.createEstimateDepositIntent({
    estimateId: estimate.id,
    amountDollars: amount,
  });
  if (!paymentIntent) return null;

  await db('estimate_deposits')
    .insert({
      estimate_id: estimate.id,
      customer_id: estimate.customer_id || null,
      amount,
      stripe_payment_intent_id: paymentIntent.id,
      status: 'pending',
      updated_at: db.fn.now(),
    })
    .onConflict('stripe_payment_intent_id')
    .merge({ updated_at: db.fn.now() });

  return { clientSecret: paymentIntent.client_secret, amount, paymentIntentId: paymentIntent.id };
}

function parseEstimateDataBlob(estimate) {
  try {
    return typeof estimate?.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : (estimate?.estimate_data || {});
  } catch {
    return {};
  }
}

// A deposit intent minted while the estimate was acceptable can be paid
// AFTER the estimate expires, declines, or accepts through an exempt path.
// Re-run the eligibility gates at webhook time so stale money is refunded
// instead of recorded. Gate helpers live on the estimate-public router —
// lazy-required to avoid a service→route load cycle (same pattern as
// admin-estimate-persistence); if the gates can't load or error, fail
// toward RECORDING: the money has already been taken, and a tracked
// received row beats losing sight of it.
async function depositStillRecordable(estimateId) {
  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) return { recordable: false, reason: 'estimate_missing' };
  // Accepted, and this PI wasn't consumed (caller checked) — the customer
  // completed acceptance via prepay/another path; this payment is surplus.
  if (estimate.status === 'accepted') return { recordable: false, reason: 'accepted_without_this_deposit' };

  let gates = null;
  try {
    gates = require('../routes/estimate-public');
  } catch (err) {
    logger.warn('[estimate-deposits] eligibility gates unavailable — recording deposit', { error: err.message });
    return { recordable: true };
  }
  if (typeof gates.isEstimateAcceptActive === 'function' && !gates.isEstimateAcceptActive(estimate)) {
    return { recordable: false, reason: 'estimate_inactive' };
  }
  try {
    const estData = parseEstimateDataBlob(estimate);
    const pricingBundle = await gates.buildPricingBundle(estimate);
    const quoteRequirement = gates.resolveEstimateQuoteRequirement(pricingBundle, estData);
    if (quoteRequirement?.quoteRequired) return { recordable: false, reason: 'quote_required' };

    const { buildEstimateMembershipContext } = require('./estimate-membership-context');
    const membership = await buildEstimateMembershipContext(estimate);
    const oneTimeUninvoiced = typeof gates.isStructuralOneTimeOnlyEstimate === 'function'
      && gates.isStructuralOneTimeOnlyEstimate(estData, estimate)
      && estimate.bill_by_invoice !== true;
    const policy = resolveDepositPolicy({ estimate, paymentMethodPreference: null, membership, oneTimeUninvoiced });
    if (!policy.required) return { recordable: false, reason: policy.exemptReason || 'not_required' };
  } catch (err) {
    logger.warn('[estimate-deposits] eligibility recheck errored — recording deposit', { error: err.message });
  }
  return { recordable: true };
}

// Refund first, mark second — a row is only stamped refunded when Stripe
// confirmed the refund; on failure it stays pending for manual follow-up.
async function refundStaleDeposit(paymentIntent, estimateId, reason) {
  try {
    await StripeService.refundPaymentIntent(paymentIntent.id);
    await db('estimate_deposits')
      .insert({
        estimate_id: estimateId,
        amount: Math.round(Number(paymentIntent.amount_received) || 0) / 100,
        stripe_payment_intent_id: paymentIntent.id,
        status: 'refunded',
        updated_at: db.fn.now(),
      })
      .onConflict('stripe_payment_intent_id')
      .merge({ status: 'refunded', updated_at: db.fn.now() });
    logger.warn('[estimate-deposits] refunded stale deposit', { reason });
    return true;
  } catch (err) {
    logger.error('[estimate-deposits] stale deposit refund FAILED — row left pending for manual follow-up', {
      reason,
      error: err.message,
    });
    return false;
  }
}

// Webhook entry: a succeeded PaymentIntent whose metadata marks it as an
// estimate deposit. Routed from stripe-webhook.js BEFORE invoice handling.
// Replay-safe: rows accept already consumed (received/credited) or already
// refunded are untouched; otherwise eligibility is re-run and stale money
// is refunded instead of recorded.
async function handleDepositIntentSucceeded(paymentIntent) {
  const estimateId = paymentIntent?.metadata?.estimate_id;
  if (!estimateId) {
    logger.warn('[estimate-deposits] deposit PI succeeded without estimate_id metadata');
    return { handled: false };
  }

  const existing = await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntent.id })
    .first('status');
  if (existing && ['received', 'credited', 'refunded'].includes(existing.status)) {
    return { handled: true, replay: true };
  }

  const eligibility = await depositStillRecordable(estimateId);
  if (!eligibility.recordable) {
    const refunded = await refundStaleDeposit(paymentIntent, estimateId, eligibility.reason);
    if (!refunded) {
      // Throw so the webhook event is NOT marked processed and Stripe
      // retries — returning handled here would leave captured money behind
      // forever on a transient Stripe/DB error.
      throw new Error(`stale estimate-deposit refund failed (${eligibility.reason}) — webhook retry required`);
    }
    return { handled: true, refunded: true };
  }

  await markDepositReceived({
    paymentIntentId: paymentIntent.id,
    estimateId,
    amountDollars: Math.round(Number(paymentIntent.amount_received) || 0) / 100,
  });
  logger.info('[estimate-deposits] deposit received', { estimateId });
  return { handled: true };
}

// A refund or chargeback landing on a deposit PI — a Stripe-dashboard
// refund, a dispute, or the webhook echo of our own stale-deposit refund.
// Deposits have no payments row, so the payments-table refund path never
// sees them; this flips the ledger row so reversed money can never satisfy
// acceptance or be credited. Returns { handled } — handled=true means the
// PI was a deposit and the webhook caller must NOT run its payments logic.
async function handleDepositChargeReversed(paymentIntentId, context) {
  if (!paymentIntentId) return { handled: false };
  // CONDITIONAL flip with bounded re-read: an accept can credit the row
  // between our read and write. The update applies only to the exact state
  // the alert decision was based on; a lost transition re-reads and
  // re-decides, so a deposit credited mid-flight still fires the
  // manual-reconciliation alert instead of being silently overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db('estimate_deposits')
      .where({ stripe_payment_intent_id: paymentIntentId })
      .first('id', 'status', 'estimate_id', 'credited_amount', 'credited_invoice_id');
    if (!row) return { handled: false };
    if (row.status === 'refunded') return { handled: true, replay: true };

    const flippedCount = await db('estimate_deposits')
      .where({ id: row.id, status: row.status, credited_amount: row.credited_amount })
      .update({ status: 'refunded', updated_at: db.fn.now() });
    if (!flippedCount) continue;

    if (row.status === 'credited' || Number(row.credited_amount) > 0) {
      // Money already applied to an invoice as a negative line — the customer
      // now holds both the refund and the credit. Needs a human.
      logger.error('[estimate-deposits] reversed deposit was ALREADY credited to an invoice — manual reconciliation required', {
        estimateId: row.estimate_id,
        invoiceId: row.credited_invoice_id || null,
        context,
      });
    } else {
      logger.warn('[estimate-deposits] deposit reversed — ledger row flipped to refunded', { context });
    }
    return { handled: true };
  }
  // Could not win the transition race in 3 attempts — fail the webhook
  // event so Stripe retries rather than dropping the reversal.
  throw new Error('deposit reversal transition contention — webhook retry required');
}

// Dispute settled on a deposit PI. Lost = money stays gone (the row already
// flipped on dispute.created). Won/reinstated = funds returned to us, but
// the row stays refunded — auto-restoring would race acceptance/crediting,
// so flag for a manual restore instead.
async function handleDepositDisputeClosed(paymentIntentId, disputeStatus) {
  if (!paymentIntentId) return { handled: false };
  const row = await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .first('id', 'status', 'estimate_id');
  if (!row) return { handled: false };
  if (disputeStatus === 'won' || disputeStatus === 'funds_reinstated') {
    logger.error('[estimate-deposits] deposit dispute resolved in our favor — funds reinstated but ledger row stays refunded; restore manually if the estimate is still live', {
      estimateId: row.estimate_id,
      disputeStatus,
    });
  }
  return { handled: true };
}

// UNAPPLIED deposit balance for the first invoice: received rows minus
// whatever prior invoices already consumed (credited_amount), so a partial
// application can never be credited twice. Accepts a trx so accept-time
// reads share the consuming transaction's snapshot.
async function pendingDepositCredit(estimateId, trx = db) {
  const rows = await trx('estimate_deposits')
    .where({ estimate_id: estimateId, status: 'received' })
    .select('id', 'amount', 'credited_amount');
  const totalCents = rows.reduce((sum, row) => sum + Math.max(0,
    Math.round(Number(row.amount || 0) * 100) - Math.round(Number(row.credited_amount || 0) * 100)), 0);
  if (!(totalCents > 0)) return null;
  const total = totalCents / 100;
  return {
    amount: total,
    lineItem: {
      description: 'Deposit credit (paid at acceptance)',
      quantity: 1,
      unit_price: -total,
      amount: -total,
      category: 'deposit_credit',
    },
  };
}

// Allocate an applied credit against received rows (oldest first), tracking
// per-row credited_amount in integer cents. A row flips to 'credited' (and
// is stamped with the invoice) only when fully consumed; a partially
// consumed row stays 'received' with only its remainder available. Returns
// the dollars actually allocated.
async function consumeDepositCredit({ estimateId, amount, invoiceId, trx = db }) {
  let remainingCents = Math.round(Number(amount) * 100);
  if (!(remainingCents > 0)) return 0;
  const requestedCents = remainingCents;

  const rows = await trx('estimate_deposits')
    .where({ estimate_id: estimateId, status: 'received' })
    .orderBy('created_at', 'asc')
    .select('id', 'amount', 'credited_amount');

  for (const row of rows) {
    if (remainingCents <= 0) break;
    const availableCents = Math.round(Number(row.amount || 0) * 100)
      - Math.round(Number(row.credited_amount || 0) * 100);
    if (availableCents <= 0) continue;
    const takeCents = Math.min(availableCents, remainingCents);
    const newCreditedCents = Math.round(Number(row.credited_amount || 0) * 100) + takeCents;
    const fullyConsumed = newCreditedCents >= Math.round(Number(row.amount || 0) * 100);
    // CONDITIONAL transition: the update applies only if the row is still in
    // the exact state the allocation was computed from — a refund/dispute
    // webhook can flip it between select and update, and an unconditional
    // by-id write would mark refunded money credited. A lost row simply
    // doesn't count toward `allocated`; callers compare allocated to applied
    // and roll back / re-read on mismatch.
    const updatedCount = await trx('estimate_deposits')
      .where({ id: row.id, status: 'received', credited_amount: row.credited_amount })
      .update({
        credited_amount: newCreditedCents / 100,
        ...(fullyConsumed ? { status: 'credited', credited_invoice_id: invoiceId } : {}),
        updated_at: trx.fn.now(),
      });
    if (!updatedCount) continue;
    remainingCents -= takeCents;
  }

  return (requestedCents - remainingCents) / 100;
}

module.exports = {
  computeDepositAmount,
  consumeDepositCredit,
  createDepositIntentForEstimate,
  ensureDepositSatisfied,
  handleDepositChargeReversed,
  handleDepositDisputeClosed,
  handleDepositIntentSucceeded,
  isDepositEnforced,
  pendingDepositCredit,
  resolveDepositPolicy,
  _private: {
    DEPOSIT_RATE,
    DEPOSIT_FLOOR,
    DEPOSIT_CAP,
    depositIntentMatchesEstimate,
    depositStillRecordable,
    markDepositReceived,
    receivedDepositTotal,
    refundStaleDeposit,
  },
};
