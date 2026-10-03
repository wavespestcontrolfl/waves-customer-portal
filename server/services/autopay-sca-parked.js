'use strict';

// B16: an off-session autopay charge that the cardholder's bank answered with a 3D Secure
// demand is parked with no retry (a retry would hit the same wall). The requires_action
// webhook sends the customer NOTHING for a card (its only notice is the ACH micro-deposit
// one) and no page can finish a card authentication, so without this the month's charge
// would sit silently. billing-cron calls parkScaChargeForOffice from both of its
// STRIPE_REQUIRES_ACTION branches, after the row is confirmed parked. It
//   1. cancels the live PaymentIntent (nobody can authenticate an off-session charge, and a
//      live intent is a double-charge risk if the office collects another way), and
//   2. raises ONE office alert whose wording says what happened to that intent.
// Nothing here closes the alert: a person marks it done after collecting. Never throws, so a
// Stripe or alert failure for one customer cannot abort the billing loop.
const db = require('../models/db');
const logger = require('./logger');

const KEY_PREFIX = 'autopay-sca-parked:';
// One key per customer + PaymentIntent (the payment row id when no PI is known), so a replay
// of the same charge never rings twice.
const scaParkedAlertKey = (customerId, ref) => `${KEY_PREFIX}${customerId}:${ref}`;

// What happened to the stuck PaymentIntent: 'cancelled' | 'in_flight' | 'unverified'.
async function neutralizeParkedIntent(piId) {
  if (!piId) return 'unverified';
  try {
    const { neutralizeOpenPaymentIntent } = require('./prepaid-pi-guard');
    const result = await neutralizeOpenPaymentIntent(piId);
    if (result.ok) return 'cancelled';
    return result.reason === 'payment_in_flight' ? 'in_flight' : 'unverified';
  } catch (err) {
    logger.error(`[autopay-sca] could not inspect/cancel PI ${piId}: ${err.message}`);
    return 'unverified';
  }
}

const dollarsOf = (amount) => {
  const n = parseFloat(amount);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
};

// Per-outcome copy: headline action templates, the one-sentence why, and the closing line of the
// detail. Only the 'cancelled' outcome tells the office to collect.
function variantCopy(outcome, dollars) {
  const card = `${dollars ? `${dollars} ` : ''}card charge`;
  if (outcome === 'in_flight') {
    return {
      actions: [(who) => `check ${who}'s pending autopay charge`, (who) => `check ${who}'s autopay`],
      why: `The ${card} is still pending at Stripe; check it before doing anything.`,
      line: 'The charge may still be completing: it is still pending at Stripe. Check it in Stripe before doing anything, and do not collect it another way until you know whether it went through.',
    };
  }
  if (outcome === 'unverified') {
    return {
      actions: [(who) => `cancel ${who}'s autopay charge in Stripe`, (who) => `cancel ${who}'s autopay in Stripe`],
      why: `The ${card} could not be cancelled; cancel it in Stripe before collecting any other way.`,
      line: 'The original charge could NOT be cancelled at Stripe. Cancel it in Stripe before collecting any other way, or the customer could be charged twice.',
    };
  }
  return {
    actions: [(who) => `collect ${who}'s autopay by hand`, (who) => `collect ${who}'s autopay`],
    why: `The bank must approve this ${card}; it was not collected and will not retry.`,
    line: 'The stuck charge was cancelled at Stripe, so collect it by hand: reach the customer to approve it with their bank, or collect it another way.',
  };
}

// notifyAdmin resolves null when its insert failed and a truthy { id: null, suppressed: true }
// when policy suppressed the row: only a result with a real id is a filed alert.
const isFiled = (alert) => !!(alert && !alert.suppressed && alert.id != null);

// customer: the customers row. err: the thrown STRIPE_REQUIRES_ACTION error. amount: the
// charge amount (the failed row's own amount wins). source: 'autopay' | 'autopay_retry'.
async function parkScaChargeForOffice(customer, err, { amount, source }) {
  const customerId = String(customer.id);
  const paymentIntentId = err.stripePaymentIntentId || err.paymentRecord?.stripe_payment_intent_id || null;
  const paymentId = err.paymentRecord?.id || null;
  const dollars = dollarsOf(err.paymentRecord?.amount ?? amount);
  try {
    const outcome = await neutralizeParkedIntent(paymentIntentId);
    const copy = variantCopy(outcome, dollars);
    const trigger = { customer_id: customerId, stripe_payment_intent_id: paymentIntentId, payment_id: paymentId, intent_outcome: outcome, source };

    let alert = null;
    let name = 'this customer';
    try {
      const { raiseAdminAlert } = require('./admin-alert-compose');
      const { fullName, fitAction } = require('./admin-alert-names');
      name = fullName(customer) || name;
      alert = await raiseAdminAlert('billing', {
        area: 'Billing',
        action: fitAction('Billing', name, copy.actions),
        why: copy.why,
        severity: 'needs-you',
        link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
        subject: { type: 'customer', id: customerId },
        // Nothing closes this alert automatically: a person marks it done after collecting.
        doneWhen: 'collected_and_marked_done',
        who: 'person',
      }, {
        // A needs-you money item must ring. With GATE_ADMIN_BELL_POLICY on, the billing category is
        // not allowlisted and a policy-suppressed alert resolves { id: null, suppressed: true } with
        // no row; bell: true is the sanctioned site-level opt-in (notification-bell-policy.js).
        bell: true,
        detail: `The customer's bank must approve this ${dollars ? `${dollars} ` : ''}card charge for ${name} (3D Secure), and an automatic charge cannot do that. It was not collected and will not retry on its own. No message was sent to the customer. ${copy.line} Nothing closes this alert automatically: mark it done after you have collected. Stripe PaymentIntent ${paymentIntentId || 'unknown'}${paymentId ? `, payment record ${paymentId}` : ''}.`,
        dedupeKey: scaParkedAlertKey(customerId, paymentIntentId || paymentId || 'unknown'),
        metadata: trigger,
      });
    } catch (alertErr) {
      logger.error(`[autopay-sca] office alert threw for customer ${customerId}: ${alertErr.message}`);
    }
    if (isFiled(alert)) {
      logger.warn(`[autopay-sca] office alerted for customer ${customerId} (PI ${paymentIntentId || 'none'}, intent ${outcome}) — no retry scheduled`);
      return { filed: true, outcome };
    }

    logger.error(`[autopay-sca] office alert NOT filed for customer ${customerId} (PI ${paymentIntentId || 'none'}, intent ${outcome}): the autopay charge is parked on card authentication with no retry — writing a customer health alert instead`);
    // Same fallback row the ambiguous-outcome branch writes. Like that one, it has no automatic
    // closer: staff resolve it by hand in the health-alerts list.
    try {
      await db('customer_health_alerts').insert({
        customer_id: customer.id,
        alert_type: 'payment_failure',
        severity: 'high',
        title: `Autopay needs card authentication — ${dollars || 'amount unknown'} (${name})`,
        description: `The bank must approve this card charge, so it was NOT collected and no retry is scheduled. No message was sent to the customer. ${copy.line} The office bell could not be filed.`,
        trigger_data: JSON.stringify({ ...trigger, source: `autopay_sca_parked_${source}` }),
      });
    } catch (fallbackErr) {
      logger.error(`[autopay-sca] CRITICAL: customer ${customerId} autopay is parked on card authentication and neither the office alert nor the health-alert fallback could be written (${fallbackErr.message}); the sca_required autopay log row is the only record`);
    }
    return { filed: false, outcome };
  } catch (unexpected) {
    logger.error(`[autopay-sca] parked-charge handling failed for customer ${customerId}: ${unexpected.message}`);
    return { filed: false, outcome: null };
  }
}

module.exports = { parkScaChargeForOffice, scaParkedAlertKey };
