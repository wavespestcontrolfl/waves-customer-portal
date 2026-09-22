/**
 * Slice 4 of the #4405 discount-stacking split: PUT /:id/update-details
 * edit-route legacy preservation, cap/stamp eligibility, and the two #4642
 * extension-loop leftovers, all behind GATE_DISCOUNT_STACKING
 * (discountStackingLive()).
 *
 * Slice 3 (#4642, MERGED) gave the edit route resolveUpdateDetailsAddonFinancials:
 * a MARKED row (carries pricing_provenance) restacks from its own frozen
 * caps through the canonical engine; an UNMARKED (legacy, or gate-was-off-
 * at-save) row falls through ENTIRELY to calculateVisitFinancialsForAddons
 * — an additive, not the canonical, engine, independent of whatever regime
 * actually produced the row's stored numbers. That fallback is correct for
 * a save that genuinely changes a price or a discount, but this editor
 * resends every price field on EVERY save (notes-only included), so the
 * SAME fallback still runs on a save that changes nothing about the money —
 * and, per #4405's own round-7 P0 finding, this editor's addon
 * reconstruction never re-consulted the row's STORED add-on discount when
 * the client didn't resend one (the multi-line editor "neither displays nor
 * edits" per-addon discounts pre-slice-7's UI) — an add-on silently
 * recomputes at its full undiscounted gross, skewing the total on a save
 * that should not have moved it at all.
 *
 * legacyEconomicsPreservationDecision (admin-schedule.js) is the pure fix:
 * when an unmarked row's save touches NEITHER a price NOR a discount NOR
 * the primary service identity, the route preserves the row's stored
 * estimated_price/discount_dollars VERBATIM under ONE shared condition,
 * rather than trusting a recompute that was never given the information it
 * needed to reproduce the stored figure. These tests exercise that
 * decision directly (no HTTP layer — matching this codebase's convention
 * for a route this large; see resolveUpdateDetailsAddonFinancials's own
 * sibling suite) and pin the round-7 P0's own $160 stored total surviving
 * a notes-only save.
 *
 * Two guards were added after the pre-push Codex audit found real P0s in
 * the first cut of this decision (see their own describe blocks below):
 * add-on comparison is NET vs NET (never gross vs gross — this editor's
 * client sends an EDITED add-on price as a flat net with no discount
 * fields, SchedulePage.jsx, so comparing it against the stored GROSS can
 * match by coincidence and silently keep a stale, lower total), and a
 * primary SERVICE identity change disqualifies preservation outright (a
 * same-priced service swap can move the row out of the stored appointment
 * discount's scope even though no raw dollar figure moved).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const {
  legacyEconomicsPreservationDecision,
  calculateVisitFinancialsForAddons,
  resolveUpdateDetailsAddonFinancials,
  hasPricingRegimeMarker,
} = require('../routes/admin-schedule')._test;

function withGateLive(fn) {
  const prior = process.env.GATE_DISCOUNT_STACKING;
  process.env.GATE_DISCOUNT_STACKING = 'true';
  return Promise.resolve().then(fn).finally(() => {
    if (prior === undefined) delete process.env.GATE_DISCOUNT_STACKING;
    else process.env.GATE_DISCOUNT_STACKING = prior;
  });
}

// The round-7 P0's own pinned combination: $100 primary (no line discount) +
// a $100 add-on stored at a 10% discount (net $90) + a $30 fixed appointment
// credit — 100 + 90 - 30 = $160. Every case below shares this stored shape
// and varies only what the notes-only save posts. normalizedAddons.price
// and existingAddonRows.estimated_price are both NET — the one invariant
// the decision function actually compares (see its own comment).
const STORED_PRIMARY_GROSS = 100;
const STORED_ADDON_GROSS = 100;
const STORED_ADDON_NET = 90; // 10% off
const STORED_TOTAL = 160; // 100 + 90 - 30

describe('legacyEconomicsPreservationDecision — pure decision (slice 4 of #4405)', () => {
  const baseArgs = () => ({
    legacyPreservationCandidate: true,
    discountInputsPosted: false,
    primaryServiceChanged: false,
    primaryGross: STORED_PRIMARY_GROSS,
    existingPrimaryLinePrice: STORED_PRIMARY_GROSS,
    normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', price: STORED_ADDON_NET }],
    existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', estimated_price: STORED_ADDON_NET }],
    existingEstimatedPrice: STORED_TOTAL,
  });

  test('every money input unchanged, no discount posted, row unmarked + gate on: preserved, storedTotal is the row\'s own total', () => {
    const result = legacyEconomicsPreservationDecision(baseArgs());
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.moneyInputsUnchanged).toBe(true);
    expect(result.storedTotal).toBe(STORED_TOTAL);
  });

  test('not a candidate at all (marked row, or gate off) — never preserved even with every other input matching', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), legacyPreservationCandidate: false });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('a discount was posted (appointment-level or any add-on) — never preserved, even with unchanged prices', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), discountInputsPosted: true });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('the primary line price changed — a genuine price edit stays on the live-recompute path', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryGross: 105 });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('an add-on was added or removed (count mismatch) — never preserved', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [
        { serviceId: 'svc-1', serviceName: 'Addon', price: STORED_ADDON_NET },
        { serviceId: 'svc-2', serviceName: 'Second Addon', price: 40 },
      ],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('an add-on\'s own NET price changed (matched by serviceId) — never preserved', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', price: 110 }],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('an add-on with no serviceId matches its stored row by trimmed service_name instead', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: null, serviceName: 'Addon', price: STORED_ADDON_NET }],
      existingAddonRows: [{ service_id: null, service_name: '  Addon  ', estimated_price: STORED_ADDON_NET }],
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });

  test('an add-on with no serviceId whose name no longer matches any stored row — never preserved (nothing to confirm "unchanged" against)', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: null, serviceName: 'Renamed Addon', price: STORED_ADDON_NET }],
      existingAddonRows: [{ service_id: null, service_name: 'Addon', estimated_price: STORED_ADDON_NET }],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('the stored estimated_price is not a finite number (undefined — the row never carried one) — never preserved', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), existingEstimatedPrice: undefined });
    expect(result.legacyEconomicsPreserved).toBe(false);
    expect(result.storedTotal).toBeNaN(); // Number(undefined) is NaN, not 0 — never confused with a real $0
  });

  test('the stored estimated_price is exactly 0 — never preserved (an explicit $0 total needs no protecting, and a genuinely blank row must still recompute)', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), existingEstimatedPrice: 0 });
    expect(result.legacyEconomicsPreserved).toBe(false);
    expect(result.storedTotal).toBe(0);
  });

  test('a fractional-cent-noise gross (< half a cent) is still "unchanged" — moneyValuesDiffer\'s own tolerance', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryGross: 100.001 });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });

  // Codex pre-push audit P0 (round 1 of this slice): a primary SERVICE swap
  // can move the row out of (or into) the stored appointment discount's
  // scope even at an identical raw price. resolveUpdateDetailsAddonFinancials's
  // canonical branch already re-derives eligibility for a service change on
  // a MARKED row; legacy preservation on an UNMARKED row must defer to that
  // SAME live-recompute path, never keep the OLD discount_dollars stamped
  // for a service that may no longer qualify for it.
  describe('primaryServiceChanged guard (Codex P0)', () => {
    test('a primary service swap disqualifies preservation even though every price and add-on matches', () => {
      const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryServiceChanged: true });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('control: primaryServiceChanged false (the ordinary case) still preserves', () => {
      const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryServiceChanged: false });
      expect(result.legacyEconomicsPreserved).toBe(true);
    });
  });

  // Codex pre-push audit P0 (round 1 of this slice): the editor sends an
  // EDITED add-on price as a flat NET with no discount fields at all (no
  // per-addon discount UI exists yet). Comparing that posted number against
  // the stored GROSS treats a genuine net-price raise as unchanged whenever
  // it happens to equal the OLD gross — a discounted $90 addon raised to
  // $100 numerically matches the stored $100 gross, so the OLD (lower)
  // total would have been silently kept. Comparing NET vs NET (this fix)
  // catches it: the posted $100 net does not match the stored $90 net.
  describe('add-on NET-vs-NET comparison (Codex P0) — never gross vs gross', () => {
    test('a genuine add-on price edit sent as a flat net (Codex\'s own repro: $90 discounted addon raised to $100) is detected as CHANGED, even though it numerically matches the stored GROSS', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        // The client's own shape for an edited/new line (SchedulePage.jsx):
        // a flat `price`, no `discount`, no separate gross at all. The
        // server's own normalizedAddons construction sets `.price` to this
        // exact posted figure when no discount is resent — matching what
        // the route itself would build.
        normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', price: STORED_ADDON_GROSS }],
        // Stored row: base_price 100 (gross), estimated_price 90 (net,
        // after the 10% stored discount) — Codex's own pinned shape.
        existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: STORED_ADDON_GROSS, estimated_price: STORED_ADDON_NET }],
      });
      // NEVER true: this would silently keep the OLD $160 on a save that
      // actually raised the addon's net by $10.
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('control: the SAME flat-net shape with a TRULY unchanged net ($90 sent, $90 stored) still preserves — the fix does not over-correct', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', price: STORED_ADDON_NET }],
        existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: STORED_ADDON_GROSS, estimated_price: STORED_ADDON_NET }],
      });
      expect(result.legacyEconomicsPreserved).toBe(true);
    });
  });
});

// The round-7 P0 itself, reproduced against the CURRENT (post-slice-3)
// computation path: without existingAddonRows, a notes-only save's add-on
// reconstruction has no way to know the add-on was ever discounted (the
// editor doesn't resend per-addon discount fields), so it recomputes at the
// full undiscounted gross — understating the discount and moving the total
// off the stored $160. This does not require the HTTP route; it exercises
// the same calculateVisitFinancialsForAddons the fallback path calls,
// proving the CLASS of bug legacyEconomicsPreservationDecision guards
// against, on the exact $160 stored total #4405's report pinned.
describe('round-7 P0, current computation path: a notes-only save\'s addon reconstruction silently drops the stored discount', () => {
  test('the broken recompute (no existingAddonRows) moves the row off its stored $160', () => {
    // What the notes-only save reconstructs WITHOUT the stored add-on
    // discount: the addon's price is its full gross ($100), not the net
    // ($90) the row was actually saved at.
    const brokenAddonLine = { price: STORED_ADDON_GROSS, serviceKey: null, serviceCategory: null };
    const result = calculateVisitFinancialsForAddons({
      primaryNet: STORED_PRIMARY_GROSS,
      primaryServiceKey: null,
      primaryServiceCategory: null,
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
    }, [brokenAddonLine]);
    // 100 + 100(undiscounted) - 30 = 170, NEVER the stored $160.
    expect(result.price).toBe(170);
    expect(result.price).not.toBe(STORED_TOTAL);
  });

  test('the CORRECT reconstruction (existingAddonRows consulted) reproduces the stored $160 exactly', () => {
    // What the SAME save reconstructs once the add-on's stored discount is
    // actually loaded and reapplied before this calculation runs.
    const correctAddonLine = { price: STORED_ADDON_NET, serviceKey: null, serviceCategory: null };
    const result = calculateVisitFinancialsForAddons({
      primaryNet: STORED_PRIMARY_GROSS,
      primaryServiceKey: null,
      primaryServiceCategory: null,
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
    }, [correctAddonLine]);
    expect(result.price).toBe(STORED_TOTAL);
  });

  // The route's OWN fix does not repair the recompute's inputs — it
  // sidesteps the recompute entirely for a legacy row whose money nobody
  // touched, using legacyEconomicsPreservationDecision to force the row's
  // OWN stored total regardless of what the (still-broken-for-a-genuine-
  // edit) fallback would have produced.
  test('legacyEconomicsPreservationDecision overrides the broken $170 recompute with the row\'s real stored $160', () => {
    const decision = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: STORED_PRIMARY_GROSS,
      existingPrimaryLinePrice: STORED_PRIMARY_GROSS,
      normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', price: STORED_ADDON_NET }],
      existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', estimated_price: STORED_ADDON_NET }],
      existingEstimatedPrice: STORED_TOTAL,
    });
    expect(decision.legacyEconomicsPreserved).toBe(true);
    expect(decision.storedTotal).toBe(STORED_TOTAL);
    // The route writes updates.estimated_price = decision.storedTotal on
    // this path — never financials.price (the $170 above).
  });
});

// Eligibility: which rows restack (marked + gate on) vs preserve (unmarked,
// or gate off) — including the PRICE-edit case #4405's own notes left
// unresolved ("uniform economics need a persisted regime marker" — now that
// pricing_provenance exists, an UNMARKED row's price edit still recomputes
// live; a MARKED row's price edit restacks from its frozen caps). Both
// halves of resolveUpdateDetailsAddonFinancials are already pinned by its
// own suite (admin-schedule-discount-stack-restack.test.js, "resolveUpdateDetailsAddonFinancials
// — PUT /:id/update-details routes through the canonical engine (round 4
// P0)"); these tests pin only the ROUTING decision itself — which function a
// row's marker state sends a PRICE edit through — not the arithmetic either
// path already owns.
describe('PUT /:id/update-details eligibility — restack (marked) vs preserve (unmarked) vs live-recompute (a genuine price/discount/service edit)', () => {
  test('an UNMARKED row is a legacy-preservation candidate whenever the gate is live', () => {
    const unmarked = { pricing_provenance: null };
    expect(hasPricingRegimeMarker(unmarked)).toBe(false);
  });

  test('a MARKED row is never a legacy-preservation candidate — it restacks through resolveUpdateDetailsAddonFinancials instead', () => {
    const marked = {
      pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: null, addons: {} } },
    };
    expect(hasPricingRegimeMarker(marked)).toBe(true);
    // legacyPreservationCandidate is computed at the callsite as
    // `discountStackingLive() && !hasPricingRegimeMarker(existing)` — a
    // marked row is excluded by construction, regardless of what else this
    // save touches.
  });

  test('gate off: resolveUpdateDetailsAddonFinancials falls through to the legacy engine for EITHER a marked or unmarked row — gate-off parity is unconditional', async () => {
    const marked = { pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: null, addons: {} } } };
    const { financials, canonicalRestackedAddonDollars, capsSnapshotToPersist } = await resolveUpdateDetailsAddonFinancials({
      db: () => { throw new Error('must not query when the gate is off'); },
      existing: marked,
      updates: {},
      primaryGross: 100,
      normalizedAddons: [],
      effDiscountType: null,
      effDiscountAmount: null,
      effMaxDiscountDollars: null,
      effServiceKeyFilter: null,
      effServiceCategoryFilter: null,
      appointmentDiscountId: null,
    });
    expect(financials.price).toBe(100);
    expect(canonicalRestackedAddonDollars).toBeNull();
    expect(capsSnapshotToPersist).toBeNull();
  });

  test('a PRICE edit on a MARKED row routes through resolveUpdateDetailsAddonFinancials\'s canonical branch (restacks from frozen caps), never legacy preservation', async () => {
    await withGateLive(async () => {
      const marked = {
        pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: { id: null, cap: null }, addons: {} } },
        line_discount_id: null, line_discount_type: null, line_discount_amount: null,
      };
      const db = () => ({ where: () => ({ whereIn: () => ({ select: () => Promise.resolve([]) }) }) });
      const { financials, canonicalRestackedAddonDollars } = await resolveUpdateDetailsAddonFinancials({
        db, existing: marked, updates: {}, primaryGross: 150, normalizedAddons: [],
        effDiscountType: null, effDiscountAmount: null, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
      });
      // The canonical branch ran (a real restack, not the additive fallback)
      // — its own arithmetic is pinned in admin-schedule-discount-stack-
      // restack.test.js; this test only pins that a marked row's PRICE edit
      // reaches it at all, at the NEW $150.
      expect(financials.price).toBe(150);
      expect(canonicalRestackedAddonDollars).toEqual([]);
    });
  });

  // legacyPreservationCandidate is FALSE the moment discountInputsPosted OR
  // a price changed (moneyInputsUnchanged folds both in) — so a genuine
  // price edit on an UNMARKED row never reaches legacyEconomicsPreserved at
  // all; it falls through resolveUpdateDetailsAddonFinancials exactly as it
  // did before this slice (calculateVisitFinancialsForAddons, live).
  test('a PRICE edit on an UNMARKED row: moneyInputsUnchanged is false, so legacy preservation never engages — the live recompute owns it', () => {
    const decision = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, // gate on, row unmarked
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: 150, // CHANGED from the stored 100
      existingPrimaryLinePrice: 100,
      normalizedAddons: [],
      existingAddonRows: [],
      existingEstimatedPrice: 100,
    });
    expect(decision.legacyEconomicsPreserved).toBe(false);
  });

  // Codex pre-push audit P0 (round 1 of this slice): a same-priced primary
  // SERVICE switch on an UNMARKED row must also fall through to the live
  // recompute — never preserve a discount stamped for a service the new
  // pick may no longer qualify for.
  test('a SERVICE swap on an UNMARKED row at the SAME price: primaryServiceChanged is true, so legacy preservation never engages', () => {
    const decision = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: true, // service_id (or key/category snapshot) changed
      primaryGross: 100, // UNCHANGED price — the exact scenario preservation would otherwise have matched
      existingPrimaryLinePrice: 100,
      normalizedAddons: [],
      existingAddonRows: [],
      existingEstimatedPrice: 100,
    });
    expect(decision.legacyEconomicsPreserved).toBe(false);
  });
});
