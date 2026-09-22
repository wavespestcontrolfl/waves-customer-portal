/**
 * Slice 5 of #4405 — the one correctness property this slice exists to
 * prove: DiscountEngine.calculateDiscounts (the /api/admin/discounts/
 * calculate PREVIEW an admin sees before saving) and InvoiceService.create
 * (the SAVE) compute the SAME total discount for the SAME set of manual
 * picks, in both gate states — because both now read discountStackingLive()
 * in the same change. An earlier round of this lane compounded only the
 * preview ($111 at 10%+5% previewed $94.90 while the additive save still
 * gave $94.35); this file is what would have caught that.
 *
 * Fixture matrix: percent-only, fixed+percent (the owner's own worked
 * example), a capped percent, and a brute-force sample — each driven
 * through BOTH the real DiscountEngine.calculateDiscounts and the real
 * InvoiceService.create (mocked db, no network), asserting identical
 * totals. Run twice: gate on (compounding — values checked against the
 * owner's "lesser of the two" ruling, not just "the two sides agree with
 * each other") and gate off (additive — byte-identical to before this
 * lane, the existing rounding fix aside).
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

let nextId = 0;
function discountRow(overrides) {
  return {
    id: `discount-${nextId++}`,
    discount_key: `key-${nextId}`,
    name: `Discount ${nextId}`,
    discount_type: 'percentage',
    amount: 10,
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

// Mocks 'customers', 'discounts' (calculateDiscounts' `.where().orderBy()`
// listing AND loadInvoiceDiscountRows' `.whereIn().where()` lookup),
// 'invoices', and a generic catch-all — same pattern
// invoice-manual-percentage-rounding-parity.test.js already uses.
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

async function previewTotal(subtotal, rows) {
  setupDb({ customer: null, discounts: rows });
  const result = await DiscountEngine.calculateDiscounts(null, { subtotal });
  return result.totalDiscount;
}

async function saveTotal(subtotal, rows) {
  setupDb({ customer: { id: 'customer-1', property_type: 'residential' }, discounts: rows });
  const invoice = await InvoiceService.create({
    customerId: 'customer-1',
    title: 'Test Service',
    lineItems: [{ description: 'Test Service', quantity: 1, unit_price: subtotal }],
    discountIds: rows.map((r) => r.id),
  });
  return invoice.discount_amount;
}

// One row per fixture entry: [subtotal, [discount overrides...]].
const FIXTURE_MATRIX = [
  // Percent-only: the owner's own worked example.
  [111, [{ discount_type: 'percentage', amount: 10 }, { discount_type: 'percentage', amount: 5 }]],
  // Fixed + percent: the owner's OTHER worked example.
  [111, [{ discount_type: 'percentage', amount: 10 }, { discount_type: 'fixed_amount', amount: 25 }]],
  // Capped percent, then a second uncapped percent on what's left.
  [100, [{ discount_type: 'percentage', amount: 50, max_discount_dollars: 10 }, { discount_type: 'percentage', amount: 10 }]],
  // Three-way mix.
  [250, [
    { discount_type: 'fixed_amount', amount: 20 },
    { discount_type: 'percentage', amount: 15 },
    { discount_type: 'percentage', amount: 5, max_discount_dollars: 8 },
  ]],
  // A single discount (degenerate case — compounding and additive agree).
  [60, [{ discount_type: 'fixed_amount', amount: 15 }]],
];

describe('gate ON — preview (DiscountEngine) and save (InvoiceService.create) compound identically', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  test.each(FIXTURE_MATRIX)('subtotal $%p, %j', async (subtotal, overridesList) => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = overridesList.map((o) => discountRow(o));
    const preview = await previewTotal(subtotal, rows);
    const saved = await saveTotal(subtotal, rows);
    expect(saved).toBe(preview);
  });

  test('the owner ruling worked example #1: 10% then 5% off $111 compounds to $16.10, never the additive $16.65', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [discountRow({ discount_type: 'percentage', amount: 10 }), discountRow({ discount_type: 'percentage', amount: 5 })];
    expect(await previewTotal(111, rows)).toBe(16.1);
    expect(await saveTotal(111, rows)).toBe(16.1);
  });

  test('the owner ruling worked example #2: 10% plus a $25 credit off $111 is $33.60, never the additive $36.10', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [discountRow({ discount_type: 'percentage', amount: 10 }), discountRow({ discount_type: 'fixed_amount', amount: 25 })];
    expect(await previewTotal(111, rows)).toBe(33.6);
    expect(await saveTotal(111, rows)).toBe(33.6);
  });

  test('brute-force sample: 300 random (subtotal, 1-3 discounts) fixtures agree exactly on both sides', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    function mulberry32(seed) {
      let a = seed;
      return function rand() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = mulberry32(20260922);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const subtotal = Math.round((rand() * 499 + 1) * 100) / 100;
      const count = Math.floor(rand() * 3) + 1;
      const rows = Array.from({ length: count }, () => {
        const kindRoll = rand();
        if (kindRoll < 0.6) {
          return discountRow({
            discount_type: 'percentage',
            amount: Math.floor(rand() * 40) + 1,
            max_discount_dollars: rand() < 0.3 ? Math.round((rand() * 79 + 1) * 100) / 100 : null,
          });
        }
        return discountRow({ discount_type: 'fixed_amount', amount: Math.round((rand() * 79 + 1) * 100) / 100 });
      });
      const preview = await previewTotal(subtotal, rows);
      const saved = await saveTotal(subtotal, rows);
      expect(saved).toBe(preview);
      checked++;
    }
    expect(checked).toBe(300);
  });
});

describe('gate OFF — preview and save stay additive, matching pre-lane totals exactly', () => {
  test.each(FIXTURE_MATRIX)('subtotal $%p, %j', async (subtotal, overridesList) => {
    const rows = overridesList.map((o) => discountRow(o));
    const preview = await previewTotal(subtotal, rows);
    const saved = await saveTotal(subtotal, rows);
    expect(saved).toBe(preview);
  });

  test('the owner ruling worked example #1, gate off: 10% then 5% off $111 stays the additive $16.65, never $16.10', async () => {
    const rows = [discountRow({ discount_type: 'percentage', amount: 10 }), discountRow({ discount_type: 'percentage', amount: 5 })];
    expect(await previewTotal(111, rows)).toBe(16.65);
    expect(await saveTotal(111, rows)).toBe(16.65);
  });
});
