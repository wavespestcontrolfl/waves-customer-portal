/**
 * Required estimate-acceptance deposits.
 *
 * Policy (owner decision 2026-06-12, revised same day to FLAT amounts):
 * every estimate acceptance requires a deposit — recurring, one-time, with
 * or without a booked slot — EXCEPT:
 *   - prepay-annual acceptances (paying in full at accept), and
 *   - existing plan customers (WaveGuard Bronze and up), who skip the
 *     deposit but MUST book an appointment to accept.
 * The deposit is a flat per-service-class amount — $49 for recurring plans,
 * $99 for one-time / intensive jobs (pricing_config-authoritative via
 * constants.DEPOSIT) — NEVER a percentage: the deposit's job is commitment,
 * not proportional cash collection, and flat amounts keep the ask explainable
 * ("Reserve your appointment with a $49 deposit"). It is charged before
 * acceptance commits and credited toward the first invoice as a negative
 * line item; an unapplied remainder stays on the ledger and rolls forward to
 * later service-record invoices for the same estimate (createFromService),
 * which is also how one-time pay-at-visit deposits get credited — their
 * first invoice is the completed-visit invoice.
 *
 * DARK BY DEFAULT: the accept gate enforces only when
 * ESTIMATE_DEPOSIT_REQUIRED=true (rollout: ship dark → land the payment UI →
 * flip). The amount derives from the service class, is FIXED when the intent
 * is created, and is not re-litigated at accept — any verified received
 * deposit satisfies the gate.
 *
 * Trust boundary: the gate never believes the client. A deposit counts only
 * when (a) the Stripe webhook recorded payment_intent.succeeded, or (b) the
 * accept request names a PaymentIntent that we retrieve LIVE from Stripe and
 * whose metadata pins it to this estimate — (b) closes the webhook race
 * without trusting the caller.
 *
 * Refund discipline: any path that refunds deposit money CLAIMS the ledger
 * row first (conditional transition into 'refunding'), calls Stripe second,
 * and stamps the terminal state third — so a refund can never race an
 * accept that is concurrently consuming the same row, and a failed Stripe
 * call reverts the claim instead of stranding it.
 */

const db = require('../models/db');
const logger = require('./logger');
const StripeService = require('./stripe');
const { DEPOSIT } = require('./pricing-engine/constants');

function isDepositEnforced() {
  const flag = process.env.ESTIMATE_DEPOSIT_REQUIRED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Flat per-service-class amount. constants.DEPOSIT is overlaid from the
// pricing_config row `estimate_deposit` by db-bridge syncConstantsFromDB(),
// so admin re-tunes apply without a redeploy.
function computeDepositAmount({ oneTime = false } = {}) {
  const amount = oneTime ? Number(DEPOSIT.oneTimeAmount) : Number(DEPOSIT.recurringAmount);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : (oneTime ? 99 : 49);
}

// Resolve what acceptance requires for this estimate + chosen payment
// preference. membership comes from buildEstimateMembershipContext —
// isExistingCustomer means the customer already has qualifying recurring
// plan services (WaveGuard Bronze+). oneTime selects the service class for
// the AMOUNT only — one-time accepts are NOT exempt: a one-time pay-at-visit
// deposit credits against the completed-visit invoice via the
// createFromService roll-forward.
function resolveDepositPolicy({ estimate, paymentMethodPreference, membership, oneTime = false }) {
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
  return {
    enforced: true,
    required: true,
    slotRequired: false,
    exemptReason: null,
    amount: computeDepositAmount({ oneTime }),
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
// { satisfied, receivedTotal }. requiredAmount enforces the RESOLVED policy
// amount, not mere presence — a $49 recurring deposit must not unlock a
// one-time accept that owes $99 (under-collection via mode switch); without
// it, any positive received money satisfies (legacy semantics).
async function ensureDepositSatisfied({ estimate, depositPaymentIntentId = null, requiredAmount = null }) {
  const requiredCents = Number.isFinite(Number(requiredAmount)) && Number(requiredAmount) > 0
    ? Math.round(Number(requiredAmount) * 100)
    : 1;
  const recorded = await receivedDepositTotal(estimate.id);
  if (Math.round(recorded * 100) >= requiredCents) {
    return { satisfied: true, receivedTotal: recorded };
  }

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
      // acceptance. Re-sum the whole ledger — the live PI may be a top-up
      // beside an earlier recorded deposit.
      const row = await db('estimate_deposits')
        .where({ stripe_payment_intent_id: paymentIntent.id })
        .first('status', 'amount');
      if (row && ['received', 'credited'].includes(row.status)) {
        const total = await receivedDepositTotal(estimate.id);
        if (Math.round(total * 100) >= requiredCents) {
          return { satisfied: true, receivedTotal: total };
        }
        logger.warn('[estimate-deposits] received deposit is below the required policy amount', {
          receivedTotal: total,
          requiredAmount,
        });
        return { satisfied: false, receivedTotal: total };
      }
      logger.warn('[estimate-deposits] PI succeeded on Stripe but ledger row is not received/credited — refusing to satisfy');
    }
  }

  return { satisfied: false, receivedTotal: recorded };
}

// Create (or idempotently reuse) the deposit PaymentIntent for an estimate
// and track it as pending. Returns { clientSecret, amount } for the payment
// UI, or null when Stripe isn't configured.
async function createDepositIntentForEstimate(estimate, { oneTime = false } = {}) {
  const amount = computeDepositAmount({ oneTime });
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
    const structuralOneTime = typeof gates.isStructuralOneTimeOnlyEstimate === 'function'
      && gates.isStructuralOneTimeOnlyEstimate(estData, estimate);
    const policy = resolveDepositPolicy({ estimate, paymentMethodPreference: null, membership, oneTime: structuralOneTime });
    if (!policy.required) return { recordable: false, reason: policy.exemptReason || 'not_required' };
  } catch (err) {
    logger.warn('[estimate-deposits] eligibility recheck errored — recording deposit', { error: err.message });
  }
  return { recordable: true };
}

// Claim the ledger row for a refund BEFORE calling Stripe: a conditional
// transition into 'refunding' from the exact observed state. Once claimed,
// markDepositReceived (pending→received only) and consumeDepositCredit
// (received only) can no longer touch the row, so the money cannot be
// consumed mid-refund. Returns { claimed, row } — claimed=false with a
// row means another path owns the money (e.g. accept consumed it).
async function claimDepositRowForRefund({ paymentIntentId, estimateId, amountDollars, fromStatuses }) {
  await db('estimate_deposits')
    .insert({
      estimate_id: estimateId,
      amount: amountDollars,
      stripe_payment_intent_id: paymentIntentId,
      status: 'refunding',
      updated_at: db.fn.now(),
    })
    .onConflict('stripe_payment_intent_id')
    .ignore();
  await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .whereIn('status', fromStatuses)
    .update({ status: 'refunding', updated_at: db.fn.now() });
  const row = await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .first('id', 'status', 'amount', 'credited_amount', 'refunded_amount');
  return { claimed: row?.status === 'refunding', row };
}

// Stale-deposit refund with the claim-first discipline (P1: a
// payment_intent.succeeded webhook racing an accept that live-verifies the
// same PI must not refund money the accept just consumed). Returns
// 'refunded' | 'consumed' (accept owns it — treat as received) | 'failed'.
async function refundStaleDeposit(paymentIntent, estimateId, reason) {
  const amountDollars = Math.round(Number(paymentIntent.amount_received) || 0) / 100;
  const { claimed, row } = await claimDepositRowForRefund({
    paymentIntentId: paymentIntent.id,
    estimateId,
    amountDollars,
    fromStatuses: ['pending', 'refunding'],
  });
  if (!claimed) {
    if (row && ['received', 'credited'].includes(row.status)) return 'consumed';
    if (row?.status === 'refunded') return 'refunded';
    return 'failed';
  }
  try {
    await StripeService.refundPaymentIntent(paymentIntent.id);
    await db('estimate_deposits')
      .where({ stripe_payment_intent_id: paymentIntent.id, status: 'refunding' })
      .update({
        status: 'refunded',
        refunded_amount: amountDollars,
        updated_at: db.fn.now(),
      });
    logger.warn('[estimate-deposits] refunded stale deposit', { reason });
    return 'refunded';
  } catch (err) {
    // Revert the claim — the money is still captured and the row must say
    // so; the thrown webhook retry will re-claim and re-attempt.
    await db('estimate_deposits')
      .where({ stripe_payment_intent_id: paymentIntent.id, status: 'refunding' })
      .update({ status: 'pending', updated_at: db.fn.now() })
      .catch(() => {});
    logger.error('[estimate-deposits] stale deposit refund FAILED — claim reverted for retry', {
      reason,
      error: err.message,
    });
    return 'failed';
  }
}

// Exempt-path sweep (post-accept): when an acceptance completes through a
// path that owes no deposit (prepay-annual, existing plan customer) — or
// after the first-invoice credit left a remainder nothing will consume —
// refund whatever 'received' money was never applied. Partial rows refund
// only their unapplied remainder; the credited slice stays credited.
// Best-effort by design: a Stripe failure reverts the claim, raises the
// reconcile alert, and leaves the truth on the ledger.
async function refundUnconsumedDeposits({ estimateId, reason }) {
  const rows = await db('estimate_deposits')
    .where({ estimate_id: estimateId, status: 'received' })
    .select('id', 'stripe_payment_intent_id', 'amount', 'credited_amount');

  let refunded = 0;
  for (const row of rows) {
    const remainderCents = Math.round(Number(row.amount || 0) * 100)
      - Math.round(Number(row.credited_amount || 0) * 100);
    if (remainderCents <= 0) continue;

    const claimedCount = await db('estimate_deposits')
      .where({ id: row.id, status: 'received', credited_amount: row.credited_amount })
      .update({ status: 'refunding', updated_at: db.fn.now() });
    if (!claimedCount) continue; // consumed or reversed mid-sweep — their win

    const creditedCents = Math.round(Number(row.credited_amount || 0) * 100);
    try {
      await StripeService.refundPaymentIntent(row.stripe_payment_intent_id, {
        amountCents: remainderCents,
      });
      await db('estimate_deposits')
        .where({ id: row.id, status: 'refunding' })
        .update({
          status: creditedCents > 0 ? 'credited' : 'refunded',
          refunded_amount: remainderCents / 100,
          updated_at: db.fn.now(),
        });
      refunded += remainderCents / 100;
    } catch (err) {
      await db('estimate_deposits')
        .where({ id: row.id, status: 'refunding' })
        .update({ status: 'received', updated_at: db.fn.now() })
        .catch(() => {});
      logger.error('[estimate-deposits] unconsumed-deposit refund FAILED — row reverted to received', {
        estimateId,
        reason,
        error: err.message,
      });
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('estimate_deposit_reconcile_needed', { estimateId });
      } catch (notifyErr) {
        logger.error('[estimate-deposits] failed to raise deposit reconcile alert', { error: notifyErr.message });
      }
    }
  }
  if (refunded > 0) {
    logger.info('[estimate-deposits] refunded unconsumed deposit money', { estimateId, reason, refunded });
  }
  return { refunded };
}

// Lifecycle sweep: refund received-but-never-consumed deposits sitting on
// TERMINAL estimates (declined/expired). The webhook staleness gate only
// catches money landing AFTER the estimate went terminal; money received
// while it was live — customer paid the deposit then closed the browser,
// the accept request failed, or they later declined — has no other refund
// path and would strand forever. Accepted estimates are deliberately NOT
// swept: their unapplied remainder rolls forward to later service invoices.
// Runs daily from the estimate-expiration worker (self-healing for any
// terminal flip regardless of origin, including admin-side status changes)
// and inline from the public decline route for immediacy. Per-estimate
// failure isolation; refundUnconsumedDeposits owns the claim-first
// discipline and the reconcile alert on Stripe failure.
async function sweepTerminalEstimateDeposits() {
  const rows = await db('estimate_deposits as ed')
    .join('estimates as e', 'e.id', 'ed.estimate_id')
    .where('ed.status', 'received')
    .whereIn('e.status', ['declined', 'expired'])
    .distinct('ed.estimate_id');

  let estimatesSwept = 0;
  let refundedTotal = 0;
  for (const row of rows) {
    try {
      const { refunded } = await refundUnconsumedDeposits({
        estimateId: row.estimate_id,
        reason: 'terminal_estimate_sweep',
      });
      if (refunded > 0) {
        estimatesSwept += 1;
        refundedTotal += refunded;
      }
    } catch (err) {
      logger.error('[estimate-deposits] terminal-estimate deposit sweep failed for one estimate', {
        estimateId: row.estimate_id,
        error: err.message,
      });
    }
  }
  if (estimatesSwept > 0) {
    logger.info('[estimate-deposits] terminal-estimate deposit sweep refunded stranded money', {
      estimatesSwept,
      refundedTotal,
    });
  }
  return { estimatesSwept, refundedTotal };
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
    const outcome = await refundStaleDeposit(paymentIntent, estimateId, eligibility.reason);
    if (outcome === 'consumed') {
      // An accept live-verified and consumed this PI between our checks —
      // the money is legitimately applied; nothing stale to refund.
      return { handled: true, replay: true };
    }
    if (outcome === 'failed') {
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
// refund, a dispute, or the webhook echo of our own refunds (stale deposit,
// exempt-path sweep, unapplied remainder). Deposits have no payments row, so
// the payments-table refund path never sees them; this flips the ledger row
// so reversed money can never satisfy acceptance or be credited. Returns
// { handled } — handled=true means the PI was a deposit and the webhook
// caller must NOT run its payments logic. amountRefundedCents (the charge's
// cumulative refund total, when the caller has it) distinguishes the echo of
// our own recorded refund from a genuinely larger dashboard reversal.
async function handleDepositChargeReversed(paymentIntentId, context, { amountRefundedCents = null } = {}) {
  if (!paymentIntentId) return { handled: false };
  // CONDITIONAL flip with bounded re-read: an accept can credit the row
  // between our read and write. The update applies only to the exact state
  // the alert decision was based on; a lost transition re-reads and
  // re-decides, so a deposit credited mid-flight still fires the
  // manual-reconciliation alert instead of being silently overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db('estimate_deposits')
      .where({ stripe_payment_intent_id: paymentIntentId })
      .first('id', 'status', 'estimate_id', 'amount', 'credited_amount', 'credited_invoice_id', 'refunded_amount');
    if (!row) return { handled: false };
    if (row.status === 'refunded') return { handled: true, replay: true };

    const recordedRefundCents = Math.round(Number(row.refunded_amount || 0) * 100);
    if (amountRefundedCents != null && recordedRefundCents > 0 && amountRefundedCents <= recordedRefundCents) {
      // Echo of a refund WE issued and stamped (sweep / remainder) — the row
      // already reflects it; a 'credited' row here keeps its credit because
      // only the unapplied remainder was returned.
      return { handled: true, replay: true };
    }
    if (row.status === 'refunding') {
      // Echo arrived before our own terminal stamp — write the SAME terminal
      // state the refund path would have: a partially credited row keeps its
      // credit (only the unapplied remainder was refunded; flipping it to
      // 'refunded' would no-op the refunder's stamp and erase a credit the
      // invoice still carries), and refunded_amount records the remainder so
      // later echoes are recognized as replays. The refunder's own pending
      // stamp is status='refunding'-guarded, so it no-ops harmlessly after us.
      const creditedCents = Math.round(Number(row.credited_amount || 0) * 100);
      const amountCents = Math.round(Number(row.amount || 0) * 100);
      const remainderCents = Math.max(amountCents - creditedCents, 0);
      const flipped = await db('estimate_deposits')
        .where({ id: row.id, status: 'refunding' })
        .update({
          status: creditedCents > 0 ? 'credited' : 'refunded',
          refunded_amount: remainderCents / 100,
          updated_at: db.fn.now(),
        });
      if (!flipped) continue;
      logger.warn('[estimate-deposits] deposit reversal echo landed mid-refund — terminal state stamped for the in-flight refund', {
        context,
        keptCreditedAmount: creditedCents > 0 ? creditedCents / 100 : 0,
        refundedAmount: remainderCents / 100,
      });
      return { handled: true };
    }

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
  refundUnconsumedDeposits,
  resolveDepositPolicy,
  sweepTerminalEstimateDeposits,
  _private: {
    claimDepositRowForRefund,
    depositIntentMatchesEstimate,
    depositStillRecordable,
    markDepositReceived,
    receivedDepositTotal,
    refundStaleDeposit,
  },
};
