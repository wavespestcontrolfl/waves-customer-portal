const {
  nonPestTierBaseMap,
  comboPricingEntry,
  serviceCadenceComboKey,
  buildServiceCadenceCombos,
  bundleSectionLadderForService,
  applySelectedMosquitoTierToEstimateData,
  buildPricingBundle,
} = require('../routes/estimate-public');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');

// A pest + lawn + mosquito bundle (Gold tier = 3 qualifying services → 15% off).
function pestLawnMosquitoV1() {
  return {
    pestTiers: [
      { label: 'Quarterly', mo: 60, ann: 720, pa: 180, apps: 4 },
      { label: 'Bi-Monthly', mo: 80, ann: 960, pa: 160, apps: 6 },
      { label: 'Monthly', mo: 120, ann: 1440, pa: 120, apps: 12 },
    ],
    services: [
      { name: 'Pest Control', service: 'pest_control', mo: 60, ann: 720, perTreatment: 180, visitsPerYear: 4 },
      { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 },
      { name: 'Mosquito Control', service: 'mosquito', mo: 79, ann: 948, perTreatment: 79, visitsPerYear: 12 },
    ],
    discount: 0.15,
    manualDiscount: null,
  };
}

const LAWN_MQ_RESULT_STATS = {
  lawn: [
    { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105 },
    { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91 },
    { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
    { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89 },
  ],
  mq: [
    { n: 'Seasonal', v: 9, mo: 65, ann: 780, pv: 86.67 },
    { n: 'Monthly', v: 12, mo: 79, ann: 948, pv: 79, recommended: true },
  ],
};

// A pest + lawn bundle in the v1 (admin) shape. Silver tier (2 qualifying
// recurring services) → 10% WaveGuard discount. Lawn defaults to Enhanced (9x).
function pestLawnV1() {
  return {
    pestTiers: [
      { label: 'Quarterly', mo: 60, ann: 720, pa: 180, apps: 4 },
      { label: 'Bi-Monthly', mo: 80, ann: 960, pa: 160, apps: 6 },
      { label: 'Monthly', mo: 120, ann: 1440, pa: 120, apps: 12 },
    ],
    services: [
      { name: 'Pest Control', service: 'pest_control', mo: 60, ann: 720, perTreatment: 180, visitsPerYear: 4 },
      { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 },
    ],
    discount: 0.10,
    manualDiscount: null,
  };
}

const LAWN_RESULT_STATS = {
  lawn: [
    { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105 },
    { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91 },
    { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
    { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89 },
  ],
};

const QUARTERLY = { key: 'quarterly', label: 'Quarterly' };
const MONTHLY = { key: 'monthly', label: 'Monthly' };

describe('nonPestTierBaseMap — per-service tier price lookup from result rows', () => {
  test('maps lawn tier keys to their pre-discount base prices/visits, dropping the retired Basic', () => {
    // basic/Quarterly retired for new sales (owner directive 2026-07-09) —
    // stored rows still carry it, but it is no longer a selectable combo axis.
    const map = nonPestTierBaseMap(LAWN_RESULT_STATS);
    expect(Object.keys(map)).toEqual(['lawn_care']);
    expect(map.lawn_care.basic).toBeUndefined();
    expect(Object.keys(map.lawn_care).sort()).toEqual(['enhanced', 'premium', 'standard']);
    expect(map.lawn_care.enhanced).toMatchObject({ mo: 66.75, v: 9, recommended: true });
    expect(map.lawn_care.premium).toMatchObject({ mo: 89, v: 12 });
  });

  test('below-$50 stored lawn rows enter the combo math UNCLAMPED (floors disarmed, owner ruling 2026-07-17)', () => {
    // programMinimumMonthly is 0 (disarm value) — a $38/mo Standard row is a
    // valid sold price and flows into the combo math as stored.
    const map = nonPestTierBaseMap({
      lawn: [
        { name: 'Standard', v: 6, mo: 38, ann: 456, pa: 76 },
        { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
      ],
    });
    expect(map.lawn_care.standard).toMatchObject({ mo: 38, ann: 456, pa: 76, v: 6 });
    expect(map.lawn_care.enhanced).toMatchObject({ mo: 52, ann: 624, v: 9 });
  });

  describe('re-armed at $50 (clamp machinery kept for potential re-arm)', () => {
    // Snapshot/restore pattern per tests/lawn-pricing-ladder-invariants.test.js.
    let priorProgramMinimum;
    beforeEach(() => {
      priorProgramMinimum = LAWN_PRICING_V2.programMinimumMonthly;
      LAWN_PRICING_V2.programMinimumMonthly = 50;
    });
    afterEach(() => {
      LAWN_PRICING_V2.programMinimumMonthly = priorProgramMinimum;
    });

    test('clamps below-floor stored lawn rows to the $50/mo program minimum', () => {
      const map = nonPestTierBaseMap({
        lawn: [
          { name: 'Standard', v: 6, mo: 38, ann: 456, pa: 76 },
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
        ],
      });
      expect(map.lawn_care.standard).toMatchObject({ mo: 50, ann: 600, pa: 100, v: 6 });
      expect(map.lawn_care.enhanced).toMatchObject({ mo: 52, ann: 624, v: 9 });
    });
  });

  test('returns {} when there are no non-pest tier rows', () => {
    expect(nonPestTierBaseMap({})).toEqual({});
    expect(nonPestTierBaseMap({ lawn: [] })).toEqual({});
  });
});

describe('comboPricingEntry — authoritative total via shapeFromV1', () => {
  const v1 = pestLawnV1();
  const tierBaseMap = nonPestTierBaseMap(LAWN_RESULT_STATS);

  test('the DEFAULT combo equals the existing bundle total (regression pin)', () => {
    // Default = pest Quarterly + lawn Enhanced (the recommended/stored tier).
    // Selecting Enhanced must reproduce today's number: pest 60*0.9 + lawn 66.75*0.9.
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, tierBaseMap, {
      pest_control: 'quarterly',
      lawn_care: 'enhanced',
    });
    const expected = Math.round((60 * 0.9 + 66.75 * 0.9) * 100) / 100; // 114.08
    expect(entry.monthly).toBe(expected);
  });

  test('pest Monthly + lawn Standard recomputes both contributions at 10% off — no lawn floor (owner ruling 2026-07-17)', () => {
    const entry = comboPricingEntry(v1, MONTHLY, v1.pestTiers[2], {}, tierBaseMap, {
      pest_control: 'monthly',
      lawn_care: 'standard',
    });
    // pest 120*0.9 = 108 ; lawn 45.5*0.9 = 40.95 (unclamped — floors
    // disarmed) → 148.95
    expect(entry.monthly).toBe(148.95);
    expect(entry.annual).toBe(Math.round(148.95 * 12 * 100) / 100);
  });

  test('pest Quarterly + lawn Premium', () => {
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, tierBaseMap, {
      pest_control: 'quarterly',
      lawn_care: 'premium',
    });
    // pest 60*0.9 = 54 ; lawn 89*0.9 = 80.1 → 134.1
    expect(entry.monthly).toBe(134.1);
  });

  test('a re-armed cost floor rides the combo selection — WaveGuard cannot cut the lawn slice below it (pre-push codex P0 round 9 #2827)', () => {
    // Stored rows carry costFloorAnnual for margin REPORTING on every
    // quote; with the estimate's arm resolution ARMED the selected tier's
    // own floor joins the post-discount clamp (never above the authored
    // base — same rule as generateEstimate's guards).
    const stats = {
      lawn: [
        { name: 'Standard', v: 6, mo: 60, ann: 720, pa: 120, costFloorAnnual: 700 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true, costFloorAnnual: 810 },
      ],
    };
    const map = nonPestTierBaseMap(stats);
    const armed = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, map, {
      pest_control: 'quarterly',
      lawn_care: 'standard',
    }, { lawnCostFloorArmed: true });
    // pest 60*0.9 = 54 ; lawn 60*0.9 = 54 → clamped at ceil(700/12) = 58.34
    // (cent-ceiled so 12× never lands under the floor) → 112.34
    expect(armed.monthly).toBe(112.34);

    // A floor ABOVE the authored base never raises the price — the line is
    // merely undiscountable (Enhanced: base 66.75, floor 810/12 = 67.5).
    const aboveBase = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, map, {
      pest_control: 'quarterly',
      lawn_care: 'enhanced',
    }, { lawnCostFloorArmed: true });
    // pest 54 ; lawn held at its base 66.75 → 120.75
    expect(aboveBase.monthly).toBe(120.75);
    // …and the per-treatment DISPLAY (drives the first-application invoice)
    // is capped the same way — never lifted to a floor above the authored
    // line (codex P2 round 10 on #2827).
    const lawnTreatment = (aboveBase.perServiceTreatments || [])
      .find((row) => (row.service || '').includes('lawn'));
    if (lawnTreatment && lawnTreatment.displayPrice != null) {
      expect(lawnTreatment.displayPrice).toBeLessThanOrEqual(89);
    }

    // Disarmed (default): the same reporting field moves nothing.
    const disarmed = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, map, {
      pest_control: 'quarterly',
      lawn_care: 'standard',
    });
    expect(disarmed.monthly).toBe(108);
  });

  test('a bundle manual discount applies IN FULL — no lawn floor caps the headroom (owner ruling 2026-07-17)', () => {
    // No WaveGuard %; floors disarmed so the lawn Standard base stays $45.50.
    // The $65/mo ($780/yr) manual discount spends against the whole bundle:
    // pest 60 + lawn 45.5 = 105.5 gross − 65 = 40.5, uncapped.
    const manualV1 = { ...pestLawnV1(), discount: 0, manualDiscount: { type: 'FIXED', value: 780 } };
    const entry = comboPricingEntry(manualV1, QUARTERLY, manualV1.pestTiers[0], {}, tierBaseMap, {
      pest_control: 'quarterly',
      lawn_care: 'standard',
    });
    expect(entry.monthly).toBe(40.5);
    expect(entry.manualDiscount).toMatchObject({ capped: false, capReason: null });
    expect(entry.manualDiscount.monthlyAmount).toBe(65);
  });
});

describe('serviceCadenceComboKey — stable composite key', () => {
  test('sorts keys so the composite is order-independent', () => {
    expect(serviceCadenceComboKey({ pest_control: 'monthly', lawn_care: 'basic' }))
      .toBe('lawn_care:basic|pest_control:monthly');
    expect(serviceCadenceComboKey({ lawn_care: 'basic', pest_control: 'monthly' }))
      .toBe('lawn_care:basic|pest_control:monthly');
  });
});

describe('buildServiceCadenceCombos — full combination ladder', () => {
  test('pest(3) × lawn(3, Basic retired) = 9 priced combinations, all keyed + summed', () => {
    const combos = buildServiceCadenceCombos(pestLawnV1(), {}, LAWN_RESULT_STATS);
    expect(combos).toHaveLength(9);
    expect(combos.some((c) => c.selection.lawn_care === 'basic')).toBe(false);
    // Spot-check combos against the hand math (no floor — owner ruling 2026-07-17).
    const monthlyStandard = combos.find((c) => c.key === 'lawn_care:standard|pest_control:monthly');
    expect(monthlyStandard.monthly).toBe(148.95); // pest 108 + lawn 45.5*0.9
    const quarterlyEnhanced = combos.find((c) => c.key === 'lawn_care:enhanced|pest_control:quarterly');
    expect(quarterlyEnhanced.monthly).toBe(Math.round((60 * 0.9 + 66.75 * 0.9) * 100) / 100);
    // Every combo carries a selection for both axes.
    for (const c of combos) {
      expect(c.selection.pest_control).toBeTruthy();
      expect(c.selection.lawn_care).toBeTruthy();
    }
  });

  test('combo perServiceTreatments reflect the SELECTED tier (drives first-visit invoice)', () => {
    // The accept handler re-bases the first-application invoice on the selected
    // combo's perServiceTreatments — so they must carry the chosen tier's
    // per-visit price, not the default tier's. (Regression for the P0 where the
    // first invoice billed the default non-pest rows.)
    const combos = buildServiceCadenceCombos(pestLawnV1(), {}, LAWN_RESULT_STATS);
    const monthlyStandard = combos.find((c) => c.key === 'lawn_care:standard|pest_control:monthly');
    const lawnRow = monthlyStandard.perServiceTreatments.find((r) => /lawn/i.test(r.service || ''));
    // standard per-app 91 * 0.9 = 81.9 — floors disarmed (owner ruling
    // 2026-07-17), so the discounted market price bills as-is.
    expect(lawnRow.displayPrice).toBe(81.9);
    const quarterlyPremium = combos.find((c) => c.key === 'lawn_care:premium|pest_control:quarterly');
    const lawnRow2 = quarterlyPremium.perServiceTreatments.find((r) => /lawn/i.test(r.service || ''));
    expect(lawnRow2.displayPrice).toBe(80.1); // premium per-app 89 * 0.9 (above floor)
  });

  test('returns null when no non-pest service has more than one tier', () => {
    // Pest-only bundle: nothing extra to vary.
    const pestOnly = { pestTiers: pestLawnV1().pestTiers, services: [pestLawnV1().services[0]], discount: 0 };
    expect(buildServiceCadenceCombos(pestOnly, {}, {})).toBeNull();
  });

  test('returns null for a no-pest bundle (combos require a pest axis for billing cadence)', () => {
    // Lawn + tree, no pest. Per-service combos must NOT be emitted — otherwise a
    // placeholder pest cadence would mis-resolve billing to quarterly/per-app
    // instead of the services' own monthly billing (Codex P1).
    const lawnTree = {
      pestTiers: [],
      services: [
        { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, visitsPerYear: 9 },
        { name: 'Tree & Shrub', service: 'tree_shrub', mo: 40, visitsPerYear: 6 },
      ],
      discount: 0.10,
    };
    const rs = {
      lawn: LAWN_RESULT_STATS.lawn,
      ts: [
        { name: 'Light', v: 4, mo: 30, ann: 360, pa: 90 },
        { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
      ],
    };
    expect(buildServiceCadenceCombos(lawnTree, {}, rs)).toBeNull();
  });
});

describe('bundleSectionLadderForService — non-pest section own-cadence slider', () => {
  const lawnSvc = { name: 'Lawn Care', service: 'lawn_care' };

  test('reprices each lawn tier post-WaveGuard discount, PRE manual (manual null) — no $50 floor (owner ruling 2026-07-17)', () => {
    const ladder = bundleSectionLadderForService('lawn_care', { results: LAWN_RESULT_STATS }, lawnSvc, 0.10);
    expect(ladder.map((e) => e.key)).toEqual(['standard', 'enhanced', 'premium']);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    expect(byKey.standard.monthly).toBe(40.95); // 45.5 * 0.9, unclamped
    expect(byKey.enhanced.monthly).toBe(60.08); // 66.75 * 0.9
    expect(byKey.premium.monthly).toBe(80.1); // 89 * 0.9
    // monthlyBase stays the PRE-discount monthly — the client derives the
    // struck-through anchor and the "You save … with WaveGuard" line from
    // the monthlyBase-vs-monthly gap on non-pest rows (no perVisit anchor).
    expect(byKey.standard.monthlyBase).toBe(45.5);
    expect(byKey.premium.monthlyBase).toBe(89);
    // Manual discount is applied once at the bundle total, never per-section.
    for (const e of ladder) expect(e.manualDiscount).toBeNull();
  });

  test('a re-armed margin floor clamps the section card like the combo path (codex P2 round 11 #2827)', () => {
    // Rows carry costFloorAnnual for reporting on every quote; with the
    // estimate ARMED (pricingMetadata stamp) the entry's own floor rides
    // the ladder (marginFloorMonthly) and the section reprice clamps at it
    // — capped at the authored base (undiscounts, never re-prices).
    const estData = {
      pricingMetadata: { lawnCostFloorArmed: true },
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, costFloorAnnual: 516 },
          { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true, costFloorAnnual: 850 },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, costFloorAnnual: 516 },
        ],
      },
    };
    const ladder = bundleSectionLadderForService('lawn_care', estData, lawnSvc, 0.10);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    // Standard: 45.5 × 0.9 = 40.95 → clamped at 516/12 = 43.
    expect(byKey.standard.monthly).toBe(43);
    expect(byKey.standard.flooredAtMinimum).toBe(true);
    // Enhanced: floor ceil(850/12) = 70.84 ABOVE the 66.75 stored monthly —
    // the upstream ladder's armed re-clamp (clampLawnLadderEntry, #2795
    // save==accept semantics) already lifted the ENTRY to its floor, and
    // the section inherits that base: the card shows exactly what accept
    // collects.
    expect(byKey.enhanced.monthly).toBe(70.84);
    // Premium: 89 × 0.9 = 80.1 sits above its 43 floor — untouched.
    expect(byKey.premium.monthly).toBe(80.1);

    // Disarmed (no stamp): same rows reprice with the full discount.
    const disarmed = bundleSectionLadderForService('lawn_care', { results: estData.results }, lawnSvc, 0.10);
    expect(Object.fromEntries(disarmed.map((e) => [e.key, e])).standard.monthly).toBe(40.95);
  });

  test('margin-floor monthly CEILS to the cent — 12× the clamp never lands under the annual floor (codex P2 round 12 #2827)', () => {
    // $630.85/yr floor: nearest-cent monthly (52.57) × 12 = 630.84 would
    // accept a cent under the floor; the ceil rule gives 52.58.
    const estData = {
      pricingMetadata: { lawnCostFloorArmed: true },
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 60, ann: 720, pa: 120, costFloorAnnual: 630.85 },
          { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true, costFloorAnnual: 630.85 },
        ],
      },
    };
    const ladder = bundleSectionLadderForService('lawn_care', estData, lawnSvc, 0.20);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    // Standard: 60 × 0.8 = 48 → clamped at ceil(630.85/12) = 52.58.
    expect(byKey.standard.monthly).toBe(52.58);
    expect(byKey.standard.monthly * 12).toBeGreaterThanOrEqual(630.85);
  });

  test('the combo base map lifts a below-floor lawn base while armed — card == accepted combo (codex P2 round 12 #2827)', () => {
    const stats = {
      lawn: [
        { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91, costFloorAnnual: 570 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true, costFloorAnnual: 570 },
      ],
    };
    // Armed: the 45.5 base lifts to the row's 570/12 = 47.5 floor — the
    // same armed selection lift the section ladder shows, so the backing
    // combo resolves the price the customer actually saw.
    const armed = nonPestTierBaseMap(stats, undefined, { lawnCostFloorArmed: true });
    expect(armed.lawn_care.standard).toMatchObject({ mo: 47.5, ann: 570 });
    // Enhanced sits above its floor — untouched.
    expect(armed.lawn_care.enhanced).toMatchObject({ mo: 66.75, ann: 801 });
    // Disarmed default: reporting fields move nothing.
    const disarmed = nonPestTierBaseMap(stats);
    expect(disarmed.lawn_care.standard).toMatchObject({ mo: 45.5, ann: 546 });
  });

  test('no discount applied when the rate is 0 (Bronze / single-service)', () => {
    const ladder = bundleSectionLadderForService('lawn_care', { results: LAWN_RESULT_STATS }, lawnSvc, 0);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    expect(byKey.standard.monthly).toBe(45.5); // stored base, unclamped (floors disarmed 2026-07-17)
    expect(byKey.premium.monthly).toBe(89);
  });

  test('returns null for a service with no tier rows / no extractor', () => {
    expect(bundleSectionLadderForService('lawn_care', { results: {} }, lawnSvc, 0.1)).toBeNull();
    expect(bundleSectionLadderForService('pest_control', { results: LAWN_RESULT_STATS }, {}, 0.1)).toBeNull();
  });
});

describe('mosquito as a per-service combo axis (pest + lawn + mosquito)', () => {
  test('nonPestTierBaseMap includes mosquito seasonal/monthly tiers', () => {
    const map = nonPestTierBaseMap(LAWN_MQ_RESULT_STATS);
    expect(Object.keys(map).sort()).toEqual(['lawn_care', 'mosquito']);
    expect(map.mosquito.seasonal9).toMatchObject({ mo: 65, v: 9 });
    expect(map.mosquito.monthly12).toMatchObject({ mo: 79, v: 12, recommended: true });
  });

  test('combos fan out pest(3) × lawn(3, Basic retired) × mosquito(2) = 18, summed at 15% off', () => {
    const combos = buildServiceCadenceCombos(pestLawnMosquitoV1(), {}, LAWN_MQ_RESULT_STATS);
    expect(combos).toHaveLength(18);
    // pest Monthly 120*0.85 = 102 + lawn Standard 45.5*0.85 = 38.68
    // (unclamped — floors disarmed 2026-07-17) + mosquito Seasonal
    // 65*0.85 = 55.25 → 195.93
    const c = combos.find((x) => x.key === 'lawn_care:standard|mosquito:seasonal9|pest_control:monthly');
    expect(c.monthly).toBe(195.93);
    for (const combo of combos) {
      expect(combo.selection.pest_control).toBeTruthy();
      expect(combo.selection.lawn_care).toBeTruthy();
      expect(combo.selection.mosquito).toBeTruthy();
    }
  });
});

describe('applySelectedMosquitoTierToEstimateData — accept re-stamps the picked mosquito cadence', () => {
  function estDataWithRecurringMosquito() {
    return {
      result: {
        recurring: {
          monthlyTotal: 79,
          services: [{ name: 'Mosquito Control', service: 'mosquito', mo: 79, ann: 948, v: 12, visitsPerYear: 12 }],
        },
        results: {
          mq: [
            { n: 'Seasonal', v: 9, mo: 65, ann: 780, pv: 86.67 },
            { n: 'Monthly', v: 12, mo: 79, ann: 948, pv: 79, recommended: true },
          ],
        },
      },
    };
  }
  const seasonalFreq = {
    key: 'seasonal9', serviceCategory: 'mosquito', monthly: 65, annual: 780,
    perTreatment: 86.67, visitsPerYear: 9, billingFrequencyKey: 'monthly', label: 'Seasonal',
  };

  test('selecting Seasonal rewrites the recurring mosquito line to 9 visits + marks results.mq', () => {
    const out = applySelectedMosquitoTierToEstimateData(estDataWithRecurringMosquito(), seasonalFreq);
    const svc = out.result.recurring.services[0];
    expect(svc.visitsPerYear).toBe(9);
    expect(svc.monthly).toBe(65);
    expect(svc.tierKey).toBe('seasonal9');
    expect(svc.billingFrequencyKey).toBe('monthly'); // mosquito always bills monthly
    expect(out.result.results.mq.filter((r) => r.selected).map((r) => r.n)).toEqual(['Seasonal']);
  });

  test('is a no-op for a non-mosquito (e.g. lawn) selection', () => {
    const lawnFreq = { key: 'basic', serviceCategory: 'lawn_care', monthly: 35 };
    const input = estDataWithRecurringMosquito();
    expect(applySelectedMosquitoTierToEstimateData(input, lawnFreq)).toBe(input);
  });
});

describe('bundle split survives 1-cent per-service rounding drift (buildPricingBundle e2e)', () => {
  // Real prod Silver pest+lawn draft (numbers verbatim, identity swapped):
  // combined monthly rounds from the discounted sum (0.9 × 93.42 = 84.078 →
  // 84.08) while the per-service treatment rows round individually
  // (32.10 + 51.975→51.98 sums to 84.07) — a legitimate 1-cent drift.
  // The old gate compared raw floats: |84.08 − 84.07| = 0.010000000000005116
  // > 0.01, so frequencyServiceRowsMatchMonthly rejected the quarterly entry
  // and the whole estimate collapsed into the single combined-price bundle
  // section — no per-service sections, no lawn cadence slider, even though
  // buildServiceCadenceCombos had priced all 9 combinations.
  function driftEstimate() {
    return {
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'draft',
      monthly_total: 84.08,
      annual_total: 1008.90,
      onetime_total: 99,
      waveguard_tier: 'Silver',
      estimate_data: {
        inputs: {
          svcPest: true, svcLawn: true, pestFreq: '4', lawnFreq: '9',
          grassType: 'st_augustine', homeSqFt: '2309', lotSqFt: '9423',
          stories: '1', isCommercial: 'NO', customerName: 'Split Drift',
          address: '123 Rounding Way, Parrish, FL 34219',
        },
        result: {
          hasRecurring: true,
          hasOneTime: true,
          manualDiscount: null,
          totals: { year1: 1107.9, year2: 1008.9, year2mo: 84.08, manualDiscount: null },
          oneTime: { items: [], total: 99, membershipFee: 99 },
          recurring: {
            tier: 'Silver',
            waveGuardTier: 'Silver',
            discount: 0.1,
            serviceCount: 2,
            monthlyTotal: 84.08,
            grandTotal: 84.08,
            annualBeforeDiscount: 1121,
            annualAfterDiscount: 1008.9,
            services: [
              {
                name: 'Lawn Care', service: 'lawn_care', mo: 57.75, monthly: 57.75,
                perTreatment: 77, visitsPerYear: 9, grassType: 'St. Augustine',
                discountable: true, discountEligible: true,
                waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
              },
              {
                name: 'Pest Control', service: 'pest_control', mo: 35.67, monthly: 35.67,
                basePrice: 107, perTreatment: 107, visitsPerYear: 4,
              },
            ],
          },
          results: {
            pestTiers: [
              { label: 'Quarterly', mo: 35.67, pa: 107, ann: 428, apps: 4, init: 99, recommended: true },
              { label: 'Bi-Monthly', mo: 45.48, pa: 90.95, ann: 545.7, apps: 6, init: 99 },
              { label: 'Monthly', mo: 74.9, pa: 74.9, ann: 898.8, apps: 12, init: 99 },
            ],
            lawn: [
              { name: '6x applications/yr', v: 6, mo: 50, pa: 100, ann: 600, dimmed: true },
              { name: '9x applications/yr', v: 9, mo: 57.75, pa: 77, ann: 693, recommended: true },
              { name: '12x applications/yr', v: 12, mo: 79, pa: 79, ann: 948, dimmed: true },
            ],
          },
        },
      },
    };
  }

  test('splits into pest + lawn sections, lawn with its own application ladder', async () => {
    const bundle = await buildPricingBundle(driftEstimate());
    expect(bundle.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);

    const pest = bundle.services[0];
    expect(pest.frequencies.map((f) => f.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    // Per-application pest pricing at 10% WaveGuard off: 107→96.30, 90.95→81.86(±1¢), 74.90→67.41
    expect(pest.frequencies[0].perTreatment).toBeCloseTo(96.30, 2);

    const lawn = bundle.services[1];
    // Floors disarmed (owner ruling 2026-07-17): the 6x tier that used to be
    // pinned at the $50/mo program minimum and display-hidden as a decoy is
    // now just another market-priced cadence — all three tiers are offered
    // at the Silver 10% off their stored bases.
    expect(lawn.frequencies.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    expect(lawn.frequencies.map((f) => f.visitsPerYear)).toEqual([6, 9, 12]);
    expect(lawn.frequencies.map((f) => f.monthly)).toEqual([45, 51.98, 71.1]); // 50/57.75/79 × 0.9

    // The combo ladder backs the selections; default combo equals the stored
    // total.
    expect(bundle.serviceCadenceCombos).toHaveLength(9);
    const defaultCombo = bundle.serviceCadenceCombos.find(
      (c) => c.key === 'lawn_care:enhanced|pest_control:quarterly',
    );
    expect(defaultCombo.monthly).toBe(84.08);
  });
});

describe('lawn floor display-hide machinery (buildPricingBundle e2e) — disarmed by default (owner ruling 2026-07-17)', () => {
  function lawnOnlyEstimate(lawnRows, { monthly = 51.98 } = {}) {
    return {
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'sent',
      monthly_total: monthly,
      annual_total: Math.round(monthly * 12 * 100) / 100,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      estimate_data: {
        result: {
          hasRecurring: true,
          recurring: {
            discount: 0,
            monthlyTotal: monthly,
            services: [{ name: 'Lawn Care', service: 'lawn_care', mo: monthly, visitsPerYear: 9 }],
          },
          results: { lawn: lawnRows },
          oneTime: { items: [], total: 0 },
        },
      },
    };
  }

  function snapshotEstimate() {
    // Frozen pre-deploy send-snapshot shape (no floored flags on entries).
    const snapshotFrequencies = [
      {
        key: 'standard', label: 'Bi-monthly', serviceCategory: 'lawn_care', serviceTierKey: 'standard',
        monthly: 50, monthlyBase: 50, annual: 600, perTreatment: 100, visitsPerYear: 6,
        billingFrequencyKey: 'monthly', included: [], addOns: [],
      },
      {
        key: 'enhanced', label: '9 visits / yr', serviceCategory: 'lawn_care', serviceTierKey: 'enhanced',
        monthly: 57.75, monthlyBase: 57.75, annual: 693, perTreatment: 77, visitsPerYear: 9,
        billingFrequencyKey: 'monthly', included: [], addOns: [], recommended: true,
      },
      {
        key: 'premium', label: 'Monthly', serviceCategory: 'lawn_care', serviceTierKey: 'premium',
        monthly: 79, monthlyBase: 79, annual: 948, perTreatment: 79, visitsPerYear: 12,
        billingFrequencyKey: 'monthly', included: [], addOns: [],
      },
    ];
    const estimate = lawnOnlyEstimate([
      { name: 'Standard', v: 6, mo: 50, ann: 600, pa: 100 },
      { name: 'Enhanced', v: 9, mo: 57.75, ann: 693, pa: 77, recommended: true },
      { name: 'Premium', v: 12, mo: 79, ann: 948, pa: 79 },
    ], { monthly: 57.75 });
    estimate.estimate_data.sendSnapshot = {
      pricingBundle: {
        frequencies: snapshotFrequencies,
        source: 'send_snapshot',
        oneTimeBreakdown: { items: [], total: 0 },
      },
    };
    return estimate;
  }

  describe('disarmed default (programMinimumMonthly = 0): nothing clamps, nothing hides', () => {
    test('every stored tier renders at its stored price; no hiddenLawnFrequencies', async () => {
      const bundle = await buildPricingBundle(lawnOnlyEstimate([
        { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
        { name: 'Enhanced', v: 9, mo: 45, ann: 540, pa: 60, recommended: true },
        { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
      ], { monthly: 50 }));
      expect(bundle.frequencies.map((f) => [f.key, f.monthly])).toEqual([
        ['standard', 40],
        ['enhanced', 45],
        ['premium', 60],
      ]);
      expect(bundle.hiddenLawnFrequencies).toBeUndefined();
    });

    test('send-snapshot fast path serves all tiers unhidden, including the at-$50 one', async () => {
      const bundle = await buildPricingBundle(snapshotEstimate());
      expect(bundle.snapshotHit).toBe(true); // prove the fast path served this, not a rebuild
      expect(bundle.frequencies.map((f) => [f.key, f.monthly])).toEqual([
        ['standard', 50],
        ['enhanced', 57.75],
        ['premium', 79],
      ]);
      expect((bundle.hiddenLawnFrequencies || []).map((f) => f.key)).toEqual([]);
    });
  });

  describe('re-armed at $50 (machinery kept for potential re-arm)', () => {
    // Snapshot/restore pattern per tests/lawn-pricing-ladder-invariants.test.js.
    let priorProgramMinimum;
    beforeEach(() => {
      priorProgramMinimum = LAWN_PRICING_V2.programMinimumMonthly;
      LAWN_PRICING_V2.programMinimumMonthly = 50;
    });
    afterEach(() => {
      LAWN_PRICING_V2.programMinimumMonthly = priorProgramMinimum;
    });

    test('floored non-recommended tier is hidden; recommended floored tier stays', async () => {
      const bundle = await buildPricingBundle(lawnOnlyEstimate([
        // standard prices below the $50 floor → clamped → hidden
        { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
        // enhanced also floors, but it is the recommended (quoted) plan → stays
        { name: 'Enhanced', v: 9, mo: 45, ann: 540, pa: 60, recommended: true },
        { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
      ], { monthly: 50 }));
      expect(bundle.frequencies.map((f) => f.key)).toEqual(['enhanced', 'premium']);
      expect(bundle.frequencies[0].monthly).toBe(50); // recommended, floor-clamped
      expect(bundle.frequencies[1].monthly).toBe(60);
    });

    test('when every tier floors, the stored (quoted) tier survives', async () => {
      // The estimate's recurring lawn row is 9 visits (enhanced) — that quoted
      // tier is protected even when everything floors, so the customer keeps
      // seeing the plan they were sold.
      const bundle = await buildPricingBundle(lawnOnlyEstimate([
        { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
        { name: 'Enhanced', v: 9, mo: 45, ann: 540, pa: 60 },
        { name: 'Premium', v: 12, mo: 48, ann: 576, pa: 48 },
      ], { monthly: 50 }));
      expect(bundle.frequencies.map((f) => f.key)).toEqual(['enhanced']);
      expect(bundle.frequencies[0].monthly).toBe(50);
      expect(bundle.frequencies[0].visitsPerYear).toBe(9);
    });

    test('flag-less frozen ladder: the stored at-floor tier is protected from the hide', async () => {
      // No recommended/selected flags anywhere (frozen pre-deploy shape) and the
      // stored recurring lawn row is the at-floor 6-visit standard tier — it must
      // stay visible (hiding it would silently re-price the quoted plan), while
      // nothing else is dropped because the other tiers price above the floor.
      const estimate = lawnOnlyEstimate([
        { name: 'Standard', v: 6, mo: 45, ann: 540, pa: 90 },
        { name: 'Enhanced', v: 9, mo: 58, ann: 696, pa: 77.33 },
        { name: 'Premium', v: 12, mo: 79, ann: 948, pa: 79 },
      ], { monthly: 50 });
      estimate.estimate_data.result.recurring.services = [
        { name: 'Lawn Care', service: 'lawn_care', mo: 50, visitsPerYear: 6 },
      ];
      const bundle = await buildPricingBundle(estimate);
      expect(bundle.frequencies.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
      expect(bundle.frequencies[0].monthly).toBe(50); // clamped, quoted, visible
    });

    test('hidden tiers move to hiddenLawnFrequencies so accept can still resolve them', async () => {
      const bundle = await buildPricingBundle(lawnOnlyEstimate([
        { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
        { name: 'Enhanced', v: 9, mo: 45, ann: 540, pa: 60, recommended: true },
        { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
      ], { monthly: 50 }));
      expect(bundle.frequencies.map((f) => f.key)).toEqual(['enhanced', 'premium']);
      // The floored standard tier is hidden, not deleted — accept resolves a
      // stale pre-deploy selection from hiddenLawnFrequencies at its clamped price.
      expect(bundle.hiddenLawnFrequencies.map((f) => f.key)).toEqual(['standard']);
      expect(bundle.hiddenLawnFrequencies[0].monthly).toBe(50);
    });

    test('send-snapshot fast path (frozen pre-deploy, no floored flags) still hides floored tiers', async () => {
      // Snapshot entries predate flooredAtMinimum — the chokepoint recomputes
      // flooredness from the at-floor price itself.
      const bundle = await buildPricingBundle(snapshotEstimate());
      expect(bundle.snapshotHit).toBe(true); // prove the fast path served this, not a rebuild
      expect(bundle.frequencies.map((f) => f.key)).toEqual(['enhanced', 'premium']);
      expect((bundle.hiddenLawnFrequencies || []).map((f) => f.key)).toEqual(['standard']);
    });
  });
});

describe('section ladders stamp billedPerApplication (owner 2026-07-23: billing is always per application; estimator audit 2026-07-24)', () => {
  // Regression trap from PR #2965: the PriceCard "Billed $X/mo" note renders
  // for any per-app-headline frequency WITHOUT this flag, and the server only
  // stamped termite_bait — so every 4/6/9-visit lawn/T&S/mosquito tier
  // (monthly ≠ per-app) shipped a monthly-billing claim the converter
  // contradicts (billing_mode='per_application', plan annual ÷ visits).
  const TS_RESULT_STATS = {
    ts: [
      { name: 'Light', v: 4, mo: 30, ann: 360, pa: 90 },
      { name: 'Standard', v: 6, mo: 40, ann: 480, pa: 80 },
      { name: 'Enhanced', v: 9, mo: 68.6, ann: 823.2, pa: 91.47 },
    ],
  };

  test('tree & shrub ladder (incl. the 9x Enhanced upsell) flags every tier', () => {
    const ladder = bundleSectionLadderForService(
      'tree_shrub',
      { results: TS_RESULT_STATS },
      { name: 'Tree & Shrub', service: 'tree_shrub' },
      0,
    );
    expect(ladder.map((e) => e.key)).toEqual(['light', 'standard', 'enhanced']);
    for (const entry of ladder) {
      expect(entry.billedPerApplication).toBe(true);
    }
  });

  test('lawn ladder flags every tier — the 6/9-visit tiers are where a missing flag resurrects the note', () => {
    const ladder = bundleSectionLadderForService(
      'lawn_care',
      { results: LAWN_RESULT_STATS },
      { name: 'Lawn Care', service: 'lawn_care' },
      0,
    );
    expect(ladder.length).toBeGreaterThan(0);
    for (const entry of ladder) {
      expect(entry.billedPerApplication).toBe(true);
    }
  });

  test('mosquito ladder flags both tiers (seasonal9 is the monthly ≠ per-app case)', () => {
    const ladder = bundleSectionLadderForService(
      'mosquito',
      { results: { mq: LAWN_MQ_RESULT_STATS.mq } },
      { name: 'Mosquito Control', service: 'mosquito' },
      0,
    );
    expect(ladder.map((e) => e.key).sort()).toEqual(['monthly12', 'seasonal9']);
    for (const entry of ladder) {
      expect(entry.billedPerApplication).toBe(true);
    }
  });
});
