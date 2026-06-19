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
const { etDateString } = require('../utils/datetime-et');

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
// the AMOUNT — one-time accepts are NOT exempt: a one-time pay-at-visit
// deposit credits against the completed-visit invoice via the
// createFromService roll-forward. oneTimeUninvoiced (one-time accept on a
// non-invoice-mode estimate) additionally REQUIRES a booking: no invoice is
// created at accept, so the credit's only path back to the customer is the
// roll-forward, which traces scheduled_services.source_estimate_id — an
// unbooked accept would orphan the paid deposit (accepted estimates are
// deliberately outside the terminal sweep).
function resolveDepositPolicy({ estimate, paymentMethodPreference, membership, oneTime = false, oneTimeUninvoiced = false }) {
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
    slotRequired: oneTimeUninvoiced,
    exemptReason: null,
    amount: computeDepositAmount({ oneTime }),
  };
}

// Resolve the scheduled_service whose payer the eventual invoice will use, so a
// per-job payer (scheduled_services.payer_id) exempts the deposit even when the
// customer has no default payer. Precedence: an explicit/committed appointment,
// else the estimate's persisted estimate_data.scheduled_service_id, else an
// appointment linked only by source_estimate_id (the converter's reservation
// linkage — what findLinkedUpcomingAppointment also matches on). Scoped to the
// customer. `strict` re-throws DB errors for fail-closed callers (the nudge);
// default fail-soft to null = "no per-job payer found" for collection paths.
async function linkedScheduledServiceId(estimate, explicitId = null, { strict = false } = {}) {
  if (explicitId) return String(explicitId);
  const estData = parseEstimateDataBlob(estimate);
  if (estData?.scheduled_service_id) return String(estData.scheduled_service_id);
  if (estimate?.id && estimate?.customer_id) {
    try {
      // Mirror findLinkedUpcomingAppointment's live-appointment constraints so a
      // past / cancelled / expired-reservation row can never waive the deposit or
      // set a stale payer scope: pending|confirmed, future-dated (ET), non-expired
      // reservation, earliest first.
      const row = await db('scheduled_services')
        .where({ source_estimate_id: estimate.id, customer_id: estimate.customer_id })
        .whereNotNull('payer_id')
        .whereIn('status', ['pending', 'confirmed'])
        .where('scheduled_date', '>=', etDateString())
        .where((qb) => {
          qb.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()');
        })
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .first('id');
      if (row?.id) return String(row.id);
    } catch (err) {
      if (strict) throw err;
      // non-strict: a failed lookup just means "no source-linked per-job payer".
    }
  }
  return null;
}

// Policy resolution with the LIVE existing-plan-customer fallback. The
// pricing snapshot (estimate_data.membershipSnapshot) is deliberately frozen
// at save time and absent on legacy customer-linked estimates, so exempting
// only on the snapshot would charge a commitment deposit to a current
// WaveGuard member (and bypass their appointment-only gate). Display pricing
// stays snapshot-frozen; whether a customer owes a deposit follows their
// CURRENT qualifying recurring services. A failed live check falls back to
// requiring the deposit — wrongly charged money still credits forward,
// while a wrongly granted exemption silently loses the commitment gate.
async function resolveDepositPolicyForEstimate({ estimate, paymentMethodPreference = null, membership = null, oneTime = false, oneTimeUninvoiced = false, scheduledServiceId = null }) {
  let member = membership;
  if (!member?.isExistingCustomer && estimate?.customer_id && isDepositEnforced()) {
    try {
      const { loadExistingRecurringQualifyingRows } = require('./waveguard-existing-services');
      const rows = await loadExistingRecurringQualifyingRows(db, estimate.customer_id);
      if (Array.isArray(rows) && rows.length > 0) {
        member = { ...(member || {}), isExistingCustomer: true };
      }
    } catch (err) {
      logger.warn('[estimate-deposits] live plan-customer check failed — deposit stays required', { error: err.message });
    }
  }
  const policy = resolveDepositPolicy({ estimate, paymentMethodPreference, membership: member, oneTime, oneTimeUninvoiced });
  // Third-party Bill-To: a payer-billed customer's invoices route to the payer's
  // AP inbox, and payer invoices reject homeowner deposit credit (invoice.create
  // skips depositCredit when a payer resolves) — so an acceptance deposit
  // collected from the homeowner could never be applied and would strand. When a
  // deposit WOULD be required, exempt it at the source (no prompt) if the customer
  // resolves to a payer. Only the `required` gate is overridden — slotRequired and
  // any already-exempt policy (e.g. existing_plan_customer's booking gate) are
  // left intact, so we never override a policy that isn't charging a deposit.
  // resolveForInvoice never throws (fails soft to self-pay); a miss/error falls
  // through to the computed policy, the safe direction (a wrongly-charged self-pay
  // deposit still credits forward; only a wrongly-granted exemption is unsafe).
  if (policy.required && estimate?.customer_id) {
    try {
      const PayerService = require('./payer');
      // Match the eventual invoice's payer precedence (scheduled_services.payer_id
      // ?? customers.payer_id): scope by the appointment the estimate is tied to
      // (committed > persisted link > source_estimate_id) so a per-job payer with
      // no customer default is still caught.
      const linkedSsId = await linkedScheduledServiceId(estimate, scheduledServiceId);
      const resolved = await PayerService.resolveForInvoice({ customerId: estimate.customer_id, scheduledServiceId: linkedSsId });
      if (resolved?.payerId) {
        return { enforced: policy.enforced, required: false, slotRequired: policy.slotRequired, exemptReason: 'payer_billed' };
      }
    } catch (err) {
      logger.warn('[estimate-deposits] payer check failed — deposit policy unchanged', { error: err.message });
    }
  }
  return policy;
}

// Money the customer has paid and still holds with us: received/credited
// rows MINUS any partial refunds already returned (a dashboard refund of
// half a deposit must not keep satisfying the accept gate at full value).
async function receivedDepositTotal(estimateId) {
  const rows = await db('estimate_deposits')
    .where({ estimate_id: estimateId })
    .whereIn('status', ['received', 'credited'])
    .select('amount', 'refunded_amount');
  const totalCents = rows.reduce((sum, row) => sum + Math.max(0,
    Math.round(Number(row.amount || 0) * 100) - Math.round(Number(row.refunded_amount || 0) * 100)), 0);
  return totalCents / 100;
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
// and track it as pending. Charges only the MISSING amount: money already
// received counts toward the policy (the gate sums the ledger the same
// way), so a customer who paid the $49 recurring deposit and then switched
// to one-time owes a $50 top-up, not a fresh $99 — and a switch the other
// way owes nothing. The Stripe idempotency key includes the amount, so a
// changed balance mints a new intent while retries at the same balance
// reuse the old one. Returns { clientSecret, amount } for the payment UI,
// { alreadySatisfied: true } when the ledger already covers the policy, or
// null when Stripe isn't configured.
async function createDepositIntentForEstimate(estimate, { oneTime = false } = {}) {
  const requiredAmount = computeDepositAmount({ oneTime });
  const receivedTotal = await receivedDepositTotal(estimate.id);
  const missingCents = Math.round(requiredAmount * 100) - Math.round(receivedTotal * 100);
  if (missingCents <= 0) {
    return { alreadySatisfied: true, amount: 0, requiredAmount, receivedTotal };
  }
  const amount = missingCents / 100;
  // Refunded/disputed money must not poison retries: within Stripe's
  // idempotency window the bare estimate+amount key would hand back the OLD
  // succeeded (and refunded) PI, whose terminal ledger row can never satisfy
  // the gate — the customer would be stuck unable to pay a replacement
  // deposit. Terminal rows only grow, so their count is a monotonic retry
  // generation that mints a fresh PI after every refund/failure while
  // same-generation retries still reuse one intent.
  const terminalCountRow = await db('estimate_deposits')
    .where({ estimate_id: estimate.id })
    .whereIn('status', ['refunding', 'refunded', 'failed'])
    .count({ n: '*' })
    .first();
  const retryGeneration = Number(terminalCountRow?.n || 0);
  const paymentIntent = await StripeService.createEstimateDepositIntent({
    estimateId: estimate.id,
    amountDollars: amount,
    retryGeneration,
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

  return {
    clientSecret: paymentIntent.client_secret,
    amount,
    paymentIntentId: paymentIntent.id,
    requiredAmount,
    receivedTotal,
  };
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
    const policy = await resolveDepositPolicyForEstimate({
      estimate,
      paymentMethodPreference: null,
      membership,
      oneTime: structuralOneTime,
      oneTimeUninvoiced: structuralOneTime && estimate.bill_by_invoice !== true,
    });
    if (!policy.required) return { recordable: false, reason: policy.exemptReason || 'not_required' };
  } catch (err) {
    logger.warn('[estimate-deposits] eligibility recheck errored — recording deposit', { error: err.message });
  }
  return { recordable: true };
}

// Abandonment window for the deposit follow-up nudge: the latest pending
// intent must have been last touched between these bounds. Under 2h the
// customer may still be mid-payment; over 72h the expiring stage owns the
// end-of-life messaging. Shared with the cron's candidate query AND
// re-enforced at send time inside assessDepositFollowUpEligibility.
const DEPOSIT_FOLLOWUP_WINDOW = { minAgeHours: 2, maxAgeHours: 72 };

// Outbound-nudge eligibility for the estimate follow-up cron's
// deposit-abandonment stage. Mirrors depositStillRecordable's checks with
// the OPPOSITE failure policy: that probe fails OPEN because captured money
// must be recorded even when the gates can't be verified; an unprompted SMS
// must fail CLOSED — if eligibility can't be verified, we simply don't text.
// That inversion includes the live plan-customer check: the accept-gate
// resolver deliberately treats a failed lookup as "deposit required" (money
// wrongly charged still credits forward), but here a failed lookup must
// SKIP — texting an existing plan customer for a deposit they don't owe is
// the worse error. So the live check runs HERE, unguarded (a throw falls
// through to the fail-closed catch), and the resolved membership is passed
// to the sync policy resolver so no internal fallback can mask it.
// Nets received money out, so the nudge never duns money already paid,
// quotes the real outstanding amount (top-up remainders included), and goes
// silent the moment the policy is satisfied or stops requiring a deposit.
async function assessDepositFollowUpEligibility(estimateId, now = new Date()) {
  try {
    const estimate = await db('estimates').where({ id: estimateId }).first();
    if (!estimate) return { eligible: false, reason: 'estimate_missing' };
    if (!['sent', 'viewed'].includes(estimate.status)) {
      return { eligible: false, reason: `status:${estimate.status}` };
    }
    const gates = require('../routes/estimate-public');
    if (typeof gates.isEstimateAcceptActive !== 'function' || !gates.isEstimateAcceptActive(estimate)) {
      return { eligible: false, reason: 'estimate_inactive' };
    }
    const estData = parseEstimateDataBlob(estimate);
    const pricingBundle = await gates.buildPricingBundle(estimate);
    const quoteRequirement = gates.resolveEstimateQuoteRequirement(pricingBundle, estData);
    if (quoteRequirement?.quoteRequired) return { eligible: false, reason: 'quote_required' };

    const { buildEstimateMembershipContext } = require('./estimate-membership-context');
    let membership = await buildEstimateMembershipContext(estimate);
    if (!membership?.isExistingCustomer && estimate.customer_id) {
      // Fail-closed live plan-customer check (see header comment): no catch —
      // a lookup failure must skip the SMS, not default to "required".
      const { loadExistingRecurringQualifyingRows } = require('./waveguard-existing-services');
      const rows = await loadExistingRecurringQualifyingRows(db, estimate.customer_id);
      if (Array.isArray(rows) && rows.length > 0) {
        membership = { ...(membership || {}), isExistingCustomer: true };
      }
    }
    const structuralOneTime = typeof gates.isStructuralOneTimeOnlyEstimate === 'function'
      && gates.isStructuralOneTimeOnlyEstimate(estData, estimate);
    // Third-party Bill-To: a payer-billed customer is exempt (deposit-intent and
    // accept both skip the deposit), so never nudge them about an "outstanding
    // deposit". Fail-closed (throwOnError): a payer-lookup failure re-throws and
    // the outer catch returns eligibility_unverified — we must not text a
    // payer-billed homeowner just because verification blipped. Match invoice
    // precedence via the estimate's linked appointment (catches a per-job payer
    // with no customer default).
    if (estimate.customer_id) {
      const PayerService = require('./payer');
      // strict: a DB error in the linked-appointment lookup re-throws (→ outer
      // catch → eligibility_unverified), so a source-linked per-job payer is never
      // missed by a swallowed error and a payer-billed homeowner is never nudged.
      const linkedSsId = await linkedScheduledServiceId(estimate, null, { strict: true });
      const resolvedPayer = await PayerService.resolveForInvoice({
        customerId: estimate.customer_id,
        scheduledServiceId: linkedSsId,
        throwOnError: true,
      });
      if (resolvedPayer?.payerId) {
        return { eligible: false, reason: 'payer_billed' };
      }
    }
    const policy = resolveDepositPolicy({
      estimate,
      paymentMethodPreference: null,
      membership,
      oneTime: structuralOneTime,
      oneTimeUninvoiced: structuralOneTime && estimate.bill_by_invoice !== true,
    });
    if (!policy.required) {
      return { eligible: false, reason: policy.exemptReason || 'not_required' };
    }

    const netReceived = await receivedDepositTotal(estimateId);
    const outstanding = Math.round((policy.amount - netReceived) * 100) / 100;
    if (outstanding <= 0) return { eligible: false, reason: 'deposit_satisfied' };

    // A pending intent is what makes this "abandonment": the customer
    // reached the payment step and left it unfinished. No pending row means
    // they never started paying — that's the viewed/final stages' job.
    const pending = await db('estimate_deposits')
      .where({ estimate_id: estimateId, status: 'pending' })
      .orderBy('updated_at', 'desc')
      .first();
    if (!pending) return { eligible: false, reason: 'no_pending_intent' };

    // Re-enforce the abandonment window at send time: the candidate list was
    // read earlier in the cron tick, and a customer who reopened the payment
    // step since then (createDepositIntentForEstimate bumps updated_at on
    // reuse) must not be texted mid-payment. Unreadable timestamps fail
    // closed like everything else here.
    const lastTouchedMs = new Date(pending.updated_at).getTime();
    if (!Number.isFinite(lastTouchedMs)) {
      return { eligible: false, reason: 'pending_intent_unreadable' };
    }
    const ageMs = now.getTime() - lastTouchedMs;
    if (ageMs < DEPOSIT_FOLLOWUP_WINDOW.minAgeHours * 3600000) {
      return { eligible: false, reason: 'pending_intent_recent' };
    }
    if (ageMs > DEPOSIT_FOLLOWUP_WINDOW.maxAgeHours * 3600000) {
      return { eligible: false, reason: 'pending_intent_stale' };
    }

    return { eligible: true, outstandingAmount: outstanding };
  } catch (err) {
    logger.warn('[estimate-deposits] follow-up eligibility check failed — skipping nudge (fail closed)', { error: err.message });
    return { eligible: false, reason: 'eligibility_unverified' };
  }
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
    .select('id', 'stripe_payment_intent_id', 'amount', 'credited_amount', 'refunded_amount');

  let refunded = 0;
  for (const row of rows) {
    const priorRefundedCents = Math.round(Number(row.refunded_amount || 0) * 100);
    const remainderCents = Math.round(Number(row.amount || 0) * 100)
      - Math.round(Number(row.credited_amount || 0) * 100)
      - priorRefundedCents;
    if (remainderCents <= 0) continue;

    const claimedCount = await db('estimate_deposits')
      .where({
        id: row.id,
        status: 'received',
        credited_amount: row.credited_amount,
        refunded_amount: row.refunded_amount,
      })
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
          // Cumulative across partial refunds — this sweep returns only the
          // remainder on top of anything a dashboard refund already took.
          refunded_amount: (priorRefundedCents + remainderCents) / 100,
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
    const amountCents = Math.round(Number(row.amount || 0) * 100);
    const creditedCents = Math.round(Number(row.credited_amount || 0) * 100);
    // Unknown refund size (dispute path) = treat as a full reversal — fail
    // toward the loud path, never toward silently keeping money available.
    const refundCents = amountRefundedCents != null
      ? Math.min(amountRefundedCents, amountCents)
      : amountCents;
    const fullyRefunded = refundCents >= amountCents;
    // Does the cumulative refund reach past the unapplied remainder into
    // money an invoice already absorbed? That always needs a human.
    const refundTouchesCredit = creditedCents > 0
      && refundCents > Math.max(amountCents - creditedCents, 0);

    if (row.status === 'refunding') {
      // Echo arrived before our own terminal stamp — write the SAME terminal
      // state the refund path would have: a partially credited row keeps its
      // credit when the refund covers only the unapplied remainder (flipping
      // it to 'refunded' would no-op the refunder's stamp and erase a credit
      // the invoice still carries), and refunded_amount records the
      // cumulative refund so later echoes are recognized as replays. The
      // refunder's own pending stamp is status='refunding'-guarded, so it
      // no-ops harmlessly after us.
      const flipped = await db('estimate_deposits')
        .where({ id: row.id, status: 'refunding' })
        .update({
          status: !refundTouchesCredit && creditedCents > 0 ? 'credited' : 'refunded',
          refunded_amount: refundCents / 100,
          updated_at: db.fn.now(),
        });
      if (!flipped) continue;
      if (refundTouchesCredit) {
        logger.error('[estimate-deposits] reversed deposit was ALREADY credited to an invoice — manual reconciliation required', {
          estimateId: row.estimate_id,
          invoiceId: row.credited_invoice_id || null,
          context,
        });
      } else {
        logger.warn('[estimate-deposits] deposit reversal echo landed mid-refund — terminal state stamped for the in-flight refund', {
          context,
          keptCreditedAmount: creditedCents > 0 ? creditedCents / 100 : 0,
          refundedAmount: refundCents / 100,
        });
      }
      return { handled: true };
    }

    // PARTIAL reversal of a live row (dashboard refund of part of a
    // deposit): record the cumulative refund and KEEP the status — the
    // unrefunded remainder must stay able to satisfy acceptance and roll
    // forward as credit. Only a refund covering the full amount flips the
    // row terminal.
    const flippedCount = await db('estimate_deposits')
      .where({
        id: row.id,
        status: row.status,
        credited_amount: row.credited_amount,
        refunded_amount: row.refunded_amount,
      })
      .update({
        ...(fullyRefunded ? { status: 'refunded' } : {}),
        refunded_amount: refundCents / 100,
        updated_at: db.fn.now(),
      });
    if (!flippedCount) continue;

    if (refundTouchesCredit) {
      // Money already applied to an invoice as a negative line — the customer
      // now holds both the refund and the credit. Needs a human.
      logger.error('[estimate-deposits] reversed deposit was ALREADY credited to an invoice — manual reconciliation required', {
        estimateId: row.estimate_id,
        invoiceId: row.credited_invoice_id || null,
        context,
      });
    } else if (fullyRefunded) {
      logger.warn('[estimate-deposits] deposit reversed — ledger row flipped to refunded', { context });
    } else {
      logger.warn('[estimate-deposits] deposit partially reversed — remainder stays available', {
        context,
        refundedAmount: refundCents / 100,
      });
    }
    return { handled: true };
  }
  // Could not win the transition race in 3 attempts — fail the webhook
  // event so Stripe retries rather than dropping the reversal.
  throw new Error('deposit reversal transition contention — webhook retry required');
}

// Dispute settled on a deposit PI. Lost = money stays gone (the row already
// flipped on dispute.created). Won / reinstated / warning_closed (an
// inquiry closed without the money ever leaving — same funds-back outcome
// the invoice dispute path restores on) = funds are ours again, but the row
// stays refunded — auto-restoring would race acceptance/crediting, so flag
// for a manual restore instead.
async function handleDepositDisputeClosed(paymentIntentId, disputeStatus) {
  if (!paymentIntentId) return { handled: false };
  const row = await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .first('id', 'status', 'estimate_id');
  if (!row) return { handled: false };
  if (disputeStatus === 'won' || disputeStatus === 'funds_reinstated' || disputeStatus === 'warning_closed') {
    logger.error('[estimate-deposits] deposit dispute resolved in our favor — funds reinstated but ledger row stays refunded; restore manually if the estimate is still live', {
      estimateId: row.estimate_id,
      disputeStatus,
    });
  }
  return { handled: true };
}

// UNAPPLIED deposit balance for the first invoice: received rows minus
// whatever prior invoices already consumed (credited_amount) AND whatever
// was already returned to the customer (refunded_amount — partial dashboard
// refunds), so neither slice can ever be credited. Accepts a trx so
// accept-time reads share the consuming transaction's snapshot.
async function pendingDepositCredit(estimateId, trx = db) {
  const rows = await trx('estimate_deposits')
    .where({ estimate_id: estimateId, status: 'received' })
    .select('id', 'amount', 'credited_amount', 'refunded_amount');
  const totalCents = rows.reduce((sum, row) => sum + Math.max(0,
    Math.round(Number(row.amount || 0) * 100)
      - Math.round(Number(row.credited_amount || 0) * 100)
      - Math.round(Number(row.refunded_amount || 0) * 100)), 0);
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
    .select('id', 'amount', 'credited_amount', 'refunded_amount');

  for (const row of rows) {
    if (remainingCents <= 0) break;
    const refundedCents = Math.round(Number(row.refunded_amount || 0) * 100);
    const availableCents = Math.round(Number(row.amount || 0) * 100)
      - Math.round(Number(row.credited_amount || 0) * 100)
      - refundedCents;
    if (availableCents <= 0) continue;
    const takeCents = Math.min(availableCents, remainingCents);
    const newCreditedCents = Math.round(Number(row.credited_amount || 0) * 100) + takeCents;
    // Consumable ceiling shrinks by what was already refunded — a row is
    // exhausted when credit + refund together cover the full amount.
    const fullyConsumed = newCreditedCents + refundedCents >= Math.round(Number(row.amount || 0) * 100);
    // CONDITIONAL transition: the update applies only if the row is still in
    // the exact state the allocation was computed from — a refund/dispute
    // webhook can flip it (or grow refunded_amount) between select and
    // update, and an unconditional by-id write would mark refunded money
    // credited. A lost row simply doesn't count toward `allocated`; callers
    // compare allocated to applied and roll back / re-read on mismatch.
    const updatedCount = await trx('estimate_deposits')
      .where({
        id: row.id,
        status: 'received',
        credited_amount: row.credited_amount,
        refunded_amount: row.refunded_amount,
      })
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

// payment_intent.canceled on a deposit PI: a canceled intent can never
// succeed again, so its pending row goes terminal ('failed'). This also
// advances the idempotency retry generation — without it, a retry inside
// Stripe's idempotency window would be handed the same canceled
// client_secret until the window expired. Monotonic: ONLY pending rows
// flip. payment_intent.payment_failed deliberately does NOT land here — a
// declined attempt leaves the PI live and retryable, and flipping its row
// terminal would orphan money if a later attempt on the same PI succeeded.
async function handleDepositIntentCanceled(paymentIntent) {
  if (paymentIntent?.metadata?.purpose !== 'estimate_deposit' || !paymentIntent.id) {
    return { handled: false };
  }
  const updated = await db('estimate_deposits')
    .where({ stripe_payment_intent_id: paymentIntent.id, status: 'pending' })
    .update({ status: 'failed', updated_at: db.fn.now() });
  if (updated) {
    logger.info('[estimate-deposits] canceled deposit intent marked failed — retries will mint a fresh PI', {
      paymentIntentId: paymentIntent.id,
    });
  }
  return { handled: true };
}

// Reverse a voided invoice's deposit consumption. The voided invoice's own
// deposit_credit line items are the application record — each is stamped
// with its estimate_id by InvoiceService.create(). Per-row attribution is
// impossible (partial consumes never stamp credited_invoice_id), but the
// ledger is a pool per estimate, so returning the voided dollars to the
// estimate's live rows (newest consumption first) restores exactly what the
// void released. Rows in refund/dispute states are never touched — that
// money already left. A shortfall (unstamped legacy line, or rows flipped
// terminal under us) raises the reconcile alert and then THROWS: callers
// run this inside the void transaction, so the void rolls back rather than
// committing beside a still-consumed ledger with no retry path — a blocked
// void beats stranded money, and the human resolving the alert unblocks it.
// Returns dollars restored on full success.
async function restoreDepositCreditForVoidedInvoice({ invoice, trx = db }) {
  const items = (() => {
    try {
      const raw = invoice?.line_items;
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  })();
  const creditLines = items.filter((item) => item?.category === 'deposit_credit');
  let totalRequestedCents = 0;
  let totalRestoredCents = 0;
  for (const line of creditLines) {
    const requestedCents = Math.abs(Math.round(Number(line.amount ?? line.unit_price ?? 0) * 100));
    if (!(requestedCents > 0)) continue;
    totalRequestedCents += requestedCents;
    const estimateId = line.estimate_id || null;
    if (!estimateId) continue; // unstamped line — counted in the shortfall alert below
    let remainingCents = requestedCents;
    const rows = await trx('estimate_deposits')
      .where({ estimate_id: estimateId })
      .whereIn('status', ['received', 'credited'])
      .orderBy('updated_at', 'desc')
      .select('id', 'status', 'credited_amount');
    for (const row of rows) {
      if (remainingCents <= 0) break;
      const creditedCents = Math.round(Number(row.credited_amount || 0) * 100);
      if (creditedCents <= 0) continue;
      const giveCents = Math.min(creditedCents, remainingCents);
      // CONDITIONAL: only restore the exact state the math used — reversal
      // webhooks and concurrent consumes race this, and an unconditional
      // write could resurrect refunded money. A lost row simply doesn't
      // count toward the restored total.
      const updatedCount = await trx('estimate_deposits')
        .where({ id: row.id, status: row.status, credited_amount: row.credited_amount })
        .update({
          credited_amount: (creditedCents - giveCents) / 100,
          // A fully-consumed row becomes available again for later
          // roll-forwards or the terminal sweep.
          ...(row.status === 'credited' ? { status: 'received', credited_invoice_id: null } : {}),
          updated_at: trx.fn.now(),
        });
      if (!updatedCount) continue;
      remainingCents -= giveCents;
    }
    totalRestoredCents += requestedCents - remainingCents;
  }
  if (totalRestoredCents < totalRequestedCents) {
    logger.error('[estimate-deposits] voided invoice deposit credit cannot be fully restored — void rolled back, manual reconciliation needed', {
      invoiceId: invoice?.id || null,
      requested: totalRequestedCents / 100,
      restored: totalRestoredCents / 100,
    });
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('estimate_deposit_reconcile_needed', { invoiceId: invoice?.id || null });
    } catch (notifyErr) {
      logger.error(`[estimate-deposits] failed to raise reconcile alert for voided invoice ${invoice?.id}: ${notifyErr.message}`);
    }
    throw new Error(
      `deposit credit restore incomplete for invoice ${invoice?.id} (restored $${totalRestoredCents / 100} of $${totalRequestedCents / 100}) — void blocked until the ledger is reconciled`,
    );
  }
  return totalRestoredCents / 100;
}

module.exports = {
  assessDepositFollowUpEligibility,
  computeDepositAmount,
  DEPOSIT_FOLLOWUP_WINDOW,
  consumeDepositCredit,
  createDepositIntentForEstimate,
  ensureDepositSatisfied,
  handleDepositChargeReversed,
  handleDepositDisputeClosed,
  handleDepositIntentCanceled,
  handleDepositIntentSucceeded,
  isDepositEnforced,
  pendingDepositCredit,
  refundUnconsumedDeposits,
  resolveDepositPolicy,
  resolveDepositPolicyForEstimate,
  linkedScheduledServiceId,
  restoreDepositCreditForVoidedInvoice,
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
