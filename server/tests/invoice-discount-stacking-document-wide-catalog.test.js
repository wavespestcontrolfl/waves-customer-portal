/**
 * Coordinator scope extension (2026-09, slice 8 of #4405 / PR #4659):
 * server/services/invoice.js came free of its prior lane (#4655 merged),
 * so the client-only submit-boundary workaround from this slice's first
 * two audit rounds is replaced with the real fix here — a FRESH
 * document-wide (unparented, discount_for: null) catalog-backed discount
 * pick (discount_id set, resolving to a live catalog row) is now:
 *
 *  1. ADMITTED into computeStackedDocumentDiscountLines' document stack
 *     (documentEntries used to require entry.stored || no discount_id at
 *     all — a fresh catalog pick fell through to "Invalid line-item
 *     discount" on save).
 *  2. Priced under its OWN catalog type — documentEntryTerms used to
 *     force EVERY unparented entry to a literal fixed_amount term
 *     regardless of the catalog row's real type. A document PERCENTAGE
 *     term occupies a DIFFERENT canonical-order bucket than a fixed
 *     credit (discount-stack.js's stackOrder: fixed credits compound
 *     FIRST, document percentages compound LAST), so forcing one to
 *     fixed_amount silently changes the total whenever the invoice
 *     carries any other term. Pinned here with the auditor's own
 *     reproduction: a $100 line at 10% (line) + 10% (invoice-wide)
 *     previews AND saves $81 — never the $81.90 a forced-fixed
 *     conversion would give.
 *  3. Attributed correctly — the returned discount descriptor carries
 *     {id, row, discount_type, amount} (the SAME shape a per-line pick
 *     already returns), not the anonymous {id: null, row: null,
 *     discount_type: 'fixed_amount'} every OTHER unparented credit (a
 *     plain literal like "Referral Credit") still gets. This is what lets
 *     DiscountEngine.recordInvoiceDiscounts write invoice_discounts
 *     .discount_id and roll up discounts.times_applied /
 *     total_discount_given — the P1 this round exists to close.
 *  4. Still subject to the one-tier / stack-group rule
 *     (assertNewStackGroupConflicts, called inside
 *     computeStackedDocumentDiscountLines itself) exactly like a
 *     per-line pick — grandfathered once persisted, enforced while new.
 *
 * Driven directly against computeStackedDocumentDiscountLines
 * (InvoiceService._internals) — no DB mocking needed, every input is a
 * plain in-memory value — plus one end-to-end test through the real
 * InvoiceService.create (DB mocked, no network), matching
 * invoice-create-discount-stacking-parity.test.js's own pattern, to pin
 * the $81 figure through the actual save path and its invoice_discounts
 * audit row.
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
const { computeStackedDocumentDiscountLines } = InvoiceService._internals;

const TRUSTED = new Set(['scheduled_service', 'validated_checkout']);

function positiveLine(overrides) {
  return { client_id: 'l1', _kind: 'service', description: 'Quarterly Pest', quantity: 1, unit_price: 100, amount: 100, ...overrides };
}

function freshDocPick(overrides) {
  return { client_id: 'd-doc', _kind: 'discount', discount_for: null, discount_id: 'ten-pct-doc', description: 'Ten Percent Invoice-Wide', quantity: 1, unit_price: -1, amount: -1, ...overrides };
}

function catalogRow(overrides) {
  return { id: 'ten-pct-doc', name: 'Ten Percent Invoice-Wide', discount_type: 'percentage', amount: 10, max_discount_dollars: null, stack_group: null, is_stackable: true, ...overrides };
}

function run({ items, lineItemDiscountRowById, manualDiscountRows = [], persistedClientIds = new Set(), groupConflictMetaById = new Map() }) {
  const serviceLineByClientId = new Map(
    items.filter((i) => Number(i.amount) > 0 && i.client_id).map((i) => [String(i.client_id), i]),
  );
  return computeStackedDocumentDiscountLines({
    items,
    serviceLineByClientId,
    lineItemDiscountRowById,
    manualDiscountRows,
    trustedStoredSources: TRUSTED,
    persistedClientIds,
    groupConflictMetaById,
  });
}

describe('a FRESH document-wide catalog pick is admitted and priced under its own type', () => {
  test('a lone document-wide 10% pick on a $100 line resolves $10, with catalog attribution preserved', () => {
    const line = positiveLine();
    const pick = freshDocPick();
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts).toHaveLength(1);
    expect(lineItemDiscounts[0]).toMatchObject({
      id: 'ten-pct-doc',
      discount_type: 'percentage',
      amount: 10,
      dollars: 10,
    });
    expect(lineItemDiscounts[0].row).toMatchObject({ id: 'ten-pct-doc' });
    // The engine's own mutation contract: the item's own fields are
    // resolved to the ACTUAL dollars, same as every other discount path.
    expect(pick.unit_price).toBe(-10);
    expect(pick.amount).toBe(-10);
  });

  test("the auditor's own reproduction: a $100 line at 10% (line) + 10% (invoice-wide) totals $81, never the $81.90 a forced-fixed conversion would give", () => {
    const line = positiveLine();
    const linePick = { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'ten-pct-line', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 };
    const docPick = freshDocPick();
    const rowById = new Map([
      ['ten-pct-line', catalogRow({ id: 'ten-pct-line', name: 'Ten Percent' })],
      ['ten-pct-doc', catalogRow()],
    ]);
    const { lineItemDiscounts } = run({ items: [line, linePick, docPick], lineItemDiscountRowById: rowById });
    const totalDiscount = lineItemDiscounts.reduce((sum, d) => sum + d.dollars, 0);
    const net = Math.round((100 - totalDiscount) * 100) / 100;
    expect(net).toBe(81);
    expect(net).not.toBe(81.1); // the additive-both-at-10%-of-100 wrong answer
    expect(net).not.toBe(81.9); // the forced-fixed-conversion wrong answer this round fixes
  });

  test('a FIXED-type document-wide pick is unaffected (regression: identical to before this round)', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'twenty-five-fixed' });
    const rowById = new Map([['twenty-five-fixed', catalogRow({ id: 'twenty-five-fixed', discount_type: 'fixed_amount', amount: 25 })]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0]).toMatchObject({ id: 'twenty-five-fixed', discount_type: 'fixed_amount', amount: 25, dollars: 25 });
  });

  test("a custom/variable percentage document-wide pick resolves the OPERATOR-entered rate, not the catalog row's own 0", () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'custom-pct-doc', custom_discount_percentage: 15 });
    const rowById = new Map([['custom-pct-doc', catalogRow({ id: 'custom-pct-doc', discount_type: 'variable_percentage', amount: 0 })]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0]).toMatchObject({ discount_type: 'variable_percentage', amount: 15, dollars: 15 });
  });

  test('an unparented item whose discount_id resolves to NO catalog row (unknown/tampered id) still throws — this round only widens acceptance for a REAL row', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'does-not-exist' });
    expect(() => run({ items: [line, pick], lineItemDiscountRowById: new Map() })).toThrow('Invalid line-item discount');
  });

  test('a plain id-less literal credit (e.g. "Referral Credit") keeps its pre-lane anonymous shape — not every unparented item gets attribution, only a real catalog pick', () => {
    const line = positiveLine();
    const credit = { client_id: 'd-literal', _kind: 'discount', discount_for: null, description: 'Referral Credit', quantity: 1, unit_price: -25, amount: -25 };
    const { lineItemDiscounts } = run({ items: [line, credit], lineItemDiscountRowById: new Map() });
    expect(lineItemDiscounts[0]).toMatchObject({ id: null, row: null, discount_type: 'fixed_amount', dollars: 25 });
  });
});

describe('a PERSISTED document-wide catalog pick is grandfathered (frozen by position, attribution still preserved)', () => {
  test('a positionally-persisted document-wide pick resolves through the stored/frozen path and keeps its id', () => {
    const line = positiveLine();
    // Persisted: its OWN client_id is in persistedClientIds, and it
    // already carries its resolved discount_dollars from the prior save
    // (frozen by position — never re-derived from the live catalog rate).
    const pick = freshDocPick({ client_id: 'd-doc', discount_dollars: 10, unit_price: -10, amount: -10 });
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    const { lineItemDiscounts } = run({
      items: [line, pick],
      lineItemDiscountRowById: rowById,
      persistedClientIds: new Set(['d-doc']),
    });
    expect(lineItemDiscounts[0]).toMatchObject({ id: 'ten-pct-doc', dollars: 10 });
  });
});

describe('one-tier / stack-group enforcement reaches a fresh document-wide catalog pick exactly like a per-line pick', () => {
  test('a NEW document-wide tier pick conflicts with a NEW line-scoped pick of a DIFFERENT id in the same non-stackable group', () => {
    const line = positiveLine();
    const linePick = { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'silver-id', quantity: 1, unit_price: -1, amount: -1 };
    const docPick = freshDocPick({ discount_id: 'gold-id' });
    const rowById = new Map([
      ['silver-id', catalogRow({ id: 'silver-id', name: 'WaveGuard Silver', stack_group: 'tier', is_stackable: false })],
      ['gold-id', catalogRow({ id: 'gold-id', name: 'WaveGuard Gold', stack_group: 'tier', is_stackable: false })],
    ]);
    expect(() => run({ items: [line, linePick, docPick], lineItemDiscountRowById: rowById }))
      .toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('a GRANDFATHERED (persisted) document-wide tier pick does NOT conflict with itself unchanged', () => {
    const line = positiveLine();
    const docPick = freshDocPick({ discount_id: 'silver-id' });
    const rowById = new Map([['silver-id', catalogRow({ id: 'silver-id', name: 'WaveGuard Silver', stack_group: 'tier', is_stackable: false })]]);
    expect(() => run({
      items: [line, docPick],
      lineItemDiscountRowById: rowById,
      persistedClientIds: new Set(['d-doc']),
    })).not.toThrow();
  });

  test('a NEW document-wide pick conflicting with an already-PERSISTED line-scoped pick of the same group is still rejected (one side new is enough)', () => {
    const line = positiveLine();
    const persistedLinePick = { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'silver-id', quantity: 1, unit_price: -10, amount: -10 };
    const newDocPick = freshDocPick({ discount_id: 'gold-id' });
    const rowById = new Map([
      ['silver-id', catalogRow({ id: 'silver-id', name: 'WaveGuard Silver', stack_group: 'tier', is_stackable: false })],
      ['gold-id', catalogRow({ id: 'gold-id', name: 'WaveGuard Gold', stack_group: 'tier', is_stackable: false })],
    ]);
    expect(() => run({
      items: [line, persistedLinePick, newDocPick],
      lineItemDiscountRowById: rowById,
      persistedClientIds: new Set(['d-line']),
    })).toThrow(/Only one WaveGuard tier discount can apply/);
  });
});

describe('end to end through the real InvoiceService.create (DB mocked, no network)', () => {
  function setupDb({ discounts }) {
    let insertedInvoice = null;
    const byId = new Map(discounts.map((d) => [String(d.id), d]));
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => ({ id: 'customer-1', property_type: 'residential' })) })) };
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

  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; jest.clearAllMocks(); });

  test('a lineItems-shaped document-wide 10% pick, alongside a 10% line pick on the same $100 line, SAVES $81 — matching the live preview exactly', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [
      catalogRow({ id: 'ten-pct-line', name: 'Ten Percent' }),
      catalogRow({ id: 'ten-pct-doc', name: 'Ten Percent Invoice-Wide' }),
    ];
    setupDb({ discounts: rows });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Test Service',
      lineItems: [
        { client_id: 'l1', description: 'Quarterly Pest', quantity: 1, unit_price: 100 },
        { client_id: 'd-line', description: 'Ten Percent', discount_for: 'l1', discount_id: 'ten-pct-line', quantity: 1, unit_price: -1 },
        { client_id: 'd-doc', description: 'Ten Percent Invoice-Wide', discount_for: null, discount_id: 'ten-pct-doc', quantity: 1, unit_price: -1 },
      ],
    });
    expect(invoice.discount_amount).toBe(19);
    expect(invoice.total).toBe(81);
    const recordedRows = DiscountEngine.recordInvoiceDiscounts.mock.calls[0][1];
    const docRow = recordedRows.find((r) => r.name === 'Ten Percent Invoice-Wide');
    expect(docRow).toBeTruthy();
    // The P1 this round closes: catalog attribution (discount_id) rides
    // through to the audit row, not null — this is what lets
    // recordInvoiceDiscounts roll up discounts.times_applied /
    // total_discount_given for an invoice-wide pick.
    expect(docRow.id).toBe('ten-pct-doc');
  });
});
