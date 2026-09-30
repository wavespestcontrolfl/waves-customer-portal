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

// Independent-review P1 (round 3, PR #5331, finding 1): distinguishes an
// AFFIRMATIVE Zelle offer ("Yes, you can use Zelle") from truthful negative
// copy ("we don't take Zelle anymore", "Zelle isn't available right now") —
// in the drafter's own hasAffirmativePaymentAck style (split on clause
// boundaries, test negation within the SAME clause as the mention, never the
// whole reply). Self-contained here (rather than imported from the drafter)
// so this send-time guard has no dependency on the drafter module beyond the
// two constants it already shares (AMOUNT_MASK_RE/PAYMENT_ACK_RE above) —
// several callers mock sms-shadow-drafter down to a bare stub. Any clause
// that mentions Zelle without one of these negations is affirmative, WHETHER
// OR NOT it also names a specific contact — the send-time guard used to
// re-check a body only when it named a phone/email (zelleBodyContacts(...).length),
// so "Yes, you can use Zelle" (no contact) sailed through unchecked even
// after ZELLE_RECIPIENT was disabled or the invoice became ineligible.
const ZELLE_NEGATION_RE = /\b(?:don't|do not|doesn't|does not|didn't|did not|isn't|is not|aren't|are not|can't|cannot|can not|won't|will not|couldn't|could not|wouldn't|would not|no longer|not able|unable|unavailable|not currently|not right now|stopped (?:taking|accepting))\b/i;
// Same clause-boundary split as the drafter's own CLAUSE_SPLIT_RE (not
// exported — kept as a parallel literal since both only ever need to agree
// on how a reply is split into clauses, never on a shared regex object). The
// day/year comma guard mirrors the drafter's own fix (independent-review P2,
// round 4): "September 12, 2026" must stay one clause so a Zelle RECEIPT
// clause's stated date keeps its year (see classifyZelleClause below).
const CLAUSE_SPLIT_RE = /(?<=[;!?\n])|(?<=\.)(?=\s|$)|,\s(?!\d{4}\b(?!\d))|\s(?:and|but)\s|\s[—–-]\s/;

// Independent-review P1 (round 4, PR #5331, finding 1): a Zelle-mentioning
// clause is either an INSTRUCTION/OFFER ("you can Zelle us", "Zelle to
// <contact>", "we accept Zelle") — a live payment instruction that must still
// point at the CURRENT recipient and an eligible invoice — or a HISTORICAL
// RECEIPT ("We received your $120 Zelle payment from Sep 12") — a report of
// something that already happened, which the amount/date/tender binder above
// (bindPaidPaymentRow, in sms-shadow-drafter.js) already verifies on its own
// terms. Treating every affirmative Zelle mention as an OFFER (the old rule)
// meant a truthful receipt confirmation started failing the recipient/
// eligibility recheck the moment the invoice it paid off had nothing left
// owing (zelleInvoiceId resolves to null — "zelle_invoice_unresolved" — for a
// payment that already succeeded). STRUCTURAL, DEFAULT-DENY: only a clause
// that reads UNAMBIGUOUSLY as past-tense history, with no offer/instruction
// wording of its own, is a receipt; anything else — plain offer language, or
// a clause this pattern cannot confidently read as history — is an OFFER,
// the stricter path (recipient + eligibility still recheck it). A clause
// naming both ("we got your Zelle payment; you can also Zelle the rest to
// X") is a live instruction too, whatever else it also reports.
const ZELLE_OFFER_RE = /\b(?:can|could|may|feel free to|please)\b[^.\n]{0,30}\bzelle\b|\buse\s+zelle\b|\bzelle\s+(?:us|to|it|that)\b|\bpay(?:ing)?\s*(?:via|by|with|through)\s+zelle\b|\baccept(?:s|ed|ing)?\s+zelle\b|\bsend\b[^.\n]{0,20}\bzelle\b/i;
// Independent-review P1 (round 5, finding 2): RECEIPT now requires an
// explicit past-tense/completed verb IN THE SAME CLAUSE — the old third
// alternative ("your … Zelle … payment") matched pure structure, no verb at
// all, so "For your Zelle payment, use old@example.com" (an INSTRUCTION,
// split by the clause boundary from its own "use <contact>" half) read as a
// receipt and bypassed the offer rechecks below entirely. A clause naming an
// instruction marker (use/send/pay/can/please) is never a receipt even when
// it also carries a past-tense verb ("we received your payment; please
// Zelle the rest" is still an offer for its own half — that clause already
// splits out under CLAUSE_SPLIT_RE, this guard covers the residual case
// where it doesn't).
// P2 (round 6, PR #5331): the verb list is now the SHARED
// payment-receipt-vocabulary.js RECEIPT_VERB_RE — one definition with
// sms-shadow-drafter.js's PAYMENT_ACK_RE, rather than a second copy of the
// same words maintained independently here — plus THANKS_FOR_PAYMENT_RE, so
// "Thanks for processing my Zelle payment!" / "Thank you, the Zelle payment
// cleared" read as a historical RECEIPT exactly like a bare verb does.
const { RECEIPT_VERB_RE, THANKS_FOR_PAYMENT_RE, mayAssertPaymentStatus } = require('./payment-receipt-vocabulary');
const ZELLE_INSTRUCTION_MARKER_RE = /\b(?:use|send|pay|can|please)\b/i;
// null (no affirmative Zelle mention in this clause), else 'offer' | 'receipt'.
function classifyZelleClause(clause) {
  const text = String(clause || '');
  if (!ZELLE_WORD_RE.test(text) || ZELLE_NEGATION_RE.test(text)) return null;
  if (ZELLE_OFFER_RE.test(text)) return 'offer';
  // A clause naming a specific contact (email/phone) is ALWAYS live payment
  // instructions, whatever verb it does or doesn't carry (finding 2):
  // "For your Zelle payment, use old@example.com" names no offer VERB, but
  // a contact address is never something a historical receipt states.
  if (zelleBodyContacts(text).length) return 'offer';
  if ((RECEIPT_VERB_RE.test(text) || THANKS_FOR_PAYMENT_RE.test(text)) && !ZELLE_INSTRUCTION_MARKER_RE.test(text)) return 'receipt';
  // Ambiguous — mentions Zelle affirmatively but matches neither pattern —
  // fails closed as an OFFER (the stricter path).
  return 'offer';
}
function hasAffirmativeZelleMention(body) {
  const clauses = String(body || '').split(CLAUSE_SPLIT_RE);
  return clauses.some((clause) => classifyZelleClause(clause) === 'offer');
}

/**
 * Is a Zelle-mentioning body still safe to send? { stale: false } when the
 * body carries no AFFIRMATIVE Zelle mention at all (negative copy — "we
 * don't take Zelle" — never trips this, via hasAffirmativeZelleMention above).
 *
 * Independent-review P1 (round 3, PR #5331, finding 1): an affirmative
 * mention with NO contact ("Yes, you can use Zelle") still needs the
 * recipient-enabled check below — the prior gate only ran on
 * zelleBodyContacts(...).length, so an affirmative offer naming no specific
 * contact sailed through even after ZELLE_RECIPIENT was disabled. Only when
 * the body ALSO names a specific contact is that contact checked against the
 * CURRENT recipient (email case-insensitive, phone by digits). Fail CLOSED:
 * a rotated or disabled recipient blocks the send exactly like a stale
 * dollar amount.
 */
function outgoingZelleStale(body) {
  const text = String(body || '');
  if (!hasAffirmativeZelleMention(text)) return { stale: false };
  const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');
  const current = manualPayOptionsFromEnv()?.zelle?.recipient || null;
  if (!current) return { stale: true, reason: 'zelle_recipient_stale' };
  const contacts = zelleBodyContacts(text);
  if (!contacts.length) return { stale: false };
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
 *
 * Independent-review P1 (round 2, PR #5331): also re-checks estimate-deposit
 * settlement readiness — a receipt can commit (and its credit stay
 * unposted) between the draft's own fetchZelleEligibility read and this
 * send-time recheck, exactly like every other condition here. GET /:token
 * refuses the whole pay page for this case via withInvoiceDepositSettlement,
 * a fence pay-v2.js's own payPageZelleVisibility predicate does not run
 * itself (every other caller of it already sits inside that fence) — so
 * this path, like fetchZelleEligibility's, runs it explicitly alongside.
 *
 * Independent-review P1 (round 5, findings 3 & 4): calls the SAME shared
 * payPageZelleVisibility pay-v2.js exports — never the bare isZelleTransferEligible
 * predicate alone — so a live-resolved payer or a pending partial account
 * credit blocks the send exactly as they now block the pay page itself.
 */
async function zelleInvoiceStillEligible({ customerId, zelleInvoiceId, dbh = db } = {}) {
  if (!customerId || !zelleInvoiceId) return { eligible: false, reason: 'zelle_invoice_unresolved' };
  try {
    const invoiceRow = await dbh('invoices').where({ id: zelleInvoiceId, customer_id: customerId }).first();
    if (!invoiceRow) return { eligible: false, reason: 'zelle_invoice_unresolved' };
    try {
      await require('./estimate-deposits').assertInvoiceDepositSettlementReady(dbh, invoiceRow, { lock: false });
    } catch (err) {
      if (err.code !== 'DEPOSIT_RECONCILIATION_REQUIRED') throw err;
      return { eligible: false, reason: 'zelle_invoice_ineligible' };
    }
    const { payPageZelleVisibility } = require('../routes/pay-v2');
    const visibility = await payPageZelleVisibility({ invoice: invoiceRow, dbh });
    return visibility.visible ? { eligible: true } : { eligible: false, reason: 'zelle_invoice_ineligible' };
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

// Independent-review P1 (round 5, finding 1): a body with NO dollar amount at
// all can still assert a payment-status or receipt fact ("You're paid up.",
// "We have your payment.") that the strict clause-aware binder
// (replyQuotesUngroundedAmount, via paymentStatusClaimKind / hasAffirmativePaymentAck)
// already validates at DRAFT time — but outgoingAmountsStale's own no-amount
// fast path used to return clean without ever re-fetching billing, so a v12
// "You're paid up" that stopped being true between draft and send (a new
// charge posted, a payment reversed) sailed through unrechecked at every
// send seam. Shared by that fast path AND any seam that never reaches it at
// all because dollar-bearing bodies are refused earlier in that seam's own
// pipeline (sms-auto-send's own hasPriceQuote refusal, (3.7)) — a status
// claim carries no dollar figure and so clears that guard too, yet still
// needs this same recheck before it actually sends.
async function amountFreeStatusClaimStale({
  customerId, body, strict, trustOwedAmounts = false, dbh = db, inboundMessage = null,
} = {}) {
  if (!strict) return { stale: false };
  const text = String(body || '');
  // Codex round-6 (PR #5331): a body naming no payment/paid/account word
  // cannot assert a payment status — skip the drafter + billing re-read
  // entirely (gratitude/scheduling copy on the auto-send lane).
  if (!mayAssertPaymentStatus(text)) return { stale: false };
  const hasStatusClaim = text.split(CLAUSE_SPLIT_RE)
    .some((clause) => drafter.hasAffirmativePaymentAck(clause) || drafter.paymentStatusClaimKind(clause) != null);
  if (!hasStatusClaim) return { stale: false };
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    const ctx = (customerRow && await require('./context-aggregator').getContextForCustomer(customerRow)) || {};
    const stale = drafter.replyQuotesUngroundedAmount(text, ctx, { byMeaning: true, trustOwedAmounts, inboundMessage });
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount-free status-claim recheck failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

// `trustOwedAmounts` (independent-review P1, round 4, finding 3): the
// scheduler's own "a human already reviewed this exact figure" trust (owner
// ruling 2026-07-30) — passed straight through to the drafter's clause-aware
// binder, which excuses only an OWED clause (a price/balance the operator
// approved), never a RECEIPT/status claim or a Zelle offer, both of which
// assert a fact that can go stale between review and fire regardless of who
// wrote the words.
async function outgoingAmountsStale({
  customerId, body, promptVersion = null, zelleInvoiceId = null, dbh = db, trustOwedAmounts = false,
  // Independent-review P1 (round 6, PR #5331): the customer's own inbound
  // wording (decision.inbound_message / the sms_log row's body), threaded
  // through to the clause-aware binder so a confirmation binds to the
  // tender/date the customer actually named, not only what the outgoing
  // body happens to restate.
  inboundMessage = null,
} = {}) {
  const text = String(body || '');
  // Independent-review P1 (finding 4): checked unconditionally, ahead of
  // the amount rules below and regardless of prompt version — a Zelle
  // contact is real payment instructions whether or not the body also
  // carries a dollar figure, and this same function is the one place every
  // send-time seam (the immediate Agent Review send via
  // agent-decision-send-checks.js, and the scheduler's queued-send fire-time
  // recheck, human-edited or not — independent-review P1, round 4, finding 3)
  // shares.
  const zelle = outgoingZelleStale(text);
  if (zelle.stale) return zelle;
  // Pre-push audit P1 (finding 2), widened round 3 (finding 1): checked
  // right alongside the recipient check above, for any AFFIRMATIVE Zelle
  // OFFER — contact or not (a HISTORICAL RECEIPT clause never reaches here;
  // classifyZelleClause/hasAffirmativeZelleMention route it to the amount
  // binder below instead). A body with no affirmative Zelle offer at all has
  // nothing to recheck.
  if (hasAffirmativeZelleMention(text)) {
    // Independent-review P1 (round 4, finding 3): a caller with no drafted
    // Zelle fact to re-check against (a human-authored scheduled edit with no
    // agent-decision snapshot, or any other caller that never resolved one)
    // passes no zelleInvoiceId — resolve the customer's CURRENT open invoice
    // through the SAME canonical aggregator every other Zelle/amount fact
    // reads, rather than re-deriving "open" here. Fails CLOSED (via
    // zelleInvoiceStillEligible's own "no id ⇒ zelle_invoice_unresolved"
    // rule) when there is none, or the lookup itself errors.
    let effectiveZelleInvoiceId = zelleInvoiceId;
    if (!effectiveZelleInvoiceId && customerId) {
      try {
        const customerRow = await dbh('customers').where({ id: customerId }).first();
        const ctx = (customerRow && await require('./context-aggregator').getContextForCustomer(customerRow)) || {};
        effectiveZelleInvoiceId = ctx?.billing?.openInvoice?.id || null;
      } catch (err) {
        logger.warn(`[sms-amount-recheck] open-invoice lookup for Zelle recheck failed for customer ${customerId}: ${err.message}; blocking send`);
        return { stale: true, reason: 'zelle_recheck_failed' };
      }
    }
    const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId: effectiveZelleInvoiceId, dbh });
    if (!eligibility.eligible) return { stale: true, reason: eligibility.reason };
  }
  const strict = strictForVersion(promptVersion);
  const amounts = bodyAmountCents(text);
  if (!amounts.length) {
    // Price grammar the numeric extractor cannot verify ("fifty dollars",
    // "45/mo") is unverifiable, not amount-free (audit P1): with real
    // answers on it fails closed, mirroring the drafter's draft-time rule.
    // NOT exempted by trustOwedAmounts — unlike the clause-aware binder
    // below, this whole-body check cannot tell an owed figure from a receipt
    // one, so it stays conservative for every caller.
    const unverifiable = strict && require('./sms-suggest-mode').hasPriceQuote(text);
    if (unverifiable) return { stale: true, reason: 'amount_unverifiable' };
    // Independent-review P1 (round 5, finding 1): a payment-status or receipt
    // claim with no dollar figure at all ("You're paid up.") still needs
    // fresh billing before it sends — see amountFreeStatusClaimStale above.
    return amountFreeStatusClaimStale({ customerId, body: text, strict, trustOwedAmounts, dbh, inboundMessage });
  }
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  // trustOwedAmounts on the POOLED (pre-v12) rule has nothing left to check —
  // it excuses the whole amount figure, not just its owed half (see the
  // comment above the pooled branch) — so this skips the customer/billing
  // read entirely, matching the scheduler's original human-authored
  // exemption byte-for-byte (no DB read at all).
  if (trustOwedAmounts && !strict) return { stale: false };
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
    // The pooled rule (pre-v12 prompts) has no per-clause owed/receipt
    // split to excuse only the owed half — trustOwedAmounts here matches
    // the ORIGINAL scope of the 2026-07-30 exemption exactly (skip the
    // whole amount check for a human-reviewed legacy reply), same as before
    // this finding widened the STRICT rule's own, finer-grained trust.
    const stale = strict
      ? drafter.replyQuotesUngroundedAmount(text, ctx, { byMeaning: true, trustOwedAmounts, inboundMessage })
      : !trustOwedAmounts && amounts.some((a) => !owed.has(a) && !(ack && paid.has(a)));
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

module.exports = {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible,
  hasAffirmativeZelleMention, classifyZelleClause, amountFreeStatusClaimStale,
};
