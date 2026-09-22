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
 * the client didn't resend one, skewing the total on a save that should
 * not have moved it at all.
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
 * Four guards were added across three rounds of the pre-push Codex audit,
 * which found real P0/P1s in earlier cuts of this decision (see their own
 * describe blocks below):
 *  - round 1: add-on comparison is NET vs NET for a plain (undiscounted)
 *    line (never gross vs gross — this editor's client sends an EDITED
 *    add-on price as a flat net with no discount fields, SchedulePage.jsx);
 *    a primary SERVICE identity change disqualifies preservation outright.
 *  - round 2: each stored add-on row is matched AT MOST ONCE (a naive
 *    independent `.find()` per posted line let two posted lines match the
 *    SAME stored row while a different stored row went unaccounted for);
 *    per-line discount comparison is BY TERMS, never by presence (the
 *    editor's round-trip DOES resend the full discount stamp for an
 *    UNCHANGED discounted line).
 *  - round 3: a STAMPED line (discount terms round-trip exactly) is
 *    compared by GROSS, never NET — normalizedAddons[i].price comes from
 *    applyDiscount(), which is blind to the discount's CATALOG cap, so an
 *    unchanged CAPPED discount recomputes an uncapped (wrong, lower) net
 *    and would otherwise misreport an exact match as changed.
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
// and varies only what the notes-only save posts. The addon's stored
// discount round-trips verbatim (SchedulePage.jsx's own shape for an
// unchanged discounted line) — base/base_price (gross), price/estimated_price
// (net), and the discount_* fields are ALL the fields the decision actually
// compares (see its own comment for which pair applies to which line shape).
const STORED_PRIMARY_GROSS = 100;
const STORED_ADDON_GROSS = 100;
const STORED_ADDON_NET = 90; // 10% off
const STORED_ADDON_DISCOUNT_ID = 'disc-addon-10pct';
const STORED_TOTAL = 160; // 100 + 90 - 30

describe('legacyEconomicsPreservationDecision — pure decision (slice 4 of #4405)', () => {
  const baseArgs = () => ({
    legacyPreservationCandidate: true,
    discountInputsPosted: false,
    primaryServiceChanged: false,
    primaryGross: STORED_PRIMARY_GROSS,
    existingPrimaryLinePrice: STORED_PRIMARY_GROSS,
    normalizedAddons: [{
      serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_NET,
      discount: { discountId: STORED_ADDON_DISCOUNT_ID, discountType: 'percentage', discountAmount: 10 },
    }],
    existingAddonRows: [{
      service_id: 'svc-1', service_name: 'Addon', base_price: STORED_ADDON_GROSS, estimated_price: STORED_ADDON_NET,
      discount_id: STORED_ADDON_DISCOUNT_ID, discount_type: 'percentage', discount_amount: 10,
    }],
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

  test('the appointment-level discount was actively touched — never preserved, even with unchanged prices', () => {
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
        ...baseArgs().normalizedAddons,
        { serviceId: 'svc-2', serviceName: 'Second Addon', base: 40, price: 40, discount: null },
      ],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('a plain (undiscounted) add-on\'s own NET price changed (matched by serviceId) — never preserved', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 110, price: 110, discount: null }],
      existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('a STAMPED add-on\'s own GROSS changed (round-tripped discount terms match, but base_price does not) — never preserved', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{
        serviceId: 'svc-1', serviceName: 'Addon', base: 120, price: 108, // same 10% off, on a raised $120 gross
        discount: { discountId: STORED_ADDON_DISCOUNT_ID, discountType: 'percentage', discountAmount: 10 },
      }],
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('an add-on with no serviceId matches its stored row by trimmed service_name instead', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: null, serviceName: 'Addon', base: 100, price: 100, discount: null }],
      existingAddonRows: [{ service_id: null, service_name: '  Addon  ', base_price: 100, estimated_price: 100, discount_id: null }],
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });

  test('an add-on with no serviceId whose name no longer matches any stored row — never preserved (nothing to confirm "unchanged" against)', () => {
    const result = legacyEconomicsPreservationDecision({
      ...baseArgs(),
      normalizedAddons: [{ serviceId: null, serviceName: 'Renamed Addon', base: 100, price: 100, discount: null }],
      existingAddonRows: [{ service_id: null, service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
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

  // Codex pre-push audit P0 (round 1): a primary SERVICE swap can move the
  // row out of (or into) the stored appointment discount's scope even at an
  // identical raw price.
  describe('primaryServiceChanged guard (Codex P0, round 1)', () => {
    test('a primary service swap disqualifies preservation even though every price and add-on matches', () => {
      const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryServiceChanged: true });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('control: primaryServiceChanged false (the ordinary case) still preserves', () => {
      const result = legacyEconomicsPreservationDecision({ ...baseArgs(), primaryServiceChanged: false });
      expect(result.legacyEconomicsPreserved).toBe(true);
    });
  });

  // Codex pre-push audit P0 (round 1): the editor sends an EDITED add-on
  // price as a flat NET with no discount fields at all. Comparing that
  // posted number against the stored GROSS treats a genuine net-price raise
  // as unchanged whenever it happens to equal the OLD gross.
  describe('plain (undiscounted) add-on: NET-vs-NET comparison (Codex P0, round 1) — never gross vs gross', () => {
    test('a genuine add-on price edit sent as a flat net (Codex\'s own repro: $90 discounted addon raised to $100) is detected as CHANGED, even though it numerically matches the stored GROSS', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        // The client's own shape for an edited/new line (SchedulePage.jsx):
        // a flat `price`, no `discount`, no separate gross at all.
        normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_GROSS, discount: null }],
        // baseArgs' existingAddonRows: the row IS stamped with a discount —
        // dropping it entirely (posted discount: null) is itself a genuine
        // edit (round 2's own per-line terms check), which is exactly the
        // failure mode this repro demonstrates end to end.
      });
      // NEVER true: this would silently keep the OLD $160 on a save that
      // actually raised the addon's net by $10.
      expect(result.legacyEconomicsPreserved).toBe(false);
    });
  });

  // Codex pre-push audit P1 (round 2): SchedulePage.jsx resends the FULL
  // discount stamp (id/type/amount) for an UNCHANGED discounted line —
  // presence is not itself a change. Only a DIFFERENT discount (added,
  // removed, or changed terms) disqualifies.
  describe('per-line discount comparison is BY TERMS, never by presence (Codex P1, round 2)', () => {
    test('an unchanged discounted line that round-trips its FULL discount stamp (basePrice + id/type/amount, matching storage exactly) still preserves — presence alone is not a change', () => {
      // This IS baseArgs()'s own shape — restated explicitly here as the
      // regression this fix targets: the P1 finding was that an earlier cut
      // disqualified this exact, ordinary, unchanged case.
      const result = legacyEconomicsPreservationDecision(baseArgs());
      expect(result.legacyEconomicsPreserved).toBe(true);
    });

    test('a discount AMOUNT that differs from storage (10% stored, 15% posted) is a genuine edit — never preserved', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{
          serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_NET,
          discount: { discountId: STORED_ADDON_DISCOUNT_ID, discountType: 'percentage', discountAmount: 15 },
        }],
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('a DIFFERENT discount id than what is stored is a genuine edit — never preserved', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{
          serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_NET,
          discount: { discountId: 'a-different-discount', discountType: 'percentage', discountAmount: 10 },
        }],
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('a discount REMOVED relative to storage (posted has none, stored has one) is a genuine edit — never preserved', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_NET, discount: null }],
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('a plain, never-discounted add-on (both posted and stored carry no discount) still preserves', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 100, discount: null }],
        existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
      });
      expect(result.legacyEconomicsPreserved).toBe(true);
    });
  });

  // Codex pre-push audit P0 (round 2): each stored row is matched AT MOST
  // ONCE. Reproduced with Codex's own numbers: primary $100 + stored add-ons
  // A=$20 and B=$50 (stored total $170). B is replaced with a SECOND line
  // that happens to share A's identity (e.g. the same catalog service,
  // priced $20) — an independent `.find()` per posted line would match BOTH
  // posted lines to the SAME stored A row, "confirming" $170 unchanged when
  // the real new total is $100+20+20=$140 (B's $50 line genuinely dropped).
  describe('each stored add-on is matched AT MOST ONCE (Codex P0, round 2)', () => {
    const twoStoredAddons = [
      { service_id: 'svc-a', service_name: 'Service A', base_price: 20, estimated_price: 20, discount_id: null },
      { service_id: 'svc-b', service_name: 'Service B', base_price: 50, estimated_price: 50, discount_id: null },
    ];

    test('B replaced by a second A-priced line: never preserved — B\'s stored row goes unmatched, never double-claimed by two A lines', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [
          { serviceId: 'svc-a', serviceName: 'Service A', base: 20, price: 20, discount: null },
          { serviceId: 'svc-a', serviceName: 'Service A', base: 20, price: 20, discount: null }, // duplicate — was B
        ],
        existingAddonRows: twoStoredAddons,
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });

    test('control: A and B both genuinely unchanged (real one-to-one match) still preserves', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [
          { serviceId: 'svc-a', serviceName: 'Service A', base: 20, price: 20, discount: null },
          { serviceId: 'svc-b', serviceName: 'Service B', base: 50, price: 50, discount: null },
        ],
        existingAddonRows: twoStoredAddons,
      });
      expect(result.legacyEconomicsPreserved).toBe(true);
    });
  });

  // Codex pre-push audit P0 (round 3): a STAMPED line is compared by GROSS,
  // never NET. normalizedAddons[i].price comes from applyDiscount(), which
  // has NO notion of the discount's CATALOG cap — an unchanged $100 add-on
  // at 50% off CAPPED AT $10 round-trips its true gross and terms but
  // applyDiscount naively recomputes an UNCAPPED $50, never the row's real
  // stored $90. Comparing NET here would misreport this exact match as
  // changed (Codex's own repro: a notes-only save turns $160 into $120).
  describe('capped discount: STAMPED lines compare by GROSS, never the cap-ignorant recomputed NET (Codex P0, round 3)', () => {
    const cappedAddonDiscountId = 'disc-addon-50pct-cap10';
    // What the route's own addon-normalization loop (existing, pre-slice-4
    // code) actually computes for this posted line via applyDiscount(100,
    // 'percentage', 50) = $50 — cap-ignorant, and DELIBERATELY wrong here:
    // this is the exact value Codex's repro shows must NEVER be trusted for
    // an unchanged capped line.
    const naiveUncappedNet = 50;

    test('an unchanged 50%-off-capped-at-$10 add-on ($100 gross, $90 TRUE stored net) still preserves — the naive $50 recompute is never consulted', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{
          serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: naiveUncappedNet, // $50, cap-ignorant
          discount: { discountId: cappedAddonDiscountId, discountType: 'percentage', discountAmount: 50 },
        }],
        existingAddonRows: [{
          service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90, // the REAL, capped stored net
          discount_id: cappedAddonDiscountId, discount_type: 'percentage', discount_amount: 50,
        }],
        existingEstimatedPrice: 160, // 100 (primary) + 90 (capped addon) - 30 (credit)
      });
      // NEVER false: a net-vs-net comparison here (naive $50 vs real $90)
      // would wrongly disqualify this exact-match line and fall through to
      // a recompute that repeats the same cap-ignorant mistake.
      expect(result.legacyEconomicsPreserved).toBe(true);
      expect(result.storedTotal).toBe(160);
    });

    test('control: the SAME capped line with a genuinely CHANGED gross ($120, not $100) is still correctly detected as changed', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgs(),
        normalizedAddons: [{
          serviceId: 'svc-1', serviceName: 'Addon', base: 120, price: 60, // applyDiscount(120, 'percentage', 50) = 60, still cap-ignorant
          discount: { discountId: cappedAddonDiscountId, discountType: 'percentage', discountAmount: 50 },
        }],
        existingAddonRows: [{
          service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90,
          discount_id: cappedAddonDiscountId, discount_type: 'percentage', discount_amount: 50,
        }],
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
    });
  });
});

// The round-7 P0 itself, reproduced against the CURRENT (post-slice-3)
// computation path: without existingAddonRows, a notes-only save's add-on
// reconstruction has no way to know the add-on was ever discounted, so it
// recomputes at the full undiscounted gross — understating the discount and
// moving the total off the stored $160. This does not require the HTTP
// route; it exercises the same calculateVisitFinancialsForAddons the
// fallback path calls, proving the CLASS of bug legacyEconomicsPreservationDecision
// guards against, on the exact $160 stored total #4405's report pinned.
describe('round-7 P0, current computation path: a notes-only save\'s addon reconstruction silently drops the stored discount', () => {
  test('the broken recompute (no existingAddonRows) moves the row off its stored $160', () => {
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
    const correctAddonLine = { price: STORED_ADDON_NET, serviceKey: null, serviceCategory: null };
    const result = calculateVisitFinancialsForAddons({
      primaryNet: STORED_PRIMARY_GROSS,
      primaryServiceKey: null,
      primaryServiceCategory: null,
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
    }, [correctAddonLine]);
    expect(result.price).toBe(STORED_TOTAL);
  });

  test('legacyEconomicsPreservationDecision overrides the broken $170 recompute with the row\'s real stored $160', () => {
    const decision = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: STORED_PRIMARY_GROSS,
      existingPrimaryLinePrice: STORED_PRIMARY_GROSS,
      normalizedAddons: [{
        serviceId: 'svc-1', serviceName: 'Addon', base: STORED_ADDON_GROSS, price: STORED_ADDON_NET,
        discount: { discountId: STORED_ADDON_DISCOUNT_ID, discountType: 'percentage', discountAmount: 10 },
      }],
      existingAddonRows: [{
        service_id: 'svc-1', service_name: 'Addon', base_price: STORED_ADDON_GROSS, estimated_price: STORED_ADDON_NET,
        discount_id: STORED_ADDON_DISCOUNT_ID, discount_type: 'percentage', discount_amount: 10,
      }],
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
// unresolved. Both halves of resolveUpdateDetailsAddonFinancials are already
// pinned by its own suite (admin-schedule-discount-stack-restack.test.js);
// these tests pin only the ROUTING decision itself.
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
      expect(financials.price).toBe(150);
      expect(canonicalRestackedAddonDollars).toEqual([]);
    });
  });

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
