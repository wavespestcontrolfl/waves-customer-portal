/**
 * Intelligence Bar — the Invoices page's edit-type actions
 * server/services/intelligence-bar/invoice-edit-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards): a card that replays a screen's
 * own handler. Five tools, each its own confirm card, all dark behind GATE_IB_INVOICE_EDITS (which needs GATE_IB_PLATFORM):
 *
 *   edit_invoice         PUT  /admin/invoices/:id            (invoiceUpdateHandler -> InvoiceService.update)
 *                        title, line items, notes, due date, tax rate. Not email_message (customer-facing email text).
 *   apply_invoice_credit POST /admin/invoices/:id/apply-credit  (invoiceApplyCreditHandler)
 *                        pays the WHOLE balance due from the customer's ACCOUNT CREDIT, never a card.
 *   archive_invoice      POST /admin/invoices/:id/archive    (invoiceArchiveHandler)   a voided invoice leaves the default list
 *   unarchive_invoice    POST /admin/invoices/:id/unarchive  (invoiceUnarchiveHandler)
 *   unvoid_invoice       POST /admin/invoices/:id/unvoid     (invoiceUnvoidHandler -> InvoiceService.unvoidInvoice)
 *                        a voided invoice returns to a draft: editable and collectible again.
 *
 * Each runs the route's own handler in process (admin-invoices.js editInvoiceFromBar, applyCreditFromBar,
 * archiveInvoiceFromBar, unarchiveInvoiceFromBar, unvoidInvoiceFromBar), so every refusal and rule is the route's. The
 * card is narrower than the screen where the screen's case needs more than a card can show (see each tool).
 * NONE of them sends a text, email or call, charges a card, or refunds: every card says so.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only.
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the invoice's status, edit
 *                  time, amounts, links and the exact request body).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler with the
 *                  invoice version the card showed (`expected`, services/invoice-bar-expected.js); the handler enforces
 *                  it on the row it reads and again inside its own write, so a change after the check loses.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function invoiceEditsLive() {
  return require('../../config/feature-gates').ibInvoiceEditsLive() === true;
}

const TITLE_LIMIT = 300;
const NOTES_LIMIT = 2000;
const LINE_TEXT_LIMIT = 300;
const NOTE_LIMIT = 400;
const MAX_LINE_CHANGES = 30;
const MAX_TAX_PERCENT = 20;

const INVOICE_REF = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};

const INVOICE_EDIT_TOOLS = [
  {
    name: 'edit_invoice',
    description: `Edit ONE existing unpaid invoice: the Invoices page "Edit" (title, line items, notes, due date, tax rate). The first call returns a PREVIEW and writes nothing: each field before -> after and the old total -> new total (computed with the Invoices page's own arithmetic). The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if the invoice changed.
Pass only what changes. title and notes: text ("" clears it). due_date: YYYY-MM-DD. tax_rate_percent: for a commercial customer, e.g. 7 for 7%. line_changes: a list; each entry is either an EXISTING line {line_number (1-based, as numbered on the card), description?, quantity?, unit_price?} or {line_number, remove: true}, or a NEW line {description, unit_price, quantity?}. Discount lines, deposit credits and membership-dues lines are not edited here (the Invoices page does that). Call with only the invoice to see its numbered lines.
Allowed only where the Invoices page allows Edit: a draft, scheduled, sent, viewed or overdue invoice with no open card-payment session, no payment plan, no annual-plan link, no payment or credit applied. Refused: paid, prepaid, processing, refunded, void and every invoice with money received or in flight.
Effects: the invoice row changes. If the customer already received the invoice, the bar does NOT resend it; the copy they hold is out of date until it is sent again. Nothing is sent to the customer or anyone (no text, email or call), no card is charged and nothing is refunded. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "change the due date on this invoice", "edit invoice WPC-2026-0534", "update the invoice notes", "change the price on line 2", "add a line to this invoice", "remove the second line item", "change the invoice title", "set the tax rate to 7 percent".`,
    input_schema: {
      type: 'object',
      properties: {
        ...INVOICE_REF,
        title: { type: 'string', description: `The invoice title (up to ${TITLE_LIMIT} characters; "" clears it)` },
        notes: { type: 'string', description: `The invoice notes (up to ${NOTES_LIMIT} characters; "" clears them)` },
        due_date: { type: 'string', description: 'The new due date, YYYY-MM-DD' },
        tax_rate_percent: { type: 'number', description: `Tax rate in percent (0 to ${MAX_TAX_PERCENT}), commercial customers only: 7 means 7%` },
        line_changes: {
          type: 'array',
          description: 'Changes to the invoice lines: edit or remove an existing line by line_number, or add a new line with description and unit_price',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line_number: { type: 'integer', description: 'The existing line, numbered from 1 as on the card' },
              description: { type: 'string', description: `The line text (up to ${LINE_TEXT_LIMIT} characters)` },
              quantity: { type: 'number', description: 'Quantity (more than 0)' },
              unit_price: { type: 'number', description: 'Price of one unit in dollars (more than 0; discounts are not added here)' },
              remove: { type: 'boolean', description: 'true removes the line (needs line_number)' },
            },
          },
        },
      },
    },
    _sideEffects: true,
  },
  {
    name: 'apply_invoice_credit',
    description: `Pay ONE existing unpaid invoice from the customer's ACCOUNT CREDIT: the Invoices page "Apply credit". Money moves only from account credit already on the customer's balance, never a card. The first call returns a PREVIEW and writes nothing: the credit available, the amount applied (the WHOLE balance due; a partial application is not offered), the balance due after ($0.00, the invoice becomes prepaid) and the credit left. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
Effects: the customer's credit goes down by the balance due, the invoice is marked prepaid, its payment reminders stop and any active payment plan on it is completed. Nothing is sent to the customer (no text, email or call), no card is charged and nothing is refunded.
Refused: not enough credit (the card shows the shortfall), an invoice billed to a payer, an invoice that is not collectible (paid, prepaid, void, refunded), one with an open card-payment session, an annual-plan invoice, an invoice linked to any project (a report may wait on its payment), an invoice with a saved-card charge in progress. Admin only.
Optional amount must equal the balance due (the Invoices page applies the whole balance). Optional note (up to ${NOTE_LIMIT} characters) goes on the credit entry. Takes invoice_id OR invoice_number, exactly one.
Use for: "apply the customer's credit to this invoice", "use his account credit on invoice WPC-2026-0534", "pay this invoice from credit", "cover this invoice with the credit balance".`,
    input_schema: {
      type: 'object',
      properties: {
        ...INVOICE_REF,
        amount: { type: 'number', description: 'Optional check: the dollars to apply. Must equal the balance due (the Invoices page applies the whole balance).' },
        note: { type: 'string', description: `Optional note for the credit entry (up to ${NOTE_LIMIT} characters)` },
      },
    },
    _sideEffects: true,
  },
  {
    name: 'archive_invoice',
    description: `Archive ONE voided invoice: the Invoices page "Archive". It tucks a voided invoice out of the default invoice list; nothing else changes (it stays void and stays on record, and the Invoices page can unarchive it). The first call returns a PREVIEW and writes nothing; the operator approves on the confirmation card; the confirmed run re-checks and refuses if the invoice changed.
Only a voided invoice can be archived (the Invoices page refuses any other). Nothing is sent to the customer (no text, email or call), no card is charged and nothing is refunded. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "archive this voided invoice", "archive invoice WPC-2026-0534", "hide the void invoice from the list".`,
    input_schema: { type: 'object', properties: { ...INVOICE_REF } },
    _sideEffects: true,
  },
  {
    name: 'unarchive_invoice',
    description: `Unarchive ONE archived invoice: the Invoices page "Unarchive". It puts the invoice back in the default invoice list; nothing else changes. The first call returns a PREVIEW and writes nothing; the operator approves on the confirmation card; the confirmed run re-checks and refuses if the invoice changed.
Nothing is sent to the customer (no text, email or call), no card is charged and nothing is refunded. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "unarchive this invoice", "bring invoice WPC-2026-0534 back to the list", "restore the archived invoice to the list".`,
    input_schema: { type: 'object', properties: { ...INVOICE_REF } },
    _sideEffects: true,
  },
  {
    name: 'unvoid_invoice',
    description: `Unvoid ONE voided invoice: the Invoices page "Unvoid" (restore to draft). The invoice becomes a DRAFT again: editable and collectible (payable once it is sent). Its payment reminders do NOT restart now: they restart only when the invoice is sent again. It restores the invoice row and nothing else: an invoice with a queued message, a reminder sequence, a combined-visit packet, a payer or statement, a setup fee or a dues month is left to the Invoices page. Account credit applied before the void was returned at the void and is not re-applied. The first call returns a PREVIEW and writes nothing; the operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if the invoice changed.
Refused with the page's own reasons: not void, an annual-plan invoice, one with a deposit credit, a payment already applied, a finalized payer statement, a live card-payment session, a saved-card charge in progress, a visit that was cancelled. Nothing is sent to the customer (no text, email or call), no card is charged and nothing is refunded. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "unvoid this invoice", "undo the void on invoice WPC-2026-0534", "restore the voided invoice", "I voided that by mistake, bring it back".`,
    input_schema: { type: 'object', properties: { ...INVOICE_REF } },
    _sideEffects: true,
  },
];

const TOOL_NAMES = INVOICE_EDIT_TOOLS.map((t) => t.name);

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const blank = (value) => value === undefined || value === null || value === '';
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const NOTHING_SENT = { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or anyone else. No card is charged and nothing is refunded.' };

function parseLines(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((li) => li && typeof li === 'object') : [];
  } catch { return []; }
}

async function customerOf(customerId) {
  return db('customers').where({ id: customerId }).first('id', 'first_name', 'last_name', 'company_name', 'property_type');
}
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

// Statuses that read as collected or moving money (the Invoices page shows no Edit for them either).
const MONEY_STATUSES = new Set(['paid', 'prepaid', 'processing', 'refunded', 'partially_refunded', 'partial', 'disputed']);
const EDITABLE_STATUSES = new Set(['draft', 'scheduled', 'sent', 'viewed', 'overdue']);
const DELIVERED_STATUSES = new Set(['sent', 'viewed', 'overdue']);

const ownerRule = (error, reason, invoiceId) => refusal(`${error} Refunds and card charges stay on the Invoices page.`, 'by_owner_rule', { reason, invoice_id: invoiceId });
const toPage = (error, reason, invoiceId) => refusal(`${error} Do it from the Invoices page.`, 'needs_invoices_page', { reason, invoice_id: invoiceId });

function lineAmount(li) {
  const amount = Number(li?.amount);
  if (Number.isFinite(amount) && li?.amount !== null && li?.amount !== '') return amount;
  return round2((Number(li?.quantity) || 1) * (Number(li?.unit_price) || 0));
}
const lineText = (li) => {
  const qty = Number(li?.quantity) || 1;
  const unit = Number(li?.unit_price);
  const amount = lineAmount(li);
  return `${oneLine(li?.description || li?.name || 'Line') || 'Line'} — ${qty} × ${money(Number.isFinite(unit) ? unit : amount)} = ${money(amount)}`;
};

// A day as the Invoices page shows it (ET calendar day); a pg DATE arrives as a Date at UTC midnight.
function dayOf(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return require('../../utils/datetime-et').etCalendarDayOf(value);
}

// ── shared reads ────────────────────────────────────────────────

// An invoice with a payer statement that is no longer open is a billed line.
async function statementOf(invoice) {
  if (!invoice.payer_statement_id) return null;
  return db('payer_statements').where({ id: invoice.payer_statement_id }).first('status');
}

async function paymentPlanOf(invoice, { activeOnly = false } = {}) {
  const q = db('payment_plans').where({ invoice_id: invoice.id });
  if (activeOnly) q.where({ status: 'active' });
  else q.whereNot('status', 'cancelled');
  return q.first('id', 'status');
}

// Read-only saved-card charge fence (the handlers re-run theirs under their own locks).
async function chargeInProgress(invoice) {
  try {
    await require('../stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, db, { readOnly: true });
    return null;
  } catch (err) {
    if (err?.reconciliationRequired || /^STRIPE_/.test(String(err?.code || ''))) return 'charge_in_progress';
    return 'unverified';
  }
}

// The visit the invoice rides (shown and pinned on the unvoid card).
async function linkedVisit(invoice) {
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, db);
  if (!visitId) return null;
  const visit = await db('scheduled_services').where({ id: visitId }).first('id', 'status', 'scheduled_date', 'window_start', 'window_end');
  return visit ? {
    id: visit.id, status: visit.status || null,
    date: visit.scheduled_date ? require('../../utils/datetime-et').etCalendarDayOf(visit.scheduled_date) : null,
    window: [visit.window_start, visit.window_end].map((v) => (v ? String(v).slice(0, 8) : '')).join('-'),
  } : null;
}

const baseOf = (plan) => ({ invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id, customer_name: plan.customer_name });

// The re-derived plan when it still matches the card's pin, or the refusal.
function verifier(buildPlan, doneWord) {
  return async function verifiedPlan(input, pinned) {
    if (!pinned) return { refusal: refusal(`Use the confirmation card to approve this change.`, 'approval_required') };
    const plan = await buildPlan(input);
    if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true, ...(plan.code === 'by_owner_rule' ? { reason: plan.reason } : {}) } };
    if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
      return { refusal: { error: `The invoice changed after the card was shown, so nothing was ${doneWord}. Ask again for a fresh confirmation card.`, code: 'preview_changed', preview_changed: true } };
    }
    return { plan };
  };
}

// The staff member's name as the page path reads it from the login.
async function actorOf(actionContext) {
  const technicianId = actionContext?.technicianId || null;
  if (!technicianId) return { technicianId: null };
  const tech = await db('technicians').where({ id: technicianId }).first('name', 'email');
  return { technicianId, name: tech?.name || null, email: tech?.email || null };
}

const DRIFT_RE = /changed while|new payment session|owner changed|re-check and retry/i;
const isDrift = (status, json) => status === 409 && (json?.code === 'PREVIEW_CHANGED' || DRIFT_RE.test(String(json?.error || '')));

// A non-200 answer from the page's handler, in the card's words.
function handlerFailure(plan, result, what, { moneyWords } = {}) {
  const { status, json } = result;
  const message = String(json?.error || 'the Invoices page refused it');
  const drift = isDrift(status, json);
  const code = status === 404 ? 'not_found'
    : json?.code === 'NEEDS_INVOICES_PAGE' ? 'needs_invoices_page'
      : drift ? 'preview_changed'
      : moneyWords && status === 409 && moneyWords.test(message) ? 'by_owner_rule'
        : 'refused_by_page';
  return { ...baseOf(plan), failed: true, code, error: `${what}: ${message}`, ...(drift || status === 404 ? { preview_changed: true } : {}) };
}

// ═════════════════════════════════════════════════════════════════
// edit_invoice
// ═════════════════════════════════════════════════════════════════

// Each reader answers null (field absent), a refusal, or { set, any } (what to merge into the parsed input, and whether it counts as a change).
const readTextField = (key, limit) => (input) => {
  if (input[key] === undefined) return null;
  const text = input[key] === null ? '' : String(input[key]).trim();
  if (text.length > limit) return refusal(`The ${key} is longer than ${limit} characters; shorten it.`, `${key}_too_long`);
  return { set: { [key]: text || null }, any: true };
};

function readDueDate(input) {
  if (input.due_date === undefined) return null;
  const given = String(input.due_date ?? '').trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(given) ? new Date(`${given}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== given) return refusal('due_date must be a real date, YYYY-MM-DD', 'invalid_due_date');
  return { set: { dueDate: given }, any: true };
}

function readTaxRate(input) {
  if (input.tax_rate_percent === undefined) return null;
  const pct = Number(input.tax_rate_percent);
  if (blank(input.tax_rate_percent) || !Number.isFinite(pct) || pct < 0 || pct > MAX_TAX_PERCENT) return refusal(`tax_rate_percent must be a number from 0 to ${MAX_TAX_PERCENT}`, 'invalid_tax_rate');
  // 7 -> 0.07 (the column holds a fraction, 4 places)
  return { set: { taxRate: Math.round(pct * 100) / 10000, taxPercent: pct }, any: true };
}

const invalidLine = (message) => refusal(message, 'invalid_line_change');

// The existing line a change names (counted from 1, once per line).
function readLineNumber(raw, seen) {
  if (raw.line_number === undefined) return {};
  if (!Number.isInteger(raw.line_number) || raw.line_number < 1) return invalidLine('line_number counts from 1');
  if (seen.has(raw.line_number)) return invalidLine(`Line ${raw.line_number} is named twice; give one change per line`);
  seen.add(raw.line_number);
  return { line: raw.line_number };
}

function readLineDescription(raw) {
  if (raw.description === undefined) return {};
  const text = oneLine(raw.description);
  if (!text) return invalidLine('A line needs a description');
  if (text.length > LINE_TEXT_LIMIT) return invalidLine(`A line description is limited to ${LINE_TEXT_LIMIT} characters`);
  return { description: text };
}

function readLineNumberField(raw, key) {
  if (raw[key] === undefined) return {};
  const n = Number(raw[key]);
  if (blank(raw[key]) || !Number.isFinite(n) || n <= 0) return invalidLine(`A line ${key} must be more than 0 (discounts are added on the Invoices page)`);
  if (key === 'unit_price' && Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return invalidLine('unit_price takes at most two decimals');
  return { [key]: n };
}

// A changed or new line: description, quantity, unit_price.
function readLineEdit(raw, line) {
  const parts = [readLineDescription(raw), readLineNumberField(raw, 'quantity'), readLineNumberField(raw, 'unit_price')];
  const failed = parts.find((part) => part.error);
  if (failed) return failed;
  const change = Object.assign({}, ...parts);
  if (!line) {
    if (!change.description || change.unit_price === undefined) return invalidLine('A new line needs a description and a unit_price');
  } else if (change.description === undefined && change.quantity === undefined && change.unit_price === undefined) {
    return invalidLine(`Line ${line} names no change`);
  }
  return change;
}

function readLineChange(raw, seen) {
  if (!raw || typeof raw !== 'object') return invalidLine('Each line change must be an object');
  const named = readLineNumber(raw, seen);
  if (named.error) return named;
  if (raw.remove === true) {
    if (!named.line) return invalidLine('remove needs a line_number');
    if (raw.description !== undefined || raw.quantity !== undefined || raw.unit_price !== undefined) return invalidLine('A removed line takes no other change');
    return { ...named, remove: true };
  }
  const edit = readLineEdit(raw, named.line);
  return edit.error ? edit : { ...named, ...edit };
}

function readLineChanges(input) {
  if (input.line_changes === undefined) return null;
  if (!Array.isArray(input.line_changes)) return invalidLine('line_changes must be a list');
  if (input.line_changes.length > MAX_LINE_CHANGES) return invalidLine(`At most ${MAX_LINE_CHANGES} line changes at once`);
  const seen = new Set();
  const lineChanges = [];
  for (const raw of input.line_changes) {
    const change = readLineChange(raw, seen);
    if (change.error) return change;
    lineChanges.push(change);
  }
  return { set: { lineChanges }, any: lineChanges.length > 0 };
}

const EDIT_INPUT_READERS = [readTextField('title', TITLE_LIMIT), readTextField('notes', NOTES_LIMIT), readDueDate, readTaxRate, readLineChanges];

function readEditInput(input) {
  const out = { lineChanges: [] };
  let any = false;
  for (const read of EDIT_INPUT_READERS) {
    const part = read(input);
    if (!part) continue;
    if (part.error) return part;
    Object.assign(out, part.set);
    any = any || part.any;
  }
  if (!any) return refusal('Nothing to change: give a title, notes, due_date, tax_rate_percent or line_changes.', 'nothing_to_change');
  return out;
}

const numbered = (lines) => lines.map((li, i) => `${i + 1}. ${lineText(li)}`);

// A line the bar will touch must be a plain service line.
function plainLineRefusal(li, number) {
  if (Number(lineAmount(li)) <= 0 || li.category === 'deposit_credit' || li.discount_id || li.discount_for || li.stored_discount_source) {
    return `Line ${number} is a discount or credit line. Discount lines are changed on the Invoices page.`;
  }
  if (li.membership_dues_month) return `Line ${number} is a membership-dues line, which stays as it is.`;
  return null;
}

// A stored line with an amount but no unit price (a legacy amount-only line), written so it keeps its amount when the bar resubmits
// every line: InvoiceService.update prices each line as quantity * (unit_price || 0), so an untouched amount-only line would be
// saved as $0. Returns null when the amount does not split evenly over its quantity (the bar then refuses; the page edits it).
// The page's update also rewrites every line's amount as round2(quantity * unit_price) (normalizeInvoiceLineItems), so a stored
// amount that differs from that product (e.g. 3 x $33.33 stored as $100.00) would silently change on any retotal: refused too.
function canonicalLine(li) {
  const hasUnit = li.unit_price !== undefined && li.unit_price !== null && li.unit_price !== '' && Number.isFinite(Number(li.unit_price));
  if (hasUnit) {
    const hasAmount = li.amount !== undefined && li.amount !== null && li.amount !== '' && Number.isFinite(Number(li.amount));
    if (hasAmount && round2((Number(li.quantity) || 1) * Number(li.unit_price)) !== round2(Number(li.amount))) return null;
    return { ...li };
  }
  const qty = Number(li.quantity) || 1;
  const amount = lineAmount(li);
  const unit = round2(amount / qty);
  if (round2(qty * unit) !== round2(amount)) return null;
  return { ...li, quantity: qty, unit_price: unit, amount: round2(amount) };
}

function applyLineChanges(stored, changes, invoiceId) {
  const next = stored.map(canonicalLine);
  const uneven = next.findIndex((li) => li === null);
  if (uneven !== -1) {
    return refusal(`Line ${uneven + 1} has an amount that is not its quantity times its unit price, so the bar cannot resave it unchanged. Edit this invoice on the Invoices page.`, 'line_not_editable', { lines: numbered(stored) });
  }
  const dropped = new Set();
  const touched = []; // { kind, number, before, after }
  const added = [];
  for (const change of changes) {
    if (!change.line) continue;
    const idx = change.line - 1;
    const li = next[idx];
    if (!li) return refusal(`The invoice has ${stored.length} line${stored.length === 1 ? '' : 's'}; there is no line ${change.line}.`, 'line_not_found', { lines: numbered(stored) });
    const why = plainLineRefusal(li, change.line);
    if (why) return refusal(why, 'line_not_editable', { lines: numbered(stored) });
    if (change.remove) {
      if (stored.some((other) => other.discount_for && li.client_id && String(other.discount_for) === String(li.client_id))) {
        return refusal(`Line ${change.line} has a discount attached. Remove it from the Invoices page.`, 'line_not_editable', { lines: numbered(stored) });
      }
      dropped.add(idx);
      touched.push({ kind: 'removed', number: change.line, before: lineText(stored[idx]), after: '(removed)' });
      continue;
    }
    const qty = change.quantity !== undefined ? change.quantity : (Number(li.quantity) || 1);
    const unit = change.unit_price !== undefined ? change.unit_price : (Number(li.unit_price) || lineAmount(li) / qty);
    next[idx] = {
      ...li,
      ...(change.description !== undefined ? { description: change.description } : {}),
      quantity: qty,
      unit_price: unit,
      amount: round2(qty * unit),
    };
    touched.push({ kind: 'changed', number: change.line, before: lineText(stored[idx]), after: lineText(next[idx]) });
  }
  let out = next.filter((_li, idx) => !dropped.has(idx));
  let n = 0;
  // Every id already on the invoice (even a line this edit removes) stays unique: a new line's id is derived from the invoice, the
  // line and a salt, and the salt moves on until the id is free. The stored lines are part of the card's pinned version, so the
  // same request gives the same ids at preview and at Confirm; an identical line added by a later edit gets the next free id.
  const taken = new Set(stored.map((li) => li.client_id).filter(Boolean).map(String));
  for (const change of changes) {
    if (change.line) continue;
    n += 1;
    const qty = change.quantity !== undefined ? change.quantity : 1;
    let salt = 0;
    let clientId;
    do {
      clientId = `li_bar_${digest([invoiceId, n, change.description, qty, change.unit_price, salt]).slice(0, 12)}`;
      salt += 1;
    } while (taken.has(clientId));
    taken.add(clientId);
    const li = {
      client_id: clientId,
      description: change.description,
      quantity: qty,
      unit_price: change.unit_price,
      amount: round2(qty * change.unit_price),
    };
    out.push(li);
    added.push(li);
    touched.push({ kind: 'added', number: null, before: '(new line)', after: lineText(li) });
  }
  if (!out.some((li) => lineAmount(li) > 0)) {
    return refusal('That would leave the invoice with no billable line. Void the invoice instead.', 'invoice_empty', { lines: numbered(stored) });
  }
  return { lines: out, touched };
}

async function editRefusal(invoice, retotal) {
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  if (MONEY_STATUSES.has(status)) {
    return ownerRule(`Invoice ${invoice.invoice_number} is ${status}, so money has been received or is moving. It cannot be edited.`, `status_${status}`, at);
  }
  if (status === 'void') return refusal(`Invoice ${invoice.invoice_number} is void. Unvoid it first (unvoid_invoice), then edit it.`, 'not_editable', { reason: 'status_void', invoice_id: at });
  if (!EDITABLE_STATUSES.has(status)) return refusal(`Only unpaid invoices can be edited; invoice ${invoice.invoice_number} is ${status || 'in an unknown state'}.`, 'not_editable', { reason: `status_${status}`, invoice_id: at });
  if (invoice.stripe_payment_intent_id) {
    return refusal('A customer has already started paying this invoice. Void it and create a replacement instead of editing it.', 'not_editable', { reason: 'payment_session_open', invoice_id: at });
  }
  if (invoice.annual_prepay_term_id) return toPage(`Invoice ${invoice.invoice_number} is part of an annual prepay term; edit the term (Annual prepay).`, 'annual_plan', at);
  if (await paymentPlanOf(invoice, { activeOnly: true })) return refusal('This invoice has an active payment plan. Cancel the plan before editing the invoice.', 'not_editable', { reason: 'payment_plan', invoice_id: at });
  const statement = await statementOf(invoice);
  if (statement && statement.status !== 'open') return refusal('This invoice is on a finalized payer statement. Adjust it with a credit on the next statement.', 'not_editable', { reason: 'finalized_statement', invoice_id: at });
  if (retotal) {
    if (invoice.payment_recorded_at) return ownerRule(`A payment is already recorded on invoice ${invoice.invoice_number}, so its amounts cannot change.`, 'payment_recorded', at);
    if (cents(invoice.credit_applied) > 0) return refusal('This invoice has account credit applied. Reverse the applied credit before editing line items or the tax rate.', 'not_editable', { reason: 'credit_applied', invoice_id: at });
    if (parseLines(invoice.line_items).some((li) => li.category === 'deposit_credit')) {
      return refusal('This invoice carries an estimate deposit credit. Void it and create a replacement instead of editing amounts.', 'not_editable', { reason: 'deposit_credit', invoice_id: at });
    }
    const applied = await db('payments').whereIn('status', ['paid', 'processing', 'disputed'])
      .whereRaw("(metadata::jsonb ->> 'invoice_id' = ? OR metadata::jsonb ->> 'dispute_invoice_id' = ? OR metadata::jsonb ->> 'waves_invoice_id' = ?)", [String(at), String(at), String(at)])
      .first('id', 'status');
    if (applied) return ownerRule(`A payment (${applied.status}) is on file for invoice ${invoice.invoice_number}, so its amounts cannot change.`, 'payment_on_file', at);
    const attempt = await db('stripe_invoice_charge_attempts').where({ invoice_id: at }).whereNull('resolved_at').whereIn('status', ['claimed', 'ambiguous']).first('id');
    if (attempt) return ownerRule(`A saved-card charge for invoice ${invoice.invoice_number} is still processing or awaiting reconciliation.`, 'charge_in_progress', at);
    if (await require('../invoice')._invoiceHasUnbackedDocumentDiscount(invoice, invoice.line_items, db)) {
      return toPage(`Invoice ${invoice.invoice_number} carries a document-level discount with no backing line, which an amount edit would lose.`, 'unbacked_discount', at);
    }
  }
  return null;
}

function fieldChange(field, before, after) {
  return { field, before: before === null || before === undefined || before === '' ? '(empty)' : String(before), after: after === null || after === undefined || after === '' ? '(empty)' : String(after) };
}

// Whether confirming runs the setup-fee alert reconciliation (the update handler runs it for the edited row and the pre-edit row;
// InvoiceService.unvoidInvoice runs it after the unvoid):
// the invoice, before or after the edit, is stamped for an accepted estimate or linked to an estimate-sourced visit. Mirrors
// reconcileSetupFeeAlertForInvoice's own lookup; an unreadable link counts as tied (the card discloses rather than hides).
async function setupFeeAlertTied(invoice, nextNotes) {
  const { acceptedEstimateIdFromNotes } = require('../setup-fee-alert-reconcile');
  if (acceptedEstimateIdFromNotes(invoice.notes) || (nextNotes !== undefined && acceptedEstimateIdFromNotes(nextNotes))) return true;
  try {
    let visitId = invoice.scheduled_service_id || null;
    if (!visitId && invoice.service_record_id) {
      visitId = (await db('service_records').where({ id: invoice.service_record_id }).first('scheduled_service_id'))?.scheduled_service_id || null;
    }
    if (!visitId) return false;
    return Boolean((await db('scheduled_services').where({ id: visitId }).first('source_estimate_id'))?.source_estimate_id);
  } catch {
    return true;
  }
}
const SETUP_FEE_EFFECT = { kind: 'operational', text: 'This invoice belongs to an accepted estimate. Confirming re-checks the staff alert that asks the office to bill its setup fee: that alert may close, reopen or change (and show as unread again). Nothing is sent to the customer.' };

function editEffects({ invoice, status, dueChanged, totalChanged, oldTotal, newTotal, statement, setupFeeTied = false }) {
  const effects = [];
  if (totalChanged) effects.push({ kind: 'billing', text: `The invoice total changes from ${money(oldTotal)} to ${money(newTotal)}.` });
  if (DELIVERED_STATUSES.has(status)) {
    effects.push({ kind: 'operational', text: 'The customer already received this invoice. The bar does NOT resend it: the copy they hold stays out of date until it is sent again (send it from the Invoices page, or ask the bar to send it). An activity entry notes the edit after delivery.' });
  }
  if (status === 'scheduled') {
    effects.push({ kind: 'operational', text: 'This invoice is scheduled to be sent later: the scheduled send carries the edited version. This step sends nothing itself.' });
  }
  if (dueChanged) {
    effects.push({ kind: 'operational', text: status === 'overdue'
      ? 'Its payment reminder dates move with the new due date. A due date in the future returns it from overdue to sent.'
      : 'Its payment reminder dates move with the new due date.' });
  }
  if (statement && totalChanged) effects.push({ kind: 'billing', text: 'Its payer’s open monthly statement is recalculated with the new amount.' });
  if (setupFeeTied) effects.push(SETUP_FEE_EFFECT);
  effects.push(NOTHING_SENT);
  return effects;
}

// Title, notes and due date that really differ from the invoice, as card changes and request-body fields.
function metadataChanges(invoice, read) {
  const changes = [];
  const body = {};
  if (read.title !== undefined && (read.title || null) !== (oneLine(invoice.title) || null)) {
    changes.push(fieldChange('Title', invoice.title, read.title));
    body.title = read.title;
  }
  if (read.notes !== undefined && (read.notes || null) !== ((invoice.notes || '').trim() || null)) {
    changes.push(fieldChange('Notes', invoice.notes, read.notes));
    body.notes = read.notes;
  }
  const dueBefore = dayOf(invoice.due_date);
  const dueChanged = read.dueDate !== undefined && read.dueDate !== dueBefore;
  if (dueChanged) {
    changes.push(fieldChange('Due date', dueBefore, read.dueDate));
    body.due_date = read.dueDate;
  }
  return { changes, body, dueChanged };
}

// The line changes applied to the stored lines: the next lines and one card change per touched line (or a refusal).
function editedLines({ invoice, stored, read, changes, body }) {
  if (!read.lineChanges.length) {
    // A retotal with no line change (a tax-rate edit) still reprices every stored line as quantity * (unit_price || 0), in the
    // preview and again in the page's update: a legacy amount-only line is sent with its unit price, so it keeps its amount.
    const canonical = stored.map(canonicalLine);
    const uneven = canonical.findIndex((li) => li === null);
    if (uneven !== -1) {
      return refusal(`Line ${uneven + 1} has an amount that is not its quantity times its unit price, so the bar cannot reprice this invoice. Edit it on the Invoices page.`, 'line_not_editable', { invoice_id: invoice.id, lines: numbered(stored) });
    }
    if (canonical.some((li, i) => li.unit_price !== stored[i].unit_price)) body.line_items = canonical;
    return { nextLines: canonical };
  }
  const applied = applyLineChanges(stored, read.lineChanges, invoice.id);
  if (applied.error) return { ...applied, invoice_id: invoice.id };
  for (const t of applied.touched) {
    changes.push(fieldChange(t.kind === 'added' ? 'New line' : `Line ${t.number}${t.kind === 'removed' ? ' (removed)' : ''}`, t.before, t.after));
  }
  body.line_items = applied.lines;
  return { nextLines: applied.lines };
}

// The new totals, from the page's own arithmetic; a tax rate the customer is not taxed at is refused.
async function editedFinancials({ invoice, customer, nextLines, read, changes, body }) {
  let financials;
  try {
    financials = await require('../invoice')._calculateUpdateFinancials({
      lineItems: nextLines.map((li) => ({ ...li })), customer, invoice, taxRate: read.taxRate,
    });
  } catch (err) {
    return refusal(`The Invoices page would refuse this edit: ${err.message}`, 'edit_refused', { invoice_id: invoice.id });
  }
  if (read.taxRate === undefined) return { financials };
  if (Number(financials.tax_rate) !== read.taxRate) {
    return refusal(`Tax applies only to commercial customers that pay tax; this invoice is taxed at ${(Number(financials.tax_rate) * 100).toFixed(2)}%, so a tax rate is not changed.`, 'tax_rate_not_applicable', { invoice_id: invoice.id });
  }
  if (Number(invoice.tax_rate || 0) !== read.taxRate) {
    changes.push(fieldChange('Tax rate', `${(Number(invoice.tax_rate || 0) * 100).toFixed(2)}%`, `${(read.taxRate * 100).toFixed(2)}%`));
  }
  body.tax_rate = read.taxRate;
  return { financials };
}

// The total, and the subtotal / discount / tax when they moved, appended to the card changes.
function totalChanges(invoice, financials, changes) {
  const oldTotal = round2(invoice.total);
  const newTotal = financials ? round2(financials.total) : oldTotal;
  const totalChanged = cents(oldTotal) !== cents(newTotal);
  if (totalChanged) changes.push(fieldChange('Total', money(oldTotal), money(newTotal)));
  const partsMoved = financials && ['subtotal', 'tax_amount', 'discount_amount'].some((key) => cents(invoice[key]) !== cents(financials[key]));
  if (partsMoved) {
    changes.push(fieldChange('Subtotal / discount / tax',
      `${money(invoice.subtotal)} / ${money(invoice.discount_amount)} / ${money(invoice.tax_amount)}`,
      `${money(financials.subtotal)} / ${money(financials.discount_amount)} / ${money(financials.tax_amount)}`));
  }
  return { oldTotal, newTotal, totalChanged };
}

// What the card pins (_version) and what the page's handler is handed (_expected).
function editPins({ invoice, stored, body, newTotal, financials, setupFeeTied }) {
  return {
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      total: cents(invoice.total),
      credit_applied: cents(invoice.credit_applied),
      customer_id: invoice.customer_id || null,
      payer_statement_id: invoice.payer_statement_id || null,
      lines: digest(stored),
      body: digest(body),
      new_total: cents(newTotal),
      // Shown in the effects, so pinned: an estimate link that appears after the card refuses at Confirm.
      setup_fee_tied: Boolean(setupFeeTied),
    },
    _expected: {
      status: invoice.status,
      updatedAt: msOf(invoice.updated_at),
      total: Number(invoice.total) || 0,
      creditApplied: Number(invoice.credit_applied) || 0,
      paymentIntentId: null,
      ...(financials ? { newTotal } : {}),
    },
  };
}

async function buildEditPlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const stored = parseLines(invoice.line_items);
  const read = readEditInput(input);
  // With nothing to change the reply lists the numbered lines, so the operator can name one.
  if (read.error) return read.code === 'nothing_to_change' ? { ...read, invoice_id: invoice.id, lines: numbered(stored) } : read;
  const retotal = read.lineChanges.length > 0 || read.taxRate !== undefined;
  const refused = await editRefusal(invoice, retotal);
  if (refused) return refused;
  if (retotal && stored.some((li) => li.membership_dues_month) && read.lineChanges.length) {
    return toPage(`Invoice ${invoice.invoice_number} is a membership-dues invoice; its lines stay as they are.`, 'membership_dues', invoice.id);
  }
  const customer = await customerOf(invoice.customer_id);
  const { changes, body, dueChanged } = metadataChanges(invoice, read);
  let financials = null;
  let nextLines = stored;
  if (retotal) {
    const lines = editedLines({ invoice, stored, read, changes, body });
    if (lines.error) return lines;
    nextLines = lines.nextLines;
    const computed = await editedFinancials({ invoice, customer, nextLines, read, changes, body });
    if (computed.error) return computed;
    ({ financials } = computed);
  }
  if (!changes.length) return refusal('The invoice already reads that way. Nothing was changed.', 'no_change', { invoice_id: invoice.id, lines: numbered(stored) });
  const { oldTotal, newTotal, totalChanged } = totalChanges(invoice, financials, changes);
  const statement = await statementOf(invoice);
  const setupFeeTied = await setupFeeAlertTied(invoice, body.notes);
  return {
    preview: true,
    tool: 'edit_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    old_total: money(oldTotal),
    new_total: money(newTotal),
    changes,
    lines_after: numbered(nextLines).slice(0, 30),
    effects: editEffects({ invoice, status: String(invoice.status || '').toLowerCase(), dueChanged, totalChanged, oldTotal, newTotal, statement, setupFeeTied }),
    sends_to_customer: false,
    ...editPins({ invoice, stored, body, newTotal, financials, setupFeeTied }),
    _body: body,
    note: 'PREVIEW ONLY — nothing was changed. Confirm saves exactly these changes; if the invoice changed it refuses.',
  };
}

const verifiedEdit = verifier(buildEditPlan, 'changed');

async function commitEdit(input, actionContext) {
  const { plan, refusal: refused } = await verifiedEdit(input, input._verified_invoice_edit_version);
  if (refused) return refused;
  const actor = await actorOf(actionContext);
  let result;
  try {
    result = await require('../../routes/admin-invoices').editInvoiceFromBar({ invoiceId: plan.invoice_id, body: plan._body, actor, expected: plan._expected });
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-edit] edit handler failed (${err.code || err.name || 'error'})`);
    return { ...baseOf(plan), outcome_unknown: true, code: 'execution_interrupted',
      error: 'The edit was interrupted — it may or may not have been saved. Check the invoice before trying again.' };
  }
  if (result.status !== 200) {
    return handlerFailure(plan, result, 'The invoice was not changed', { moneyWords: /payment already applied|payment dispute|saved-card charge/i });
  }
  const savedTotal = cents(result.json?.total);
  if (result.json?.id !== plan.invoice_id || (plan._expected.newTotal !== undefined && savedTotal !== cents(plan._expected.newTotal))) {
    return { ...baseOf(plan), outcome_unknown: true, code: 'edit_unverified',
      error: 'The Invoices page answered, but the invoice does not read as the card promised. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-edit] edited invoice ${plan.invoice_id}`);
  const delivered = DELIVERED_STATUSES.has(String(plan.status || '').toLowerCase());
  return {
    ...baseOf(plan), success: true, status: result.json.status || plan.status, total: money(result.json.total), sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is updated${plan._version.total !== savedTotal ? ` (total ${plan.old_total} -> ${money(result.json.total)})` : ''}. Nothing was sent to anyone.${delivered ? ' The customer already had this invoice and was not sent the new version: send it again if they should see the change.' : ''}`,
  };
}

// ═════════════════════════════════════════════════════════════════
// apply_invoice_credit
// ═════════════════════════════════════════════════════════════════

const REPORT_PROJECT_TEXT = 'This invoice is linked to a project (a report may wait on its payment). Paying it nudges the report-release sweep, which can send the report to the customer, and a report hold is written without touching the invoice, so the bar cannot pin it. Apply the credit on the Invoices page.';

// The saved-card charge fence, read-only. `where` finishes the unverified sentence ("Apply the credit from the Invoices page").
async function chargeFenceRefusal(invoice, where) {
  const charge = await chargeInProgress(invoice);
  if (charge === 'charge_in_progress') return ownerRule(`Invoice ${invoice.invoice_number} has a saved-card charge in progress or unresolved.`, 'charge_in_progress', invoice.id);
  if (charge) return refusal(`The bar could not check for a card charge in progress, so nothing was offered. ${where}`, 'unverified', { invoice_id: invoice.id });
  return null;
}

const creditBalanceDue = (invoice) => cents(invoice.total) - cents(invoice.credit_applied);

// Billed to a payer by the row, or owed by one now: the live Bill-To owner of its visit (the credit handler re-checks it under the lock).
async function creditPayerRefusal(invoice) {
  let payerOwned = Boolean(invoice.payer_id || invoice.payer_statement_id);
  if (!payerOwned && (invoice.scheduled_service_id || invoice.service_record_id)) {
    try {
      payerOwned = Boolean(await require('../visit-linked-invoice-withdrawal').liveVisitPayerOf(db, invoice));
    } catch {
      return refusal('The bar could not check who owes this invoice, so it was not offered. Apply the credit from the Invoices page.', 'unverified', { invoice_id: invoice.id });
    }
  }
  if (!payerOwned) return null;
  return refusal('This invoice is billed to a third-party payer, and account credit belongs to the homeowner. Account credit cannot be applied to payer invoices.', 'payer_invoice', { invoice_id: invoice.id });
}

function creditCollectibleRefusal(invoice) {
  const at = invoice.id;
  try {
    require('../invoice-helpers').assertInvoiceCollectible(invoice);
  } catch (err) {
    return refusal(err.message, /already (paid|prepaid)/i.test(err.message) ? 'already_paid' : 'invoice_not_collectible', { invoice_id: at });
  }
  if (String(invoice.status || '').toLowerCase() === 'sending') return refusal('A send is in progress for this invoice. Wait a moment, then ask again.', 'send_in_progress', { invoice_id: at });
  return null;
}

function creditAmountRefusal(invoice, amountCents) {
  const at = invoice.id;
  if (cents(invoice.total) <= 0) return refusal('Invoice has no amount to collect (total is $0).', 'nothing_due', { invoice_id: at });
  const dueCents = creditBalanceDue(invoice);
  if (dueCents <= 0) return refusal('Invoice is already fully covered by credit.', 'nothing_due', { invoice_id: at });
  if (amountCents !== undefined && amountCents !== dueCents) {
    return refusal(`The balance due is ${money(dueCents / 100)}. The Invoices page applies the whole balance due from credit and has no partial application; nothing was applied.`, amountCents < dueCents ? 'partial_not_supported' : 'amount_exceeds_balance', { invoice_id: at, balance_due: dueCents / 100 });
  }
  return null;
}

async function creditSessionRefusal(invoice) {
  const at = invoice.id;
  if (invoice.stripe_payment_intent_id) {
    return toPage(`Invoice ${invoice.invoice_number} has an open card-payment session, which applying credit has to cancel.`, 'payment_session_open', at);
  }
  try {
    if (await require('../invoice-prepay').resolveInvoiceTermId(invoice, db, { strict: true })) {
      return toPage(`Invoice ${invoice.invoice_number} is an annual-plan invoice.`, 'annual_plan', at);
    }
  } catch {
    return refusal('The bar could not verify whether this is an annual-plan invoice, so it was not offered. Apply the credit from the Invoices page.', 'unverified', { invoice_id: at });
  }
  return null;
}

// Any project linked to the invoice, not only one held right now: the hold is written without moving invoices.updated_at, so
// the card's pin cannot see it. The credit handler repeats this read inside its transaction under the invoice row's lock.
async function creditProjectRefusal(invoice) {
  try {
    const project = await db('projects').where({ invoice_id: invoice.id }).first('id');
    if (project) return toPage(REPORT_PROJECT_TEXT, 'report_project', invoice.id);
  } catch {
    return refusal('The bar could not check whether this invoice is linked to a report project, so it was not offered; apply the credit on the Invoices page.', 'unverified', { invoice_id: invoice.id });
  }
  return null;
}

async function creditVisitRefusal(invoice) {
  // The visit the invoice reaches through its own link or its service record's, as the page's settlement fence resolves it.
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, db);
  if (!visitId) return null;
  const visit = await db('scheduled_services').where({ id: visitId }).first('status');
  const terminal = require('../invoice-helpers').neverRanVisitStatus(visit?.status);
  if (!terminal) return null;
  return refusal(`This invoice's visit is ${terminal.replace('_', '-')}; no credit can be applied. Void or reissue the invoice from the Invoices page.`, 'visit_terminal', { invoice_id: invoice.id });
}

// In the order the page's checks run; the first refusal wins.
const CREDIT_REFUSALS = [
  creditPayerRefusal, creditCollectibleRefusal, creditAmountRefusal, creditSessionRefusal, creditProjectRefusal, creditVisitRefusal,
  (invoice) => chargeFenceRefusal(invoice, 'Apply the credit from the Invoices page.'),
];

async function creditRefusal(invoice, amountCents) {
  for (const check of CREDIT_REFUSALS) {
    const refused = await check(invoice, amountCents);
    if (refused) return refused;
  }
  return null;
}

function creditEffects({ invoice, dueCents, balanceCents, plan, fromVisit, noteText }) {
  const effects = [
    { kind: 'billing', text: `${money(dueCents / 100)} of the customer’s account credit pays invoice ${invoice.invoice_number} in full. The invoice is marked prepaid; its balance due goes from ${money(dueCents / 100)} to $0.00.` },
    { kind: 'billing', text: `The customer’s account credit goes from ${money(balanceCents / 100)} to ${money((balanceCents - dueCents) / 100)}.` },
    { kind: 'operational', text: 'Its payment reminders stop.' },
    ...(plan ? [{ kind: 'operational', text: 'Its payment plan is completed.' }] : []),
    // The exact note, as it will be saved on the credit entry and the invoice's activity entry (trimmed to what the page keeps).
    ...(noteText ? [{ kind: 'operational', text: `Note saved with the credit entry: "${noteText}"` }] : []),
    ...(fromVisit ? [{ kind: 'operational', text: 'This invoice came from a completed visit: the customer may be enrolled in the review-request follow-up under the standing review rules (no review text goes out from this step itself).' }] : []),
    NOTHING_SENT,
    { kind: 'billing', text: 'Money moves only from account credit already on the customer’s balance. No card is used.' },
  ];
  return effects;
}

// The typed note and optional amount check (the amount must equal the balance due; checked against the invoice later).
function readCreditInput(input) {
  const noteText = blank(input?.note) ? '' : String(input.note).trim();
  if (noteText.length > NOTE_LIMIT) return refusal(`The note is longer than ${NOTE_LIMIT} characters; shorten it.`, 'note_too_long');
  if (blank(input?.amount)) return { noteText };
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return refusal('amount must be a positive dollar amount with at most two decimals', 'invalid_amount');
  return { noteText, amountCents: Math.round(amount * 100) };
}

function creditPins({ invoice, dueCents, balanceCents, plan, fromVisit, noteText }) {
  return {
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      total: cents(invoice.total),
      credit_applied: cents(invoice.credit_applied),
      due: dueCents,
      balance: balanceCents,
      customer_id: invoice.customer_id || null,
      visit: invoice.scheduled_service_id || null,
      open_payment_session: false,
      active_plan: Boolean(plan),
      from_visit: fromVisit,
      note: noteText,
    },
    _body: { waiveSetupFee: false, ...(noteText ? { note: noteText } : {}) },
    _expected: {
      status: invoice.status,
      updatedAt: msOf(invoice.updated_at),
      total: Number(invoice.total) || 0,
      creditApplied: Number(invoice.credit_applied) || 0,
      paymentIntentId: null,
      // The plan state the card showed (the handler completes any active plan): enforced on the locked invoice row.
      activePlan: Boolean(plan),
      balanceAfterCents: balanceCents - dueCents,
    },
  };
}

async function buildCreditPlan(input) {
  const read = readCreditInput(input);
  if (read.error) return read;
  const { noteText, amountCents } = read;
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const refused = await creditRefusal(invoice, amountCents);
  if (refused) return refused;
  const dueCents = creditBalanceDue(invoice);
  const balanceCents = cents((await require('../customer-credit').getBalance(invoice.customer_id)) || 0);
  if (balanceCents < dueCents) {
    return refusal(`Insufficient account credit: the balance is ${money(balanceCents / 100)} and the invoice needs ${money(dueCents / 100)} (short by ${money((dueCents - balanceCents) / 100)}). Nothing was applied. Issue more credit first, or lower the invoice.`,
      'insufficient_credit', { invoice_id: invoice.id, credit_available: balanceCents / 100, balance_due: dueCents / 100 });
  }
  const customer = await customerOf(invoice.customer_id);
  const plan = await paymentPlanOf(invoice, { activeOnly: true });
  const fromVisit = Boolean(invoice.service_record_id || invoice.visit_completion_packet_id);
  return {
    preview: true,
    tool: 'apply_invoice_credit',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    credit_available: money(balanceCents / 100),
    amount_applied: money(dueCents / 100),
    balance_due_before: money(dueCents / 100),
    balance_due_after: '$0.00',
    credit_after: money((balanceCents - dueCents) / 100),
    office_note: noteText || null,
    effects: creditEffects({ invoice, dueCents, balanceCents, plan, fromVisit, noteText }),
    sends_to_customer: false,
    ...creditPins({ invoice, dueCents, balanceCents, plan, fromVisit, noteText }),
    note: 'PREVIEW ONLY — nothing was applied. Confirm applies exactly this credit; if anything changed it refuses.',
  };
}

const verifiedCredit = verifier(buildCreditPlan, 'applied');

async function commitCredit(input, actionContext) {
  const { plan, refusal: refused } = await verifiedCredit(input, input._verified_invoice_credit_version);
  if (refused) return refused;
  const actor = await actorOf(actionContext);
  let result;
  try {
    result = await require('../../routes/admin-invoices').applyCreditFromBar({ invoiceId: plan.invoice_id, body: plan._body, actor, expected: plan._expected });
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-edit] apply credit handler failed (${err.code || err.name || 'error'})`);
    return { ...baseOf(plan), outcome_unknown: true, code: 'execution_interrupted',
      error: 'Applying the credit was interrupted — it may or may not have happened. Check the invoice and the customer’s credit before trying again.' };
  }
  if (result.status !== 200) return handlerFailure(plan, result, 'The credit was not applied', { moneyWords: /saved-card|charge/i });
  if (result.json?.invoice?.status !== 'prepaid') {
    return { ...baseOf(plan), outcome_unknown: true, code: 'credit_unverified',
      error: 'The Invoices page answered, but the invoice does not read as prepaid. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-edit] applied account credit to invoice ${plan.invoice_id}`);
  return {
    ...baseOf(plan), success: true, status: 'prepaid', applied: money(result.json.applied), credit_after: money(result.json.balance), sent_to_customer: false,
    note: `${money(result.json.applied)} of account credit was applied to invoice ${plan.invoice_number}; it is marked prepaid. Account credit left: ${money(result.json.balance)}. Nothing was sent to anyone and no card was charged.`,
  };
}

// ═════════════════════════════════════════════════════════════════
// archive_invoice / unarchive_invoice
// ═════════════════════════════════════════════════════════════════

async function buildArchivePlan(input, { undo }) {
  const tool = undo ? 'unarchive_invoice' : 'archive_invoice';
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  if (!undo) {
    if (status !== 'void') return refusal(`Only voided invoices can be archived; invoice ${invoice.invoice_number} is ${status || 'not void'}.`, 'not_voided', { invoice_id: at });
    if (invoice.archived_at) return refusal(`Invoice ${invoice.invoice_number} is already archived. Nothing was changed.`, 'already_archived', { invoice_id: at });
  } else if (!invoice.archived_at) {
    return refusal(`Invoice ${invoice.invoice_number} is not archived. Nothing was changed.`, 'not_archived', { invoice_id: at });
  }
  const customer = await customerOf(invoice.customer_id);
  return {
    preview: true,
    tool,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    amount: money(invoice.total),
    effects: [
      { kind: 'operational', text: undo
        ? `Invoice ${invoice.invoice_number} goes back into the default invoice list. Its status (${invoice.status}) and amounts do not change.`
        : `Invoice ${invoice.invoice_number} leaves the default invoice list. It stays void and stays on record; the Invoices page can unarchive it.` },
      NOTHING_SENT,
    ],
    sends_to_customer: false,
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      archived: Boolean(invoice.archived_at),
      total: cents(invoice.total),
    },
    _expected: { status: invoice.status, updatedAt: msOf(invoice.updated_at), archived: Boolean(invoice.archived_at) },
    note: `PREVIEW ONLY — nothing was changed. Confirm ${undo ? 'unarchives' : 'archives'} exactly this invoice; if it changed it refuses.`,
  };
}

const verifiedArchive = verifier((input) => buildArchivePlan(input, { undo: false }), 'archived');
const verifiedUnarchive = verifier((input) => buildArchivePlan(input, { undo: true }), 'unarchived');

async function commitArchive(input, { undo }) {
  const { plan, refusal: refused } = await (undo ? verifiedUnarchive : verifiedArchive)(input, undo ? input._verified_invoice_unarchive_version : input._verified_invoice_archive_version);
  if (refused) return refused;
  const bar = require('../../routes/admin-invoices');
  let result;
  try {
    result = await (undo ? bar.unarchiveInvoiceFromBar : bar.archiveInvoiceFromBar)({ invoiceId: plan.invoice_id, expected: plan._expected });
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-edit] ${plan.tool} handler failed (${err.code || err.name || 'error'})`);
    return { ...baseOf(plan), outcome_unknown: true, code: 'execution_interrupted',
      error: `The ${undo ? 'unarchive' : 'archive'} was interrupted — it may or may not have happened. Check the invoice before trying again.` };
  }
  if (result.status !== 200) return handlerFailure(plan, result, `The invoice was not ${undo ? 'unarchived' : 'archived'}`);
  if (Boolean(result.json?.archived_at) === undo) {
    return { ...baseOf(plan), outcome_unknown: true, code: 'archive_unverified',
      error: `The Invoices page answered, but the invoice does not read as ${undo ? 'unarchived' : 'archived'}. Check the invoice before trying again.` };
  }
  logger.info(`[intelligence-bar:invoice-edit] ${undo ? 'unarchived' : 'archived'} invoice ${plan.invoice_id}`);
  return {
    ...baseOf(plan), success: true, status: plan.status, archived: !undo, sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is ${undo ? 'back in the default invoice list' : 'archived (out of the default invoice list)'}. Nothing was sent to anyone.`,
  };
}

// ═════════════════════════════════════════════════════════════════
// unvoid_invoice
// ═════════════════════════════════════════════════════════════════

const UNVOID_ANNUAL = 'belongs to an annual prepay term; manage it from Annual prepay instead';

function unvoidStatusRefusal(invoice) {
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'void') return null;
  return refusal(`Only a voided invoice can be unvoided; invoice ${invoice.invoice_number} is ${status || 'not void'}.`, 'not_voided', { invoice_id: invoice.id });
}

// What the invoice row itself says (no read): annual-plan stamps, a deposit credit, a recorded payment.
function unvoidRowRefusal(invoice) {
  const at = invoice.id;
  const n = invoice.invoice_number;
  if (invoice.annual_prepay_term_id) return toPage(`Invoice ${n} ${UNVOID_ANNUAL}.`, 'annual_plan', at);
  if (invoice.annual_prepay_covered_term_id) return toPage(`Invoice ${n} was settled as annual prepay coverage before it was voided.`, 'annual_plan_covered', at);
  if (/annual prepay/i.test(String(invoice.title || ''))) return toPage(`Invoice ${n} is an annual prepay charge.`, 'annual_plan', at);
  if (/\[prepay-switch-superseded-by:[^\]]+\]/.test(String(invoice.notes || ''))) return toPage(`Invoice ${n} was superseded by an annual prepay switch.`, 'annual_plan', at);
  if (parseLines(invoice.line_items).some((li) => li.category === 'deposit_credit')) {
    return toPage(`The deposit credit on invoice ${n} went back to the customer’s deposit when it was voided; create a replacement invoice.`, 'deposit_credit', at);
  }
  if (invoice.payment_recorded_at) return ownerRule(`A payment is already recorded on invoice ${n}.`, 'payment_recorded', at);
  return null;
}

// The records a restore must not meet: an owning annual term, a payment on file, a finalized payer statement.
async function unvoidRecordRefusal(invoice) {
  const at = invoice.id;
  const n = invoice.invoice_number;
  if (await db('annual_prepay_terms').where({ prepay_invoice_id: at }).first('id')) return toPage(`Invoice ${n} ${UNVOID_ANNUAL}.`, 'annual_plan', at);
  const paid = await db('payments').whereIn('status', ['paid', 'processing']).whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [String(at)]).first('id', 'status');
  if (paid) return ownerRule(`A payment (${paid.status}) is on file for invoice ${n}.`, 'payment_on_file', at);
  const statement = await statementOf(invoice);
  if (statement && statement.status !== 'open') return toPage(`Invoice ${n} is on a finalized payer statement; bill it as a new line on the next statement.`, 'finalized_statement', at);
  return null;
}

const BILL_TO_REASONS = new Set(['packet_invoice', 'payer_billed', 'payer_statement', 'linked_payer_owner']);
const QUEUE_REASONS = new Set(['queued_message', 'followup_sequence']);

// The card's reason for a restore that would do more than restore the row (InvoiceService._unvoidObligationReason, the one list).
function unvoidObligationRefusal(invoice, obligation) {
  const at = invoice.id;
  const n = invoice.invoice_number;
  if (!obligation) return null;
  if (obligation === 'membership_dues') return toPage(`Invoice ${n} is a membership-dues invoice: restoring it re-claims a month of coverage.`, 'membership_dues', at);
  if (BILL_TO_REASONS.has(obligation)) {
    return toPage(`Invoice ${n} is a combined-visit, payer-billed or statement invoice: restoring it re-checks who owes it, and for every withdrawn combined-visit invoice of the customer that can release it to the send queue (an invoice text).`, obligation, at);
  }
  if (QUEUE_REASONS.has(obligation)) {
    return toPage(`Invoice ${n} still has a queued message or an active reminder sequence: restoring it cancels those and can hand the invoice to the sender again (an invoice text).`, obligation, at);
  }
  return toPage(`Invoice ${n} carries a bait-station setup fee: restoring it can also retire a sibling setup invoice, clear a visit's pending setup fee or close an office billing alert.`, 'setup_fee', at);
}

async function unvoidSideEffectRefusal(invoice) {
  try {
    return unvoidObligationRefusal(invoice, await require('../invoice')._unvoidObligationReason(db, invoice));
  } catch (err) {
    logger.warn(`[intelligence-bar:invoice-edit] unvoid obligation check failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not check what else restoring this invoice would change, so nothing was offered. Unvoid it from the Invoices page.', 'unverified', { invoice_id: invoice.id });
  }
}

// In order; the first refusal wins.
// The linked-visit eligibility InvoiceService.unvoidInvoice enforces (cancelled, rescheduled, no-show, skipped, free re-service,
// stamped $0, annual-prepaid): checked at preview so a card that can never succeed is not offered. Fails closed.
async function unvoidVisitRefusal(invoice) {
  try {
    await require('../invoice')._assertUnvoidableLinkedVisit(db, invoice);
    return null;
  } catch (err) {
    return refusal(`This invoice cannot be unvoided: ${err.message || 'its linked visit could not be checked'}. Nothing was changed.`, 'visit_refuses_unvoid', { invoice_id: invoice.id });
  }
}

const UNVOID_REFUSALS = [
  unvoidStatusRefusal, unvoidRowRefusal, unvoidRecordRefusal, unvoidSideEffectRefusal, unvoidVisitRefusal,
  (invoice) => chargeFenceRefusal(invoice, 'Unvoid it from the Invoices page.'),
];

async function unvoidRefusal(invoice) {
  for (const check of UNVOID_REFUSALS) {
    const refused = await check(invoice);
    if (refused) return refused;
  }
  return null;
}

function unvoidEffects({ invoice, visit, setupFeeTied = false }) {
  return [
    { kind: 'billing', text: `Invoice ${invoice.invoice_number} (${money(invoice.total)}) becomes a draft again: editable and payable (collectible) once it is sent. It is not sent by this step.` },
    { kind: 'operational', text: 'Its payment reminders do NOT restart now: the stopped reminder sequence stays stopped until the invoice is sent again.' },
    { kind: 'operational', text: 'Nothing queued for it is cancelled or handed over: an invoice with a queued message, a reminder sequence, a packet, a payer or statement, a setup fee or a dues month stays on the Invoices page. Account credit applied before the void was returned then and is not applied again.' },
    ...(invoice.archived_at ? [{ kind: 'operational', text: 'It also leaves the archive and returns to the default invoice list.' }] : []),
    ...(invoice.stripe_payment_intent_id ? [{ kind: 'operational', text: 'Its old card-payment session is checked with Stripe and must be cancelled; if it is live the unvoid refuses.' }] : []),
    { kind: 'operational', text: visit
      ? `Its linked visit (${visit.date || 'no date'}, ${visit.status || 'no status'}) is checked: a cancelled visit refuses the unvoid. The visit is not changed.`
      : 'It is not linked to a visit.' },
    ...(setupFeeTied ? [SETUP_FEE_EFFECT] : []),
    NOTHING_SENT,
  ];
}

async function buildUnvoidPlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const refused = await unvoidRefusal(invoice);
  if (refused) return refused;
  const visit = await linkedVisit(invoice);
  const customer = await customerOf(invoice.customer_id);
  const setupFeeTied = await setupFeeAlertTied(invoice);
  return {
    preview: true,
    tool: 'unvoid_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    amount: money(invoice.total),
    becomes: 'draft (editable, collectible again)',
    reminders_restart: false,
    effects: unvoidEffects({ invoice, visit, setupFeeTied }),
    sends_to_customer: false,
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      updated_at: msOf(invoice.updated_at),
      total: cents(invoice.total),
      customer_id: invoice.customer_id || null,
      payer_statement_id: invoice.payer_statement_id || null,
      payment_intent: invoice.stripe_payment_intent_id || null,
      archived: Boolean(invoice.archived_at),
      visit: visit ? `${visit.id}:${visit.status}:${visit.date}:${visit.window}` : null,
      lines: digest(parseLines(invoice.line_items)),
      setup_fee_tied: setupFeeTied,
    },
    _expected: { status: invoice.status, updatedAt: msOf(invoice.updated_at) },
    note: 'PREVIEW ONLY — nothing was changed. Confirm restores exactly this invoice to a draft; if it changed it refuses.',
  };
}

const verifiedUnvoid = verifier(buildUnvoidPlan, 'unvoided');

async function commitUnvoid(input) {
  const { plan, refusal: refused } = await verifiedUnvoid(input, input._verified_invoice_unvoid_version);
  if (refused) return refused;
  let result;
  try {
    result = await require('../../routes/admin-invoices').unvoidInvoiceFromBar({ invoiceId: plan.invoice_id, expected: plan._expected });
  } catch (err) {
    const now = await db('invoices').where({ id: plan.invoice_id }).first('status').catch(() => null);
    if (now && now.status !== 'void') {
      return { ...baseOf(plan), success: true, status: now.status, sent_to_customer: false, warning: true,
        note: `Invoice ${plan.invoice_number} is no longer void, but a follow-up step reported a problem. Check the invoice on the Invoices page.` };
    }
    logger.error(`[intelligence-bar:invoice-edit] unvoid handler failed (${err.code || err.name || 'error'})`);
    return { ...baseOf(plan), outcome_unknown: true, code: 'execution_interrupted',
      error: 'The unvoid was interrupted — it may or may not have happened. Check the invoice before trying again.' };
  }
  if (result.status !== 200) {
    const failed = handlerFailure(plan, result, 'The invoice was not unvoided', { moneyWords: /payment already applied|saved-card charge|unresolved (Stripe )?charge/i });
    // The restore's own in-transaction fence for a setup-fee or dues invoice: the Invoices page does those.
    return /Cannot unvoid from the bar/.test(String(result.json?.error || '')) ? { ...failed, code: 'needs_invoices_page' } : failed;
  }
  if (result.json?.status !== 'draft') {
    return { ...baseOf(plan), outcome_unknown: true, code: 'unvoid_unverified',
      error: 'The Invoices page answered, but the invoice does not read as a draft. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-edit] unvoided invoice ${plan.invoice_id}`);
  return {
    ...baseOf(plan), success: true, status: 'draft', sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is a draft again (editable and collectible). Nothing was sent to anyone; its reminders restart only when it is sent.`,
  };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (!TOOL_NAMES.includes(toolName) || !preview || preview.preview !== true || preview.tool !== toolName) return [];
  const who = preview.customer_name || preview.customer_id;
  const effects = (preview.effects || []).map(({ kind, text }) => ({ kind, text }));
  if (toolName === 'edit_invoice') {
    return [
      { kind: 'billing', text: `Edit invoice ${preview.invoice_number} for ${who} (${preview.status}): total ${preview.old_total} -> ${preview.new_total}` },
      ...(preview.changes || []).map((c) => ({ kind: c.field === 'Total' ? 'billing' : 'operational', text: `${c.field}: ${c.before} -> ${c.after}`, before: c.before, after: c.after })),
      ...effects,
    ];
  }
  if (toolName === 'apply_invoice_credit') {
    return [
      { kind: 'billing', text: `Apply account credit to invoice ${preview.invoice_number} for ${who}: ${preview.amount_applied} of ${preview.credit_available} available` },
      { kind: 'billing', text: `Balance due: ${preview.balance_due_before} -> ${preview.balance_due_after}; account credit: ${preview.credit_available} -> ${preview.credit_after}`, before: preview.balance_due_before, after: preview.balance_due_after },
      ...effects,
    ];
  }
  if (toolName === 'unvoid_invoice') {
    return [
      { kind: 'billing', text: `Unvoid invoice ${preview.invoice_number} for ${who}: ${preview.amount}, void -> draft` },
      ...effects,
    ];
  }
  return [
    { kind: 'operational', text: `${toolName === 'archive_invoice' ? 'Archive' : 'Unarchive'} invoice ${preview.invoice_number} for ${who} (${preview.status}, ${preview.amount})` },
    ...effects,
  ];
}

// ── dispatch ────────────────────────────────────────────────────

const HANDLERS = {
  edit_invoice: { build: buildEditPlan, commit: commitEdit, failed: 'Could not prepare the edit', interrupted: 'The edit was interrupted — it may or may not have been saved. Check the invoice before trying again.' },
  apply_invoice_credit: { build: buildCreditPlan, commit: commitCredit, failed: 'Could not prepare the credit', interrupted: 'Applying the credit was interrupted — it may or may not have happened. Check the invoice and the customer’s credit before trying again.' },
  archive_invoice: { build: (input) => buildArchivePlan(input, { undo: false }), commit: (input) => commitArchive(input, { undo: false }), failed: 'Could not prepare the archive', interrupted: 'The archive was interrupted — it may or may not have happened. Check the invoice before trying again.' },
  unarchive_invoice: { build: (input) => buildArchivePlan(input, { undo: true }), commit: (input) => commitArchive(input, { undo: true }), failed: 'Could not prepare the unarchive', interrupted: 'The unarchive was interrupted — it may or may not have happened. Check the invoice before trying again.' },
  unvoid_invoice: { build: buildUnvoidPlan, commit: commitUnvoid, failed: 'Could not prepare the unvoid', interrupted: 'The unvoid was interrupted — it may or may not have happened. Check the invoice before trying again.' },
};

async function executeInvoiceEditTool(toolName, input = {}, actionContext = {}) {
  const handler = HANDLERS[toolName];
  if (!handler) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin routes; the registry refuses a technician too. The confirmed run needs a
  // positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Changing invoices is limited to admin accounts', 'permission_denied');
  }
  if (!invoiceEditsLive()) return refusal('Editing invoices from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await handler.commit(input, actionContext) : await handler.build(input);
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-edit] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: handler.interrupted }
      : { error: handler.failed };
  }
}

module.exports = {
  INVOICE_EDIT_TOOLS,
  INVOICE_EDIT_TOOL_NAMES: TOOL_NAMES,
  executeInvoiceEditTool,
  invoiceEditsLive,
  cardLines,
};
