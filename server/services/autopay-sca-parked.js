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
async function alertAutopayScaParked(customer, err, { amount, source, kind = 'monthly', billedMonth = null }) {
  const customerId = String(customer.id);
  const paymentIntentId = err.stripePaymentIntentId || err.paymentRecord?.stripe_payment_intent_id || null;
  const attemptId = err.paymentRecord?.id || null;
  const owed = parseFloat(err.paymentRecord?.amount ?? amount);
  const dollars = Number.isFinite(owed)
    ? `$${owed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '';
  // Everything a closer needs rides in the alert's OWN metadata (and the fallback's trigger_data),
  // so closing never depends on the failed payments row existing (stripe.js can fail to insert it
  // and still throw this error with paymentRecord null): the obligation month (from the row the
  // charge wrote, else the caller's month), the amount, and whether it is monthly dues. A one-time
  // retry row cannot be tied to an explicit-amount replacement (no month stamp; amount-matching a
  // supersede would be a guess), so its alert is worded to be marked done by a person unless its
  // own row settles or is superseded.
  const alertKind = kind === 'one_time' ? 'one_time' : 'monthly';
  const obligationMonth = alertKind === 'monthly'
    ? (parseMetadata(err.paymentRecord?.metadata).billed_month || billedMonth || null)
    : null;
  const association = {
    customer_id: customerId,
    stripe_payment_intent_id: paymentIntentId,
    payment_id: attemptId,
    billed_month: obligationMonth,
    kind: alertKind,
    amount_cents: Number.isFinite(owed) ? Math.round(owed * 100) : null,
    source,
  };
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
      doneWhen: alertKind === 'monthly' ? 'charge_collected' : 'collected_and_marked_done',
      who: 'person',
    }, {
      // A needs-you money item must ring. With GATE_ADMIN_BELL_POLICY on, the policy silences any
      // admin notification that neither carries the explicit site tag nor is on an allowlist (the
      // category override is off by default for billing), and notifyAdmin then resolves a truthy
      // { id: null, suppressed: true } sentinel with NO row. bell: true is the sanctioned site-level
      // opt-in (docs/admin-notifications.md section 7; notification-bell-policy.js decision 1).
      bell: true,
      detail: `Autopay for ${name} (${dollars || 'amount unknown'}) was declined for customer authentication (3D Secure): the cardholder's bank has to approve the charge, and an automatic charge cannot do that. It was not collected and no retry is scheduled, so it will not collect on its own. No message was sent to the customer. Reach the customer to approve it with their bank, or collect it another way. ${alertKind === 'one_time' ? 'This is a one-time charge: it closes by itself only if this charge\'s own payment settles. If you collect it with a different payment, mark this done. ' : ''}Stripe PaymentIntent ${paymentIntentId || 'unknown'}${attemptId ? `, payment record ${attemptId}` : ''}.`,
      dedupeKey: scaParkedAlertKey(customerId, paymentIntentId || attemptId || etDateString().slice(0, 7)),
      metadata: association,
    });
  } catch (alertErr) {
    logger.error(`[autopay-sca] office alert threw for customer ${customerId}: ${alertErr.message}`);
  }
  // Filed = a notification row exists (new, or the standing row of this key). Policy suppression
  // and the internal-test-customer gate resolve a truthy { id: null, suppressed: true } with no
  // row, which is NOT a filed alert: it takes the same fallback path as a null.
  if (alert && !alert.suppressed && alert.id != null) return true;

  logger.error(`[autopay-sca] office alert NOT filed for customer ${customerId} (PI ${paymentIntentId || 'none'}): the autopay charge is parked on card authentication with no retry — falling back to a customer health alert`);
  try {
    await db('customer_health_alerts').insert({
      customer_id: customer.id,
      alert_type: 'payment_failure',
      severity: 'high',
      title: `Autopay needs card authentication — ${dollars || 'amount unknown'} (${name})`,
      description: 'The cardholder\'s bank has to approve this card charge, so it was NOT collected and no retry is scheduled. Reach the customer to approve it with their bank, or collect it another way. The office bell could not be filed.',
      trigger_data: JSON.stringify({ ...association, source: `${HEALTH_SOURCE_PREFIX}${source}` }),
    });
  } catch (fallbackErr) {
    logger.error(`[autopay-sca] CRITICAL: customer ${customerId} autopay is parked on card authentication and neither the office bell nor the health-alert fallback could be written (${fallbackErr.message}); the sca_required autopay_log row is the only record`);
  }
  return false;
}

// The health-alert fallback's `source` tag is `${HEALTH_SOURCE_PREFIX}<autopay|autopay_retry>`; its
// trigger_data also carries payment_id and stripe_payment_intent_id (the identifiers below).
const HEALTH_SOURCE_PREFIX = 'autopay_sca_parked_';
const HEALTH_ACTIVE = ['new', 'acknowledged']; // the table's live states (health-alerts.js, admin-health.js)

// Resolve the OPEN health-alert fallback rows written when the bell insert failed. Same row set
// the notification close covers (rows are the callers' payment rows), scoped by customer AND the
// payment / PI identifiers in trigger_data, so another customer's or another charge's alert is
// never touched. Resolved the way the existing updateAlert does (status 'resolved' + resolved_at /
// resolved_by / resolution_notes). Only live rows are selected, so a replay is a no-op.
async function resolveScaFallbackHealthAlerts(rows, { conn = db, resolution = null } = {}) {
  const byCustomer = new Map();
  for (const row of rows || []) {
    if (!row?.customer_id) continue;
    const ids = byCustomer.get(String(row.customer_id)) || { pis: new Set(), ids: new Set() };
    if (row.stripe_payment_intent_id) ids.pis.add(String(row.stripe_payment_intent_id));
    if (row.id != null) ids.ids.add(String(row.id));
    byCustomer.set(String(row.customer_id), ids);
  }
  let resolved = 0;
  for (const [customerId, { pis, ids }] of byCustomer) {
    resolved += await conn('customer_health_alerts')
      .where({ customer_id: customerId, alert_type: 'payment_failure' })
      .whereIn('status', HEALTH_ACTIVE)
      .whereRaw("starts_with(trigger_data->>'source', ?)", [HEALTH_SOURCE_PREFIX])
      .where(function () {
        this.whereRaw("trigger_data->>'stripe_payment_intent_id' = ANY(?::text[])", [[...pis]])
          .orWhereRaw("trigger_data->>'payment_id' = ANY(?::text[])", [[...ids]]);
      })
      .update({
        status: 'resolved',
        resolved_at: conn.fn.now(),
        resolved_by: 'system',
        resolution_notes: resolution || 'The parked autopay charge was collected',
        updated_at: conn.fn.now(),
      });
  }
  return resolved;
}

// Close the alert(s) for these payment rows ({ id, customer_id, stripe_payment_intent_id }): the
// bell row (by dedupe key) AND the health-alert fallback row. The two closes are independent, so
// one failing never blocks the other. Best-effort and never throws: clearing a bell must not
// fail a collection or a webhook.
async function closeScaParkedAlerts(rows, reason, { conn = db, resolution = null, extraKeys = [] } = {}) {
  try {
    await resolveScaFallbackHealthAlerts(rows, { conn, resolution });
  } catch (err) {
    logger.error(`[autopay-sca] could not resolve the parked-charge health alert (a replay of the settlement retries it): ${err.message}`);
  }
  try {
    const keys = [...extraKeys];
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
// The obligation-month matcher shared by every reader of "this customer's failed rows for month M"
// (the retry sweep's own shape: metadata.billed_month, else the payment_date window plus the
// 'WaveGuard Monthly' marker for unstamped legacy rows).
function monthScope({ monthKey, monthStart, monthEnd }) {
  return function () {
    this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
      .orWhere(function () {
        this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
          .andWhere('payment_date', '>=', monthStart)
          .andWhere('payment_date', '<=', monthEnd)
          .andWhere('description', 'like', '%WaveGuard Monthly%');
      });
  };
}

// `collected: false` is the variant for a FAILED canonical attempt (Charge now declined again): the
// older open rows are superseded to it so exactly one failed row carries the month, and nothing is
// closed because the debt is still owed.
async function resolveParkedMonthlyRows(customerId, period, collectedPaymentId, { conn = db, collected = true } = {}) {
  const { monthKey } = period;
  const resolved = await conn('payments')
    .where({ customer_id: customerId, status: 'failed' })
    .whereNull('superseded_by_payment_id')
    .whereNull('next_retry_at')
    .whereNot({ id: collectedPaymentId })
    .where(monthScope(period))
    .update({
      superseded_by_payment_id: collectedPaymentId,
      failure_reason: conn.raw("COALESCE(failure_reason, '') || ?", [collected
        ? ` — resolved: ${monthKey} collected by payment ${collectedPaymentId}`
        : ` — superseded by a newer failed attempt ${collectedPaymentId} for ${monthKey}`]),
    })
    .returning(['id', 'customer_id', 'stripe_payment_intent_id']);
  if (!collected) return resolved || [];
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

// Charge now (amount-less) FAILED for a month: keep exactly ONE canonical failed row per obligation
// (failed-payments.js sums every unsuperseded failed row, so two would double the debt). Same
// convention as the retry ladder: when an ARMED failed row for the month exists it stays canonical
// (it carries the ladder) and the new attempt row is superseded to it; otherwise the older unarmed
// rows (parked on 3DS, an exhausted ladder) are superseded to the new attempt row. Best-effort;
// never throws. Returns the canonical row id, or null.
async function reconcileFailedManualAttempt(customerId, period, attemptRow, { conn = db } = {}) {
  try {
    if (!attemptRow?.id) return null;
    const armed = await conn('payments')
      .where({ customer_id: customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .whereNotNull('next_retry_at')
      .whereNot({ id: attemptRow.id })
      .where(monthScope(period))
      .first('id');
    if (armed?.id != null) {
      await conn('payments').where({ id: attemptRow.id }).whereNull('superseded_by_payment_id')
        .update({ superseded_by_payment_id: armed.id });
      return armed.id;
    }
    await resolveParkedMonthlyRows(customerId, period, attemptRow.id, { conn, collected: false });
    return attemptRow.id;
  } catch (err) {
    logger.error(`[autopay-sca] could not link failed manual attempt ${attemptRow?.id} to the month's canonical failed row: ${err.message}`);
    return null;
  }
}

// A card needing 3D Secure leaves its PaymentIntent LIVE in Stripe (stripe.js does not cancel it), so
// collecting a replacement without neutralizing it can collect twice if the original is later completed
// (its succeeded webhook would flip the original row to paid). Called by Charge now INSIDE the customer
// billing lock, BEFORE the replacement charge: cancel the live intent of each of the customer's parked
// (requires_action) failed rows for the month through the shared PI guard (prepaid-pi-guard.js:
// cancels a cancelable intent, refuses when money is in flight, fails closed when unverifiable).
//   { ok: true }                                  - nothing parked, or all neutralized: safe to charge
//   { ok: false, reason: 'payment_in_flight' }    - the original is processing/succeeded: do NOT charge
//   { ok: false, reason: 'payment_session_unverifiable' } - fail closed
async function fenceParkedIntentsForReplacement(customerId, period, { conn = db } = {}) {
  const rows = await conn('payments')
    .where({ customer_id: customerId, status: 'failed' })
    .whereNull('superseded_by_payment_id')
    .whereNull('next_retry_at')
    .whereNotNull('stripe_payment_intent_id')
    .whereRaw("metadata->>'requires_action' = 'true'")
    .where(monthScope(period))
    .select('id', 'stripe_payment_intent_id');
  const { neutralizeOpenPaymentIntent } = require('./prepaid-pi-guard');
  for (const row of rows || []) {
    const result = await neutralizeOpenPaymentIntent(row.stripe_payment_intent_id);
    if (!result.ok) return { ...result, paymentId: row.id };
  }
  return { ok: true };
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

// Collected = this row is paid, or it was superseded by another payment that (following the supersede
// chain) is itself PAID. Superseded by a FAILED attempt row is NOT collected: a failed Charge now
// re-points the month's canonical row to the new failed attempt, and the debt is still owed.
async function rowIsCollected(row, conn) {
  let r = row;
  for (let hop = 0; hop < 10 && r; hop += 1) {
    if (String(r.status) === 'paid') return true;
    if (r.superseded_by_payment_id == null || String(r.superseded_by_payment_id) === String(r.id)) return false;
    r = await conn('payments').where({ id: r.superseded_by_payment_id }).first('id', 'status', 'superseded_by_payment_id');
  }
  return false;
}

// The durable closer. Every event-time close above (Charge now, the succeeded webhook, the
// already-collected retry) is the fast path and stays best-effort, but each hangs off one event and
// each can fail or never fire (a webhook redelivery is deduped, a customer can pay another way). This
// reconciler makes closure EVENTUALLY CORRECT regardless of the door the money came through: the
// daily retry sweep runs it, it reads only the OPEN alerts of this family (a small set found by the
// dedupe-key prefix / source tag, never a payments scan), and for each decides from the alert's own
// metadata whether the debt is still owed:
//   - the parked payments row (by id or PI) is now paid, or superseded (following the supersede chain)
//     by a PAID payment: collected (superseded by a FAILED attempt row is still owed);
//   - a MONTHLY alert and the customer has a paid payment stamped with that billed_month: collected,
//     and the parked rows of that month are superseded to it (resolveParkedMonthlyRows) if still open;
//   - otherwise still owed: left open. A one-time alert is judged on its own row only (no guessing
//     from an amount).
// Collected -> close the bell row and resolve the health-alert fallback. Idempotent (closed alerts are
// no longer selected), isolated per alert, and it never throws: it must never abort collections.
async function scaAlertIsCollected(item, conn) {
  const { customerId, paymentIntentId, paymentId, billedMonth, kind } = item;
  if (paymentId || paymentIntentId) {
    const rows = await conn('payments')
      .where({ customer_id: customerId })
      .where(function () {
        if (paymentId) this.where('id', paymentId);
        if (paymentId && paymentIntentId) this.orWhere('stripe_payment_intent_id', paymentIntentId);
        else if (paymentIntentId) this.where('stripe_payment_intent_id', paymentIntentId);
      })
      .select('id', 'status', 'superseded_by_payment_id');
    for (const r of rows || []) {
      if (await rowIsCollected(r, conn)) return { collected: true };
    }
  }
  if (kind === 'monthly' && /^\d{4}-\d{2}$/.test(String(billedMonth || ''))) {
    const paid = await conn('payments')
      .where({ customer_id: customerId, status: 'paid' })
      .whereRaw("metadata->>'billed_month' = ?", [billedMonth])
      .first('id');
    if (paid?.id != null) return { collected: true, paidPaymentId: paid.id };
  }
  return { collected: false };
}

async function reconcileScaParkedAlerts({ conn = db } = {}) {
  const summary = { examined: 0, collected: 0, failed: 0 };
  try {
    const { openAdminAlertMetadata } = require('./admin-alert-episodes');
    const items = [];
    for (const m of await openAdminAlertMetadata(conn, KEY_PREFIX)) {
      items.push({
        dedupeKey: m.dedupeKey || null, customerId: m.customer_id, paymentIntentId: m.stripe_payment_intent_id || null,
        paymentId: m.payment_id ?? null, billedMonth: m.billed_month || null, kind: m.kind === 'one_time' ? 'one_time' : 'monthly',
      });
    }
    const healthRows = await conn('customer_health_alerts')
      .where({ alert_type: 'payment_failure' })
      .whereIn('status', HEALTH_ACTIVE)
      .whereRaw("starts_with(trigger_data->>'source', ?)", [HEALTH_SOURCE_PREFIX])
      .select('customer_id', 'trigger_data');
    for (const h of healthRows || []) {
      const t = parseMetadata(h.trigger_data);
      items.push({
        dedupeKey: null, customerId: t.customer_id || h.customer_id, paymentIntentId: t.stripe_payment_intent_id || null,
        paymentId: t.payment_id ?? null, billedMonth: t.billed_month || null, kind: t.kind === 'one_time' ? 'one_time' : 'monthly',
      });
    }
    for (const item of items) {
      if (!item.customerId) continue;
      summary.examined += 1;
      try {
        const verdict = await scaAlertIsCollected(item, conn);
        if (!verdict.collected) continue;
        if (verdict.paidPaymentId != null) {
          const [y, mo] = item.billedMonth.split('-').map(Number);
          const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
          await resolveParkedMonthlyRows(item.customerId, {
            monthKey: item.billedMonth, monthStart: `${item.billedMonth}-01`,
            monthEnd: `${item.billedMonth}-${String(lastDay).padStart(2, '0')}`,
          }, verdict.paidPaymentId, { conn });
        }
        await closeScaParkedAlerts(
          [{ id: item.paymentId, customer_id: item.customerId, stripe_payment_intent_id: item.paymentIntentId }],
          'charge_collected',
          { conn, extraKeys: item.dedupeKey ? [item.dedupeKey] : [] },
        );
        summary.collected += 1;
      } catch (err) {
        summary.failed += 1;
        logger.error(`[autopay-sca] reconcile failed for customer ${item.customerId} (PI ${item.paymentIntentId || 'none'}): ${err.message}`);
      }
    }
  } catch (err) {
    summary.failed += 1;
    logger.error(`[autopay-sca] parked-alert reconcile could not read open alerts: ${err.message}`);
  }
  return summary;
}

module.exports = { KEY_PREFIX, scaParkedAlertKey, alertAutopayScaParked, closeScaParkedAlerts, resolveParkedMonthlyRows, settleParkedForPaidPayment, reconcileScaParkedAlerts,
  reconcileFailedManualAttempt, fenceParkedIntentsForReplacement };
