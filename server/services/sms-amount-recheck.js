'use strict';
// Send-time amount revalidation, shared by the scheduler's fire-time path
// (where it was written) and the immediate Agent Review send (follow-up #2
// on PR #5119): an outgoing body carrying numeric amounts must still match
// the CURRENT authoritative billing values, re-read fresh from the context
// aggregator, because a card can wait through a payment or an invoice
// change that inbound-thread staleness never sees. Fail CLOSED on any
// error — an unknowable account state must not send figures.
//
// PR #5331, real-answers (v12) decisions - the MONEY-SENTENCE CONTRACT (owner 2026-10-01; widened ~23:58Z to all money content):
//   an UNEDITED AI body may state a payment / invoice / refund / balance status, ANY dollar figure, or anything about Zelle only by
//   copying, verbatim, a sentence the decision's snapshot recorded (payment-status-contract.js) - and every copied sentence must STILL
//   be one the customer's records render right now (a copied Zelle sentence: same recipient, same live eligibility of its invoice).
//   Anything else money-shaped is held. There is no clause grammar here any more (no offer / denial classifier, no owed-amount pool).
//   A STAFF-EDITED body is the staff member's own wording (owner 2026-10-01 ~05:50Z): main's amount rule, and any Zelle contact in it
//   must be the current recipient for an invoice that still takes Zelle.
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

// A staff-written Zelle CONTACT (an email / phone in a body that mentions Zelle) must be the CURRENT recipient - a rotated or removed
// ZELLE_RECIPIENT blocks the send. (The AI's own Zelle sentences are copies, rechecked by re-rendering; this is the staff-edit path.)
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

// The LIVE Zelle facts for one invoice - what the renderer turns into a Zelle sentence (payment-status-contract.zelleSentences): offer
// (recipient configured + the invoice takes Zelle now), invoice_unavailable (CONFIRMED not eligible), not_offered (no recipient), or
// null (no invoice / an unverifiable state: renders nothing). The SAME function builds the draft's facts and re-renders at send.
const ZELLE_UNVERIFIABLE = new Set(['zelle_recheck_failed', 'payer_unverifiable', 'credit_unverifiable', 'zelle_invoice_unresolved']);
async function liveZelleFacts({ customerId, invoiceId, dbh = db } = {}) {
  const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');
  const recipient = manualPayOptionsFromEnv()?.zelle?.recipient || null;
  if (!recipient) return { state: 'not_offered', invoiceId: invoiceId || null, invoiceNumber: null, recipient: null };
  if (!customerId || !invoiceId) return { state: null, invoiceId: invoiceId || null, invoiceNumber: null, recipient };
  let invoiceNumber = null;
  try {
    const row = await dbh('invoices').where({ id: invoiceId, customer_id: customerId }).first('invoice_number');
    // the target invoice is GONE (deleted / moved to another customer): a change, not an outage
    if (!row) return { state: null, invoiceId, invoiceNumber: null, recipient };
    invoiceNumber = row.invoice_number || null;
  } catch {
    return { state: null, invoiceId, invoiceNumber: null, recipient, unverifiable: true };
  }
  const eligibility = await zelleInvoiceStillEligible({ customerId, zelleInvoiceId: invoiceId, dbh });
  // Codex round-62 P1: the recipient is read AGAIN after the eligibility awaits - one rotated or removed meanwhile is the one returned
  const recipientNow = manualPayOptionsFromEnv()?.zelle?.recipient || null;
  if (!recipientNow) return { state: 'not_offered', invoiceId, invoiceNumber: null, recipient: null };
  if (!eligibility.eligible && ZELLE_UNVERIFIABLE.has(eligibility.reason)) return { state: null, invoiceId, invoiceNumber, recipient: recipientNow, unverifiable: true };
  return { state: eligibility.eligible ? 'offer' : 'invoice_unavailable', invoiceId, invoiceNumber, recipient: recipientNow };
}

// Cheap, read-free pre-screen for the send seams (Codex round-11 P1): does this body carry anything the recheck judges - a dollar figure /
// price grammar, any mention of Zelle, or (real-answers drafts only) payment-status vocabulary (customer's message unknown => scoped)?
// A body with none (a reply about scheduling, thanks, ...) needs no decision / customer / billing reads at all. Gate off (and no v12
// decision) the status trigger is off.
function bodyHasPaymentStatusVocabulary(body) {
  return paymentStatus.assertsPaymentStatus(String(body || ''), { inboundText: null });
}
function bodyNeedsPaymentRecheck(body, { inboundMessage = null, promptVersion = null, statusVocabulary = true } = {}) {
  const text = String(body || '');
  if (!text) return false;
  if (bodyAmountCents(text).length || ZELLE_WORD_RE.test(text)) return true;
  if (statusVocabulary && strictForVersion(promptVersion)
      && paymentStatus.assertsPaymentStatus(text, { inboundText: inboundMessage == null ? null : String(inboundMessage) })) return true;
  try { return !!require('./sms-suggest-mode').hasPriceQuote(text); } catch { return true; }
}
// A body the recheck judges also gets the billing-fingerprint check at the provider boundary (Codex round-49 P1).
const bodyNeedsBillingBoundaryCheck = bodyNeedsPaymentRecheck;

// The customer's current context, fresh, or null (no customer row / nothing loadable): never substituted by {} - a missing
// context is a failed read, not an empty account.
async function loadCustomerContext(customerId, dbh = db) {
  const customerRow = await dbh('customers').where({ id: customerId }).first();
  return customerRow ? require('./context-aggregator').getContextForCustomer(customerRow) : null;
}

/**
 * THE CONTRACT at send time. The snapshot (input_snapshot.payment_status_snapshot) names the sentences the draft copied; they are the
 * only authorized money wording. { reason, zelle }: reason null when the body may go out, else
 *   payment_status_unauthorized        - after the copies are removed the body still asserts a status, carries a dollar figure / price
 *                                        grammar / Zelle, or a copy answers a different record than the customer named
 *   payment_status_not_auto_sendable   - (auto-send only) a payment-scoped reply with anything beyond copies and inert text
 *   payment_status_ambiguous           - (auto-send only) a copied receipt / invoice line had 2+ rendered candidates: a person picks
 *   payment_status_changed             - a copied sentence is no longer one the records render right now
 *   payment_status_recheck_no_customer / payment_status_recheck_failed - unverifiable, fail closed
 * `zelle` = the live Zelle facts a copied Zelle sentence was re-rendered from (the provider boundary re-reads them).
 */
async function paymentStatusVerdict({ customerId, body, snapshot = null, inboundMessage = null, dbh = db, ctx = null, autoSend = false } = {}) {
  const text = String(body || '');
  const authorized = Array.isArray(snapshot?.sentences) ? snapshot.sentences.filter((s) => typeof s === 'string') : [];
  const copied = paymentStatus.copiedSentences(text, authorized);
  const remainder = text.length > paymentStatus.MAX_REPLY_CHARS ? text : paymentStatus.withoutCopies(text, copied);
  const inboundText = inboundMessage == null ? null : String(inboundMessage);
  const scoped = snapshot?.scoped === true || authorized.length > 0;
  if (paymentStatus.remainderHasMoney(remainder) || paymentStatus.assertsPaymentStatus(remainder, { inboundText, scoped })) {
    return { reason: 'payment_status_unauthorized', zelle: null };
  }
  // a copied sentence about a different record than the one the customer named answers nothing (Codex round-59 P2)
  if (paymentStatus.copiesOffTarget(copied, inboundText)) return { reason: 'payment_status_unauthorized', zelle: null };
  // The AUTONOMOUS rung does not trust the detector alone: a payment-scoped reply auto-sends only as verbatim copies plus inert text.
  if (autoSend) {
    const scopeBlock = paymentStatus.autoSendScopeBlock({ reply: text, inboundText, snapshot });
    if (scopeBlock) return { reason: scopeBlock, zelle: null };
  }
  return copied.length ? copiedSentencesStillRendered({ customerId, copied, snapshot, ctx, dbh, autoSend }) : { reason: null, zelle: null };
}
async function paymentStatusSendBlockReason(args = {}) {
  return (await paymentStatusVerdict(args)).reason;
}
// Every copied sentence must still be one the records render right now (a fresh read; unreadable => fail closed). A copied Zelle
// sentence is re-rendered from the LIVE Zelle facts of the invoice it named (snapshot.zelle.invoice_id).
async function copiedSentencesStillRendered({ customerId, copied, snapshot, ctx, dbh, autoSend = false }) {
  if (!customerId) return { reason: 'payment_status_recheck_no_customer', zelle: null };
  if (snapshot.customer_id && String(snapshot.customer_id) !== String(customerId)) return { reason: 'payment_status_changed', zelle: null };
  try {
    const context = ctx || await loadCustomerContext(customerId, dbh);
    // Codex round-75 P2: the aggregator reports an inner read failure as billing.unavailable (not a throw) - an outage, retryable,
    // never "the sentence is no longer true"
    if (!context || context.billing?.unavailable === true) return { reason: 'payment_status_recheck_failed', zelle: null };
    const copiesZelle = copied.some((t) => ZELLE_WORD_RE.test(t));
    const zelle = copiesZelle ? await liveZelleFacts({ customerId, invoiceId: snapshot?.zelle?.invoice_id || null, dbh }) : null;
    // Codex round-71 P2: an UNREADABLE Zelle state (a target invoice whose eligibility could not be verified) is an outage, not a change -
    // it stays retryable instead of retiring the reviewed decision
    if (zelleUnverifiable(zelle)) return { reason: 'zelle_recheck_failed', zelle: null };
    const live = paymentStatus.renderPaymentStatusSentences(zelle ? { ...context, billing: { ...(context.billing || {}), zelleFacts: zelle } } : context)
      .map((s) => s.text);
    if (!copied.every((t) => live.includes(t))) return { reason: 'payment_status_changed', zelle: null };
    // Codex round-70 P2 (hold when ambiguous, owner 2026-10-02): the AUTO-send recheck recounts each copied line's family from the LIVE
    // render - a second receipt that arrived after drafting makes the copy a guess again
    if (autoSend) {
      // (Codex round-74 P2: records too - a disputed / unknown row renders nothing but is still a candidate)
      const counts = paymentStatus.candidateFamilyCounts(live, context.billing);
      if (copied.some((t) => { const f = paymentStatus.sentenceFamily(t); return f != null && counts[f] !== 1; })) return { reason: 'payment_status_ambiguous', zelle: null };
    }
    return { reason: null, zelle };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] payment-status recheck failed for customer ${customerId}: ${err.message}; blocking send`);
    return { reason: 'payment_status_recheck_failed', zelle: null };
  }
}

// STAFF-EDITED (or pre-v12) bodies: a Zelle contact is real payment instructions - it must be the current recipient, and the invoice the
// decision targeted (zelleInvoiceId) must still take Zelle. A Zelle mention with no contact is the staff member's own words.
// The invoice is the one the BODY names when it names one (a reviewer edit can re-target the instructions - Codex rounds 29/30), else the
// decision's target, else the invoice the customer's message names / their one open invoice (resolveZelleTargetInvoice); unresolvable
// => no invoice => not eligible (fail closed).
// liveZelleFacts could not READ the target invoice's Zelle state (a lookup failure, an unverifiable eligibility reason): an outage, never
// 'changed' (Codex round-71 P2). A gone invoice or no target is a change, not this.
const zelleUnverifiable = (facts) => facts?.unverifiable === true;
async function staffZelleStale({ customerId, text, zelleInvoiceId, inboundMessage = null, dbh }) {
  if (!zelleBodyContacts(text).length) return { stale: false, zelle: null };
  const recipient = outgoingZelleStale(text);
  if (recipient.stale) return { ...recipient, zelle: null };
  const { resolveZelleTargetInvoice, explicitInvoiceReference } = require('./zelle-target-invoice');
  let invoiceId = zelleInvoiceId || null;
  const bodyNamesInvoice = explicitInvoiceReference(text);
  if (customerId && (bodyNamesInvoice || !invoiceId)) {
    try {
      const ctx = await loadCustomerContext(customerId, dbh);
      // (a staff-typed figure in the edited body is deliberate: it may select among several open invoices - the customer's may not)
      const resolved = (bodyNamesInvoice ? resolveZelleTargetInvoice(ctx?.billing, text, { figuresIdentify: true }) : resolveZelleTargetInvoice(ctx?.billing, inboundMessage)).invoiceId || null;
      // the body's own reference decides when it has one (Codex rounds 71/73: "use Zelle to send $210" checks the $210 invoice); a number
      // or figure that points at no single invoice is UNRESOLVED => blocked (Codex round-79 P1, hold when ambiguous: "Zelle $305" may be
      // the aggregate of two invoices - never silently the draft's old target). No reference in the body: the decision's target.
      invoiceId = bodyNamesInvoice ? resolved : (resolved || invoiceId || null);
    } catch (err) {
      logger.warn(`[sms-amount-recheck] Zelle target lookup failed for customer ${customerId}: ${err.message}; blocking send`);
      return { stale: true, reason: 'zelle_recheck_failed', zelle: null };
    }
  }
  const facts = await liveZelleFacts({ customerId, invoiceId, dbh });
  if (zelleUnverifiable(facts)) return { stale: true, reason: 'zelle_recheck_failed', zelle: null };
  return facts.state === 'offer' ? { stale: false, zelle: facts } : { stale: true, reason: 'zelle_invoice_ineligible', zelle: null };
}

// OWED AMOUNTS (main's rule, staff-edited and pre-v12 bodies): every figure is what is still owed, or a payment-history figure in a body
// that reads as an acknowledgement (masked first, audit P1 - the ack grammar stops at a period, and "$95.50" must not end the clause).
async function ownedAmountsStale({ customerId, text, dbh }) {
  const amounts = bodyAmountCents(text);
  if (!amounts.length) return { stale: false };
  if (!customerId) return { stale: true, reason: 'amount_recheck_no_customer' };
  try {
    // (getContextForCustomer's default skips the LIVE ETA lookup - Codex round-2 P2, PR #5334 - so this send-time read makes no GPS call)
    const ctx = await loadCustomerContext(customerId, dbh);
    // A missing customer/context is a failed read, not an empty account — fail closed instead of {}.
    if (!ctx) return { stale: true, reason: 'amount_recheck_no_customer' };
    const { owed, paid } = drafter.billingAmountCents(ctx);
    const ack = PAYMENT_ACK_RE.test(text.replace(AMOUNT_FORMS_RE, ' AMT '));
    return amounts.some((a) => !owed.has(a) && !(ack && paid.has(a))) ? { stale: true, reason: 'amount_no_longer_authorized' } : { stale: false };
  } catch (err) {
    logger.warn(`[sms-amount-recheck] amount revalidation failed for customer ${customerId}: ${err.message}; blocking send`);
    return { stale: true, reason: 'amount_recheck_failed' };
  }
}

/**
 * Is an outgoing body still authorized by the customer's CURRENT billing? { stale: false, zelle } or { stale: true, reason }.
 *   - unedited real-answers (v12) body: the money-sentence contract (paymentStatusVerdict) - nothing else;
 *   - staff-edited v12 body, or a pre-v12 body: a Zelle contact rechecked (staffZelleStale), then main's owed-amount rule unless the
 *     caller trusts the owed figures (`trustOwedAmounts`, the scheduler's reviewed-figure trust, owner ruling 2026-07-30).
 * `zelle` = the live Zelle facts the verdict stood on, re-read at the provider boundary (billing-fingerprint).
 */
async function outgoingAmountsStale({
  customerId, body, promptVersion = null, zelleInvoiceId = null, dbh = db, trustOwedAmounts = false,
  // the customer's own inbound wording (decision.inbound_message / the sms_log row's body): scopes the payment-status detector
  inboundMessage = null,
  // input_snapshot.payment_status_snapshot of the decision (null = the draft copied no sentence)
  paymentStatusSnapshot = null,
  // Owner ruling 2026-10-01: the body is a STAFF EDIT of the AI draft (callers compare it with the stored draft; auto-send never sets this).
  humanEditedBody = false,
} = {}) {
  const text = String(body || '');
  if (strictForVersion(promptVersion) && humanEditedBody !== true) {
    const verdict = await paymentStatusVerdict({ customerId, body: text, snapshot: paymentStatusSnapshot, inboundMessage, dbh });
    return verdict.reason ? { stale: true, reason: verdict.reason } : { stale: false, ...(verdict.zelle ? { zelle: verdict.zelle } : {}) };
  }
  // Codex round-77 P1: an UNEDITED pre-v12 AI draft that says anything about Zelle without a contact ("Yes, Zelle is available", "We don't
  // take Zelle") cannot be re-checked against today's configuration or invoice (v11 never had Zelle facts) - held, never sent. Only a
  // staff member's own wording carries the staff exemption.
  // (an AI draft = a prompt version on the decision; a hand-typed body with none is the staff member's own wording)
  if (promptVersion && humanEditedBody !== true && ZELLE_WORD_RE.test(text) && !zelleBodyContacts(text).length) return { stale: true, reason: 'zelle_claim_unverifiable' };
  const zelle = await staffZelleStale({ customerId, text, zelleInvoiceId, inboundMessage, dbh });
  if (zelle.stale) return { stale: true, reason: zelle.reason };
  const amounts = trustOwedAmounts ? { stale: false } : await ownedAmountsStale({ customerId, text, dbh });
  return amounts.stale ? amounts : { stale: false, ...(zelle.zelle ? { zelle: zelle.zelle } : {}) };
}

module.exports = {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible, liveZelleFacts,
  paymentStatusVerdict, paymentStatusSendBlockReason, bodyNeedsPaymentRecheck, bodyHasPaymentStatusVocabulary, bodyNeedsBillingBoundaryCheck,
};
