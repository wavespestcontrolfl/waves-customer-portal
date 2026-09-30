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
const { ensureAbsenceHistory, surfaceReferencedPayments } = require('./payment-history');

// The amount forms and the payment-acknowledgement grammar are the
// draft-time guard's own (one definition for both amount guards): every
// amount syntax hasPriceQuote recognizes, and payment-history amounts only
// on a body that reads as an ack, so a stale "your balance is $X" can never
// re-authorize via the payment row.
const { AMOUNT_MASK_RE: AMOUNT_FORMS_RE } = drafter;

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
// Codex round-6 pre-push audit P1 (PR #5331): negation is scoped to the Zelle
// OFFER itself — a negator DIRECTLY governing Zelle ("we don't take/accept
// Zelle", "can't use Zelle", "no longer accept payments by Zelle") or Zelle as
// the subject of a negated/unavailable predicate ("Zelle isn't available").
// The old rule suppressed every Zelle check when ANY negation appeared
// anywhere in the clause, so "You don't need a card to use Zelle to
// old@example.com." (an affirmative instruction) skipped the recipient and
// invoice-eligibility rechecks at every send seam. classifyZelleClause also
// never lets negation suppress a clause carrying a transfer contact.
const ZELLE_NEGATOR = "(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|can'?t|cannot|can not|won'?t|will not|couldn'?t|could not|wouldn'?t|would not|no longer|not currently|not able to|not able|unable to|unable|stopped)";
const ZELLE_NEGATION_RE = new RegExp(
  `\\b${ZELLE_NEGATOR}\\s+(?:(?:be\\s+able\\s+to|able\\s+to|currently|right\\s+now|really|anymore)\\s+)*`
  + '(?:(?:take|taking|accept|accepting|offer|offering|support|supporting|use|using|do|have|allow|process|processing)\\s+)?'
  + '(?:(?:any|payments?|transfers?|us|our|the|a)\\s+)*(?:(?:via|by|through|with|using)\\s+)?zelle\\b'
  + "|\\bzelle\\b\\s+(?:(?:payments?|transfers?)\\s+)?(?:isn'?t|is\\s+not|aren'?t|are\\s+not|is\\s+unavailable|is\\s+no\\s+longer|not\\s+available|unavailable|not\\s+currently|no\\s+longer|not\\s+right\\s+now|not\\s+accepted|not\\s+supported|won'?t\\s+work|doesn'?t\\s+work)\\b"
  // Codex round-30 P2: SUBJECT-FIRST modal denials — "Zelle cannot be used", "Zelle won't be available", "Zelle could not be offered"
  + "|\\bzelle\\b\\s+(?:(?:payments?|transfers?)\\s+)?(?:can'?t|cannot|can\\s+not|couldn'?t|could\\s+not|won'?t|will\\s+not|wouldn'?t|would\\s+not|shouldn'?t|should\\s+not|may\\s+not|might\\s+not)\\s+(?:be\\s+)?(?:used|offered|accepted|available|supported|taken|processed|possible|an?\\s+option)\\b",
  'i',
);
// Same clause-boundary split as the drafter's own CLAUSE_SPLIT_RE (not
// exported — kept as a parallel literal since both only ever need to agree
// on how a reply is split into clauses, never on a shared regex object). The
// day/year comma guard mirrors the drafter's own fix (independent-review P2,
// round 4): "September 12, 2026" must stay one clause so a Zelle RECEIPT
// clause's stated date keeps its year (see classifyZelleClause below).
const CLAUSE_SPLIT_RE = /(?<=[;!?\n])|(?<=\.)(?=\s|$)|,\s(?!\d{4}\b(?!\d))|\s(?:and|but)\s|\s?[—–]\s?|\s-\s/;

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
const {
  RECEIPT_VERB_RE, THANKS_FOR_PAYMENT_RE, mayAssertPaymentStatus, paymentStatusPhraseClaim, inboundNamesPayment, zeroBalanceClaim, unrecognizedPaymentAssertion, hasPronounSubjectClause,
} = require('./payment-receipt-vocabulary');
const ZELLE_INSTRUCTION_MARKER_RE = /\b(?:use|send|pay|can|please)\b/i;
// null (no affirmative Zelle mention in this clause), else 'offer' | 'receipt'.
function classifyZelleClause(clause) {
  const text = String(clause || '');
  if (!ZELLE_WORD_RE.test(text)) return null;
  // A clause carrying ANY transfer contact is a live instruction — always
  // checked, negation or not (Codex round-6 pre-push audit P1).
  if (zelleBodyContacts(text).length) return 'offer';
  if (ZELLE_NEGATION_RE.test(text)) return null;
  if (ZELLE_OFFER_RE.test(text)) return 'offer';
  // Codex round-7 P1 (PR #5331): receipt wording must identify an actual PAST
  // PAYMENT — a receipt verb PLUS a payment noun / an amount / "your" / a date.
  // A bare verb ("Yes, we've got Zelle", "we have Zelle") is an OFFER and gets
  // the recipient + invoice recheck.
  const namesPastPayment = /\b(?:payments?|transfers?|deposits?|your)\b/i.test(text)
    || bodyAmountCents(text).length > 0
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/i.test(text);
  // Codex round-8 P1 (PR #5331): a payment-STATUS report about a past payment
  // ("Your Zelle payment is still processing", "...failed") with no instruction
  // and no contact is a status claim, not a new transfer offer — it routes to
  // the status grounding in replyQuotesUngroundedAmount (bindPaymentRow), never
  // the recipient/invoice-eligibility recheck. A contact was handled above
  // (always an offer); an instruction marker keeps it an offer.
  // Codex round-21 P1: ANY payment claim the drafter's shared enumerator recognizes (receipt, paid-family
  // wording like "is paid" / "shows as paid", every status family) is historical — one definition with the
  // draft validator. (A caller that mocks the drafter to a stub keeps the phrase check alone.)
  const recognizedClaim = typeof drafter.enumeratePaymentClaims === 'function'
    && drafter.enumeratePaymentClaims(text, {}).claims.length > 0;
  if (namesPastPayment && !ZELLE_INSTRUCTION_MARKER_RE.test(text)
      && (recognizedClaim || paymentStatusPhraseClaim(text, bodyAmountCents(text).length > 0))) return 'receipt';
  // A clause naming a specific contact (email/phone) is ALWAYS live payment
  // instructions, whatever verb it does or doesn't carry (finding 2):
  // "For your Zelle payment, use old@example.com" names no offer VERB, but
  // a contact address is never something a historical receipt states.
  if (zelleBodyContacts(text).length) return 'offer';
  // Codex round-7 P1 (PR #5331): receipt wording must identify an actual PAST
  // PAYMENT — a receipt verb PLUS a payment noun / an amount / "your" / a date.
  // A bare verb ("Yes, we've got Zelle", "we have Zelle") is an OFFER and gets
  // the recipient + invoice recheck.
  if (((RECEIPT_VERB_RE.test(text) && namesPastPayment) || THANKS_FOR_PAYMENT_RE.test(text)) && !ZELLE_INSTRUCTION_MARKER_RE.test(text)) return 'receipt';
  // Ambiguous — mentions Zelle affirmatively but matches neither pattern —
  // fails closed as an OFFER (the stricter path).
  return 'offer';
}
// Codex round-16 P1: Zelle context carries across clauses. A reply that affirms Zelle in one
// clause (an offer, or a receipt) and then gives the TRANSFER INSTRUCTION in another that never
// says "Zelle" ("We got your Zelle payment. Use pay@example.com for the rest.") used to skip the
// recheck: the contact-bearing clause has no Zelle word of its own. Fail closed — any transfer
// instruction (a contact, or a send/pay/use ... to/via/through <destination>) in a reply that
// mentions Zelle non-negatedly anywhere runs the Zelle recipient + visibility recheck.
const TRANSFER_INSTRUCTION_RE = /\b(?:send|transfer|pay|use)\b[^.\n]{0,30}\b(?:to|via|through)\b/i;
const NON_ZELLE_DESTINATION_RE = /\b(?:link|portal|online|website|app|card|invoice\s+page)\b/i;
function isTransferInstructionClause(clause) {
  const text = String(clause || '');
  if (zelleBodyContacts(`zelle ${text}`).length) return true;
  return TRANSFER_INSTRUCTION_RE.test(text) && !NON_ZELLE_DESTINATION_RE.test(text);
}
// Codex round-18 P2: a NEGATIVE availability claim ("Zelle isn't available right now", "we don't take
// Zelle") is excluded from hasAffirmativeZelleMention on purpose, but it is a live claim too: the recipient
// is an env setting and the invoice's eligibility moves, so the denial can go stale before it sends.
function hasNegativeZelleAvailabilityClaim(body) {
  return String(body || '').split(CLAUSE_SPLIT_RE)
    .some((clause) => ZELLE_WORD_RE.test(clause) && !zelleBodyContacts(clause).length && ZELLE_NEGATION_RE.test(clause));
}
function hasAffirmativeZelleMention(body) {
  const clauses = String(body || '').split(CLAUSE_SPLIT_RE);
  if (clauses.some((clause) => classifyZelleClause(clause) === 'offer')) return true;
  const zelleAffirmed = clauses.some((clause) => ZELLE_WORD_RE.test(clause) && !ZELLE_NEGATION_RE.test(clause));
  return zelleAffirmed && clauses.some((clause) => !ZELLE_WORD_RE.test(clause) && isTransferInstructionClause(clause));
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

// Codex round-14 P2: keep the SPECIFIC reason the shared visibility check gave, so the
// scheduler's reviewer-facing note (AMOUNT_BLOCK_NOTES) says what actually changed
// (a third-party payer took the invoice / the payer or credit state could not be
// verified) instead of one generic "no longer eligible". Reasons with no reviewer
// mapping of their own stay the generic ineligible; a probe that could not complete
// is the recheck-failed reason.
const PASSTHROUGH_ZELLE_REASONS = new Set(['payer_owned', 'payer_unverifiable', 'credit_unverifiable']);
function zelleRecheckReason(visibilityReason) {
  if (PASSTHROUGH_ZELLE_REASONS.has(visibilityReason)) return visibilityReason;
  if (visibilityReason === 'eligibility_unverifiable') return 'zelle_recheck_failed';
  return 'zelle_invoice_ineligible';
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
    // READ-ONLY (Codex round-26 P1): send-time / draft-time rechecks never write to the charge-claim state.
    const visibility = await payPageZelleVisibility({ invoice: invoiceRow, dbh, readOnly: true });
    return visibility.visible ? { eligible: true } : { eligible: false, reason: zelleRecheckReason(visibility.reason) };
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
  // A customer message ABOUT a payment makes a bare pronoun clause ("It settled.") payment-scoped, so the
  // prescreen alone can't clear it (Codex round-30 P1) — the per-clause decision below is the precise one.
  if (!mayAssertPaymentStatus(text) && !inboundNamesPayment(inboundMessage)) return { stale: false };
  // ONE decision with the draft validator (Codex round-18/24 P1): a clause needs the billing recheck exactly
  // when clauseUngrounded would judge it — the enumerator finds a claim, OR it is an UNRECOGNIZED payment
  // assertion (fail closed: "Your payment settled." is never fresh just because no phrase knows it).
  // (A caller that mocks the drafter down to a stub falls back to the individual predicates + the same
  // vocabulary-level unrecognized-assertion rule.)
  const inboundText = String(inboundMessage || '');
  const hasStatusClaim = text.split(CLAUSE_SPLIT_RE).some((clause) => (
    typeof drafter.paymentClauseNeedsValidation === 'function'
      ? drafter.paymentClauseNeedsValidation(clause, { inboundText })
      : (drafter.hasAffirmativePaymentAck(clause) || drafter.paymentStatusClaimKind(clause) != null
        || paymentStatusPhraseClaim(clause, inboundNamesPayment(inboundMessage)) != null
        || zeroBalanceClaim(clause) || unrecognizedPaymentAssertion(clause))));
  if (!hasStatusClaim) return { stale: false };
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    // Codex round-6 pre-push audit P1 (PR #5331): no customer row (or no
    // loadable context) is NOT an empty account — never substitute {} and let
    // a settlement claim read the emptiness as "nothing owed". Fail closed.
    const ctx = customerRow ? await require('./context-aggregator').getContextForCustomer(customerRow) : null;
    if (!ctx) return { stale: true, reason: 'amount_recheck_no_customer' };
    // the payment the customer asked about may be older than the display window (Codex round-19 P2) — the SAME
    // surfacing the draft did, from the same inbound, so a valid reply about it is judged against that row
    await surfaceReferencedPayments(ctx, inboundMessage, dbh);
    await ensureAbsenceHistory(ctx, text, dbh);
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
// Cheap, read-free pre-screen for the SCHEDULER's fire-time seam (Codex round-11
// P1): does this body carry anything outgoingAmountsStale could judge — a dollar
// figure / price grammar, an affirmative Zelle offer, or a payment-status claim?
// A body with none (a human reply about scheduling, thanks, etc.) needs no
// agent_decisions / customer / billing reads at all.
function bodyNeedsPaymentRecheck(body) {
  const text = String(body || '');
  if (!text) return false;
  if (bodyAmountCents(text).length) return true;
  if (hasAffirmativeZelleMention(text) || hasNegativeZelleAvailabilityClaim(text)) return true;
  if (mayAssertPaymentStatus(text)) return true;
  // a bare pronoun clause ("It settled.") may be payment-scoped by the customer's message — let the caller read it
  if (hasPronounSubjectClause(text)) return true;
  try { return !!require('./sms-suggest-mode').hasPriceQuote(text); } catch { return true; }
}

/**
 * Is a Zelle DENIAL still true? { stale: false } when Zelle still is not offered to this customer (no
 * recipient configured, no open invoice, or the invoice fails the pay page's Zelle visibility); stale
 * ('zelle_now_available') when it would be offered now. An unverifiable check fails CLOSED.
 */
const ZELLE_DENIAL_UNVERIFIABLE = new Set(['zelle_recheck_failed', 'payer_unverifiable', 'credit_unverifiable']);
async function zelleDenialStale({ customerId, dbh = db, inboundMessage = null, body = null } = {}) {
  const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');
  if (!manualPayOptionsFromEnv()?.zelle?.recipient) return { stale: false };
  if (!customerId) return { stale: true, reason: 'zelle_recheck_failed' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    const ctx = customerRow ? await require('./context-aggregator').getContextForCustomer(customerRow) : null;
    if (!ctx) return { stale: true, reason: 'zelle_recheck_failed' };
    // several open invoices: the SAME resolver as the draft (Codex round-19 P1); an unresolvable reference
    // abstained at draft time, so the denial stands
    // the denial's own invoice reference wins; the customer's message only when the body names none (round 30)
    const { resolveZelleTargetInvoice: resolveTarget, explicitInvoiceReference: bodyNames } = require('./zelle-target-invoice');
    const target = resolveTarget(ctx?.billing, body && bodyNames(body) ? body : inboundMessage);
    const invoiceId = target.invoiceId;
    if (!invoiceId) {
      // Codex round-25 P1: no open invoice at all => nothing to pay by Zelle, the denial stands. An UNRESOLVED
      // target (several open invoices, none identified) is UNVERIFIABLE — the draft asks which invoice instead of
      // denying — so a denial is blocked.
      return target.reason === 'no_open_invoice' ? { stale: false } : { stale: true, reason: 'zelle_target_ambiguous' };
    }
    const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId: invoiceId, dbh });
    if (eligibility.eligible) return { stale: true, reason: 'zelle_now_available' };
    // an UNVERIFIABLE state (lookup failed, payer or credit state unknown) is not a confirmed "ineligible" —
    // the denial can't be confirmed, so block (Codex round-21 P2); only confirmed reasons let it stand
    return ZELLE_DENIAL_UNVERIFIABLE.has(eligibility.reason) ? { stale: true, reason: eligibility.reason } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] Zelle denial recheck failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'zelle_recheck_failed' };
  }
}

// Codex round-29 P2: the PRECISE classifier — does this body actually make a payment claim the recheck would judge
// (an amount, a Zelle offer or denial, a recognized claim / unrecognized payment assertion in any clause, or price
// grammar)? Unlike bodyNeedsPaymentRecheck (the broad prescreen that decides whether a billing READ is worth doing)
// it does not fire on "Your invoice is attached" or "We updated your account details". A stubbed drafter falls back to
// the broad prescreen per clause (fail closed).
function bodyMakesPaymentClaim(body) {
  const text = String(body || '');
  if (!text) return false;
  if (bodyAmountCents(text).length) return true;
  if (hasAffirmativeZelleMention(text) || hasNegativeZelleAvailabilityClaim(text)) return true;
  const needs = typeof drafter.paymentClauseNeedsValidation === 'function'
    ? (clause) => drafter.paymentClauseNeedsValidation(clause, {})
    : (clause) => mayAssertPaymentStatus(clause);
  if (text.split(CLAUSE_SPLIT_RE).some(needs)) return true;
  try { return !!require('./sms-suggest-mode').hasPriceQuote(text); } catch { return true; }
}

async function outgoingAmountsStale({
  customerId, body, promptVersion = null, zelleInvoiceId = null, dbh = db, trustOwedAmounts = false,
  // Independent-review P1 (round 6, PR #5331): the customer's own inbound
  // wording (decision.inbound_message / the sms_log row's body), threaded
  // through to the clause-aware binder so a confirmation binds to the
  // tender/date the customer actually named, not only what the outgoing
  // body happens to restate.
  inboundMessage = null,
  // Codex round-30 P1: run the clause-aware status / receipt check regardless of prompt version (a scheduled send of
  // ANY draft — a pre-v12 "Your payment failed" too). trustOwedAmounts still excuses only genuinely OWED figures.
  strictStatusClaims = false,
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
    // Codex round-29 P1: the snapshot invoice is the one the DRAFT was written for. A reviewer EDIT that names a
    // different invoice (number, or an amount tied to an invoice) re-targets the offer — resolve what the edited body
    // names with the same resolver and check THAT invoice afresh; if it can't be resolved (not open, ambiguous) the
    // offer is unverifiable and blocks.
    const { resolveZelleTargetInvoice, explicitInvoiceReference } = require('./zelle-target-invoice');
    const editedNamesInvoice = explicitInvoiceReference(text);
    if (customerId && (!effectiveZelleInvoiceId || editedNamesInvoice)) {
      try {
        const customerRow = await dbh('customers').where({ id: customerId }).first();
        const ctx = (customerRow && await require('./context-aggregator').getContextForCustomer(customerRow)) || {};
        if (!effectiveZelleInvoiceId) {
          // Codex round-30 P1: the OUTGOING body's explicit invoice reference wins (unresolvable => unresolved => blocked);
          // the customer's message decides only when the body names none. Several open: else abstain.
          effectiveZelleInvoiceId = resolveZelleTargetInvoice(ctx?.billing, editedNamesInvoice ? text : inboundMessage).invoiceId;
        } else {
          const edited = resolveZelleTargetInvoice(ctx?.billing, text).invoiceId;
          if (edited !== effectiveZelleInvoiceId) effectiveZelleInvoiceId = edited; // re-targeted (null => unresolved => blocked below)
        }
      } catch (err) {
        logger.warn(`[sms-amount-recheck] open-invoice lookup for Zelle recheck failed for customer ${customerId}: ${err.message}; blocking send`);
        return { stale: true, reason: 'zelle_recheck_failed' };
      }
    }
    const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId: effectiveZelleInvoiceId, dbh });
    if (!eligibility.eligible) return { stale: true, reason: eligibility.reason };
  } else if (hasNegativeZelleAvailabilityClaim(text)) {
    const denial = await zelleDenialStale({ customerId, dbh, inboundMessage, body: text });
    if (denial.stale) return denial;
  }
  const strict = strictForVersion(promptVersion);
  // The clause-aware binder runs for every strict decision AND for any
  // human-edited one (trustOwedAmounts): the human-review exemption excuses an
  // OWED amount only — a receipt/status claim asserts a fact that can go stale
  // whoever wrote the words (round-4 finding 3 / round-13 P1).
  const binderStrict = strict || trustOwedAmounts || strictStatusClaims;
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
    // Codex round-13 P1: a human-edited (trustOwedAmounts) reply is checked by the
    // clause-aware binder even on a pre-v12 prompt — the trust covers OWED clauses
    // only, never a receipt/status claim.
    return amountFreeStatusClaimStale({ customerId, body: text, strict: binderStrict, trustOwedAmounts, dbh, inboundMessage });
  }
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    // Same sweep (round-6 pre-push audit P1): a missing customer/context is a
    // failed read, not an empty account — fail closed instead of {}.
    const ctx = customerRow ? await require('./context-aggregator').getContextForCustomer(customerRow) : null;
    if (!ctx) return { stale: true, reason: 'amount_recheck_no_customer' };
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
    // Polarity-aware (round-10 P1): a negated ack ("wasn't processed") never widens the pooled paid allowance.
    const ack = drafter.hasAffirmativePaymentAck(text.replace(AMOUNT_FORMS_RE, ' AMT '));
    // The pooled rule (pre-v12 prompts, NOT human-edited) has no per-clause
    // owed/receipt split; a human-edited pre-v12 reply uses the clause-aware
    // binder with trustOwedAmounts so only its OWED clauses are excused.
    if (binderStrict) {
      // Codex round-19 P2: the SAME surfacing the draft did, from the same inbound, so a valid reply about an
      // older payment is judged against that row instead of blocked
      await surfaceReferencedPayments(ctx, inboundMessage, dbh);
      await ensureAbsenceHistory(ctx, text, dbh);
    }
    const stale = binderStrict
      ? drafter.replyQuotesUngroundedAmount(text, ctx, { byMeaning: true, trustOwedAmounts, inboundMessage })
      : amounts.some((a) => !owed.has(a) && !(ack && paid.has(a)));
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

module.exports = {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible,
  hasAffirmativeZelleMention, hasNegativeZelleAvailabilityClaim, zelleDenialStale, classifyZelleClause, bodyMakesPaymentClaim,
  amountFreeStatusClaimStale, bodyNeedsPaymentRecheck,
};
