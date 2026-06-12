// Deposit credits are PRIOR PAYMENT, not price reductions: they must not
// shrink the commercial tax base or fold into discount reporting. The
// category: 'deposit_credit' line is excluded from the discount machinery
// and subtracted AFTER tax in InvoiceService.create.
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
  etDateString: jest.fn(() => '2026-06-12'),
  addETDays: jest.fn(() => new Date('2026-07-12T12:00:00Z')),
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
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return {
            returning: jest.fn(async () => [{ id: 'invoice-1', ...data }]),
          };
        }),
      };
      return q;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { getInsertedInvoice: () => insertedInvoice };
}

describe('deposit credit is after-tax prior payment, never a discount', () => {
  beforeEach(() => jest.clearAllMocks());

  const depositLine = {
    description: 'Deposit credit (paid at acceptance)',
    quantity: 1,
    unit_price: -70,
    category: 'deposit_credit',
  };
  const serviceLine = {
    description: 'First service application',
    quantity: 1,
    unit_price: 200,
  };

  it('COMMERCIAL: tax is computed on the full charge, then the deposit subtracts after tax', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, depositLine],
      taxRate: 0.07,
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);          // deposit is NOT a discount
    expect(row.tax_amount).toBe(14);              // 7% of 200, not of 130
    expect(row.total).toBe(144);                  // 200 + 14 − 70
    // The line stays visible on the invoice.
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(true);
  });

  it('RESIDENTIAL: no tax, total is charge minus deposit, discount stays zero', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, depositLine],
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);
    expect(row.tax_amount).toBe(0);
    expect(row.total).toBe(130);
  });

  it('REGRESSION GUARD: a plain negative line WITHOUT the category still behaves as a pre-tax discount', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, { description: 'Promo', quantity: 1, unit_price: -70 }],
      taxRate: 0.07,
    });
    const row = getInsertedInvoice();
    expect(row.discount_amount).toBe(70);
    expect(row.tax_amount).toBe(9.1);             // 7% of 130
    expect(row.total).toBe(139.1);
  });
});
