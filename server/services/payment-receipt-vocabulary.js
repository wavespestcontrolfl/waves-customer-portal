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
const RECEIPT_VERBS = ['received', 'processed', 'went through', 'got', 'came through', 'cleared', 'posted', 'arrived'];

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
const PAYMENT_STATUS_PRESCREEN_RE = /\b(?:payments?|paid|account)\b/i;
function mayAssertPaymentStatus(text) {
  return PAYMENT_STATUS_PRESCREEN_RE.test(String(text || ''));
}

module.exports = {
  mayAssertPaymentStatus,
  RECEIPT_VERBS,
  RECEIPT_VERB_RE,
  THANKS_FOR_PAYMENT_RE,
  paymentAckPatternSource,
};
