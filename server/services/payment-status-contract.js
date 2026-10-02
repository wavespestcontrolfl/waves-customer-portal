'use strict';
// PAYMENT STATUS CONTRACT (owner ruling 2026-10-01, PR #5331).
//
// The AI may state a payment / invoice / refund / balance STATUS only by copying,
// word for word and as a whole sentence, a sentence this module RENDERS from the
// customer's own billing records. Anything else that asserts such a status holds
// the draft for staff. A word-list checker over free text cannot converge (43
// Codex rounds), so the free-text claim binders are gone: this module has
//   1. a RENDERER  - the small, deterministic set of sentences the records
//      support (and none at all for anything truncated, ambiguous or unverifiable);
//   2. a COPY test - a reply (or a send-time body) contains a sentence only as a
//      complete, stand-alone, verbatim copy;
//   3. a DETECTOR  - broad and conservative: after the copied sentences are
//      removed, ANY remaining payment-status vocabulary in a payment-scoped reply
//      is an unauthorized assertion. False holds are fine (staff review); a false
//      pass is not.
// WIDENED (owner 2026-10-01 ~23:58Z, "widen the contract to ALL money content"): in an unedited AI body every sentence that names a
// dollar amount, Zelle, or a payment receipt / status must be a verbatim copy of a rendered sentence - the monthly plan price and
// card charge, and the Zelle offer / unavailability per target invoice are rendered too. The clause grammar that used to classify
// Zelle offers / denials and pool owed amounts is gone. A pay-METHOD answer with no amount and no Zelle ("you can pay by card or bank
// account through your pay link") needs no sentence.
//
// One shape table drives rendering AND parsing (a frozen replay reads its
// sentences back out of its own facts block), so the two cannot drift.

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_REPLY_CHARS = 2000;
const MAX_INBOUND_CHARS = 1000;

const SECTION_HEADER = '- Payment status sentences (the ONLY way to state a payment, invoice, refund or balance status, ANY dollar amount, or anything about Zelle is to copy one of these word for word, as a whole sentence, and only one that answers what the customer asked):';
const SECTION_NONE = '- Payment status sentences: none on file right now - state no payment, invoice, refund or balance status, no dollar amount and nothing about Zelle; say a teammate will confirm';
const SENTENCE_BULLET = '  - ';

// ---- Rendering -------------------------------------------------------------
const finiteCents = (v) => {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const dateText = (d) => `${SHORT_MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
// A DATE column arrives as a local-midnight Date (pg) or a 'YYYY-MM-DD' string; anything else is unreadable (no sentence).
function dateParts(value) {
  if (!value) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const s = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? '' : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`)
    : String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.0+)?Z?$)/.exec(s);
  if (!m) return null;
  const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return parts.month >= 1 && parts.month <= 12 && parts.day >= 1 && parts.day <= 31 ? parts : null;
}
const dayKey = (d) => d.year * 10000 + d.month * 100 + d.day;
// The ET calendar-day key of a payment row (null = undatable): shared with the aggregator's lookahead.
const paymentDayKey = (p) => { const d = dateParts(p?.payment_date || p?.date); return d ? dayKey(d) : null; };

// The tender word a sentence may carry: only what the row's own Stripe columns prove. A manual tender (Zelle, check, ...) is
// never named, so no rendered sentence ever contains "Zelle" (the Zelle recheck treats every Zelle clause as an offer/denial).
function tenderWord(p) {
  const type = String(p?.payment_method_type || '').toLowerCase();
  if (type === 'card') return 'card';
  if (type.includes('bank') || type === 'us_bank_account' || type === 'ach') return 'ACH';
  const meta = paymentMetadata(p);
  const method = String(meta.payment_method || '').toLowerCase();
  if (method === 'card') return 'card';
  if (method.includes('bank') || method === 'ach') return 'ACH';
  return null;
}

const AMT = '\\$\\d+\\.\\d{2}';
const TENDER = '(?: (?:card|ACH))?';
const DAY = '[A-Z][a-z]{2} \\d{1,2}, \\d{4}';
const INVOICE = '[A-Za-z0-9][A-Za-z0-9-]{0,29}';
const SHAPES = Object.freeze({
  payment_received: new RegExp(`^We received your ${AMT}${TENDER} payment on ${DAY}\\.$`),
  payment_partly_refunded: new RegExp(`^We received your ${AMT}${TENDER} payment on ${DAY}, and ${AMT} of it was refunded\\.$`),
  payment_refunded: new RegExp(`^Your ${AMT}${TENDER} payment on ${DAY} was refunded in full\\.$`),
  payment_processing: new RegExp(`^Your ${AMT}${TENDER} payment from ${DAY} is still processing\\.$`),
  payment_failed: new RegExp(`^A ${AMT}${TENDER} payment attempt on ${DAY} did not go through\\.$`),
  invoice_paid: new RegExp(`^Invoice ${INVOICE} for ${AMT} is paid\\.$`),
  invoice_refunded: new RegExp(`^Invoice ${INVOICE} for ${AMT} was refunded\\.$`),
  invoice_due: new RegExp(`^Invoice ${INVOICE} has ${AMT} due(?: by ${DAY})?\\.$`),
  invoice_processing: new RegExp(`^Invoice ${INVOICE} for ${AMT} is still processing\\.$`),
  balance: new RegExp(`^Your account balance is ${AMT}\\.$`),
  no_balance: /^Your account has no balance due\.$/,
  no_payment_since: new RegExp(`^We don't see a payment on your account since ${DAY}\\.$`),
  no_payments: /^We don't see any payments on your account\.$/,
  // the money every reply may need to state (owner 2026-10-01 ~23:58Z): the plan price, the card charge, and Zelle per target invoice
  dues_monthly: new RegExp(`^Your monthly plan price is ${AMT}\\.$`),
  dues_card_charge: new RegExp(`^When your dues are charged to the credit card on file, the monthly charge is ${AMT}: ${AMT} dues plus a ${AMT} credit-card fee\\.$`),
  zelle_offer: new RegExp(`^You can pay invoice ${INVOICE} by Zelle to [^,\\n]{3,80}, with your name or the invoice number in the Zelle memo\\.$`),
  zelle_invoice_unavailable: new RegExp(`^Zelle isn't available for invoice ${INVOICE} right now\\.$`),
  zelle_not_offered: /^We don't take Zelle right now\.$/,
});
const kindOf = (text) => Object.keys(SHAPES).find((k) => SHAPES[k].test(text)) || null;

const billingIsReadable = (billing) => !!billing && typeof billing === 'object' && !billing.unavailable;

// The invoice statuses the renderer positively models. A status in this set is either settled / void (nothing owed), counted by the
// balance (sent / viewed / overdue, net of credit) or in flight (processing, covered by hasProcessingPayment). ANY other status of an
// own, non-draft invoice (a legacy 'unpaid', 'partially_paid', ...) is a debt the renderer cannot describe: it suppresses every
// "nothing owed" / "no payments" sentence. A whitelist, never a blacklist of the statuses somebody remembered.
const MODELED_INVOICE_STATUSES = new Set(['paid', 'prepaid', 'refunded', 'void', 'voided', 'canceled', 'cancelled', 'processing', 'sent', 'viewed', 'overdue']);
const unmodeledStatus = (inv) => {
  const status = String(inv?.status || '').toLowerCase();
  return status !== 'draft' && !MODELED_INVOICE_STATUSES.has(status);
};
// `hasUnmodeledInvoice` is the aggregator's verdict over ALL the customer's own invoice rows (the status list below is cut at 8).
const hasUnmodeledInvoice = (billing) => billing?.hasUnmodeledInvoice === true
  || (Array.isArray(billing?.invoiceStatuses) && billing.invoiceStatuses.some(unmodeledStatus));
// An active payment plan changes what is due NOW (installments), and the invoice balance does not reflect installments: no sentence
// states a balance, a due amount or "nothing owed" for such a customer (the aggregator reads true on an unreadable lookup).
const onActivePaymentPlan = (billing) => billing?.hasActivePaymentPlan === true;

// An obligation exists (or money is in flight / unknown): settlement is then neither stated nor implied.
// Codex round-64 P2: a retained payment in any state other than these (disputed, requires_action, an unknown status) is unresolved money.
const RESOLVED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'refunded', 'failed', 'canceled', 'cancelled', 'void', 'voided']);
function hasOutstandingObligation(billing) {
  const b = billing || {};
  const inFlight = b.hasProcessingPayment !== false
    || (b.recentPayments || []).some((p) => !RESOLVED_PAYMENT_STATUSES.has(String(p?.status || '').toLowerCase()));
  return Number(b.outstandingBalance) > 0 || Number(b.openInvoice?.amountDue) > 0 || inFlight || b.hasUncountedPartialDue === true
    || hasUnmodeledInvoice(b) || onActivePaymentPlan(b);
}

// Which payments rows may be stated as money RECEIVED? Mirrors sms-commitment-fulfillment's `paymentEvidenceRow`: a row that only
// APPLIES earlier money is not a payment that arrived on its date. `scheduled_service_prepaid` is the row written when cash / Zelle
// recorded on a visit is applied to its invoice later (payment_date = the application date, not the receipt date); a no-show / card
// hold fee is not the customer's payment for an invoice; a combined-balance charge is split across several rows (no row's amount is
// what the customer paid); a refund still in flight leaves the row's state unknown. Such a row renders nothing - and, because
// money exists that no sentence describes, no "we don't see a payment" sentence either.
const NON_RECEIPT_SOURCES = new Set(['scheduled_service_prepaid']);
const NON_RECEIPT_PURPOSES = new Set(['card_hold_no_show_fee', 'appointment_card_no_show_fee']);
function paymentMetadata(p) {
  try { return p?.metadata && typeof p.metadata === 'object' ? p.metadata : JSON.parse(p?.metadata || 'null') || {}; } catch { return {}; }
}
function isReceiptRow(p) {
  const meta = paymentMetadata(p);
  return !NON_RECEIPT_SOURCES.has(String(meta.source || '').toLowerCase())
    && !NON_RECEIPT_PURPOSES.has(String(meta.purpose || '').toLowerCase())
    && String(meta.combined_payment ?? '').toLowerCase() !== 'true'
    && !meta.pending_refund_key
    && !(meta.deferred_reason && !p?.stripe_payment_intent_id) // a never-attempted deferral (lock contention, dispute hold) is no payment attempt
    // a Stripe timeout recorded as failed with ambiguous_outcome may have succeeded: unknown, never "did not go through" (local review P1)
    && String(meta.ambiguous_outcome ?? '').toLowerCase() !== 'true'
    && !meta.payer_id && !p?.payer_id;
}

// One small renderer per payment status (`f` = the facts paymentSentence derives once). Each returns { kind, text } or null.
function paidPaymentSentence(f) {
  const { total, date, what, refundStatus, refunded } = f;
  if (refunded > 0 && refunded < total && ['partial', 'succeeded'].includes(refundStatus)) {
    return { kind: 'payment_partly_refunded', text: `We received your ${what} on ${dateText(date)}, and ${money(refunded)} of it was refunded.` };
  }
  // any other refund trace on a "paid" row (pending / failed / unreadable refund) is an unknown state: no sentence
  if (refunded > 0 || !['', 'none'].includes(refundStatus)) return null;
  return { kind: 'payment_received', text: `We received your ${what} on ${dateText(date)}.` };
}
function refundedPaymentSentence(f) {
  const { total, date, what, refundStatus, refunded } = f;
  if (!['', 'full', 'succeeded'].includes(refundStatus) || (refunded > 0 && refunded < total)) return null;
  return { kind: 'payment_refunded', text: `Your ${what} on ${dateText(date)} was refunded in full.` };
}
function inFlightPaymentSentence(f) {
  const { date, what, today } = f;
  if (today && dayKey(date) > dayKey(today)) return null; // a future-dated scheduled charge is not "processing" yet
  return { kind: 'payment_processing', text: `Your ${what} from ${dateText(date)} is still processing.` };
}
function failedPaymentSentence(f) {
  const { p, total, date, tender } = f;
  if (p?.superseded_by_payment_id != null) return null; // a retry collected it
  return { kind: 'payment_failed', text: `A ${money(total)}${tender ? ` ${tender}` : ''} payment attempt on ${dateText(date)} did not go through.` };
}
// disputed, requires_action, canceled, void, unknown, ...: no entry here - a person answers
const PAYMENT_STATUS_RENDERERS = new Map([
  ['paid', paidPaymentSentence],
  ['refunded', refundedPaymentSentence],
  ['pending', inFlightPaymentSentence],
  ['processing', inFlightPaymentSentence],
  ['failed', failedPaymentSentence],
]);

function paymentSentence(p, today) {
  const status = String(p?.status || '').toLowerCase();
  const total = finiteCents(p?.amount);
  const date = dateParts(p?.payment_date || p?.date);
  if (total == null || total === 0 || !date) return null;
  const tender = tenderWord(p);
  const what = `${money(total)}${tender ? ` ${tender}` : ''} payment`;
  const refundStatus = String(p?.refund_status || '').toLowerCase();
  const refunded = finiteCents(p?.refund_amount) || 0;
  const render = PAYMENT_STATUS_RENDERERS.get(status);
  return render ? render({ p, total, date, tender, what, refundStatus, refunded, today }) : null;
}

// Invoice statuses that state the total: { kind, verb } -> `Invoice N for $T <verb>.` (null when the total is zero / unreadable).
const INVOICE_TOTAL_SENTENCES = new Map([
  ['paid', { kind: 'invoice_paid', verb: 'is paid' }],
  ['prepaid', { kind: 'invoice_paid', verb: 'is paid' }],
  ['refunded', { kind: 'invoice_refunded', verb: 'was refunded' }],
  ['processing', { kind: 'invoice_processing', verb: 'is still processing' }],
]);
function invoiceDueSentence(inv, number, status, due, onPlan) {
  // partially_paid renders NOTHING: its paid portions live in payments, not in the invoice row (matches the balance path's UNCOUNTED treatment)
  if (onPlan || !['sent', 'viewed', 'overdue'].includes(status) || !due) return null;
  const by = dateParts(inv?.dueDate);
  return { kind: 'invoice_due', text: `Invoice ${number} has ${money(due)} due${by ? ` by ${dateText(by)}` : ''}.` };
}
function invoiceSentence(inv, { onPlan = false } = {}) {
  const number = String(inv?.invoiceNumber || '');
  if (!new RegExp(`^${INVOICE}$`).test(number)) return null;
  const status = String(inv?.status || '').toLowerCase();
  const total = finiteCents(inv?.total);
  const due = finiteCents(inv?.amountDue);
  const stated = INVOICE_TOTAL_SENTENCES.get(status);
  if (stated) return total ? { kind: stated.kind, text: `Invoice ${number} for ${money(total)} ${stated.verb}.` } : null;
  return invoiceDueSentence(inv, number, status, due, onPlan);
}

/**
 * [{ kind, text }] - every status sentence the customer's records fully support. Billing unreadable (unavailable, ownership
 * unverifiable) renders NOTHING. `today` (a {year,month,day}) only gates future-dated pending rows.
 */
function renderPaymentStatusSentences(context, { today = null } = {}) {
  const billing = context?.billing;
  if (!billingIsReadable(billing)) return [];
  const todayParts = (typeof today === 'string' ? dateParts(today) : today) || dateParts(require('../utils/datetime-et').etDateString());
  const onPlan = onActivePaymentPlan(billing);
  const allRows = (Array.isArray(billing.recentPayments) ? billing.recentPayments : []).filter(Boolean);
  const rows = allRows.filter(isReceiptRow);
  const out = [
    ...balanceSentences(billing, onPlan),
    ...(Array.isArray(billing.invoiceStatuses) ? billing.invoiceStatuses : []).map((inv) => invoiceSentence(inv, { onPlan })).filter(Boolean),
    ...paymentRowSentences(billing, rows, todayParts),
  ];
  // money the sentences do not describe (a non-receipt row, an own invoice the renderer cannot model) may carry payments this window
  // does not show: no absence sentence either
  // money the payments table never holds (an estimate deposit has no payments row) makes an absence claim unknowable unless the
  // deposit ledger was read and is empty (local review P1)
  const depositUnknown = billing.hasDepositActivity !== false;
  const absence = (hasUnmodeledInvoice(billing) || allRows.length !== rows.length || depositUnknown || !everyRowRenders(billing, rows, todayParts))
    ? null : absenceSentence(billing, rows, todayParts);
  return [...out, ...(absence ? [absence] : []), ...duesSentences(context), ...zelleSentences(billing.zelleFacts)];
}

// The monthly plan price, and the card charge only when the lane resolved it exactly (context.customer.billingLane, the same facts the
// dues line and authorizedDuesCents read). Any other dues state renders no charge figure.
function duesSentences(context) {
  const lane = context?.customer?.billingLane;
  const dues = lane?.monthlyBilled ? lane.monthlyDues : null;
  const base = finiteCents(dues?.base);
  if (!base) return [];
  const out = [{ kind: 'dues_monthly', text: `Your monthly plan price is ${money(base)}.` }];
  const total = finiteCents(dues.total);
  const fee = finiteCents(dues.surcharge);
  if (dues.surcharged && total && fee) {
    out.push({ kind: 'dues_card_charge', text: `When your dues are charged to the credit card on file, the monthly charge is ${money(total)}: ${money(base)} dues plus a ${money(fee)} credit-card fee.` });
  }
  return out;
}

// Zelle, per the target invoice the caller resolved and checked live (zelleFacts = { state, invoiceNumber, recipient }):
//   offer               - the invoice is Zelle-eligible right now and a recipient is configured
//   invoice_unavailable - the invoice is CONFIRMED not Zelle-eligible (never for an unverifiable state)
//   not_offered         - no Zelle recipient is configured at all
// Anything else (no target, several open invoices, an unverifiable state) renders nothing, so Zelle cannot be mentioned at all.
function zelleSentences(zelleFacts) {
  const f = zelleFacts || {};
  const number = String(f.invoiceNumber || '');
  const numberOk = new RegExp(`^${INVOICE}$`).test(number);
  const recipient = String(f.recipient || '').trim();
  if (f.state === 'offer' && numberOk && /^[^,\n]{3,80}$/.test(recipient)) {
    return [{ kind: 'zelle_offer', text: `You can pay invoice ${number} by Zelle to ${recipient}, with your name or the invoice number in the Zelle memo.` }];
  }
  if (f.state === 'invoice_unavailable' && numberOk) return [{ kind: 'zelle_invoice_unavailable', text: `Zelle isn't available for invoice ${number} right now.` }];
  if (f.state === 'not_offered') return [{ kind: 'zelle_not_offered', text: "We don't take Zelle right now." }];
  return [];
}

function balanceSentences(billing, onPlan) {
  if (onPlan) return [];
  const owed = finiteCents(billing.outstandingBalance);
  // a cut invoice history (or an own invoice the renderer cannot model) may hide more owed: no balance figure either (Codex round-54 P2)
  if (owed > 0 && billing.hasUncountedPartialDue !== true && !hasUnmodeledInvoice(billing)) return [{ kind: 'balance', text: `Your account balance is ${money(owed)}.` }];
  if (owed === 0 && !hasOutstandingObligation(billing)) return [{ kind: 'no_balance', text: 'Your account has no balance due.' }];
  return [];
}

// Two rows with the same amount and day but a different status are ONE ambiguous payment: neither is stated.
// Codex round-48 P1: the window is cut at 3 rows, so the twin can sit just past it. Rows come newest first, so a twin shares a
// VISIBLE day: the aggregator ships those same-day rows past the window (recentPaymentsLookahead) and the ambiguity is judged
// over both. When the window is cut and that lookahead is not known complete, the oldest visible day states nothing.
function paymentRowSentences(billing, rows, todayParts) {
  const identityOf = (p) => { const d = dateParts(p.payment_date || p.date); return d ? `${finiteCents(p.amount)}|${dayKey(d)}` : null; };
  const lookahead = (Array.isArray(billing.recentPaymentsLookahead) ? billing.recentPaymentsLookahead : []).filter(Boolean).filter(isReceiptRow);
  const statuses = new Map();
  for (const p of [...rows, ...lookahead]) statuses.set(identityOf(p), new Set([...(statuses.get(identityOf(p)) || []), String(p.status || '').toLowerCase()]));
  const days = rows.map(paymentDayKey).filter((k) => k != null);
  const unknownDay = billing.recentPaymentsTruncated === true && billing.recentPaymentsLookaheadComplete !== true && days.length
    ? Math.min(...days) : null;
  return rows
    .filter((p) => statuses.get(identityOf(p)).size === 1 && (unknownDay == null || paymentDayKey(p) !== unknownDay))
    .map((p) => paymentSentence(p, todayParts))
    .filter(Boolean);
}
// Every retained row states its own status (none dropped as ambiguous, on an unknown boundary day, or in an unmodeled status such as
// disputed) - only then can the window say what is ABSENT (Codex round-58 P2).
const everyRowRenders = (billing, rows, todayParts) => paymentRowSentences(billing, rows, todayParts).length === rows.length;

// The newest row is always inside the window (newest first): nothing is dated after it. No rows at all is only "none" when the
// window cannot be hiding more and no money is in flight. Codex round-46 P2: a future-dated row (a scheduled charge) would put the
// cutoff in the future - no absence sentence at all.
function absenceSentence(billing, rows, todayParts) {
  const days = rows.map((p) => dateParts(p.payment_date || p.date));
  if (todayParts && days.some((d) => d && dayKey(d) > dayKey(todayParts))) return null;
  if (rows.length && days.every(Boolean)) {
    const newest = days.reduce((a, b) => (dayKey(b) > dayKey(a) ? b : a));
    return { kind: 'no_payment_since', text: `We don't see a payment on your account since ${dateText(newest)}.` };
  }
  if (!rows.length && billing.recentPaymentsTruncated !== true && billing.hasProcessingPayment === false) {
    return { kind: 'no_payments', text: "We don't see any payments on your account." };
  }
  return null;
}

/** The BILLING-section lines for these sentences (always at least one line, so the contract is visible gate-on). */
function renderPaymentStatusLines(sentences) {
  return sentences.length ? [SECTION_HEADER, ...sentences.map((s) => `${SENTENCE_BULLET}${s.text}`)] : [SECTION_NONE];
}

/** The rendered sentences of a facts block (BILLING section only, exact shapes only; [] when absent). */
function sentencesFromFactsBlock(factsBlock) {
  const facts = String(factsBlock || '');
  const start = facts.indexOf('\nBILLING:\n');
  if (start < 0) return [];
  const rest = facts.slice(start + '\nBILLING:\n'.length);
  const end = rest.indexOf('\nPENDING ESTIMATE:');
  const lines = (end < 0 ? rest : rest.slice(0, end)).split('\n');
  const from = lines.indexOf(SECTION_HEADER);
  if (from < 0) return [];
  const out = [];
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith(SENTENCE_BULLET)) break;
    const text = line.slice(SENTENCE_BULLET.length);
    const kind = kindOf(text);
    if (kind) out.push({ kind, text });
  }
  return out;
}

// ---- Copying ---------------------------------------------------------------
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Typography folded so a reply can neither dodge nor forge a verbatim match with it.
function canonText(text) {
  return String(text ?? '').normalize('NFKC')
    .replace(/[‘’‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// A copy is COMPLETE (the whole sentence incl. its period, on a word boundary), STANDS ALONE (starts the text, follows a sentence
// end or a plain "Hi Jane," greeting - never a colon or other lead-in) and is not reopened by a modifier ("... Or sooner.") or
// framed by meta/negation talk in the sentences beside it ("Ignore this.", "That is outdated.").
const MODIFIER_FRAGMENT_RE = /^(?:or|unless|at\s+(?:the\s+)?(?:most|least|latest|earliest)|max|maybe|perhaps|roughly|approx\w*|give\s+or\s+take|sooner|earlier|though|but|however|usually|typically|sometimes|depending|weather)\b/i;
const META_FRAME_RE = /\b(?:false|untrue|not\s+(?:true|correct|accurate|right|apply|valid)|isn'?t\s+(?:true|correct|accurate|right)|ignore|disregard|do(?:n'?t|\s+not)\s+follow|does(?:n'?t|\s+not)\s+apply|outdated|out\s+of\s+date|old\s+info|wrong|incorrect|kidding|joking|not\s+anymore|no\s+longer|actually|scratch\s+that|correction|used\s+to|mistake|never\s*mind|forget\s+(?:that|this|it)|however|but|although|except|unless)\b/i;
const OWN_SENTENCE_START_RE = /(?:^|[.!?]|\s;)\s*$|(?:^|[.!?]\s*)(?:hi|hello|hey|thanks|thank\s+you)\b[^.!?:;]{0,30},\s*$/i;
const SENTENCE_GAP_RE = /(?<=[.!?])\s+/;
function copyRanges(canon, sentence) {
  const out = [];
  for (const m of canon.matchAll(new RegExp(escapeRegex(canonText(sentence)), 'gi'))) {
    const end = m.index + m[0].length;
    const before = canon.slice(0, m.index);
    const after = canon.slice(end);
    if (m.index > 0 && /[\p{L}\p{N}]/u.test(canon[m.index - 1])) continue;
    if (!(after === '' || (/^\s+(?![a-z])/.test(after) && !MODIFIER_FRAGMENT_RE.test(after.trim())))) continue;
    if (!OWN_SENTENCE_START_RE.test(before)) continue;
    const near = [...before.split(SENTENCE_GAP_RE).slice(-2), ...after.split(SENTENCE_GAP_RE).slice(0, 2)];
    if (near.some((s) => META_FRAME_RE.test(s))) continue;
    out.push({ start: m.index, end });
  }
  return out;
}
const copiesSentence = (text, sentence) => copyRanges(canonText(text), sentence).length > 0;
/** The sentences (texts) of `candidates` that `text` copies completely and verbatim. */
const copiedSentences = (text, candidates) => (candidates || []).filter((s) => typeof s === 'string' && copiesSentence(text, s));
/** `text` (canonical form) with each complete copy of one of `candidates` replaced by a clause break. */
function withoutCopies(text, candidates) {
  let out = canonText(text);
  if (String(text ?? '').length > MAX_REPLY_CHARS) return out;
  for (const s of candidates || []) {
    if (typeof s !== 'string') continue;
    for (const { start, end } of copyRanges(out, s).reverse()) out = `${out.slice(0, start)} ; ${out.slice(end)}`;
  }
  return out;
}

// ---- Detecting -------------------------------------------------------------
// A reply is PAYMENT-SCOPED when it (or the customer's message) is about money. Only a scoped reply is judged: "We received your
// photos" in a scheduling thread is not a payment status.
const TOPIC_RE = /\b(?:payments?|pay(?:s|ing)?|paid|unpaid|invoices?|bills?|billed|billing|balance|charg\w*|refund\w*|funds?|money|transactions?|deposit\w*|transfers?|zelle\w*|ach|venmo|paypal|cash|che(?:ck|que)s?|cards?|autopay|auto-pay|credits?|owe[sd]?|owing|due|overdue|dues|statements?|receipts?|accounts?)\b/i;
// Every word a payment / invoice / refund / balance STATUS can be said with, deliberately wide: one more synonym is one more
// alternative here, never a new checker.
const PAYMENT_NOUN = '(?:payments?(?!\\s+(?:links?|page|portal|options?|methods?|instructions?|plan|reminders?))|funds|money|transfers?|deposits?|transactions?|refunds?|invoices?|bills?)';
// Codex round-61 P2: "accepted" is a status ("your payment was accepted") but NOT when a payment METHOD is its subject ("Checks are
// accepted", "Credit cards and bank accounts are accepted") - that is a pay-method answer.
const ACCEPTED_STATUS = "(?<!\\b(?:cards?|checks?|cheques?|cash|ach|bank\\s+accounts?|bank\\s+transfers?|apple\\s+pay|google\\s+pay|venmo|paypal|e-?checks?|methods?|forms?\\s+of\\s+payment)\\s+(?:are|is)\\s+(?:also\\s+|all\\s+|gladly\\s+)?)accepted";
const STATUS_ALTERNATIVES = [
  '(?:un|over|under|pre|re)?paid', 'received', 'receipts?', 'process\\w*', 'pending', 'post(?:ed|s|ing)?', 'clear(?:ed|s|ing)?', 'arriv\\w*', 'appear\\w*',
  'settle[sd]?', 'settling', 'settlement', 'completed?', 'successful(?:ly)?', 'approved', ACCEPTED_STATUS, 'declined', 'denied', 'rejected',
  'fail(?:ed|s|ure)?', 'bounced?', 'returned', 'revers\\w*', 'refund\\w*', 'credit(?:s|ed)?(?!\\s+cards?)', 'debit(?:s|ed)?(?!\\s+cards?)', 'charged', 'charges', 'deducted',
  'withdrawn', 'collected', 'captured', 'applied', 'land(?:ed|s)?', 'cashed', 'deposited', 'submitted',
  '(?:went|go(?:es)?|gone|going|came|come(?:s)?|coming) (?:through|thru|in)', 'made it', 'hit your',
  'owe[sd]?', 'owing', 'due', 'overdue', 'outstanding', 'balance', 'delinquent', 'arrears', 'late fees?', 'past due',
  'all set', 'all good', 'squared(?: away| up)?', 'taken care of', 'good to go', 'up to date', 'caught up', 'current', 'in good standing',
  'nothing (?:more |else |further )?(?:owed|due|to pay|needed)', 'no (?:balance|charges?|payments?|record)', 'zero',
  // (Codex round-53/56 P2: a tender SUBJECT - cash, check, Zelle, ACH, ... - in a state - "Your cash is here", "The check came in", "that check cleared")
  '(?:your|the|that|this)\\s+(?:cash|che(?:ck|que)s?|zelle|ach|venmo|paypal|wire|bank\\s+transfer|e-?check)\\b(?:\\s+[\\w$.,-]+){0,2}?\\s+(?:is|was|were|are|has|have|came|arrived|got|went|cleared|bounced|posted|landed|showed)\\b',
  // (Codex round-52 P2: cash, and a received / collected / picked-up cash or check, are receipts too)
  '(?:have|has|had|got|gotten|received|collected|picked up)\\s+(?:your|the)\\s+(?:payments?|funds|money|transfer|deposit|che(?:ck|que)s?|zelle|ach|cash)', '(?:got|have|has)\\s+(?:it|that|this|them)',
  // (Codex round-58 P2: a receipt verb aimed at a pronoun - "We banked it", "we processed that", "it's been deposited")
  '(?:banked|deposited|cashed|processed|posted|applied|recorded|logged|collected|received|ran|run|cleared|settled)\\s+(?:it|that|this|them|(?:your|the|that|this)\\s+(?:cash|che(?:ck|que)s?|zelle|ach|venmo|paypal|wire|e-?check|money|funds))\\b',
  "(?:it|that|this|they)(?:'s|’s|\\s+(?:is|was|were|are|has|have))\\s+(?:been\\s+)?(?:banked|deposited|cashed|processed|posted|applied|recorded|logged|collected|received|cleared|settled)\\b",
  "(?:don'?t|do not|can'?t|cannot|haven'?t|have not|hasn'?t|has not|didn'?t|did not|not)\\s+(?:\\w+\\s+){0,2}?(?:see|seen|find|found|show|showing|reflect\\w*|there)",
  'no record', 'missing', 'showing', 'shows?', 'reflect(?:ed|s|ing)?', 'recorded', 'logged', 'visible',
  'sorted', 'handled', 'resolved', 'dealt with', 'wrapped up', 'in the clear', 'all done', 'covered',
  // a verb of having / seeing aimed at a payment noun a few words later ("we got your $120.00 card payment", "I see the transfer");
  // "payment link / page / options" is how-to-pay vocabulary, not a payment
  `(?:got|gotten|have|has|had|see|saw|seen|find|found|take|took|taken|show|shows)\\b(?:\\s+\\S+){0,6}?\\s+${PAYMENT_NOUN}`,
  // a payment noun as the SUBJECT of a clause ("your payment is on its way", "the transfer will post", "invoice 1234 looks right")
  `${PAYMENT_NOUN}\\b(?:\\s+[#\\w-]+){0,2}?\\s+(?:is|are|was|were|has|have|had|will|would|did|didn't|hasn't|haven't|isn't|wasn't|went|came|got|looks?|appears?|seems?|shows?|should|must)\\b(?!\\s+(?:attached|enclosed|ready|below|above|linked|included|available|here|coming|on\\s+its\\s+way))`,
  // a negation aimed at a payment noun ("we don't a payment", "no payment yet", "haven't gotten the transfer")
  `(?:don'?t|do not|didn'?t|did not|haven'?t|have not|hasn'?t|has not|can'?t|cannot|won'?t|no|not|never|nothing)\\b(?:\\s+\\S+){0,4}?\\s+${PAYMENT_NOUN}`,
  // a card / wallet that "didn't work" is a failure said without any failure word ("your card on file didn't work", "Apple Pay isn't working")
  "(?:cards?|wallets?|apple pay|google pay)\\b(?:\\s+[\\w#-]+){0,3}?\\s+(?:didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|not)\\s+work(?:ed|ing)?",
  // "you're good", "it's fine", "everything is set", "that looks sorted", "the invoice is done" - a completion word said of the account
  "(?:you|it|they|everything|that|this|things|account|invoice|payment)(?:'s|'re|'ve|\\s+(?:is|are|was|were|has|have|been|looks?|seems?))?\\s+(?:all\\s+)?(?:good|fine|ok|okay|set|clear|cleared|done|fixed|complete|completed|finished)",
  // A receipt said with pronouns only ("I see it on our end", "it came in Tuesday", "it's in our system", "it's here", "it's on your
  // account now", "your Zelle came in", "and the one from Sep 30 too"): no payment noun for the patterns above to key on.
  "(?:i|we|you|they)\\s+(?:do\\s+|did\\s+|can\\s+|just\\s+|now\\s+)?(?:see|saw|seen|spot(?:ted)?|find|found|got|gotten|have|has|had|receive[ds]?)\\s+(?:it|that|this|them|mine|yours|one|those|these)",
  '(?:on|in)\\s+(?:our|your|the)\\s+(?:end|system|records?|account|books|file|portal)',
  "(?:it|that|this)(?:'s|\\s+is|\\s+was)\\s+(?:here|there|in|on)",
  '(?:zelle|ach|che(?:ck|que)|transfer|deposit|wire|venmo|paypal|payments?)\\w*\\s+(?:came|come|comes|got|arrived|landed|hit|posted|cleared|went)',
  '(?:the|that|this|another|other|your)\\s+(?:(?:other|earlier|previous|first|second|last|older|newer)\\s+)?ones?',
];
const STATUS_WORDS_RE = new RegExp(`\\b(?:${STATUS_ALTERNATIVES.join('|')})\\b`, 'i');
const STATUS_RE = new RegExp(`${STATUS_WORDS_RE.source}|\\$\\s?0(?:\\.0+)?(?![\\d.,])`, 'i');
// Punctuation read as a space: the same alternatives, matched where the text glues a word to punctuation ("see,payment").
const PUNCT_RE = /[^\w\s$'’]+/g;
const statusHit = (sentence) => STATUS_RE.test(sentence) || STATUS_WORDS_RE.test(sentence.replace(PUNCT_RE, ' '));
// Belt and braces: a sentence that still NAMES a payment thing after the how-to-pay vocabulary is taken out is not a pay-method
// answer, and whatever it says about that thing is held - so a status said in words no list knows ("we banked it", "your
// payment is in the books") cannot pass just because it avoided the status words above.
const PAYMENT_THING_RE = /\b(?:payments?|invoices?|bills?|refunds?|transfers?|deposits?|charges?|funds|money|transactions?|balance|receipts?|statements?)\b/i;
const HOW_TO_PAY_RE = new RegExp([
  '\\bpay(?:ment)?\\s+(?:links?|page|portal|online|options?|methods?|instructions?)\\b',
  '\\b(?:invoice|bill)\\s+(?:number|link|page|portal|copy|pdf)\\b',
  '\\bpay(?:ing)?\\s+(?:for\\s+)?(?:your|the|this|that|an?|it)\\s+(?:\\$[\\d,.]+\\s+)?(?:invoice|bill|balance)\\b',
  '\\b(?:make|submit|send)\\s+(?:a\\s+)?payment\\b',
  '\\b(?:check|confirm|look(?:ing)?\\s+into|verify|review|follow\\s+up)\\s+(?:on\\s+|with\\s+|about\\s+)?(?:your|the|that|this)\\s+(?:payment|invoice|balance|refund|account|charge|bill|transfer)\\b',
  '\\b(?:your|the)\\s+(?:invoice|bill)\\s+(?:is\\s+|was\\s+)?(?:attached|enclosed|ready|below|above|linked|here)\\b',
  '\\bauto-?pay\\b(?:\\s+(?:is|are|will\\s+be|was)\\s+(?:not\\s+)?(?:on|off|active|paused|set|scheduled|enabled|disabled|running))?',
  '\\b(?:next|upcoming|scheduled)\\s+(?:auto-?pay\\s+)?(?:charge|payment)(?:\\s+date)?\\b',
  '\\b(?:the\\s+)?(?:invoice|bill)\\s+(?:number|#)\\s*[\\w-]+',
].join('|'), 'gi');
const INTERROGATIVE_START_RE = /^(?:and\s+|so\s+|also\s+)?(?:did|do|does|is|are|was|were|has|have|had|can|could|will|would|should|may|what|when|why|how|where|which|who)\b/i;
const GREETING_RE = /^(?:hi|hello|hey|thanks|thank\s+you)\b[^,.!?]{0,30},\s*/i;
// (breaks carry no surrounding \s*: a whitespace run next to a bare `;` made the split quadratic; every consumer trims)
const CLAUSE_BREAK_RE = /(?<=[.!?])\s+|;/;

// A message that talks about a receipt without a payment noun ("did it go through?", "did you get it?", "yes, I see it on our end") is
// payment-scoped too: the customer's pronoun refers to the payment the thread is about.
const RECEIPT_SCOPE_RE = /\b(?:(?:went|go|goes|gone|going|came|come|comes|coming)\s+(?:through|thru)|came\s+in|made\s+it|(?:get|gotten|getting|receive[ds]?|receiving|see|saw|seen|spot(?:ted)?)\s+(?:it|that|this|them|mine|yours)|(?:on|in)\s+(?:our|your)\s+(?:end|system|records?|account|books))\b/i;
/** Is this one message about money (a payment word, or a pronoun-only receipt phrase)? A message too long to judge counts as yes. */
// Codex round-62 P2: the status vocabulary is English. Money words of the languages the drafter answers in (es / pt / fr) scope a
// message too, and inside a payment-scoped exchange a reply carrying them - or one the English rules cannot read at all
// (sms-label-facts.looksNonEnglish, the shared detector) - is held: it may confirm a payment in words no list knows.
const FOREIGN_MONEY_RE = /(?<![\p{L}])(?:pag(?:o|os|ar|ue|u[eé]|ó|amos|aron|ado|ada|amento|amentos|ou|uei)|paiements?|pay[ée]e?s?|factura|facturas|fatura|faturas|facture|factures|saldo|saldos|solde|dinero|dinheiro|argent|cobr(?:o|os|ar|amos|aron|ado|ada|anza|é|ó)|recib\p{L}*|receb\p{L}*|reçu|transferencia|transfer[eê]ncia|virement|tarjeta|cart[aã]o|carte|cuenta|conta|compte|deuda|d[ií]vida|dette|reembols\p{L}*|rembours\p{L}*)(?![\p{L}])/iu;
const notReadableEnglish = (text) => { try { return !!require('./sms-label-facts').looksNonEnglish(text); } catch { return true; } };
// "We still owe you a callback" (the VISIT STATUS & OPEN LOOPS facts, PR #5499) is a promise, not money. An ALLOW-list of non-money
// things owed is masked before the payment vocabulary is read; "we owe you a refund / credit / $20" stays payment status.
const NON_MONEY_OWE_RE = /\b(?:we|you|they)(?:'re|\s+are)?\s+(?:still\s+|also\s+|really\s+)?ow(?:e|ing)\s+(?:you|me|us)\s+(?:a|an|the|that|this|one|your|my|our)\s+(?:quick\s+|proper\s+|real\s+)?(?:call[\s-]?backs?|calls?|phone\s+calls?|answers?|repl(?:y|ies)|responses?|updates?|visits?|follow[\s-]?ups?|texts?|emails?|apolog(?:y|ies)|explanations?|quotes?|estimates?|confirmations?|check[\s-]?ins?)\b/gi;
const maskNonMoneyOwe = (text) => String(text ?? '').replace(NON_MONEY_OWE_RE, ' we will follow up ');
function isPaymentScopedText(text) {
  const t = String(text ?? '').replace(/[’‘]/g, "'");
  if (t.length > MAX_INBOUND_CHARS) return true;
  if (FOREIGN_MONEY_RE.test(t)) return true;
  const body = maskNonMoneyOwe(t.replace(GREETING_RE, '')); // "Hi Bill," is a name, not a bill
  return TOPIC_RE.test(body) || RECEIPT_SCOPE_RE.test(body);
}
const asTexts = (list) => (Array.isArray(list) ? list : []).filter((t) => t != null).map(String);
/**
 * Is a draft PAYMENT-SCOPED? Yes when the reply, the customer's message, any recent thread message the draft was written from
 * (`scopeTexts`), or an explicit `scoped` flag (the facts block put a status sentence in play, or the draft was already judged
 * scoped) touches money. A missing customer message is unknown, and unknown is scoped.
 */
function isPaymentScoped({ reply = '', inboundText = null, scopeTexts = [], scoped = false } = {}) {
  if (scoped === true || inboundText == null) return true;
  return [reply, inboundText, ...asTexts(scopeTexts)].some(isPaymentScopedText);
}

/**
 * Does `text` (a reply with the copied sentences already removed) assert any payment status? `inboundText` null = unknown
 * (judged as scoped). A question the reply asks the customer is not an assertion, unless it carries status / receipt content itself
 * ("Would you like a receipt for the payment we received Tuesday?").
 */
function assertsPaymentStatus(text, { inboundText = null, scopeTexts = [], scoped = false } = {}) {
  const raw = String(text ?? '').replace(/[’‘]/g, "'");
  if (raw.length > MAX_REPLY_CHARS) return true; // never truncated and passed
  const body = maskNonMoneyOwe(raw);
  const inbound = inboundText == null ? null : String(inboundText);
  if (!isPaymentScoped({ reply: body, inboundText: inbound, scopeTexts, scoped })) return false;
  if (body.trim() && (FOREIGN_MONEY_RE.test(body) || notReadableEnglish(body))) return true;
  return body.split(CLAUSE_BREAK_RE).some((raw) => {
    const sentence = raw.trim();
    if (!sentence) return false;
    const status = statusHit(sentence);
    if (/\?$/.test(sentence) && INTERROGATIVE_START_RE.test(sentence.replace(GREETING_RE, ''))) return status;
    return status || PAYMENT_THING_RE.test(sentence.replace(HOW_TO_PAY_RE, ' '));
  });
}

/**
 * The contract for one reply against the sentences it may copy: { ok, copied (texts), remainder }.
 * ok = after the complete verbatim copies are removed, nothing left asserts a payment status.
 */
// Codex round-59 P2: a copied sentence must ANSWER the record the customer named. When the inbound names an invoice (full number or
// tail), every copied invoice sentence must be about one of those invoices; when it names a dollar amount, every copied payment sentence
// must carry one of those amounts. A true sentence about a DIFFERENT record is off target (held), never an answer.
const INBOUND_AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const amountCentsOf = (raw) => Math.round(Number(String(raw).replace(/[^\d.]/g, '')) * 100);
// Codex round-66 P2: the customer's own figure also comes as "100 dollars" / "50 bucks" / "75 USD" (the money detector's forms)
const INBOUND_NAMED_AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?(?=\s*(?:dollars?|bucks|usd)\b)/gi;
// Codex round-69 P2: every brand in the shared table (services/card-brands.js), plus funding types
const CARD_SUBTYPE_RE = new RegExp(`\\b(?:${require('./card-brands').CARD_BRAND_WORD_ALT}|debit|credit\\s+card|prepaid\\s+card)\\b`, 'i');
const INBOUND_TENDER_RES = [
  ['card', /\b(?:card|credit|debit|visa|mastercard|amex|discover|apple\s*pay|google\s*pay)\b/i],
  // (Codex round-69 P2: "just checking if ..." is no tender - only a checking ACCOUNT is)
  ['ach', /\b(?:ach|bank(?:\s+(?:account|transfer|draft))?|e-?check|checking\s+account)\b/i],
  ['zelle', /\bzelle\b/i],
  ['cash', /\bcash\b/i],
  ['check', /\b(?:paper\s+)?che(?:ck|que)s?\b(?!\s+(?:on|in|with|if|whether|that|to\s+see))/i],
];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const INBOUND_NAMED_DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
const INBOUND_NUMERIC_DATE_RE = /(?<![\d/$.])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g;
// Codex round-63 P2: RELATIVE days the customer named resolve against the Eastern calendar ("yesterday's payment", "the one I
// sent Monday", "3 days ago"). A weekday is its most recent occurrence (today included).
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RELATIVE_DAY_RES = [
  [/\b(?:the\s+)?day\s+before\s+yesterday\b/i, () => 2],
  [/\b(?:yesterday|yday|last\s+night)\b/i, () => 1],
  [/\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/i, () => 0],
  [/\b(\d{1,2}|one|two|three|four|five|six)\s+days?\s+ago\b/i, (m) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[m[1].toLowerCase()] ?? Number(m[1]))],
];
const WEEKDAY_RE = /\b(sun|mon|tues|wednes|thurs|fri|satur)day\b/gi;
function relativeDates(text, today) {
  const t = String(text || '');
  const base = Date.UTC(today.year, today.month - 1, today.day);
  const at = (back) => { const d = new Date(base - back * 86400000); return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), year: d.getUTCFullYear() }; };
  const out = [];
  let rest = t;
  for (const [re, back] of RELATIVE_DAY_RES) {
    const m = re.exec(rest);
    if (m) { out.push(at(back(m))); rest = rest.replace(re, ' '); }
  }
  const dow = new Date(base).getUTCDay();
  for (const m of rest.matchAll(WEEKDAY_RE)) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (idx >= 0) out.push(at((dow - idx + 7) % 7));
  }
  return out;
}
// The calendar dates an inbound names ({month, day, year|null}): a month name, an m/d[/yy] form, or a relative day.
function inboundDates(text, today = null) {
  const out = today ? relativeDates(text, today) : [];
  for (const m of String(text || '').matchAll(INBOUND_NAMED_DATE_RE)) {
    const month = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const day = Number(m[2]);
    if (month && day >= 1 && day <= 31) out.push({ month, day, year: m[3] ? Number(m[3]) : null });
  }
  for (const m of String(text || '').matchAll(INBOUND_NUMERIC_DATE_RE)) {
    const month = Number(m[1]); const day = Number(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.push({ month, day, year });
  }
  return out;
}
// the {month, day, year} a rendered payment sentence is dated, or null
function sentenceDate(t) {
  const m = new RegExp(`(${SHORT_MONTHS.join('|')}) (\\d{1,2}), (\\d{4})`).exec(t);
  return m ? { month: SHORT_MONTHS.indexOf(m[1]) + 1, day: Number(m[2]), year: Number(m[3]) } : null;
}
// the tender a rendered payment sentence names ('card' / 'ach'), or null when it names none
const sentenceTender = (t) => (/ card payment\b/.test(t) ? 'card' : / ACH payment\b/.test(t) ? 'ach' : null);
function copiesOffTarget(copied, inboundText, { today = null } = {}) {
  const inbound = String(inboundText || '');
  if (!inbound || !copied.length) return false;
  const { invoiceNumbersNamed } = require('./zelle-target-invoice');
  const named = invoiceNumbersNamed(inbound);
  const stripZeros = (v) => String(v).replace(/^0+/, '') || '0';
  // Codex round-66 P2: a FULL reference (WPC-2025-0001) matches only that number - tails repeat across years; a tail matches shorthand only
  const namedTails = new Set(named.tail.map(stripZeros));
  const amounts = new Set((inbound.match(INBOUND_NAMED_AMOUNT_RE) || []).map(amountCentsOf));
  // Codex round-60 P2: a payment method the customer named. A rendered payment sentence names a tender only when the row proves it (card
  // / ACH from Stripe columns; a manual tender - Zelle, cash, check - is never named), so a copied payment sentence answers a tender
  // question only when it names THAT tender: a Zelle / cash / check question is never answered by a copied receipt.
  const namedTenders = INBOUND_TENDER_RES.filter(([, re]) => re.test(inbound)).map(([tender]) => tender);
  // Codex round-67 P2: a card BRAND or funding type the customer named (Visa, debit ...) is narrower than any rendered sentence (which
  // says "card" at most) - so no copied receipt is proven to be that payment
  if (CARD_SUBTYPE_RE.test(inbound)) namedTenders.push('card_subtype');
  // Codex round-62 P2: a payment DATE the customer named ("the payment I sent on Sep 1", "9/1") - a copied payment sentence must be
  // dated that day (month + day; the year too when the customer gave one)
  const todayParts = (typeof today === 'string' ? dateParts(today) : today) || dateParts(require('../utils/datetime-et').etDateString());
  const namedDates = inboundDates(inbound, todayParts);
  const invoiceNamed = named.full.length > 0 || named.tail.length > 0;
  return copied.some((sentence) => {
    const t = String(sentence);
    const inv = /\binvoice\s+([A-Za-z0-9][A-Za-z0-9-]{0,29})\b/i.exec(t);
    if (inv && invoiceNamed) return !(named.full.includes(inv[1].toUpperCase()) || namedTails.has(stripZeros(inv[1].toUpperCase().split('-').pop())));
    // Codex round-65 P2: no invoice named - an invoice sentence must match the amount / date / tender the customer did name, like a receipt
    // (status lines only - "Invoice N for $T is paid." / "Invoice N has $D due..."; a Zelle offer names the tender it is about)
    if (inv) return /^Invoice\s/.test(t) && attributesOffTarget(t, { namedDates, namedTenders, amounts });
    return /\bpayment\b/i.test(t) && (invoiceNamed || attributesOffTarget(t, { namedDates, namedTenders, amounts }));
  });
}
// A copied sentence against the payment attributes the customer named: its date, its tender (an invoice sentence names none, so a named
// tender never matches one), its amount. (Codex round-64 P2: a receipt that names no invoice never answers a NAMED invoice - above.)
function attributesOffTarget(t, { namedDates, namedTenders, amounts }) {
  if (namedDates.length) {
    const d = sentenceDate(t);
    if (!d || !namedDates.some((n) => n.month === d.month && n.day === d.day && (n.year == null || n.year === d.year))) return true;
  }
  if (namedTenders.includes('card_subtype')) return true;
  if (namedTenders.length && !namedTenders.some((tender) => sentenceTender(t) === tender)) return true;
  // Codex round-69 P2: a payment sentence is matched on its PRIMARY figure (the payment), never a refund figure that follows it
  const figures = (t.match(INBOUND_AMOUNT_RE) || []).map(amountCentsOf);
  const candidates = sentenceFamily(t) === 'payment' ? figures.slice(0, 1) : figures;
  return amounts.size > 0 && !candidates.some((c) => amounts.has(c));
}

// MONEY CONTENT (owner 2026-10-01 ~23:58Z): once the verbatim copies are removed, an unedited AI reply carries no dollar figure, no price
// grammar ("fifty dollars", "45/mo") and no mention of Zelle - whatever the wording, in any scope. (An unparseable check fails closed.)
const MONEY_FIGURE_RE = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|bucks|usd)\b/i;
const ZELLE_WORD_RE = /\bzelle\b/i;
function remainderHasMoney(remainder) {
  const text = String(remainder ?? '');
  if (MONEY_FIGURE_RE.test(text) || ZELLE_WORD_RE.test(text)) return true;
  try { return !!require('./sms-suggest-mode').hasPriceQuote(text); } catch { return true; }
}

function checkPaymentStatusReply({ reply, sentences, inboundText = null, scopeTexts = [], scoped = false }) {
  const texts = (sentences || []).map((s) => (typeof s === 'string' ? s : s.text));
  const text = String(reply ?? '');
  if (text.length > MAX_REPLY_CHARS) return { ok: false, copied: [], remainder: canonText(text) };
  const copied = copiedSentences(text, texts);
  const remainder = withoutCopies(text, copied);
  const ok = !copiesOffTarget(copied, inboundText) && !remainderHasMoney(remainder) && !assertsPaymentStatus(remainder, { inboundText, scopeTexts, scoped });
  return { ok, copied, remainder };
}

// ---- Auto-send: a payment-scoped reply may carry nothing but verbatim copies and inert text ---------------------------------------
// The detector above is a net; it misses a status said in words nobody listed (it missed pronoun-only receipts for 44 rounds). So
// the autonomous rung does not rely on it: a payment-scoped v12 reply may AUTO-send only when, once its verbatim copies are
// removed, every clause left is on this tiny allowlist (a greeting, thanks, "let us know if you have questions"). Anything else goes
// to Agent Review, where a person reads it.
const INERT_CLAUSE_RES = [
  /^(?:hi|hello|hey)(?: [a-z][a-z'.-]*){0,2}$/,
  /^(?:thanks|thank you)(?: so much| very much| again)?(?: for (?:reaching out|your message|texting us|texting|getting in touch|letting us know|your patience))?$/,
  /^(?:(?:please )?(?:let us know|reach out|text us|call us)|(?:feel free|don't hesitate) to (?:reach out|text us|call us|let us know))(?: anytime)?(?: if (?:you (?:have|need) (?:any |more |other )?(?:questions?|anything(?: else)?)|there's anything else|anything else comes up))?$/,
  /^have a (?:great|good|wonderful|nice) (?:day|week|one|afternoon|evening|weekend)$/,
];
const INERT_CLAUSE_BREAK_RE = /(?<=[.!?])\s+|[;,\u2014\u2013]|(?<=\s)-(?=\s)/;
function isInertClause(raw) {
  const clause = raw.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clause) return true;
  if (statusHit(clause) || RECEIPT_SCOPE_RE.test(clause)) return false;
  if (INERT_CLAUSE_RES[0].test(clause)) return true; // a greeting may carry a name that is also a payment word ("Bill")
  if (TOPIC_RE.test(clause)) return false;
  return INERT_CLAUSE_RES.some((re) => re.test(clause));
}
/** Is `remainder` (a reply with its verbatim copies removed) only inert text? */
function remainderIsInert(remainder) {
  const text = canonText(remainder);
  if (text.length > MAX_REPLY_CHARS) return false;
  return text.split(INERT_CLAUSE_BREAK_RE).every(isInertClause);
}
/**
 * null when `reply` may auto-send; 'payment_status_not_auto_sendable' when it is payment-scoped and says anything beyond verbatim
 * copies of `snapshot.sentences` and inert text. A reply that is not payment-scoped is not this check's business.
 */
// The reply with every verbatim copy of a snapshotted rendered sentence removed (Codex round-72 P2): a copied receipt / invoice / Zelle
// line carries a record's own figure, so the auto-send price-quote rung reads only what the model wrote itself. The copies are gated by
// autoSendScopeBlock below and re-rendered at dispatch.
// Codex round-74 P2: ONLY the receipt / invoice-status families (the case the owner's hold-when-ambiguous ruling opened, gated by the
// family count + generic-question allow-list in autoSendScopeBlock); a balance, plan-price or Zelle line with a figure stays a quote.
function withoutSnapshotCopies(reply, snapshot) {
  const text = String(reply ?? '');
  return withoutCopies(text, copiedSentences(text, asTexts(snapshot?.sentences)).filter((t) => sentenceFamily(t) != null));
}
function autoSendScopeBlock({ reply, inboundText = null, snapshot = null }) {
  const sentences = asTexts(snapshot?.sentences);
  const scoped = isPaymentScoped({ reply, inboundText, scoped: snapshot?.scoped === true || sentences.length > 0 });
  if (!scoped) return null;
  const copied = copiedSentences(reply, sentences);
  if (copiesAmbiguousFamily(copied, snapshot) || copiesAnswerNamedSpecifics(copied, inboundText)) return 'payment_status_ambiguous';
  return remainderIsInert(withoutCopies(reply, copied)) ? null : 'payment_status_not_auto_sendable';
}
// HOLD WHEN AMBIGUOUS (owner 2026-10-02, after round 66): code does not guess which record the customer means. A copied receipt or invoice
// status line auto-sends only when the draft rendered exactly ONE line of that family; with 2+ candidates (or a snapshot that never
// counted them) the draft goes to Agent Review and a person picks. copiesOffTarget stays a filter, not the gate.
// (Codex round-67 P2: an absence summary - "We don't see a payment ..." - is no record, so it is no candidate)
const sentenceFamily = (t) => (/^Invoice\s/.test(t) ? 'invoice'
  : /\bpayment\b/i.test(t) && !/\binvoice\b/i.test(t) && !/^We don't see\b/.test(t) ? 'payment' : null);
function familyCounts(texts) {
  const counts = {};
  for (const t of texts) { const f = sentenceFamily(String(t)); if (f) counts[f] = (counts[f] || 0) + 1; }
  return counts;
}
// The same ruling applied to a customer who NAMES which payment they mean (an invoice number, an amount, a date, a tender or card brand):
// matching that to a record is the guess the ruling stops making, so a copied receipt / invoice / balance line auto-sends only for a
// generic question ("did my payment go through?"); otherwise a person picks (Codex round-69 P2s: worded amounts, brands, refund figures,
// a balance summary answering a named receipt).
const ACCOUNT_SUMMARY_RE = /^(?:Your account (?:balance is|has no balance due)|We don't see)\b/;
function inboundNamesSpecifics(inboundText) {
  const inbound = String(inboundText || '');
  if (!inbound.trim()) return false;
  const { invoiceNumbersNamed } = require('./zelle-target-invoice');
  const named = invoiceNumbersNamed(inbound);
  const today = dateParts(require('../utils/datetime-et').etDateString());
  return named.full.length > 0 || named.tail.length > 0 || (inbound.match(INBOUND_NAMED_AMOUNT_RE) || []).length > 0
    || inboundDates(inbound, today).length > 0 || INBOUND_TENDER_RES.some(([, re]) => re.test(inbound)) || CARD_SUBTYPE_RE.test(inbound);
}
// STRUCTURAL form of the same ruling (Codex round-73, after rounds 66-73 kept finding one more tender / brand / amount / date word):
// instead of listing what makes a question SPECIFIC, an ALLOW-list says what a GENERIC one is. A copied receipt / invoice / balance line
// auto-sends only when every clause of the customer's message is a generic status question or inert (greeting, thanks); anything
// else - Venmo, "the one from last week", a wire, a card nickname - goes to Agent Review, where a person picks the record.
const GENERIC_STATUS_QUESTION_RES = [
  /^(?:(?:i'?m |i am |just )?(?:checking|wondering|wanted to (?:check|see|make sure|confirm)|wanted to know|can you (?:check|confirm|tell me|let me know)|could you (?:check|confirm|tell me|let me know)|please (?:check|confirm|let me know))\s+)?(?:if |whether |that )?(?:you (?:guys )?|y'?all )?(?:did |have |got |received |get |receive )?(?:you (?:guys )?)?(?:get|got|receive|received)\s+(?:my|the|our)\s+payment$/,
  /^(?:(?:i'?m |just )?(?:checking|wondering)\s+)?(?:if |whether )?(?:did\s+)?(?:my|the|our)\s+payment\s+(?:go|went|gone)\s+through$/,
  /^(?:did|has|have)\s+(?:my|the|our)\s+payment\s+(?:go through|gone through|been (?:received|processed|posted|applied)|(?:get|got) (?:received|processed|posted|applied))$/,
  /^(?:was|is)\s+(?:my|the|our)\s+payment\s+(?:received|processed|posted|applied|through)$/,
  /^did\s+(?:it|that)\s+go\s+through$/,
  /^did\s+(?:you|y'?all)\s+(?:guys\s+)?(?:get|receive)\s+it$/,
  /^(?:is|was)\s+(?:my|the|our)\s+(?:invoice|bill|account|balance)\s+(?:paid(?: up| off| in full)?|settled|current|up to date|cleared)$/,
  /^(?:am i|are we)\s+(?:all\s+)?(?:paid up|caught up|current|up to date|all set|good|square)(?: on (?:my|our) (?:bill|account|invoice|balance))?$/,
  /^do\s+(?:i|we)\s+(?:still\s+)?owe\s+(?:you\s+)?(?:anything|any money|anything else)$/,
  /^(?:is there|do i have|do we have)\s+(?:a|any)\s+balance(?: (?:due|on (?:my|our) account|left))?$/,
  /^what(?:'s| is)\s+(?:my|our)\s+balance$/,
];
const GENERIC_INERT_RES = [...INERT_CLAUSE_RES, /^(?:ok(?:ay)?|hi there|good (?:morning|afternoon|evening)|quick question)$/];
function inboundIsGenericStatusQuestion(inboundText) {
  const clauses = String(inboundText || '').replace(/[’‘]/g, "'").toLowerCase().split(/[.?!;\n]+|,\s*(?=(?:thanks|thank you)\b)/)
    .map((c) => c.replace(/^\s*(?:hi|hello|hey)(?: [a-z'.-]+){0,2}\s*,\s*/, '').replace(/[,\s]+$/g, '').replace(/^[,\s]+/, '').replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!clauses.length) return false;
  let asked = false;
  for (const c of clauses) {
    if (GENERIC_STATUS_QUESTION_RES.some((re) => re.test(c))) { asked = true; continue; }
    if (!GENERIC_INERT_RES.some((re) => re.test(c))) return false;
  }
  return asked;
}
function copiesAnswerNamedSpecifics(copied, inboundText) {
  const answers = copied.some((t) => sentenceFamily(String(t)) || ACCOUNT_SUMMARY_RE.test(String(t)));
  return answers && (inboundNamesSpecifics(inboundText) || !inboundIsGenericStatusQuestion(inboundText));
}
// Codex round-74 P2: the candidates are the RECORDS, not only the lines that rendered - a disputed / unknown-status row in the window
// renders nothing yet may be the payment the customer means, and money still in flight (or unknown) or a cut window may be too. Each
// family's count is the larger of its rendered lines and its records; no billing => rendered lines only.
function recordFamilyCounts(billing) {
  if (!billing || typeof billing !== 'object') return {};
  const rows = Array.isArray(billing.recentPayments) ? billing.recentPayments.length : 0;
  const unseen = billing.recentPaymentsTruncated === true || billing.hasProcessingPayment !== false ? 1 : 0;
  return { payment: rows + unseen, invoice: Array.isArray(billing.invoiceStatuses) ? billing.invoiceStatuses.length : 0 };
}
function candidateFamilyCounts(texts, billing = null) {
  const rendered = familyCounts(texts);
  const records = recordFamilyCounts(billing);
  const out = {};
  for (const f of new Set([...Object.keys(rendered), ...Object.keys(records)])) {
    const n = Math.max(rendered[f] || 0, records[f] || 0);
    if (n) out[f] = n;
  }
  return out;
}
function copiesAmbiguousFamily(copied, snapshot) {
  const counts = snapshot?.family_counts && typeof snapshot.family_counts === 'object' ? snapshot.family_counts : {};
  return copied.some((t) => { const f = sentenceFamily(String(t)); return f != null && counts[f] !== 1; });
}

/**
 * What a decision persists (input_snapshot.payment_status_snapshot): the sentences its final reply copies, and whether the draft was
 * payment-scoped (the reply, the customer's message or the thread it was written from touches money). null when it is neither.
 */
function paymentStatusSnapshotFor({ customerId = null, sentences, reply, inboundText = null, scopeTexts = [], zelleInvoiceId = null, billing = null }) {
  const copied = copiedSentences(reply, (sentences || []).map((s) => (typeof s === 'string' ? s : s.text)));
  // (a snapshot that copied a sentence is payment-scoped by that alone; `scoped` marks the draft that copied none)
  const scoped = !copied.length && isPaymentScoped({ reply, inboundText, scopeTexts });
  if (!copied.length && !scoped) return null;
  // a copied Zelle sentence is re-rendered at send for the SAME invoice (its live eligibility and the current recipient)
  const zelle = copied.some((t) => ZELLE_WORD_RE.test(t)) && zelleInvoiceId ? { invoice_id: String(zelleInvoiceId) } : null;
  // how many lines of each family the draft could have copied (the auto-send ambiguity hold reads it)
  const counts = copied.some((t) => sentenceFamily(t)) ? candidateFamilyCounts((sentences || []).map((s) => (typeof s === 'string' ? s : s.text)), billing) : null;
  return {
    customer_id: customerId ?? null, sentences: copied, ...(scoped ? { scoped: true } : {}), ...(zelle ? { zelle } : {}), ...(counts ? { family_counts: counts } : {}),
  };
}

module.exports = {
  sentenceFamily,
  familyCounts,
  copiesOffTarget,
  remainderHasMoney,
  zelleSentences,
  paymentDayKey,
  isUnmodeledInvoice: unmodeledStatus,
  SECTION_HEADER,
  SECTION_NONE,
  SENTENCE_BULLET,
  SHAPES,
  MAX_REPLY_CHARS,
  renderPaymentStatusSentences,
  renderPaymentStatusLines,
  sentencesFromFactsBlock,
  hasOutstandingObligation,
  RESOLVED_PAYMENT_STATUSES,
  withoutSnapshotCopies,
  inboundIsGenericStatusQuestion,
  candidateFamilyCounts,
  canonText,
  copiedSentences,
  withoutCopies,
  assertsPaymentStatus,
  checkPaymentStatusReply,
  paymentStatusSnapshotFor,
  isPaymentScopedText,
  isPaymentScoped,
  autoSendScopeBlock,
  remainderIsInert,
  // every module regex, for the adversarial-input timing test
  REGEXES: { TOPIC_RE, RECEIPT_SCOPE_RE, STATUS_RE, STATUS_WORDS_RE, PAYMENT_THING_RE, HOW_TO_PAY_RE, INTERROGATIVE_START_RE, GREETING_RE, CLAUSE_BREAK_RE, MODIFIER_FRAGMENT_RE, META_FRAME_RE, OWN_SENTENCE_START_RE, SENTENCE_GAP_RE, INERT_CLAUSE_BREAK_RE, ...SHAPES },
};
