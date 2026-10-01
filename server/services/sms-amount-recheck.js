'use strict';
// Send-time amount revalidation, shared by the scheduler's fire-time path
// (where it was written) and the immediate Agent Review send (follow-up #2
// on PR #5119): an outgoing body carrying numeric amounts must still match
// the CURRENT authoritative billing values, re-read fresh from the context
// aggregator, because a card can wait through a payment or an invoice
// change that inbound-thread staleness never sees. Fail CLOSED on any
// error — an unknowable account state must not send figures.
//
// PR #5331 adds two more send-time duties, both for real-answers (v12) decisions:
//   - PAYMENT STATUS (owner ruling 2026-10-01): the body may state a payment / invoice / refund / balance status only by copying,
//     verbatim, a sentence the decision's snapshot recorded (payment-status-contract.js) - and every copied sentence must STILL
//     be one the customer's records render right now. Anything else that asserts a status is held.
//   - ZELLE: a Zelle offer / denial is rechecked against the current recipient and the invoice's eligibility (pay-method answers
//     keep this path unchanged).
const db = require('../models/db');
const logger = require('./logger');
const drafter = require('./sms-shadow-drafter');
const paymentStatus = require('./payment-status-contract');

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
// split on clause boundaries, test negation within the SAME clause as the
// mention, never the whole reply. Any clause that mentions Zelle without one
// of these negations is affirmative, WHETHER OR NOT it also names a specific
// contact.
// Codex round-33 P2: plain copular forms count as denials too ("We are not accepting Zelle", "We aren't taking Zelle",
// "we're not set up for Zelle") — checked before the offer regex, so they never read as an offer.
// Codex round-6 pre-push audit P1 (PR #5331): negation is scoped to the Zelle
// OFFER itself — a negator DIRECTLY governing Zelle ("we don't take/accept
// Zelle", "can't use Zelle", "no longer accept payments by Zelle") or Zelle as
// the subject of a negated/unavailable predicate ("Zelle isn't available").
const ZELLE_NEGATOR = "(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|can'?t|cannot|can not|won'?t|will not|couldn'?t|could not|wouldn'?t|would not|no longer|not currently|not able to|not able|unable to|unable|stopped|aren'?t|isn'?t|wasn'?t|weren'?t|ain'?t|not)";
const ZELLE_NEGATION_RE = new RegExp(
  `\\b${ZELLE_NEGATOR}\\s+(?:(?:be\\s+able\\s+to|able\\s+to|currently|right\\s+now|really|anymore)\\s+)*`
  + '(?:(?:take|taking|accept|accepting|offer|offering|support|supporting|use|using|do|have|allow|allowing|process|processing|set\\s+up\\s+for|set\\s+up\\s+to\\s+(?:take|accept))\\s+)?'
  + '(?:(?:any|payments?|transfers?|us|our|the|a)\\s+)*(?:(?:via|by|through|with|using)\\s+)?zelle\\b'
  + "|\\bzelle\\b\\s+(?:(?:payments?|transfers?)\\s+)?(?:isn'?t|is\\s+not|aren'?t|are\\s+not|is\\s+unavailable|is\\s+no\\s+longer|not\\s+available|unavailable|not\\s+currently|no\\s+longer|not\\s+right\\s+now|not\\s+accepted|not\\s+supported|won'?t\\s+work|doesn'?t\\s+work)\\b"
  // Codex round-30 P2: SUBJECT-FIRST modal denials — "Zelle cannot be used", "Zelle won't be available", "Zelle could not be offered"
  + "|\\bzelle\\b\\s+(?:(?:payments?|transfers?)\\s+)?(?:can'?t|cannot|can\\s+not|couldn'?t|could\\s+not|won'?t|will\\s+not|wouldn'?t|would\\s+not|shouldn'?t|should\\s+not|may\\s+not|might\\s+not)\\s+(?:be\\s+)?(?:used|offered|accepted|available|supported|taken|processed|possible|an?\\s+option)\\b",
  'i',
);
// Clause boundaries: sentence ends, commas, "and"/"but", dashes.
// Round-12 P1: an UNSPACED em/en dash ends a clause too ("processing—does that answer…").
const CLAUSE_SPLIT_RE = /(?<=[;!?\n])|(?<=\.)(?=\s|$)|,\s|\s(?:and|but)\s|\s?[—–]\s?|\s-\s/;

// null (no affirmative Zelle mention in this clause), else 'offer'. A clause mentioning Zelle is a live instruction unless it
// is negated; a payment-RECEIPT clause is no longer a separate kind - a received payment is stated only by a rendered
// sentence, and a rendered sentence never names a manual tender (payment-status-contract.tenderWord), so it never mentions Zelle.
function classifyZelleClause(clause) {
  const text = String(clause || '');
  if (!ZELLE_WORD_RE.test(text)) return null;
  // A clause carrying ANY transfer contact is a live instruction — always checked, negation or not (Codex round-6 pre-push audit P1).
  if (zelleBodyContacts(text).length) return 'offer';
  return ZELLE_NEGATION_RE.test(text) ? null : 'offer';
}
// Codex round-16 P1: Zelle context carries across clauses. A reply that affirms Zelle in one
// clause and then gives the TRANSFER INSTRUCTION in another that never says "Zelle"
// ("We take Zelle. Use pay@example.com for the rest.") used to skip the recheck: the
// contact-bearing clause has no Zelle word of its own. Fail closed — any transfer
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
// Codex round-32 P2: a reply can hold BOTH a Zelle offer and a Zelle denial ("Zelle isn't available for invoice A. You can
// Zelle invoice B."). Every seam validates each independently, each against ITS OWN clause text (so each clause's invoice
// reference targets its own check): { offerText, denialText } — '' when none.
function zelleClauseTexts(body) {
  const text = String(body || '');
  const clauses = text.split(CLAUSE_SPLIT_RE);
  const offers = clauses.filter((clause) => classifyZelleClause(clause) === 'offer');
  const denials = clauses.filter((clause) => ZELLE_WORD_RE.test(clause) && !zelleBodyContacts(clause).length && ZELLE_NEGATION_RE.test(clause));
  // the cross-clause case (Zelle affirmed in one clause, the transfer instruction in another) has no single offer clause
  const offerText = offers.length ? offers.join(' ') : (hasAffirmativeZelleMention(text) ? text : '');
  return { offerText, denialText: denials.join(' ') };
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
 * An affirmative mention with NO contact ("Yes, you can use Zelle") still needs
 * the recipient-enabled check below. Only when the body ALSO names a specific
 * contact is that contact checked against the CURRENT recipient (email
 * case-insensitive, phone by digits). Fail CLOSED: a rotated or disabled
 * recipient blocks the send exactly like a stale dollar amount.
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
 * withhold Zelle for. Re-runs the SAME predicate (server/routes/pay-v2.js
 * payPageZelleVisibility - live payer, pending credit, deposit settlement)
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

// Cheap, read-free pre-screen for the SCHEDULER's fire-time seam (Codex round-11
// P1): does this body carry anything outgoingAmountsStale could judge — a dollar
// figure / price grammar, an affirmative or negative Zelle claim, or a payment-status
// assertion (the contract's detector; with the customer's message unknown, payment-scoped)? A body
// with none (a human reply about scheduling, thanks, etc.) needs no agent_decisions /
// customer / billing reads at all.
function bodyNeedsPaymentRecheck(body, { inboundMessage = null } = {}) {
  const text = String(body || '');
  if (!text) return false;
  if (bodyAmountCents(text).length) return true;
  if (hasAffirmativeZelleMention(text) || hasNegativeZelleAvailabilityClaim(text)) return true;
  if (paymentStatus.assertsPaymentStatus(text, { inboundText: inboundMessage == null ? null : String(inboundMessage) })) return true;
  try { return !!require('./sms-suggest-mode').hasPriceQuote(text); } catch { return true; }
}

/**
 * Is a Zelle DENIAL still true? { stale: false } when Zelle still is not offered to this customer (no
 * recipient configured, no open invoice, or the invoice fails the pay page's Zelle visibility); stale
 * ('zelle_now_available') when it would be offered now. An unverifiable check fails CLOSED.
 */
// Codex round-38 P2: while a Zelle recipient is configured, Waves DOES accept Zelle, so only a denial EXPLICITLY scoped to this customer's
// account / invoice ("Zelle isn't available for this account right now", "Zelle isn't available for invoice WPC-2026-0002") can be
// true - and only that kind is judged against the invoice's eligibility. A general / business-wide denial ("We don't accept Zelle",
// "Zelle isn't available right now") is false whatever the invoice state is, so it is stale outright (fail closed: scope must be stated).
const ZELLE_DENIAL_SCOPE_RE = /\b(?:this|that|your|these|those|my|the)\s+(?:[\w#-]+\s+){0,2}?(?:accounts?|invoices?|bills?|balances?)\b|\binvoices?\s*#?\s*[\w-]*\d|#\s?\d{3,}|\bWPC-\d{4}-\d+|\bfor\s+you\b/i;
function hasUnscopedZelleDenial(body) {
  return String(body || '').split(CLAUSE_SPLIT_RE)
    .filter((clause) => ZELLE_WORD_RE.test(clause) && !zelleBodyContacts(clause).length && ZELLE_NEGATION_RE.test(clause))
    .some((clause) => !ZELLE_DENIAL_SCOPE_RE.test(clause));
}
const ZELLE_DENIAL_UNVERIFIABLE = new Set(['zelle_recheck_failed', 'payer_unverifiable', 'credit_unverifiable']);
async function zelleDenialStale({ customerId, dbh = db, inboundMessage = null, body = null } = {}) {
  const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');
  if (!manualPayOptionsFromEnv()?.zelle?.recipient) return { stale: false };
  if (body && hasUnscopedZelleDenial(body)) return { stale: true, reason: 'zelle_now_available' };
  if (!customerId) return { stale: true, reason: 'zelle_recheck_failed' };
  try {
    const customerRow = await dbh('customers').where({ id: customerId }).first();
    const ctx = customerRow ? await require('./context-aggregator').getContextForCustomer(customerRow) : null;
    if (!ctx) return { stale: true, reason: 'zelle_recheck_failed' };
    // Codex round-43 P2: an unavailable billing read (invoice / ownership lookup failed) leaves the open-invoice list EMPTY, which would
    // read as a genuine `no_open_invoice` and let an account-scoped denial stand. Unknown availability is never a denial: fail closed.
    if (!ctx.billing || ctx.billing.unavailable) return { stale: true, reason: 'zelle_recheck_failed' };
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

// The customer's current context, fresh, or null (no customer row / nothing loadable): never substituted by {} - a missing
// context is a failed read, not an empty account.
async function loadCustomerContext(customerId, dbh = db) {
  const customerRow = await dbh('customers').where({ id: customerId }).first();
  return customerRow ? require('./context-aggregator').getContextForCustomer(customerRow) : null;
}

/**
 * PAYMENT STATUS at send time. The snapshot (input_snapshot.payment_status_snapshot) names the sentences the draft copied; they
 * are the only authorized status wording. Returns null when the body may go out, else a reason:
 *   payment_status_unauthorized        - the body asserts a payment / invoice / refund / balance status that is not a verbatim
 *                                        copy of a snapshotted sentence (an edit, a paraphrase, a status typed in by hand)
 *   payment_status_changed             - a copied sentence is no longer one the records render right now
 *   payment_status_recheck_no_customer / payment_status_recheck_failed - unverifiable, fail closed
 * A body that copies nothing and asserts nothing needs no billing read at all.
 */
async function paymentStatusSendBlockReason({ customerId, body, snapshot = null, inboundMessage = null, dbh = db, ctx = null } = {}) {
  const text = String(body || '');
  const authorized = Array.isArray(snapshot?.sentences) ? snapshot.sentences.filter((s) => typeof s === 'string') : [];
  const copied = paymentStatus.copiedSentences(text, authorized);
  const remainder = text.length > paymentStatus.MAX_REPLY_CHARS ? text : paymentStatus.withoutCopies(text, copied);
  if (paymentStatus.assertsPaymentStatus(remainder, { inboundText: inboundMessage == null ? null : String(inboundMessage) })) return 'payment_status_unauthorized';
  if (!copied.length) return null;
  if (!customerId) return 'payment_status_recheck_no_customer';
  if (snapshot.customer_id && String(snapshot.customer_id) !== String(customerId)) return 'payment_status_changed';
  try {
    const context = ctx || await loadCustomerContext(customerId, dbh);
    if (!context) return 'payment_status_recheck_failed';
    const live = paymentStatus.renderPaymentStatusSentences(context).map((s) => s.text);
    return copied.every((s) => live.includes(s)) ? null : 'payment_status_changed';
  } catch (err) {
    logger.warn(`[sms-amount-recheck] payment-status recheck failed for customer ${customerId}: ${err.message}; blocking send`);
    return 'payment_status_recheck_failed';
  }
}

// `trustOwedAmounts` (independent-review P1, round 4, finding 3): the
// scheduler's own "a human already reviewed this exact figure" trust (owner
// ruling 2026-07-30). It excuses the OWED-figure half only - never a Zelle
// offer or a payment-status assertion, both of which can go stale between
// review and fire regardless of who wrote the words.
async function outgoingAmountsStale({
  customerId, body, promptVersion = null, zelleInvoiceId = null, dbh = db, trustOwedAmounts = false,
  // the customer's own inbound wording (decision.inbound_message / the sms_log row's body): scopes the payment-status detector
  inboundMessage = null,
  // input_snapshot.payment_status_snapshot of the decision (null = the draft copied no sentence)
  paymentStatusSnapshot = null,
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
  // OFFER — contact or not. A body with no affirmative Zelle offer at all has
  // nothing to recheck.
  const { offerText, denialText } = zelleClauseTexts(text);
  if (offerText) {
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
    // the OFFER clauses' own text decides the target (a denial clause in the same reply targets its own check below)
    const editedNamesInvoice = explicitInvoiceReference(offerText);
    if (customerId && (!effectiveZelleInvoiceId || editedNamesInvoice)) {
      try {
        const ctx = (await loadCustomerContext(customerId, dbh)) || {};
        if (!effectiveZelleInvoiceId) {
          // Codex round-30 P1: the OUTGOING body's explicit invoice reference wins (unresolvable => unresolved => blocked);
          // the customer's message decides only when the body names none. Several open: else abstain.
          effectiveZelleInvoiceId = resolveZelleTargetInvoice(ctx?.billing, editedNamesInvoice ? offerText : inboundMessage).invoiceId;
        } else {
          const edited = resolveZelleTargetInvoice(ctx?.billing, offerText).invoiceId;
          if (edited !== effectiveZelleInvoiceId) effectiveZelleInvoiceId = edited; // re-targeted (null => unresolved => blocked below)
        }
      } catch (err) {
        logger.warn(`[sms-amount-recheck] open-invoice lookup for Zelle recheck failed for customer ${customerId}: ${err.message}; blocking send`);
        return { stale: true, reason: 'zelle_recheck_failed' };
      }
    }
    const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId: effectiveZelleInvoiceId, dbh });
    if (!eligibility.eligible) return { stale: true, reason: eligibility.reason };
  }
  // INDEPENDENT of the offer branch (round 32): a reply with both an offer and a denial validates both
  if (denialText) {
    const denial = await zelleDenialStale({ customerId, dbh, inboundMessage, body: denialText });
    if (denial.stale) return denial;
  }
  const strict = strictForVersion(promptVersion);
  let ctx = null;
  let checked = text;
  if (strict) {
    // PAYMENT STATUS: only a verbatim copy of a snapshotted sentence that is still rendered may state one (owner ruling 2026-10-01).
    const statusReason = await paymentStatusSendBlockReason({ customerId, body: text, snapshot: paymentStatusSnapshot, inboundMessage, dbh });
    if (statusReason) return { stale: true, reason: statusReason };
    // ...and the figures judged below are the ones OUTSIDE the copied sentences (those were just re-verified live).
    checked = paymentStatus.withoutCopies(text, paymentStatus.copiedSentences(text, paymentStatusSnapshot?.sentences));
  }
  if (trustOwedAmounts) return { stale: false }; // a human reviewed the owed figures; status and Zelle were judged above
  const amounts = bodyAmountCents(checked);
  if (!amounts.length) {
    // Price grammar the numeric extractor cannot verify ("fifty dollars",
    // "45/mo") is unverifiable, not amount-free (audit P1): with real
    // answers on it fails closed, mirroring the drafter's draft-time rule.
    const unverifiable = strict && require('./sms-suggest-mode').hasPriceQuote(checked);
    return unverifiable ? { stale: true, reason: 'amount_unverifiable' } : { stale: false };
  }
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    // (getContextForCustomer's default skips the LIVE ETA lookup - Codex round-2 P2, PR #5334 - so this send-time read makes no GPS call)
    ctx = await loadCustomerContext(customerId, dbh);
    // A missing customer/context is a failed read, not an empty account — fail closed instead of {}.
    if (!ctx) return { stale: true, reason: 'amount_recheck_no_customer' };
    // Real answers: each remaining figure must be an OWED one in an owed clause (drafter.remainderAmountsUngrounded) - a
    // payment's own figure is stated only inside a copied sentence. Otherwise main's pooled rule over the same shared figures:
    // what is still owed, plus payment history only when the body reads as an acknowledgement (masked first, audit P1 - the
    // ack grammar stops at a period, and "$95.50" must not end the clause).
    const { owed, paid } = drafter.billingAmountCents(ctx);
    const ack = PAYMENT_ACK_RE.test(text.replace(AMOUNT_FORMS_RE, ' AMT '));
    const stale = strict
      ? drafter.remainderAmountsUngrounded(checked, ctx)
      : amounts.some((a) => !owed.has(a) && !(ack && paid.has(a)));
    return stale ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

module.exports = {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible,
  hasAffirmativeZelleMention, hasNegativeZelleAvailabilityClaim, hasUnscopedZelleDenial, zelleClauseTexts, zelleDenialStale, classifyZelleClause,
  paymentStatusSendBlockReason, bodyNeedsPaymentRecheck,
};
