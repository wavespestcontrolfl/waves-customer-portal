/**
 * Intelligence Bar — the Invoices page's edit-type actions
 * server/services/intelligence-bar/invoice-edit-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards): a card that replays a screen's
 * own handler. Four tools, each its own confirm card, all dark behind GATE_IB_INVOICE_EDITS (which needs GATE_IB_PLATFORM):
 *
 *   edit_invoice         PUT  /admin/invoices/:id            (invoiceUpdateHandler -> InvoiceService.update)
 *                        title, notes and due date ONLY. Line items and the tax rate (anything that moves the total) stay on
 *                        the Invoices page; so does apply credit.
 *   archive_invoice      POST /admin/invoices/:id/archive    (invoiceArchiveHandler)   a voided invoice leaves the default list
 *   unarchive_invoice    POST /admin/invoices/:id/unarchive  (invoiceUnarchiveHandler)
 *   unvoid_invoice       POST /admin/invoices/:id/unvoid     (invoiceUnvoidHandler -> InvoiceService.unvoidInvoice)
 *                        a voided invoice returns to a draft: editable and collectible again.
 *
 * Each runs the route's own handler in process (admin-invoices.js editInvoiceFromBar, archiveInvoiceFromBar,
 * unarchiveInvoiceFromBar, unvoidInvoiceFromBar), so every refusal and rule is the route's.
 * NONE of them moves money, sends a text, email or call, charges a card, or refunds: every card says so.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only.
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the invoice's status, edit
 *                  time, amounts, customer, links and the exact request body).
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

const INVOICE_REF = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};

const INVOICE_EDIT_TOOLS = [
  {
    name: 'edit_invoice',
    description: `Edit the title, notes or due date of ONE existing unpaid invoice: the Invoices page "Edit", for those three fields only. Line items and the tax rate are NOT changed here (they change the total): do those on the Invoices page. The first call returns a PREVIEW and writes nothing: each field before -> after. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if the invoice changed.
Pass only what changes. title and notes: text ("" clears it). due_date: YYYY-MM-DD. The total never changes.
Allowed only where the Invoices page allows Edit: a draft, scheduled, sent, viewed or overdue invoice with no open card-payment session, no payment plan, no annual-plan link. Refused: paid, prepaid, processing, refunded, void and every invoice with money received or in flight.
Effects: the invoice row changes. If the customer already received the invoice, the bar does NOT resend it; the copy they hold is out of date until it is sent again. Nothing is sent to the customer or anyone (no text, email or call), no card is charged and nothing is refunded. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "change the due date on this invoice", "edit invoice WPC-2026-0534", "update the invoice notes", "change the invoice title".`,
    input_schema: {
      type: 'object',
      properties: {
        ...INVOICE_REF,
        title: { type: 'string', description: `The invoice title (up to ${TITLE_LIMIT} characters; "" clears it)` },
        notes: { type: 'string', description: `The invoice notes (up to ${NOTES_LIMIT} characters; "" clears them)` },
        due_date: { type: 'string', description: 'The new due date, YYYY-MM-DD' },
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
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
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
const MONEY_STATUSES = new Set(['paid', 'prepaid', 'processing', 'refunded', 'partially_refunded', 'partial', 'partially_paid', 'disputed']);
const EDITABLE_STATUSES = new Set(['draft', 'scheduled', 'sent', 'viewed', 'overdue']);
const DELIVERED_STATUSES = new Set(['sent', 'viewed', 'overdue']);

const ownerRule = (error, reason, invoiceId) => refusal(`${error} Refunds and card charges stay on the Invoices page.`, 'by_owner_rule', { reason, invoice_id: invoiceId });
const toPage = (error, reason, invoiceId) => refusal(`${error} Do it from the Invoices page.`, 'needs_invoices_page', { reason, invoice_id: invoiceId });

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

async function activePlanOf(invoice) {
  return db('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first('id', 'status');
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

const EDIT_INPUT_READERS = [readTextField('title', TITLE_LIMIT), readTextField('notes', NOTES_LIMIT), readDueDate];

function readEditInput(input) {
  const out = {};
  let any = false;
  for (const read of EDIT_INPUT_READERS) {
    const part = read(input);
    if (!part) continue;
    if (part.error) return part;
    Object.assign(out, part.set);
    any = any || part.any;
  }
  if (!any) return refusal('Nothing to change: give a title, notes or due_date. Line items and the tax rate are changed on the Invoices page.', 'nothing_to_change');
  return out;
}

async function editRefusal(invoice) {
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
  // An annual-prepay anchor can be linked only through its scheduled visit until payment syncs the term (invoice-prepay.js):
  // the strict resolver finds it, and an answer it cannot give refuses (the term's recorded price must match the invoice).
  try {
    if (await require('../invoice-prepay').resolveInvoiceTermId(invoice, db, { strict: true })) {
      return toPage(`Invoice ${invoice.invoice_number} is part of an annual prepay term; edit the term (Annual prepay).`, 'annual_plan', at);
    }
  } catch {
    return refusal('The bar could not verify whether this is an annual-plan invoice, so it was not offered. Edit it from the Invoices page.', 'unverified', { invoice_id: at });
  }
  if (await activePlanOf(invoice)) return refusal('This invoice has an active payment plan. Cancel the plan before editing the invoice.', 'not_editable', { reason: 'payment_plan', invoice_id: at });
  const statement = await statementOf(invoice);
  if (statement && statement.status !== 'open') return refusal('This invoice is on a finalized payer statement. Adjust it with a credit on the next statement.', 'not_editable', { reason: 'finalized_statement', invoice_id: at });
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
// Shown when no estimate link is found: the save re-runs the same reconciliation for whatever link exists at that moment (a visit
// can gain its estimate between the card and the save), so the card always names the effect instead of promising its absence.
const SETUP_FEE_IF_TIED_EFFECT = { kind: 'operational', text: 'If this invoice is linked to an accepted estimate when it is saved, confirming re-checks the staff alert that asks the office to bill its setup fee (it may close, reopen or change). Nothing is sent to the customer.' };

function editEffects({ status, dueChanged, setupFeeTied = false }) {
  const effects = [];
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
  effects.push(setupFeeTied ? SETUP_FEE_EFFECT : SETUP_FEE_IF_TIED_EFFECT);
  effects.push(NOTHING_SENT);
  return effects;
}

// Title, notes and due date that really differ from the invoice, as card changes and request-body fields.
function metadataChanges(invoice, read) {
  const changes = [];
  const body = {};
  // Both sides trimmed the same way (internal spacing kept), so a spacing-only fix is a change and an identical title is not.
  if (read.title !== undefined && (read.title || null) !== ((invoice.title || '').trim() || null)) {
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

// What the card pins (_version) and what the page's handler is handed (_expected). The customer is pinned in both: a customer merge
// can repoint invoices.customer_id without moving updated_at, and the card (and its approval) named the customer it showed.
function editPins({ invoice, stored, body, setupFeeTied }) {
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
      // Shown in the effects, so pinned: an estimate link that appears after the card refuses at Confirm.
      setup_fee_tied: Boolean(setupFeeTied),
    },
    _expected: {
      status: invoice.status,
      updatedAt: msOf(invoice.updated_at),
      total: Number(invoice.total) || 0,
      creditApplied: Number(invoice.credit_applied) || 0,
      paymentIntentId: null,
      customerId: invoice.customer_id || null,
    },
  };
}

async function buildEditPlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const stored = parseLines(invoice.line_items);
  const read = readEditInput(input);
  if (read.error) return read.code === 'nothing_to_change' ? { ...read, invoice_id: invoice.id } : read;
  const refused = await editRefusal(invoice);
  if (refused) return refused;
  const customer = await customerOf(invoice.customer_id);
  const { changes, body, dueChanged } = metadataChanges(invoice, read);
  if (!changes.length) return refusal('The invoice already reads that way. Nothing was changed.', 'no_change', { invoice_id: invoice.id });
  const setupFeeTied = await setupFeeAlertTied(invoice, body.notes);
  return {
    preview: true,
    tool: 'edit_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: personName(customer) || invoice.customer_id,
    status: invoice.status,
    amount: money(invoice.total),
    changes,
    effects: editEffects({ status: String(invoice.status || '').toLowerCase(), dueChanged, setupFeeTied }),
    sends_to_customer: false,
    ...editPins({ invoice, stored, body, setupFeeTied }),
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
  if (result.json?.id !== plan.invoice_id) {
    return { ...baseOf(plan), outcome_unknown: true, code: 'edit_unverified',
      error: 'The Invoices page answered, but the invoice does not read as the card promised. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:invoice-edit] edited invoice ${plan.invoice_id}`);
  const delivered = DELIVERED_STATUSES.has(String(plan.status || '').toLowerCase());
  return {
    ...baseOf(plan), success: true, status: result.json.status || plan.status, total: money(result.json.total), sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is updated. Nothing was sent to anyone.${delivered ? ' The customer already had this invoice and was not sent the new version: send it again if they should see the change.' : ''}`,
  };
}

// The saved-card charge fence, read-only. `where` finishes the unverified sentence ("Unvoid it from the Invoices page").
async function chargeFenceRefusal(invoice, where) {
  const charge = await chargeInProgress(invoice);
  if (charge === 'charge_in_progress') return ownerRule(`Invoice ${invoice.invoice_number} has a saved-card charge in progress or unresolved.`, 'charge_in_progress', invoice.id);
  if (charge) return refusal(`The bar could not check for a card charge in progress, so nothing was offered. ${where}`, 'unverified', { invoice_id: invoice.id });
  return null;
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
      customer_id: invoice.customer_id || null,
    },
    _expected: { status: invoice.status, updatedAt: msOf(invoice.updated_at), archived: Boolean(invoice.archived_at), customerId: invoice.customer_id || null },
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
    setupFeeTied ? SETUP_FEE_EFFECT : SETUP_FEE_IF_TIED_EFFECT,
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
    _expected: { status: invoice.status, updatedAt: msOf(invoice.updated_at), customerId: invoice.customer_id || null },
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
      { kind: 'billing', text: `Edit invoice ${preview.invoice_number} for ${who} (${preview.status}, ${preview.amount}): title, notes or due date only` },
      ...(preview.changes || []).map((c) => ({ kind: 'operational', text: `${c.field}: ${c.before} -> ${c.after}`, before: c.before, after: c.after })),
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
