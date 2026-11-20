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

async function findUnbookedSale(conn, invoiceId, { lockInvoice = false } = {}) {
  const invoiceQuery = conn('invoices').where({ id: invoiceId }).first();
  const lockedInvoice = lockInvoice ? await invoiceQuery.forUpdate() : null;
  if (lockInvoice && !lockedInvoice) return null;
  const sales = await conn('audit_log').where({
    action: UNBOOKED_SALE,
    resource_type: 'invoices',
    resource_id: invoiceId,
  }).select('id', 'metadata').limit(2).forUpdate();
  if (sales.length !== 1) return null;
  const saleRow = sales[0];
  const sale = saleRow.metadata;
  if (!Number.isSafeInteger(sale?.setupAmountCents) || sale.setupAmountCents <= 0) return null;
  const invoice = lockedInvoice || await invoiceQuery;
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

async function verifiedCustomerLinks(conn, invoiceIds) {
  const records = await conn('audit_log as sale')
    .join('invoices as i', 'i.id', 'sale.resource_id')
    .join('annual_prepay_terms as t', function invoiceOwner() {
      this.on('t.prepay_invoice_id', '=', 'i.id').andOn('t.customer_id', '=', 'i.customer_id');
    })
    .where({ 'sale.action': UNBOOKED_SALE, 'sale.resource_type': 'invoices' })
    .whereIn('sale.resource_id', invoiceIds)
    .select('i.id', 'i.customer_id', 't.source_estimate_id', 'sale.metadata');
  const seen = new Set();
  const verified = new Map();
  for (const row of records) {
    if (seen.has(row.id)) {
      verified.delete(row.id);
      continue;
    }
    seen.add(row.id);
    const sale = row.metadata;
    if (!Number.isSafeInteger(sale?.setupAmountCents) || sale.setupAmountCents <= 0
      || (row.source_estimate_id && row.source_estimate_id !== sale.estimateId)) continue;
    if (await invoiceOwnerReachedByAuditedMerge(conn, {
      invoiceId: row.id, originalCustomerId: sale.customerId, currentCustomerId: row.customer_id,
    })) verified.set(row.id, row.customer_id);
  }
  return verified;
}

module.exports = {
  UNBOOKED_SALE,
  recordUnbookedSale,
  recordUnbookedCoverageSale,
  findUnbookedSale,
  invoiceOwnerReachedByAuditedMerge,
  verifiedCustomerLinks,
};
