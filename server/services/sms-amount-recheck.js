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
const drafter = require('./sms-shadow-drafter');

// The amount forms and the payment-acknowledgement grammar are the
// draft-time guard's own (one definition for both amount guards): every
// amount syntax hasPriceQuote recognizes, and payment-history amounts only
// on a body that reads as an ack, so a stale "your balance is $X" can never
// re-authorize via the payment row.
const { AMOUNT_MASK_RE: AMOUNT_FORMS_RE, PAYMENT_ACK_RE } = drafter;

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
// `promptVersion` (the decision's own) selects the strict rule: a real-
// answers draft is rechecked as one even after the gate is rolled back
// while its card is still pending (Codex #5194 r2 P1). Without a version
// the live gate decides.
function strictForVersion(promptVersion) {
  if (typeof promptVersion === 'string' && promptVersion) return promptVersion.startsWith('house_voice_v12');
  return require('./sms-followup-sla').realAnswersGateOn();
}

async function outgoingAmountsStale({ customerId, body, promptVersion = null, dbh = db } = {}) {
  const text = String(body || '');
  const strict = strictForVersion(promptVersion);
  const amounts = bodyAmountCents(text);
  if (!amounts.length) {
    // Price grammar the numeric extractor cannot verify ("fifty dollars",
    // "45/mo") is unverifiable, not amount-free (audit P1): with real
    // answers on it fails closed, mirroring the drafter's draft-time rule.
    const unverifiable = strict && require('./sms-suggest-mode').hasPriceQuote(text);
    return unverifiable ? { stale: true, reason: 'amount_unverifiable' } : { stale: false };
  }
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    const ctx = (customerRow && await require('./context-aggregator').getContextForCustomer(customerRow)) || {};
    // With real answers on, the drafter's clause-aware guard is the whole
    // rule (Codex #5194 r1 P1; r5: its checks are a superset of the pooled
    // one below): each amount binds to the meaning of its own clause, and
    // only payments that went through back an acknowledgement — a payment
    // that later failed, was refunded or disputed no longer authorizes "we
    // received your $95 payment", even when the reversal reopened a balance
    // for the same figure. Otherwise the pooled rule over the same shared
    // figures: what is still owed, plus payment history only when the body
    // reads as an acknowledgement (masked first, audit P1 — the ack grammar
    // stops at a period, and "$95.50" must not end the clause).
    const { owed, paid } = drafter.billingAmountCents(ctx);
    const ack = PAYMENT_ACK_RE.test(text.replace(AMOUNT_FORMS_RE, ' AMT '));
    const stale = strict
      ? drafter.replyQuotesUngroundedAmount(text, ctx, { byMeaning: true })
      : amounts.some((a) => !owed.has(a) && !(ack && paid.has(a)));
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

module.exports = { outgoingAmountsStale, bodyAmountCents };
