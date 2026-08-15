/**
 * Open-balance reads (owner ruling 2026-08-08, Donovan case): everything a
 * customer still owes across their OTHER open invoices, for the
 * previous-balance surfaces (invoice email note, pay-page list) and the
 * completion balance sweep.
 *
 * Selection deliberately mirrors the portal "Pay now" query in
 * billing-v2.js GET /balance (the existing open-invoice authority):
 *   - status sent/viewed/overdue — bills the customer has actually been
 *     DELIVERED. Drafts are excluded on purpose: a draft was never presented,
 *     so it is neither shown as "previous balance" nor auto-charged.
 *   - payer_id NULL / payer_statement_id NULL in SQL, then a LIVE payer
 *     re-resolution per row (pre-push P0): a payer assigned after the
 *     invoice was minted can live only on scheduled_services (or as the
 *     customer's default payer) while the reused invoice row stays
 *     payer-null — the completion rails re-resolve for exactly this reason.
 *     A payer-billed row is the third party's debt, never the homeowner's
 *     balance; a failed resolve DROPS the row (fail closed, same direction
 *     as previsit-balance-reminder).
 *   - positive remainder (total − credit_applied), computed in SQL with the
 *     same GREATEST expression as the balance sum, oldest first.
 *
 * Invoices are NEVER merged, voided, or re-totalled here — each row keeps
 * its own service date, amount, and dunning age (that per-invoice age is
 * what keeps the oldest debt escalating — owner ruling #2).
 */

const db = require('../models/db');
const logger = require('./logger');
const { invoiceAmountDue } = require('./invoice-helpers');

// Safety valve, not display pagination: high enough that every real
// customer's full balance fits (prod max open invoices per customer is
// single digits), low enough to bound the per-row payer resolves against
// pathological data. Hitting it is logged so an understated total is never
// silent (pre-push P1).
const MAX_OPEN_INVOICES = 200;

/**
 * The customer's open self-pay invoices, oldest first, excluding
 * `excludeInvoiceId` (the invoice currently being viewed/emailed/charged).
 * Every returned row has been live-payer-verified as self-pay. Callers
 * whitelist what they expose — in particular, sibling invoice TOKENS must
 * never ride a public by-token payload (pre-push P0: one leaked invoice
 * link must not fan out into bearer credentials for the account's other
 * invoices).
 */
// The ONE eligibility query — both the full read and the existence probe run
// this exact selection, so "is there an open balance" can never disagree with
// the invoice list (the columns are needed either way: eligibility itself is
// remainder > 0, cents-checked in JS below).
function openInvoiceQuery(customerId, { excludeInvoiceId = null, database = db } = {}) {
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .orderBy('created_at', 'asc')
    .limit(MAX_OPEN_INVOICES)
    .select(
      'id', 'invoice_number', 'status', 'service_type', 'service_date',
      'due_date', 'created_at', 'subtotal', 'discount_amount', 'total',
      'credit_applied', 'scheduled_service_id', 'stripe_payment_intent_id',
    );
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  return query;
}

// The per-row self-pay test the SQL cannot make alone: cents-authoritative
// remainder plus the LIVE payer re-resolution (fail-closed toward DROP).
async function rowIsSelfPayDue(customerId, row) {
  if (!(invoiceAmountDue(row) > 0)) return false;
  const PayerService = require('./payer');
  try {
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(customerId),
      ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
      throwOnError: true,
    });
    if (resolved?.payerId) return false;
  } catch (err) {
    logger.warn(`[open-balance] payer resolve failed for invoice ${row.invoice_number} — dropping from balance (fail closed): ${err.message}`);
    return false;
  }
  return true;
}

async function openBalanceInvoices(customerId, { excludeInvoiceId = null, database = db } = {}) {
  if (!customerId) return [];
  const rows = await openInvoiceQuery(customerId, { excludeInvoiceId, database });
  if (rows.length >= MAX_OPEN_INVOICES) {
    logger.warn(`[open-balance] customer ${customerId} hit the ${MAX_OPEN_INVOICES}-invoice bound — balance surfaces may understate`);
  }

  const selfPay = [];
  for (const row of rows) {
     
    if (await rowIsSelfPayDue(customerId, row)) selfPay.push(row);
  }
  return selfPay;
}

/**
 * EXISTENCE ONLY — "does this customer have any open self-pay balance", with
 * the exact same eligibility rules as the full read (same SQL, same
 * cents-authoritative remainder, same live payer re-resolution), but no total
 * is ever materialized and nothing amount-shaped is returned. Built for the
 * voice split tier (AGENTS.md): an unattested caller may hear THAT a balance
 * exists, and the figure must not even be fetched into the session. Stops at
 * the first qualifying row.
 */
async function openBalanceExists(customerId, { excludeInvoiceId = null, database = db } = {}) {
  if (!customerId) return false;
  // ⭐ NO AMOUNTS LEAVE THE DATABASE. The full read's projection carries
  // subtotal/total/credit_applied because its callers render them; an
  // existence probe has no business materializing 200 invoices' figures to
  // reduce them to a boolean. The cents-positive test runs IN SQL — the exact
  // integer arithmetic invoiceAmountDue performs
  // (ROUND(total·100) − ROUND(credit·100) > 0), not the float GREATEST the
  // broad-phase WHERE uses — and the projection is only what the live payer
  // re-resolution needs. Same eligibility rules, no figures in the process.
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('(ROUND(total * 100) - ROUND(COALESCE(credit_applied, 0) * 100)) > 0')
    .orderBy('created_at', 'asc')
    .limit(MAX_OPEN_INVOICES)
    .select('id', 'invoice_number', 'scheduled_service_id');
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  const rows = await query;
  const PayerService = require('./payer');
  // ⭐ A DROPPED ROW IS NOT A "NO". The full read fails a resolve-outage row
  // toward DROP because SHOWING a possibly-payer-billed invoice is the harm
  // there. Here the harm is inverted: this boolean gets SPOKEN as "no open
  // balance" to a customer who may owe money, so a candidate lost to a
  // transient failure makes the answer INDETERMINATE (null) — the voice layer
  // already degrades null to "couldn't check, a team member can confirm".
  let anyResolveFailed = false;
  for (const row of rows) {
    try {
       
      const resolved = await PayerService.resolveForInvoice({
        customerId: String(customerId),
        ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
        throwOnError: true,
      });
      if (resolved?.payerId) continue;
    } catch (err) {
      logger.warn(`[open-balance] payer resolve failed for invoice ${row.invoice_number} — existence answer degrades to indeterminate: ${err.message}`);
      anyResolveFailed = true;
      continue;
    }
    return true; // short-circuit at the first qualifying self-pay row
  }
  // ⭐ A FULL PAGE OF NON-QUALIFIERS IS NOT A "NO" EITHER. If the candidate
  // query hit its cap and every fetched row resolved to a payer, a self-pay
  // invoice can still exist beyond the cap — a confident false here would be
  // SPOKEN as "no open balance" to a customer who owes money. Off-the-end of
  // a full page is indeterminate, same degradation as a failed resolve.
  if (rows.length >= MAX_OPEN_INVOICES) return null;
  return anyResolveFailed ? null : false;
}

/**
 * { total, count, moreCount, invoices } for the previous-balance surfaces.
 * `total`/`count` cover the FULL self-pay open set; `invoices` is capped at
 * `displayLimit` for rendering, with `moreCount` carrying the remainder so a
 * capped list is never presented as complete (pre-push P1). `total` is the
 * cents-safe sum of per-invoice remainders — a pure sum, never
 * re-discounted or re-taxed (each invoice's own math already happened at
 * mint).
 */
async function openBalanceSummary(customerId, { displayLimit = 5, ...opts } = {}) {
  const invoices = await openBalanceInvoices(customerId, opts);
  const totalCents = invoices.reduce(
    (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
    0,
  );
  return {
    total: totalCents / 100,
    count: invoices.length,
    moreCount: Math.max(0, invoices.length - displayLimit),
    invoices: invoices.slice(0, displayLimit),
  };
}

module.exports = { openBalanceInvoices, openBalanceSummary, openBalanceExists, rowIsSelfPayDue, MAX_OPEN_INVOICES };
