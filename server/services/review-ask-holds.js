'use strict';

/**
 * Review-ask holds read before a cadence ask goes out
 * (GATE_REVIEW_ASK_TECH_VOICE; build plan PR 2, owner rulings 2026-10-01).
 * The sequence runner records every hold on the sequence with its reason
 * (decision), so the review page can show it.
 *
 *   paymentHold   An open overdue invoice, or an overdue-payment reminder
 *                 delivered in the last 3 days: the ask waits for the hold
 *                 to clear.
 *   askHold       The runner's one call: what to do with this ask (drop,
 *                 wait, or send).
 *
 * The repeat hold (a later touch that repeats an earlier one) needs the
 * drafted text, so it lives with the writer (review-ask-drafter.js). The
 * "customer says they already left a review" hold is its own PR (owner
 * 2026-10-02): checked once per text as it arrives.
 */

const db = require('../models/db');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAYMENT_TEXT_HOLD_MS = 3 * DAY_MS;
// A payment-held ask waits at most this long from when its step was first
// held, then the step is dropped (owner ruling 2026-10-01: "the ask waits for
// the hold to clear, inside its normal window, or is dropped").
const PAYMENT_HOLD_MAX_WAIT_MS = 3 * DAY_MS;

/**
 * Why the ask waits, or null. { reason: 'overdue_invoice', invoiceId } |
 * { reason: 'payment_reminder_recent', at, until }. A failed read holds
 * ({ reason: 'payment_lookup_unavailable' }): the ruling is "no review ask
 * while", so no evidence is never a clear.
 *
 * The customer's own open bills are the pay page's authority
 * (open-balance.js openBalanceInvoices: delivered, a positive amount due
 * after credit, not payer- or statement-billed, not withdrawn); overdue is
 * dunning's rule (account-anchor.js: status overdue, or past its due day,
 * a legacy invoice with no due date by its created day).
 */
async function paymentHold(customerId, { now = new Date() } = {}) {
  try {
    const { openBalanceInvoices } = require('./open-balance');
    const { invoiceDaysOverdue } = require('./collections/account-anchor');
    let incomplete = false;
    const markIncomplete = () => { incomplete = true; };
    const open = await openBalanceInvoices(customerId, { database: db, onResolveFailure: markIncomplete, onTruncation: markIncomplete });
    const overdue = open.find((inv) => inv.status === 'overdue' || invoiceDaysOverdue(now, inv) > 0);
    if (overdue) return { reason: 'overdue_invoice', invoiceId: overdue.id };
    // A bill dropped because its payer could not be resolved, or one beyond
    // the read's cap, may be theirs and overdue.
    if (incomplete) return { reason: 'payment_lookup_unavailable' };
    // Every reminder row that is not a confirmed failure counts, the dunning
    // rule's own doctrine (over-report, never under-report): several rails
    // record before the send and never stamp a delivery, so requiring one
    // would miss real reminders. A row whose send never happened costs one
    // review ask delayed at most 3 days; a missed reminder sends an ask
    // right after a payment reminder, which the hold exists to prevent.
    const { lastOverdueReminderWithin7d } = require('./collections/dunning-spacing');
    const last = await lastOverdueReminderWithin7d(customerId, { now, database: db });
    if (last && now.getTime() - new Date(last.occurred_at).getTime() < PAYMENT_TEXT_HOLD_MS) {
      return { reason: 'payment_reminder_recent', at: new Date(last.occurred_at), until: new Date(new Date(last.occurred_at).getTime() + PAYMENT_TEXT_HOLD_MS) };
    }
    return null;
  } catch (err) {
    logger.warn(`[review-holds] payment hold read failed (customerId=${customerId}): ${err.message}`);
    return { reason: 'payment_lookup_unavailable' };
  }
}

/**
 * What the runner does with this cadence ask (switch on, ask steps only):
 *   null                                          send it
 *   { kind: 'drop', detail }                      payment-held past its window
 *   { kind: 'wait', retryAt, heldSince, detail }
 * `shiftRetry` moves a retry time onto the step's own send days.
 *
 * The hold's start rides its own columns (payment_hold_step / _since), which
 * no other deferral rewrites; past its window the step is dropped even if
 * the hold cleared in between (it would go out late).
 */
async function askHold(seq, { now = new Date(), shiftRetry = null } = {}) {
  // Through the exports, so a test can stand in for the check.
  const payment = await module.exports.paymentHold(seq.customer_id, { now });
  const heldBefore = seq.payment_hold_step === seq.current_step && seq.payment_hold_since ? new Date(seq.payment_hold_since) : null;
  const heldSince = heldBefore || (payment ? now : null);
  if (!heldSince) return null;
  const dropAt = new Date(heldSince.getTime() + PAYMENT_HOLD_MAX_WAIT_MS);
  const detail = {
    step: seq.current_step, hold: payment ? payment.reason : 'cleared_after_window', heldSince: heldSince.toISOString(),
    ...(payment?.invoiceId ? { invoiceId: payment.invoiceId } : {}),
  };
  if (now.getTime() >= dropAt.getTime()) return { kind: 'drop', detail };
  if (!payment) return null;
  const wait = payment.until ? new Date(payment.until)
    : new Date(now.getTime() + (payment.reason === 'payment_lookup_unavailable' ? 30 * 60 * 1000 : DAY_MS));
  const shifted = shiftRetry ? shiftRetry(wait) : wait;
  return { kind: 'wait', retryAt: shifted > dropAt ? dropAt : shifted, heldSince, detail };
}

module.exports = {
  askHold,
  paymentHold,
  PAYMENT_TEXT_HOLD_MS,
  PAYMENT_HOLD_MAX_WAIT_MS,
};
