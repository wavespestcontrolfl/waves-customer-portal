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
  loadExistingAddonRowsForLegacyPreservation,
  legacyPreservationSnapshotStale,
  calculateVisitFinancialsForAddons,
  resolveUpdateDetailsAddonFinancials,
  hasPricingRegimeMarker,
  adoptsCanonicalPricingOnEdit,
  stampPricingRegimeMarker,
  addonRowIdsDrifted,
  previewTotalDrifted,
  financialStateDrifted,
} = require('../routes/admin-schedule')._test;
const {
  deriveLegacyPrimarySubmission,
  deriveLegacyAddonSubmission,
} = require('../../shared/legacy-visit-money-submission.cjs');

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

// Codex pre-push audit P1 (PR #4654, GitHub round 1): a stored-add-on read
// failure must fail CLOSED — reject the whole save with no writes — never
// silently default to an empty set (which, for an `addons: []` removal
// save, could otherwise let legacy preservation keep the OLD total while
// the real rows get deleted underneath it).
describe('loadExistingAddonRowsForLegacyPreservation — fail-closed on a read failure (Codex P1, PR #4654 round 1)', () => {
  test('not a candidate at all: returns [] WITHOUT ever touching the db (gate off, or a marked row)', async () => {
    const db = jest.fn(() => { throw new Error('must not be called'); });
    await expect(loadExistingAddonRowsForLegacyPreservation(db, false, 'svc-1')).resolves.toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  test('a candidate row: a successful read resolves with the rows', async () => {
    const rows = [{ service_id: 'svc-1', estimated_price: 90 }];
    const db = jest.fn(() => ({
      where: () => ({ select: () => Promise.resolve(rows) }),
    }));
    await expect(loadExistingAddonRowsForLegacyPreservation(db, true, 'svc-1')).resolves.toBe(rows);
  });

  test('a candidate row whose SELECT throws (e.g. a transient DB error): the rejection PROPAGATES — never silently becomes []', async () => {
    const readFailure = new Error('QA transient read failure');
    const db = jest.fn(() => ({
      where: () => ({ select: () => Promise.reject(readFailure) }),
    }));
    await expect(loadExistingAddonRowsForLegacyPreservation(db, true, 'svc-1')).rejects.toBe(readFailure);
  });

  test('the same read failure, threaded through legacyEconomicsPreservationDecision\'s own caller shape: rejects rather than resolving to a preserved decision built on an empty stand-in', async () => {
    // Models the route's own call: `addons: []` (every add-on removed) —
    // the exact scenario the finding names. Before this fix, a caught
    // failure here would have handed legacyEconomicsPreservationDecision
    // `existingAddonRows: []`, which (0 posted === 0 "stored") could
    // preserve the OLD total while the save deletes the real rows.
    const readFailure = new Error('QA transient read failure');
    const db = jest.fn(() => ({
      where: () => ({ select: () => Promise.reject(readFailure) }),
    }));
    await expect((async () => {
      const existingAddonRows = await loadExistingAddonRowsForLegacyPreservation(db, true, 'svc-1');
      // Unreached on a real failure — if this line ever runs, the read
      // silently swallowed the error and the whole point of this test failed.
      return legacyEconomicsPreservationDecision({
        legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
        primaryGross: 100, existingPrimaryLinePrice: 100, normalizedAddons: [], existingAddonRows, existingEstimatedPrice: 100,
      });
    })()).rejects.toBe(readFailure);
  });
});

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

  // GitHub round 2 on PR #4654 (P0): a legitimately FREE unmarked visit
  // (fully covered by an appointment credit) must still be preservable —
  // `storedTotal > 0` wrongly excluded a real, finite $0 total from the
  // exact protection this mechanism exists to provide, so a notes-only
  // save on such a row fell through to the cap-blind fallback and rewrote
  // the addon/discount audit even though the AGGREGATE stayed $0 either
  // way (see the "explicitly free" describe block below for the full
  // pinned repro).
  test('the stored estimated_price is exactly 0 — STILL preserved (a genuinely free visit needs the SAME protection any other total gets)', () => {
    const result = legacyEconomicsPreservationDecision({ ...baseArgs(), existingEstimatedPrice: 0 });
    expect(result.legacyEconomicsPreserved).toBe(true);
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

  // Codex pre-push audit P1 (round 4, confirmed real): the AGGREGATE total
  // was preserved verbatim, but nothing protected the individual
  // scheduled_service_addons ROW writes from the same cap-ignorant
  // applyDiscount() recompute this PR already distrusts for the aggregate.
  // insertScheduledServiceAddons deletes and re-inserts every addon row on
  // EVERY save with an `addons` array, using `replaceAddons` — which was
  // `normalizedAddons` unconditionally, even when legacyEconomicsPreserved
  // is true. A capped-discount addon's row would silently corrupt to its
  // naive uncapped figure while the (correctly preserved) aggregate stayed
  // right — and that corrupted row becomes the STORED baseline the NEXT
  // save's own existingAddonRows comparison trusts, defeating this whole
  // mechanism one save late.
  //
  // Fix: when preserved, the decision also returns `preservedAddonLines` —
  // each matched posted line with its MONEY fields (base/price/discount)
  // overridden from the STORED row, while every other field (duration,
  // recurring cadence, …) still comes from what THIS save posted, so a
  // save that legitimately changes a non-money addon field alongside an
  // otherwise-unchanged price still applies it.
  describe('preservedAddonLines — the addon ROW write, not just the aggregate (Codex P1, round 4)', () => {
    const cappedAddonDiscountId = 'disc-addon-50pct-cap10';
    const cappedStoredRow = {
      service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90, // the REAL, capped stored net
      discount_id: cappedAddonDiscountId, discount_name: 'Fixture 50% Off Capped $10',
      discount_type: 'percentage', discount_amount: 50, discount_dollars: 10,
    };
    const cappedPostedLine = {
      serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 50, // applyDiscount(100,'percentage',50) — cap-ignorant, deliberately wrong
      discount: { discountId: cappedAddonDiscountId, discountType: 'percentage', discountAmount: 50 },
      estimatedDuration: 30, recurringPattern: null,
    };

    test('a preserved save returns preservedAddonLines with the TRUE stored $90 net, never the naive $50', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgsFor(cappedPostedLine, cappedStoredRow),
      });
      expect(result.legacyEconomicsPreserved).toBe(true);
      expect(result.preservedAddonLines).toHaveLength(1);
      const [line] = result.preservedAddonLines;
      expect(line.price).toBe(90); // NEVER the naive $50
      expect(line.base).toBe(100);
      expect(line.discount).toMatchObject({
        discountId: cappedAddonDiscountId, discountType: 'percentage', discountAmount: 50, discountDollars: 10,
      });
    });

    test('a legitimate NON-MONEY field change (estimatedDuration) on an otherwise money-unchanged addon still applies, alongside the preserved money', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgsFor({ ...cappedPostedLine, estimatedDuration: 45 }, cappedStoredRow), // operator changed duration 30 -> 45
      });
      expect(result.legacyEconomicsPreserved).toBe(true);
      const [line] = result.preservedAddonLines;
      expect(line.estimatedDuration).toBe(45); // the NEW, legitimate duration edit lands
      expect(line.price).toBe(90); // money still preserved, untouched by the duration edit
      expect(line.base).toBe(100);
    });

    test('preservedAddonLines is null when NOT preserved (a genuine price/discount edit) — the route must fall through to normalizedAddons unchanged', () => {
      const result = legacyEconomicsPreservationDecision({
        ...baseArgsFor({ ...cappedPostedLine, base: 999 }, cappedStoredRow), // a genuine GROSS change — the field this STAMPED line's comparison actually reads
      });
      expect(result.legacyEconomicsPreserved).toBe(false);
      expect(result.preservedAddonLines).toBeNull();
    });

    // Helper: a minimal, self-contained legacyEconomicsPreservationDecision
    // argument set for exactly one addon line + its stored row, isolating
    // this describe block from baseArgs()'s own (unrelated) fixture shape.
    function baseArgsFor(postedLine, storedRow) {
      return {
        legacyPreservationCandidate: true,
        discountInputsPosted: false,
        primaryServiceChanged: false,
        primaryGross: 100,
        existingPrimaryLinePrice: 100,
        normalizedAddons: [postedLine],
        existingAddonRows: [storedRow],
        existingEstimatedPrice: 160,
      };
    }
  });
});

// GitHub round 2 on PR #4654 (P0): a visit that predates the
// `primary_line_price` column (never backfilled) stores it as null.
// SchedulePage does not know or care about that column split — it derives
// a numeric primary from the stored TOTAL minus the stored add-on nets and
// resubmits that derived number on every save, notes-only included.
// Comparing the posted (derived) primaryGross against a raw null
// `existingPrimaryLinePrice` always "differs" (moneyValuesDiffer treats
// null vs a number as a difference by construction), so EVERY save on
// such a row — however unchanged — looked like a price edit and fell
// through to the cap-blind fallback recompute.
describe('null legacy primary_line_price: reconstruct the SAME way the client derives it (GitHub round 2, P0)', () => {
  // Codex's own pinned combination: a stored $160 total, one $100-gross
  // (undiscounted) add-on, so the reconstructed primary is $160-$100=$60 —
  // exactly the number SchedulePage itself would derive and resubmit.
  const nullPrimaryArgs = () => ({
    legacyPreservationCandidate: true,
    discountInputsPosted: false,
    primaryServiceChanged: false,
    primaryGross: 60, // the CLIENT's own derived primary — stored total (160) minus addon net (100)
    existingPrimaryLinePrice: null, // never backfilled
    normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 100, discount: null }],
    existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
    existingEstimatedPrice: 160,
  });

  test('a notes-only save on a null-primary legacy row preserves — the derived $60 matches the reconstructed stored primary', () => {
    const result = legacyEconomicsPreservationDecision(nullPrimaryArgs());
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.storedTotal).toBe(160);
  });

  test('control: a GENUINE price edit on a null-primary row (derived primary does not match total-minus-addons) is still correctly detected as changed', () => {
    const result = legacyEconomicsPreservationDecision({ ...nullPrimaryArgs(), primaryGross: 75 }); // operator actually raised it
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('a null primary with an UNRECONSTRUCTABLE stored total (also null/non-finite) never preserves — nothing real to reconstruct against', () => {
    const result = legacyEconomicsPreservationDecision({ ...nullPrimaryArgs(), existingEstimatedPrice: undefined });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('a populated primary_line_price is used as-is — the reconstruction only ever applies when it is null', () => {
    // Same total/addon shape, but the row DOES carry a structured primary —
    // must compare against THAT, never the derived fallback.
    const result = legacyEconomicsPreservationDecision({
      ...nullPrimaryArgs(), existingPrimaryLinePrice: 60, primaryGross: 60,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });
});

// GitHub round 2 on PR #4654 (P0): a legitimately FREE unmarked visit must
// be preservable too. Codex's own pinned combination: $100 primary (no
// line discount) + a $100 add-on at 50% off CAPPED AT $10 (true net $90) +
// a $190 fixed appointment credit — 100 + 90 - 190 = 0. The broken
// fallback keeps the AGGREGATE at $0 too (by coincidence: its own
// cap-blind recompute of the add-on nets to $50, subtotal $150, and the
// $190 credit clamps to the $150 subtotal — still $0) but corrupts the
// addon row to $50/$50-off and the appointment stamp to $150, not $190.
describe('explicitly-free ($0) legacy visits are preservable (GitHub round 2, P0)', () => {
  const freeCappedDiscountId = 'disc-addon-50pct-cap10-free';

  test('a $0 visit with a capped add-on discount preserves — the addon stays $90 (never the naive $50), never treated as "nothing to protect"', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: 100,
      existingPrimaryLinePrice: 100,
      normalizedAddons: [{
        serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 50, // applyDiscount(100,'percentage',50) — cap-ignorant
        discount: { discountId: freeCappedDiscountId, discountType: 'percentage', discountAmount: 50 },
      }],
      existingAddonRows: [{
        service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90, // the REAL, capped net
        discount_id: freeCappedDiscountId, discount_name: null, discount_type: 'percentage', discount_amount: 50, discount_dollars: 10,
      }],
      existingEstimatedPrice: 0, // the real, finite $0 total
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.storedTotal).toBe(0);
    expect(result.preservedAddonLines).toHaveLength(1);
    expect(result.preservedAddonLines[0].price).toBe(90); // never the naive $50
    // The route writes updates.discount_dollars = existing.discount_dollars
    // (the real $190 credit) on this branch — never a live recompute that
    // would clamp it to $150 against the cap-blind $150 subtotal.
  });
});

// GitHub round 2 on PR #4654 (P0): a stored add-on row with a null
// service_id (never linked to the catalog) whose NAME/KEY now happens to
// resolve to an ACTIVE catalog service. The route's own (pre-slice-4)
// normalization infers that catalog id onto the posted line even though
// the CLIENT submitted none — `serviceId: a.serviceId || catalogService?.id
// || null` — so matching by `l.serviceId` alone can never pair that
// inferred id with the still-unlinked ($null) stored row, and a notes-only
// save on such a row bypassed preservation even with a populated
// primary_line_price.
describe('a stored row with an INFERRED (not submitted) service id still matches by name (GitHub round 2, P0)', () => {
  test('submittedServiceId undefined + an inferred serviceId: falls back to matching the null-service_id stored row by name', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: 100,
      existingPrimaryLinePrice: 100,
      normalizedAddons: [{
        // The client posted NO id (submittedServiceId reflects that); the
        // route's own catalog-name resolution inferred `serviceId: 'catalog-42'`
        // for pricing purposes ONLY — matching must not trust it as "submitted".
        serviceId: 'catalog-42', submittedServiceId: null, serviceName: 'Legacy Add-On', base: 100, price: 100, discount: null,
      }],
      existingAddonRows: [{ service_id: null, service_name: 'Legacy Add-On', base_price: 100, estimated_price: 100, discount_id: null }],
      existingEstimatedPrice: 200,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });

  test('control: an id the client DID submit still matches by id, even if it disagrees with the stored (unlinked) row\'s null service_id — never preserved, since that stored row genuinely cannot be confirmed unchanged', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: 100,
      existingPrimaryLinePrice: 100,
      normalizedAddons: [{
        serviceId: 'catalog-42', submittedServiceId: 'catalog-42', serviceName: 'Legacy Add-On', base: 100, price: 100, discount: null,
      }],
      existingAddonRows: [{ service_id: null, service_name: 'Legacy Add-On', base_price: 100, estimated_price: 100, discount_id: null }],
      existingEstimatedPrice: 200,
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  test('backward compatibility: a fixture with NO submittedServiceId field at all falls back to matching by the (old) serviceId field, unchanged from before this fix', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true,
      discountInputsPosted: false,
      primaryServiceChanged: false,
      primaryGross: 100,
      existingPrimaryLinePrice: 100,
      normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 100, discount: null }], // no submittedServiceId key
      existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
      existingEstimatedPrice: 200,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });
});

// GitHub round 2 on PR #4654 (P1, disclosed, addressed alongside the P0s
// above): the reads that drive this decision (`existing`, `existingAddonRows`)
// run on the base `db` handle before the write transaction opens — a
// concurrent edit to the SAME row between that read and the later write
// could be silently reverted by an unrelated notes-only save computed from
// a stale snapshot. legacyPreservationSnapshotStale is the pure
// compare-and-swap check the route re-runs, under `trx`, immediately
// before applying a preserved write.
describe('legacyPreservationSnapshotStale — TOCTOU compare-and-swap before a preserved write (GitHub round 2 P1; every preserved field, round 3 P1)', () => {
  const snapshotArgs = () => ({
    freshRow: { estimated_price: 160, primary_line_price: 100, discount_dollars: 30, discount_type: 'fixed_amount', discount_amount: 30 },
    existingRow: { estimated_price: 160, primary_line_price: 100, discount_dollars: 30, discount_type: 'fixed_amount', discount_amount: 30 },
    freshAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90, discount_id: 'd1', discount_type: 'percentage', discount_amount: 10, discount_dollars: 10 }],
    existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90, discount_id: 'd1', discount_type: 'percentage', discount_amount: 10, discount_dollars: 10 }],
  });

  test('nothing changed since the read: not stale', () => {
    expect(legacyPreservationSnapshotStale(snapshotArgs())).toBe(false);
  });

  test('the aggregate estimated_price moved under us: stale', () => {
    const args = snapshotArgs();
    expect(legacyPreservationSnapshotStale({ ...args, freshRow: { ...args.freshRow, estimated_price: 175 } })).toBe(true);
  });

  test('an add-on row\'s net moved under us (a concurrent edit): stale', () => {
    const args = snapshotArgs();
    expect(legacyPreservationSnapshotStale({
      ...args,
      freshAddonRows: [{ ...args.freshAddonRows[0], estimated_price: 999 }],
    })).toBe(true);
  });

  test('an add-on was added or removed under us (count mismatch): stale', () => {
    const args = snapshotArgs();
    expect(legacyPreservationSnapshotStale({ ...args, freshAddonRows: [...args.freshAddonRows, { ...args.freshAddonRows[0], service_id: 'svc-2' }] })).toBe(true);
  });

  test('a discount id changed on an add-on under us: stale', () => {
    const args = snapshotArgs();
    expect(legacyPreservationSnapshotStale({
      ...args,
      freshAddonRows: [{ ...args.freshAddonRows[0], discount_id: 'd-different' }],
    })).toBe(true);
  });

  test('row order does not matter — the same rows in a different order are NOT stale', () => {
    const args = snapshotArgs();
    const rowB = { service_id: 'svc-2', service_name: 'B', base_price: 20, estimated_price: 20, discount_id: null };
    expect(legacyPreservationSnapshotStale({
      ...args,
      freshAddonRows: [rowB, args.freshAddonRows[0]],
      existingAddonRows: [args.existingAddonRows[0], rowB],
    })).toBe(false);
  });

  // GitHub round 3 on PR #4654 (P1): comparing ONLY the aggregate missed an
  // overlapping save that changes the primary/appointment BREAKDOWN — which
  // column carries the money — while leaving the aggregate total and every
  // add-on row untouched. Codex's own scenario: a concurrent save moves
  // $20 from the primary line into the appointment credit (both still sum
  // to the same $160/$30-off shape in aggregate terms), which this fix
  // must catch even though estimated_price and every add-on row are
  // byte-identical to the original read.
  describe('an overlapping save that changes ONLY the breakdown (Codex round 3 P1 repro)', () => {
    test('primary_line_price moved under us (aggregate + add-ons unchanged): stale', () => {
      const args = snapshotArgs();
      expect(legacyPreservationSnapshotStale({ ...args, freshRow: { ...args.freshRow, primary_line_price: 80 } })).toBe(true);
    });

    test('discount_dollars (the appointment stamp) moved under us: stale', () => {
      const args = snapshotArgs();
      expect(legacyPreservationSnapshotStale({ ...args, freshRow: { ...args.freshRow, discount_dollars: 50 } })).toBe(true);
    });

    test('the appointment discount_type changed under us (same dollars, different terms): stale', () => {
      const args = snapshotArgs();
      expect(legacyPreservationSnapshotStale({ ...args, freshRow: { ...args.freshRow, discount_type: 'percentage', discount_amount: 15 } })).toBe(true);
    });

    test('an add-on\'s own discount_dollars stamp moved under us (type/amount unchanged): stale', () => {
      const args = snapshotArgs();
      expect(legacyPreservationSnapshotStale({
        ...args,
        freshAddonRows: [{ ...args.freshAddonRows[0], discount_dollars: 5 }],
      })).toBe(true);
    });
  });

  // GitHub review round 4 (P1, post-round-3): a concurrent transaction
  // changes ONLY the row's primary service between this route's unlocked
  // `existing` read and the trx-locked re-check — no money field moves at
  // all. Without checking service identity here, the CAS would pass and
  // the STALE primaryServiceChanged=false conclusion (computed once, from
  // the unlocked read) would go unrevalidated, letting a preserved write
  // reapply a stored discount to a service that may no longer qualify —
  // exactly the failure primaryServiceChanged exists to prevent.
  describe('a concurrent primary-service swap (no money field moves at all) — GitHub round 4 P1 repro', () => {
    const serviceIdentityArgs = () => ({
      ...snapshotArgs(),
      freshRow: { ...snapshotArgs().freshRow, service_id: 'svc-primary-a', service_key_snapshot: 'general_pest', service_category_snapshot: 'pest_control' },
      existingRow: { ...snapshotArgs().existingRow, service_id: 'svc-primary-a', service_key_snapshot: 'general_pest', service_category_snapshot: 'pest_control' },
    });

    test('nothing changed (service identity included): still not stale', () => {
      expect(legacyPreservationSnapshotStale(serviceIdentityArgs())).toBe(false);
    });

    test('service_id changed under us — no money field moved at all: stale', () => {
      const args = serviceIdentityArgs();
      expect(legacyPreservationSnapshotStale({
        ...args,
        freshRow: { ...args.freshRow, service_id: 'svc-primary-b' },
      })).toBe(true);
    });

    test('service_key_snapshot changed under us (a re-service reclassification, same service_id): stale', () => {
      const args = serviceIdentityArgs();
      expect(legacyPreservationSnapshotStale({
        ...args,
        freshRow: { ...args.freshRow, service_key_snapshot: 'pest_re_service' },
      })).toBe(true);
    });

    test('service_category_snapshot changed under us: stale', () => {
      const args = serviceIdentityArgs();
      expect(legacyPreservationSnapshotStale({
        ...args,
        freshRow: { ...args.freshRow, service_category_snapshot: 'lawn_care' },
      })).toBe(true);
    });
  });
});

// GitHub review round 3 on PR #4654: the SHARED derivation module
// (shared/legacy-visit-money-submission.cjs) is the structural fix for
// three rounds of "another legacy data shape the server's own
// re-derivation missed" — these tests pin the shared functions directly
// (round-tripping every shape review found across rounds 2-3), then pin
// legacyEconomicsPreservationDecision actually using them end to end.
describe('deriveLegacyPrimarySubmission — the shared module itself (GitHub round 3 P0)', () => {
  test('GROSS-preferring, never net: a $160 total with a $100-gross/$90-net add-on derives $60, never $70', () => {
    // Codex's own round-3 repro, pinned directly against the shared
    // function: the earlier server-side reconstruction subtracted the
    // add-on's NET ($90), landing on $70 — SchedulePage.jsx actually
    // subtracts the GROSS ($100), landing on $60.
    const result = deriveLegacyPrimarySubmission({
      primaryLinePrice: null,
      estimatedPrice: 160,
      addons: [{ basePrice: 100, estimatedPrice: 90 }],
    });
    expect(result).toBe(60);
  });

  test('an addon with NO recorded base_price falls back to its own net for the subtraction (nothing else to subtract)', () => {
    const result = deriveLegacyPrimarySubmission({
      primaryLinePrice: null,
      estimatedPrice: 160,
      addons: [{ basePrice: null, estimatedPrice: 90 }],
    });
    expect(result).toBe(70); // 160 - 90, the only figure this addon has
  });

  test('a populated primaryLinePrice is trusted as-is (WITH add-ons present), never re-derived from the total', () => {
    const result = deriveLegacyPrimarySubmission({
      primaryLinePrice: 60, estimatedPrice: 999, addons: [{ basePrice: 40, estimatedPrice: 40 }],
    });
    expect(result).toBe(60);
  });

  test('GitHub round 10 P1 on #4657 (:49, reverting round 5\'s :6083 net seed) — a ZERO-add-on visit with a KNOWN gross seeds the GROSS: a replaced appointment discount rebases from $100, never compounds onto the $90 net ($72)', () => {
    // The untouched-save gross echo round 5 worried about is the SERVER's
    // job (computeSingleServiceEstimatedPricePlan's isUnchangedGrossEcho,
    // pinned by admin-schedule-discount-provenance-fields ':6083 — GATE
    // OFF'); the net seed itself fed a CHANGED discount the wrong base.
    expect(deriveLegacyPrimarySubmission({ primaryLinePrice: 100, estimatedPrice: 90, addons: [] })).toBe(100);
  });

  test('a ZERO-add-on legacy visit with NO stored gross still derives from the stored total (unchanged)', () => {
    expect(deriveLegacyPrimarySubmission({ primaryLinePrice: null, estimatedPrice: 90, addons: [] })).toBe(90);
  });

  test('null total, null primary, no addons: nothing derivable — returns null', () => {
    expect(deriveLegacyPrimarySubmission({ primaryLinePrice: null, estimatedPrice: null, addons: [] })).toBeNull();
  });

  test('no addons known at all (not even an empty array): the total itself is the primary', () => {
    expect(deriveLegacyPrimarySubmission({ primaryLinePrice: null, estimatedPrice: 160, addons: null })).toBe(160);
  });
});

describe('deriveLegacyAddonSubmission — the shared module itself (GitHub round 3 P0)', () => {
  test('a discount WITH a recorded base_price: the full STAMPED shape (basePrice + discount terms), net omitted', () => {
    const result = deriveLegacyAddonSubmission({
      basePrice: 100, netPrice: 90, discountType: 'percentage', discountAmount: 10, discountId: 'd1', discountName: 'Fixture',
    });
    expect(result).toEqual({ basePrice: 100, discountType: 'percentage', discountAmount: 10, discountId: 'd1', discountName: 'Fixture' });
  });

  // Codex's own round-3 repro: migration 20260504000004 added the add-on
  // discount columns BEFORE 20260511000002 added base_price, so a real
  // legacy row can carry a discount with base_price still null.
  test('a discount whose base_price is NULL (pre-base_price legacy row): the flat-NET shape, discount fields omitted entirely', () => {
    const result = deriveLegacyAddonSubmission({
      basePrice: null, netPrice: 90, discountType: 'percentage', discountAmount: 10, discountId: 'd1', discountName: 'Fixture',
    });
    expect(result).toEqual({ price: 90 });
  });

  test('no discount at all: the flat-NET shape', () => {
    expect(deriveLegacyAddonSubmission({ basePrice: 100, netPrice: 100, discountType: null })).toEqual({ price: 100 });
  });
});

describe('legacyEconomicsPreservationDecision end to end with the shared derivation (GitHub round 3 P0)', () => {
  // The add-on itself carries a real 10% discount ($100 gross -> $90 net)
  // so the stored row is internally consistent — the interesting number is
  // the PRIMARY: 160 (total) - 100 (addon GROSS) = 60, never 160 - 90 = 70.
  test('null primary_line_price + a gross/net-differing add-on: preserves via the SAME derivation the client uses ($60, never the old $70)', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
      primaryGross: 60, // the client's own gross-derived primary
      existingPrimaryLinePrice: null,
      normalizedAddons: [{
        serviceId: 'svc-1', serviceName: 'Addon', base: 100,
        discount: { discountId: null, discountType: 'percentage', discountAmount: 10 },
      }],
      existingAddonRows: [{
        service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90,
        discount_id: null, discount_type: 'percentage', discount_amount: 10,
      }],
      existingEstimatedPrice: 160,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
  });

  test('control: the OLD net-subtraction figure ($70) is now correctly rejected as a mismatch against the client\'s real gross-derived $60', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
      primaryGross: 70, // what the OLD, wrong reconstruction would have expected — never what the real client sends
      existingPrimaryLinePrice: null,
      normalizedAddons: [{
        serviceId: 'svc-1', serviceName: 'Addon', base: 100,
        discount: { discountId: null, discountType: 'percentage', discountAmount: 10 },
      }],
      existingAddonRows: [{
        service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 90,
        discount_id: null, discount_type: 'percentage', discount_amount: 10,
      }],
      existingEstimatedPrice: 160,
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
  });

  // Codex's own round-3 repro, at the decision-function level: a caller
  // posts `primaryLinePrice: 0` with an empty add-on set against a
  // genuinely UNPRICED (estimated_price NULL) legacy visit — Number(null)
  // is 0, so BOTH the reconstructed primary and storedTotal could look
  // like a valid free visit without the explicit null check.
  test('a NULL stored total is never coerced to a preservable $0 — never preserved, regardless of what else matches', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
      primaryGross: 0, existingPrimaryLinePrice: 0, // a caller posting 0 against an unpriced row
      normalizedAddons: [], existingAddonRows: [],
      existingEstimatedPrice: null, // the REAL stored state: unpriced, unknown — never a real $0
    });
    expect(result.legacyEconomicsPreserved).toBe(false);
    expect(result.storedTotal).toBeNaN(); // never silently reads as 0
  });

  test('control: a GENUINE stored $0 (not null) still preserves — the null-guard does not over-correct', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
      primaryGross: 0, existingPrimaryLinePrice: 0,
      normalizedAddons: [], existingAddonRows: [],
      existingEstimatedPrice: 0,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.storedTotal).toBe(0);
  });

  // Codex's own round-3 repro: a discounted add-on whose base_price
  // predates that column. The old per-shape comparison routed this into
  // the STAMPED (gross-vs-gross) branch because stored.discount_type was
  // populated, comparing a posted `undefined` base against a stored
  // `null` base — the shared derivation instead recognizes this as the
  // flat-NET shape (matching what the client ACTUALLY sends) and, once
  // matched, still retains the row's stored discount fields on write.
  test('a discounted add-on with base_price NULL (pre-base_price legacy row): preserves via the flat-NET shape, retaining the stored discount audit on write', () => {
    const result = legacyEconomicsPreservationDecision({
      legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
      primaryGross: 100, existingPrimaryLinePrice: 100,
      // The client's real payload for this shape: a flat net, no discount fields at all.
      normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 90, price: 90, discount: null }],
      existingAddonRows: [{
        service_id: 'svc-1', service_name: 'Addon', base_price: null, estimated_price: 90,
        discount_id: 'd1', discount_name: 'Fixture', discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
      }],
      existingEstimatedPrice: 190,
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
    // The written addon row retains its FULL discount audit, pulled from
    // storage — never dropped just because the client couldn't round-trip it.
    expect(result.preservedAddonLines[0].discount).toMatchObject({
      discountId: 'd1', discountType: 'percentage', discountAmount: 10, discountDollars: 10,
    });
  });
});

// GitHub review round 3 P0 (blocking push, post-round-3): the write
// callsite used to write `primary_line_price = primaryGross` (the
// POSTED/derived value) unconditionally, even on a preserved save — a
// previously NULL primary_line_price got "filled in" with the client's
// own reconstruction. Codex's own repro: a $160 visit, null primary, one
// $100 add-on, a $30 stored appointment discount — the client derives and
// resubmits primaryGross=60 (GROSS-preferring, per the shared module),
// and the preserved write must keep primary_line_price NULL, never write
// that derived $60 — invoice.js branches on its null-ness, and writing a
// structured $60 there let the invoice recompute to $130 instead of $160.
describe('preservedPrimaryLinePrice — the primary_line_price WRITE, not just estimated_price (GitHub round 3 P0)', () => {
  const nullPrimaryRepro = () => ({
    legacyPreservationCandidate: true, discountInputsPosted: false, primaryServiceChanged: false,
    primaryGross: 60, // the client's own derived primary (160 - 100 addon gross)
    existingPrimaryLinePrice: null, // the row's REAL stored state
    normalizedAddons: [{ serviceId: 'svc-1', serviceName: 'Addon', base: 100, price: 100, discount: null }],
    existingAddonRows: [{ service_id: 'svc-1', service_name: 'Addon', base_price: 100, estimated_price: 100, discount_id: null }],
    existingEstimatedPrice: 160,
  });

  test('a null-primary row\'s preserved write keeps primary_line_price NULL, never the client\'s derived $60', () => {
    const result = legacyEconomicsPreservationDecision(nullPrimaryRepro());
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.preservedPrimaryLinePrice).toBeNull(); // NEVER 60
  });

  test('a POPULATED primary_line_price row\'s preserved write keeps the row\'s OWN stored value', () => {
    const result = legacyEconomicsPreservationDecision({
      ...nullPrimaryRepro(),
      primaryGross: 60, existingPrimaryLinePrice: 60, // already structured, unchanged
    });
    expect(result.legacyEconomicsPreserved).toBe(true);
    expect(result.preservedPrimaryLinePrice).toBe(60);
  });

  test('NOT preserved (a genuine edit): preservedPrimaryLinePrice is null — the route falls through to writing primaryGross itself, unchanged from before this fix', () => {
    const result = legacyEconomicsPreservationDecision({ ...nullPrimaryRepro(), primaryGross: 999 });
    expect(result.legacyEconomicsPreserved).toBe(false);
    expect(result.preservedPrimaryLinePrice).toBeNull();
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

// ---------------------------------------------------------------------
// GitHub Codex round 9 on #4657 (P1, admin-schedule.js:9984): applying a
// fresh CAPPED line discount to an UNMARKED legacy visit resolved the cap
// correctly for THAT save, but the planner only produced a frozen-cap
// snapshot (and therefore a regime stamp) for rows that were ALREADY
// marked — so the visit stayed unmarked. The NEXT edit that added an
// appointment discount disqualified notes-only preservation, treated the
// now-unchanged line preset as non-fresh, and recomputed it through
// cap-unaware applyDiscount: a 20%-off/$5-cap line saved at $95 restacked
// to $80. Fix: adoptsCanonicalPricingOnEdit decides that a discount-TERM
// change on an unmarked row prices this save canonically
// (resolveUpdateDetailsAddonFinancials's `adoptCanonicalPricing`), whose
// capsSnapshotToPersist then becomes the row's first FULL regime stamp.
// ---------------------------------------------------------------------
describe('GitHub round 9 P1 on #4657 — a discount-term change on an UNMARKED row adopts canonical pricing and marks the row', () => {
  const CAPPED_20PCT = 'disc-20pct-cap5';
  // loadDiscountCapsById's own read shape: db('discounts').whereIn('id', ids).select(...)
  const dbWithCatalogCap = (cap) => () => ({
    whereIn: () => ({ select: () => Promise.resolve([{ id: CAPPED_20PCT, max_discount_dollars: cap }]) }),
  });
  const unmarkedExisting = {
    pricing_provenance: null,
    line_discount_id: null, line_discount_type: null, line_discount_amount: null,
  };

  describe('adoptsCanonicalPricingOnEdit — the pure decision', () => {
    const base = { legacyPreservationCandidate: true, legacyEconomicsPreserved: false, appointmentDiscountChanged: false, addonDiscountTermsChanged: false };
    test('an add-on discount TERM change (a fresh/changed pick, a line discount removed, or a discounted line deleted — round 10 P1) on an unmarked, non-preserved row: adopts', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, addonDiscountTermsChanged: true })).toBe(true);
    });
    test('an appointment-level discount added, swapped OR removed (appointmentDiscountChanged) on an unmarked, non-preserved row: adopts', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, appointmentDiscountChanged: true })).toBe(true);
    });
    test('a PRICE-only edit (no discount term changed anywhere) on an unmarked row: does NOT adopt — the legacy live recompute keeps it (#4405\'s own open product decision)', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, addonDiscountTermsChanged: false })).toBe(false);
    });
    test('the add-on answer is the planner\'s own stored-row comparison (a round-tripped, unchanged stamp reads false there) — a bare false never adopts', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, addonDiscountTermsChanged: false, appointmentDiscountChanged: false })).toBe(false);
    });
    test('a notes-only save that legacy preservation already claimed: never adopts (preservation and adoption are mutually exclusive)', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, legacyEconomicsPreserved: true, appointmentDiscountChanged: true })).toBe(false);
    });
    test('not a candidate at all (a MARKED row, or the gate off): never adopts — a marked row already restacks on its own marker', () => {
      expect(adoptsCanonicalPricingOnEdit({ ...base, legacyPreservationCandidate: false, appointmentDiscountChanged: true })).toBe(false);
    });
  });

  test('Codex\'s repro, save 1: a fresh 20%/$5-cap pick on an UNMARKED $100 + $100 visit prices canonically ($195), reports canonicalPricingApplied, and hands back the resolved $5 cap to freeze', async () => {
    await withGateLive(async () => {
      // normalizeUpdateDetailsAddons's own output for a FRESH catalog pick:
      // resolveLineDiscount already applied the cap (price 95, dollars 5).
      const normalizedAddons = [{
        base: 100, price: 95, serviceId: null, serviceKey: null, discountTermChanged: true,
        discount: { discountId: CAPPED_20PCT, discountType: 'percentage', discountAmount: 20, discountDollars: 5 },
      }];
      const result = await resolveUpdateDetailsAddonFinancials({
        db: dbWithCatalogCap(5), existing: unmarkedExisting, updates: {}, primaryGross: 100, normalizedAddons,
        effDiscountType: null, effDiscountAmount: null, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
        adoptCanonicalPricing: adoptsCanonicalPricingOnEdit({
          legacyPreservationCandidate: true, legacyEconomicsPreserved: false, appointmentDiscountChanged: false, addonDiscountTermsChanged: true,
        }),
      });
      expect(result.canonicalPricingApplied).toBe(true);
      expect(result.financials.price).toBe(195);
      expect(result.canonicalRestackedAddonDollars).toEqual([{ discountDollars: 5, netPrice: 95 }]);
      // The snapshot the planner's stampPricingRegimeMarker call persists —
      // the resolved cap, frozen, keyed by the discount id.
      expect(result.capsSnapshotToPersist).toEqual({ line: { id: null, cap: null }, addons: { [CAPPED_20PCT]: 5 } });
      const stamped = {};
      stampPricingRegimeMarker(stamped, { pricing_provenance: true }, result.capsSnapshotToPersist);
      expect(hasPricingRegimeMarker(stamped)).toBe(true);
    });
  });

  test('Codex\'s repro, save 2: adding a $10 appointment credit to that now-MARKED row keeps the line at $95 (frozen $5 cap) — never the cap-unaware $80 — even though the catalog cap has since been raised', async () => {
    await withGateLive(async () => {
      const stamped = {};
      stampPricingRegimeMarker(stamped, { pricing_provenance: true }, { line: { id: null, cap: null }, addons: { [CAPPED_20PCT]: 5 } });
      const markedExisting = { ...unmarkedExisting, pricing_provenance: stamped.pricing_provenance };
      // normalizeUpdateDetailsAddons's own output for an UNCHANGED, round-
      // tripped stamp: cap-unaware applyDiscount(100, 'percentage', 20) → 80.
      const normalizedAddons = [{
        base: 100, price: 80, serviceId: null, serviceKey: null, discountTermChanged: false,
        discount: { discountId: CAPPED_20PCT, discountType: 'percentage', discountAmount: 20, discountDollars: 20 },
      }];
      const result = await resolveUpdateDetailsAddonFinancials({
        db: dbWithCatalogCap(50), existing: markedExisting, updates: {}, primaryGross: 100, normalizedAddons,
        effDiscountType: 'fixed_amount', effDiscountAmount: 10, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
        adoptCanonicalPricing: false, // a marked row needs no adoption
      });
      expect(result.canonicalRestackedAddonDollars[0]).toEqual({ discountDollars: 5, netPrice: 95 });
      expect(result.financials.price).toBe(185); // 100 + 95 - 10, NEVER 170
      expect(result.capsSnapshotToPersist.addons[CAPPED_20PCT]).toBe(5); // frozen $5 wins over the live $50
    });
  });

  test('the SAME save 2 against a row that stayed UNMARKED (the pre-fix state) with NO adoption reproduces the bug — $80 / $170 — and adoption alone turns it into $95 / $185', async () => {
    await withGateLive(async () => {
      const normalizedAddons = [{
        base: 100, price: 80, serviceId: null, serviceKey: null, discountTermChanged: false,
        discount: { discountId: CAPPED_20PCT, discountType: 'percentage', discountAmount: 20, discountDollars: 20 },
      }];
      const run = (adoptCanonicalPricing) => resolveUpdateDetailsAddonFinancials({
        db: dbWithCatalogCap(5), existing: unmarkedExisting, updates: {}, primaryGross: 100, normalizedAddons,
        effDiscountType: 'fixed_amount', effDiscountAmount: 10, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
        adoptCanonicalPricing,
      });
      const legacy = await run(false);
      expect(legacy.canonicalPricingApplied).toBe(false);
      expect(legacy.financials.price).toBe(170); // the exact finding: 100 + 80 - 10
      expect(legacy.capsSnapshotToPersist).toBeNull(); // and the row would stay unmarked forever
      // appointmentDiscountChanged on an unmarked, non-preserved row is
      // exactly what adoptsCanonicalPricingOnEdit says adopts.
      const adopted = await run(adoptsCanonicalPricingOnEdit({
        legacyPreservationCandidate: true, legacyEconomicsPreserved: false, appointmentDiscountChanged: true, addonDiscountTermsChanged: false,
      }));
      expect(adopted.canonicalPricingApplied).toBe(true);
      expect(adopted.canonicalRestackedAddonDollars[0]).toEqual({ discountDollars: 5, netPrice: 95 });
      expect(adopted.financials.price).toBe(185);
      expect(adopted.capsSnapshotToPersist.addons[CAPPED_20PCT]).toBe(5);
    });
  });

  test('null-primary legacy ambiguity still wins: an unmarked row with NO primary_line_price falls back to the legacy engine and stays unmarked even when adoption is requested', async () => {
    await withGateLive(async () => {
      const normalizedAddons = [{
        base: 100, price: 95, serviceId: null, serviceKey: null, discountTermChanged: true,
        discount: { discountId: CAPPED_20PCT, discountType: 'percentage', discountAmount: 20, discountDollars: 5 },
      }];
      const result = await resolveUpdateDetailsAddonFinancials({
        db: dbWithCatalogCap(5), existing: unmarkedExisting, updates: {}, primaryGross: null, normalizedAddons,
        effDiscountType: null, effDiscountAmount: null, effMaxDiscountDollars: null,
        effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
        adoptCanonicalPricing: true,
      });
      expect(result.canonicalPricingApplied).toBe(false);
      expect(result.capsSnapshotToPersist).toBeNull();
      expect(result.canonicalRestackedAddonDollars).toBeNull();
    });
  });

  test('gate off: adoption is inert — the legacy engine prices it and the catalog is never read (gate-off parity is unconditional)', async () => {
    const result = await resolveUpdateDetailsAddonFinancials({
      db: () => { throw new Error('must not query when the gate is off'); },
      existing: unmarkedExisting, updates: {}, primaryGross: 100,
      normalizedAddons: [{ base: 100, price: 95, discountTermChanged: true, discount: { discountId: CAPPED_20PCT, discountType: 'percentage', discountAmount: 20, discountDollars: 5 } }],
      effDiscountType: null, effDiscountAmount: null, effMaxDiscountDollars: null,
      effServiceKeyFilter: null, effServiceCategoryFilter: null, appointmentDiscountId: null,
      adoptCanonicalPricing: true,
    });
    expect(result.canonicalPricingApplied).toBe(false);
    expect(result.capsSnapshotToPersist).toBeNull();
    expect(result.financials.price).toBe(195);
  });
});

// GitHub Codex round 14 P1 (#4657, :10034): the pre-transaction stale-id
// check cannot see a concurrent save that lands between the plan's read
// and the row lock; the route re-reads the add-on row ids under the lock
// and refuses via this predicate when the planned set is not the set on
// disk (replace strategy = every save reissues ids).
describe('addonRowIdsDrifted (round 14 P1: add-on identities rechecked under the write lock)', () => {
  test('same ids, any order or type: not drifted', () => {
    expect(addonRowIdsDrifted(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(addonRowIdsDrifted([1, 2], ['2', '1'])).toBe(false);
    expect(addonRowIdsDrifted([], [])).toBe(false);
  });
  test('a concurrent save replaced the rows (new ids, same count): drifted', () => {
    expect(addonRowIdsDrifted(['a', 'b'], ['c', 'd'])).toBe(true);
  });
  test('a row added or removed in between: drifted', () => {
    expect(addonRowIdsDrifted(['a', 'b'], ['a'])).toBe(true);
    expect(addonRowIdsDrifted(['a'], ['a', 'b'])).toBe(true);
  });
  test('a visit that had no add-ons and still has none: not drifted (a first add-on save must not refuse itself)', () => {
    expect(addonRowIdsDrifted(null, [])).toBe(false);
    expect(addonRowIdsDrifted([], [])).toBe(false);
  });
});

// GitHub Codex round 15 P1 (#4657, :3019): the client gates Save on the
// server preview's confirmed total (POST .../update-details/preview) but
// the PUT never received it back, so a catalog change between preview and
// save could persist a different total than the one the operator actually
// confirmed. previewTotalDrifted is the pure comparison the route's own
// post-plan witness check (:11355) is built on. Extended GitHub Codex
// round 20 P1 (#4657, :3330) to a three-way contract: undefined
// expectedTotal means no witness was posted and never drifts; a finite
// number witnesses a priced preview (existing rule); null witnesses a
// CONFIRMED unpriced preview ("Not priced") and drifts only if the plan
// would actually persist a price.
describe('previewTotalDrifted (round 15 P1 + round 20 P1: the preview-total witness)', () => {
  test('an exact match never drifts', () => {
    expect(previewTotalDrifted(150, 150)).toBe(false);
    expect(previewTotalDrifted(0, 0)).toBe(false);
    expect(previewTotalDrifted('150', 150)).toBe(false);
  });

  test('off by a single cent drifts (the route uses < 0.005, same cent-rounding tolerance as the rest of this file)', () => {
    expect(previewTotalDrifted(150, 150.01)).toBe(true);
    expect(previewTotalDrifted(150.01, 150)).toBe(true);
  });

  test('a sub-cent float wobble does not drift', () => {
    expect(previewTotalDrifted(150, 150.001)).toBe(false);
  });

  test('a witness against a plan that never touched the price (planned price undefined) always drifts', () => {
    expect(previewTotalDrifted(150, undefined)).toBe(true);
    expect(previewTotalDrifted(0, undefined)).toBe(true);
  });

  test('undefined expectedTotal (no witness posted) never drifts, whatever the plan', () => {
    expect(previewTotalDrifted(undefined, 150)).toBe(false);
    expect(previewTotalDrifted(undefined, undefined)).toBe(false);
    expect(previewTotalDrifted(undefined, null)).toBe(false);
  });

  // GitHub Codex round 26 P1 (#4657, :1605): Number(null) is 0.
  test('a NUMERIC witness against a plan that resolves to null (unpriced) drifts — a confirmed $0.00 is not "no price"', () => {
    expect(previewTotalDrifted(0, null)).toBe(true);
    expect(previewTotalDrifted('0', null)).toBe(true);
    expect(previewTotalDrifted(150, null)).toBe(true);
    // the null-witness contract is unchanged
    expect(previewTotalDrifted(null, null)).toBe(false);
    expect(previewTotalDrifted(null, undefined)).toBe(false);
    expect(previewTotalDrifted(null, 0)).toBe(true);
  });

  test('null expectedTotal (confirmed "Not priced") drifts against a plan that would persist a real price', () => {
    expect(previewTotalDrifted(null, 150)).toBe(true);
    expect(previewTotalDrifted(null, 0)).toBe(true);
  });

  test('null expectedTotal does not drift against a plan that leaves the price untouched (undefined)', () => {
    expect(previewTotalDrifted(null, undefined)).toBe(false);
  });

  test('null expectedTotal does not drift against a plan that itself plans null (still unpriced)', () => {
    expect(previewTotalDrifted(null, null)).toBe(false);
  });
});

// GitHub Codex round 21 P1 (#4657, :12301): addonRowIdsDrifted (above) only
// proves the add-on ROW SET a plan was built against is still on disk — it
// is blind to a concurrent caller that reprices this visit WITHOUT
// replacing any add-on row at all. MobileServiceEditModal's own
// primary-price-only save is exactly this shape: it updates estimated_price
// and nulls every add-on's stored discount columns in place (:12444-12455),
// leaving every id untouched, so addonRowIdsDrifted alone would let a stale
// desktop request's plan overwrite that fresher state. financialStateDrifted
// is the pure compare-and-swap the route's own locked recheck runs right
// alongside addonRowIdsDrifted, comparing the ACTUAL money a plan was built
// from (computeUpdateDetailsFinancialPlan's own financialCasSnapshot)
// against the same fields re-read under the lock.
describe('financialStateDrifted (round 21 P1: financial CAS alongside the add-on identity recheck)', () => {
  function baseSnapshot() {
    return {
      parent: {
        estimated_price: 160,
        primary_line_price: 100,
        discount_type: 'percentage',
        discount_amount: 10,
        discount_dollars: 30,
        discount_id: 'disc-appt-1',
        line_discount_id: null,
        line_discount_type: null,
        line_discount_amount: null,
        pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: null, addons: { 'disc-addon-1': 25 } } },
      },
      addons: [
        {
          id: 'addon-row-1', base_price: 100, estimated_price: 90, discount_id: 'disc-addon-1', discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
        },
      ],
    };
  }

  function freshFromSnapshot(snapshot) {
    return {
      parent: { ...snapshot.parent },
      addons: snapshot.addons.map((a) => ({ ...a })),
    };
  }

  test('no snapshot (a schedule-only save that never planned money): never drifted', () => {
    expect(financialStateDrifted(null, { parent: {}, addons: [] })).toBe(false);
    expect(financialStateDrifted(undefined, { parent: { estimated_price: 999 }, addons: [] })).toBe(false);
  });

  test('an exact match (same parent + add-on fields, re-read verbatim): not drifted', () => {
    const snap = baseSnapshot();
    expect(financialStateDrifted(snap, freshFromSnapshot(snap))).toBe(false);
  });

  test('a sub-cent float wobble on a money field does not drift (cent-rounding tolerance)', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.estimated_price = 160.001;
    fresh.addons[0].estimated_price = 90.004;
    expect(financialStateDrifted(snap, fresh)).toBe(false);
  });

  test('a concurrent primary-price edit changes the parent estimated_price: drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.estimated_price = 150;
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  test('the MobileServiceEditModal repro: primary_line_price moves and every add-on discount column is cleared in place (same id) — drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.primary_line_price = 150;
    fresh.parent.estimated_price = 150;
    fresh.addons[0] = {
      ...fresh.addons[0], discount_id: null, discount_type: null, discount_amount: null, discount_dollars: null,
    };
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  test('an add-on discount cleared alone (parent untouched): drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.addons[0].discount_id = null;
    fresh.addons[0].discount_type = null;
    fresh.addons[0].discount_amount = null;
    fresh.addons[0].discount_dollars = null;
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  test('a changed appointment discount identity (discount_id) drifts even at the same dollar figure', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.discount_id = 'disc-appt-2';
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  test('pricing_provenance caps change (a catalog cap edit re-froze against a fresh cap): drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.pricing_provenance = {
      ...fresh.parent.pricing_provenance,
      caps: { line: null, addons: { 'disc-addon-1': 15 } },
    };
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  test('pricing_provenance unrelated field changes (e.g. engine_version) without touching marker or caps: not drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.parent.pricing_provenance = { ...fresh.parent.pricing_provenance, engine_version: 2 };
    expect(financialStateDrifted(snap, fresh)).toBe(false);
  });

  test('null vs undefined on any field compares equal', () => {
    const snap = baseSnapshot();
    snap.parent.line_discount_id = null;
    const fresh = freshFromSnapshot(snap);
    fresh.parent.line_discount_id = undefined;
    expect(financialStateDrifted(snap, fresh)).toBe(false);
  });

  test('an add-on row present in the snapshot but missing from the fresh read: drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.addons = [];
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  // GitHub Codex round 22 P1 (#4657, :11627): the loop above only walks
  // the SNAPSHOT's own add-on rows looking for one gone from `fresh` — it
  // never checked the opposite direction. A row present in `fresh` but
  // absent from the snapshot (a concurrently ADDED add-on) must drift
  // too, and this is the ONLY case that matters for a visit that was
  // opened with zero add-ons in the first place (computeSingleServiceEstimatedPricePlan's
  // own financialCasSnapshot always carries `addons: []`).
  test('an add-on row present in the fresh read but absent from the snapshot (a concurrently ADDED add-on): drifted', () => {
    const snap = baseSnapshot();
    const fresh = freshFromSnapshot(snap);
    fresh.addons = [...fresh.addons, {
      id: 'addon-row-2', base_price: 25, estimated_price: 25, discount_id: null, discount_type: null, discount_amount: null, discount_dollars: null,
    }];
    expect(financialStateDrifted(snap, fresh)).toBe(true);
  });

  // The no-add-on save's own shape: a snapshot with an EMPTY addons array
  // (never null — computeSingleServiceEstimatedPricePlan always builds one
  // once `existingPrice` resolves) still needs a concurrently added row
  // to register as drift.
  test('a snapshot with zero add-ons (the no-add-on save path) drifts when a fresh add-on row now exists', () => {
    const snap = { parent: { estimated_price: 100, primary_line_price: 100, discount_type: null, discount_amount: null }, addons: [] };
    const fresh = {
      parent: { ...snap.parent },
      addons: [{
        id: 'addon-row-new', base_price: 25, estimated_price: 25, discount_id: null, discount_type: null, discount_amount: null, discount_dollars: null,
      }],
    };
    expect(financialStateDrifted(snap, fresh)).toBe(true);
    // Control: same zero-add-on snapshot, no concurrent add — not drifted.
    expect(financialStateDrifted(snap, { parent: { ...snap.parent }, addons: [] })).toBe(false);
  });
});

// Pre-push fallback audit P1 on #4657 round 24 (admin-schedule.js:9902): the
// single-service (no addons array) save path computed basePrice =
// Number(estimatedPrice) with no >= 0 check, so a caller posting a negative
// estimatedPrice with no `addons` key persisted a negative estimated_price.
// The refusal now sits at the top of BOTH routes, before any read.
describe('negativePricePosted — a negative primary price is refused at the route input (fallback audit P1, #4657 round 24)', () => {
  const { negativePricePosted } = require('../routes/admin-schedule')._test;

  test('pure decision: finite negatives refuse; blank, undefined, NaN, zero and positives do not', () => {
    expect(negativePricePosted({ estimatedPrice: -50 })).toBe(true);
    expect(negativePricePosted({ estimatedPrice: '-0.01' })).toBe(true);
    expect(negativePricePosted({ primaryLinePrice: -1, estimatedPrice: 100 })).toBe(true);
    expect(negativePricePosted({ estimatedPrice: 0 })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: '0' })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: 90 })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: '' })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: undefined, primaryLinePrice: null })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: 'abc' })).toBe(false);
    expect(negativePricePosted({ estimatedPrice: -Infinity })).toBe(false); // non-finite: each branch's own existing handling
    expect(negativePricePosted({})).toBe(false);
  });

  const router = require('../routes/admin-schedule');
  const db = require('../models/db');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function run(method, path, body) {
    const handler = findHandler(method, path);
    const req = { params: { id: 'visit-1' }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, nextErr };
  }
  const DB_TOUCHED = new Error('db must not be touched before the refusal');
  beforeEach(() => { db.mockReset(); db.mockImplementation(() => { throw DB_TOUCHED; }); });

  test('PUT /:id/update-details with estimatedPrice -50 and NO addons array: 422 NEGATIVE_PRICE, the db never touched', async () => {
    const { statusCode, payload } = await run('put', '/:id/update-details', { estimatedPrice: -50, notes: 'x' });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('NEGATIVE_PRICE');
    expect(db).not.toHaveBeenCalled();
  });

  test('PUT with a negative primaryLinePrice (desktop gross convention) is refused the same way', async () => {
    const { statusCode, payload } = await run('put', '/:id/update-details', { primaryLinePrice: -1, estimatedPrice: 100, addons: [] });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('NEGATIVE_PRICE');
    expect(db).not.toHaveBeenCalled();
  });

  test('POST /:id/update-details/preview with a negative price is refused identically, so the preview never confirms a total the save would refuse', async () => {
    const { statusCode, payload } = await run('post', '/:id/update-details/preview', { estimatedPrice: -50 });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('NEGATIVE_PRICE');
    expect(db).not.toHaveBeenCalled();
  });

  test('a non-negative price passes the refusal and the handler proceeds (reaches the db read)', async () => {
    const { nextErr } = await run('put', '/:id/update-details', { estimatedPrice: 90, notes: 'x' });
    // Not our refusal — the handler went on into the route and hit the
    // throwing db mock, which is exactly the proof that the guard let it through.
    expect(nextErr).toBe(DB_TOUCHED);
  });
});

// Pre-push fallback audit P1 on #4657 round 24: presetEligibilityCheck was
// two hand-copied closures (PUT save + POST preview). One builder now; the
// route context is a thunk read at call time. Pinned on the shared rule.
describe('buildPresetEligibilityCheck — one eligibility rule for the save and its preview (fallback audit P1, #4657 round 24)', () => {
  const { buildPresetEligibilityCheck } = require('../routes/admin-schedule')._test;
  const { manualEligibilityFailures } = require('../services/discount-engine');
  const db = require('../models/db');
  const LINES = [
    { amount: 100, serviceKey: 'pest_general_quarterly', serviceCategory: 'pest' },
    { amount: 40, serviceKey: 'termite_bond', serviceCategory: 'termite' },
  ];
  beforeEach(() => {
    manualEligibilityFailures.mockReset();
    manualEligibilityFailures.mockResolvedValue([]);
    db.mockReset();
    // resolveMembershipBookingContext reads the customer row through db();
    // a stub chain that resolves null is enough — the engine is mocked.
    const chain = { where: () => chain, first: async () => null, select: async () => [] };
    db.mockImplementation(() => chain);
  });

  test('no preset: resolves without touching the engine or the context', async () => {
    const membershipContext = jest.fn();
    const check = buildPresetEligibilityCheck({ appointmentDiscountPreset: null, membershipContext });
    await expect(check(LINES)).resolves.toBeUndefined();
    expect(manualEligibilityFailures).not.toHaveBeenCalled();
    expect(membershipContext).not.toHaveBeenCalled();
  });

  test('a service-key-scoped fixed preset is judged on the MATCHING lines only (subtotal $40, termite context), reading the route context at call time', async () => {
    const preset = { name: 'Termite Special', discount_type: 'fixed_amount', amount: 20, service_key_filter: 'termite_bond' };
    const updates = {};
    const membershipContext = jest.fn(() => ({ db, id: 'visit-1', updates, isRecurring: false, serviceType: 'Termite Bond', scheduledDate: '2040-02-01' }));
    const check = buildPresetEligibilityCheck({ appointmentDiscountPreset: preset, membershipContext });
    await expect(check(LINES)).resolves.toBeUndefined();
    expect(membershipContext).toHaveBeenCalledTimes(1);
    expect(manualEligibilityFailures).toHaveBeenCalledTimes(1);
    const [presetArg, , ctx] = manualEligibilityFailures.mock.calls[0];
    expect(presetArg).toBe(preset);
    expect(ctx).toMatchObject({ subtotal: 40, serviceKey: 'termite_bond', serviceCategory: 'termite' });
  });

  test('an unscoped preset sums every line ($140) with the primary as context', async () => {
    const preset = { name: 'Military', discount_type: 'fixed_amount', amount: 5 };
    const check = buildPresetEligibilityCheck({ appointmentDiscountPreset: preset, membershipContext: () => ({ db, id: 'visit-1', updates: {} }) });
    await check(LINES);
    expect(manualEligibilityFailures.mock.calls[0][2]).toMatchObject({ subtotal: 140, serviceKey: 'pest_general_quarterly', serviceCategory: 'pest' });
  });

  test('engine failures become the same 400 the save always returned', async () => {
    manualEligibilityFailures.mockResolvedValue(['minimum subtotal $200']);
    const preset = { name: 'Big Spender', discount_type: 'fixed_amount', amount: 25 };
    const check = buildPresetEligibilityCheck({ appointmentDiscountPreset: preset, membershipContext: () => ({ db, id: 'visit-1', updates: {} }) });
    await expect(check(LINES)).rejects.toMatchObject({ status: 400, message: 'Big Spender is not eligible: minimum subtotal $200' });
  });

  test('both routes build their check from the shared builder (no second copy of the rule in the file)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/= buildPresetEligibilityCheck\(\{/g)).toHaveLength(2); // the PUT and the preview
    expect(src.match(/const presetEligibilityCheck = async \(lines\)/g)).toBeNull();
  });
});

// GitHub Codex round 24 P1 (#4657, :14442): a cleared Price on a no-add-on
// visit omits both price fields, the planner leaves estimated_price
// undefined and the PUT RETAINS the stored charge — yet the preview said
// `total: null` ("Not priced") and the null witness passed the drift
// check. Both routes now resolve the total through resolvePlannedTotal.
describe('resolvePlannedTotal — the preview reports, and the drift check compares against, the total the save actually leaves on the row (round 24 P1, #4657 :14442)', () => {
  const { resolvePlannedTotal, previewTotalDrifted } = require('../routes/admin-schedule')._test;
  const db = require('../models/db');
  let storedRow;
  beforeEach(() => {
    db.mockReset();
    storedRow = { estimated_price: 100 };
    const chain = { where: () => chain, first: async () => storedRow };
    db.mockImplementation(() => chain);
  });

  test('a planned write wins without reading the row (number)', async () => {
    await expect(resolvePlannedTotal(db, 'v1', { estimated_price: 85 })).resolves.toBe(85);
    expect(db).not.toHaveBeenCalled();
  });

  test('a planned null (genuinely unpriced result) stays null without reading the row', async () => {
    await expect(resolvePlannedTotal(db, 'v1', { estimated_price: null })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('no planned write: the RETAINED stored total is reported, never null', async () => {
    await expect(resolvePlannedTotal(db, 'v1', {})).resolves.toBe(100);
    expect(db).toHaveBeenCalledWith('scheduled_services');
  });

  test('no planned write on a never-priced row resolves null (still "Not priced")', async () => {
    storedRow = { estimated_price: null };
    await expect(resolvePlannedTotal(db, 'v1', {})).resolves.toBeNull();
    storedRow = null;
    await expect(resolvePlannedTotal(db, 'v1', {})).resolves.toBeNull();
  });

  test('a failed read resolves null rather than throwing', async () => {
    const chain = { where: () => chain, first: async () => { throw new Error('db down'); } };
    db.mockImplementation(() => chain);
    await expect(resolvePlannedTotal(db, 'v1', {})).resolves.toBeNull();
  });

  test('cols without estimated_price short-circuits to null', async () => {
    await expect(resolvePlannedTotal(db, 'v1', {}, { id: {} })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('the repro: cleared Price on a priced no-add-on visit — the operator now confirms the RETAINED $100 and the save accepts that witness; a $120 concurrent reprice is drift', async () => {
    const previewed = await resolvePlannedTotal(db, 'v1', {});
    expect(previewed).toBe(100);
    expect(previewTotalDrifted(previewed, await resolvePlannedTotal(db, 'v1', {}))).toBe(false);
    storedRow = { estimated_price: 120 };
    expect(previewTotalDrifted(previewed, await resolvePlannedTotal(db, 'v1', {}))).toBe(true);
  });

  test('the PUT drift check and the preview total both go through resolvePlannedTotal (no bare `updates.estimated_price` total left)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/previewTotalDrifted\(expectedTotal, await resolvePlannedTotal\(db, req\.params\.id, updates\)\)/g)).toHaveLength(1);
    expect(src.match(/total: await resolvePlannedTotal\(db, id, updates, cols\)/g)).toHaveLength(1);
    expect(src.match(/total: updates\.estimated_price !== undefined \? updates\.estimated_price : null/g)).toBeNull();
  });
});

// GitHub Codex round 24 P1 (#4657, :3315): a discount change (pick or
// explicit None) posted with Price cleared — both price fields omitted, no
// addons array — has no gross to recompute against; refused at the route
// input for the save AND the preview, before any read.
describe('discountChangeWithoutPricePosted — a discount change with no price is refused at the route input (round 24 P1, #4657 :3315)', () => {
  const { discountChangeWithoutPricePosted } = require('../routes/admin-schedule')._test;

  test('pure decision: explicit-null clear, a pick, or a lone discountId with no finite price refuses; any finite price, an addons array, or no discount field at all does not', () => {
    expect(discountChangeWithoutPricePosted({ discountType: null, discountAmount: null, discountId: null })).toBe(true);
    expect(discountChangeWithoutPricePosted({ discountType: 'fixed_amount', discountAmount: 10 })).toBe(true);
    expect(discountChangeWithoutPricePosted({ discountId: 'disc-1' })).toBe(true);
    expect(discountChangeWithoutPricePosted({ discountType: null, estimatedPrice: '' , primaryLinePrice: '' })).toBe(true);
    expect(discountChangeWithoutPricePosted({ discountType: null, estimatedPrice: 'abc' })).toBe(true);
    expect(discountChangeWithoutPricePosted({ discountType: null, estimatedPrice: 90 })).toBe(false);
    expect(discountChangeWithoutPricePosted({ discountType: null, primaryLinePrice: '100' })).toBe(false);
    expect(discountChangeWithoutPricePosted({ discountType: null, estimatedPrice: 0 })).toBe(false);
    expect(discountChangeWithoutPricePosted({ discountType: null, addons: [] })).toBe(false);
    expect(discountChangeWithoutPricePosted({ notes: 'x' })).toBe(false);
    expect(discountChangeWithoutPricePosted({ estimatedPrice: undefined })).toBe(false);
    expect(discountChangeWithoutPricePosted({})).toBe(false);
  });

  const router = require('../routes/admin-schedule');
  const db = require('../models/db');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function run(method, path, body) {
    const handler = findHandler(method, path);
    const req = { params: { id: 'visit-1' }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, nextErr };
  }
  const DB_TOUCHED = new Error('db must not be touched before the refusal');
  beforeEach(() => { db.mockReset(); db.mockImplementation(() => { throw DB_TOUCHED; }); });

  test('PUT: the repro — Price cleared + None (explicit nulls, both price fields omitted, no addons): 422 DISCOUNT_PRICE_REQUIRED, db never touched', async () => {
    const { statusCode, payload } = await run('put', '/:id/update-details', { discountType: null, discountAmount: null, discountId: null, notes: 'x' });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('DISCOUNT_PRICE_REQUIRED');
    expect(db).not.toHaveBeenCalled();
  });

  test('PUT: a fresh pick with Price cleared is refused the same way (recurring root included — the body shape is what is judged)', async () => {
    const { statusCode, payload } = await run('put', '/:id/update-details', { discountType: 'percentage', discountAmount: 10, discountId: 'disc-1', isRecurring: true });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('DISCOUNT_PRICE_REQUIRED');
  });

  test('POST preview: refused identically, so the preview never confirms a save the PUT would refuse', async () => {
    const { statusCode, payload } = await run('post', '/:id/update-details/preview', { discountType: null, discountAmount: null, discountId: null });
    expect(statusCode).toBe(422);
    expect(payload?.code).toBe('DISCOUNT_PRICE_REQUIRED');
    expect(db).not.toHaveBeenCalled();
  });

  test('the same clear WITH a price passes the refusal and the handler proceeds (reaches the db read)', async () => {
    const { nextErr } = await run('put', '/:id/update-details', { discountType: null, discountAmount: null, discountId: null, estimatedPrice: 100, primaryLinePrice: 100 });
    expect(nextErr).toBe(DB_TOUCHED);
  });

  test('a notes-only save (no discount field posted, no price) is untouched by the guard', async () => {
    const { nextErr } = await run('put', '/:id/update-details', { notes: 'x' });
    expect(nextErr).toBe(DB_TOUCHED);
  });

  test('both routes call the guard right after negativePricePosted (source pin)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/if \(discountChangeWithoutPricePosted\(req\.body \|\| \{\}\)\) \{/g)).toHaveLength(2);
  });
});

// GitHub Codex round 26 P0 (#4657, :10432): a legacy add-on row with a null
// stored service_id round-trips WITHOUT a service id in the desktop payload;
// the name/key fallback infers a catalog id, and comparing it to the stored
// null read as a service change on a notes-only save.
describe('addonServiceIdentityForFreshness — when the service identity is compared for add-on discount freshness (round 26 P0, #4657 :10432)', () => {
  const { addonServiceIdentityForFreshness } = require('../routes/admin-schedule')._test;

  test('raw id omitted + stored service_id null (the legacy round-trip): identity check SKIPPED (undefined), whatever the fallback inferred', () => {
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: { service_id: null }, inferredServiceId: 'svc-inferred' })).toBeUndefined();
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: { service_id: '' }, inferredServiceId: 'svc-inferred' })).toBeUndefined();
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: null, inferredServiceId: 'svc-inferred' })).toBeUndefined();
  });

  test('the client POSTED a service id (a real pick): the resolved id is compared, even against a stored null', () => {
    expect(addonServiceIdentityForFreshness({ rawServiceId: 'svc-new', priorRow: { service_id: null }, inferredServiceId: 'svc-new' })).toBe('svc-new');
    expect(addonServiceIdentityForFreshness({ rawServiceId: 'svc-new', priorRow: { service_id: 'svc-old' }, inferredServiceId: 'svc-new' })).toBe('svc-new');
  });

  test('raw id omitted but the stored row HAS a service id: the inferred id is compared (a name/key change is a real change)', () => {
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: { service_id: 'svc-old' }, inferredServiceId: 'svc-other' })).toBe('svc-other');
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: { service_id: 'svc-old' }, inferredServiceId: null })).toBeNull();
  });

  // GitHub Codex round 26 P1 (#4657, :1627): an ID-less fallback switch
  // posts serviceId null too — key/name decide.
  test('raw id omitted + stored null service_id, but the submitted KEY differs from the stored snapshot: an explicit switch, compares the inferred id', () => {
    const priorRow = { service_id: null, service_key_snapshot: 'lawn_fert', service_name: 'Quarterly Fertilization' };
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow, inferredServiceId: 'svc-mosq', submittedServiceKey: 'mosquito', submittedServiceName: 'Mosquito Add-on' })).toBe('svc-mosq');
  });

  test('raw id omitted + stored null service_id, same key (case/space-insensitive): the round-trip, skipped', () => {
    const priorRow = { service_id: null, service_key_snapshot: 'lawn_fert', service_name: 'Quarterly Fertilization' };
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow, inferredServiceId: 'svc-fert', submittedServiceKey: ' LAWN_FERT ', submittedServiceName: 'Quarterly Fertilization' })).toBeUndefined();
  });

  test('no stored key: the NAME decides — a different name is a switch, the same name (any case) is the round-trip; nothing to compare = skipped', () => {
    const priorRow = { service_id: null, service_key_snapshot: null, service_name: 'Quarterly Fertilization' };
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow, inferredServiceId: 'svc-mosq', submittedServiceName: 'Mosquito Add-on' })).toBe('svc-mosq');
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow, inferredServiceId: 'svc-fert', submittedServiceName: 'quarterly fertilization' })).toBeUndefined();
    expect(addonServiceIdentityForFreshness({ rawServiceId: null, priorRow: { service_id: null }, inferredServiceId: 'svc-x', submittedServiceName: 'Anything' })).toBeUndefined();
  });

  test('the normalizer hands isNewAddonDiscount this helper\'s answer, never the bare inferred id (source pin)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/\}, gross, addonServiceIdentityForFreshness\(\{/g)).toHaveLength(1);
    expect(src.match(/\}, gross, catalogService\?\.id \|\| null\)/g)).toBeNull();
    expect(src.match(/submittedServiceKey: a\.serviceKey \|\| null,/g)).toHaveLength(1);
  });
});

// GitHub Codex round 26 P1 (#4657, :11100): the unknown-primary-gross refusal
// used to fire only under canonical adoption; a composition change (delete
// an undiscounted sibling) on a legacy null-gross row recomputed from the
// echoed NET ($100 + $90 priced as $90 + $90 = $180, not $190).
describe('legacyPrimaryGrossUnknownFor — refuse a non-preserved reprice of a legacy null-gross row unless a real gross was entered (round 26 P1, #4657 :11100)', () => {
  const { legacyPrimaryGrossUnknownFor } = require('../routes/admin-schedule')._test;
  // $100 primary (gross unknown), a $100 add-on stored net $90, a $50 undiscounted sibling: stored total $240.
  const existing = { primary_line_price: null, estimated_price: 240, discount_type: null, line_discount_type: null };
  const rows = [
    { id: 'a1', base_price: 100, estimated_price: 90, discount_id: 'disc-10', discount_type: 'percentage' },
    { id: 'a2', base_price: 50, estimated_price: 50, discount_id: null, discount_type: null },
  ];
  const base = {
    existing, existingAddonDiscountRows: rows, anyExistingAddonDiscounted: true,
    adoptCanonicalPricing: false, legacyPreservationCandidate: true, legacyEconomicsPreserved: false,
  };

  test('Codex\'s repro: sibling deleted, adoption off, not preserved, primary posted as the SEEDED net ($240 − $100 − $50 = $90): refused', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, primaryGross: 90 })).toBe(true);
  });

  test('the same save with an independently ENTERED primary gross ($100 ≠ seed $90): allowed, the recompute can trust it', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, primaryGross: 100 })).toBe(false);
  });

  test('economics preserved (a notes-only save): never refused', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, legacyEconomicsPreserved: true, primaryGross: 90 })).toBe(false);
  });

  test('canonical adoption requested: refused regardless of what was posted (round 12 rule unchanged)', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, adoptCanonicalPricing: true, primaryGross: 100 })).toBe(true);
  });

  test('not a legacy-preservation candidate (gate off / marked row): the widened rule stays out of the way', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, legacyPreservationCandidate: false, primaryGross: 90 })).toBe(false);
  });

  test('a known primary gross, or no discount reaching the primary anywhere: never refused', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, existing: { ...existing, primary_line_price: 100 }, primaryGross: 90 })).toBe(false);
    expect(legacyPrimaryGrossUnknownFor({ ...base, anyExistingAddonDiscounted: false, primaryGross: 90 })).toBe(false);
  });

  test('no posted primary at all on a non-preserved reprice of this shape: refused (nothing trustworthy to price from)', () => {
    expect(legacyPrimaryGrossUnknownFor({ ...base, primaryGross: null })).toBe(true);
  });
});

// GitHub Codex round 26 P1 (#4657, :10824): the financial CAS compares the
// primary's SERVICE identity too.
describe('financialStateDrifted — a concurrent same-price primary service switch is drift (round 26 P1, #4657 :10824)', () => {
  const { financialStateDrifted } = require('../routes/admin-schedule')._test;
  const parent = {
    estimated_price: 160, primary_line_price: 100, discount_type: null, discount_amount: null, discount_dollars: null,
    service_id: 'svc-pest', service_key_snapshot: 'pest_general_quarterly', service_category_snapshot: 'pest',
  };
  const snapshot = { parent, addons: [] };
  test('identical identity: no drift', () => {
    expect(financialStateDrifted(snapshot, { parent: { ...parent }, addons: [] })).toBe(false);
  });
  test('service_id / key / category changed at the same price: drift', () => {
    expect(financialStateDrifted(snapshot, { parent: { ...parent, service_id: 'svc-termite' }, addons: [] })).toBe(true);
    expect(financialStateDrifted(snapshot, { parent: { ...parent, service_key_snapshot: 'termite_bond' }, addons: [] })).toBe(true);
    expect(financialStateDrifted(snapshot, { parent: { ...parent, service_category_snapshot: 'termite' }, addons: [] })).toBe(true);
  });
  // GitHub Codex round 26 P1 (#4657, :10884): cap + scope of the stored
  // appointment discount.
  test('discount_max_dollars (money) and the two scope filters (identity) are compared', () => {
    const withCap = { ...parent, discount_max_dollars: 10, discount_service_key_filter: null, discount_service_category_filter: 'pest' };
    const snap = { parent: withCap, addons: [] };
    expect(financialStateDrifted(snap, { parent: { ...withCap }, addons: [] })).toBe(false);
    expect(financialStateDrifted(snap, { parent: { ...withCap, discount_max_dollars: 20 }, addons: [] })).toBe(true);
    expect(financialStateDrifted(snap, { parent: { ...withCap, discount_max_dollars: null }, addons: [] })).toBe(true);
    expect(financialStateDrifted(snap, { parent: { ...withCap, discount_service_key_filter: 'termite_bond' }, addons: [] })).toBe(true);
    expect(financialStateDrifted(snap, { parent: { ...withCap, discount_service_category_filter: 'termite' }, addons: [] })).toBe(true);
  });

  test('both CAS snapshot builders capture the identity fields (source pin)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/service_id: existing\.service_id,\n\s+\.\.\.\(cols\.service_key_snapshot \? \{ service_key_snapshot: existing\.service_key_snapshot \}/g)).toHaveLength(1);
    expect(src.match(/\.\.\.\(cols\.service_id \? \{ service_id: existingPrice\.service_id \} : null\),/g)).toHaveLength(1);
    // round 26 P1 (:10884): cap + scope in BOTH builders, and the scope columns selected on the single-service read.
    expect(src.match(/discount_service_key_filter: existing\.discount_service_key_filter/g)).toHaveLength(1);
    expect(src.match(/discount_service_key_filter: existingPrice\.discount_service_key_filter/g)).toHaveLength(1);
    expect(src.match(/discount_max_dollars: existing\.discount_max_dollars/g)).toHaveLength(1);
    expect(src.match(/discount_max_dollars: existingPrice\.discount_max_dollars/g)).toHaveLength(1);
    expect(src.match(/\.\.\.\(cols\.discount_service_key_filter \? \['discount_service_key_filter'\] : \[\]\),/g)).toHaveLength(1);
  });

  // Pre-push fallback audit P1 (round 26c): every key the addons-array
  // branch places in financialCasSnapshot.parent must be a column the
  // `existing` read actually selected — an unselected key would store
  // undefined, the locked re-read (which selects the snapshot's keys) would
  // read the real value, and EVERY save on such a row would 409.
  test('every addons-branch snapshot key is selected by existingFields (source pin)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    const fieldsStart = src.indexOf('const existingFields = [');
    const fieldsEnd = src.indexOf("const existing = await db('scheduled_services')", fieldsStart);
    expect(fieldsStart).toBeGreaterThan(-1);
    expect(fieldsEnd).toBeGreaterThan(fieldsStart);
    const selected = new Set([...src.slice(fieldsStart, fieldsEnd).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const snapStart = src.lastIndexOf('financialCasSnapshot = {\n            parent: {');
    const snapEnd = src.indexOf('addons: existingAddonDiscountRows.map', snapStart);
    expect(snapStart).toBeGreaterThan(-1);
    expect(snapEnd).toBeGreaterThan(snapStart);
    const snapshotKeys = [...src.slice(snapStart, snapEnd).matchAll(/\{ ([a-z_]+): existing\.\1 \}|^\s+([a-z_]+): existing\.\2,/gm)]
      .map((m) => m[1] || m[2]);
    expect(snapshotKeys.length).toBeGreaterThanOrEqual(16);
    for (const key of snapshotKeys) expect(selected.has(key)).toBe(true);
  });
});

// GitHub Codex round 26 P1 (#4657, :11902): the null witness on the blank-
// price path of an unpriced no-add-on visit had no under-lock recheck.
describe('lockedWitnessDrifted — the witness is rechecked against the LOCKED row when no snapshot covered estimated_price (round 26 P1, #4657 :11902)', () => {
  const { lockedWitnessDrifted } = require('../routes/admin-schedule')._test;

  test('the repro: "Not priced" confirmed (null witness), no snapshot, no planned price, but the locked row is now priced: drift', () => {
    expect(lockedWitnessDrifted({ expectedTotal: null, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: 120 })).toBe(true);
  });

  test('null witness, locked row still unpriced: no drift', () => {
    expect(lockedWitnessDrifted({ expectedTotal: null, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: null })).toBe(false);
  });

  test('numeric witness against the locked retained total: match passes, a concurrent reprice or clear drifts', () => {
    expect(lockedWitnessDrifted({ expectedTotal: 100, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: 100 })).toBe(false);
    expect(lockedWitnessDrifted({ expectedTotal: 100, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: 120 })).toBe(true);
    expect(lockedWitnessDrifted({ expectedTotal: 100, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: null })).toBe(true);
  });

  test('a planned write wins over the locked stored value', () => {
    expect(lockedWitnessDrifted({ expectedTotal: 90, financialCasSnapshot: null, plannedEstimatedPrice: 90, lockedEstimatedPrice: 120 })).toBe(false);
  });

  test('no witness posted, or a snapshot already covering estimated_price: never fires here', () => {
    expect(lockedWitnessDrifted({ expectedTotal: undefined, financialCasSnapshot: null, plannedEstimatedPrice: undefined, lockedEstimatedPrice: 120 })).toBe(false);
    expect(lockedWitnessDrifted({ expectedTotal: null, financialCasSnapshot: { parent: {}, addons: [] }, plannedEstimatedPrice: undefined, lockedEstimatedPrice: 120 })).toBe(false);
  });

  test('the locked block is entered on a posted witness alone and selects estimated_price for it (source pin)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(src.match(/\|\| financialCasSnapshot \|\| expectedTotal !== undefined\) \{/g)).toHaveLength(1);
    expect(src.match(/: \['id', 'estimated_price'\];/g)).toHaveLength(1);
    expect(src.match(/if \(lockedWitnessDrifted\(\{/g)).toHaveLength(1);
  });
});

// GitHub Codex round 27 P1 (#4657, :10969): appointment-discount freshness
// must be judged against the SAME row read the planner builds its financial
// CAS snapshot from — never the route's earlier `existingDiscount` read. A
// concurrent A → B edit between the two reads used to leave the boolean
// stale (false), so a request restoring A read as "pre-existing" and
// assertNewStackGroupConflicts grandfathered it against an add-on already
// carrying A's non-stackable group-mate, while the CAS (taken from the
// second read, B) saw nothing to refuse.
describe('appointmentDiscountChangedAgainst — freshness against a given row read (round 27 P1, #4657 :10969)', () => {
  const { appointmentDiscountChangedAgainst } = require('../routes/admin-schedule')._test;
  const cols = { discount_id: true };
  const rowA = { discount_type: 'percentage', discount_amount: 10, discount_id: 'silver' };
  const rowB = { discount_type: 'fixed_amount', discount_amount: 10, discount_id: 'credit' };

  test('a request restoring A judged against a row that still holds A: unchanged', () => {
    expect(appointmentDiscountChangedAgainst(rowA, { discountType: 'percentage', discountAmount: 10, discountId: 'silver', cols })).toBe(false);
  });
  test("the SAME request judged against the row AFTER a concurrent A → B edit: CHANGED (Codex's repro)", () => {
    expect(appointmentDiscountChangedAgainst(rowB, { discountType: 'percentage', discountAmount: 10, discountId: 'silver', cols })).toBe(true);
  });
  test('identity alone counts when the column exists (same type/amount, different catalog id)', () => {
    expect(appointmentDiscountChangedAgainst(rowA, { discountType: 'percentage', discountAmount: 10, discountId: 'gold', cols })).toBe(true);
    expect(appointmentDiscountChangedAgainst(rowA, { discountType: 'percentage', discountAmount: 10, discountId: 'gold', cols: { discount_id: false } })).toBe(false);
  });
  test('a request that never touches the appointment discount (both undefined) is never a change, whatever the row holds', () => {
    expect(appointmentDiscountChangedAgainst(rowB, { discountType: undefined, discountAmount: undefined, discountId: 'silver', cols })).toBe(false);
  });
  test('a null row (the read failed) with a posted discount reads as changed — fail closed toward "new"', () => {
    expect(appointmentDiscountChangedAgainst(null, { discountType: 'percentage', discountAmount: 10, discountId: 'silver', cols })).toBe(true);
  });

  // Source pins: both planner branches re-derive against their own read
  // and the PUT route adopts the planner's answer.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
  test('the addons branch re-derives against `existing`, the single-service branch against `existingPrice`, and the planner returns it', () => {
    expect(source).toMatch(/if \(existing\) \{\s*appointmentDiscountChanged = appointmentDiscountChangedAgainst\(existing, \{ discountType, discountAmount, discountId, cols \}\);/);
    expect(source).toMatch(/if \(existingPrice\) \{\s*appointmentDiscountChanged = appointmentDiscountChangedAgainst\(existingPrice, \{ discountType, discountAmount, discountId, cols \}\);/);
    expect(source).toMatch(/appointmentDiscountChanged = singleServicePlan\.appointmentDiscountChanged;/);
  });
  test('the PUT route adopts the planner\'s answer for everything after the plan', () => {
    expect(source).toMatch(/appointmentDiscountChanged = financialPlan\.appointmentDiscountChanged;/);
  });
});

// Follow-up to #4657 (owner-approved 2026-09-24): a generic row-version CAS
// beneath the field comparators. The planner records the Postgres xmin of
// the visit row and each add-on row it read; the route re-reads them under
// the lock and refuses ANY change — a column no comparator lists included.
describe('rowVersionsDrifted — generic row-version CAS beneath the field comparators (follow-up to #4657)', () => {
  const { rowVersionsDrifted, rowVersionsFor } = require('../routes/admin-schedule')._test;
  const parentRow = { id: 'visit-1', estimated_price: 160, row_version: '1001' };
  const addonRows = [{ id: 'addon-1', row_version: '2001' }, { id: 'addon-2', row_version: '2002' }];
  const snapshot = { parent: { estimated_price: 160 }, addons: [], versions: rowVersionsFor(parentRow, addonRows) };

  test('rowVersionsFor records the parent xmin and every add-on xmin keyed by row id, as strings', () => {
    expect(snapshot.versions).toEqual({ parent: '1001', addons: { 'addon-1': '2001', 'addon-2': '2002' } });
  });
  test('identical versions under the lock: no drift', () => {
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: '1001' }, addons: addonRows })).toBe(false);
  });
  test('the parent row was written by anyone, on any column: drift', () => {
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: '1005' }, addons: addonRows })).toBe(true);
  });
  test('one add-on row was written: drift; a missing add-on row: drift', () => {
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: '1001' }, addons: [addonRows[0], { id: 'addon-2', row_version: '2999' }] })).toBe(true);
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: '1001' }, addons: [addonRows[0]] })).toBe(true);
  });
  test('a parent whose locked re-read carries no version (row gone): drift', () => {
    expect(rowVersionsDrifted(snapshot, { parent: null, addons: addonRows })).toBe(true);
  });
  test('numeric vs string xmin compare by value', () => {
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: 1001 }, addons: [{ id: 'addon-1', row_version: 2001 }, { id: 'addon-2', row_version: 2002 }] })).toBe(false);
  });
  test('no recorded versions (a mock connection with no raw(), or no snapshot at all): the check is skipped, never a false 409', () => {
    expect(rowVersionsDrifted({ parent: {}, addons: [], versions: rowVersionsFor({ id: 'v' }, [{ id: 'a' }]) }, { parent: { row_version: '9' }, addons: [] })).toBe(false);
    expect(rowVersionsDrifted({ parent: {}, addons: [] }, { parent: { row_version: '9' }, addons: [] })).toBe(false);
    expect(rowVersionsDrifted(null, { parent: { row_version: '9' }, addons: [] })).toBe(false);
  });
  test('a concurrently ADDED add-on row the plan never saw is not this check\'s job (financialStateDrifted covers it) — recorded rows only', () => {
    expect(rowVersionsDrifted(snapshot, { parent: { row_version: '1001' }, addons: [...addonRows, { id: 'addon-3', row_version: '3001' }] })).toBe(false);
  });
});
