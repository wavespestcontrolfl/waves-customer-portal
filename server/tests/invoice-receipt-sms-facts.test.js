/**
 * receiptSmsFacts — the shared money facts behind the receipt SMS and the
 * combined completion+receipt text. Pins:
 *   - card line formatting (one formatter for every payment text)
 *   - refund-aware amount: net cash kept on a recorded refund, amount due
 *     (total − credit_applied) otherwise, amount-due fallback with no
 *     payment row
 *   - tokenless invoices produce no receipt link rather than a broken one
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: () => 'https://portal.example.com',
}));

const db = require('../models/db');
const { formatCardLine } = require('../services/invoice-helpers');
const InvoiceService = require('../services/invoice');

function mockPaymentLookup(paymentRow) {
  db.mockImplementation((table) => {
    expect(table).toBe('payments');
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      whereRaw: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      first: jest.fn(async () => paymentRow),
      catch: undefined,
    };
    // knex query is thenable; the code calls .first().catch(...)
    q.first = jest.fn(() => ({ catch: async () => paymentRow }));
    return q;
  });
}

const BASE_INVOICE = {
  id: 'inv-1',
  customer_id: 'cust-1',
  token: 'tok123',
  invoice_number: 'WPC-2099-0001',
  total: '214.00',
  credit_applied: '0.00',
  card_brand: 'visa',
  card_last_four: '4242',
};

describe('formatCardLine', () => {
  test('formats brand + last4 and stays empty when either is missing', () => {
    expect(formatCardLine('visa', '4242')).toBe(' (Visa ending 4242)');
    expect(formatCardLine('VISA', '7299')).toBe(' (VISA ending 7299)');
    expect(formatCardLine(null, '4242')).toBe('');
    expect(formatCardLine('visa', null)).toBe('');
  });
});

describe('receiptSmsFacts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('amount is the payment net of a recorded refund', async () => {
    mockPaymentLookup({ amount: '214.00', refund_amount: '50.00' });
    const facts = await InvoiceService.receiptSmsFacts(BASE_INVOICE);
    expect(facts.amount).toBe('164.00');
    expect(facts.cardLine).toBe(' (Visa ending 4242)');
    expect(facts.receiptUrl).toBe('https://portal.example.com/pay/tok123');
  });

  test('falls back to amount due (total − credit_applied) without a payment row', async () => {
    mockPaymentLookup(null);
    const facts = await InvoiceService.receiptSmsFacts({ ...BASE_INVOICE, credit_applied: '50.00' });
    expect(facts.amount).toBe('164.00');
  });

  test('un-refunded payment row still reports amount due, and no token means no link', async () => {
    mockPaymentLookup({ amount: '214.00', refund_amount: null });
    const facts = await InvoiceService.receiptSmsFacts({ ...BASE_INVOICE, token: null, card_brand: null });
    expect(facts.amount).toBe('214.00');
    expect(facts.receiptUrl).toBe('');
    expect(facts.cardLine).toBe('');
  });
});
