/**
 * GET /api/pay/:token — previousBalance block (GATE_BALANCE_VISIBILITY,
 * owner ruling 2026-08-08).
 *
 * Contract:
 *   - gate ON + other open self-pay invoices → `previousBalance` with the
 *     cents-safe total and each invoice's own existing /pay link
 *   - gate OFF → field ABSENT — payload byte-identical to today
 *   - payer-billed pay pages NEVER list the homeowner's other invoices (an
 *     AP contact must not see the homeowner's unrelated balance)
 *   - a lookup failure renders the pay page exactly as today
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
jest.mock('../services/stripe', () => ({ isAvailable: () => true }));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test_1' }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateInvoicePDF: jest.fn() }));
jest.mock('../services/payment-method-consents', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/bill-payment-error-alerts', () => ({ alertBillPaymentError: jest.fn(async () => {}) }));
jest.mock('../services/payer', () => ({ attachToInvoice: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: { autoApplyAccountCredit: false },
}));
jest.mock('../services/open-balance', () => ({
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, invoices: [] })),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceSummary } = require('../services/open-balance');
const payRouter = require('../routes/pay-v2');

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}

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
  // invoiceRequiresSavedMethod's customers read: no billing mode, no monthly rate.
  db.mockImplementation((table) => {
    if (table === 'customers') return chain({ first: { billing_mode: null, monthly_rate: null } });
    return chain({ first: null });
  });
  const layer = payRouter.stack.find((l) => l.route?.path === '/:token' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { token: data.token } };
  let body = null;
  let statusCode = 200;
  const res = {
    json: (payload) => { body = payload; },
    status: (code) => { statusCode = code; return res; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { body, statusCode };
}

describe('GET /pay/:token previousBalance (GATE_BALANCE_VISIBILITY)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => false);
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, invoices: [] });
  });

  test('gate on: other open invoices ride previousBalance — informational only, NEVER sibling tokens or pay paths', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({
      total: 450,
      count: 3,
      moreCount: 1,
      invoices: [
        { invoice_number: 'INV-1', service_type: 'Rodent Trapping', service_date: '2026-06-02', due_date: '2026-06-16', total: '250.00', credit_applied: 0 },
        { invoice_number: 'INV-2', service_type: null, service_date: null, due_date: null, total: '200.00', credit_applied: 0 },
      ],
    });

    const { body } = await getPayPage(invoiceData());

    expect(openBalanceSummary).toHaveBeenCalledWith('cust-1', { excludeInvoiceId: 'inv-1' });
    expect(body.previousBalance).toEqual({
      total: 450,
      count: 3,
      moreCount: 1,
      invoices: [
        {
          invoiceNumber: 'INV-1',
          serviceType: 'Rodent Trapping',
          serviceDate: '2026-06-02',
          dueDate: '2026-06-16',
          amountDue: 250,
        },
        {
          invoiceNumber: 'INV-2',
          serviceType: null,
          serviceDate: null,
          dueDate: null,
          amountDue: 200,
        },
      ],
    });
    // One leaked invoice link must never fan out into bearer credentials for
    // the account's other invoices (pre-push P0).
    const serialized = JSON.stringify(body.previousBalance);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/payPath|\/pay\//);
  });

  test('gate off: field absent, no lookup', async () => {
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
    expect(openBalanceSummary).not.toHaveBeenCalled();
  });

  test('payer-billed page never lists the homeowner balance', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 1, moreCount: 0, invoices: [{ invoice_number: 'INV-1', total: '450.00', credit_applied: 0 }] });

    const { body } = await getPayPage(invoiceData({ payer_id: 'payer-1' }));

    expect(body).not.toHaveProperty('previousBalance');
    expect(openBalanceSummary).not.toHaveBeenCalled();
  });

  test('zero open balance: field absent', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    const { body } = await getPayPage(invoiceData());
    expect(body).not.toHaveProperty('previousBalance');
  });

  test('a lookup failure renders the pay page exactly as today', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockRejectedValue(new Error('db down'));

    const { body } = await getPayPage(invoiceData());

    expect(body.invoice.invoiceNumber).toBe('WPC-2026-0123');
    expect(body).not.toHaveProperty('previousBalance');
  });
});
