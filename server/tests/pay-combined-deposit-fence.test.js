jest.mock('../services/completion-balance-sweep', () => ({
  dunningStoppedInvoiceIds: jest.fn(async () => new Set()),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => null),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
}));

const { verifyAllocationLocked } = require('../services/pay-combined');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');

test('a held sibling refuses the whole combined collection after all invoice locks', async () => {
  const rows = ['anchor', 'sibling'].map((id) => ({
    id, invoice_number: id, customer_id: 'customer', status: 'viewed',
    total: '25.00', credit_applied: '0.00', stripe_payment_intent_id: 'pi_combined',
  }));
  const events = [];
  const trx = (table) => {
    expect(table).toBe('invoices');
    const query = {};
    query.whereIn = () => query;
    query.orderBy = () => query;
    query.forUpdate = async () => {
      events.push('invoices locked');
      return rows;
    };
    return query;
  };
  assertInvoiceDepositSettlementReady.mockImplementation(async (_trx, invoice) => {
    events.push(invoice.id);
    if (invoice.id === 'sibling') {
      throw Object.assign(new Error('A received deposit is awaiting invoice reconciliation'), {
        code: 'DEPOSIT_RECONCILIATION_REQUIRED', statusCode: 409,
      });
    }
  });

  await expect(verifyAllocationLocked(trx, [
    { invoiceId: 'anchor', cents: 2500 },
    { invoiceId: 'sibling', cents: 2500 },
  ], { anchorInvoiceId: 'anchor', expectPaymentIntentId: 'pi_combined' }))
    .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED', statusCode: 409 });
  expect(events).toEqual(['invoices locked', 'anchor', 'sibling']);
});
