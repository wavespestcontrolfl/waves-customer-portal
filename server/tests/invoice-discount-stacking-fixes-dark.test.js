/**
 * Dark-path pin for the finding-1 fix (invoice.js, PR #4405 Codex round 1):
 * with GATE_DISCOUNT_STACKING off, an invoice-level discount plus a
 * line-item discount must still resolve exactly as before this lane — each
 * discount independently against the untouched subtotal (additive), never
 * the gated compounding math. Own file (not a resetModules toggle inside
 * invoice-discount-stacking-fixes.test.js) because gates.discountStacking is
 * a module-load snapshot of process.env — same convention as
 * schedule-prepay-switch-dark.test.js.
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
  etDateString: jest.fn(() => '2026-09-11'),
  addETDays: jest.fn(() => new Date('2026-10-11T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');

async function mockTransaction(callback) {
  const trx = (...args) => db(...args);
  trx.isTransaction = true;
  trx.raw = db.raw;
  trx.fn = db.fn;
  trx.transaction = async (inner) => inner(trx);
  return callback(trx);
}

const InvoiceService = require('../services/invoice');

function setupDb({ customer, discounts = [] }) {
  const discountById = new Map(discounts.map((row) => [String(row.id), row]));

  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => customer) };
      return q;
    }
    if (table === 'discounts') {
      const q = {
        ids: null,
        whereIn: jest.fn((_field, ids) => { q.ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q.ids ? q.ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => ({
          returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]),
        })),
      };
      return q;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.transaction = jest.fn(mockTransaction);
}

describe('gate off: invoice-level + line-item discount stays additive (pre-lane math)', () => {
  test('a 10% invoice discount plus a 5% line discount is additive 15%, never the gated 14.5%', async () => {
    const INVOICE_10 = {
      id: 'invoice10-id', name: 'Loyalty 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true,
    };
    const LINE_5 = {
      id: 'line5-id', name: 'Referral 5%', discount_type: 'percentage', amount: 5,
      is_active: true, show_in_invoices: true,
    };
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' },
      discounts: [INVOICE_10, LINE_5],
    });
    const line = { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 };
    const pick = (d) => ({
      client_id: `d-${d.id}`, _kind: 'discount', discount_id: d.id, discount_for: 'line-1',
      description: d.name, quantity: 1, unit_price: -1, amount: -1,
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_5)],
      discountIds: [INVOICE_10.id],
    });

    // Pre-lane math: line 5% of $100 = $5; invoice 10% of the untouched
    // $100 subtotal = $10. Additive total = $15 (15%), not the gated $14.50.
    expect(invoice.discount_amount).toBe(15);
    expect(invoice.total).toBe(85);
  });

  test('a fixed invoice-level credit plus a line percentage is order-independent pre-lane math ($40 off either way)', async () => {
    const CREDIT_30 = {
      id: 'credit30-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 30,
      is_active: true, show_in_invoices: true,
    };
    const LINE_10 = {
      id: 'line10-id', name: 'Line 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true,
    };
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' },
      discounts: [CREDIT_30, LINE_10],
    });
    const line = { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 };
    const pick = (d) => ({
      client_id: `d-${d.id}`, _kind: 'discount', discount_id: d.id, discount_for: 'line-1',
      description: d.name, quantity: 1, unit_price: -1, amount: -1,
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_10)],
      discountIds: [CREDIT_30.id],
    });

    // Pre-lane math: line 10% of the untouched $100 = $10; invoice $30
    // fixed credit, also independent of the line discount = $30. Neither
    // resolves against the other, so order never matters here — $40 off,
    // $60 total (this is the gated-ON path's PRE-FIX regression number,
    // reached here for an unrelated reason: no compounding at all).
    expect(invoice.discount_amount).toBe(40);
    expect(invoice.total).toBe(60);
  });
});
