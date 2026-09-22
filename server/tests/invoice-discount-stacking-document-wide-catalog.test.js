/**
 * Coordinator scope extension (2026-09, slice 8 of #4405 / PR #4659):
 * server/services/invoice.js came free of its prior lane (#4655 merged),
 * so the client-only submit-boundary workaround from this slice's first
 * two audit rounds is replaced with the real fix here — a FRESH
 * document-wide (unparented, discount_for: null) FIXED-type catalog pick
 * (discount_id set, resolving to a live catalog row) is now:
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
 *     total_discount_given — the P1 this round exists to close.
 *  3. Still subject to the one-tier / stack-group rule
 *     (assertNewStackGroupConflicts, called inside
 *     computeStackedDocumentDiscountLines itself) exactly like a
 *     per-line pick — grandfathered once persisted, enforced while new.
 *
 * A FRESH PERCENTAGE (or free_service) document-wide catalog pick is
 * deliberately still REJECTED — pre-push audit P0 (round 2 of this
 * extension): once saved, every frozen discount replays on the next
 * edit as a fixed credit (resolveStoredDiscountLineItem, by design), but
 * a document-wide fixed credit sorts BEFORE a narrower line-scoped one
 * in that same pass, a competition a genuine live percentage term never
 * faced (percentages always resolve after every fixed credit) — so a
 * saved invoice can total DIFFERENTLY on a plain no-op resubmit purely
 * from that bucket transition. The auditor's own reproduction: a
 * $50/$100 two-line invoice with a $50 line-1 credit and a 50%
 * invoice-wide discount totals $50 on save, $66.67 on an unchanged
 * resubmit. Fixing that needs a new term category in discount-stack.js
 * — the SHARED engine (visit/checkout callers too) — outside this
 * round's authorized file; rejecting the pick at the door (same
 * "Invalid line-item discount" a pre-lane invoice would throw) closes
 * the class entirely instead.
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

describe('a FRESH document-wide FIXED catalog pick is admitted and priced correctly', () => {
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

  test('a custom/variable FIXED-dollar document-wide pick resolves the OPERATOR-entered amount, not the catalog row\'s own 0', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'custom-dollar-doc', custom_discount_amount: 15 });
    const rowById = new Map([['custom-dollar-doc', catalogRow({ id: 'custom-dollar-doc', discount_type: 'variable_amount', amount: 0 })]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0]).toMatchObject({ discount_type: 'variable_amount', amount: 15, dollars: 15 });
  });

  test('an unparented item whose discount_id resolves to NO catalog row (unknown/tampered id) still throws — this round only widens acceptance for a REAL fixed row', () => {
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

  // No-op-resave invariant, the same class of guarantee every other
  // frozen-discount test in this codebase pins (e.g. #4655's "a
  // compounded $10+$4.50 invoice ... stays $14.50, never recomputed"):
  // a fresh document-wide FIXED pick, saved and then resubmitted
  // UNCHANGED (now persisted/frozen-by-position), must total the SAME
  // as its own first save — the exact invariant a document-wide
  // PERCENTAGE pick would have broken (see the P0 describe block below).
  test('a document-wide fixed pick totals identically fresh vs. frozen-by-position on an unchanged resubmit', () => {
    const line = positiveLine();
    const rowById = new Map([['twenty-five-fixed', catalogRow({ id: 'twenty-five-fixed', discount_type: 'fixed_amount', amount: 25 })]]);
    const fresh = run({ items: [positiveLine(), freshDocPick({ discount_id: 'twenty-five-fixed' })], lineItemDiscountRowById: rowById });
    const freshTotal = fresh.lineItemDiscounts.reduce((sum, d) => sum + d.dollars, 0);
    const persistedPick = freshDocPick({ discount_id: 'twenty-five-fixed', discount_dollars: freshTotal, unit_price: -freshTotal, amount: -freshTotal });
    const frozen = run({
      items: [line, persistedPick],
      lineItemDiscountRowById: rowById,
      persistedClientIds: new Set(['d-doc']),
    });
    const frozenTotal = frozen.lineItemDiscounts.reduce((sum, d) => sum + d.dollars, 0);
    expect(frozenTotal).toBe(freshTotal);
  });
});

// Pre-push audit P0 (coordinator scope extension, round 2): documentEntries
// deliberately EXCLUDES a fresh PERCENTAGE (or free_service) catalog pick
// — once saved, every frozen discount replays on the next edit as a
// fixed credit (resolveStoredDiscountLineItem, by design), but a
// document-wide fixed credit sorts BEFORE a narrower line-scoped one in
// that same pass, a competition a genuine live percentage term never
// faced (percentages always resolve after every fixed credit). The
// auditor's own reproduction: a $50/$100 two-line invoice with a $50
// line-1 credit and a 50% invoice-wide discount totals $50 on save, but
// $66.67 on a plain unchanged resubmit, purely from that bucket
// transition. Rejecting the PERCENTAGE pick at the door (same "Invalid
// line-item discount" a pre-lane invoice would throw) closes this class
// entirely rather than allowing a save that silently drifts later.
describe('a FRESH document-wide PERCENTAGE (or free_service) catalog pick is rejected, not silently mispriced', () => {
  test('a lone document-wide 10% pick throws — this type is not admitted into documentEntries at all', () => {
    const line = positiveLine();
    const pick = freshDocPick();
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    expect(() => run({ items: [line, pick], lineItemDiscountRowById: rowById })).toThrow('Invalid line-item discount');
  });

  test("the auditor's own reproduction, confirmed unreachable: a $100 line at 10% (line) + 10% (invoice-wide) throws instead of ever computing $81 now / $81.90 later", () => {
    const line = positiveLine();
    const linePick = { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'ten-pct-line', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 };
    const docPick = freshDocPick();
    const rowById = new Map([
      ['ten-pct-line', catalogRow({ id: 'ten-pct-line', name: 'Ten Percent' })],
      ['ten-pct-doc', catalogRow()],
    ]);
    expect(() => run({ items: [line, linePick, docPick], lineItemDiscountRowById: rowById })).toThrow('Invalid line-item discount');
  });

  test('a variable_percentage (custom %) document-wide pick is rejected the same way — the type check reads the catalog row, not the operator-entered value', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'custom-pct-doc', custom_discount_percentage: 15 });
    const rowById = new Map([['custom-pct-doc', catalogRow({ id: 'custom-pct-doc', discount_type: 'variable_percentage', amount: 0 })]]);
    expect(() => run({ items: [line, pick], lineItemDiscountRowById: rowById })).toThrow('Invalid line-item discount');
  });

  test('a free_service document-wide pick is rejected too — not a fixed type either', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'free-svc' });
    const rowById = new Map([['free-svc', catalogRow({ id: 'free-svc', discount_type: 'free_service', amount: 0 })]]);
    expect(() => run({ items: [line, pick], lineItemDiscountRowById: rowById })).toThrow('Invalid line-item discount');
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
    // The P1 this round closes: catalog attribution (discount_id) rides
    // through to the audit row, not null — this is what lets
    // recordInvoiceDiscounts roll up discounts.times_applied /
    // total_discount_given for an invoice-wide pick.
    expect(docRow.id).toBe('twenty-five-doc');
  });

  // Pre-push audit P0 (round 2): a document-wide PERCENTAGE pick must
  // never reach create() at all — real catalog row, real round trip
  // (mocked DB) — matching the pre-lane "Invalid line-item discount"
  // rejection exactly, so the total-drift-on-resave class this round's
  // audit found can never be saved in the first place.
  test('a lineItems-shaped document-wide PERCENTAGE pick is rejected by create(), not silently saved', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const rows = [catalogRow({ id: 'ten-pct-doc', name: 'Ten Percent Invoice-Wide' })];
    setupDb({ discounts: rows });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Test Service',
      lineItems: [
        { client_id: 'l1', description: 'Quarterly Pest', quantity: 1, unit_price: 100 },
        { client_id: 'd-doc', description: 'Ten Percent Invoice-Wide', discount_for: null, discount_id: 'ten-pct-doc', quantity: 1, unit_price: -1 },
      ],
    })).rejects.toThrow('Invalid line-item discount');
  });
});
