/**
 * GET /api/pay/:token — previous-balance itemization contract.
 *
 * Owner ruling 2026-08-16 (payIncludeBalance) SUPERSEDED the original
 * sibling-isolation P0 this suite used to pin: with the gate ON, the pay
 * page itemizes the customer's other open self-pay invoices (numbers,
 * dates, amounts) and the pay flow charges the combined total. Two parts
 * of the old contract survive unchanged and stay pinned here:
 *   1. Gate OFF ⇒ the payload is byte-identical to the pre-ruling surface
 *      (no previousBalance key, no sibling data anywhere) — the kill
 *      switch fully restores the old disclosure posture.
 *   2. Sibling TOKENS never ride the payload in ANY state — one leaked
 *      pay link must not fan out into bearer credentials for the
 *      account's other invoices.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.raw = (sql) => sql;
  return dbFn;
});
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/invoice-attachments', () => ({ list: jest.fn(async () => []) }));
jest.mock('../services/stripe', () => ({
  isAvailable: () => true,
  // Sibling reconciliation fence (codex #3427 r13 P1): clean by default.
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test_1' }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateInvoicePDF: jest.fn() }));
jest.mock('../services/payment-method-consents', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/bill-payment-error-alerts', () => ({ alertBillPaymentError: jest.fn(async () => {}) }));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => null),
  // Live anchor payer resolution (codex #3427 r6 P1): no payer by default.
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: { autoApplyAccountCredit: false },
}));
const SIBLING_TOKEN = 'sibling-token-must-never-leak';
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => []),
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, moreCount: 0, invoices: [] })),
}));
jest.mock('../services/completion-balance-sweep', () => ({
  dunningStoppedInvoiceIds: jest.fn(async () => new Set()),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const openBalance = require('../services/open-balance');
const { isEnabled } = require('../config/feature-gates');
const payRouter = require('../routes/pay-v2');

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}

const siblingRow = () => ({
  id: 'inv-old-1',
  token: SIBLING_TOKEN,
  invoice_number: 'INV-OLD',
  status: 'overdue',
  service_type: 'Lawn Care',
  service_date: '2026-08-01',
  due_date: '2026-08-15',
  total: '44.55',
  credit_applied: 0,
  stripe_payment_intent_id: null,
});

function invoiceData(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'WPC-2026-0123',
    status: 'sent',
    token: 'a'.repeat(64),
    subtotal: '150.00',
    discount_amount: '0',
    tax_rate: '0',
    tax_amount: '0',
    total: '150.00',
    credit_applied: 0,
    line_items: [],
    customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Doe' },
    ...overrides,
  };
}

async function getPayPage(data) {
  InvoiceService.getByToken.mockResolvedValue(data);
  db.mockImplementation((table) => {
    if (table === 'customers') return chain({ first: { billing_mode: null, monthly_rate: null } });
    return chain({ first: null });
  });
  const layer = payRouter.stack.find((l) => l.route?.path === '/:token' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { token: data.token } };
  let body = null;
  const res = {
    json: (payload) => { body = payload; },
    status: () => res,
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { body };
}

describe('GET /pay/:token previous-balance itemization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => false);
    openBalance.openBalanceInvoices.mockImplementation(async () => []);
  });

  test('gate OFF: payload is byte-identical to the pre-ruling surface — no sibling data at all', async () => {
    openBalance.openBalanceInvoices.mockImplementation(async () => [siblingRow()]);
    const { body } = await getPayPage(invoiceData());

    expect(body).not.toHaveProperty('previousBalance');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('INV-OLD');
    expect(serialized).not.toContain('44.55');
    expect(serialized).not.toContain(SIBLING_TOKEN);
    expect(body.invoice.invoiceNumber).toBe('WPC-2026-0123');
  });

  test('gate ON with open siblings: itemized previousBalance with combined total — but NEVER sibling tokens', async () => {
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    openBalance.openBalanceInvoices.mockImplementation(async () => [siblingRow()]);
    const { body } = await getPayPage(invoiceData());

    expect(body.previousBalance).toEqual({
      invoices: [{
        invoiceNumber: 'INV-OLD',
        // NO serviceType (codex #3427 r14 P1): the unauthenticated bearer
        // surface exposes numbers, dates, and amounts only — never the
        // customer's service history.
        serviceDate: '2026-08-01',
        dueDate: '2026-08-15',
        amountDue: 44.55,
      }],
      total: 44.55,
      combinedTotal: 194.55,
    });
    expect(JSON.stringify(body.previousBalance)).not.toContain('Lawn Care');
    // The hard line that survived the ruling: sibling bearer tokens never
    // ride this payload.
    expect(JSON.stringify(body)).not.toContain(SIBLING_TOKEN);
  });

  test('gate ON, no open siblings: previousBalance key is absent (not null)', async () => {
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
  });

  test('gate ON, payer-billed anchor: never itemizes the homeowner balance', async () => {
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    openBalance.openBalanceInvoices.mockImplementation(async () => [siblingRow()]);
    const { body } = await getPayPage(invoiceData({ payer_id: 'payer-1' }));
    expect(body).not.toHaveProperty('previousBalance');
  });

  test('gate ON, anchor LIVE-resolves to a payer (invoices.payer_id null): never itemizes', async () => {
    // A payer assigned via scheduled service / customer default after
    // invoice creation leaves the raw column null — the live resolve must
    // still refuse to serialize the homeowner's siblings to the payer.
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    openBalance.openBalanceInvoices.mockImplementation(async () => [siblingRow()]);
    const PayerService = require('../services/payer');
    PayerService.resolveForInvoice.mockImplementationOnce(async () => ({ payerId: 'payer-late' }));
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
  });

  test('gate ON, anchor payer resolution FAILS: declines to itemize (fail closed)', async () => {
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    openBalance.openBalanceInvoices.mockImplementation(async () => [siblingRow()]);
    const PayerService = require('../services/payer');
    PayerService.resolveForInvoice.mockImplementationOnce(async () => { throw new Error('payer service down'); });
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
  });

  test('gate ON, incomplete sibling read (resolve failure): declines to itemize rather than understate', async () => {
    isEnabled.mockImplementation((key) => key === 'payIncludeBalance');
    openBalance.openBalanceInvoices.mockImplementation(async (customerId, { onResolveFailure } = {}) => {
      if (onResolveFailure) onResolveFailure(new Error('payer service down'));
      return [siblingRow()];
    });
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
  });
});
