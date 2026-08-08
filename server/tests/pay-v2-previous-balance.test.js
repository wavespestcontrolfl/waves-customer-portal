/**
 * GET /api/pay/:token — sibling-invoice isolation contract (balance-visibility
 * lane, pre-push P0 ×2).
 *
 * The pay page is an unauthenticated, PERMANENT, per-invoice bearer surface
 * (AGENTS.md: links are commonly forwarded — bookkeepers, spouses).
 * Possession of one invoice token must never disclose the account's OTHER
 * invoices — not their tokens, not their numbers/amounts/history, not the
 * balance total. Even with GATE_BALANCE_VISIBILITY on and other open
 * invoices present, the payload carries NO previous-balance data; the
 * consolidated view lives on customer-addressed surfaces only (invoice
 * email note + authenticated portal Billing tab).
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
  isEnabled: jest.fn(() => true),
  gates: { autoApplyAccountCredit: false },
}));
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => [{ invoice_number: 'INV-OLD', total: '450.00', credit_applied: 0 }]),
  openBalanceSummary: jest.fn(async () => ({
    total: 450,
    count: 1,
    moreCount: 0,
    invoices: [{ invoice_number: 'INV-OLD', total: '450.00', credit_applied: 0 }],
  })),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const openBalance = require('../services/open-balance');
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

describe('GET /pay/:token sibling-invoice isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('even with the visibility gate on and other open invoices, the payload carries NO sibling data', async () => {
    const { body } = await getPayPage(invoiceData());

    expect(body).not.toHaveProperty('previousBalance');
    // The route never consults the open-balance surface at all.
    expect(openBalance.openBalanceSummary).not.toHaveBeenCalled();
    expect(openBalance.openBalanceInvoices).not.toHaveBeenCalled();
    // Nothing about the sibling invoice leaks anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('INV-OLD');
    expect(serialized).not.toContain('450');
    // The page still renders its own invoice normally.
    expect(body.invoice.invoiceNumber).toBe('WPC-2026-0123');
  });
});
