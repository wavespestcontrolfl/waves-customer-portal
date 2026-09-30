'use strict';
// ONE shared vocabulary for "this clause reports that a payment already
// happened" (a historical receipt/status claim), used by TWO independent
// callers that must never quietly drift apart:
//   - sms-shadow-drafter.js's PAYMENT_ACK_RE / hasAffirmativePaymentAck (the
//     generic draft-time receipt guard feeding replyQuotesUngroundedAmount)
//   - sms-amount-recheck.js's classifyZelleClause (tells a Zelle RECEIPT
//     clause — "we received your $120 Zelle payment" — apart from a live
//     Zelle OFFER/instruction that still needs the recipient/eligibility
//     recheck)
//
// A standalone module, deliberately NOT re-exported from sms-shadow-drafter
// itself: several test files mock that module down to a bare stub
// (jest.mock('../services/sms-shadow-drafter', () => ({ ... }))), and a
// shared vocabulary riding through it would silently vanish under those
// mocks with no test failure to catch it. This module has no dependency on
// either caller.
//
// P2 (round 6, PR #5331): the receipt-verb list gains "came through",
// "cleared", "posted" and "arrived" (previously only present in
// sms-amount-recheck's own copy, never in the drafter's PAYMENT_ACK_RE), and
// a "thank(s|you) for … payment" construction is recognized everywhere this
// vocabulary is used — a customer- or agent-authored "Thanks for processing
// my Zelle payment!"/"Thank you, the payment cleared" is historical receipt
// wording exactly like "we received your payment" is, whichever side typed
// it and whichever of the two callers above is asking.
const RECEIPT_VERBS = ['received', 'processed', 'went through', 'got', 'came through', 'cleared', 'posted', 'arrived', 'applied'];

// Escapes the one thing that varies between entries — internal whitespace in
// a two-word verb ("went through") — into a `\s+` gap so the pattern still
// matches across a line-wrapped or double-spaced body.
const receiptVerbPattern = RECEIPT_VERBS.map((v) => v.replace(/\s+/g, '\\s+')).join('|');

// Bare verb test with no "payment" anchor — for a caller that has already
// established payment/Zelle context some other way (classifyZelleClause only
// reaches this after confirming the clause affirmatively mentions Zelle) and
// needs just the completion-verb half of the vocabulary.
const RECEIPT_VERB_RE = new RegExp(`\\b(?:${receiptVerbPattern})\\b`, 'i');

// The "thank(s|you) for … payment" courtesy construction, "payment"-anchored
// so a bare "Thanks!" with no payment word nearby never counts as a receipt
// claim on its own.
const THANKS_FOR_PAYMENT_RE = /\bthank(?:s|\s+you)\b[^.\n]{0,25}\bpayment\b/i;

// The full "payment acknowledgement" pattern SOURCE (a string, not a
// compiled RegExp — sms-shadow-drafter.js's PAYMENT_ACK_RE also needs the
// "all set"/"all paid"/"paid in full" status phrases folded into the SAME
// pattern, which are not part of this shared vocabulary): verb-then-payment,
// payment-then-verb (verbs OR the status phrases), status-then-payment, and
// the thank-you construction — the same four-branch shape PAYMENT_ACK_RE has
// always had, now built from the one shared verb list instead of a second,
// independently-maintained copy.
function paymentAckPatternSource() {
  return [
    `\\b(?:${receiptVerbPattern})\\b[^.\\n]{0,30}\\bpayment\\b`,
    `\\bpayment\\b[^.\\n]{0,30}\\b(?:${receiptVerbPattern}|all set|all paid|paid in full)\\b`,
    `\\b(?:all set|all paid|paid in full)\\b[^.\\n]{0,30}\\bpayment\\b`,
    THANKS_FOR_PAYMENT_RE.source,
  ].join('|');
}

// ONE table of every payment-STATUS phrase a reply may use, and the Recent
// payments row status(es) that phrase requires (Codex round-7 P1, PR #5331).
// The drafter's system prompt is BUILT from this table (paymentStatusPromptLine)
// and the classifier that validates a drafted/queued reply is BUILT from the
// same table (pendingClaimRe / failedClaimRe / the paid list feeding
// paymentAckPatternSource) — so the prompt can never permit a status phrase the
// guard does not know: adding a phrase here adds it to both.
//   paid      -> a row marked paid                     (received/applied/cleared/…)
//   pending   -> a row marked pending/processing       ("still processing", …)
//   failed    -> a row marked failed/declined/…        ("didn't go through", …)
//   refunded / disputed -> a row marked exactly that   ("was refunded" / "is disputed", "charged back"); generic
//   reversed  -> either                                ("was reversed")
//                (settled THEN reversed — never a "failed" payment; Codex round-8 P1)
//   not_received -> NO PAID row exists ("haven't received", "hasn't come through", …)
//   not_found -> NO paid/pending row exists for the named payment
//                ("isn't showing", "haven't received", …). Its rowStatuses are the
//                statuses that CONTRADICT the claim: the claim is valid only when no
//                matching row of those statuses exists NOW (Codex round-8 P1).
const PAYMENT_STATUS_VOCABULARY = Object.freeze({
  paid: Object.freeze({
    rowStatuses: Object.freeze(['paid']),
    phrases: Object.freeze([...RECEIPT_VERBS, 'all set', 'all paid', 'paid in full']),
  }),
  pending: Object.freeze({
    rowStatuses: Object.freeze(['pending', 'processing', 'requires_action']),
    phrases: Object.freeze(['still processing', 'is processing', 'currently processing', 'being processed', 'in process', 'pending', 'processing']),
  }),
  failed: Object.freeze({
    rowStatuses: Object.freeze(['failed', 'declined', 'canceled', 'cancelled', 'void', 'voided']),
    phrases: Object.freeze(['failed', 'declined', "didn't go through", 'did not go through', 'was returned', 'bounced', 'unsuccessful']),
  }),
  // Codex round-9 P1: a refund and a dispute are DIFFERENT reversals — each
  // phrase binds only to its own row status; only the generic "was reversed"
  // may bind to either.
  refunded: Object.freeze({
    rowStatuses: Object.freeze(['refunded']),
    phrases: Object.freeze(['was refunded', 'has been refunded', 'is refunded', 'refunded']),
  }),
  disputed: Object.freeze({
    rowStatuses: Object.freeze(['disputed']),
    phrases: Object.freeze(['was disputed', 'is disputed', 'disputed', 'charged back']),
  }),
  reversed: Object.freeze({
    rowStatuses: Object.freeze(['refunded', 'disputed']),
    phrases: Object.freeze(['was reversed']),
  }),
  not_found: Object.freeze({
    rowStatuses: Object.freeze(['paid', 'pending', 'processing', 'requires_action']),
    phrases: Object.freeze([
      "isn't showing", 'is not showing', "aren't showing", 'not showing', "don't see", 'do not see', 'no record',
      "isn't reflected", 'not on file',
    ]),
  }),
  // "Not received yet" is TRUE for a still-processing row (the prompt itself
  // says a processing line means "not received yet"), so only a PAID row
  // contradicts it.
  not_received: Object.freeze({
    rowStatuses: Object.freeze(['paid']),
    phrases: Object.freeze([
      "haven't received", 'have not received', "hasn't been received", 'has not been received',
      "hasn't come through", "hasn't posted", "hasn't cleared",
    ]),
  }),
});
const phrasePattern = (list) => list.map((v) => v.replace(/\s+/g, '\\s+').replace(/'/g, "['\u2019]")).join('|');
// A status claim is only a PAYMENT claim when the clause also names a payment
// noun (or an amount, or the customer's own message is about a payment, both
// handled by the caller) — "your invoice is pending" or "we're processing your
// request" are not.
const PAYMENT_NOUN_RE = /\b(?:payments?|transfers?|deposits?|charges?|zelle|ach|paid|refund(?:ed|s)?|disputed?|chargeback)\b/i;
const familyRe = (family) => new RegExp(`\\b(?:${phrasePattern(PAYMENT_STATUS_VOCABULARY[family].phrases)})\\b`, 'i');
const STATUS_PHRASE_RES = Object.freeze([
  ['not_found', familyRe('not_found')],
  ['not_received', familyRe('not_received')],
  ['refunded', familyRe('refunded')],
  ['disputed', familyRe('disputed')],
  ['reversed', familyRe('reversed')],
  ['failed', familyRe('failed')],
  ['pending', familyRe('pending')],
]);
// The customer's own message is about a payment (used to relax the noun
// requirement for a bare "it isn't showing on our end yet" reply).
const INBOUND_PAYMENT_RE = /\b(?:pay(?:ment|ments|ing)?|paid|sent|send|transfer(?:red)?|deposit(?:ed)?|zelle[d']*|venmo|paypal|check|ach)\b/i;
const inboundNamesPayment = (text) => INBOUND_PAYMENT_RE.test(String(text || ''));
// null | 'not_found' | 'reversed' | 'failed' | 'pending' for a clause that
// asserts a payment's status. `namesPayment` = the caller already knows the
// clause is about a payment (it carries an amount, or the inbound is about one).
function paymentStatusPhraseClaim(clause, namesPayment = false) {
  const text = String(clause || '');
  if (/\?/.test(text)) return null;
  if (!namesPayment && !PAYMENT_NOUN_RE.test(text)) return null;
  for (const [family, re] of STATUS_PHRASE_RES) if (re.test(text)) return family;
  return null;
}
// The prompt sentence derived from the table above.
function paymentStatusPromptLine() {
  const q = (list) => list.map((p) => `"${p}"`).join(', ');
  const V = PAYMENT_STATUS_VOCABULARY;
  return `Payment-status wording and the Recent payments status each requires: say a payment was ${q(V.paid.phrases)} ONLY for a line marked ${V.paid.rowStatuses.join('/')}; say it is ${q(V.pending.phrases)} ONLY for a line marked ${V.pending.rowStatuses.join(' or ')}; say it ${q(V.failed.phrases)} ONLY for a line marked ${V.failed.rowStatuses.slice(0, 3).join(', ')}; say it ${q(V.refunded.phrases)} ONLY for a line marked ${V.refunded.rowStatuses.join('/')}, ${q(V.disputed.phrases)} ONLY for a line marked ${V.disputed.rowStatuses.join('/')}, and ${q(V.reversed.phrases)} for either (a refunded or disputed payment WAS received and then reversed — never say it failed, and never say it is still paid); say ${q(V.not_found.phrases)} ONLY when NO line marked ${V.not_found.rowStatuses.join('/')} matches the payment the customer asked about; say ${q(V.not_received.phrases)} ONLY when NO line marked ${V.not_received.rowStatuses.join('/')} matches it (a processing line is not received yet). Any other wording about a payment's status is not allowed.`;
}

// Cheap, drafter-free PRE-SCREEN for "could this body assert a payment
// status/receipt fact at all?" (Codex round-6, PR #5331 — CI regression on
// the gratitude auto-send lane). Every claim the drafter's
// hasAffirmativePaymentAck / paymentStatusClaimKind can flag names at least
// one of "payment(s)", "paid", or "account" ("you're paid up", "paid in
// full", "all paid", "your account is current", "your payment cleared",
// "we received your payment"). A body naming none of them — a gratitude
// "You're welcome!", a scheduling confirmation — can never be a status claim,
// so amountFreeStatusClaimStale (sms-amount-recheck.js) returns clean for it
// WITHOUT touching the drafter or the database: no billing re-read for
// copy that asserts nothing about billing, and no dependence on the
// drafter's export shape (several callers mock that module down to a stub).
// MUST stay a strict SUPERSET of those two drafter predicates — if either
// gains a status phrase that avoids all three words, add its anchor here
// (payment-receipt-vocabulary.test.js pins the current claim examples).
// Built FROM the full table (every phrase of every family) plus the base
// payment words, so it is a guaranteed superset of paymentStatusPhraseClaim —
// a phrase added to the table is automatically screened in (Codex round-9 P1).
const PAYMENT_STATUS_PRESCREEN_RE = new RegExp(
  `\\b(?:payments?|paid|account|transfers?|deposits?|charges?|zelle|ach|refund(?:ed|s)?|disputed?|chargeback|${
    phrasePattern(Object.values(PAYMENT_STATUS_VOCABULARY).flatMap((f) => [...f.phrases]))
  })\\b`,
  'i',
);
function mayAssertPaymentStatus(text) {
  return PAYMENT_STATUS_PRESCREEN_RE.test(String(text || ''));
}

module.exports = {
  PAYMENT_STATUS_VOCABULARY,
  inboundNamesPayment,
  paymentStatusPhraseClaim,
  paymentStatusPromptLine,
  mayAssertPaymentStatus,
  RECEIPT_VERBS,
  RECEIPT_VERB_RE,
  THANKS_FOR_PAYMENT_RE,
  paymentAckPatternSource,
};
