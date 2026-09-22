/**
 * GitHub round 6 on PR #4655 (468f4ba2dc) — the marker-gated fix to the
 * isFrozenByPosition finding a prior round's own audit raised (and this
 * lane's first revert attempt only partly closed, per the coordinator's
 * explicit ruling): freeze-by-position in calculateUpdateFinancials's
 * gate-OFF branch must apply ONLY to a row THIS engine itself priced
 * under compounding (stamped `stacking_regime: "compound"` by
 * computeStackedDocumentDiscountLines, gate-ON only) — never to an
 * ordinary persisted row that predates this lane or was never once saved
 * while the gate was live. Those keep main's unconditional live recompute
 * (resolveLineItemDiscount against the CURRENT parent gross), byte-
 * identical to main for every row main could ever have produced.
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
  etDateString: jest.fn(() => '2026-09-23'),
  addETDays: jest.fn(() => new Date('2026-10-23T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { calculateUpdateFinancials } = InvoiceService._internals;

function setupDb({ discounts = [] } = {}) {
  const byId = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_f, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve) => Promise.resolve(q._ids ? q._ids.map((id) => byId.get(id)).filter(Boolean) : discounts).then(resolve),
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

afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

describe('P1 (round 6): gate-OFF freeze-by-position is gated on the stacking_regime marker', () => {
  test('(a) a PRE-LANE persisted percentage discount (no marker) still live-recomputes on gate OFF — byte-identical to main', async () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    const tenId = 'ten-pct';
    setupDb({ discounts: [
      { id: tenId, discount_key: 'ten', name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
    ] });
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      // No stacking_regime — this row predates the lane (or was never once
      // saved while the gate was live).
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
    ];
    // Operator edits the parent line's price $100 -> $200. A live
    // recompute (main's own behavior) gives 10% of $200 = $20, never the
    // stale frozen $10.
    const submitted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 200, amount: 200 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(20);
  });

  test('(b) a discount MINTED under GATE ON (marker stamped), edited after the gate rolls back, keeps its stored dollars', async () => {
    const tenId = 'ten-pct-2';
    setupDb({ discounts: [
      { id: tenId, discount_key: 'ten2', name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
    ] });
    // Simulate: this row was priced under compounding at create/edit time
    // while the gate was live — computeStackedDocumentDiscountLines would
    // have stamped it. Persisted with the marker already on it.
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      {
        client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent',
        quantity: 1, unit_price: -10, amount: -10, stacking_regime: 'compound',
      },
    ];
    // Gate now rolled back (unset). Operator edits the parent line's price.
    delete process.env.GATE_DISCOUNT_STACKING;
    const submitted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 200, amount: 200 },
      {
        client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent',
        quantity: 1, unit_price: -10, amount: -10, stacking_regime: 'compound',
      },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    // Stays pinned to its own $10 — never silently reverted to a fresh
    // $20 recompute out from under an already-compounded total.
    expect(result.discount_amount).toBe(10);
  });

  test('computeStackedDocumentDiscountLines (gate ON) stamps stacking_regime: "compound" on the resolved item', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const tenId = 'ten-pct-3';
    setupDb({ discounts: [
      { id: tenId, discount_key: 'ten3', name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
    ] });
    const lineItems = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
    ];
    const result = await calculateUpdateFinancials({
      lineItems,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: '[]' },
    });
    const items = JSON.parse(result.line_items);
    const discountItem = items.find((i) => i.client_id === 'd1');
    expect(discountItem.stacking_regime).toBe('compound');
  });
});
