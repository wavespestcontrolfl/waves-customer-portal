const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const { excludeNeverAttemptedHoldDeferrals } = require('../services/collections/collection-hold');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const { logAutopay } = require('../services/autopay-log');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');
const { isPaused, autopayActivePredicate } = require('../services/autopay-eligibility');
const { MONTHLY_LANE_SQL, resolveBillingLane, findLiveStampedDuesInvoice } = require('../services/billing-lane');
const { withCustomerBillingLock } = require('../utils/customer-billing-lock');
const { hasUnresolvedSiblingStripeOutcome, deriveMonthlyChargeIdempotencyKey } = require('../services/retry-collectibility');

// Charge Now is an operatorOverride: it goes past an active collections dispute
// hold. The override is recorded at the charge boundary (stripe.js charge()),
// naming this admin; it never blocks the charge.
const chargeNowOverrideTrail = (req) => ({
  actorId: req.technicianId || null, ip: req.ip,
  userAgent: req.get('user-agent') || null, route: 'admin_charge_now',
});

router.use(adminAuthenticate);
router.use(requireAdmin);

/**
 * GET /api/admin/customers/:id/autopay-state — admin read of autopay + recent events.
 */
router.get('/customers/:id/autopay-state', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers')
      .where({ id: customerId })
      .select(
        'id', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_pause_reason',
        'autopay_payment_method_id', 'billing_day', 'next_charge_date',
      )
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const autopayPaused = isPaused(customer);
    let state = 'disabled';
    if (customer.autopay_enabled && !autopayPaused) state = 'active';
    else if (customer.autopay_enabled && autopayPaused) state = 'paused';

    const recent_events = await db('autopay_log')
      .where({ customer_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(20);

    res.json({
      state,
      autopay_enabled: !!customer.autopay_enabled,
      paused_until: customer.autopay_paused_until,
      pause_reason: customer.autopay_pause_reason,
      autopay_payment_method_id: customer.autopay_payment_method_id,
      billing_day: customer.billing_day || 1,
      next_charge_date: customer.next_charge_date,
      monthly_rate: customer.monthly_rate,
      recent_events,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/customers/:id/autopay-setup-link
 * Body: { delivery?: 'inline' | 'sms' | 'email' } (default inline — hands
 * the link back for copy/paste, no comm; 'sms' texts it and 'email' emails
 * it, both operator-initiated).
 * All policy lives in requestAutopaySetupLink (gate, payer exemption,
 * already-on-Auto-Pay, saved-method auto-secure, dedup, template lever) —
 * the outcome is reported verbatim so the Customers page can say WHY.
 */
router.post('/customers/:id/autopay-setup-link', async (req, res, next) => {
  try {
    const { requestAutopaySetupLink } = require('../services/autopay-setup-link');
    const result = await requestAutopaySetupLink({
      customerId: req.params.id,
      delivery: ['sms', 'email'].includes(req.body?.delivery) ? req.body.delivery : 'inline',
      trigger: 'admin',
    });
    res.json({
      requested: result.requested,
      action: result.action,
      reason: result.reason,
      channel: result.channel || null,
      secureUrl: result.secureUrl || null,
      expiresAt: result.expiresAt || null,
    });
  } catch (err) { next(err); }
});

// Shared charge()/chargeOneTime() failure classification for charge-now —
// used by both the locked monthly-collection path and the unlocked
// explicit-amount path so the two branches can't drift on how orphan /
// ambiguous / generic failures are logged and reported.
async function buildChargeFailureResponse(err, { customerId, chargeAmount, technicianId }) {
  // Stripe ACCEPTED the charge but the ledger write failed — the
  // customer WAS billed (orphan row recorded by the service). This
  // must not look retryable: a second "Charge now" click would use
  // a fresh idempotency key and take the money again.
  if (err.code === 'STRIPE_CHARGED_DB_FAILED') {
    await logAutopay(customerId, 'orphan_charge', {
      amountCents: Math.round(chargeAmount * 100),
      details: { source: 'manual_charge', stripe_payment_intent_id: err.stripePaymentIntentId, reason: err.message, admin_id: technicianId || null },
    }).catch(() => {});
    return {
      status: 409,
      body: {
        error: `Charge SUCCEEDED at Stripe (PI ${err.stripePaymentIntentId}) but could not be recorded in the ledger. DO NOT charge again — reconcile via stripe_orphan_charges.`,
        orphan: true,
        stripe_payment_intent_id: err.stripePaymentIntentId,
      },
    };
  }
  // Ambiguous outcome — Stripe may have processed the charge even
  // though the request errored. Don't present as retryable: a
  // re-click would mint a fresh idempotency key and could charge
  // twice. charge() already flagged its failed row; park it
  // non-collectible until reconciled.
  if (err.code === 'STRIPE_AMBIGUOUS_OUTCOME') {
    if (err.paymentRecord?.id) {
      await db('payments').where({ id: err.paymentRecord.id }).update({
        superseded_by_payment_id: err.paymentRecord.id,
        failure_reason: 'Ambiguous Stripe outcome (manual charge) — reconcile before re-charging',
      }).catch(() => {});
    }
    await logAutopay(customerId, 'charge_failed', {
      amountCents: Math.round(chargeAmount * 100),
      details: { source: 'manual_charge', reason: 'ambiguous_stripe_outcome', admin_id: technicianId || null },
    }).catch(() => {});
    return {
      status: 409,
      body: {
        error: 'Charge outcome is AMBIGUOUS — Stripe may have processed it. Check the Stripe dashboard before charging again.',
        ambiguous: true,
      },
    };
  }
  await logAutopay(customerId, 'charge_failed', {
    amountCents: Math.round(chargeAmount * 100),
    details: { source: 'manual_charge', reason: err.message, admin_id: technicianId || null },
  });
  return { status: 502, body: { error: err.message } };
}

/**
 * POST /api/admin/customers/:id/charge-now
 * Body: { amount?: number, description?: string, billedMonth?: 'YYYY-MM', expectedAmount?: number }
 * If amount omitted, charges customer.monthly_rate — ONLY for a customer the
 * lane resolver puts on the monthly lane. Any other lane 400s (fail closed).
 * billedMonth (amount omitted only): the month of dues this collects — this
 * ET month (the default) or one of the previous PAST_DUES_MONTHS, e.g. a
 * month whose bank payment was canceled (owner 2026-10-30). Every monthly
 * guard below reads that month, and the payment carries it as billed_month,
 * the stamp the cron, the retry sweep and plan-visit completion all trust.
 * expectedAmount (amount omitted only): the dollar amount the Charge now
 * confirm showed. The dues charge collects the rate stored NOW, so a rate
 * edited after the page loaded would collect an amount nobody approved: a
 * confirmed amount that no longer matches refuses (409 rate_changed, with the
 * current amount) and charges nothing. Absent = no confirm to compare.
 */
const PAST_DUES_MONTHS = 2;

const toCents = (value) => Math.round(parseFloat(value || 0) * 100);

function readConfirmedCents(expectedAmount, amount) {
  if (expectedAmount == null) return { cents: null };
  if (amount != null) {
    return { error: 'A confirmed amount applies only to the monthly dues charge: leave the amount empty.' };
  }
  if (typeof expectedAmount !== 'number' || !Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return { error: 'The confirmed amount must be a positive number of dollars.' };
  }
  return { cents: Math.round(expectedAmount * 100) };
}

// The refusal when the rate to charge is not the rate the operator confirmed
// (or it moved while this request waited on the billing lock). Nothing charged.
function rateChangedBody(currentAmount, confirmedCents) {
  const confirmed = confirmedCents == null ? '' : ` after you confirmed $${(confirmedCents / 100).toFixed(2)}`;
  return {
    error: `The monthly rate changed to $${currentAmount.toFixed(2)}${confirmed}. Nothing was charged. Check the rate and confirm again.`,
    rate_changed: true,
    current_amount: currentAmount,
  };
}

async function chargeableCustomerRefusal(customer) {
  if (!customer) return { status: 404, body: { error: 'Customer not found' } };
  if (customer.deleted_at) {
    return { status: 409, body: { error: 'This customer record is archived — cannot charge.', customer_inactive: true } };
  }
  if (customer.active === false) {
    return { status: 409, body: { error: 'This customer account is inactive — cannot charge.', customer_inactive: true } };
  }
  if (customer.payer_id) {
    // Payer deactivation preserves customers.payer_id; only an active payer
    // (or an unresolved/missing payer row, failing closed) blocks direct charges.
    const payersQ = db('payers');
    const payerRow = payersQ && typeof payersQ.where === 'function'
      ? await payersQ.where({ id: customer.payer_id }).first('id', 'active').catch(() => null)
      : null;
    if (payerRow?.active !== false) {
      return { status: 400, body: { error: 'This customer is billed to a third-party payer — do not charge the service recipient directly.', payer_billed: true } };
    }
  }
  return null;
}

function buildOneTimeChargeIdempotencyKey(req, customerId, chargeAmount) {
  const headerKey = typeof req.get === 'function' ? req.get('idempotency-key') : null;
  const rawCallerKey = (typeof headerKey === 'string' && headerKey.trim())
    || (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim())
    || null;
  if (rawCallerKey) {
    const hash = crypto.createHash('sha256').update(rawCallerKey.slice(0, 256)).digest('hex').slice(0, 24);
    return { key: `admin_charge_one_time_${customerId}_${hash}`, hasCallerKey: true };
  }
  const cents = toCents(chargeAmount);
  return { key: `admin_charge_one_time_${customerId}_${cents}_${crypto.randomUUID()}`, hasCallerKey: false };
}

async function isManualChargeAlreadyLogged(lockOutcome, customerId, eventType) {
  if (!lockOutcome?.payment?.id) return Boolean(lockOutcome?.replayed);
  const q = db('autopay_log');
  if (!q || typeof q.where !== 'function') return Boolean(lockOutcome?.replayed);
  const existing = await q
    .where({ customer_id: customerId, payment_id: lockOutcome.payment.id, event_type: eventType })
    .first('id');
  return Boolean(existing);
}

async function claimManualReceiptDelivery(customer, paymentId, lockOutcome) {
  if (!customer?.phone) return false;
  if (!lockOutcome?.hasCallerKey || !paymentId) return true;
  const q = db('sms_messages');
  if (!q || typeof q.where !== 'function') return !lockOutcome.replayed;
  const existing = await q
    .whereRaw("metadata->>'source' = 'admin_manual_charge' AND metadata->>'paymentId' = ?", [String(paymentId)])
    .first('id');
  return !existing;
}

async function findRecordedCallerKeyedPayment(customerId, idempotencyKey) {
  const q = db('payments');
  if (!q || typeof q.where !== 'function' || typeof q.whereRaw !== 'function') return null;
  return q
    .where({ customer_id: customerId })
    .whereIn('status', ['paid', 'processing', 'refunded', 'partially_refunded', 'disputed'])
    .whereRaw("metadata->>'idempotency_key' = ?", [idempotencyKey])
    .orderBy('created_at', 'desc')
    .first();
}

function recordedPaymentBaseCents(payment) {
  if (!payment) return null;
  if (payment.base_amount_cents != null && Number.isFinite(Number(payment.base_amount_cents))) {
    return Math.round(Number(payment.base_amount_cents));
  }
  let meta = payment.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  if (meta && meta.base_amount != null && Number.isFinite(Number(meta.base_amount))) {
    return Math.round(Number(meta.base_amount) * 100);
  }
  if (payment.amount != null && Number.isFinite(Number(payment.amount))) {
    return Math.round(Number(payment.amount) * 100);
  }
  return null;
}

// Inside the billing lock, just before the dues charge: re-read customer state
// (active, deleted_at, payer_id, billing_mode, waveguard_tier, monthly_rate) so
// an archive/deactivation, payer assignment, lane switch, or rate edit landing
// while waiting on the lock refuses cleanly before charging anything.
async function assertMonthlyCustomerInLock(customerId, chargeAmount, confirmedCents) {
  const current = await db('customers')
    .where({ id: customerId })
    .first('id', 'active', 'deleted_at', 'payer_id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'billing_day');
  const customerRefusal = await chargeableCustomerRefusal(current);
  if (customerRefusal) {
    const err = new Error(customerRefusal.body.error);
    err.code = 'CHARGE_REFUSED';
    err.response = customerRefusal;
    throw err;
  }
  const lane = resolveBillingLane(current);
  if (lane.mode !== 'monthly_membership') {
    const err = new Error('Customer is no longer on the monthly lane.');
    err.code = 'CHARGE_REFUSED';
    err.response = {
      status: 409,
      body: {
        error: `This customer is not on the monthly lane (billing_mode: ${lane.mode}, ${lane.source}) — the monthly rate is not their dues. To charge them, enter an explicit amount.`,
        billing_mode: lane.mode,
        billing_mode_source: lane.source,
      },
    };
    throw err;
  }
  const currentCents = toCents(current.monthly_rate);
  if (currentCents > 0 && currentCents === toCents(chargeAmount) && (confirmedCents == null || confirmedCents === currentCents)) {
    return current;
  }
  const err = new Error('The monthly rate changed before the charge.');
  err.code = 'RATE_CHANGED';
  err.body = rateChangedBody(currentCents / 100, confirmedCents);
  throw err;
}

function mapBillingLockError(err) {
  if (err.code === 'BILLING_CLAIM_HELD_ELSEWHERE') {
    return { response: { status: 409, body: { error: `${err.message} — try again in a moment`, in_progress: true } } };
  }
  if (err.code === 'RATE_CHANGED') return { response: { status: 409, body: err.body } };
  if (err.code === 'CHARGE_REFUSED') return { response: err.response };
  throw err;
}

async function resolveCollectedMonthFailures({ customerId, monthKey, chargedPayment, technicianId }) {
  try {
    const resolved = await db('payments')
      .where({ customer_id: customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .whereRaw("metadata->>'billed_month' = ?", [monthKey])
      .whereNot({ id: chargedPayment.id })
      .update({
        next_retry_at: null,
        superseded_by_payment_id: chargedPayment.id,
        failure_reason: db.raw("COALESCE(failure_reason, '') || ?", [` — resolved: ${monthKey} collected by Charge now (payment ${chargedPayment.id})`]),
      }, ['id']);
    for (const row of resolved) {
      await logAutopay(customerId, 'skipped_already_paid', {
        paymentId: row.id,
        details: { source: 'manual_charge', collected_by_payment_id: chargedPayment.id, billed_month: monthKey, ladder_stopped: true, admin_id: technicianId || null },
      }).catch(() => {});
    }
  } catch (resolveErr) {
    logger.error(`[admin-billing] could not resolve ${monthKey} failed attempts for customer ${customerId} after payment ${chargedPayment?.id}: ${resolveErr.message}`);
  }
  if (chargedPayment?.status === 'paid') {
    await require('../services/payment-failed-alert-close').closePaymentFailedAlertsForMonthlyDues({
      customerId,
      billedMonth: monthKey,
    });
  }
}

async function runMonthlyChargeInLock(req, {
  customerId, customer, chargeAmount, desc, monthKey, obligationMonth, confirmedCents, service,
}) {
  const [year, month] = monthKey.split('-').map(Number);
  const monthStart = `${monthKey}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
  const existingCharge = await db('payments')
    .where({ customer_id: customerId })
    .whereIn('status', ['paid', 'processing'])
    .where(function () {
      this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
        .orWhere(function () {
          this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
            .andWhere('payment_date', '>=', monthStart)
            .andWhere('payment_date', '<=', monthEnd)
            .andWhere('description', 'like', '%WaveGuard Monthly%');
        });
    })
    .first();
  if (existingCharge) {
    await logAutopay(customerId, 'skipped_already_paid', {
      paymentId: existingCharge.id,
      details: { source: 'manual_charge', billed_month: monthKey, admin_id: req.technicianId || null },
    }).catch(() => {});
    return {
      response: {
        status: 409,
        body: {
          error: `${monthKey} is already collected for this customer (payment ${existingCharge.id}). To charge something additional on purpose, enter an explicit amount.`,
          already_collected: true,
          payment_id: existingCharge.id,
        },
      },
    };
  }

  const duesInvoice = await findLiveStampedDuesInvoice(db, customerId, monthKey);
  if (duesInvoice) {
    const invoiceLabel = duesInvoice.invoice_number || duesInvoice.id;
    const settled = ['paid', 'prepaid', 'processing'].includes(duesInvoice.status);
    await logAutopay(customerId, 'skipped_already_paid', {
      details: { source: 'manual_charge', billed_month: monthKey, dues_invoice_id: duesInvoice.id, admin_id: req.technicianId || null },
    }).catch(() => {});
    return {
      response: {
        status: 409,
        body: {
          error: settled
            ? `${monthKey} is already billed on dues invoice ${invoiceLabel}, which is paid — nothing is owed for the month. To charge something additional on purpose, enter an explicit amount.`
            : `${monthKey} is already billed on dues invoice ${invoiceLabel}, which is still open — collect that invoice instead of charging the month again. To charge something additional on purpose, enter an explicit amount.`,
          already_collected: true,
          payment_id: null,
          dues_invoice_id: duesInvoice.id,
        },
      },
    };
  }

  if (obligationMonth) {
    const { getActivelyCoveredCustomerIds } = require('../services/annual-prepay-renewals');
    const dueDay = String(Math.min(customer.billing_day || 1, lastDay)).padStart(2, '0');
    const covered = await getActivelyCoveredCustomerIds(`${monthKey}-${dueDay}`, db, { throwOnError: true });
    if (covered.has(String(customerId))) {
      return {
        response: {
          status: 409,
          body: { error: `${monthKey} was covered by this customer's annual prepay, so nothing is owed for the month.`, prepay_covered: true },
        },
      };
    }
  }

  const unresolvedOutcome = await hasUnresolvedSiblingStripeOutcome(customerId, monthKey, db);
  if (unresolvedOutcome.blocked) {
    return {
      response: {
        status: 409,
        body: {
          error: `A prior charge attempt for this customer has an unresolved Stripe outcome (${unresolvedOutcome.reason}) — reconcile it before charging again.`,
          unresolved_outcome: unresolvedOutcome.reason,
        },
      },
    };
  }

  const parkedIntents = await db('payments')
    .where({ customer_id: customerId, status: 'failed' })
    .whereNull('superseded_by_payment_id')
    .whereRaw("metadata->>'billed_month' = ? AND COALESCE(metadata->>'requires_action', '') = 'true'", [monthKey])
    .pluck('stripe_payment_intent_id');
  const { neutralizeOpenPaymentIntent } = require('../services/prepaid-pi-guard');
  for (const piId of new Set(parkedIntents.filter(Boolean))) {
    const intent = await neutralizeOpenPaymentIntent(piId, { inspectOnly: true });
    if (!intent.ok) {
      return {
        response: {
          status: 409,
          body: {
            error: `${monthKey} has an earlier charge still waiting on the customer's bank or card approval at Stripe (${piId}). Check it in Stripe before charging the month again.`,
            live_payment_intent: piId,
          },
        },
      };
    }
  }

  // Re-verify active, deleted_at, payer_id, monthly lane, and rate under lock
  // as late as possible right before calling Stripe.
  const lockedCustomer = await assertMonthlyCustomerInLock(customerId, chargeAmount, confirmedCents);
  const idempotencyKey = await deriveMonthlyChargeIdempotencyKey(customerId, monthKey, db);

  let chargedPayment;
  try {
    chargedPayment = await service.charge(customerId, chargeAmount, desc, {
      type: 'manual_charge',
      tier: lockedCustomer.waveguard_tier || '',
      billed_month: monthKey,
      initiated_by: 'machine',
    }, idempotencyKey, { operatorOverride: true, overrideTrail: chargeNowOverrideTrail(req) });
  } catch (err) {
    return { response: await buildChargeFailureResponse(err, { customerId, chargeAmount, technicianId: req.technicianId }) };
  }

  await resolveCollectedMonthFailures({ customerId, monthKey, chargedPayment, technicianId: req.technicianId });
  return { payment: chargedPayment };
}

async function runExplicitChargeInLock(req, { customerId, chargeAmount, desc, service }) {
  const lockedCustomer = await db('customers')
    .where({ id: customerId })
    .first('id', 'active', 'deleted_at', 'payer_id');
  const customerRefusal = await chargeableCustomerRefusal(lockedCustomer);
  if (customerRefusal) return { response: customerRefusal };

  const { key: idempotencyKey, hasCallerKey } = buildOneTimeChargeIdempotencyKey(req, customerId, chargeAmount);
  if (hasCallerKey) {
    // Check recorded operation key under the exclusive customer billing lock
    // BEFORE calling Stripe so late retries after Stripe's 24h key TTL never
    // mint a duplicate PaymentIntent.
    const existing = await findRecordedCallerKeyedPayment(customerId, idempotencyKey);
    if (existing) {
      if (['refunded', 'partially_refunded', 'disputed'].includes(existing.status)) {
        return {
          response: {
            status: 409,
            body: {
              error: 'A prior charge using this idempotency key was refunded or disputed. Generate a new idempotency key to charge again.',
              code: 'IDEMPOTENCY_KEY_RETIRED',
            },
          },
        };
      }
      const existingBaseCents = recordedPaymentBaseCents(existing);
      const expectedBaseCents = Math.round(Number(chargeAmount) * 100);
      if (existingBaseCents !== null && existingBaseCents !== expectedBaseCents) {
        return {
          response: {
            status: 409,
            body: {
              error: 'This idempotency key was already used for a different charge amount. Generate a new idempotency key.',
              code: 'IDEMPOTENCY_AMOUNT_MISMATCH',
            },
          },
        };
      }
      return { payment: existing, hasCallerKey: true, replayed: true };
    }
  }
  try {
    const metadata = hasCallerKey
      ? { initiated_by: 'machine', idempotency_key: idempotencyKey }
      : { initiated_by: 'machine' };
    const payment = await service.chargeOneTime(
      customerId,
      chargeAmount,
      desc,
      idempotencyKey,
      metadata,
      { operatorOverride: true, overrideTrail: chargeNowOverrideTrail(req) },
    );
    return { payment, hasCallerKey, replayed: false };
  } catch (err) {
    return { response: await buildChargeFailureResponse(err, { customerId, chargeAmount, technicianId: req.technicianId }) };
  }
}

router.post('/customers/:id/charge-now', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const { amount, description, billedMonth, expectedAmount } = req.body || {};

    const today = etParts(new Date());
    const thisMonth = `${today.year}-${String(today.month).padStart(2, '0')}`;
    let obligationMonth = null;
    if (billedMonth != null) {
      const allowed = Array.from({ length: PAST_DUES_MONTHS + 1 }, (_, back) => (
        new Date(Date.UTC(today.year, today.month - 1 - back, 1)).toISOString().slice(0, 7)
      ));
      if (amount != null) {
        return res.status(400).json({ error: 'A month applies only to the monthly dues charge: leave the amount empty to charge a month.' });
      }
      if (!allowed.includes(billedMonth)) {
        return res.status(400).json({ error: `Pick this month or one of the previous ${PAST_DUES_MONTHS}: ${allowed.join(', ')}.` });
      }
      obligationMonth = billedMonth === thisMonth ? null : billedMonth;
    }
    const confirmed = readConfirmedCents(expectedAmount, amount);
    if (confirmed.error) return res.status(400).json({ error: confirmed.error });

    const customer = await db('customers').where({ id: customerId }).first();
    const preRefusal = await chargeableCustomerRefusal(customer);
    if (preRefusal) return res.status(preRefusal.status).json(preRefusal.body);

    if (amount == null) {
      const lane = resolveBillingLane(customer);
      if (lane.mode !== 'monthly_membership') {
        return res.status(400).json({
          error: `This customer is not on the monthly lane (billing_mode: ${lane.mode}, ${lane.source}) — the monthly rate is not their dues. To charge them, enter an explicit amount.`,
          billing_mode: lane.mode,
          billing_mode_source: lane.source,
        });
      }
    }

    const chargeAmount = amount != null
      ? parseFloat(amount)
      : parseFloat(customer.monthly_rate || 0);

    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
      return res.status(400).json({ error: 'No amount to charge (monthly_rate is 0 or unset)' });
    }

    const service = await require('../services/stripe');
    const monthLabel = obligationMonth
      ? ` — ${new Date(`${obligationMonth}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })} dues`
      : '';
    const desc = description || `Manual charge — WaveGuard ${customer.waveguard_tier || ''}`.trim() + monthLabel;

    const isMonthlyCollection = amount == null;
    const lockOutcome = await withCustomerBillingLock(customerId, () => (
      isMonthlyCollection
        ? runMonthlyChargeInLock(req, {
            customerId,
            customer,
            chargeAmount,
            desc,
            monthKey: obligationMonth || thisMonth,
            obligationMonth,
            confirmedCents: confirmed.cents,
            service,
          })
        : runExplicitChargeInLock(req, { customerId, chargeAmount, desc, service })
    )).catch(mapBillingLockError);

    if (lockOutcome.response) return res.status(lockOutcome.response.status).json(lockOutcome.response.body);
    const payment = lockOutcome.payment;
    const eventType = payment?.status === 'paid' ? 'manual_charge' : 'manual_charge_processing';

    // Deduplicate manual-charge logging and receipt SMS separately: logging checks
    // autopay_log, while receipt SMS uses claimManualReceiptDelivery so a crash
    // between log and SMS still delivers once without double-sending on replays.
    if (!(await isManualChargeAlreadyLogged(lockOutcome, customerId, eventType))) {
      await logAutopay(customerId, eventType, {
        amountCents: Math.round(Number(payment?.amount) * 100),
        paymentId: payment?.id || null,
        details: { source: 'manual_charge', description: desc, admin_id: req.technicianId || null },
      });
    }

    // An accepted bank payment is not evidence of a completed charge.
    if (payment?.status !== 'paid') {
      return res.json({ success: true, payment, ...(lockOutcome.replayed ? { idempotent_replay: true } : {}) });
    }

    // Send receipt SMS
    let receiptUrl = null;
    try {
      const raw = payment?.metadata;
      const meta = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      receiptUrl = meta.stripe_receipt_url || null;
    } catch (_) {}

    if (await claimManualReceiptDelivery(customer, payment?.id, lockOutcome)) {
      try {
        const receiptLine = receiptUrl ? ` View receipt: ${receiptUrl}` : '';
        const body = await renderRequiredSmsTemplate('manual_payment_receipt', {
          first_name: customer.first_name || 'there',
          receipt_line: receiptLine,
        }, {
          workflow: 'manual_payment_receipt',
          entity_type: 'payment',
          entity_id: payment.id,
        });
        const result = await sendCustomerMessage({
          audience: 'customer',
          channel: 'sms',
          to: customer.phone,
          customerId,
          purpose: 'payment_receipt',
          identityTrustLevel: 'admin_operator',
          // Staff explicitly charged and receipted this customer — operator
          // provenance keeps the receipt on SMS (push routing stays out of
          // operator-triggered sends).
          operatorInitiated: true,
          body,
          metadata: { source: 'admin_manual_charge', paymentId: payment?.id || null },
        });
        if (!result?.sent) logger.warn(`[admin-billing] receipt SMS blocked: ${result?.code || 'unknown'}`);
      } catch (smsErr) {
        logger.error(`[admin-billing] receipt SMS failed: ${smsErr.message}`);
      }
    }

    res.json({ success: true, payment, ...(lockOutcome.replayed ? { idempotent_replay: true } : {}) });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/billing-health
 * Returns a dashboard-ready snapshot of autopay health.
 */
router.get('/billing-health', async (req, res, next) => {
  try {
    const now = new Date();
    const todayEt = etDateString(now);
    const monthStart = `${todayEt.slice(0, 7)}-01`;
    const thirtyDaysAgoDate = etDateString(addETDays(now, -30));
    const sixtyDaysOutDate = etDateString(addETDays(now, 60));

    // Active billable customers — `active=true` alone isn't enough,
    // soft-deleted customers can have active=true left over from before
    // the delete. whereNull('deleted_at') everywhere matches the rest
    // of the dashboard.
    const billable = await db('customers')
      .where({ active: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereRaw(MONTHLY_LANE_SQL)
      .count('* as n').first();
    const totalBillable = parseInt(billable.n) || 0;

    // Autopay enabled / paused / disabled
    const enabled = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereRaw(MONTHLY_LANE_SQL)
      .count('* as n').first();
    const disabled = await db('customers')
      .where({ active: true, autopay_enabled: false })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereRaw(MONTHLY_LANE_SQL)
      .count('* as n').first();
    const paused = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereRaw(MONTHLY_LANE_SQL)
      .whereNotNull('autopay_paused_until')
      .where('autopay_paused_until', '>=', todayEt)
      .count('* as n').first();

    // Chargeable autopay — the shared predicate the dashboard Cash KPI and
    // Action Inbox use (default Stripe method present, not paused, not
    // expired). Reporting only the raw autopay_enabled flag here made this
    // card claim 100% coverage while the Cash KPI on the same page said 0%.
    const { sql: chargeableSql, binding: chargeableBinding } = autopayActivePredicate(now);
    const chargeable = await db('customers as c')
      .where({ 'c.active': true })
      .whereNull('c.deleted_at')
      .where('c.monthly_rate', '>', 0)
      .whereRaw(MONTHLY_LANE_SQL)
      .whereRaw(chargeableSql, [chargeableBinding])
      .count('* as n').first();

    // Enrolled but unchargeable — autopay flag on, not paused, yet the
    // chargeable predicate fails (no default Stripe method, expired card,
    // retired processor). These customers silently won't bill, and none of
    // the other attention buckets is guaranteed to catch them (Codex P2 on
    // #2939). Overlaps no_payment_method when the method pointer is also
    // NULL — both chips firing for one account is truthful, so no subtraction.
    // Card-dependent audience (Codex #3669 r9): dues-lane accounts AND
    // per-application accounts — a per-application customer's saved card is
    // HOW their per-visit charge collects (see admin-billing-recovery), so
    // an unchargeable/missing method is actionable on that lane too, rate
    // or no rate. The coverage metrics above stay dues-lane only.
    const unchargeable = await db('customers as c')
      .where({ 'c.active': true })
      .whereNull('c.deleted_at')
      .where(function cardDependentLanes() { this.where(function monthlyLane() { this.where('c.monthly_rate', '>', 0).whereRaw(MONTHLY_LANE_SQL); }).orWhere('c.billing_mode', 'per_application'); })
      .where('c.autopay_enabled', true)
      .whereRaw(
        'NOT (c.autopay_paused_until IS NOT NULL AND c.autopay_paused_until >= ?::date)',
        [todayEt]
      )
      .whereRaw(`NOT ${chargeableSql}`, [chargeableBinding])
      .count('* as n').first();

    // Customers with no autopay payment method — card-dependent audience
    // (dues lane ∪ per-application), same rationale as `unchargeable`.
    const noMethod = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where(function cardDependentLanes() { this.where(function monthlyLane() { this.where('monthly_rate', '>', 0).whereRaw(MONTHLY_LANE_SQL); }).orWhere('billing_mode', 'per_application'); })
      .whereNull('autopay_payment_method_id')
      .count('* as n').first();

    // Failed payments in the last 30 days. Superseded rows (retry
    // collected, or duplicate attempt rows) are resolved — not active
    // failures.
    const failedRecent = await excludeNeverAttemptedHoldDeferrals(db('payments')
      .where({ status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .where('payment_date', '>=', thirtyDaysAgoDate))
      .count('* as n').first();

    // Payments in retry queue (pending retry)
    // B10: a dispute-hold deferral (never attempted, Stripe not contacted) is
    // waiting on the office's release, not in a decline-retry ladder.
    const inRetry = await excludeNeverAttemptedHoldDeferrals(db('payments')
      .where({ status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .where('retry_count', '<', 3)
      .whereNotNull('next_retry_at'))
      .count('* as n').first();

    // Escalated (3 retries exhausted)
    const escalated = await excludeNeverAttemptedHoldDeferrals(db('payments')
      .where({ status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .where('retry_count', '>=', 3)
      .where('payment_date', '>=', thirtyDaysAgoDate))
      .count('* as n').first();

    // Charged this month (success)
    const chargedMonth = await db('payments')
      .whereIn('status', ['paid', 'processing'])
      .where('payment_date', '>=', monthStart)
      .where('description', 'like', '%WaveGuard Monthly%')
      .count('* as n').first();

    // Cards already expired or expiring in next 60 days (for active autopay customers)
    const expiringCards = await db('payment_methods')
      .join('customers', 'customers.id', 'payment_methods.customer_id')
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .where('customers.autopay_enabled', true)
      .where('payment_methods.autopay_enabled', true)
      .whereRaw(
        "(make_date(payment_methods.exp_year::int, payment_methods.exp_month::int, 1) + INTERVAL '1 month - 1 day')::date <= ?::date",
        [sixtyDaysOutDate]
      )
      .count('* as n').first();

    res.json({
      summary: {
        total_billable: totalBillable,
        autopay_active: Math.max(0, (parseInt(enabled.n) || 0) - (parseInt(paused.n) || 0)),
        autopay_chargeable: parseInt(chargeable.n) || 0,
        autopay_unchargeable: parseInt(unchargeable.n) || 0,
        autopay_paused: parseInt(paused.n) || 0,
        autopay_disabled: parseInt(disabled.n) || 0,
        no_payment_method: parseInt(noMethod.n) || 0,
        charged_this_month: parseInt(chargedMonth.n) || 0,
        failed_last_30_days: parseInt(failedRecent.n) || 0,
        in_retry_queue: parseInt(inRetry.n) || 0,
        escalated_last_30_days: parseInt(escalated.n) || 0,
        expiring_cards_60_days: parseInt(expiringCards.n) || 0,
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/billing-health/at-risk
 * Customers needing attention — failed charges, no method, expiring cards.
 */
router.get('/billing-health/at-risk', async (req, res, next) => {
  try {
    // No payment method — card-dependent audience (dues lane ∪
    // per-application): a per-application customer's saved card is how
    // their per-visit charge collects, so a missing method is actionable
    // there too (Codex #3669 r9).
    const noMethod = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where(function cardDependentLanes() { this.where(function monthlyLane() { this.where('monthly_rate', '>', 0).whereRaw(MONTHLY_LANE_SQL); }).orWhere('billing_mode', 'per_application'); })
      .whereNull('autopay_payment_method_id')
      .select('id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier');

    // In retry queue
    const inRetry = await excludeNeverAttemptedHoldDeferrals(db('payments')
      .join('customers', 'customers.id', 'payments.customer_id')
      .where('payments.status', 'failed')
      .whereNull('payments.superseded_by_payment_id')
      .where('payments.retry_count', '<', 3)
      .whereNotNull('payments.next_retry_at'))
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'payments.id as payment_id', 'payments.amount', 'payments.retry_count',
        'payments.next_retry_at', 'payments.failure_reason',
      );

    // Escalated
    const escalated = await excludeNeverAttemptedHoldDeferrals(db('payments')
      .join('customers', 'customers.id', 'payments.customer_id')
      .where('payments.status', 'failed')
      .whereNull('payments.superseded_by_payment_id')
      .where('payments.retry_count', '>=', 3))
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'payments.id as payment_id', 'payments.amount', 'payments.failure_reason',
        'payments.payment_date',
      );

    res.json({
      no_payment_method: noMethod,
      in_retry: inRetry,
      escalated,
    });
  } catch (err) { next(err); }
});

module.exports = router;
