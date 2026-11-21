'use strict';

const UNBOOKED_SALE = 'commercial_setup_sold_without_visit';

// Both callers just minted this invoice. Later bookings and refunds may
// consume the setup claim, so its original price and estimate live here.
function recordUnbookedSale(trx, { invoiceId, customerId, estimateId = null, setupAmount }) {
  return require('./audit-log').recordAuditEvent({
    trx, critical: true, actor_type: 'system', action: UNBOOKED_SALE,
    resource_type: 'invoices', resource_id: invoiceId,
    metadata: { customerId, estimateId, setupAmountCents: Math.round(Number(setupAmount) * 100) },
  });
}

// Lock-free discriminator for optional Dispatch receipt evidence. Financial
// writers may already hold invoice/deposit locks when they ask, so this must
// stay a plain existence read rather than reusing findUnbookedSale's FOR UPDATE
// validation path.
async function hasRecordedUnbookedSale(conn, invoiceId) {
  if (!invoiceId) return false;
  const row = await conn('audit_log').where({
    action: UNBOOKED_SALE,
    resource_type: 'invoices',
    resource_id: invoiceId,
  }).first('id');
  return !!row;
}

async function recordUnbookedCoverageSale(trx, sale) {
  const service = require('./estimate-converter').recurringServiceKey({ name: sale.coverageServiceType });
  if (service === 'commercial_rodent_bait' || (service === 'rodent_bait'
    && await require('./secure-appointment-plans').customerHasCommercialChannel(trx, sale.customerId))) {
    await recordUnbookedSale(trx, sale);
  }
}

function parsedObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The immutable sale event names the customer that bought the setup. A
// customer merge deliberately repoints the invoice, term and payment rows,
// but never rewrites audit history. Accept that owner change only through the
// merge journal's exact per-row record; a count-only legacy journal, an
// unrelated merge, or an undone merge proves nothing. Every hop must name the
// invoice because a later winner -> winner merge repoints it again.
async function invoiceOwnerReachedByAuditedMerge(conn, { invoiceId, originalCustomerId, currentCustomerId }) {
  let ownerId = String(originalCustomerId || '');
  const targetId = String(currentCustomerId || '');
  if (!ownerId || !targetId || !invoiceId) return false;
  if (ownerId === targetId) return true;
  const seen = new Set([ownerId]);
  while (true) {
    const journal = await conn('customer_merge_journal')
      .where({ loser_customer_id: ownerId })
      .whereNull('undone_at')
      .orderBy('created_at', 'desc')
      .first('winner_customer_id', 'repointed_ids');
    const movedInvoiceIds = parsedObject(journal?.repointed_ids)
      ?.tables?.['invoices.customer_id'];
    if (!journal?.winner_customer_id || !Array.isArray(movedInvoiceIds)
      || !movedInvoiceIds.map(String).includes(String(invoiceId))) return false;
    ownerId = String(journal.winner_customer_id);
    if (ownerId === targetId) return true;
    if (seen.has(ownerId)) return false;
    seen.add(ownerId);
  }
}

async function findUnbookedSale(conn, invoiceId) {
  const sales = await conn('audit_log').where({
    action: UNBOOKED_SALE, resource_type: 'invoices', resource_id: invoiceId,
  }).select('metadata').limit(2).forUpdate();
  if (sales.length !== 1) return null;
  const sale = sales[0].metadata;
  if (!Number.isSafeInteger(sale?.setupAmountCents) || sale.setupAmountCents <= 0) return null;
  const invoice = await conn('invoices').where({ id: invoiceId }).first();
  if (!invoice) return null;
  if (String(invoice.customer_id) !== String(sale.customerId)
    && !await invoiceOwnerReachedByAuditedMerge(conn, {
      invoiceId,
      originalCustomerId: sale.customerId,
      currentCustomerId: invoice.customer_id,
    })) return null;
  const term = await conn('annual_prepay_terms').where({
    prepay_invoice_id: invoiceId, customer_id: invoice.customer_id,
  }).first();
  if (!term || (term.source_estimate_id && sale.estimateId !== term.source_estimate_id)) return null;
  return { invoice, term, estimateId: sale.estimateId, amount: sale.setupAmountCents / 100 };
}

module.exports = {
  recordUnbookedSale,
  recordUnbookedCoverageSale,
  findUnbookedSale,
  hasRecordedUnbookedSale,
  invoiceOwnerReachedByAuditedMerge,
};
