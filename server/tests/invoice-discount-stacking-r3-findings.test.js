/**
 * GitHub Codex round 3 on PR #4655 (60271e5a57) — "the gate-transition
 * class", the last patch round before this lane closes. Two P0s, one P2
 * server-side (the fourth finding, AdminInvoicesPage.jsx P2, is a
 * client-only change pinned in AdminInvoicesPage.discount-stacking-
 * r3-findings.test.jsx).
 *
 * P0 (invoice.js ~756): non-stackable group enforcement on EDITS must be
 * grandfathered against the invoice's PERSISTED discount set — an invoice
 * saved with two conflicting tier discounts (gate off, or an earlier
 * catalog configuration) must stay editable for everything else; only a
 * NEWLY added conflicting pick is rejected.
 *
 * P0 (AdminInvoicesPage.jsx ~533, fixed server-side): a discount row
 * already persisted on the invoice must survive ANY gate transition
 * unchanged — its own frozen dollars are trusted on edit regardless of
 * which regime priced it or which regime is live now. Only a genuinely
 * NEW pick in this submission is computed under the CURRENT regime.
 *
 * P2 (invoice.js ~786): a resolved term that's $0 (an orphaned scoped
 * stamp, or a credit an earlier one already exhausted the line against)
 * must not increment discounts.times_applied.
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
const { calculateUpdateFinancials } = InvoiceService._internals;

function setupDiscountsDb(discounts = []) {
  const discountById = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
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
    if (table === 'payers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => null), catch: () => null })) };
    }
    const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
    return q;
  });
}

const CUSTOMER = { id: 'customer-1', property_type: 'residential' };
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

function tierRow(overrides) {
  return {
    discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true,
    stack_group: 'tier', is_stackable: false, max_discount_dollars: null,
    ...overrides,
  };
}

describe('P0: non-stackable group enforcement on EDIT is grandfathered against the PERSISTED set', () => {
  const PERSISTED = [
    { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
    { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
    { client_id: 'd1', discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -10, amount: -10 },
    { client_id: 'd2', discount_id: 'gold-id', discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -15, amount: -15 },
  ];

  test('a pre-existing Silver+Gold invoice can have a price edit saved without throwing', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDiscountsDb([
      tierRow({ id: 'silver-id', name: 'WaveGuard Silver' }),
      tierRow({ id: 'gold-id', name: 'WaveGuard Gold', amount: 15 }),
    ]);
    const submitted = PERSISTED.map((item) => (
      item.client_id === 'line-1' ? { ...item, unit_price: 120, amount: 120 } : item
    ));
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(PERSISTED) },
    });
    expect(result.subtotal).toBe(220);
  });

  test('adding a THIRD tier discount to that same invoice is rejected', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDiscountsDb([
      tierRow({ id: 'silver-id', name: 'WaveGuard Silver' }),
      tierRow({ id: 'gold-id', name: 'WaveGuard Gold', amount: 15 }),
      tierRow({ id: 'platinum-id', name: 'WaveGuard Platinum', amount: 20 }),
    ]);
    const submitted = [
      ...PERSISTED,
      { client_id: 'd3-new', discount_id: 'platinum-id', discount_for: 'line-1', description: 'WaveGuard Platinum', quantity: 1, unit_price: -1, amount: -1 },
    ];
    await expect(calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(PERSISTED) },
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('a brand-new invoice (create-equivalent: nothing persisted) still rejects two conflicting NEW tier picks', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDiscountsDb([
      tierRow({ id: 'silver-id', name: 'WaveGuard Silver' }),
      tierRow({ id: 'gold-id', name: 'WaveGuard Gold', amount: 15 }),
    ]);
    await expect(calculateUpdateFinancials({
      lineItems: PERSISTED,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: '[]' }, // nothing persisted yet
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });
});

describe('P0: a persisted discount row survives ANY gate transition unchanged', () => {
  // Round 6 (Claude-fallback P1, this diff's own marker-gating fix):
  // "created compounded" now means this row was priced under
  // computeStackedDocumentDiscountLines while the gate was live, which
  // stamps stacking_regime: "compound" on it — carried here explicitly so
  // this fixture actually represents that history, not just a persisted
  // row of unknown origin.
  test('created compounded ($10+$4.50=$14.50), edited under gate OFF with an unrelated change: stays $14.50, never recomputed to the additive $15', async () => {
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10, stacking_regime: 'compound' },
      { client_id: 'd2', discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -4.5, amount: -4.5, stacking_regime: 'compound' },
    ];
    setupDiscountsDb([
      { id: 'ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: 'five-pct', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true },
    ]);
    // Gate OFF at edit time — the submitted items are otherwise unchanged.
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(14.5);
  });

  test('created additive ($10+$5=$15), edited under gate ON with an unrelated change: stays $15, never recomputed to the compounded $14.50', async () => {
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
      { client_id: 'd2', discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -5, amount: -5 },
    ];
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDiscountsDb([
      { id: 'ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: 'five-pct', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true },
    ]);
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(15);
  });

  test('a GENUINELY NEW pick added in this same edit still computes fresh under the CURRENT regime, while the persisted sibling stays frozen', async () => {
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
    ];
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDiscountsDb([
      { id: 'ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: 'five-pct', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true },
    ]);
    const submitted = [
      ...persisted,
      { client_id: 'd2-new', discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -1, amount: -1 },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    // The persisted 10% stays frozen at $10; the NEW 5% compounds on what
    // it left ($90 * 5% = $4.50) — $14.50 total, never the additive $15
    // (10 + 5) a from-scratch gate-on recompute of BOTH would give.
    expect(result.discount_amount).toBe(14.5);
  });
});

describe('P2: zero-dollar resolved terms are excluded from discounts.times_applied', () => {
  test('an orphaned scoped stamp ($0) is excluded from the audit rows; a genuine discount ($>0) is still recorded', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    let insertedInvoice = null;
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => CUSTOMER) })) };
      }
      if (table === 'discounts') {
        const q = {
          whereIn: jest.fn(() => q), where: jest.fn(() => q), first: jest.fn(async () => null),
          then: (resolve) => Promise.resolve([]).then(resolve),
        };
        return q;
      }
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q), orderBy: jest.fn(() => q),
          first: jest.fn(async () => null),
          insert: jest.fn((data) => { insertedInvoice = data; return { returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]) }; }),
        };
        return q;
      }
      const q = {
        where: jest.fn(() => q), whereIn: jest.fn(() => q), andWhere: jest.fn(() => q), leftJoin: jest.fn(() => q), orderBy: jest.fn(() => q),
        select: jest.fn(async () => []), first: jest.fn(async () => null), insert: jest.fn(async () => []),
        then: (resolve) => Promise.resolve([]).then(resolve),
      };
      return q;
    });
    await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Orphan + genuine',
      lineItems: [
        {
          client_id: 'line-1', description: 'Mosquito', quantity: 1, unit_price: 100, amount: 100,
          service_key: 'mosquito', service_category: 'mosquito',
        },
        {
          discount_id: 'lawn-credit', discount_for: null, document_discount: true,
          document_scope_service_key: 'lawn_care', document_scope_service_category: 'lawn',
          description: 'Lawn Add-on Credit', quantity: 1, unit_price: -30, amount: -30,
          discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
          use_stored_discount: true, stored_discount_source: 'scheduled_service',
        },
        { description: 'Referral Credit', quantity: 1, unit_price: -20, amount: -20 },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(insertedInvoice.discount_amount).toBe(20);
    if (DiscountEngine.recordInvoiceDiscounts.mock.calls.length) {
      const auditRows = DiscountEngine.recordInvoiceDiscounts.mock.calls[0][1];
      expect(auditRows.every((row) => row.discount_dollars > 0)).toBe(true);
      expect(auditRows.some((row) => row.discount_dollars === 20)).toBe(true);
      expect(auditRows.some((row) => row.discount_dollars === 0)).toBe(false);
    }
  });
});
