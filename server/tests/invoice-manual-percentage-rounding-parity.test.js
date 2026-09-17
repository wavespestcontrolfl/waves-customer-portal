/**
 * Codex GitHub round 4 on #4568, P1 — a direct consequence of the previous
 * round's rounding correction. discount-engine.js's preview now rounds a
 * manual percentage discount cent-exact (via server/services/discount-
 * stack.js), but InvoiceService.create (server/services/invoice.js, the
 * SAVE this previews) still used the old float formula: 5% of $20.70
 * previewed $1.04 ($19.66 net) while the save computed $1.03 ($19.67 net).
 * The delegation's own header comment claimed the save "would" already
 * produce $1.04 — that was wrong at the time.
 *
 * Fixed by exporting discount-stack.js's cent-exact percentageDiscountDollars
 * and using it at the ONE expression in invoice.js that used to run the old
 * float formula (nothing else in invoice.js changes — no stacking wiring,
 * no gate read; that stays slice 5, invoice/document calculation).
 *
 * This file drives the ACTUAL save arithmetic — InvoiceService.create,
 * mocked db and all, the same way invoice-tier-discounts.test.js and
 * invoice-manual-discount-line.test.js do — against the ACTUAL preview
 * (DiscountEngine.calculateDiscounts, real implementation, only
 * recordInvoiceDiscounts stubbed so create() doesn't need an
 * invoice_discounts table mock) for the half-cent boundary case and a
 * brute-force sample, asserting the two report identical per-line dollars.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => {
  const actual = jest.requireActual('../services/discount-engine');
  return {
    ...actual,
    // create() only calls recordInvoiceDiscounts (an audit-log write) —
    // stubbed so this test needs no invoice_discounts table mock.
    // calculateDiscounts stays the REAL implementation: it's the preview
    // side of the parity comparison below.
    recordInvoiceDiscounts: jest.fn(),
  };
});
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-16'),
  addETDays: jest.fn(() => new Date('2026-10-16T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const InvoiceService = require('../services/invoice');

let nextId = 0;
function percentageDiscountRow(overrides) {
  return {
    id: `discount-${nextId++}`,
    discount_key: 'k',
    name: 'Test Discount',
    discount_type: 'percentage',
    amount: 5,
    max_discount_dollars: null,
    color: null,
    icon: null,
    is_active: true,
    is_waveguard_tier_discount: false,
    promo_code: null,
    is_auto_apply: true,
    requires_military: false,
    requires_senior: false,
    requires_multi_home: false,
    requires_new_customer: false,
    requires_referral: false,
    requires_prepayment: false,
    requires_waveguard_tier: null,
    service_key_filter: null,
    service_category_filter: null,
    payment_method_condition: null,
    min_subtotal: null,
    min_service_count: null,
    show_in_invoices: true,
    show_in_estimates: true,
    is_stackable: true,
    stack_group: null,
    priority: 0,
    ...overrides,
  };
}

// Mocks 'customers', 'discounts' (both calculateDiscounts' `.where().orderBy()`
// listing AND loadInvoiceDiscountRows' `.whereIn().where()` lookup), 'invoices',
// and a generic catch-all for everything else create() touches along the way
// (scheduled_services, customer_discounts, service_records, ...) — the same
// pattern invoice-manual-discount-line.test.js already uses.
function setupDb({ customer, discounts }) {
  let insertedInvoice = null;
  const byId = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q._ids ? q._ids.map((id) => byId.get(id)).filter(Boolean) : discounts;
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

async function saveDiscountDollars(subtotal, discountRow) {
  setupDb({
    customer: { id: 'customer-1', property_type: 'residential' },
    discounts: [discountRow],
  });
  const invoice = await InvoiceService.create({
    customerId: 'customer-1',
    title: 'Test Service',
    lineItems: [{ description: 'Test Service', quantity: 1, unit_price: subtotal }],
    discountIds: [discountRow.id],
  });
  return invoice.discount_amount;
}

async function previewDiscountDollars(subtotal, discountRow) {
  setupDb({ customer: null, discounts: [discountRow] });
  const result = await DiscountEngine.calculateDiscounts(null, { subtotal });
  return result.discounts[0] ? result.discounts[0].discount_dollars : 0;
}

describe('save (InvoiceService.create) and preview (DiscountEngine.calculateDiscounts) agree on a manual percentage discount', () => {
  test('the exact known divergence: 5% of $20.70 is $1.04 on BOTH sides now, never the old $1.03 save', async () => {
    const row = percentageDiscountRow({ amount: 5 });
    const previewDollars = await previewDiscountDollars(20.70, row);
    const saveDollars = await saveDiscountDollars(20.70, row);
    expect(previewDollars).toBe(1.04);
    expect(saveDollars).toBe(1.04);
  });

  test('a capped percentage agrees on both sides', async () => {
    const row = percentageDiscountRow({ amount: 50, max_discount_dollars: 10 });
    const previewDollars = await previewDiscountDollars(100, row);
    const saveDollars = await saveDiscountDollars(100, row);
    expect(previewDollars).toBe(10);
    expect(saveDollars).toBe(10);
  });

  test('brute-force sample: 300 random (subtotal, rate) pairs agree exactly on both sides', async () => {
    function mulberry32(seed) {
      let a = seed;
      return function rand() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = mulberry32(20260916);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const subtotal = Math.round((rand() * 499 + 1) * 100) / 100;
      const amount = Math.round(rand() * 59 + 1);
      const row = percentageDiscountRow({ amount });
      const previewDollars = await previewDiscountDollars(subtotal, row);
      const saveDollars = await saveDiscountDollars(subtotal, row);
      expect(saveDollars).toBe(previewDollars);
      checked++;
    }
    expect(checked).toBe(300);
  });
});
