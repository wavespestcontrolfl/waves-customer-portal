/**
 * Labeled manual-discount line on accept-generated invoices (owner
 * 2026-07-11): the estimate's promised discount label follows onto the
 * invoice via a plain negative line item (no discount_id / discount_for),
 * with the parent line grossed up by the same slice so the TOTAL is
 * unchanged by construction. create() must roll the negative line into
 * invoices.discount_amount and surface the line's own description as the
 * discount_label — never the generic "Line-item discounts".
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-07-12'),
  addETDays: jest.fn(() => new Date('2026-08-11T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function setupDb({ customer }) {
  let insertedInvoice = null;
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => customer),
      };
      return q;
    }
    if (table === 'discounts') {
      const q = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return {
            returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]),
          };
        }),
      };
      return q;
    }
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() => q),
      leftJoin: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      select: jest.fn(async () => []),
      first: jest.fn(async () => null),
      insert: jest.fn(async () => []),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  });
  return { getInsertedInvoice: () => insertedInvoice };
}

describe('labeled manual-discount line (accept-generated invoices)', () => {
  test('plain negative line rolls into discount_amount with its own label; total = net by construction', async () => {
    // First application net $110.00, promised "Referral Credit" slice $15.00:
    // the accept leg grosses the line to $125.00 and adds the −$15.00 line.
    const ctx = setupDb({ customer: { id: 'customer-1', property_type: 'residential' } });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'First Service Application',
      lineItems: [
        { description: 'First service application', quantity: 1, unit_price: 125 },
        { description: 'Referral Credit', quantity: 1, unit_price: -15 },
      ],
    });
    expect(invoice.subtotal).toBe(125);
    expect(invoice.discount_amount).toBe(15);
    expect(invoice.total).toBe(110);
    expect(ctx.getInsertedInvoice().discount_label).toBe('Referral Credit');
  });

  test('setup fee rides beside the grossed first application untouched', async () => {
    // $99.00 setup + $93.99 net first app with a $6.25 "Spring Promo" slice:
    // gross line = 100.24, subtotal = 199.24, discount = 6.25 → total must
    // equal 99 + 93.99 = 192.99 exactly (the setup fee is never discounted).
    const ctx = setupDb({ customer: { id: 'customer-1', property_type: 'residential' } });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'WaveGuard Membership Setup + First Application',
      lineItems: [
        { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
        { description: 'First service application', quantity: 1, unit_price: 100.24 },
        { description: 'Spring Promo', quantity: 1, unit_price: -6.25 },
      ],
    });
    expect(invoice.subtotal).toBe(199.24);
    expect(invoice.discount_amount).toBe(6.25);
    expect(invoice.total).toBe(192.99);
    expect(ctx.getInsertedInvoice().discount_label).toBe('Spring Promo');
  });
});
