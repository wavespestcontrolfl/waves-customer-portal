/**
 * GitHub Codex round 4 on PR #4655 (90d4eba989) — P1: an orphaned
 * LINE-scoped (discount_for-set) trusted/frozen discount item must
 * resolve to $0, the same orphaned ⇒ $0 rule already enforced for
 * document-wide (unparented) scoped stamps — not silently replay its
 * frozen face value. classifyInvoiceDiscountItem gives a discount_for
 * item with no matching line parent:null, spansAll:false, so it joined
 * NEITHER lineEntries nor documentEntries and never reached the engine;
 * resolveStoredDiscountLineItem's override check (`overrideDollars !=
 * null`) treated the resulting `undefined` the same as "no override" and
 * fell back to the frozen value. Fixed in both the gate-on
 * (computeStackedDocumentDiscountLines) and gate-off (calculateUpdateFinancials's
 * own per-item branch) paths, for gate-transition consistency.
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
const InvoiceService = require('../services/invoice');
const { calculateUpdateFinancials } = InvoiceService._internals;

function setupDb() {
  db.mockImplementation((table) => {
    if (table === 'discounts') {
      const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), first: jest.fn(async () => null), then: (resolve) => Promise.resolve([]).then(resolve) };
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
beforeEach(() => { jest.clearAllMocks(); setupDb(); });
afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

function orphanFixture() {
  const persisted = [
    { client_id: 'line-1', description: 'Pest (about to be removed)', quantity: 1, unit_price: 100, amount: 100 },
    { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 50, amount: 50 },
    {
      client_id: 'd1', discount_id: null, discount_for: 'line-1', description: 'Frozen Stamp',
      quantity: 1, unit_price: -30, amount: -30,
      use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 30,
    },
  ];
  // line-1 removed; its child discount item is submitted anyway (the
  // theoretical gap the finding describes — cascade-delete normally
  // prevents this via the UI, but the server must not trust the client).
  const submitted = [
    { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 50, amount: 50 },
    {
      client_id: 'd1', discount_id: null, discount_for: 'line-1', description: 'Frozen Stamp',
      quantity: 1, unit_price: -30, amount: -30,
      use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 30,
    },
  ];
  return { persisted, submitted };
}

describe('orphaned line-scoped trusted item resolves to $0, never its frozen face value', () => {
  test('gate ON: the orphaned $30 stamp contributes $0 — subtotal $50, discount $0, total $50', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const { persisted, submitted } = orphanFixture();
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.subtotal).toBe(50);
    expect(result.discount_amount).toBe(0);
    expect(result.total).toBe(50);
  });

  test('gate OFF: the same orphaned stamp also contributes $0 — gate-transition consistency', async () => {
    const { persisted, submitted } = orphanFixture();
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.subtotal).toBe(50);
    expect(result.discount_amount).toBe(0);
    expect(result.total).toBe(50);
  });

  test('gate ON: a NON-orphaned line-scoped stamp (its line still present) keeps replaying its frozen $30 unaffected', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const { persisted } = orphanFixture();
    // Resubmit unchanged — line-1 still present, the stamp still targets it.
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.subtotal).toBe(150);
    expect(result.discount_amount).toBe(30);
    expect(result.total).toBe(120);
  });

  test('a FRESH (non-trusted) orphaned discount_for item still throws "Invalid line-item discount" — unaffected by this fix', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const submitted = [
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 50, amount: 50 },
      { client_id: 'd1', discount_id: 'some-catalog-id', discount_for: 'line-1', description: 'Fresh pick', quantity: 1, unit_price: -10, amount: -10 },
    ];
    await expect(calculateUpdateFinancials({
      lineItems: submitted,
      customer: CUSTOMER,
      invoice: { id: 'invoice-1', line_items: '[]' },
    })).rejects.toThrow('Invalid line-item discount');
  });
});
