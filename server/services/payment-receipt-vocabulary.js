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
// Codex round-13 P1: LITERAL paid-status forms ("shows as paid", "This invoice is
// paid", "it's been paid", "marked paid") — a claim that a payment/invoice IS
// paid, whatever its subject noun. They join the paid family (prompt, prescreen
// and the ack pattern all read this list) so they bind to a current paid row.
const PAID_STATUS_PHRASES = ['is paid', 'are paid', 'was paid', 'has been paid', "it's been paid", 'been paid', 'shows as paid', 'showing as paid', 'marked paid', 'marked as paid'];
const paidStatusPattern = PAID_STATUS_PHRASES.map((v) => v.replace(/\s+/g, '\\s+').replace(/'/g, "['\u2019]")).join('|');

const receiptVerbPattern = RECEIPT_VERBS.map((v) => v.replace(/\s+/g, '\\s+')).join('|');

// Bare verb test with no "payment" anchor — for a caller that has already
// established payment/Zelle context some other way (classifyZelleClause only
// reaches this after confirming the clause affirmatively mentions Zelle) and
// needs just the completion-verb half of the vocabulary.
const RECEIPT_VERB_RE = new RegExp(`\\b(?:${receiptVerbPattern})\\b`, 'i');

// The "thank(s|you) for … payment" courtesy construction, "payment"-anchored
// so a bare "Thanks!" with no payment word nearby never counts as a receipt
// claim on its own.
// Codex round-12 P1: the SUBJECT of a paid-status claim is any payment noun, not
// literally "payment" — "your Zelle transfer cleared", "your charge posted",
// "your check cleared". PAYMENT_SUBJECT (receipt/ack verbs) stays to nouns that
// unambiguously name a payment so "we've got Zelle" (an OFFER) is never a
// receipt; PAYMENT_EVENT_SUBJECT additionally takes "your/the Zelle|ACH|check"
// because its verbs (cleared/posted/went through/complete) are unambiguous.
// Codex round-28 P1: the CARD / supported TENDER subjects ("Your card was declined", "Your Apple Pay failed") — ONE
// shared alternation used by the status classifier (PAYMENT_NOUN_RE), the customer-message test
// (INBOUND_PAYMENT_RE), the unrecognized-assertion fallback and the prescreen, so the lists cannot drift.
const TENDER_SUBJECT_ALT = '(?:cards?|apple\\s+pay|google\\s+pay|samsung\\s+pay|zelle|ach|venmo|paypal|bank\\s+account)';
// Codex round-40 P1: "funds" / "money" are unambiguous payment subjects ("The funds arrived", "Your money cleared").
// ONE noun alternation — every list below (subjects, status nouns, prescreen, inbound context, anaphor subjects)
// is built from it, so a noun can never be a payment subject in one classifier and invisible in another.
const PAYMENT_NOUN_ALT = 'payments?|transfers?|deposits?|charges?|funds|money';
const PAYMENT_SUBJECT = `(?:${PAYMENT_NOUN_ALT}|(?:your|the|our)\\s+check)`;
const PAYMENT_EVENT_SUBJECT = `(?:${PAYMENT_NOUN_ALT}|(?:your|the|our)\\s+(?:zelle|ach|check))`;
const THANKS_FOR_PAYMENT_RE = new RegExp(`\\bthank(?:s|\\s+you)\\b[^.\\n]{0,25}\\b${PAYMENT_SUBJECT}\\b`, 'i');

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
    `\\b(?:${receiptVerbPattern})\\b[^.\\n]{0,30}\\b${PAYMENT_SUBJECT}\\b`,
    `\\b${PAYMENT_SUBJECT}\\b[^.\\n]{0,30}\\b(?:${receiptVerbPattern}|all set|all paid|paid in full)\\b`,
    `\\b(?:all set|all paid|paid in full)\\b[^.\\n]{0,30}\\b${PAYMENT_SUBJECT}\\b`,
    THANKS_FOR_PAYMENT_RE.source,
    `\\b(?:${paidStatusPattern})\\b`,
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
//   not_received -> NO paid/refunded/disputed row exists ("haven't received", "hasn't come through", …)
//   not_found -> NO paid/pending row exists for the named payment
//                ("isn't showing", "haven't received", …). Its rowStatuses are the
//                statuses that CONTRADICT the claim: the claim is valid only when no
//                matching row of those statuses exists NOW (Codex round-8 P1).
// Codex round-16 P1: ONE list of the completed-payment EVENT verbs ("your payment cleared / posted /
// went through / was successful / is complete"). The drafter's positive event grammar
// (PAYMENT_EVENT_STATUS_RE) and the NEGATED denials ("did not clear", "wasn't successful") are BOTH
// derived from it, so a stem can never be recognized as a claim but missing from the denial side.
//   pattern  regex source for the positive verb form (used in PAYMENT_EVENT_STATUS_RE)
//   base/past  the verb, for "did not <base>" / "has not <past>"; adjective  for "was not <adjective>"
const EVENT_STATUS_STEMS = Object.freeze([
  Object.freeze({ pattern: 'clear(?:ed|s)?', base: 'clear', past: 'cleared' }),
  Object.freeze({ pattern: 'post(?:ed|s)?', base: 'post', past: 'posted' }),
  // "didn't / did not go through" is already the FAILED family's own phrase (needs a failed row), so its base forms are not repeated here.
  Object.freeze({ pattern: 'went\\s+through', base: 'go through', past: 'gone through', denialIsFailure: true }),
  Object.freeze({ pattern: "(?:was|is|'s)\\s+successful", adjective: 'successful' }),
  Object.freeze({ pattern: "(?:was|is|'s)\\s+complete", adjective: 'complete', base: 'complete', past: 'completed' }),
  // "processed" is a pending-family phrase: its negations ("wasn't processed") already classify as a
  // negated status claim and fail closed, so the stem needs no denial phrases of its own.
  Object.freeze({ pattern: "(?:was|is|'s)\\s+processed" }),
]);
const EVENT_STATUS_VERB_PATTERN = EVENT_STATUS_STEMS.map((st) => st.pattern).join('|');
const NEGATED_EVENT_PHRASES = Object.freeze([...new Set(EVENT_STATUS_STEMS.flatMap((st) => {
  const out = [];
  if (st.base && !st.denialIsFailure) out.push(`did not ${st.base}`, `didn't ${st.base}`, `does not ${st.base}`, `doesn't ${st.base}`);
  if (st.past) out.push(`has not ${st.past}`, `hasn't ${st.past}`, `have not ${st.past}`, `haven't ${st.past}`, `never ${st.past}`, `not ${st.past}`, `was not ${st.past}`, `wasn't ${st.past}`, `is not ${st.past}`, `isn't ${st.past}`);
  if (st.adjective) out.push(`was not ${st.adjective}`, `wasn't ${st.adjective}`, `is not ${st.adjective}`, `isn't ${st.adjective}`, `not ${st.adjective}`);
  return out;
}))]);

const ANY_STATUS = '*';
const PAYMENT_STATUS_VOCABULARY = Object.freeze({
  paid: Object.freeze({
    rowStatuses: Object.freeze(['paid']),
    phrases: Object.freeze([...RECEIPT_VERBS, 'all set', 'all paid', 'paid in full', ...PAID_STATUS_PHRASES]),
  }),
  pending: Object.freeze({
    rowStatuses: Object.freeze(['pending', 'processing', 'requires_action']),
    phrases: Object.freeze(['still processing', 'is processing', 'currently processing', 'being processed', 'in process', 'pending', 'processing']),
  }),
  failed: Object.freeze({
    rowStatuses: Object.freeze(['failed', 'declined', 'canceled', 'cancelled', 'void', 'voided']),
    phrases: Object.freeze([
      'failed', 'declined', "didn't go through", 'did not go through', 'was returned', 'bounced', 'unsuccessful',
      // Codex round-29 P1: the common "card didn't work" family — a failure assertion whatever the subject
      "didn't work", 'did not work', "wasn't accepted", 'was not accepted', 'got rejected', 'was rejected', 'were rejected', 'got declined',
    ]),
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
  // '*' = a row of ANY status contradicts it: "isn't showing" is false when the
  // payment is on file as failed/refunded/canceled/… too — the reply must
  // report that real status instead (Codex round-9 P1).
  not_found: Object.freeze({
    rowStatuses: Object.freeze([ANY_STATUS]),
    phrases: Object.freeze([
      "isn't showing", 'is not showing', "aren't showing", 'not showing', "don't see", 'do not see', 'no record',
      "isn't reflected", 'not on file',
      // Codex round-15 P1: "we don't have your payment" / "...a payment on file" deny the payment's existence.
      "don't have your payment", 'do not have your payment', "don't have the payment", 'do not have the payment',
      "don't have any payment", 'do not have any payment', "don't have a payment on file", 'do not have a payment on file',
    ]),
  }),
  // "Unpaid" forms: contradicted by a PAID row (Codex round-13 P1). Predicate forms
  // only — "an unpaid balance of $95" is owed language, not this claim.
  unpaid: Object.freeze({
    rowStatuses: Object.freeze(['paid']),
    phrases: Object.freeze([
      'is unpaid', 'are unpaid', 'was unpaid', 'shows as unpaid', 'showing as unpaid', 'marked unpaid', 'marked as unpaid', 'still unpaid',
      "hasn't been paid", 'has not been paid', "isn't paid", 'is not paid', "isn't marked paid", "isn't marked as paid",
    ]),
  }),
  // "Not received yet" is TRUE for a still-processing row (the prompt itself
  // says a processing line means "not received yet"), so only a PAID row
  // contradicts it.
  not_received: Object.freeze({
    // Received-then-reversed rows (refunded/disputed) WERE received, so they
    // contradict "haven't received" too; pending/processing do not (Codex round-11).
    rowStatuses: Object.freeze(['paid', 'refunded', 'disputed']),
    phrases: Object.freeze([
      "haven't received", 'have not received', "hasn't been received", 'has not been received',
      "wasn't received", 'was not received', 'not received',
      "hasn't come through", 'has not come through', 'no payment has come through', "hasn't posted", "hasn't cleared",
      // Codex round-15 P1: the verb-first denials ("we didn't get your payment") — they deny RECEIPT,
      // so a paid row contradicts them exactly like "haven't received".
      "didn't get", 'did not get', "didn't receive", 'did not receive', "haven't gotten", 'have not gotten',
      "haven't got", 'have not got', "haven't seen", 'have not seen', 'never received', 'never got',
      // Codex round-22 P1: "we have yet to receive your payment" — the common "yet to <verb>" denials
      ...['receive', 'see', 'get', 'be received', 'come through', 'post', 'clear', 'show'].flatMap((v) => [`have yet to ${v}`, `has yet to ${v}`, `yet to ${v}`]),
      // Codex round-16 P1: negated event-status verbs, generated from the SAME stem list that builds the
      // positive event grammar ("did not clear", "wasn't successful", "hasn't posted", ...).
      ...NEGATED_EVENT_PHRASES,
    ]),
  }),
});
const phrasePattern = (list) => list.map((v) => v.replace(/\s+/g, '\\s+').replace(/'/g, "['\u2019]")).join('|');
// A status claim is only a PAYMENT claim when the clause also names a payment
// noun (or an amount, or the customer's own message is about a payment, both
// handled by the caller) — "your invoice is pending" or "we're processing your
// request" are not.
const PAYMENT_NOUN_RE = new RegExp(`\\b(?:${PAYMENT_NOUN_ALT}|${TENDER_SUBJECT_ALT}|paid|unpaid|refund(?:ed|s)?|disputed?|chargeback|(?:your|the|our|a)\\s+check)\\b`, 'i');
const familyRe = (family) => new RegExp(`\\b(?:${phrasePattern(PAYMENT_STATUS_VOCABULARY[family].phrases)})\\b`, 'i');
// Codex round-20 P1: subject-aware REFUND completion ("Your refund was processed / posted / went through /
// was issued / completed"). Derived from the SAME event-status stems as the payment event grammar
// (EVENT_STATUS_VERB_PATTERN) plus the refund-specific "issued / processed / completed / sent" passive
// forms, so it cannot drift. A negator inside the span ("hasn't posted") is a DENIAL the not_received
// family already owns, so the span may not contain one. Binds like the refunded family: a current refunded
// row (or a partially refunded paid row when the amount is the refunded amount / the wording is partial).
const REFUND_COMPLETION_VERB_PATTERN = `${EVENT_STATUS_VERB_PATTERN}|(?:(?:was|has\\s+been|is|'s)\\s+)?(?:processed|issued|completed|posted|cleared|sent)`;
const REFUND_COMPLETION_RE = new RegExp(
  `\\brefunds?\\b(?:(?!not\\b|n['\u2019]t\\b|never\\b)[^.\\n]){0,25}\\b(?:${REFUND_COMPLETION_VERB_PATTERN})\\b`,
  'i',
);
// Codex round-20 P1: a clause whose status subject is the INVOICE / BILL (no payment noun of its own).
// The invoice / bill must be the GRAMMATICAL SUBJECT of a status word — "Your invoice is / was / has ... /
// failed" ("Your $120 invoice is ...", "invoice WPC-2026-0101 is ...") — so "we're processing your invoice
// request" and "invoice processing takes two days" assert nothing.
const INVOICE_SUBJECT_RE = /\b(?:invoices?|bills?)\b(?:\s+[#\w-]+){0,2}?\s+(?:is|was|has|have|are|were|got|still|isn['\u2019]t|wasn['\u2019]t|hasn['\u2019]t|failed|declined)\b|\b(?:invoices?|bills?)['\u2019]s\s+(?:been\s+)?(?:paid|failed)\b/i;
const PAYMENT_OBJECT_RE = new RegExp(`\\b(?:${PAYMENT_NOUN_ALT}|checks?|refunds?|zelle|ach)\\b`, 'i');
// Codex round-34 P1 (structural): a tender word introduced by a TENDER PREPOSITION ("via ACH", "by check", "with your card",
// "through Zelle", "using your bank account", "paid by Zelle") names HOW, never a payment SUBJECT. It is stripped before the
// subject test and judged as a tender claim bound to the invoice's own rows (sms-shadow-drafter invoiceTenderUngrounded) —
// uniformly for every tender word (card, cash, check, ACH, Zelle, wallets, bank).
const TENDER_AFTER_PREPOSITION_RE = new RegExp(
  `\\b(?:via|by|with|through|thru|using|on|from)\\s+(?:(?:your|the|our|my|a|an)\\s+)?(?:(?:bank|debit|credit|wire)\\s+)?(?:${TENDER_SUBJECT_ALT}|checks?|cash|ach|zelle|bank(?:\\s+transfer)?)\\b`,
  'gi',
);
const withoutTenderPhrases = (text) => String(text || '').replace(TENDER_AFTER_PREPOSITION_RE, ' ');
const invoiceSubjectClause = (text) => INVOICE_SUBJECT_RE.test(String(text || '')) && !PAYMENT_OBJECT_RE.test(withoutTenderPhrases(text));
const STATUS_PHRASE_RES = Object.freeze([
  ['refunded', REFUND_COMPLETION_RE],
  ['not_found', familyRe('not_found')],
  ['not_received', familyRe('not_received')],
  ['unpaid', familyRe('unpaid')],
  ['refunded', familyRe('refunded')],
  ['disputed', familyRe('disputed')],
  ['reversed', familyRe('reversed')],
  ['failed', familyRe('failed')],
  ['pending', familyRe('pending')],
]);
// Does the text contain a phrase of an ABSENCE family (isn't showing, haven't
// received, …)? Used to load authoritative history only when a claim needs it.
const ABSENCE_PHRASE_RE = new RegExp(`\\b(?:${phrasePattern([...PAYMENT_STATUS_VOCABULARY.not_found.phrases, ...PAYMENT_STATUS_VOCABULARY.not_received.phrases, ...PAYMENT_STATUS_VOCABULARY.unpaid.phrases])})\\b`, 'i');
const containsAbsencePhrase = (text) => ABSENCE_PHRASE_RE.test(String(text || ''));
// The customer's own message is about a payment (used to relax the noun
// requirement for a bare "it isn't showing on our end yet" reply).
const INBOUND_PAYMENT_RE = new RegExp(`\\b(?:pay(?:ment|ments|ing)?|paid|sent|send|transfer(?:red)?|deposit(?:ed)?|charges?|charged|funds|money|zelle[d']*|check|${TENDER_SUBJECT_ALT})\\b`, 'i');
const inboundNamesPayment = (text) => INBOUND_PAYMENT_RE.test(String(text || ''));
// null | 'not_found' | 'reversed' | 'failed' | 'pending' for a clause that
// asserts a payment's status. `namesPayment` = the caller already knows the
// clause is about a payment (it carries an amount, or the inbound is about one).
// Codex round-9 P1: polarity. A POSITIVE-family phrase ("pending", "refunded",
// "failed", "disputed", …) preceded by a negator — "is not pending", "wasn't
// refunded", "didn't fail" — is a negated PRESENCE claim the family binder
// cannot judge, so it classifies as 'negated' and every guard rejects it
// (fail closed, draft + send). The families' OWN negative phrases ("didn't go
// through", "haven't received", "isn't showing") are members of their family
// and are matched first, so they keep their positive meaning.
const NEGATOR_BEFORE_RE = /(?:\b(?:not|never|no\s+longer|cannot)|n['\u2019]t)\b(?:\s+\w+){0,3}\s*$/i;
const NEGATED_STEM_RE = /(?:\b(?:not|never|no\s+longer|cannot)|n['\u2019]t)\b(?:\s+\w+){0,3}\s+(?:fail|declin|refund|disput|bounc|revers|return|process|pend|reject|accept|work|charg(?=ed\s*back))(?:e|ed|d|ing|es|s)?\b/i;
const POSITIVE_FAMILIES = new Set(['pending', 'failed', 'refunded', 'disputed', 'reversed']);
// Codex round-12 P1: question suppression is scoped to the status phrase ITSELF
// — it is a question only when the first sentence terminator at/after it is a
// '?' (interrogative order: "is your payment still processing?"). A statement
// followed by a question ("still processing — does that answer it?") is NOT
// suppressed. Dashes/em-dashes terminate a span like . ! ; do.
function insideQuestion(text, index) {
  const m = /[.!?;\u2014\u2013\n]/.exec(String(text || '').slice(index));
  return !!m && m[0] === '?';
}
// Codex round-14/17 P1: EVERY status phrase a clause asserts, with its position — the
// enumerator (sms-shadow-drafter.js enumeratePaymentClaims) validates each one independently.
// { negated, matches: [{ family, start, end }] }. `negated` = a positive-family phrase under a
// negator (or a negated stem) — fail closed, the binder cannot judge it.
// Is the RECOGNIZED status phrase at `index` inside a hypothetical / interrogative sub-clause — a question, a sub-clause
// that opens with a conditional, or one with "if / whether / in case…" BEFORE the phrase? (Sub-clause scoped, so a
// "please try another card" elsewhere does not matter, and an assertion like "Please note your payment failed" is kept.)
function recognizedMatchIsHypothetical(text, index) {
  const range = subclauseRanges(text).find((r) => index >= r.start && index <= r.end);
  if (!range) return false;
  const sub = range.text;
  return MODAL_NON_ASSERTIVE_RE.test(sub) || HYPOTHETICAL_BEFORE_RE.test(sub.slice(0, Math.max(0, index - range.start)));
}
// Affirmative (not a question / conditional): used to gate what a clause may DISCLOSE.
const isModalNonAssertive = (text) => MODAL_NON_ASSERTIVE_RE.test(String(text || ''));

function paymentStatusPhraseMatches(clause, namesPayment = false) {
  const text = String(clause || '');
  if (!namesPayment && !PAYMENT_NOUN_RE.test(text) && !invoiceSubjectClause(text)) return { negated: false, matches: [] };
  const matches = [];
  let negated = false;
  for (const [family, re] of STATUS_PHRASE_RES) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(global)) {
      if (insideQuestion(text, m.index)) continue;
      if (recognizedMatchIsHypothetical(text, m.index)) continue; // "If your payment failed, …" asserts nothing
      if (POSITIVE_FAMILIES.has(family) && NEGATOR_BEFORE_RE.test(text.slice(0, m.index))) { negated = true; continue; }
      matches.push({ family, start: m.index, end: m.index + m[0].length });
    }
  }
  if (negated) return { negated: true, matches };
  if (matches.length) return { negated: false, matches };
  // "didn't fail", "wasn't declined", "not refunded" forms whose positive stem
  // is not itself a table phrase: still a negated status claim.
  const stem = NEGATED_STEM_RE.exec(text);
  if (stem && !insideQuestion(text, stem.index) && !recognizedMatchIsHypothetical(text, stem.index)) return { negated: true, matches };
  return { negated: false, matches };
}
// [] = no status claim; ['negated'] = any negated positive-family claim in the clause;
// otherwise the distinct families in table order.
function paymentStatusPhraseFamilies(clause, namesPayment = false) {
  const { negated, matches } = paymentStatusPhraseMatches(clause, namesPayment);
  if (negated) return ['negated'];
  return [...new Set(matches.map((m) => m.family))];
}
// The FIRST asserted family (null | 'negated' | family) — the single-claim view kept for
// callers that only need "does this clause assert a status at all".
function paymentStatusPhraseClaim(clause, namesPayment = false) {
  return paymentStatusPhraseFamilies(clause, namesPayment)[0] || null;
}
// Codex round-12 P1: ONE table of SETTLEMENT phrases ("nothing is owed" claims),
// feeding the drafter's settlement classifier AND the prescreen so a phrase can
// never be classified but not screened. Each is grounded only when nothing is
// outstanding or in flight (billingHasOutstandingObligation).
const SETTLEMENT_PHRASES = Object.freeze([
  "you're paid up", 'you are paid up', 'paid in full', 'all paid',
  'your account is current', 'your account is up to date', 'your account is up-to-date',
  "you're all caught up", 'you are all caught up', 'all caught up',
  "you don't owe anything", "you don't owe us anything", 'you do not owe anything', 'you do not owe us anything', 'you owe nothing', "you don't owe a thing",
  'there is no balance', "there's no balance", 'no balance due', 'no balance owed', 'no balance remaining', 'no outstanding balance', 'no balance on your account',
  'nothing is due', "nothing's due", 'nothing is owed', "nothing's owed", 'nothing is owing', 'nothing due', 'nothing owed', 'nothing outstanding',
  'zero balance',
]);
const SETTLEMENT_PHRASE_RE = new RegExp(`\\b(?:${phrasePattern(SETTLEMENT_PHRASES)})\\b`, 'i');
// "$0 balance" / "balance is $0" / "owe $0" — checked on the RAW text (masking a
// figure loses its value). Codex round-16 P1: the WHOLE amount must be zero — "$0.99",
// "$0.50" and "$0.01" are real balances whose "$0" prefix must not read as zero, so the
// zero figure may not be followed by more digits ([.,]\d). "$0", "$0.00", "0.00", "zero".
const ZERO_AMT = '(?:\\$\\s?0(?:\\.0{1,2})?|\\b0\\.0{1,2}|\\bzero)(?![.,]?\\d)';
const ZERO_DOLLARS = '\\$\\s?0(?:\\.0{1,2})?(?![.,]?\\d)';
const ZERO_BALANCE_RE = new RegExp(
  `${ZERO_AMT}\\s+(?:balance|due|owed|owing)\\b|\\bbalance\\s+(?:is|of)\\s+${ZERO_AMT}|\\bowe\\s+(?:us\\s+)?${ZERO_DOLLARS}`,
  'i',
);
// ONE detector for a zero-balance claim, shared by the draft validator AND the send-time
// recheck (a question — "is your balance zero?" — asserts nothing). zeroBalanceSpan returns the
// matched span so a caller can validate the claim as ONE claim among others (Codex round-17 P1).
function zeroBalanceSpan(text) {
  const raw = String(text || '');
  const m = ZERO_BALANCE_RE.exec(raw);
  return m && !insideQuestion(raw, m.index) ? { index: m.index, length: m[0].length } : null;
}
function zeroBalanceClaim(text) {
  return !!zeroBalanceSpan(text);
}
// The text with ONLY the zero-balance span blanked out — everything else in the clause (a receipt
// claim, another figure, price grammar) still goes through the normal binders.
function withoutZeroBalanceSpan(text) {
  const raw = String(text || '');
  const span = zeroBalanceSpan(raw);
  return span ? `${raw.slice(0, span.index)} ${raw.slice(span.index + span.length)}` : raw;
}

// The prompt sentence derived from the table above.
function paymentStatusPromptLine() {
  const q = (list) => list.map((p) => `"${p}"`).join(', ');
  const V = PAYMENT_STATUS_VOCABULARY;
  return `Payment-status wording and the Recent payments status each requires: say a payment was ${q(V.paid.phrases)} ONLY for a line marked ${V.paid.rowStatuses.join('/')}; say it is ${q(V.pending.phrases)} ONLY for a line marked ${V.pending.rowStatuses.join(' or ')}; say it ${q(V.failed.phrases)} ONLY for a line marked ${V.failed.rowStatuses.slice(0, 3).join(', ')}; say it ${q(V.refunded.phrases)} ONLY for a line marked ${V.refunded.rowStatuses.join('/')}, ${q(V.disputed.phrases)} ONLY for a line marked ${V.disputed.rowStatuses.join('/')}, and ${q(V.reversed.phrases)} for either (a refunded or disputed payment WAS received and then reversed — never say it failed, and never say it is still paid); say ${q(V.not_found.phrases)} ONLY when NO line of ANY status (paid, pending, failed, refunded, …) matches the payment the customer asked about — if a matching line exists, report its real status instead; say ${q(V.unpaid.phrases)} ONLY when NO line marked ${V.unpaid.rowStatuses.join('/')} matches it; say ${q(V.not_received.phrases)} ONLY when NO line marked ${V.not_received.rowStatuses.join('/')} matches it (a processing line is not received yet). Any other wording about a payment's status is not allowed.`;
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
  `\\b(?:${PAYMENT_NOUN_ALT}|paid|unpaid|invoices?|bills?|account|${TENDER_SUBJECT_ALT}|zelle|ach|refund(?:ed|s)?|disputed?|chargeback|${
    phrasePattern([...Object.values(PAYMENT_STATUS_VOCABULARY).flatMap((f) => [...f.phrases]), ...SETTLEMENT_PHRASES])
  })\\b`,
  'i',
);
// Codex round-22 P1: the claim enumerator can never list every phrasing, so a clause that the payment
// prescreen flags but for which the enumerator finds NO claim is treated as an UNRECOGNIZED payment assertion
// (fail closed) — unless it is clearly NON-assertive: a question, a conditional, an offer/instruction ("you
// can pay…", "please…"), or a plain reference to the payment options / pay link / payment method.
// ONE set of non-assertive patterns, three groups: MODAL (a question, a conditional opening the sub-clause), OFFER (an
// offer / request / future action) and REFERENCE (how to pay, payment options / method / link). The unrecognized-assertion
// fallback exempts on ANY group; RECOGNIZED status phrases are exempt only when hypothetical (see recognizedMatchIsHypothetical) —
// "If your payment failed, please try another card" does not assert a failure (Codex round-32 P2).
const MODAL_NON_ASSERTIVE = [
  '\\?', // a question
  '^\\s*(?:if|once|when|whenever|unless|in\\s+case|should\\s+you|as\\s+soon\\s+as|after\\s+you|before\\s+you)\\b', // conditional (opens the sub-clause)
];
// Codex round-38 P1: a polite / modal word is a discourse marker unless it GOVERNS a requested or offered action. "Please note your
// payment settled" / "You can rest assured your payment settled" assert a payment fact; "please call", "you can pay online" do not.
// So the marker exempts a sub-clause only when an ACTION verb follows it directly (optionally after an adverb / "to"); anything else
// ("note", "rest", "be sure", "see that", ...) stays an assertion and goes through the claim binders.
const OFFER_ACTION_VERBS = 'pay|repay|settle|use|try|text|call|reply|respond|email|send|resend|share|forward|let|contact|reach|visit|click|tap|log|sign|check|review|view|open|update|add|enter|re-?enter|give|provide|confirm|verify|find|come|stop|ask|request|make|set|schedule|reschedule|retry|submit|choose|select|switch|change|download|print|save|keep|bring|mail|drop|cancel|message|get|go|head|take|remit|hold|wait|bear|zelle|venmo|wire|transfer|put|mail|dm';
const OFFER_MARKER = '(?:you\\s+(?:can|could|may|might)|will\\s+be\\s+able\\s+to|(?:can|could|would|will)\\s+you|please|feel\\s+free(?:\\s+to)?)';
const OFFER_LEAD = "(?:(?:also|still|just|always|simply|kindly|now|then|first|please|do\\s+not\\s+hesitate\\s+to|don['\u2019]t\\s+hesitate\\s+to|be\\s+sure\\s+to|make\\s+sure\\s+to|remember\\s+to|go\\s+ahead\\s+and|to)\\s+)*";
const OFFER_NON_ASSERTIVE = [
  `\\b${OFFER_MARKER}\\s+${OFFER_LEAD}(?:${OFFER_ACTION_VERBS})\\b`, // offer / request that governs an action
  '\\b(?:let\\s+me|reply\\s+with|just\\s+(?:reply|text)|go\\s+ahead)\\b', // offer / request
  "\\b(?:we|i)(?:'ll|\\s+will|'d|\\s+can|\\s+could)\\s+(?:send|text|email|share|resend|forward|get|help|check|look|find|make|set|go|take|give|walk|confirm|follow|let|reach|call|update|see)\\b", // future action
];
const REFERENCE_NON_ASSERTIVE = [
  '\\b(?:we\\s+(?:accept|take|offer|support)|to\\s+pay|ways?\\s+to\\s+pay|how\\s+to\\s+pay|pay(?:ing)?\\s+(?:link|online|by|with|via|through|using))\\b', // how-to-pay
  '\\b(?:pay|payment)\\s+(?:link|method|methods|options?|page|portal|plan|info(?:rmation)?|details|instructions?|reminder|schedule|date|due)\\b',
  '\\bpersonal\\s+pay\\b',
  '\\bautopay\\b',
];
const NON_ASSERTIVE_PAYMENT_RE = new RegExp([...MODAL_NON_ASSERTIVE, ...OFFER_NON_ASSERTIVE, ...REFERENCE_NON_ASSERTIVE].join('|'), 'i');
const MODAL_NON_ASSERTIVE_RE = new RegExp(MODAL_NON_ASSERTIVE.join('|'), 'i');
// words that make what FOLLOWS them hypothetical inside a sub-clause ("…whether your payment failed", "I'll check if it posted")
const HYPOTHETICAL_BEFORE_RE = /\b(?:if|whether|in\s+case|unless|suppose|assuming)\b/i;
const isNonAssertivePaymentClause = (text) => NON_ASSERTIVE_PAYMENT_RE.test(String(text || ''));
// The words that make a clause a payment-STATUS assertion when NO claim was recognized: a payment noun,
// paid / unpaid, a settlement phrase or a zero balance. (Narrower than mayAssertPaymentStatus on purpose:
// a bare "processing" / "pending" with no payment noun ("we're processing your request"), or "Zelle" /
// "account" alone (offers and availability are rechecked by their own seams), are not status assertions.)
const PAYMENT_STATUS_NOUN_RE = new RegExp(`\\b(?:${PAYMENT_NOUN_ALT}|paid|unpaid|refund(?:ed|s)?|disputed?|chargeback)\\b`, 'i');
// Codex round-25 P1: an INVOICE / BILL is a payment-status subject too ("Your invoice is settled", "The bill
// finalized") — the same noun family as the invoice-status tagger (invoiceSubjectClause). "bill" only as a
// noun ("the/your/a bill"), never the verb ("we bill monthly"). Benign delivery predicates ("your invoice is
// attached / ready / below") assert nothing about payment.
const INVOICE_NOUN_RE = /\binvoices?\b|\b(?:the|your|a|this|that|our|my)\s+(?:\w+\s+)?bills?\b/i;
const BENIGN_INVOICE_PREDICATE_RE = /\b(?:attached|enclosed|ready|below|above|included|linked|available|sent|emailed|texted|coming|on\s+its\s+way|in\s+your\s+(?:email|inbox|portal)|for\s+your\s+records)\b/i;
// One sub-clause: does it hold a payment / invoice status noun (or a settlement phrase / zero balance)?
// A card / tender as the grammatical SUBJECT of a predicate ("Your card got sorted out", "Your Apple Pay went
// fine") — not the saved-method facts ("your card on file is a Visa ending 4242").
const TENDER_SUBJECT_STATUS_RE = new RegExp(`\\b(?:your|the|our|my)\\s+(?:\\w+\\s+){0,2}?${TENDER_SUBJECT_ALT}\\b(?:\\s+[\\w']+){0,3}?\\s+(?:is|was|has|have|are|were|got|went|didn['\u2019]t|wasn['\u2019]t|hasn['\u2019]t|failed|declined)\\b`, 'i');
const BENIGN_TENDER_PREDICATE_RE = /\b(?:on\s+file|ending|expires?|expiring|expired|last\s+four|brand|saved|updated|added|removed|visa|mastercard|amex|discover|autopay|default|primary|active)\b/i;
// The "on file / ending / expires" exemption is for clauses that ONLY describe the stored method. Any status
// predicate ("Your card on file didn't work", "…was declined / bounced / rejected / went through") is an assertion
// again (Codex round-29 P1).
const TENDER_STATUS_PREDICATE_RE = /\b(?:didn['\u2019]t\s+work|did\s+not\s+work|failed|declined|bounced|rejected|wasn['\u2019]t\s+accepted|was\s+not\s+accepted|didn['\u2019]t\s+go\s+through|did\s+not\s+go\s+through|went\s+through|was\s+charged|got\s+charged|isn['\u2019]t\s+working|is\s+not\s+working|stopped\s+working|maxed|over\s+the\s+limit)\b/i;
function paymentStatusHit(sub) {
  return PAYMENT_STATUS_NOUN_RE.test(sub) || SETTLEMENT_PHRASE_RE.test(sub) || ZERO_BALANCE_RE.test(sub)
    || (INVOICE_NOUN_RE.test(sub) && !BENIGN_INVOICE_PREDICATE_RE.test(sub))
    || (TENDER_SUBJECT_STATUS_RE.test(sub) && !(BENIGN_TENDER_PREDICATE_RE.test(sub) && !TENDER_STATUS_PREDICATE_RE.test(sub)));
}
// Codex round-25 P1: the non-assertive exemption is judged on the payment phrase's OWN sub-clause — split on
// so / because / while / however / and / but / punctuation — so "Your payment settled so please call if you
// need anything" is an assertion (the "please…" belongs to the other sub-clause). Only a clause that is ENTIRELY a
// question ("Did your payment settle, or is it pending?") is exempt as a whole.
const SUBCLAUSE_SPLIT_RE = /(\s+(?:so(?:\s+that)?|because|since|though|although|while|whereas|however|then|which|and|but)\s+|[,;\u2014\u2013]\s*|\s-\s|(?<=[.!?])\s+)/i;
const PURPOSE_CONNECTOR_RE = /^\s*so(?:\s+that)?\s*$/i;
const INTERROGATIVE_START_RE = /^\s*(?:did|do|does|is|are|was|were|has|have|had|can|could|will|would|should|may|what|when|why|how|where|which|who)\b/i;
// A clause whose subject is a bare pronoun ("It settled.", "That cleared out.", "They're sorted.") — payment-scoped only
// when the surrounding environment is about a payment (Codex round-30 P1).
const PRONOUN_SUBJECT_CLAUSE_RE = /^\s*(?:and\s+|but\s+|so\s+|well,?\s+|yes,?\s+)?(?:it|that|they|this(?:\s+one)?|the\s+(?:payment|charge|transfer|deposit|funds|money))(?:['\u2019](?:s|re|ll|d))?\s+\w+/i;
function unrecognizedPaymentAssertion(text, { paymentContext = false } = {}) {
  const t = String(text || '');
  if (/\?\s*$/.test(t) && INTERROGATIVE_START_RE.test(t)) return false; // the whole clause is a question
  // pieces alternate: sub-clause, connector, sub-clause, ...
  const pieces = t.split(SUBCLAUSE_SPLIT_RE);
  let prevExempt = false;
  let connector = '';
  for (let i = 0; i < pieces.length; i += 1) {
    if (i % 2 === 1) { connector = pieces[i]; continue; }
    const sub = pieces[i];
    if (!sub || !sub.trim()) continue;
    // a "so (that) …" PURPOSE clause after an instruction/offer ("Please use your pay link so your payment goes
    // through") is part of the instruction, not a status assertion
    const exempt = isNonAssertivePaymentClause(sub) || (prevExempt && PURPOSE_CONNECTOR_RE.test(connector));
    if (paymentStatusHit(sub) && !exempt) return true;
    if (paymentContext && !exempt && PRONOUN_SUBJECT_CLAUSE_RE.test(sub)) return true; // "It settled." about a payment
    prevExempt = exempt;
  }
  return false;
}
function mayAssertPaymentStatus(text) {
  return PAYMENT_STATUS_PRESCREEN_RE.test(String(text || '')) || ZERO_BALANCE_RE.test(String(text || ''));
}

// Sub-clause ranges of a clause ({ start, end, text }), using the SAME splitter as the unrecognized-assertion rule, so a
// caller can classify each status phrase by the sub-clause it sits in (Codex round-29 P1).
function subclauseRanges(text) {
  const t = String(text || '');
  const pieces = t.split(SUBCLAUSE_SPLIT_RE);
  const ranges = [];
  let pos = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i] || '';
    if (i % 2 === 0) ranges.push({ start: pos, end: pos + piece.length, text: piece });
    pos += piece.length;
  }
  return ranges;
}
// Is the sub-clause holding character `index` an INVOICE / BILL status clause?
function invoiceSubjectAt(text, index) {
  const range = subclauseRanges(text).find((r) => index >= r.start && index <= r.end);
  return !!range && invoiceSubjectClause(range.text);
}

// Codex round-35 P2: is the status phrase at `index` said of a REFUND ("Your $30 refund is pending", "The refund
// failed", "Your refund was issued")? The refund NOUN (never the verb "refunded") sits in the same sub-clause at or
// before the phrase. Such a claim is about the refund's own state (payments.refund_status / refund_amount), never the
// payment attempt's status.
const REFUND_NOUN_RE = /\brefunds?\b/i;
function refundSubjectAt(text, index) {
  const range = subclauseRanges(text).find((r) => index >= r.start && index <= r.end);
  if (!range) return false;
  const m = REFUND_NOUN_RE.exec(range.text);
  return !!m && range.start + m.index <= index;
}

// Does any sub-clause open with a bare pronoun / "the payment" subject? (A cheap prescreen signal for the recheck gates:
// such a clause is payment-scoped only when the surrounding environment is about a payment — Codex round-30 P1.)
const hasPronounSubjectClause = (text) => String(text || '').split(SUBCLAUSE_SPLIT_RE).some((sub, i) => i % 2 === 0 && PRONOUN_SUBJECT_CLAUSE_RE.test(sub));

module.exports = {
  refundSubjectAt,
  isModalNonAssertive,
  recognizedMatchIsHypothetical,
  hasPronounSubjectClause,
  subclauseRanges,
  invoiceSubjectAt,
  unrecognizedPaymentAssertion,
  isNonAssertivePaymentClause,
  REFUND_COMPLETION_RE,
  invoiceSubjectClause,
  EVENT_STATUS_STEMS,
  EVENT_STATUS_VERB_PATTERN,
  NEGATED_EVENT_PHRASES,
  PAID_STATUS_PHRASES,
  SETTLEMENT_PHRASES,
  SETTLEMENT_PHRASE_RE,
  ZERO_BALANCE_RE,
  zeroBalanceClaim,
  zeroBalanceSpan,
  withoutZeroBalanceSpan,
  PAYMENT_SUBJECT,
  PAYMENT_EVENT_SUBJECT,
  insideQuestion,
  containsAbsencePhrase,
  PAYMENT_STATUS_VOCABULARY,
  ANY_STATUS,
  inboundNamesPayment,
  paymentStatusPhraseFamilies,
  paymentStatusPhraseMatches,
  paymentStatusPhraseClaim,
  paymentStatusPromptLine,
  mayAssertPaymentStatus,
  RECEIPT_VERBS,
  RECEIPT_VERB_RE,
  THANKS_FOR_PAYMENT_RE,
  paymentAckPatternSource,
};
