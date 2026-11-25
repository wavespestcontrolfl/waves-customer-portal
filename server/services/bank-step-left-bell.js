'use strict';

/**
 * Bank step left bell (owner 2026-11-24, "build bell").
 *
 * A customer picks Bank account on the pay page, Stripe's bank sign-in window
 * fails or gets closed, and the customer leaves. Stripe reports nothing for a
 * closed bank window, so the office used to hear about it only when the
 * customer texted. A browser "left the page" signal cannot tell a reload or a
 * retry from a real stop, so this check runs on the server instead:
 *
 * every 10 minutes it asks Stripe for invoice PaymentIntents still waiting for
 * a payment method with Bank account as the last method the pay page picked
 * (metadata.selected_method_category, refreshed with pay_session_touched_at on
 * every method switch). One that has sat 30 minutes to 24 hours, with no
 * payment error on it, on an invoice that is still the customer's to pay and
 * still points at that intent, rings ONE office bell through the existing
 * bill-payment alert path (deduped per invoice for 24 h).
 *
 * Read only toward customers: sends nothing to a customer, charges nothing,
 * writes only the alert row and the admin bell. No GATE_* (owner rule
 * 2026-11-05: an admin bell with no spend and no customer contact ships live).
 */

const db = require('../models/db');
const logger = require('./logger');
const { isInvoiceCollectibleStatus, invoiceAmountDue, invoiceWithdrawnFromCustomer } = require('./invoice-helpers');

const SEARCH_QUERY = "status:'requires_payment_method' AND metadata['selected_method_category']:'us_bank_account'";
const MIN_AGE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Stripe search pages of 100. Today the match set is a handful; a cap hit logs.
const MAX_PAGES = 100;
const MESSAGE = 'Bank account picked on the pay page, not paid after 30 minutes';

function touchedAtMs(pi) {
  const touched = Number(pi?.metadata?.pay_session_touched_at);
  if (Number.isFinite(touched) && touched > 0) return touched * 1000;
  const created = Number(pi?.created);
  return Number.isFinite(created) && created > 0 ? created * 1000 : null;
}

// Why one intent does not ring, or null when it should.
function skipReason(pi, invoice, nowMs) {
  const touched = touchedAtMs(pi);
  if (!touched) return 'no_touch_time';
  const age = nowMs - touched;
  if (age < MIN_AGE_MS) return 'too_recent';
  if (age > MAX_AGE_MS) return 'too_old';
  // Stripe search can match on a lagging index and return the CURRENT intent:
  // re-check the live state (an ACH debit processing or awaiting verification
  // must not ring).
  if (pi.status !== 'requires_payment_method') return 'status_changed';
  if (pi.metadata?.selected_method_category !== 'us_bank_account') return 'method_changed';
  // A confirm that failed already rang its own "Bank payment error" bell.
  if (pi.last_payment_error) return 'payment_error_on_intent';
  if (!invoice) return 'invoice_not_found';
  if (invoice.stripe_payment_intent_id !== pi.id) return 'intent_replaced';
  if (!isInvoiceCollectibleStatus(invoice.status)) return 'not_collectible';
  // Billed to a third party: the visitor may not be the service customer.
  if (invoice.payer_id || invoice.payer_statement_id || invoiceWithdrawnFromCustomer(invoice)) return 'payer_billed';
  if (invoice.archived_at) return 'archived';
  if (invoiceAmountDue(invoice) <= 0) return 'nothing_due';
  return null;
}

// A checkout error the office already got for this invoice since the customer's
// last touch (a browser-side bank confirm or network failure reported through
// POST /pay/:token/error can leave last_payment_error empty): no second bell.
async function errorAlreadyReported(invoice, pi) {
  const touched = touchedAtMs(pi);
  const row = await db('bill_payment_error_alerts')
    .where({ invoice_id: invoice.id })
    .whereNot({ phase: 'bank_step_left' })
    .where('last_seen_at', '>=', new Date(touched))
    .first('id');
  return !!row;
}

// One searched intent: ring, count a duplicate, or count why it was skipped.
async function checkIntent(pi, { nowMs, sendAlert, tally }) {
  const invoiceId = pi.metadata?.waves_invoice_id;
  const invoice = invoiceId ? await db('invoices').where({ id: invoiceId }).first() : null;
  const reason = skipReason(pi, invoice, nowMs) || (await errorAlreadyReported(invoice, pi) ? 'error_already_reported' : null);
  if (reason) {
    tally.skipped[reason] = (tally.skipped[reason] || 0) + 1;
    return;
  }
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
  else tally.skipped[result?.reason || 'alert_skipped'] = (tally.skipped[result?.reason || 'alert_skipped'] || 0) + 1;
}

async function runBankStepLeftBell({ now = new Date(), stripe, alert } = {}) {
  const client = stripe === undefined ? require('./stripe').getStripe() : stripe;
  if (!client) return { skipped: 'stripe_unavailable', candidates: 0, rang: 0 };
  const sendAlert = alert || require('./bill-payment-error-alerts').alertBillPaymentError;
  const ctx = { nowMs: now.getTime(), sendAlert, tally: { candidates: 0, rang: 0, duplicate: 0, skipped: {}, failed: 0 } };
  const { tally } = ctx;

  let nextPage = null;
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo += 1) {
    const page = await client.paymentIntents.search({ query: SEARCH_QUERY, limit: 100, ...(nextPage ? { page: nextPage } : {}) });
    for (const pi of page?.data || []) {
      tally.candidates += 1;
      try {
        await checkIntent(pi, ctx);
      } catch (err) {
        tally.failed += 1;
        logger.warn(`[bank-step-left-bell] check failed for ${pi.id}: ${err.code || err.name || 'error'}`);
      }
    }
    nextPage = page?.has_more ? page.next_page : null;
    if (!nextPage) break;
    if (pageNo === MAX_PAGES - 1) logger.warn(`[bank-step-left-bell] stopped at the ${MAX_PAGES}-page cap with more results`);
  }
  logger.info(`[bank-step-left-bell] ${tally.candidates} bank-picked intents, ${tally.rang} rang, ${tally.duplicate} already rung, ${tally.failed} failed, skipped ${JSON.stringify(tally.skipped)}`);
  return tally;
}

module.exports = { runBankStepLeftBell, __private: { skipReason, touchedAtMs, SEARCH_QUERY, MIN_AGE_MS, MAX_AGE_MS } };
