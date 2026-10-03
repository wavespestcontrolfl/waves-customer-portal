'use strict';

// B16: an off-session autopay charge that the cardholder's bank answered with a
// 3D Secure demand is parked with no retry (a retry would hit the same wall), and
// nothing else tells anyone: the requires_action webhook texts the customer only
// for an ACH micro-deposit step (and that bank-verification text is switched off),
// and no page can finish a card authentication. This module owns the office alert's
// whole lifecycle (docs/admin-notifications.md: the emitter that raises a row owns
// clearing it):
//   - alertAutopayScaParked: raise it (billing-cron's two parked branches);
//   - settleParkedForPaidPayment: the one entry point when a payment becomes paid
//     (Charge now collecting at once, or the Stripe succeeded hook for an ACH that
//     settles later): close the alert of the payment's own PaymentIntent, and when it is
//     a monthly dues payment take the customer's parked rows for that month out of the
//     overdue balance (resolveParkedMonthlyRows) and close their alerts
//     (closeScaParkedAlerts).
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const KEY_PREFIX = 'autopay-sca-parked:';
// One key per customer + PaymentIntent (the payment row id when no PI was minted), so a
// replay or a second tick never rings twice and a closer can recompute it from a row.
const scaParkedAlertKey = (customerId, ref) => `${KEY_PREFIX}${customerId}:${ref}`;

// Raises the office alert. Resolves true only when a notification row exists (new or an
// already-standing one for the same key). `notifyAdmin` catches its own insert failures
// and resolves null instead of rejecting, so a null (or a throw) is a failed alert: it is
// logged at error level and falls back to a customer_health_alerts row (the same staff
// surface billing-cron's ambiguous-outcome branch uses), and the caller must not claim
// the office was told. Never throws: a bell failure must not abort the collection loop.
async function alertAutopayScaParked(customer, err, { amount, source }) {
  const customerId = String(customer.id);
  const paymentIntentId = err.stripePaymentIntentId || err.paymentRecord?.stripe_payment_intent_id || null;
  const attemptId = err.paymentRecord?.id || null;
  const owed = parseFloat(err.paymentRecord?.amount ?? amount);
  const dollars = Number.isFinite(owed)
    ? `$${owed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '';
  let alert = null;
  let name = 'this customer';
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fullName, fitAction } = require('./admin-alert-names');
    name = fullName(customer) || name;
    alert = await raiseAdminAlert('billing', {
      area: 'Billing',
      action: fitAction('Billing', name, [
        (who) => `collect ${who}'s autopay by hand`,
        (who) => `collect ${who}'s autopay`,
      ]),
      why: `The bank must approve this ${dollars ? `${dollars} ` : ''}card charge; it was not collected and will not retry on its own.`,
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
      subject: { type: 'customer', id: customerId },
      doneWhen: 'charge_collected',
      who: 'person',
    }, {
      detail: `Autopay for ${name} (${dollars || 'amount unknown'}) was declined for customer authentication (3D Secure): the cardholder's bank has to approve the charge, and an automatic charge cannot do that. It was not collected and no retry is scheduled, so it will not collect on its own. No message was sent to the customer. Reach the customer to approve it with their bank, or collect it another way. Stripe PaymentIntent ${paymentIntentId || 'unknown'}${attemptId ? `, payment record ${attemptId}` : ''}.`,
      dedupeKey: scaParkedAlertKey(customerId, paymentIntentId || attemptId || etDateString().slice(0, 7)),
      metadata: {
        customer_id: customerId,
        stripe_payment_intent_id: paymentIntentId,
        payment_id: attemptId,
        source,
      },
    });
  } catch (alertErr) {
    logger.error(`[autopay-sca] office alert threw for customer ${customerId}: ${alertErr.message}`);
  }
  if (alert) return true;

  logger.error(`[autopay-sca] office alert NOT filed for customer ${customerId} (PI ${paymentIntentId || 'none'}): the autopay charge is parked on card authentication with no retry — falling back to a customer health alert`);
  try {
    await db('customer_health_alerts').insert({
      customer_id: customer.id,
      alert_type: 'payment_failure',
      severity: 'high',
      title: `Autopay needs card authentication — ${dollars || 'amount unknown'} (${name})`,
      description: 'The cardholder\'s bank has to approve this card charge, so it was NOT collected and no retry is scheduled. Reach the customer to approve it with their bank, or collect it another way. The office bell could not be filed.',
      trigger_data: JSON.stringify({ payment_id: attemptId, stripe_payment_intent_id: paymentIntentId, source: `autopay_sca_parked_${source}` }),
    });
  } catch (fallbackErr) {
    logger.error(`[autopay-sca] CRITICAL: customer ${customerId} autopay is parked on card authentication and neither the office bell nor the health-alert fallback could be written (${fallbackErr.message}); the sca_required autopay_log row is the only record`);
  }
  return false;
}

// Close the alert(s) for these payment rows ({ id, customer_id, stripe_payment_intent_id }).
// Best-effort and never throws: clearing a bell must not fail a collection or a webhook.
async function closeScaParkedAlerts(rows, reason, { conn = db, resolution = null } = {}) {
  try {
    const keys = [];
    for (const row of rows || []) {
      if (!row?.customer_id) continue;
      if (row.stripe_payment_intent_id) keys.push(scaParkedAlertKey(row.customer_id, row.stripe_payment_intent_id));
      if (row.id != null) keys.push(scaParkedAlertKey(row.customer_id, row.id));
    }
    if (!keys.length) return 0;
    const { closeAdminAlertKeys } = require('./admin-alert-episodes');
    return await closeAdminAlertKeys(conn, keys, reason, { resolution: resolution || 'The parked autopay charge was collected' });
  } catch (err) {
    // error level: the supersede that precedes a close has already committed, so a failed
    // close leaves an alert telling staff to collect paid debt until a replay retries it
    logger.error(`[autopay-sca] could not close the parked-charge alert (a replay of the settlement retries it): ${err.message}`);
    return 0;
  }
}

// The office collected the month by hand (Customer 360 "Charge now"): the customer's
// still-open failed monthly rows for THAT obligation month (parked on card
// authentication, or a ladder that ran out) are no longer owed. Same supersede the
// retry sweep applies to an armed row when "another door" collected the month, and
// the same month matcher (metadata.billed_month, else the payment_date window plus the
// 'WaveGuard Monthly' marker). Only unarmed rows (an armed row is the sweep's own to
// resolve) of the same customer and month; the collecting payment itself and rows
// superseded by some OTHER payment are left alone. Returns the rows THIS call superseded.
// The alert close is recoverable: the supersede commits first, so a close that failed would
// otherwise never be retried (the next call no longer selects those rows). The keys closed
// therefore also cover every row already superseded by THIS collecting payment, so a replay
// of the settlement (or a second Charge now) finishes a close that failed. Closing an
// already-closed key is a no-op (closeAdminAlertKeys skips alerts already auto-cleared).
async function resolveParkedMonthlyRows(customerId, { monthKey, monthStart, monthEnd }, collectedPaymentId, { conn = db } = {}) {
  const resolved = await conn('payments')
    .where({ customer_id: customerId, status: 'failed' })
    .whereNull('superseded_by_payment_id')
    .whereNull('next_retry_at')
    .whereNot({ id: collectedPaymentId })
    .where(function () {
      this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
        .orWhere(function () {
          this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
            .andWhere('payment_date', '>=', monthStart)
            .andWhere('payment_date', '<=', monthEnd)
            .andWhere('description', 'like', '%WaveGuard Monthly%');
        });
    })
    .update({
      superseded_by_payment_id: collectedPaymentId,
      failure_reason: conn.raw("COALESCE(failure_reason, '') || ?", [` — resolved: ${monthKey} collected by payment ${collectedPaymentId}`]),
    })
    .returning(['id', 'customer_id', 'stripe_payment_intent_id']);
  const mine = await conn('payments')
    .where({ customer_id: customerId, superseded_by_payment_id: collectedPaymentId })
    .whereNot({ id: collectedPaymentId })
    .select('id', 'customer_id', 'stripe_payment_intent_id');
  const toClose = [...(resolved || []), ...(mine || [])];
  if (toClose.length) {
    await closeScaParkedAlerts(toClose, 'charge_collected', { conn });
  }
  return resolved || [];
}

const parseMetadata = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
};

// THE entry point for "a payment is now PAID": Charge now when it collects at once, and the
// Stripe payment_intent.succeeded hook for everything that settles later (an ACH Charge now
// replacement moves processing -> paid there). It does two things, both idempotent and
// best-effort (it never throws, so it can never fail a charge or a settlement):
//   1. closes the alert keyed to THIS payment's own PaymentIntent (the original parked PI
//      itself settling);
//   2. if the payment is recognizably a MONTHLY DUES payment, resolves the customer's parked
//      rows for that month (resolveParkedMonthlyRows) and closes their alerts. "Recognizably
//      monthly dues" = it carries the persisted metadata.billed_month stamp that every dues
//      collection writes (chargeMonthly, the retry rungs, Charge now) and nothing else does.
//      Its description is NOT used (Charge now's own row reads "Manual charge — WaveGuard
//      <tier>") and the month is NEVER inferred from payment_date: the settle path restamps
//      that to the settlement day, so a late-settling ACH would land in the wrong month.
// A replay supersedes nothing new and re-closes the keys of rows this payment already
// superseded (a no-op when they are closed; the recovery when an earlier close failed).
async function settleParkedForPaidPayment(payment, { conn = db } = {}) {
  try {
    if (!payment?.customer_id || String(payment.status) !== 'paid') return [];
    await closeScaParkedAlerts([payment], 'charge_collected', { conn });
    const billedMonth = parseMetadata(payment.metadata).billed_month;
    const match = /^(\d{4})-(\d{2})$/.exec(String(billedMonth || ''));
    if (!match) return [];
    const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    return await resolveParkedMonthlyRows(payment.customer_id, {
      monthKey: billedMonth,
      monthStart: `${billedMonth}-01`,
      monthEnd: `${billedMonth}-${String(lastDay).padStart(2, '0')}`,
    }, payment.id, { conn });
  } catch (err) {
    logger.error(`[autopay-sca] could not resolve parked rows for paid payment ${payment?.id}: ${err.message}`);
    return [];
  }
}

module.exports = { KEY_PREFIX, scaParkedAlertKey, alertAutopayScaParked, closeScaParkedAlerts, resolveParkedMonthlyRows, settleParkedForPaidPayment };
