'use strict';

const UNBOOKED_SALE = 'commercial_setup_sold_without_visit';

function recordUnbookedSale(trx, { invoiceId, claimId, customerId }) {
  return require('./audit-log').recordAuditEvent({
    trx, critical: true, actor_type: 'system', action: UNBOOKED_SALE,
    resource_type: 'invoices', resource_id: invoiceId, metadata: { claimId, customerId },
  });
}

async function findUnbookedSale(conn, invoiceId) {
  const sales = await conn('audit_log').where({
    action: UNBOOKED_SALE, resource_type: 'invoices', resource_id: invoiceId,
  }).select('metadata').limit(2);
  if (sales.length !== 1) return null;
  const evidence = sales[0].metadata;
  const claim = await conn('setup_fee_claims').where({ invoice_id: invoiceId }).forUpdate().first();
  if (!claim || claim.id !== evidence?.claimId || !(Number(claim.amount) > 0)) return null;
  const invoice = await conn('invoices').where({ id: invoiceId }).first();
  if (!invoice || invoice.customer_id !== evidence.customerId) return null;
  const term = await conn('annual_prepay_terms').where({
    prepay_invoice_id: invoiceId, customer_id: invoice.customer_id,
  }).first();
  if (!term || (claim.estimate_id && claim.estimate_id !== term.source_estimate_id)) return null;
  return { claim, term, invoice };
}

module.exports = { recordUnbookedSale, findUnbookedSale };
