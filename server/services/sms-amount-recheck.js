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

// Independent-review P1 (finding 4, PR #5331): ZELLE_RECIPIENT is a live env
// var (no redeploy to flip), so it can change — or disappear — between a
// card's draft time and the moment it actually sends. "Zelle to <contact>"
// is the ONLY wording the drafter's own PAYMENT OPTIONS fact ever produces
// (buildFactsBlock / the paymentMoneyExtra prompt bullet in
// sms-shadow-drafter.js), so this same shape catches both an unedited draft
// and a human-edited body that still carries one.
// Any email, and any 10/11-digit US phone in whatever format ("(941) 555-1234",
// "941.555.1234", "+1 941 555 1234"), anywhere in a body that mentions Zelle.
// Phrase-anchored matching ("Zelle to X") missed "Zelle us at X" and "our
// Zelle is X", so every contact-shaped token in a Zelle body must be the
// current recipient.
const ZELLE_WORD_RE = /\bzelle\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const phoneDigits = (v) => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

function zelleBodyContacts(body) {
  const text = String(body || '');
  if (!ZELLE_WORD_RE.test(text)) return [];
  return [
    ...(text.match(EMAIL_RE) || []).map((e) => ({ kind: 'email', value: e.toLowerCase() })),
    ...(text.match(PHONE_RE) || []).map((ph) => ({ kind: 'phone', value: phoneDigits(ph) })),
  ];
}

/**
 * Is every contact in a Zelle-mentioning body still the one Waves actually
 * accepts? { stale: false } when the body mentions no Zelle contact;
 * otherwise stale unless Zelle is currently enabled AND each contact equals
 * the CURRENT manualPayOptionsFromEnv recipient (email case-insensitive,
 * phone by digits). Fail CLOSED: a rotated or disabled recipient blocks the
 * send exactly like a stale dollar amount.
 */
function outgoingZelleStale(body) {
  const contacts = zelleBodyContacts(body);
  if (!contacts.length) return { stale: false };
  const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');
  const current = manualPayOptionsFromEnv()?.zelle?.recipient || null;
  if (!current) return { stale: true, reason: 'zelle_recipient_stale' };
  const currentEmail = String(current).toLowerCase();
  const currentPhone = phoneDigits(current);
  const ok = contacts.every((c) => (c.kind === 'email'
    ? c.value === currentEmail
    : currentPhone.length >= 10 && c.value === currentPhone));
  return ok ? { stale: false } : { stale: true, reason: 'zelle_recipient_stale' };
}

/**
 * Pre-push audit P1 (finding 2): a Zelle contact that still matches the
 * CURRENT recipient (outgoingZelleStale above) is not enough on its own —
 * the invoice the drafter checked isZelleTransferEligible against when it
 * built the fact may have since been paid off, or a saved-card charge or
 * PaymentIntent may have started, either of which the pay page would now
 * withhold Zelle for. Re-runs the SAME predicate (server/routes/pay-v2.js)
 * against that invoice's CURRENT state, exactly as fetchZelleEligibility
 * (sms-shadow-drafter.js) does at draft time. Fail CLOSED: no customerId,
 * no zelleInvoiceId (a body a human typed Zelle into by hand carries no
 * snapshot), an invoice that no longer resolves to this customer, or any
 * lookup error are all treated as ineligible.
 */
async function zelleInvoiceStillEligible({ customerId, zelleInvoiceId, dbh = db } = {}) {
  if (!customerId || !zelleInvoiceId) return { eligible: false, reason: 'zelle_invoice_unresolved' };
  try {
    const invoiceRow = await dbh('invoices').where({ id: zelleInvoiceId, customer_id: customerId }).first();
    if (!invoiceRow) return { eligible: false, reason: 'zelle_invoice_unresolved' };
    const { isZelleTransferEligible } = require('../routes/pay-v2');
    const eligible = Boolean(await isZelleTransferEligible(invoiceRow));
    return eligible ? { eligible: true } : { eligible: false, reason: 'zelle_invoice_ineligible' };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] Zelle eligibility recheck failed for customer ${customerId}: ${err.message}; blocking send`);
    return { eligible: false, reason: 'zelle_recheck_failed' };
  }
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

async function outgoingAmountsStale({ customerId, body, promptVersion = null, zelleInvoiceId = null, dbh = db } = {}) {
  const text = String(body || '');
  // Independent-review P1 (finding 4): checked unconditionally, ahead of
  // the amount rules below and regardless of prompt version — a Zelle
  // contact is real payment instructions whether or not the body also
  // carries a dollar figure, and this same function is the one place both
  // send-time seams (the immediate Agent Review send via
  // agent-decision-send-checks.js, and the scheduler's queued-send fire-
  // time recheck) already share.
  const zelle = outgoingZelleStale(text);
  if (zelle.stale) return zelle;
  // Pre-push audit P1 (finding 2): checked right alongside the recipient
  // check above, and only when the body actually mentions a Zelle contact —
  // a body with no Zelle contact has nothing to recheck.
  if (zelleBodyContacts(text).length) {
    const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId, dbh });
    if (!eligibility.eligible) return { stale: true, reason: eligibility.reason };
  }
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

module.exports = { outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible };
