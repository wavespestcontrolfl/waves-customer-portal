/**
 * Intelligence Bar — record a payment received outside the portal
 * server/services/intelligence-bar/record-payment-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards): a card that
 * replays a screen's own handler.
 *
 *   record_payment — the Invoices page "Record payment" (POST /admin/invoices/:id/record-payment), run
 *                    through admin-invoices.js recordPaymentFromBar: the same handler, in process, so every
 *                    refusal and rule is the route's own.
 *
 * It records money ALREADY RECEIVED by hand (cash, check, Zelle, Venmo, PayPal, other). It never charges a
 * card, creates a Stripe payment, refunds or voids; refunds and charging a saved card stay closed.
 *
 * What the screen does (and so what the card promises). The card records the WHOLE amount due (total minus
 * account credit applied and any part payment already received) and stamps the payment as of now (ET). The handler
 * drops any amount in the card's body and fences the whole balance with expectedAmountCents.
 * So the card takes `amount` as a check against the balance due: it must equal it. A larger amount is
 * refused (no overpayment). A smaller one is a PART payment, offered only while GATE_IB_RECORD_PAYMENT_PARTIAL AND
 * GATE_PARTIAL_PAYMENTS are both on (owner 2026-10-29, "the bar does what the Invoices page does"); with either off it
 * is refused (partial_not_supported). A payment date other than today is refused.
 *
 * A part payment (the gated path). The card states the part, what will still be owed, that reminders continue for the rest,
 * that no receipt goes out, and the amount owed it priced from. That amount owed is pinned in `_version` and rides to the
 * handler as `part: { amountCents, owedCentsSeen }` (internal, built here, never from a request body); the route turns it into the
 * writer's `amountCents` + `owedCentsSeen` + the internal `barApprovedPart` marker, so recordManualPayment applies the Invoices
 * page's own part rules (Auto Pay, payment plan, annual prepay, payer-billed, an unsettled card dispute) and its double-submit
 * fence (a second Confirm meets a different amount owed and is refused). The preview runs the same refusals, so they show on the
 * card. A part is not a settlement: no paid flip, no receipt, no reminder stop, no review ask, no visit closeout (so the card
 * pins no closeout visit), no pause clear, no plan completion; the invoice stays open.
 * The handler (services/invoice-manual-payment.js recordManualPayment) then: retires any open pay-page
 * card session for the invoice (cancelled so it cannot be charged later; a payment already in flight
 * refuses), marks the invoice paid with the method / reference / recorder, appends the operator note,
 * writes the payments ledger row and completes any active payment plan, all in one transaction; stops the
 * invoice's reminder sequence; may clear a billing pause that was waiting on a payment; may enroll the
 * customer in the post-service review sequence (a visit-completion invoice); completes the linked visit
 * quietly when GATE_INVOICE_ISSUED_CLOSES_VISIT is on; and writes an activity row.
 * Nothing else the settlement does contacts the customer at once
 * (checked: billing-pause clear, payment-plan completion, reminder stop and the payment-failed bell close send nothing). The screen's
 * "Send receipt" switch is NOT offered: this card always sends the handler sendReceipt=false and sends the customer nothing. A receipt
 * is a separate act with its own card and its own queue rules: resend_receipt after recording, or the Invoices page. (Scope cut after
 * the receipt-queue review rounds on #6380: take-over after a guarded claim, uncertain provider outcomes.)
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct (an external_action),
 * platform path only, dark behind GATE_IB_RECORD_PAYMENT (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the invoice's
 *                  status, edit time, amounts and links, the method / reference / note, the
 *                  visit the closeout would complete, the exact request body).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the
 *                  handler with exactly the carded body. The bar also hands the handler the amount due
 *                  and a settlement fence built from the invoice the card showed (record-payment-fences.js); the settlement enforces them
 *                  on the LOCKED invoice row in the same transaction as the paid flip (and that the
 *                  invoice is still the customer's own). The Invoices page sends none of that.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { VALID_PAYMENT_METHODS } = require('../invoice-manual-payment');
const { assertInvoiceCollectible, invoiceAmountDue, neverRanVisitStatus } = require('../invoice-helpers');
const { settlementFenceFor, pinnedColumnsOf } = require('./record-payment-fences');
const { etDateString } = require('../../utils/datetime-et');

function recordPaymentLive() {
  return require('../../config/feature-gates').ibRecordPaymentLive() === true;
}

// A part payment is offered only while the bar's own part gate AND the Invoices page's part gate are both on (the writer re-checks both).
function partPaymentsOffered() {
  const gates = require('../../config/feature-gates');
  return gates.ibRecordPaymentPartialLive() === true && gates.partialPaymentsLive() === true;
}

const REFERENCE_LIMIT = 200;
const NOTE_LIMIT = 400;
const CARD_WORDS = /(card|stripe|visa|master|amex|discover|credit|debit|apple|google|tap)/i;

const RECORD_PAYMENT_TOOLS = [
  {
    name: 'record_payment',
    description: `Record a payment the office ALREADY RECEIVED outside the portal (cash, a check, Zelle, Venmo, PayPal or another manual payment) against ONE existing open invoice: the Invoices page "Record payment". It marks the invoice paid; it never charges a card, creates a Stripe payment, refunds or voids anything. The first call returns a PREVIEW and writes nothing: the invoice, the customer, the balance due, the method and reference, that no receipt is sent, and every change. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
The Invoices page records the WHOLE balance due, as of today. So amount must equal the balance due on the invoice: a larger amount (overpayment) is refused with the balance, and a payment date other than today is refused. An amount LESS than the balance due is a part payment: it is accepted only while part payments from the bar are switched on (the card says so and shows the part and what will still be owed; the invoice stays open and its reminders continue) and is otherwise refused with the balance. Effects: the invoice becomes paid with the method and reference, a payment row is added, the invoice's reminders stop, an open pay-page card session on the invoice is cancelled, and a linked visit may be completed or a review ask enrolled (the card lists what applies). The customer is sent nothing: this tool does not send receipts. To send one afterwards, use resend_receipt or the Invoices page.
Pass amount in dollars, method (cash, check, zelle, venmo, paypal or other), and reference when there is one (check number, confirmation number). send_receipt is not accepted: it is refused as capability_unimplemented. Takes invoice_id OR invoice_number, exactly one.
Refused: a paid, prepaid, void, refunded or canceled invoice, one billed to a payer or a payer's statement, an annual-plan invoice, an invoice with nothing due, a card payment (the bar does not take cards), a refund or negative amount, an amount over the balance due (or under it while part payments are off), a date other than today. A part payment is also refused for a customer on Auto Pay, an invoice with a payment plan, and one with an unsettled card dispute.
Use for: "record a payment", "customer paid cash", "mark paid by check", "she paid by check number 1042", "got a Zelle for this invoice", "log a Venmo payment", "mark this invoice paid".`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'The existing open invoice (from get_customer_invoices)' },
        invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
        amount: { type: 'number', description: 'The dollars received. Equal to the balance due records the whole balance; less than it is a part payment (only while part payments from the bar are on); more is refused.' },
        method: { type: 'string', enum: VALID_PAYMENT_METHODS, description: 'How the money arrived: cash, check, zelle, venmo, paypal or other. Never a card.' },
        reference: { type: 'string', description: `Check number, Zelle / Venmo / PayPal confirmation number, money order number (up to ${REFERENCE_LIMIT} characters)` },
        note: { type: 'string', description: `Optional office note added to the invoice's notes (up to ${NOTE_LIMIT} characters)` },
        payment_date: { type: 'string', description: 'YYYY-MM-DD, only if the operator gave one. Only today (ET) is accepted; the Invoices page records the payment as of now.' },
      },
      required: ['amount', 'method'],
    },
    _sideEffects: true,
  },
];

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const toCents = (value) => Math.round((Number(value) || 0) * 100);
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const personName = (row) => [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || row?.company_name || null;

// The invoice the call names: exactly one of id / number.
async function resolveInvoice(input) {
  const rawId = String(input?.invoice_id || '').trim();
  const rawNumber = String(input?.invoice_number || '').trim();
  if (Boolean(rawId) === Boolean(rawNumber)) return refusal('Give exactly one of invoice_id or invoice_number', 'invalid_target');
  if (rawId && !UUID_RE.test(rawId)) return refusal('A valid invoice_id is required', 'invalid_target');
  const invoice = rawId
    ? await db('invoices').where({ id: rawId.toLowerCase() }).first()
    : await db('invoices').where({ invoice_number: rawNumber.toUpperCase() }).first();
  return invoice ? { invoice } : refusal('Invoice not found', 'invoice_not_found');
}

const blank = (value) => value === undefined || value === null || value === '';

function readAmount(raw) {
  const amount = Number(raw);
  if (blank(raw) || !Number.isFinite(amount)) return refusal('amount is required: the dollars received (the balance due, or less for a part payment)', 'invalid_amount');
  if (amount < 0) return refusal('A negative amount is a refund. The bar does not refund; this card only records money received.', 'refund_not_supported');
  if (amount === 0) return refusal('amount must be more than $0.00', 'invalid_amount');
  const amountCents = toCents(amount);
  if (Math.abs(amount * 100 - amountCents) > 1e-6) return refusal('amount must be a dollar amount with at most two decimals', 'invalid_amount');
  return { amountCents };
}

function readMethod(raw) {
  const method = String(raw || '').trim().toLowerCase();
  if (VALID_PAYMENT_METHODS.includes(method)) return { method };
  return CARD_WORDS.test(method)
    ? refusal('The bar does not take card payments or charge a card. This card records cash, check, Zelle, Venmo, PayPal or other money already received.', 'card_not_supported')
    : refusal(`method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`, 'invalid_method');
}

// A text over its limit is refused, never cut short.
function readTexts(input) {
  const reference = blank(input?.reference) ? '' : String(input.reference).trim();
  const noteText = blank(input?.note) ? '' : String(input.note).trim();
  if (reference.length > REFERENCE_LIMIT) return refusal(`The reference is longer than ${REFERENCE_LIMIT} characters; shorten it.`, 'reference_too_long');
  if (noteText.length > NOTE_LIMIT) return refusal(`The note is longer than ${NOTE_LIMIT} characters; shorten it.`, 'note_too_long');
  return { reference, note: noteText };
}

function readDate(raw) {
  if (blank(raw)) return {};
  const given = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given)) return refusal('payment_date must be YYYY-MM-DD', 'invalid_target');
  if (given !== etDateString()) {
    return refusal(`The Invoices page records a payment as of today (${etDateString()}) and has no date field. Record it today, or record the payment from the Invoices page.`, 'date_not_supported');
  }
  return {};
}

// What the operator typed, checked before any read. Returns { method, reference, note, amountCents }
// or the refusal.
function readInput(input) {
  // No receipt option: refused outright, not ignored, so a model that asks for one is told the way forward.
  if (input?.send_receipt !== undefined && input.send_receipt !== null && input.send_receipt !== false) {
    return refusal('record_payment does not send receipts; after recording, use resend_receipt or the Invoices page', 'capability_unimplemented');
  }
  const parts = [readAmount(input?.amount), readMethod(input?.method), readTexts(input), readDate(input?.payment_date)];
  const failed = parts.find((part) => part.error);
  if (failed) return failed;
  return Object.assign({}, ...parts);
}

// The writer's own part-payment refusal, in its words; a check that cannot be read refuses too (fail closed).
async function partRefusal(invoice, at) {
  let why;
  try {
    why = await require('../invoice-manual-payment').partPaymentRefusal(db, invoice);
  } catch {
    why = 'The bar could not check whether a part payment is allowed on this invoice.';
  }
  return why ? refusal(`${why} Nothing was recorded. Record the whole balance, or use the Invoices page.`, 'part_not_allowed', at) : null;
}

// The refusals the card makes before it shows anything, in the handler's own words where the handler has them.
async function invoiceRefusal(invoice, dueCents, amountCents, { part = false } = {}) {
  const at = { invoice_id: invoice.id };
  try {
    assertInvoiceCollectible(invoice);
  } catch (err) {
    return refusal(err.message, /already (paid|prepaid)/.test(err.message) ? 'already_paid' : 'invoice_not_collectible', at);
  }
  if (invoice.payer_statement_id) {
    return refusal('Invoice is billed on the payer’s monthly statement; record the payment against the statement from the Invoices page.', 'payer_statement', at);
  }
  if (parseFloat(invoice.total || 0) <= 0) return refusal('Invoice has no amount to collect (total is $0)', 'nothing_due', at);
  if (dueCents <= 0) return refusal('Nothing is due on this invoice (account credit covers it), so there is no payment to record.', 'nothing_due', at);
  if (amountCents > dueCents) {
    return refusal(`The balance due is ${money(dueCents)}, less than the ${money(amountCents)} given. The Invoices page records the balance due and takes no overpayment; nothing was recorded.`, 'amount_exceeds_balance', { ...at, balance_due: dueCents / 100 });
  }
  if (amountCents < dueCents && !part) {
    return refusal(`The balance due is ${money(dueCents)}, more than the ${money(amountCents)} given. This card settles the whole balance and takes no partial payment right now; nothing was recorded.`, 'partial_not_supported', { ...at, balance_due: dueCents / 100 });
  }
  // Whose debt it is: the live resolver (the same one the settlement re-runs under the row lock), fail closed.
  let selfPay;
  try {
    selfPay = !invoice.payer_id && await require('../open-balance').rowIsSelfPayDue(invoice.customer_id, invoice);
  } catch {
    selfPay = false;
  }
  if (!selfPay) {
    return refusal('This invoice is billed to a payer, or who owes it could not be verified. Record the payment from the Invoices page.', 'payer_owned', at);
  }
  // An annual-plan invoice settles a prepaid term: it stays on the Invoices page.
  try {
    if (await require('../invoice-prepay').resolveInvoiceTermId(invoice, db, { strict: true })) {
      return refusal('This is an annual-plan invoice. Record the payment from the Invoices page.', 'annual_plan_invoice', at);
    }
  } catch {
    return refusal('The bar could not verify whether this is an annual-plan invoice, so it was not offered. Record the payment from the Invoices page.', 'annual_plan_invoice', at);
  }
  const visitId = invoice.scheduled_service_id || null;
  if (visitId) {
    const visit = await db('scheduled_services').where({ id: visitId }).first('status');
    const terminal = neverRanVisitStatus(visit?.status);
    if (terminal) {
      return refusal(`This invoice's visit is ${terminal.replace('_', '-')}; nothing can be recorded. Void or reissue the invoice from the Invoices page.`, 'visit_terminal', at);
    }
  }
  // A part payment meets the Invoices page's own part refusals (Auto Pay, a payment plan, an unsettled card dispute, ...): the writer's function.
  if (part) return partRefusal(invoice, at);
  return null;
}

// The visit the paid closeout would complete (null = none); a probe that cannot read refuses (fail closed).
async function closeoutProbe(invoice) {
  try {
    return { closeout: await require('../invoice-issued-closeout').issuedCloseoutTarget(invoice, { trigger: 'paid' }) };
  } catch {
    return { error: refusal('The bar could not check whether this payment would also complete a linked visit, so it was not offered. Record the payment from the Invoices page.', 'effects_check_failed', { invoice_id: invoice.id }) };
  }
}

// The body the Invoices page sends with its Send receipt switch off: sendReceipt is always false (the shim forces it too).
function requestBody({ method, reference, note }) {
  return {
    method,
    ...(reference ? { reference } : {}),
    ...(note ? { note } : {}),
    sendReceipt: false,
  };
}

function partEffects({ invoice, dueCents, partCents, method, reference, note }) {
  const effects = [
    { kind: 'billing', text: `Part payment of ${money(partCents)} by ${method}${reference ? `, reference ${reference}` : ''}, as of today, on invoice ${invoice.invoice_number}; ${money(dueCents - partCents)} will still be owed. The invoice stays open (${invoice.status}). A payment row for ${money(partCents)} is added to the ledger and ${money(partCents)} is added to the money received on the invoice.` },
    { kind: 'billing', text: `The amount owed this card priced from is ${money(dueCents)}. If it has changed when you confirm (another payment, an edit, or this card confirmed twice), nothing is recorded and you need a fresh card.` },
    { kind: 'billing', text: 'No card is charged, no Stripe payment is created, and nothing is refunded or voided. This records money already received.' },
    ...(note ? [{ kind: 'operational', text: `The note is added to the invoice's notes: "${note}"` }] : []),
    { kind: 'operational', text: 'The invoice\'s reminders continue for the rest: the reminder sequence is not stopped.' },
    ...(invoice.stripe_payment_intent_id
      ? [{ kind: 'operational', text: 'An open pay-page card session exists for this invoice: it is cancelled first so it cannot be charged later. A card payment already in flight stops the recording.' }]
      : []),
    { kind: 'operational', text: 'The invoice is not paid in full, so no linked visit is completed, no review ask is enrolled, no payment plan is completed and no billing pause is cleared by this step.' },
    { kind: 'comms', text: 'No receipt is sent. To send one, ask the bar to resend the receipt after recording, or use the Invoices page.' },
  ];
  return effects;
}

function planEffects({ invoice, dueCents, method, reference, note, closeout }) {
  const effects = [
    { kind: 'billing', text: `Invoice ${invoice.invoice_number} (${invoice.status}) → paid, ${money(dueCents)} by ${method}${reference ? `, reference ${reference}` : ''}, as of today. A payment row for ${money(dueCents)} is added to the ledger and any active payment plan on the invoice is completed.` },
    { kind: 'billing', text: 'No card is charged, no Stripe payment is created, and nothing is refunded or voided. This records money already received.' },
    ...(note ? [{ kind: 'operational', text: `The note is added to the invoice's notes: "${note}"` }] : []),
    { kind: 'operational', text: 'The invoice\'s reminder sequence stops.' },
    ...(invoice.stripe_payment_intent_id
      ? [{ kind: 'operational', text: 'An open pay-page card session exists for this invoice: it is cancelled first so it cannot be charged later. A card payment already in flight stops the recording.' }]
      : []),
    { kind: 'operational', text: 'A billing pause on the account that was waiting for a payment can clear.' },
  ];
  if (closeout) {
    effects.push({ kind: 'operational', text: closeout.resuming
      ? `Also finishes a closeout already started for the linked visit (${closeout.serviceType || 'visit'} on ${closeout.date}); no completion text, report, review request or charge.`
      : `Also completes the linked visit (${closeout.serviceType || 'visit'} on ${closeout.date}) quietly: creates its service record; no completion text, report, review request or charge.` });
  }
  if (invoice.service_record_id || invoice.visit_completion_packet_id) {
    effects.push({ kind: 'operational', text: 'This invoice came from a completed visit: the customer may be enrolled in the review-request follow-up under the standing review rules (no review text goes out from this step itself).' });
  }
  effects.push({ kind: 'comms', text: 'No receipt is sent. To send one, ask the bar to resend the receipt after recording, or use the Invoices page.' });
  return effects;
}

// Everything the card approves: a change in any of it is drift.
// The visit the closeout would complete, as the card read it (null = none).
const closeoutPin = (closeout) => (closeout
  ? { visitId: closeout.visitId, serviceType: closeout.serviceType || null, date: closeout.date || null, status: closeout.status ?? null, updatedAtMs: msOf(closeout.updatedAt), resuming: closeout.resuming === true }
  : null);

function versionOf({ invoice, dueCents, partCents, input, closeout, paymentDate, body }) {
  return {
    invoice_id: invoice.id,
    status: invoice.status,
    edited: msOf(invoice.updated_at),
    total: toCents(invoice.total),
    credit: toCents(invoice.credit_applied),
    due: dueCents,
    // The part the card showed (null = the whole balance); with `due` it is the amount owed the card priced from.
    part: partCents,
    customer_id: invoice.customer_id,
    payer: digest([invoice.payer_id || null, invoice.payer_statement_id || null]),
    visit: invoice.scheduled_service_id || null,
    open_payment_session: Boolean(invoice.stripe_payment_intent_id),
    from_completed_visit: Boolean(invoice.service_record_id || invoice.visit_completion_packet_id),
    method: input.method,
    reference: input.reference,
    note: input.note,
    closeout_visit: closeout?.visitId || null,
    // The visit's own facts (edit time, scheduled date, service type): a visit edited after the card is drift.
    closeout_facts: closeout ? digest(closeoutPin(closeout)) : null,
    payment_date: paymentDate,
    body: digest(body),
  };
}

async function buildPlan(input) {
  const read = readInput(input);
  if (read.error) return read;
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const dueCents = toCents(invoiceAmountDue(invoice));
  // A part payment: less than what is owed, while both part gates are on. Anything else less than owed is refused by invoiceRefusal.
  const partCents = read.amountCents < dueCents && partPaymentsOffered() ? read.amountCents : null;
  const refused = await invoiceRefusal(invoice, dueCents, read.amountCents, { part: partCents !== null });
  if (refused) return refused;
  // A part completes no visit, so the card names none and pins none.
  const probe = partCents !== null ? { closeout: null } : await closeoutProbe(invoice);
  if (probe.error) return probe.error;
  const { closeout } = probe;
  // One ET day for the whole card: shown, pinned, and re-asserted by the settlement's fence.
  const paymentDate = etDateString();
  const customer = await db('customers').where({ id: invoice.customer_id }).first('first_name', 'last_name', 'company_name');
  const body = requestBody({ method: read.method, reference: read.reference, note: read.note });
  const effects = partCents !== null
    ? partEffects({ invoice, dueCents, partCents, method: read.method, reference: read.reference, note: read.note })
    : planEffects({ invoice, dueCents, method: read.method, reference: read.reference, note: read.note, closeout });
  return {
    preview: true,
    tool: 'record_payment',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    balance_due: dueCents / 100,
    amount: read.amountCents / 100,
    ...(partCents !== null ? { part_payment: true, still_owed_after: (dueCents - partCents) / 100 } : {}),
    method: read.method,
    reference: read.reference || null,
    office_note: read.note || null,
    payment_date: paymentDate,
    effects,
    receipt: 'No receipt is sent',
    sends_to_customer: false,
    _version: versionOf({ invoice, dueCents, partCents, input: read, closeout, paymentDate, body }),
    _body: body,
    // What the settlement is handed (never shown): the amount due, the fence it runs before the Stripe retirement and again under
    // the invoice lock (record-payment-fences.js). Functions: not part of any pin or display.
    _approved: {
      expectedAmountCents: dueCents,
      // A part payment: the figures the route hands the writer (never from the body). owedCentsSeen is the amount owed the card priced from.
      ...(partCents !== null ? { part: { amountCents: partCents, owedCentsSeen: dueCents } } : {}),
      settlementFence: settlementFenceFor({ invoiceId: invoice.id, status: invoice.status, updatedAtMs: msOf(invoice.updated_at), columns: pinnedColumnsOf(invoice), closeoutTarget: closeout?.visitId || 'none', paymentDate, closeout: closeoutPin(closeout) }),
    },
    note: 'PREVIEW ONLY — nothing was recorded. Confirm records exactly this; if anything changed it refuses.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this payment.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was recorded: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The invoice changed after the card was shown, so nothing was recorded. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// The staff member's name as the page path reads it from the login (recorded on the invoice as the recorder).
async function actorOf(actionContext) {
  const technicianId = actionContext?.technicianId || null;
  if (!technicianId) return { technicianId: null };
  const tech = await db('technicians').where({ id: technicianId }).first('name', 'email');
  return { technicianId, name: tech?.name || null, email: tech?.email || null };
}

// What happened to the linked-visit closeout the card promised (null = none was promised). The payment is recorded either way.
function closeoutReport(promisedVisitId, closeout) {
  if (!promisedVisitId) return null;
  if (closeout?.closed) return { state: 'completed', note: 'The linked visit was closed.' };
  const reason = closeout?.reason || 'not_completed';
  if (['approved_visit_changed', 'approved_target_mismatch'].includes(reason)) {
    return { state: 'skipped_visit_changed', note: 'The visit changed since the card; the payment is recorded, close the visit from its page.' };
  }
  return { state: 'not_completed', note: `The linked visit was not closed (${reason}); the payment is recorded, close the visit from its page.` };
}

// The result of a part payment: the invoice stays open, and the writer's answer must carry the part it booked, equal to the card's.
function partReport(plan, json, base) {
  if (json?.partial?.amount === undefined || Math.round(Number(json.partial.amount) * 100) !== Math.round(plan.amount * 100) || json?.invoice?.status === 'paid') {
    return { ...base, outcome_unknown: true, code: 'record_unverified',
      error: 'The Invoices page answered, but the part payment does not read as recorded. Check the invoice before trying again.' };
  }
  const remaining = Number(json.partial.remaining);
  logger.info(`[intelligence-bar:record-payment] recorded ${plan.method} part payment on invoice ${plan.invoice_id}`);
  return {
    ...base, success: true, partial: true, status: json.invoice?.status || plan.status, method: plan.method, amount: plan.amount, still_owed: remaining, sent_to_customer: false,
    note: `Part payment of ${money(plan.amount * 100)} by ${plan.method} recorded on ${plan.invoice_number}; ${money(remaining * 100)} is still owed and the invoice stays open, with its reminders running. No receipt was sent. To send one, ask the bar to resend the receipt, or use the Invoices page.`,
  };
}

async function commitRecord(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_record_payment_version);
  if (refused) return refused;
  const actor = await actorOf(actionContext);
  const { status, json } = await require('../../routes/admin-invoices').recordPaymentFromBar({
    invoiceId: plan.invoice_id, body: plan._body, actor, approvedPayment: plan._approved,
  });
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id, customer_name: plan.customer_name };
  if (status !== 200) {
    const drift = status === 409 && json?.code === 'PREVIEW_CHANGED';
    return { ...base, failed: true, code: drift ? 'preview_changed' : status === 404 ? 'not_found' : 'record_refused',
      error: `The payment was not recorded: ${json?.error || 'the Invoices page refused it'}`, ...(drift ? { preview_changed: true } : {}) };
  }
  if (plan.part_payment) return partReport(plan, json, base);
  if (json?.invoice?.status !== 'paid') {
    return { ...base, outcome_unknown: true, code: 'record_unverified',
      error: 'The Invoices page answered, but the invoice does not read as paid. Check the invoice before trying again.' };
  }
  const visitCloseout = closeoutReport(plan._version.closeout_visit, json.closeout);
  logger.info(`[intelligence-bar:record-payment] recorded ${plan.method} payment on invoice ${plan.invoice_id}`);
  return {
    ...base, success: true, status: 'paid', method: plan.method, amount: plan.balance_due, sent_to_customer: false,
    ...(visitCloseout ? { visit_closeout: visitCloseout.state } : {}),
    note: `${plan.invoice_number} is marked paid (${money(plan.balance_due * 100)} by ${plan.method}). No receipt was sent. To send one, ask the bar to resend the receipt, or use the Invoices page.${visitCloseout ? ` ${visitCloseout.note}` : ''}`,
  };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'record_payment' || !preview || preview.preview !== true) return [];
  if (preview.part_payment) {
    return [
      { kind: 'billing', text: `Record a PART payment on invoice ${preview.invoice_number} for ${preview.customer_name}: ${money(preview.amount * 100)} by ${preview.method}${preview.reference ? ` (reference ${preview.reference})` : ''}, as of ${preview.payment_date}` },
      { kind: 'billing', text: `Part payment of ${money(preview.amount * 100)}; ${money(preview.still_owed_after * 100)} will still be owed (owed now: ${money(preview.balance_due * 100)}). The invoice stays open and its reminders continue.` },
      ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
    ];
  }
  return [
    { kind: 'billing', text: `Record a payment on invoice ${preview.invoice_number} for ${preview.customer_name}: ${money(preview.amount * 100)} by ${preview.method}${preview.reference ? ` (reference ${preview.reference})` : ''}, as of ${preview.payment_date}` },
    { kind: 'billing', text: `Balance due before: ${money(preview.balance_due * 100)}; after: $0.00 (the invoice is marked paid in full)` },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executeRecordPaymentTool(toolName, input = {}, actionContext = {}) {
  if (!RECORD_PAYMENT_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin record-payment route; the registry refuses a technician too. The confirmed
  // run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Recording payments is limited to admin accounts', 'permission_denied');
  }
  if (!recordPaymentLive()) return refusal('Recording a payment from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitRecord(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:record-payment] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow the write: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The payment recording was interrupted — it may or may not have happened. Check the invoice before trying again.' }
      : { error: 'Could not prepare the payment recording' };
  }
}

module.exports = {
  RECORD_PAYMENT_TOOLS,
  executeRecordPaymentTool,
  recordPaymentLive,
  cardLines,
};
