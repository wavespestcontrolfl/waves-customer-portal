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
// Pay-METHOD answers ("how can I pay", "do you take Zelle") carry no status
// vocabulary and never reach the contract; they keep the Zelle path in
// sms-amount-recheck.
//
// One shape table drives rendering AND parsing (a frozen replay reads its
// sentences back out of its own facts block), so the two cannot drift.

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_REPLY_CHARS = 2000;
const MAX_INBOUND_CHARS = 1000;

const SECTION_HEADER = '- Payment status sentences (the ONLY way to state a payment, invoice, refund or balance status is to copy one of these word for word, as a whole sentence, and only one that answers what the customer asked):';
const SECTION_NONE = '- Payment status sentences: none on file right now - state no payment, invoice, refund or balance status at all; say a teammate will confirm';
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
function hasOutstandingObligation(billing) {
  const b = billing || {};
  const inFlight = b.hasProcessingPayment !== false
    || (b.recentPayments || []).some((p) => ['pending', 'processing', 'requires_action'].includes(String(p?.status || '').toLowerCase()));
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
  return absence ? [...out, absence] : out;
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
const STATUS_ALTERNATIVES = [
  '(?:un|over|under|pre|re)?paid', 'received', 'receipts?', 'process\\w*', 'pending', 'post(?:ed|s|ing)?', 'clear(?:ed|s|ing)?', 'arriv\\w*', 'appear\\w*',
  'settle[sd]?', 'settling', 'settlement', 'completed?', 'successful(?:ly)?', 'approved', 'accepted', 'declined', 'denied', 'rejected',
  'fail(?:ed|s|ure)?', 'bounced?', 'returned', 'revers\\w*', 'refund\\w*', 'credit(?:s|ed)?', 'debit(?:s|ed)?', 'charged', 'charges', 'deducted',
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
  '(?:banked|deposited|cashed|processed|posted|applied|recorded|logged|collected|received|ran|run|cleared|settled)\\s+(?:it|that|this|them)\\b',
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
// a Zelle sentence that reads as a pay-METHOD sentence (an offer, a recipient, a denial, the memo); the Zelle recheck covers those
const ZELLE_METHOD_RE = /\bzelle\b/i;
const ZELLE_METHOD_CUE_RE = /\b(?:can|could|may|will|would|should|please|to|via|use|using|send|sending|accept\w*|take|takes|taking|offer\w*|available|unavailable|works?|memo|option)\b|@|\d{3}[\s.-]\d{4}/i;
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
function isPaymentScopedText(text) {
  const t = String(text ?? '').replace(/[’‘]/g, "'");
  if (t.length > MAX_INBOUND_CHARS) return true;
  const body = t.replace(GREETING_RE, ''); // "Hi Bill," is a name, not a bill
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
  const body = String(text ?? '').replace(/[’‘]/g, "'");
  if (body.length > MAX_REPLY_CHARS) return true; // never truncated and passed
  const inbound = inboundText == null ? null : String(inboundText);
  if (!isPaymentScoped({ reply: body, inboundText: inbound, scopeTexts, scoped })) return false;
  return body.split(CLAUSE_BREAK_RE).some((raw) => {
    const sentence = raw.trim();
    if (!sentence) return false;
    const status = statusHit(sentence);
    if (/\?$/.test(sentence) && INTERROGATIVE_START_RE.test(sentence.replace(GREETING_RE, ''))) return status;
    // (a Zelle sentence with a pay-method cue is a pay-method sentence: its recipient and the invoice's eligibility are rechecked by the Zelle path)
    return status || (!(ZELLE_METHOD_RE.test(sentence) && ZELLE_METHOD_CUE_RE.test(sentence)) && PAYMENT_THING_RE.test(sentence.replace(HOW_TO_PAY_RE, ' ')));
  });
}

/**
 * The contract for one reply against the sentences it may copy: { ok, copied (texts), remainder }.
 * ok = after the complete verbatim copies are removed, nothing left asserts a payment status.
 */
function checkPaymentStatusReply({ reply, sentences, inboundText = null, scopeTexts = [], scoped = false }) {
  const texts = (sentences || []).map((s) => (typeof s === 'string' ? s : s.text));
  const text = String(reply ?? '');
  if (text.length > MAX_REPLY_CHARS) return { ok: false, copied: [], remainder: canonText(text) };
  const copied = copiedSentences(text, texts);
  const remainder = withoutCopies(text, copied);
  return { ok: !assertsPaymentStatus(remainder, { inboundText, scopeTexts, scoped }), copied, remainder };
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
function autoSendScopeBlock({ reply, inboundText = null, snapshot = null }) {
  const sentences = asTexts(snapshot?.sentences);
  const scoped = isPaymentScoped({ reply, inboundText, scoped: snapshot?.scoped === true || sentences.length > 0 });
  if (!scoped) return null;
  const copied = copiedSentences(reply, sentences);
  return remainderIsInert(withoutCopies(reply, copied)) ? null : 'payment_status_not_auto_sendable';
}

/**
 * What a decision persists (input_snapshot.payment_status_snapshot): the sentences its final reply copies, and whether the draft was
 * payment-scoped (the reply, the customer's message or the thread it was written from touches money). null when it is neither.
 */
function paymentStatusSnapshotFor({ customerId = null, sentences, reply, inboundText = null, scopeTexts = [] }) {
  const copied = copiedSentences(reply, (sentences || []).map((s) => (typeof s === 'string' ? s : s.text)));
  // (a snapshot that copied a sentence is payment-scoped by that alone; `scoped` marks the draft that copied none)
  const scoped = !copied.length && isPaymentScoped({ reply, inboundText, scopeTexts });
  if (!copied.length && !scoped) return null;
  return { customer_id: customerId ?? null, sentences: copied, ...(scoped ? { scoped: true } : {}) };
}

module.exports = {
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
  REGEXES: { TOPIC_RE, RECEIPT_SCOPE_RE, STATUS_RE, STATUS_WORDS_RE, PAYMENT_THING_RE, HOW_TO_PAY_RE, ZELLE_METHOD_RE, ZELLE_METHOD_CUE_RE, INTERROGATIVE_START_RE, GREETING_RE, CLAUSE_BREAK_RE, MODIFIER_FRAGMENT_RE, META_FRAME_RE, OWN_SENTENCE_START_RE, SENTENCE_GAP_RE, INERT_CLAUSE_BREAK_RE, ...SHAPES },
};
