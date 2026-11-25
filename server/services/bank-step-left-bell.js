'use strict';

/**
 * Bank step left bell (owner 2026-11-24, "build bell").
 *
 * A customer picks Bank account on the pay page, Stripe's bank sign-in window
 * fails or gets closed, and the customer leaves. Stripe reports nothing for a
 * closed bank window, so the office used to hear about it only when the
 * customer texted. A browser "left the page" signal cannot tell a reload or a
 * retry from a real stop, so this runs on the server:
 *
 * - POST /pay/:token/update-amount calls recordBankSelection: a switch to
 *   us_bank_account upserts the invoice's pay_bank_selections row (selected_at
 *   = now), any other method deletes it. A reload re-mints on card, so the row
 *   goes away; only a page LEFT on Bank account keeps it.
 * - Every 10 minutes runBankStepLeftBell reads rows selected 30 minutes to 24
 *   hours ago. An invoice that is still the customer's to pay (collectible,
 *   amount due, not archived, no third-party payer right now), still points at
 *   that intent, has no checkout error reported since the selection and no
 *   bank-step bell in the last 24 h, and whose LIVE Stripe intent still waits
 *   for a payment method on Bank account with no payment error, rings ONE
 *   bill_payment_error bell (phase bank_step_left, "Bank payment not
 *   finished") through alertBillPaymentError.
 *
 * Sends nothing to a customer and charges nothing; writes only the alert row
 * and the admin bell. No GATE_* (owner rule 2026-11-05).
 */

const db = require('../models/db');
const logger = require('./logger');
const { isInvoiceCollectibleStatus, invoiceAmountDue, invoiceWithdrawnFromCustomer } = require('./invoice-helpers');

const MIN_AGE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 200;
const MESSAGE = 'Bank account picked on the pay page, not paid after 30 minutes';

async function recordBankSelection(invoiceId, methodCategory, paymentIntentId, { now = new Date() } = {}) {
  if (!invoiceId) return;
  try {
    if (methodCategory === 'us_bank_account' && paymentIntentId) {
      await db('pay_bank_selections')
        .insert({ invoice_id: invoiceId, payment_intent_id: String(paymentIntentId).slice(0, 128), selected_at: now })
        .onConflict('invoice_id')
        .merge(['payment_intent_id', 'selected_at']);
    } else {
      await db('pay_bank_selections').where({ invoice_id: invoiceId }).del();
    }
  } catch (err) {
    logger.warn(`[bank-step-left-bell] record selection failed for invoice ${invoiceId}: ${err.code || err.name || 'error'}`);
  }
}

// Invoice-side reasons not to ring (a cheap pass, before any Stripe call).
async function invoiceSkipReason(sel, invoice, nowMs) {
  if (!invoice) return 'invoice_not_found';
  if (invoice.stripe_payment_intent_id !== sel.payment_intent_id) return 'intent_replaced';
  if (!isInvoiceCollectibleStatus(invoice.status)) return 'not_collectible';
  if (invoice.archived_at) return 'archived';
  if (invoiceAmountDue(invoice) <= 0) return 'nothing_due';
  if (invoiceWithdrawnFromCustomer(invoice)) return 'payer_billed';
  // Billed to a third party right now (also a payer assigned through the visit
  // or the customer after the invoice was minted): the visitor may not be the
  // service customer. Unverifiable fails closed.
  const owner = await require('./invoice-payer-ownership').invoicePayerOwnership(invoice);
  if (owner) return owner;
  const rung = await db('bill_payment_error_alerts')
    .where({ invoice_id: invoice.id, phase: 'bank_step_left' })
    .where('notified_at', '>', new Date(nowMs - MAX_AGE_MS))
    .first('id');
  if (rung) return 'already_rung';
  // A checkout error already reported since the selection (a browser-side bank
  // confirm or network failure can leave the intent without last_payment_error).
  const reported = await db('bill_payment_error_alerts')
    .where({ invoice_id: invoice.id })
    .whereNot({ phase: 'bank_step_left' })
    .where('last_seen_at', '>=', new Date(sel.selected_at))
    .first('id');
  if (reported) return 'error_already_reported';
  return null;
}

// The live intent, re-checked: still waiting for a method, on Bank account.
function intentSkipReason(pi) {
  if (!pi) return 'intent_not_found';
  if (pi.status !== 'requires_payment_method') return 'status_changed';
  if (pi.metadata?.selected_method_category !== 'us_bank_account') return 'method_changed';
  // A confirm that failed already rang its own "Bank payment error" bell.
  if (pi.last_payment_error) return 'payment_error_on_intent';
  return null;
}

async function checkSelection(sel, { nowMs, client, sendAlert, tally }) {
  const skip = (why) => { tally.skipped[why] = (tally.skipped[why] || 0) + 1; };
  const invoice = (await db('invoices').where({ id: sel.invoice_id }).first()) || null;
  const invoiceReason = await invoiceSkipReason(sel, invoice, nowMs);
  if (invoiceReason) return skip(invoiceReason);
  const pi = await client.paymentIntents.retrieve(sel.payment_intent_id);
  const intentReason = intentSkipReason(pi);
  if (intentReason) return skip(intentReason);
  const result = await sendAlert({
    invoice,
    phase: 'bank_step_left',
    methodCategory: 'us_bank_account',
    paymentIntentId: pi.id,
    message: MESSAGE,
    source: 'server',
  });
  if (result?.notified) tally.rang += 1;
  else if (result?.duplicate) tally.duplicate += 1;
  else if (result?.error) tally.failed += 1;
  else skip(result?.reason || 'alert_skipped');
  return undefined;
}

async function runBankStepLeftBell({ now = new Date(), stripe, alert } = {}) {
  const client = stripe === undefined ? require('./stripe').getStripe() : stripe;
  if (!client) return { skipped: 'stripe_unavailable', candidates: 0, rang: 0 };
  const nowMs = now.getTime();
  const ctx = {
    nowMs,
    client,
    sendAlert: alert || require('./bill-payment-error-alerts').alertBillPaymentError,
    tally: { candidates: 0, rang: 0, duplicate: 0, skipped: {}, failed: 0 },
  };
  const { tally } = ctx;
  const rows = await db('pay_bank_selections')
    .where('selected_at', '<=', new Date(nowMs - MIN_AGE_MS))
    .where('selected_at', '>=', new Date(nowMs - MAX_AGE_MS))
    .orderBy('selected_at', 'asc')
    .limit(BATCH_LIMIT)
    .select('invoice_id', 'payment_intent_id', 'selected_at');
  for (const sel of rows) {
    tally.candidates += 1;
    try {
      await checkSelection(sel, ctx);
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[bank-step-left-bell] check failed for invoice ${sel.invoice_id}: ${err.code || err.name || 'error'}`);
    }
  }
  logger.info(`[bank-step-left-bell] ${tally.candidates} bank selections, ${tally.rang} rang, ${tally.duplicate} already rung, ${tally.failed} failed, skipped ${JSON.stringify(tally.skipped)}`);
  return tally;
}

module.exports = { recordBankSelection, runBankStepLeftBell, __private: { invoiceSkipReason, intentSkipReason, MIN_AGE_MS, MAX_AGE_MS } };
