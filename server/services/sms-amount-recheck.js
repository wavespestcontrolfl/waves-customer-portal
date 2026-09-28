'use strict';
// Send-time amount revalidation, shared by the scheduler's fire-time path
// (where it was written) and the immediate Agent Review send (follow-up #2
// on PR #5119): an outgoing body carrying numeric amounts must still match
// the CURRENT authoritative billing values, re-read fresh from the context
// aggregator, because a card can wait through a payment or an invoice
// change that inbound-thread staleness never sees. Fail CLOSED on any
// error — an unknowable account state must not send figures.
const db = require('../models/db');
const logger = require('./logger');

// Every amount syntax hasPriceQuote recognizes: $-prefixed, USD-prefixed,
// and number-with-unit. Bare numerals stay out (dates, house numbers).
const AMOUNT_FORMS_RE = /(?:\$|\bUSD\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|bucks|usd)\b/gi;
// Payment ACKNOWLEDGEMENTS may cite payment-history amounts ("we received
// your $95 payment") — but only when the body reads as an ack, so a stale
// "your balance is $X" can never re-authorize via the payment row.
// "payment" must appear NEAR the ack verb — a generic "Thanks for reaching
// out — your balance is $X" must not unlock payment-history amounts.
const PAYMENT_ACK_RE = /\b(?:received|processed|went through)\b[^.\n]{0,30}\bpayment\b|\bpayment\b[^.\n]{0,30}\b(?:received|processed|went through)\b|\bthank(?:s| you)\b[^.\n]{0,25}\bpayment\b/i;

const cents = (v) => Math.round(Number(v) * 100);

function bodyAmountCents(body) {
  return (String(body || '').match(AMOUNT_FORMS_RE) || []).map((a) => cents(a.replace(/[^\d.]/g, '')));
}

/**
 * Are the amounts in `body` still backed by the customer's CURRENT billing
 * facts? Returns { stale: false } when the body carries no amounts or every
 * amount is authorized; { stale: true, reason } otherwise (including any
 * lookup failure). CURRENT OBLIGATIONS ONLY: a paid balance moves the same
 * figure into recent payments, so only what the customer still owes (balance,
 * open invoice, monthly dues) may validate an amount; payment-history amounts
 * validate only an acknowledgement.
 */
async function outgoingAmountsStale({ customerId, body, dbh = db } = {}) {
  const bodyAmounts = bodyAmountCents(body);
  if (!bodyAmounts.length) return { stale: false };
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    const ContextAggregator = require('./context-aggregator');
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    const ctx = customerRow ? await ContextAggregator.getContextForCustomer(customerRow) : null;
    const ackBody = PAYMENT_ACK_RE.test(String(body || ''));
    const authorized = new Set([
      ctx?.billing?.outstandingBalance > 0 ? cents(ctx.billing.outstandingBalance) : null,
      ctx?.billing?.openInvoice?.amountDue != null ? cents(ctx.billing.openInvoice.amountDue) : null,
      ...ContextAggregator.authorizedDuesCents(ctx),
      ...(ackBody ? (ctx?.billing?.recentPayments || []).map((p) => (p?.amount != null ? cents(p.amount) : null)) : []),
    ].filter((v) => Number.isFinite(v)));
    const stale = bodyAmounts.some((a) => !authorized.has(a));
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

module.exports = { outgoingAmountsStale, bodyAmountCents, AMOUNT_FORMS_RE, PAYMENT_ACK_RE };
