'use strict';

const UNBOOKED_SALE = 'commercial_setup_sold_without_visit';

// Written in the invoice mint transaction. Later booking/refund paths may
// consume or move the setup claim, so the original sale amount and estimate
// live in immutable audit history rather than on that mutable claim.
function recordUnbookedSale(trx, { invoiceId, customerId, estimateId = null, setupAmount }) {
  return require('./audit-log').recordAuditEvent({
    trx,
    critical: true,
    actor_type: 'system',
    action: UNBOOKED_SALE,
    resource_type: 'invoices',
    resource_id: invoiceId,
    metadata: {
      customerId,
      estimateId,
      setupAmountCents: Math.round(Number(setupAmount) * 100),
    },
  });
}

// Settlement writers already hold their money locks. This existence read
// decides whether to capture payment evidence before full verification.
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
  const commercial = service === 'commercial_rodent_bait'
    || (service === 'rodent_bait'
      && await require('./secure-appointment-plans').customerHasCommercialChannel(trx, sale.customerId));
  if (commercial) await recordUnbookedSale(trx, sale);
}

function parsedObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// A merge can repoint the live invoice owner, but only an active per-row merge
// journal entry naming this invoice may bridge the immutable sale owner to it.
async function invoiceOwnerReachedByAuditedMerge(conn, {
  invoiceId,
  originalCustomerId,
  currentCustomerId,
}) {
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
    action: UNBOOKED_SALE,
    resource_type: 'invoices',
    resource_id: invoiceId,
  }).select('id', 'metadata').limit(2).forUpdate();
  if (sales.length !== 1) return null;
  const saleRow = sales[0];
  const sale = saleRow.metadata;
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
    prepay_invoice_id: invoiceId,
    customer_id: invoice.customer_id,
  }).first();
  if (!term || (term.source_estimate_id && String(sale.estimateId) !== String(term.source_estimate_id))) {
    return null;
  }
  const estimateId = sale.estimateId || null;
  return {
    saleId: saleRow.id,
    invoice,
    term,
    estimateId,
    amount: sale.setupAmountCents / 100,
    reviewContext: {
      saleId: saleRow.id,
      sourceInvoiceId: invoice.id,
      customerId: invoice.customer_id,
      estimateId,
      setupAmountCents: sale.setupAmountCents,
    },
  };
}

module.exports = {
  UNBOOKED_SALE,
  recordUnbookedSale,
  recordUnbookedCoverageSale,
  findUnbookedSale,
  hasRecordedUnbookedSale,
  invoiceOwnerReachedByAuditedMerge,
};
