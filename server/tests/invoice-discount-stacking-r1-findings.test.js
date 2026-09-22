/**
 * GitHub Codex round 1 on PR #4655 (9ba05da027) — two server findings,
 * each pinned here.
 *
 * P1 (invoice.js ~619): a stamp with BOTH discount_service_key_filter AND
 * discount_service_category_filter must match a line on EVERY configured
 * predicate (AND) — the same rule admin-schedule.js's own booking
 * calculation enforces (admin-schedule.js:2088-2092) — not just one (the
 * old `||`). A line sharing only the CATEGORY of a removed keyed service
 * must not silently absorb the frozen credit; the orphaned-$0 rule must
 * still fire.
 *
 * P2 (invoice.js ~646): a manual discountIds pick's stable `id` must ride
 * into its document term so stackOrder's identity tie-break (id beats
 * array/query position) decides which of two value-tied picks compounds
 * first — deterministically, regardless of the order the caller happened
 * to list them in.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-22'),
  addETDays: jest.fn(() => new Date('2026-10-22T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const InvoiceService = require('../services/invoice');

function setupDb({ customer, discounts = [] }) {
  let insertedInvoice = null;
  const discountById = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q._ids ? q._ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
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
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return { returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]) };
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

const CUSTOMER = { id: 'customer-1', property_type: 'residential' };

beforeEach(() => { jest.clearAllMocks(); });

function stampItem({ dollars, scopeKey, scopeCategory }) {
  return {
    discount_id: 'lawn-credit',
    discount_for: null,
    document_discount: true,
    document_scope_service_key: scopeKey,
    document_scope_service_category: scopeCategory,
    description: 'Lawn Add-on Credit',
    quantity: 1,
    unit_price: -dollars,
    amount: -dollars,
    discount_type: 'fixed_amount',
    discount_amount: dollars,
    discount_dollars: dollars,
    use_stored_discount: true,
    stored_discount_source: 'scheduled_service',
  };
}

describe('P1: mixed key+category scope requires ALL configured predicates (AND)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });
  beforeEach(() => { process.env.GATE_DISCOUNT_STACKING = 'true'; });

  test('a line sharing only the CATEGORY of a removed keyed line must NOT absorb the credit — orphaned $0, not a category-only match', async () => {
    setupDb({ customer: CUSTOMER });
    // The stamp was frozen for a "lawn_care" line in the "lawn" category.
    // That line is gone; the ONLY line left shares the CATEGORY but has a
    // DIFFERENT key ("mosquito_lawn_addon") — the old `||` let category
    // alone satisfy the scope and replay the credit here anyway.
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Mixed-scope invoice',
      lineItems: [
        {
          client_id: 'line-1', description: 'Mosquito (lawn category)', quantity: 1, unit_price: 100, amount: 100,
          service_key: 'mosquito_lawn_addon', service_category: 'lawn',
        },
        stampItem({ dollars: 30, scopeKey: 'lawn_care', scopeCategory: 'lawn' }),
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.subtotal).toBe(100);
    expect(invoice.discount_amount).toBe(0);
    expect(invoice.total).toBe(100);
  });

  test('a line matching BOTH the key AND the category still absorbs the credit normally', async () => {
    setupDb({ customer: CUSTOMER });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Mixed-scope invoice',
      lineItems: [
        {
          client_id: 'line-1', description: 'Lawn Care', quantity: 1, unit_price: 100, amount: 100,
          service_key: 'lawn_care', service_category: 'lawn',
        },
        stampItem({ dollars: 30, scopeKey: 'lawn_care', scopeCategory: 'lawn' }),
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.discount_amount).toBe(30);
    expect(invoice.total).toBe(70);
  });

  test('a line matching the KEY but a DIFFERENT category also fails to match (AND, not OR, in the other direction)', async () => {
    setupDb({ customer: CUSTOMER });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Mixed-scope invoice',
      lineItems: [
        {
          client_id: 'line-1', description: 'Lawn Care (recategorized)', quantity: 1, unit_price: 100, amount: 100,
          service_key: 'lawn_care', service_category: 'specialty',
        },
        stampItem({ dollars: 30, scopeKey: 'lawn_care', scopeCategory: 'lawn' }),
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.discount_amount).toBe(0);
    expect(invoice.total).toBe(100);
  });

  test('a key-only filter (no category set) still matches on key alone — unaffected by the AND fix', async () => {
    setupDb({ customer: CUSTOMER });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Key-only scope invoice',
      lineItems: [
        {
          client_id: 'line-1', description: 'Lawn Care', quantity: 1, unit_price: 100, amount: 100,
          service_key: 'lawn_care', service_category: 'lawn',
        },
        stampItem({ dollars: 30, scopeKey: 'lawn_care', scopeCategory: null }),
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.discount_amount).toBe(30);
  });
});

describe('P2: a manual pick\'s stable id decides canonical order, not array/query position', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });
  beforeEach(() => { process.env.GATE_DISCOUNT_STACKING = 'true'; });

  test('two value-tied $60 fixed credits on $100: "a-credit" (lower id) always compounds first, regardless of array order', async () => {
    setupDb({
      customer: CUSTOMER,
      discounts: [
        { id: 'b-credit', discount_type: 'fixed_amount', amount: 60, is_active: true, show_in_invoices: true, name: 'B Credit' },
        { id: 'a-credit', discount_type: 'fixed_amount', amount: 60, is_active: true, show_in_invoices: true, name: 'A Credit' },
      ],
    });
    await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Identity-tiebreak invoice',
      lineItems: [{ client_id: 'line-1', description: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
      // Deliberately listed with the LARGER-id-would-lose row first — if
      // identity isn't carried, this array position alone decides who
      // gets the full $60 and who gets clamped to $40.
      discountIds: ['b-credit', 'a-credit'],
    });
    const auditRows = DiscountEngine.recordInvoiceDiscounts.mock.calls[0][1];
    const byId = new Map(auditRows.map((r) => [r.id, r.discount_dollars]));
    // a-credit (lower id) processes FIRST in canonical order and takes its
    // full $60; b-credit is clamped to whatever the $100 base has left ($40).
    expect(byId.get('a-credit')).toBe(60);
    expect(byId.get('b-credit')).toBe(40);
  });

  test('reversing the input array order gives the IDENTICAL per-discount allocation — array position no longer matters', async () => {
    setupDb({
      customer: CUSTOMER,
      discounts: [
        { id: 'b-credit', discount_type: 'fixed_amount', amount: 60, is_active: true, show_in_invoices: true, name: 'B Credit' },
        { id: 'a-credit', discount_type: 'fixed_amount', amount: 60, is_active: true, show_in_invoices: true, name: 'A Credit' },
      ],
    });
    await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Identity-tiebreak invoice (reversed)',
      lineItems: [{ client_id: 'line-1', description: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
      discountIds: ['a-credit', 'b-credit'],
    });
    const auditRows = DiscountEngine.recordInvoiceDiscounts.mock.calls[0][1];
    const byId = new Map(auditRows.map((r) => [r.id, r.discount_dollars]));
    expect(byId.get('a-credit')).toBe(60);
    expect(byId.get('b-credit')).toBe(40);
  });
});
