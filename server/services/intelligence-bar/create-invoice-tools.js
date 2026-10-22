/**
 * Intelligence Bar — create a DRAFT invoice
 * server/services/intelligence-bar/create-invoice-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards): a card that replays a
 * screen's own handler.
 *
 *   create_invoice — the Invoices page "Create invoice" (POST /admin/invoices), run through admin-invoices.js
 *                    createInvoiceFromBar: the same handler, in process, so the mint lock, the accepted-estimate
 *                    setup-fee reconcile and every refusal are the route's own. When the operator names a
 *                    completed visit and one amount, it runs the visit convenience route instead
 *                    (POST /admin/invoices/from-service, createInvoiceFromServiceFromBar).
 *
 * It creates a DRAFT only. It never sends (no text, email or call), never charges a card and never records a
 * payment. The card says so and says to use send_invoice to send it afterwards.
 *
 * What the card does not take (the Invoices page keeps them): discounts, a custom email message, attachments,
 * scheduled sending, a deposit credit. A customer whose invoices go to a third-party payer (Bill-To) is left to
 * the Invoices page, because that invoice is addressed to the payer and may join a payer statement. A visit
 * invoice that would consume an estimate deposit or a granted retention offer is left to the page too (the card
 * could not show that total), and the visit route is handed refuseDepositCredit so it refuses instead.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only, dark behind
 * GATE_IB_CREATE_INVOICE (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (customer, every line,
 *                  notes, dates, the tax rate, the server-computed subtotal, tax and total, the linked visit and
 *                  the invoices that already bill it).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler with
 *                  exactly the carded body (the due date included) and the card's total. The handler creates the
 *                  invoice in one transaction and rolls it back if the total it computed differs from the card's.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString, addETDays, etCalendarDayOf } = require('../../utils/datetime-et');

function createInvoiceLive() {
  return require('../../config/feature-gates').ibCreateInvoiceLive() === true;
}

const MAX_LINES = 25;
const MAX_QUANTITY = 10000;
const MAX_AMOUNT = 1000000;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 200;
const NOTES_LIMIT = 1000;
const DEFAULT_DUE_DAYS = 30;

const CREATE_INVOICE_TOOLS = [
  {
    name: 'create_invoice',
    description: `Create ONE new DRAFT invoice for a customer: the Invoices page "Create invoice" button. The first call returns a PREVIEW and writes nothing: the customer, every line with its amount, the tax, the total, the due date and the linked visit. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed, and refuses if the total the server computes is not the total on the card.
It creates a DRAFT only. Nothing is sent to the customer (no text, email or call), no card is charged and no payment is recorded. To send it, use send_invoice afterwards. The Invoices page can edit or void the draft.
Two ways to call it:
1. Lines: customer_id, a title, and line_items (each a description, a quantity and a unit_price above 0; at most 25 lines). Optional: notes, due_date (YYYY-MM-DD; default 30 days from today), service_date (YYYY-MM-DD), tax_rate (a fraction such as 0.07; only a commercial customer is taxed, and a residential customer is never taxed), service_record_id (links a completed visit of this customer).
2. From a completed visit the operator names: customer_id, service_record_id and amount (above 0), optional description. No line_items, title, notes or dates. Tax follows the customer's rules.
Refused with the reason: no customer, an amount of 0 or less, no lines, more than 25 lines, a visit that is not this customer's, a customer whose invoices go to a third-party payer (use the Invoices page), and a visit invoice that would use an estimate deposit or a retention offer (use the Invoices page). Discounts, custom email text, attachments and scheduled sending are not offered here. Admin only.
Use for: "create an invoice for this customer", "invoice them $150 for the extra visit", "bill this customer", "make a draft invoice", "invoice this completed visit for $120".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to invoice (from query_customers / get_customer_detail)' },
        title: { type: 'string', description: 'The invoice title, for example "Mosquito treatment" (lines mode)' },
        line_items: {
          type: 'array',
          description: 'The invoice lines (lines mode): at most 25',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What the line bills' },
              quantity: { type: 'number', description: 'How many (default 1)' },
              unit_price: { type: 'number', description: 'Price of one, in dollars, above 0' },
            },
            required: ['description', 'unit_price'],
          },
        },
        notes: { type: 'string', description: 'Optional invoice notes (lines mode)' },
        due_date: { type: 'string', description: 'Optional due date YYYY-MM-DD (lines mode); default 30 days from today' },
        service_date: { type: 'string', description: 'Optional service date YYYY-MM-DD (lines mode)' },
        tax_rate: { type: 'number', description: 'Optional tax rate as a fraction, for example 0.07 (lines mode); commercial customers only' },
        service_record_id: { type: 'string', format: 'uuid', description: 'A completed visit of this customer: links it (lines mode) or bills it (visit mode, with amount)' },
        amount: { type: 'number', description: 'Visit mode: the amount to bill for the completed visit, in dollars, above 0' },
        description: { type: 'string', description: 'Visit mode: optional line description (default: the visit’s service type)' },
      },
      required: ['customer_id'],
    },
    _sideEffects: true,
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const toPage = (error, reason) => refusal(`${error} Create it from the Invoices page.`, 'needs_invoices_page', { reason });
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const personName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;

// A real calendar day written YYYY-MM-DD.
function validDay(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}
// A dollar amount with at most two decimals, above 0.
function dollars(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? Math.round(n * 100) / 100 : null;
}
const dayOf = (value) => (value ? (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : etCalendarDayOf(value)) : null);

// What the call asks for, checked and normalised: { mode, ... } or a refusal.
function readInput(input) {
  const rawCustomer = String(input?.customer_id || '').trim();
  if (!rawCustomer) return refusal('A customer is required: name the customer to invoice', 'invalid_target');
  if (!UUID_RE.test(rawCustomer)) return refusal('A valid customer_id is required', 'invalid_target');
  const customerId = rawCustomer.toLowerCase();
  const rawRecord = String(input?.service_record_id || '').trim();
  if (rawRecord && !UUID_RE.test(rawRecord)) return refusal('A valid service_record_id is required', 'invalid_target');
  const serviceRecordId = rawRecord ? rawRecord.toLowerCase() : null;
  const hasLines = input?.line_items !== undefined && input?.line_items !== null;
  const hasAmount = input?.amount !== undefined && input?.amount !== null;

  if (hasAmount) {
    if (hasLines) return refusal('Give either line_items or one visit amount, not both', 'invalid_input');
    if (!serviceRecordId) return refusal('Billing a visit needs its service_record_id', 'invalid_input');
    const extras = ['title', 'notes', 'due_date', 'service_date', 'tax_rate'].filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '');
    if (extras.length) return refusal(`Billing a visit takes only the visit, the amount and a description; leave out ${extras.join(', ')}`, 'invalid_input');
    const amount = dollars(input.amount);
    if (amount === null) return refusal('The amount must be above $0 with at most two decimals', 'invalid_amount');
    const description = clean(input.description);
    if (description.length > DESCRIPTION_LIMIT) return refusal(`The description is limited to ${DESCRIPTION_LIMIT} characters`, 'invalid_input');
    return { mode: 'from_visit', customerId, serviceRecordId, amount, description };
  }

  if (input?.description !== undefined && input.description !== null && input.description !== '') {
    return refusal('description belongs to billing a visit with an amount; put each line’s text in line_items', 'invalid_input');
  }
  if (!hasLines) return refusal('Give line_items, or a service_record_id with an amount', 'invalid_input');
  if (!Array.isArray(input.line_items) || !input.line_items.length) return refusal('At least one line is required', 'invalid_input');
  if (input.line_items.length > MAX_LINES) return refusal(`An invoice from the bar has at most ${MAX_LINES} lines; use the Invoices page for more`, 'too_many_lines');
  const lines = [];
  for (const [i, raw] of input.line_items.entries()) {
    const at = `Line ${i + 1}`;
    const description = clean(raw?.description);
    if (!description) return refusal(`${at} needs a description`, 'invalid_input');
    if (description.length > DESCRIPTION_LIMIT) return refusal(`${at}: the description is limited to ${DESCRIPTION_LIMIT} characters`, 'invalid_input');
    const quantity = raw?.quantity === undefined || raw?.quantity === null || raw?.quantity === '' ? 1 : Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) return refusal(`${at}: the quantity must be above 0`, 'invalid_amount');
    const unitPrice = dollars(raw?.unit_price);
    if (unitPrice === null) return refusal(`${at}: the unit price must be above $0 with at most two decimals`, 'invalid_amount');
    const amount = Math.round(quantity * unitPrice * 100) / 100;
    if (!(amount > 0)) return refusal(`${at}: the line amount must be above $0`, 'invalid_amount');
    lines.push({ description, quantity, unit_price: unitPrice, amount });
  }
  const title = clean(input.title);
  if (title.length > TITLE_LIMIT) return refusal(`The title is limited to ${TITLE_LIMIT} characters`, 'invalid_input');
  if (!title && !serviceRecordId) return refusal('A title is required', 'invalid_input');
  const notes = String(input.notes ?? '').trim();
  if (notes.length > NOTES_LIMIT) return refusal(`The notes are limited to ${NOTES_LIMIT} characters`, 'invalid_input');
  const wantsDue = input.due_date !== undefined && input.due_date !== null && input.due_date !== '';
  const dueDate = wantsDue ? validDay(input.due_date) : null;
  if (wantsDue && !dueDate) return refusal('due_date must be a real date written YYYY-MM-DD', 'invalid_input');
  const wantsService = input.service_date !== undefined && input.service_date !== null && input.service_date !== '';
  const serviceDate = wantsService ? validDay(input.service_date) : null;
  if (wantsService && !serviceDate) return refusal('service_date must be a real date written YYYY-MM-DD', 'invalid_input');
  let taxRate;
  if (input.tax_rate !== undefined && input.tax_rate !== null && input.tax_rate !== '') {
    taxRate = Number(input.tax_rate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) return refusal('tax_rate is a fraction between 0 and 1, for example 0.07', 'invalid_input');
  }
  return { mode: 'lines', customerId, serviceRecordId, lines, title, notes, dueDate, serviceDate, taxRate };
}

async function loadCustomer(customerId) {
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
  return customer || null;
}

// The completed visit the invoice links or bills: it must be this customer's own.
async function loadVisit(customerId, serviceRecordId) {
  if (!serviceRecordId) return { visit: null };
  const sr = await db('service_records').where({ id: serviceRecordId, customer_id: customerId })
    .first('id', 'customer_id', 'service_type', 'service_date', 'scheduled_service_id');
  if (!sr) return { refusal: refusal('That visit is not one of this customer’s service records, so nothing was offered.', 'record_unavailable') };
  const existing = await db('invoices').where({ service_record_id: serviceRecordId })
    .whereNotIn('status', ['void', 'canceled', 'cancelled'])
    .select('id', 'invoice_number', 'status', 'total');
  return {
    visit: {
      id: sr.id, service_type: sr.service_type || null, date: dayOf(sr.service_date), scheduled_service_id: sr.scheduled_service_id || null,
      invoices: existing.map((r) => ({ id: r.id, number: r.invoice_number, status: r.status, total: cents(r.total) })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    },
  };
}

// Invoices the page would address to a third-party payer, and what a visit invoice would consume beyond the card.
async function pageOnlyRefusal(customer, visit, mode) {
  try {
    const resolved = await require('../payer').resolveForInvoice({
      database: db, customerId: customer.id, customer, scheduledServiceId: visit?.scheduled_service_id || null, throwOnError: true,
    });
    if (resolved.payerId) return toPage('This customer’s invoices go to a third-party payer (Bill-To), so the invoice would be addressed to the payer.', 'payer_billed');
    if (mode === 'from_visit' && await db('retention_offers').where({ customer_id: customer.id, status: 'granted' }).first('id')) {
      return toPage('A retention offer is granted for this customer and could discount this visit invoice, which the card cannot show.', 'retention_offer');
    }
  } catch (err) {
    logger.warn(`[intelligence-bar:create-invoice] link check failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not check who this invoice is billed to, so nothing was offered. Create it from the Invoices page.', 'unverified');
  }
  return null;
}

// The totals the server will store, from the service's own mirror of create().
async function serverTotals({ customer, subtotal, visit, title, taxRate }) {
  try {
    return await require('../invoice').previewInvoiceTotals({
      customerId: customer.id, customer, amount: subtotal, serviceRecordId: visit?.id || null, title: title || null, taxRate,
    });
  } catch (err) {
    logger.warn(`[intelligence-bar:create-invoice] totals preview failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

function planEffects({ name, city, mode, totals, dueDate, visit }) {
  const who = `${name}${city ? ` (${city})` : ''}`;
  return [
    { kind: 'billing', text: `Creates a DRAFT invoice for ${who}: ${money(totals.total)} (${money(totals.subtotal)} plus ${money(totals.tax_amount)} tax)${dueDate ? `, due ${dueDate}` : ', due 30 days after it is created'}.` },
    { kind: 'comms', text: 'It is only a draft: nothing is sent. No text, email or call goes to the customer or anyone else. To send it, use send_invoice afterwards.' },
    { kind: 'billing', text: 'No card is charged and no payment is recorded.' },
    { kind: 'operational', text: visit
      ? `${mode === 'from_visit' ? 'It bills' : 'It links'} the ${visit.service_type || 'service'} visit of ${visit.date || 'no date'}; the visit itself is not changed.`
      : 'It is not linked to a visit.' },
    ...(visit && visit.invoices.length
      ? [{ kind: 'billing', text: `Check before approving: ${visit.invoices.map((i) => `${i.number} (${i.status}, ${money(i.total / 100)})`).join(', ')} already ${visit.invoices.length === 1 ? 'bills' : 'bill'} this visit.` }]
      : []),
    { kind: 'billing', text: 'The Invoices page can edit the draft or void it.' },
  ];
}

// Everything the card approves: a change in any of it is drift.
function versionOf({ customer, name, mode, body, visit, totals }) {
  return {
    mode,
    customer_id: customer.id,
    customer: `${name || ''}|${customer.city || ''}`,
    body: digest(body),
    visit: visit ? `${visit.id}:${visit.service_type}:${visit.date}:${visit.scheduled_service_id || ''}` : null,
    visit_invoices: visit ? visit.invoices.map((i) => `${i.id}:${i.status}:${i.total}`) : [],
    subtotal: cents(totals.subtotal),
    tax_rate: totals.tax_rate === undefined || totals.tax_rate === null ? null : Number(totals.tax_rate),
    tax: cents(totals.tax_amount),
    total: cents(totals.total),
  };
}

async function buildPlan(input) {
  const read = readInput(input);
  if (read.error) return read;
  const customer = await loadCustomer(read.customerId);
  if (!customer) return refusal('Customer not found', 'customer_not_found');
  const { visit, refusal: visitRefusal } = await loadVisit(customer.id, read.serviceRecordId);
  if (visitRefusal) return visitRefusal;
  const pageOnly = await pageOnlyRefusal(customer, visit, read.mode);
  if (pageOnly) return pageOnly;

  const fromVisit = read.mode === 'from_visit';
  const subtotal = fromVisit ? read.amount : Math.round(read.lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  if (!(subtotal > 0)) return refusal('The invoice total must be above $0', 'invalid_amount');
  const totals = await serverTotals({ customer, subtotal, visit, title: fromVisit ? null : read.title, taxRate: fromVisit ? undefined : read.taxRate });
  if (!totals) return refusal('The bar could not work out the tax and total, so nothing was offered. Create it from the Invoices page.', 'unverified');

  // The exact body the handler receives. The due date is always explicit for lines mode, so the invoice gets the carded date.
  const dueDate = fromVisit ? null : (read.dueDate || etDateString(addETDays(new Date(), DEFAULT_DUE_DAYS)));
  const body = fromVisit
    ? { serviceRecordId: read.serviceRecordId, amount: read.amount, ...(read.description ? { description: read.description } : {}) }
    : {
      customerId: customer.id,
      ...(read.serviceRecordId ? { serviceRecordId: read.serviceRecordId } : {}),
      ...(read.title ? { title: read.title } : {}),
      lineItems: read.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, amount: l.amount })),
      notes: read.notes || null,
      dueDate,
      ...(read.serviceDate ? { serviceDate: read.serviceDate } : {}),
      ...(read.taxRate !== undefined ? { taxRate: read.taxRate } : {}),
    };
  const name = personName(customer) || customer.id;
  const lines = fromVisit
    ? [{ description: read.description || visit.service_type || 'Service', quantity: 1, unit_price: read.amount, amount: read.amount }]
    : read.lines;
  return {
    preview: true,
    tool: 'create_invoice',
    mode: read.mode,
    customer_id: customer.id,
    customer_name: name,
    customer_city: customer.city || null,
    title: fromVisit ? null : (read.title || null),
    lines: lines.map((l) => `${l.description}: ${l.quantity} x ${money(l.unit_price)} = ${money(l.amount)}`),
    subtotal: money(totals.subtotal),
    tax_rate: totals.tax_rate ?? null,
    tax: money(totals.tax_amount),
    total: money(totals.total),
    due_date: dueDate,
    service_date: fromVisit ? (visit.date || null) : (read.serviceDate || visit?.date || null),
    notes: fromVisit ? null : (read.notes || null),
    linked_visit: visit ? `${visit.service_type || 'Service'} ${visit.date || ''}`.trim() : null,
    status: 'draft',
    effects: planEffects({ name, city: customer.city, mode: read.mode, totals, dueDate, visit }),
    sends_to_customer: false,
    charges_card: false,
    _version: versionOf({ customer, name, mode: read.mode, body, visit, totals }),
    _body: body,
    _expectedTotalCents: cents(totals.total),
    note: 'PREVIEW ONLY — nothing was created. Confirm creates exactly this draft; if anything changed it refuses. The draft is not sent: use send_invoice to send it.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this invoice.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was created: ${plan.error}`, code: plan.code, preview_changed: true, ...(plan.reason ? { reason: plan.reason } : {}) } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The invoice details changed after the card was shown, so nothing was created. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

async function commitCreate(input) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_invoice_create_version);
  if (refused) return refused;
  const base = { customer_id: plan.customer_id, customer_name: plan.customer_name };
  const invoices = require('../../routes/admin-invoices');
  const run = plan.mode === 'from_visit' ? invoices.createInvoiceFromServiceFromBar : invoices.createInvoiceFromBar;
  let result;
  try {
    result = await run({ body: plan._body, expectedTotalCents: plan._expectedTotalCents });
  } catch (err) {
    // A 409 from the visit route (a deposit would apply, the price moved) is thrown before anything is created.
    if (err?.status === 409) {
      return { ...base, failed: true, code: 'create_refused', error: `The invoice was not created: ${err.message}` };
    }
    // The handler threw after the card was approved. The create may or may not have committed: never invite a retry.
    logger.error(`[intelligence-bar:create-invoice] handler failed (${err.code || err.name || 'error'})`);
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The invoice creation was interrupted — it may or may not have happened. Check the customer’s invoices before trying again.' };
  }
  const { status, json } = result;
  if (status !== 201) {
    const message = String(json?.error || 'the Invoices page refused it');
    const drift = json?.code === 'IB_TOTAL_MISMATCH';
    return { ...base, failed: true, code: drift ? 'preview_changed' : status === 404 ? 'not_found' : 'create_refused',
      error: `The invoice was not created: ${message}`, ...(drift ? { preview_changed: true } : {}) };
  }
  if (!json?.id || json.status !== 'draft') {
    return { ...base, outcome_unknown: true, code: 'create_unverified',
      error: 'The Invoices page answered, but the result does not read as a draft invoice. Check the customer’s invoices before trying again.' };
  }
  logger.info(`[intelligence-bar:create-invoice] created draft invoice ${json.id}`);
  return {
    ...base, success: true, status: 'draft', invoice_id: json.id, invoice_number: json.invoice_number || null,
    amount: money(json.total), due_date: dayOf(json.due_date), sent_to_customer: false,
    note: `Draft invoice${json.invoice_number ? ` ${json.invoice_number}` : ''} for ${money(json.total)} is created. Nothing was sent and no card was charged. To send it, use send_invoice.`,
  };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'create_invoice' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'billing', text: `Create a draft invoice for ${preview.customer_name}${preview.customer_city ? ` (${preview.customer_city})` : ''}: ${preview.total}${preview.title ? `, "${preview.title}"` : ''}` },
    ...(preview.lines || []).map((text) => ({ kind: 'billing', text: `Line: ${text}` })),
    { kind: 'billing', text: `Subtotal ${preview.subtotal}, tax ${preview.tax}, total ${preview.total}` },
    { kind: 'billing', text: `Due: ${preview.due_date || '30 days after it is created'}${preview.service_date ? `; service date ${preview.service_date}` : ''}` },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executeCreateInvoiceTool(toolName, input = {}, actionContext = {}) {
  if (!CREATE_INVOICE_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin create routes; the registry refuses a technician too. The confirmed
  // run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Creating invoices is limited to admin accounts', 'permission_denied');
  }
  if (!createInvoiceLive()) return refusal('Creating an invoice from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitCreate(input) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:create-invoice] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The invoice creation was interrupted — it may or may not have happened. Check the customer’s invoices before trying again.' }
      : { error: 'Could not prepare the invoice' };
  }
}

module.exports = {
  CREATE_INVOICE_TOOLS,
  executeCreateInvoiceTool,
  createInvoiceLive,
  cardLines,
};
