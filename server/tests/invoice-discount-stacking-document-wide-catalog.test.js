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

  // Pre-push audit P1 (coordinator scope extension, round 4): the
  // client's invoice-wide picker refuses to offer a free_service catalog
  // row (matchingDocumentDiscounts, AdminInvoicesPage.jsx — it would
  // zero out every eligible line's balance at once), but the SAVE path
  // had no matching guard — a request built directly against the API,
  // bypassing the picker, could still post a document-wide free_service
  // pick and zero the whole invoice. A clean operational 400 now closes
  // that gap, matching the client's own exclusion.
  test('a FRESH document-wide free_service pick is REJECTED with a clean operational 400 — the client picker refuses to offer this type, and a direct API request must not bypass that refusal', () => {
    const line = positiveLine();
    const pick = freshDocPick({ discount_id: 'free-svc-doc' });
    const rowById = new Map([['free-svc-doc', catalogRow({ id: 'free-svc-doc', name: 'Free Service', discount_type: 'free_service', amount: 0 })]]);
    let caught;
    try {
      run({ items: [line, pick], lineItemDiscountRowById: rowById });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/free_service discounts cannot be applied invoice-wide/);
    expect(caught.statusCode).toBe(400);
    expect(caught.isOperational).toBe(true);
    expect(caught.code).toBe('DISCOUNT_DOCUMENT_WIDE_TYPE_UNSUPPORTED');
  });

  test('a STORED (persisted/trusted) document-wide free_service item is UNAFFECTED — this check only ever reaches a FRESH pick, never a genuine stamp', () => {
    const line = positiveLine();
    // A stored item never even reaches entry.row's type check (the
    // documentEntries branch for entry.stored doesn't look at row.type
    // at all) — this models a trusted stamp whose OWN visit-side
    // stacking already resolved it to a free_service credit, unrelated
    // to this invoice-wide picker guard.
    const pick = freshDocPick({
      discount_id: 'free-svc-doc',
      stored_discount_source: 'scheduled_service',
      discount_dollars: 50,
      unit_price: -50,
      amount: -50,
    });
    const rowById = new Map([['free-svc-doc', catalogRow({ id: 'free-svc-doc', name: 'Free Service', discount_type: 'free_service', amount: 0 })]]);
    expect(() => run({ items: [line, pick], lineItemDiscountRowById: rowById })).not.toThrow();
  });
});

// GitHub review round 1 P1 (PR #4659): a fresh catalog row carrying its
// OWN service_key_filter / service_category_filter must scope a
// document-wide pick to only the matching line(s) — never the whole
// invoice, and $0 when no line matches (the orphaned-scope rule a
// stored stamp already follows). Pinned with the active
// waveguard_member_wdo seed shape: 100% off, restricted to
// wdo_inspection.
describe('a FRESH document-wide catalog pick with service_key_filter/_category_filter is scoped, not applied invoice-wide', () => {
  test('waveguard_member_wdo (100% off, scoped to wdo_inspection) on a mixed invoice discounts ONLY the WDO line, never the whole invoice', () => {
    const wdoLine = positiveLine({ client_id: 'l-wdo', description: 'WDO Inspection', unit_price: 200, amount: 200, service_key: 'wdo_inspection' });
    const pestLine = positiveLine({ client_id: 'l-pest', description: 'Quarterly Pest', unit_price: 100, amount: 100, service_key: 'pest_control' });
    const pick = freshDocPick({ discount_id: 'waveguard-wdo' });
    const rowById = new Map([[
      'waveguard-wdo',
      catalogRow({ id: 'waveguard-wdo', name: 'WaveGuard Member WDO', discount_type: 'percentage', amount: 100, service_key_filter: 'wdo_inspection' }),
    ]]);
    const { lineItemDiscounts } = run({ items: [wdoLine, pestLine, pick], lineItemDiscountRowById: rowById });
    // Only the WDO line's own $200 is discounted — the pest line's $100
    // is completely untouched, not zeroed alongside it.
    expect(lineItemDiscounts[0].dollars).toBe(200);
    expect(wdoLine.amount).toBe(200); // positive line items are never mutated
    expect(pestLine.unit_price).toBe(100);
  });

  test('a service_category_filter (no key) scopes the same way, AND-matched — a line matching only the key is not enough when a category is also set', () => {
    const wdoLine = positiveLine({ client_id: 'l-wdo', description: 'WDO Inspection', unit_price: 200, amount: 200, service_key: 'wdo_inspection', service_category: 'wdo' });
    const otherLine = positiveLine({ client_id: 'l-other', description: 'Other', unit_price: 100, amount: 100, service_key: 'other_service', service_category: 'pest' });
    const pick = freshDocPick({ discount_id: 'waveguard-wdo-cat' });
    const rowById = new Map([[
      'waveguard-wdo-cat',
      catalogRow({ id: 'waveguard-wdo-cat', name: 'WaveGuard Member WDO', discount_type: 'percentage', amount: 100, service_category_filter: 'wdo' }),
    ]]);
    const { lineItemDiscounts } = run({ items: [wdoLine, otherLine, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0].dollars).toBe(200);
  });

  test('a scoped pick whose filter matches NO line on this invoice resolves to $0 — orphaned, never a silent full-invoice replay', () => {
    const pestLine = positiveLine({ client_id: 'l-pest', description: 'Quarterly Pest', unit_price: 100, amount: 100, service_key: 'pest_control' });
    const otherLine = positiveLine({ client_id: 'l-lawn', description: 'Lawn', unit_price: 100, amount: 100, service_key: 'lawn_care' });
    const pick = freshDocPick({ discount_id: 'waveguard-wdo' });
    const rowById = new Map([[
      'waveguard-wdo',
      catalogRow({ id: 'waveguard-wdo', name: 'WaveGuard Member WDO', discount_type: 'percentage', amount: 100, service_key_filter: 'wdo_inspection' }),
    ]]);
    const { lineItemDiscounts } = run({ items: [pestLine, otherLine, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0].dollars).toBe(0);
  });

  test('a scoped row on an invoice with NO service_key data anywhere (a hand-typed line, no pickService) resolves to $0 — a FRESH pick fails CLOSED, unlike a stored stamp\'s legacy fallback', () => {
    const line = positiveLine({ client_id: 'l1', unit_price: 100, amount: 100 }); // no service_key at all
    const pick = freshDocPick({ discount_id: 'waveguard-wdo' });
    const rowById = new Map([[
      'waveguard-wdo',
      catalogRow({ id: 'waveguard-wdo', name: 'WaveGuard Member WDO', discount_type: 'percentage', amount: 100, service_key_filter: 'wdo_inspection' }),
    ]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    // scopeEligibleLines's "no service_key snapshot anywhere ⇒ unscoped"
    // fallback is intentionally preserved ONLY for STORED/replayed items
    // (a pre-lane invoice whose stamp predates service_key tracking).
    // A FRESH pick has no such excuse — the operator is choosing a
    // scoped catalog row right now, against lines that plainly carry no
    // service_key at all, so there is no verifiable match. Admitting it
    // unscoped here would let a WDO-only 100% discount zero a hand-typed
    // line it was never meant to touch. Fail closed: $0, not $100.
    expect(lineItemDiscounts[0].dollars).toBe(0);
  });

  test('an UNSCOPED catalog row (no filter set) is unaffected — this only changes rows that actually carry a filter', () => {
    const line = positiveLine({ client_id: 'l1', unit_price: 100, amount: 100, service_key: 'pest_control' });
    const pick = freshDocPick({ discount_id: 'ten-pct-doc' });
    const rowById = new Map([['ten-pct-doc', catalogRow()]]);
    const { lineItemDiscounts } = run({ items: [line, pick], lineItemDiscountRowById: rowById });
    expect(lineItemDiscounts[0].dollars).toBe(10);
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

  // Round-1 GitHub review P0 #1: a FRESH scoped document-wide catalog
  // pick (service_key_filter set) applies its eligibleLines correctly on
  // the FIRST save, but nothing persisted that scope onto the item — so
  // on an unchanged resubmit, the STORED-replay branch found no
  // document_scope_service_key/_category, scopeEligibleLines treated the
  // absent key as "unscoped", and the discount silently widened to the
  // whole invoice (documentEntryTerms now stamps
  // entry.item.document_scope_service_key/_category alongside the sort
  // key whenever a fresh row carries a filter, so the stored branch's
  // existing scopeEligibleLines call reads the SAME scope back on
  // replay). $50 WDO / $100 pest lines, a 100%-off pick scoped to
  // wdo_inspection: only the $50 WDO line is discounted on the first
  // save AND on an unchanged resubmit — the pre-fix code silently
  // widened to $150 (the whole invoice) on the resubmit.
  test('round-1 P0 repro: a WDO-scoped 100% document-wide pick discounts only the $50 WDO line on save AND on an unchanged resubmit, never the whole $150 invoice', () => {
    const rowById = new Map([
      ['waveguard-wdo', catalogRow({ id: 'waveguard-wdo', name: 'WaveGuard Member WDO', discount_type: 'percentage', amount: 100, service_key_filter: 'wdo_inspection' })],
    ]);
    const items = [
      positiveLine({ client_id: 'l-wdo', description: 'WDO Inspection', unit_price: 50, amount: 50, service_key: 'wdo_inspection' }),
      positiveLine({ client_id: 'l-pest', description: 'Quarterly Pest', unit_price: 100, amount: 100, service_key: 'pest_control' }),
      freshDocPick({ discount_id: 'waveguard-wdo' }),
    ];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(totalOf(fresh.lineItemDiscounts)).toBe(50);
    expect(totalOf(resubmitted.lineItemDiscounts)).toBe(50);
    // The scope itself must have been persisted onto the item, not just
    // happened to net out right — assert it directly.
    const docItem = items.find((i) => i.client_id === 'd-doc');
    expect(docItem.document_scope_service_key).toBe('wdo_inspection');
  });
});

// Coordinator design call (round 3 on PR #4659, GitHub review P0 on
// invoice.js:807, corrected in round 4): the round-1-P0-repro fix above
// (persisting scope onto a fresh pick's item) still resolved a STORED
// replay through scopeEligibleLines — which keeps its own "no
// service_key anywhere on this invoice ⇒ unscoped" fallback for EVERY
// stored item, including one carrying a real, operator-chosen,
// PERSISTED scope. That let a saved scoped pick silently widen to the
// whole invoice the moment its own scoped line was removed — reproduced
// by the GitHub auditor directly.
//
// Round 3 first tried reusing item.stacking_regime === "compound" (the
// marker computeStackedDocumentDiscountLines stamps on every discount
// line it resolves) as the "safe to resolve strictly" signal. Round 4's
// own GitHub audit caught that this was wrong: stacking_regime is
// stamped unconditionally on EVERY item this engine touches, including
// a genuine legacy scheduled_service/validated_checkout stamp that only
// ever resolved through the UNSCOPED fallback — so a legacy stamp got
// marked "compound" on its very first pass through this engine (no
// scope change needed to trigger it), then switched to strict matching
// on its NEXT save, silently dropping a legitimate credit the moment
// the invoice's service_key data didn't happen to cover it.
//
// Fixed with a NARROWER, DEDICATED marker instead:
// item.document_scope_strict === true, set ONLY by the fresh-pick
// branch below at the exact moment it actually, verifiably resolves a
// scope via freshPickEligibleLines — never by unrelated compounding-
// engine bookkeeping. Only a stamp THIS engine itself strictly resolved
// at least once carries it; every other stamp (every genuine
// scheduled_service/validated_checkout credit, scoped or not) keeps
// scopeEligibleLines' legacy behavior, completely unaffected by this
// whole lane.
describe('a STORED scoped pick marked document_scope_strict (THIS engine itself strictly resolved its scope) resolves STRICTLY, never the legacy "no keys anywhere" fallback', () => {
  test('GitHub auditor repro verbatim: a WDO-only $50 document credit saved alongside an unkeyed $100 service resolves to $0 once the WDO line is removed on resubmit, never $50', () => {
    const rowById = new Map([
      ['wdo-fifty-doc', catalogRow({ id: 'wdo-fifty-doc', discount_type: 'fixed_amount', amount: 50, service_key_filter: 'wdo_inspection' })],
    ]);
    // First save: a WDO line + an unkeyed line (never ran through
    // pickService — no service_key at all), the WDO-only $50 pick fresh.
    const wdoLine = positiveLine({ client_id: 'l-wdo', description: 'WDO Inspection', unit_price: 50, amount: 50, service_key: 'wdo_inspection' });
    const unkeyedLine = positiveLine({ client_id: 'l-unkeyed', description: 'Hand-typed line', unit_price: 100, amount: 100 });
    const pick = freshDocPick({ discount_id: 'wdo-fifty-doc' });
    const firstSave = run({ items: [wdoLine, unkeyedLine, pick], lineItemDiscountRowById: rowById });
    expect(totalOf(firstSave.lineItemDiscounts)).toBe(50);
    expect(pick.document_scope_service_key).toBe('wdo_inspection');
    expect(pick.document_scope_strict).toBe(true);

    // Resubmit: the operator removed the WDO line entirely. Only the
    // unkeyed $100 line and the now-STORED discount item remain — the
    // invoice as a whole carries NO service_key data anywhere, which is
    // exactly the condition scopeEligibleLines' legacy fallback treats
    // as "unscoped." The marked stamp must resolve strictly instead:
    // its own persisted scope names a line that no longer exists, so it
    // resolves orphaned ($0), never widening onto the unrelated line.
    const resubmitted = run({
      items: [unkeyedLine, pick],
      lineItemDiscountRowById: rowById,
      persistedClientIds: new Set([pick.client_id]),
    });
    expect(totalOf(resubmitted.lineItemDiscounts)).toBe(0);
    expect(unkeyedLine.unit_price).toBe(100); // untouched — never absorbed the orphaned credit
  });

  test('category-only scope (no key) stays $20 on an unchanged resubmit — the strict path does not disturb the ordinary, still-matching case', () => {
    const rowById = new Map([
      ['ninety-fixed', catalogRow({ id: 'ninety-fixed', discount_type: 'fixed_amount', amount: 90 })],
      ['eighty-fixed-pest-cat-doc', catalogRow({ id: 'eighty-fixed-pest-cat-doc', discount_type: 'fixed_amount', amount: 80, service_category_filter: 'pest' })],
    ]);
    const items = [
      positiveLine({ client_id: 'l1', unit_price: 50, amount: 50, service_key: 'wdo_inspection', service_category: 'wdo' }),
      positiveLine({ client_id: 'l2', unit_price: 100, amount: 100, service_key: 'pest_control', service_category: 'pest' }),
      { client_id: 'd-line', _kind: 'discount', discount_for: 'l1', discount_id: 'ninety-fixed', description: 'Ninety Dollars', quantity: 1, unit_price: -1, amount: -1 },
      freshDocPick({ discount_id: 'eighty-fixed-pest-cat-doc' }),
    ];
    const { fresh, resubmitted } = saveThenResubmitUnchanged(items, rowById);
    expect(netOf(150, fresh.lineItemDiscounts)).toBe(20);
    expect(netOf(150, resubmitted.lineItemDiscounts)).toBe(20);
    const docItem = items.find((i) => i.client_id === 'd-doc');
    expect(docItem.document_scope_service_category).toBe('pest');
    expect(docItem.document_scope_strict).toBe(true);
  });

  test('an UNMARKED stamp (a genuine scheduled_service/validated_checkout credit — no document_scope_strict, ever) still falls back to unscoped when this invoice carries no service_key data anywhere', () => {
    // A real scheduled_service/validated_checkout stamp is trusted
    // purely by its stored_discount_source, exactly like
    // buildDiscountLineItem's appointment-level branch has always
    // produced — it never passes through the fresh-pick branch below
    // that sets document_scope_strict, no matter how many times this
    // invoice gets resaved. Its document_scope_service_key may still be
    // set (a scoped visit-time discount), but with the scoped line
    // since removed and no service_key data left anywhere on the
    // invoice, the OLD "no keys anywhere ⇒ unscoped" rule must still
    // govern it — this credit was never strictly verified; there is
    // nothing to check it against.
    const unkeyedLine = positiveLine({ client_id: 'l-unkeyed', description: 'Hand-typed line', unit_price: 100, amount: 100 });
    const legacyStamp = {
      client_id: 'd-legacy',
      _kind: 'discount',
      discount_for: null,
      discount_id: null,
      stored_discount_source: 'scheduled_service',
      discount_dollars: 50,
      document_scope_service_key: 'wdo_inspection',
      unit_price: -50,
      amount: -50,
    };
    const { lineItemDiscounts } = run({ items: [unkeyedLine, legacyStamp], lineItemDiscountRowById: new Map() });
    // Unscoped (null eligibleLines) — the pre-existing, intentional
    // fallback for an unmarked stamp — resolves its full $50 face
    // value, not $0 (which strict/fail-closed matching would give this
    // same scope now that its line is gone).
    expect(totalOf(lineItemDiscounts)).toBe(50);
  });

  // Round 4 GitHub review P0 (PR #4659) — the auditor's own repro of the
  // round-3 fix's bug: item.stacking_regime === "compound" is stamped on
  // EVERY discount item computeStackedDocumentDiscountLines touches,
  // including a genuine scheduled_service stamp that only ever resolves
  // through the UNSCOPED legacy fallback. Using it as the "resolve
  // strictly" signal meant a legacy stamp got marked "compound" on its
  // very FIRST pass through this engine (no scope change of its own
  // needed — merely being on an invoice that gets saved once is
  // enough), then switched to strict matching on the NEXT save,
  // dropping a legitimate credit entirely. Pinned here with the
  // auditor's own numbers, TWO CONSECUTIVE saves of the SAME unchanged
  // invoice: an unkeyed $100 service plus a genuine legacy WDO-scoped
  // $50 credit must total $50 on BOTH saves, never $100 on the second.
  test("round-4 P0 repro: a genuine legacy scoped stamp totals the SAME $50 across TWO CONSECUTIVE saves, never dropping to $100 on the second", () => {
    const unkeyedLine = positiveLine({ client_id: 'l-unkeyed', description: 'Hand-typed line', unit_price: 100, amount: 100 });
    const legacyStamp = {
      client_id: 'd-legacy',
      _kind: 'discount',
      discount_for: null,
      discount_id: null,
      stored_discount_source: 'scheduled_service',
      discount_dollars: 50,
      document_scope_service_key: 'wdo_inspection',
      unit_price: -50,
      amount: -50,
    };
    const firstSave = run({ items: [unkeyedLine, legacyStamp], lineItemDiscountRowById: new Map() });
    expect(totalOf(firstSave.lineItemDiscounts)).toBe(50);
    // This legacy stamp must NEVER pick up document_scope_strict, no
    // matter how many times it passes through this engine — that flag
    // is reserved for a scope THIS engine itself strictly resolved.
    expect(legacyStamp.document_scope_strict).toBeUndefined();

    const secondSave = run({
      items: [unkeyedLine, legacyStamp],
      lineItemDiscountRowById: new Map(),
      persistedClientIds: new Set([legacyStamp.client_id]),
    });
    expect(totalOf(secondSave.lineItemDiscounts)).toBe(50);
    expect(legacyStamp.document_scope_strict).toBeUndefined();
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
