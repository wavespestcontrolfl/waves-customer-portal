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
 *  2. Attributed correctly — the returned discount descriptor carries
 *     {id, row, discount_type, amount} (the SAME shape a per-line pick
 *     already returns), not the anonymous {id: null, row: null,
 *     discount_type: 'fixed_amount'} every OTHER unparented credit (a
 *     plain literal like "Referral Credit") still gets. This is what lets
 *     DiscountEngine.recordInvoiceDiscounts write invoice_discounts
 *     .discount_id and roll up discounts.times_applied /
 *     total_discount_given — the P1 round 1 exists to close.
 *  3. Still subject to the one-tier / stack-group rule
 *     (assertNewStackGroupConflicts, called inside
 *     computeStackedDocumentDiscountLines itself) exactly like a
 *     per-line pick — grandfathered once persisted, enforced while new.
 *  4. REPLAY-STABLE across an edit, for FIXED and PERCENTAGE alike
 *     (round 3, this file) — round 2 excluded percentage document
 *     picks entirely: once frozen, every stored discount replays as a
 *     flat {fixed_amount, <its own dollars>} term, which used to ALSO
 *     decide its canonical-order rank/value, so a document PERCENTAGE
 *     pick jumped into the FIXED pass on replay (never competing there
 *     when fresh), silently changing the invoice's total on a plain
 *     unchanged resave (auditor's own reproduction: $50/$100 lines, a
 *     $50 line-1 credit, a 50% invoice-wide discount — $50 on save,
 *     $66.67 on resubmit). Fixed at the ROOT in discount-stack.js
 *     instead of by exclusion: lineItemDiscountTerm now stamps
 *     stack_sort_kind/_value/_cap onto an item the FIRST time it
 *     resolves fresh; stackInvoiceDocumentDiscounts and
 *     documentEntryTerms below replay that persisted key
 *     (frozenSortKeyFields) alongside the frozen dollars, so
 *     discount-stack.js's resolveSortKind/Value/Cap keep a term in the
 *     SAME rank/value/cap position on every later edit regardless of
 *     how its own dollars got clamped. See
 *     discount-stack-replay-invariance-property.test.js for the general
 *     property (9000+ random trials) this file's own tests below only
 *     spot-check.
 *
 * Driven directly against computeStackedDocumentDiscountLines
 * (InvoiceService._internals) — no DB mocking needed, every input is a
 * plain in-memory value — plus end-to-end tests through the real
 * InvoiceService.create (DB mocked, no network), matching
 * invoice-create-discount-stacking-parity.test.js's own pattern.
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

// Runs `items` through computeStackedDocumentDiscountLines, then simulates
// a SECOND, unchanged save — the items array IS mutated in place by the
// engine (unit_price/amount/stack_sort_* stamped directly onto each
// item), so the SAME array, now with every discount item's client_id
// added to persistedClientIds, models exactly what invoice.js's
// calculateUpdateFinancials sees on a genuine no-op resubmit.
function saveThenResubmitUnchanged(items, lineItemDiscountRowById) {
  const fresh = run({ items, lineItemDiscountRowById });
  const persistedClientIds = new Set(
    items.filter((i) => i._kind === 'discount' && i.client_id).map((i) => i.client_id),
  );
  const resubmitted = run({ items, lineItemDiscountRowById, persistedClientIds });
  return { fresh, resubmitted };
}

function totalOf(lineItemDiscounts) {
  return Math.round(lineItemDiscounts.reduce((sum, d) => sum + d.dollars, 0) * 100) / 100;
}

function netOf(subtotal, lineItemDiscounts) {
  return Math.round((subtotal - totalOf(lineItemDiscounts)) * 100) / 100;
}

describe('a FRESH document-wide catalog pick (fixed OR percentage) is admitted and priced correctly', () => {
  test('a lone document-wide $25 fixed pick on a $100 line resolves $25, with catalog attribution preserved', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'twenty-five-fixed' });
    const rowById = new Map([['twenty-five-fixed', catalogRow({ id: 'twenty-five-fixed', discount_type: 'fixed_amount', amount: 25 })]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts).toHaveLength(1);
    expect(lineItemDiscounts[0]).toMatchObject({
      id: 'twenty-five-fixed',
      discount_type: 'fixed_amount',
      amount: 25,
      dollars: 25,
    });
    expect(lineItemDiscounts[0].row).toMatchObject({ id: 'twenty-five-fixed' });
    // The engine's own mutation contract: the item's own fields are
    // resolved to the ACTUAL dollars, same as every other discount path.
    expect(pick.unit_price).toBe(-25);
    expect(pick.amount).toBe(-25);
  });

  test('a lone document-wide 10% pick on a $100 line resolves $10, with catalog attribution preserved (round 2 excluded this; round 3 re-admits it)', () => {
    const line = positiveLine();
    const pick = freshDocPick();
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0]).toMatchObject({ id: 'ten-pct-doc', discount_type: 'percentage', amount: 10, dollars: 10 });
  });

  test('a custom/variable FIXED-dollar document-wide pick resolves the OPERATOR-entered amount, not the catalog row\'s own 0', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'custom-dollar-doc', custom_discount_amount: 15 });
    const rowById = new Map([['custom-dollar-doc', catalogRow({ id: 'custom-dollar-doc', discount_type: 'variable_amount', amount: 0 })]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0]).toMatchObject({ discount_type: 'variable_amount', amount: 15, dollars: 15 });
  });

  test('a custom/variable PERCENTAGE document-wide pick resolves the OPERATOR-entered rate, not the catalog row\'s own 0', () => {
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

// No-op-resave invariant — the property discount-stack.js's own replay-
// invariance test proves in general (9000+ random trials); these are the
// exact scenarios that broke it, driven through the ACTUAL invoice.js
// entry point (computeStackedDocumentDiscountLines) across two calls
// simulating a genuine create-then-resubmit-unchanged round trip, not
// just the raw engine.
describe('replay stability: a saved document-wide pick totals identically on an unchanged resubmit', () => {
  test('a document-wide FIXED pick alone (regression: was always stable, still is)', () => {
    const rowById = new Map([['twenty-five-fixed', catalogRow({ id: 'twenty-five-fixed', discount_type: 'fixed_amount', amount: 25 })]]);
    const items = [positiveLine(), freshDocPick({ discount_id: 'twenty-five-fixed' })];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(totalOf(resubmitted.lineItemDiscounts)).toBe(totalOf(fresh.lineItemDiscounts));
  });

  test('a document-wide PERCENTAGE pick alone (round 2 could not accept this at all; round 3 both accepts it AND keeps it stable)', () => {
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    const items = [positiveLine(), freshDocPick()];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(totalOf(resubmitted.lineItemDiscounts)).toBe(totalOf(fresh.lineItemDiscounts));
  });

  // The auditor's OWN round-1 reproduction, driven through
  // computeStackedDocumentDiscountLines across a real fresh-then-resubmit
  // round trip: a $50 line-scoped credit plus a 50% document-wide
  // discount on $50/$100 lines. Fresh totals $50; the pre-fix code
  // totaled $66.67 on an unchanged resubmit (a document percent term
  // reclassified into the fixed pass once frozen).
  test("round-1 auditor repro: $50 line-1 credit + 50% invoice-wide on $50/$100 lines stays $50 on resubmit, never $66.67", () => {
    const rowById = new Map([
      ['fifty-fixed', catalogRow({ id: 'fifty-fixed', discount_type: 'fixed_amount', amount: 50 })],
      ['fifty-pct-doc', catalogRow({ id: 'fifty-pct-doc', discount_type: 'percentage', amount: 50 })],
    ]);
    const items = [
      positiveLine({ client_id: 'l1', unit_price: 50, amount: 50 }),
      positiveLine({ client_id: 'l2', unit_price: 100, amount: 100 }),
      { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'fifty-fixed', description: 'Fifty Dollars', quantity: 1, unit_price: -1, amount: -1 },
      freshDocPick({ discount_id: 'fifty-pct-doc' }),
    ];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(netOf(150, fresh.lineItemDiscounts)).toBe(50);
    expect(netOf(150, resubmitted.lineItemDiscounts)).toBe(50);
  });

  // The auditor's OWN round-2 reproduction: a $90 line-1 credit (clamps
  // to $50 against a $50 line) plus an $80 document-wide credit, on
  // $50/$100 lines. Fresh totals $20; the pre-fix code totaled $46.67 on
  // an unchanged resubmit (the frozen $50 sorted AFTER the $80 by its
  // clamped dollars, though the original $90 rate had sorted BEFORE it).
  test('round-2 auditor repro: $90 line-1 credit (clamps to $50) + $80 invoice-wide on $50/$100 lines stays $20 on resubmit, never $46.67', () => {
    const rowById = new Map([
      ['ninety-fixed', catalogRow({ id: 'ninety-fixed', discount_type: 'fixed_amount', amount: 90 })],
      ['eighty-fixed-doc', catalogRow({ id: 'eighty-fixed-doc', discount_type: 'fixed_amount', amount: 80 })],
    ]);
    const items = [
      positiveLine({ client_id: 'l1', unit_price: 50, amount: 50 }),
      positiveLine({ client_id: 'l2', unit_price: 100, amount: 100 }),
      { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'ninety-fixed', description: 'Ninety Dollars', quantity: 1, unit_price: -1, amount: -1 },
      freshDocPick({ discount_id: 'eighty-fixed-doc' }),
    ];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(netOf(150, fresh.lineItemDiscounts)).toBe(20);
    expect(netOf(150, resubmitted.lineItemDiscounts)).toBe(20);
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

  test('a lineItems-shaped document-wide $25 FIXED pick, alongside a 10% line pick on the same $100 line, SAVES correctly with real catalog attribution', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [
      catalogRow({ id: 'ten-pct-line', name: 'Ten Percent', discount_type: 'percentage', amount: 10 }),
      catalogRow({ id: 'twenty-five-doc', name: 'Twenty Five Invoice-Wide', discount_type: 'fixed_amount', amount: 25 }),
    ];
    setupDb({ discounts: rows });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Test Service',
      lineItems: [
        { client_id: 'l1', description: 'Quarterly Pest', quantity: 1, unit_price: 100 },
        { client_id: 'd-line', description: 'Ten Percent', discount_for: 'l1', discount_id: 'ten-pct-line', quantity: 1, unit_price: -1 },
        { client_id: 'd-doc', description: 'Twenty Five Invoice-Wide', discount_for: null, discount_id: 'twenty-five-doc', quantity: 1, unit_price: -1 },
      ],
    });
    // Fixed credit ($25) resolves first against the $100 line, leaving
    // $75; the 10% line pick then takes $7.50 off that remainder.
    expect(invoice.discount_amount).toBe(32.5);
    expect(invoice.total).toBe(67.5);
    const recordedRows = DiscountEngine.recordInvoiceDiscounts.mock.calls[0][1];
    const docRow = recordedRows.find((r) => r.name === 'Twenty Five Invoice-Wide');
    expect(docRow).toBeTruthy();
    // The P1 round 1 closes: catalog attribution (discount_id) rides
    // through to the audit row, not null — this is what lets
    // recordInvoiceDiscounts roll up discounts.times_applied /
    // total_discount_given for an invoice-wide pick.
    expect(docRow.id).toBe('twenty-five-doc');
  });

  // Round 2 rejected this outright; round 3 both accepts AND saves it
  // correctly — real catalog rows, real create() round trip.
  test('a lineItems-shaped document-wide 10% PERCENTAGE pick, alongside a 10% line pick on the same $100 line, SAVES $81 with real catalog attribution', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [
      catalogRow({ id: 'ten-pct-line', name: 'Ten Percent', discount_type: 'percentage', amount: 10 }),
      catalogRow({ id: 'ten-pct-doc', name: 'Ten Percent Invoice-Wide', discount_type: 'percentage', amount: 10 }),
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
    expect(docRow.id).toBe('ten-pct-doc');
  });
});
