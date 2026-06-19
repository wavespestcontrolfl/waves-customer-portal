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

// An invoice's AP delivery email is "frozen" to the snapshot once the invoice has
// been issued/delivered (or reached a terminal state). Before that — while it's
// still draft/scheduled/sending — the live active payer's current AP email wins
// so an operator's correction takes effect on a resend.
const AP_FROZEN_INVOICE_STATUSES = new Set([
  'sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled',
]);

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

  if (!partial || has('displayName') || has('display_name')) {
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
// Frozen bill-to subset stored on the invoice at creation. Uses the SAME keys
// as the payers row so the PDF / pay page / email renderers (which read
// invoice.payer) work unchanged whether they get a live row or a snapshot.
function payerSnapshot(payer) {
  if (!payer) return null;
  return {
    display_name: payer.display_name || null,
    company_name: payer.company_name || null,
    ap_email: payer.ap_email || null,
    billing_address_line1: payer.billing_address_line1 || null,
    billing_city: payer.billing_city || null,
    billing_state: payer.billing_state || null,
    billing_zip: payer.billing_zip || null,
  };
}

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const obj = JSON.parse(value);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

async function resolveForInvoice({ database = db, customerId, customer = null, scheduledServiceId = null } = {}) {
  const SELF_PAY = { payerId: null, poNumber: null, taxExempt: false, snapshot: null };
  try {
    let payerId = null;
    let poNumber = null;

    // The owning customer of this invoice; used to scope the per-job lookup so
    // a stale/mismatched scheduledServiceId can never snapshot a DIFFERENT
    // customer's payer onto this invoice.
    const ownerCustomerId = customerId || customer?.id || null;

    if (scheduledServiceId) {
      const ssWhere = { id: scheduledServiceId };
      if (ownerCustomerId) ssWhere.customer_id = ownerCustomerId;
      const ss = await database('scheduled_services')
        .where(ssWhere)
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

    if (!payerId) return SELF_PAY;

    // Only honor an ACTIVE payer link. A deactivated payer falls back to
    // self-pay rather than silently sending invoices to a dead AP inbox.
    const payer = await getPayer(payerId, database).catch(() => null);
    if (!payer || payer.active === false) return SELF_PAY;

    return { payerId, poNumber, taxExempt: !!payer.tax_exempt, snapshot: payerSnapshot(payer) };
  } catch (err) {
    logger.warn(`[payer] resolveForInvoice failed (falling back to self-pay): ${err.message}`);
    return SELF_PAY;
  }
}

/**
 * Load and attach `invoice.payer` when the invoice carries a payer_id snapshot.
 * Mutates and returns the same invoice object. Never throws.
 */
async function attachToInvoice(invoice, database = db) {
  if (!invoice || invoice.payer) return invoice;
  // Prefer the frozen bill-to snapshot taken at creation — it survives later
  // edits/deactivation of the payer row, so an issued invoice/receipt keeps
  // its original Bill-To and routes to the AP email it was billed to.
  const parsed = parseSnapshot(invoice.payer_snapshot);
  if (parsed) {
    // Clone so a live AP-email recovery below never mutates the STORED snapshot
    // in place — Postgres returns jsonb as a parsed object, and downstream
    // (persistPayerApIfNeeded) must still see that the stored snapshot lacked an
    // AP email to know it needs to freeze the recovered one.
    const snap = { ...parsed };
    // "Issued/delivered" is determined by the persistent sent_at timestamp, not
    // the live status: sendViaSMSAndEmail claims a sendable invoice by flipping
    // its status to 'sending' BEFORE this attach runs (claimInvoiceForSend), so a
    // resend of an already-sent/viewed payer invoice would otherwise look
    // undelivered. sent_at survives the claim (COALESCE-set on first delivery,
    // never cleared), so it correctly classifies an issued invoice as frozen.
    const apIsFrozen = !!invoice.sent_at
      || AP_FROZEN_INVOICE_STATUSES.has(String(invoice.status || '').toLowerCase());

    // ISSUED invoice: the frozen bill-to is an immutable record of who it was
    // billed to — keep the snapshot even if the payer was later edited or
    // deactivated (round-3 intent: "an issued invoice keeps its Bill-To"). Only
    // recover a live AP email if the snapshot never captured one (minted before
    // ops filled it in).
    if (apIsFrozen) {
      if (!isEmailLike(snap.ap_email) && invoice.payer_id) {
        try {
          const live = await getPayer(invoice.payer_id, database);
          if (live && live.active !== false && live.ap_email && isEmailLike(live.ap_email)) {
            snap.ap_email = live.ap_email;
          }
        } catch (err) {
          logger.warn(`[payer] attachToInvoice live AP-email recovery failed for invoice ${invoice.id}: ${err.message}`);
        }
      }
      invoice.payer = snap;
      return invoice;
    }

    // UNFROZEN invoice (draft/scheduled/sending, never delivered): not yet a
    // record of issue, so it requires a live ACTIVE payer. A payer cleared or
    // deactivated after minting makes the invoice UNATTACHABLE (invoice.payer is
    // left unset) so the delivery paths FAIL CLOSED — the operator reactivates or
    // corrects the bill-to instead of silently sending to the stale snapshot AP
    // inbox. The live ACTIVE payer's AP email is preferred so a correction takes
    // effect on a resend. (A snapshot with no payer_id link can't be re-verified;
    // routing keys off payer_id so it stays self-pay — keep it for display.)
    if (!invoice.payer_id) {
      invoice.payer = snap;
      return invoice;
    }
    try {
      const live = await getPayer(invoice.payer_id, database);
      if (live && live.active !== false) {
        if (live.ap_email && isEmailLike(live.ap_email)) snap.ap_email = live.ap_email;
        invoice.payer = snap;
      }
      // missing/inactive live payer → leave invoice.payer unset (fail closed)
    } catch (err) {
      logger.warn(`[payer] attachToInvoice live lookup failed for invoice ${invoice.id}: ${err.message}`);
      // fail closed for unfrozen invoices on lookup error
    }
    return invoice;
  }
  // Legacy invoices created before payer_snapshot existed fall back to the live
  // payer row, still guarding against a payer deactivated before a draft
  // invoice was ever sent (no snapshot = no issued bill-to of record yet).
  if (!invoice.payer_id) return invoice;
  try {
    const payer = await getPayer(invoice.payer_id, database);
    if (payer && payer.active !== false) invoice.payer = payer;
  } catch (err) {
    logger.warn(`[payer] attachToInvoice failed for invoice ${invoice.id}: ${err.message}`);
  }
  return invoice;
}

/**
 * Freeze the AP email an invoice was actually DELIVERED to onto its
 * payer_snapshot, so the (async) receipt + pay/receipt pages keep routing to the
 * same AP contact even if the payer row is later edited/deactivated. Covers a
 * live-recovered email, an operator one-off, or the first send of a legacy
 * invoice. No-ops once the snapshot already carries the delivered address. Never
 * throws — a bookkeeping write must not break a successful send.
 */
async function freezeApEmail(invoice, deliveredEmail, database = db) {
  try {
    if (!invoice || !invoice.payer_id) return;
    const email = cleanEmail(deliveredEmail);
    if (!email || !isEmailLike(email)) return;
    const stored = parseSnapshot(invoice.payer_snapshot);
    if (stored && cleanEmail(stored.ap_email) === email) return; // already frozen with this AP email
    const base = (invoice.payer && typeof invoice.payer === 'object') ? invoice.payer : (stored || {});
    const snap = { ...base, ap_email: email };
    await database('invoices').where({ id: invoice.id }).update({ payer_snapshot: JSON.stringify(snap) });
    invoice.payer = snap;
  } catch (err) {
    logger.warn(`[payer] freezeApEmail failed for invoice ${invoice && invoice.id}: ${err.message}`);
  }
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
  freezeApEmail,
  payerRecipient,
  payerSnapshot,
  _private: { isEmailLike, normalizeTerms, parseSnapshot },
};
