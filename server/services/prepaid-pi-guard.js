/**
 * Prepaid PaymentIntent guard — shared between the mark-prepaid receipt path
 * (admin-schedule) and the completion-side prepaid application (admin-dispatch).
 *
 * Marking an invoice paid by a cash/check/Zelle prepayment while it still carries
 * a live Stripe PaymentIntent (a /pay session the customer opened) lets that stale
 * client secret settle and charge the card AFTER we've marked it paid — a double
 * charge. Before crediting a prepayment against an invoice, callers run this guard
 * to neutralize the PI: cancel a cancelable one, or refuse when money is already
 * in flight or the PI can't be verified (fail closed).
 *
 * Mirrors the /admin/invoices apply-credit triage so all "mark paid by non-Stripe
 * means" paths handle the open-PI case identically.
 */

const logger = require('./logger');

// PI statuses where money is already moving — never cancel the PI or mark the
// invoice paid out from under it.
const PI_MONEY_IN_FLIGHT_STATUSES = ['processing', 'succeeded', 'requires_capture'];

// Returns { ok: true, piId } when it is safe to mark the invoice paid (no PI, or
// the open PI was cancelled), or { ok: false, reason } when the caller must NOT
// proceed:
//   payment_in_flight          — a card/ACH payment is settling; leave it to pay.
//   payment_session_unverifiable — Stripe unreachable/unconfigured or cancel
//                                   failed; fail closed rather than risk a double
//                                   charge.
async function guardOpenPaymentIntentForPrepaid(invoice) {
  const piId = invoice && invoice.stripe_payment_intent_id ? invoice.stripe_payment_intent_id : null;
  if (!piId) return { ok: true, piId: null };
  const StripeService = require('./stripe');
  let pi;
  try {
    pi = await StripeService.retrievePaymentIntent(piId);
  } catch (e) {
    logger.warn(`[prepaid-pi-guard] PI verify failed for ${piId}: ${e.message}`);
    return { ok: false, reason: 'payment_session_unverifiable' };
  }
  // Null = Stripe unconfigured/unreachable — fail closed rather than mark paid
  // while a live client secret could still settle.
  if (!pi) return { ok: false, reason: 'payment_session_unverifiable' };
  // An ACH micro-deposit verification sits in requires_action (not one of the
  // money-in-flight statuses) but is a LIVE payment the customer has started —
  // cancelling it would kill their bank-verification session. Treat it as in
  // flight and defer to manual reconciliation, never cancel it.
  const isMicrodepositVerification = pi.status === 'requires_action'
    && pi.next_action && pi.next_action.type === 'verify_with_microdeposits';
  if (PI_MONEY_IN_FLIGHT_STATUSES.includes(pi.status) || isMicrodepositVerification) {
    return { ok: false, reason: 'payment_in_flight' };
  }
  if (pi.status !== 'canceled') {
    try {
      await StripeService.cancelPaymentIntent(piId, { cancellation_reason: 'abandoned' });
    } catch (e) {
      logger.warn(`[prepaid-pi-guard] PI cancel failed for ${piId}: ${e.message}`);
      return { ok: false, reason: 'payment_session_unverifiable' };
    }
  }
  return { ok: true, piId };
}

module.exports = { PI_MONEY_IN_FLIGHT_STATUSES, guardOpenPaymentIntentForPrepaid };
