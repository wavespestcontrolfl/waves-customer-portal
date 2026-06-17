/**
 * Third-party payer (Bill-To) service.
 *
 * A payer is a reusable Bill-To account that is NOT a customer. See the
 * 20260617000002_third_party_payers migration for the data model and the
 * resolution order. This module is the single place that:
 *   - resolves which payer (if any) bills a given invoice/job,
 *   - loads a payer for the invoice PDF + email reroute,
 *   - performs admin CRUD with light validation.
 *
 * Safety: resolveForInvoice() and attachToInvoice() NEVER throw — a payer
 * lookup must not be able to block invoicing. They fail soft to "self-pay".
 */

const db = require('../models/db');
const logger = require('./logger');

const PAYMENT_TERMS = ['due_on_receipt', 'net15', 'net30'];

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function cleanOrNull(value, max) {
  const s = clean(value);
  if (!s) return null;
  return typeof max === 'number' ? s.slice(0, max) : s;
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function normalizeTerms(value) {
  const t = clean(value).toLowerCase();
  return PAYMENT_TERMS.includes(t) ? t : 'due_on_receipt';
}

// Build the { dbUpdates } object for create/update from a request body.
// Returns { error } on a validation failure. `partial` (PATCH/PUT-update)
// only writes provided keys; create requires display_name + a valid ap_email
// when one is supplied.
function buildPayerWrite(body = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('displayName')) {
    const displayName = cleanOrNull(body.displayName ?? body.display_name, 160);
    if (!displayName) return { error: 'Payer name is required' };
    out.display_name = displayName;
  }
  if (has('companyName') || has('company_name')) out.company_name = cleanOrNull(body.companyName ?? body.company_name, 200);
  if (has('apEmail') || has('ap_email')) {
    const apEmail = cleanEmail(body.apEmail ?? body.ap_email);
    if (apEmail && !isEmailLike(apEmail)) return { error: 'Invalid AP email' };
    out.ap_email = apEmail || null;
  }
  if (has('apPhone') || has('ap_phone')) out.ap_phone = cleanOrNull(body.apPhone ?? body.ap_phone, 40);
  if (has('billingAddressLine1') || has('billing_address_line1')) out.billing_address_line1 = cleanOrNull(body.billingAddressLine1 ?? body.billing_address_line1, 200);
  if (has('billingCity') || has('billing_city')) out.billing_city = cleanOrNull(body.billingCity ?? body.billing_city, 120);
  if (has('billingState') || has('billing_state')) out.billing_state = cleanOrNull(clean(body.billingState ?? body.billing_state).toUpperCase(), 8);
  if (has('billingZip') || has('billing_zip')) out.billing_zip = cleanOrNull(body.billingZip ?? body.billing_zip, 16);
  if (has('paymentTerms') || has('payment_terms')) out.payment_terms = normalizeTerms(body.paymentTerms ?? body.payment_terms);
  if (has('requiresPo') || has('requires_po')) out.requires_po = !!(body.requiresPo ?? body.requires_po);
  if (has('taxExempt') || has('tax_exempt')) out.tax_exempt = !!(body.taxExempt ?? body.tax_exempt);
  if (has('taxExemptCert') || has('tax_exempt_cert')) out.tax_exempt_cert = cleanOrNull(body.taxExemptCert ?? body.tax_exempt_cert, 120);
  if (has('notes')) out.notes = cleanOrNull(body.notes, 2000);
  if (has('active')) out.active = !!body.active;

  return { dbUpdates: out };
}

async function listPayers({ search, includeInactive = false, limit = 100 } = {}) {
  let q = db('payers').select('*').orderBy('display_name', 'asc').limit(Math.min(Number(limit) || 100, 500));
  if (!includeInactive) q = q.where('active', true);
  const term = clean(search);
  if (term) {
    const like = `%${term.toLowerCase()}%`;
    q = q.where((b) => {
      b.whereRaw('LOWER(display_name) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(company_name, \'\')) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(ap_email, \'\')) LIKE ?', [like]);
    });
  }
  return q;
}

async function getPayer(id, database = db) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return database('payers').where({ id: pid }).first();
}

async function createPayer(body) {
  const { dbUpdates, error } = buildPayerWrite(body, { partial: false });
  if (error) return { error };
  const [row] = await db('payers').insert(dbUpdates).returning('*');
  return { payer: row };
}

async function updatePayer(id, body) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return { error: 'Invalid payer id' };
  const existing = await getPayer(pid);
  if (!existing) return { error: 'Payer not found', notFound: true };
  const { dbUpdates, error } = buildPayerWrite(body, { partial: true });
  if (error) return { error };
  if (Object.keys(dbUpdates).length === 0) return { payer: existing };
  dbUpdates.updated_at = new Date();
  const [row] = await db('payers').where({ id: pid }).update(dbUpdates).returning('*');
  return { payer: row };
}

/**
 * Resolve the bill-to payer for an invoice context.
 * Precedence: scheduled_service.payer_id ?? customer.payer_id.
 * po_number comes only from the scheduled service (PO is per-job).
 * Never throws — returns { payerId: null, poNumber: null } on any problem.
 */
async function resolveForInvoice({ database = db, customerId, customer = null, scheduledServiceId = null } = {}) {
  try {
    let payerId = null;
    let poNumber = null;

    if (scheduledServiceId) {
      const ss = await database('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('payer_id', 'po_number')
        .catch(() => null);
      if (ss) {
        if (ss.payer_id) payerId = ss.payer_id;
        if (clean(ss.po_number)) poNumber = clean(ss.po_number);
      }
    }

    if (!payerId) {
      let cust = customer;
      if (!cust && customerId) {
        cust = await database('customers').where({ id: customerId }).first('payer_id').catch(() => null);
      }
      if (cust && cust.payer_id) payerId = cust.payer_id;
    }

    if (!payerId) return { payerId: null, poNumber: null };

    // Only honor an ACTIVE payer link. A deactivated payer falls back to
    // self-pay rather than silently sending invoices to a dead AP inbox.
    const payer = await getPayer(payerId, database).catch(() => null);
    if (!payer || payer.active === false) return { payerId: null, poNumber: null };

    return { payerId, poNumber };
  } catch (err) {
    logger.warn(`[payer] resolveForInvoice failed (falling back to self-pay): ${err.message}`);
    return { payerId: null, poNumber: null };
  }
}

/**
 * Load and attach `invoice.payer` when the invoice carries a payer_id snapshot.
 * Mutates and returns the same invoice object. Never throws.
 */
async function attachToInvoice(invoice, database = db) {
  if (!invoice || !invoice.payer_id || invoice.payer) return invoice;
  try {
    const payer = await getPayer(invoice.payer_id, database);
    if (payer) invoice.payer = payer;
  } catch (err) {
    logger.warn(`[payer] attachToInvoice failed for invoice ${invoice.id}: ${err.message}`);
  }
  return invoice;
}

// Recipient object for the invoice email reroute. Returns null when the payer
// has no usable AP email (caller then falls back to the customer billing
// contact, so a misconfigured payer never strands the invoice with no path).
function payerRecipient(payer) {
  if (!payer) return null;
  const email = cleanEmail(payer.ap_email);
  if (!email || !isEmailLike(email)) return null;
  return {
    email,
    name: cleanOrNull(payer.company_name || payer.display_name, 120) || '',
    role: 'payer',
  };
}

module.exports = {
  PAYMENT_TERMS,
  buildPayerWrite,
  listPayers,
  getPayer,
  createPayer,
  updatePayer,
  resolveForInvoice,
  attachToInvoice,
  payerRecipient,
  _private: { isEmailLike, normalizeTerms },
};
