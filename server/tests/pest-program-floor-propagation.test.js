// Pest post-discount program floor — propagation into the stored v1 payload
// and the public estimator reprice (codex P1 on PR #2550).
//
// The engine caps the collected pest annual at floor × cadence (discount-
// engine.applyMarginGuard), but the customer link reprices the STORED payload:
// estimate-public shapeFromV1 re-applies the full WaveGuard percent to the
// pre-discount pestTiers rows. These tests pin the fix: tier rows carry
// programFloor* metadata (service-pricing → v1-legacy-mapper floorPa/floorAnn/
// floorMo), and shapeFromV1 clamps the discounted pest figures at the floor.
const {
  generateEstimate,
  constants,
} = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  nonPestTierBaseMap,
  comboPricingEntry,
  monthlyForRecurringParts,
  pestFloorMonthlyLift,
} = require('../routes/estimate-public');
const { normalizeClientPestFloorMetadata } = require('../services/admin-estimate-persistence');

const ORIGINAL_PEST_BASE = constants.PEST.base;
const ORIGINAL_PEST_FLOOR = constants.PEST.floor;
const ORIGINAL_ENFORCE_FLOOR = constants.PEST.enforceFloorPostDiscount;
afterEach(() => {
  constants.PEST.base = ORIGINAL_PEST_BASE;
  constants.PEST.floor = ORIGINAL_PEST_FLOOR;
  constants.PEST.enforceFloorPostDiscount = ORIGINAL_ENFORCE_FLOOR;
});

function platinumBundle() {
  return {
    property: { footprint: 2000 },
    services: { pest: { frequency: 'quarterly' }, lawn: true, mosquito: true, treeShrub: true },
  };
}

describe('program floor metadata on engine tier rows + legacy mapper', () => {
  test('every pest tier row carries the floor for ITS cadence (v1 curve)', () => {
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    const byFreq = Object.fromEntries(pest.tiers.map(t => [t.frequency, t]));
    // floor $89, per-visit basis rounded first: round(89 × mult) × visits.
    expect(byFreq.quarterly).toMatchObject({ programFloorPerVisit: 89, programFloorAnnual: 356, programFloorMonthly: 29.67 });
    expect(byFreq.bimonthly).toMatchObject({ programFloorPerVisit: 75.65, programFloorAnnual: 453.90, programFloorMonthly: 37.82 });
    expect(byFreq.monthly).toMatchObject({ programFloorPerVisit: 62.30, programFloorAnnual: 747.60, programFloorMonthly: 62.30 });
  });

  test('legacy mapper copies the floor onto pestTiers rows and the selected R.pest', () => {
    const est = generateEstimate(platinumBundle());
    const mapped = mapV1ToLegacyShape(est);
    const quarterly = mapped.results.pestTiers.find(t => t.label === 'Quarterly');
    expect(quarterly).toMatchObject({ floorPa: 89, floorAnn: 356, floorMo: 29.67 });
    const bimonthly = mapped.results.pestTiers.find(t => t.label === 'Bi-Monthly');
    expect(bimonthly).toMatchObject({ floorPa: 75.65, floorAnn: 453.90, floorMo: 37.82 });
    expect(mapped.results.pest).toMatchObject({ floorPa: 89, floorAnn: 356, floorMo: 29.67 });
  });

  test('kill switch off → no floor metadata emitted (new estimates reprice as before)', () => {
    constants.PEST.enforceFloorPostDiscount = false;
    const est = generateEstimate(platinumBundle());
    const pest = est.lineItems.find(i => i.service === 'pest_control');
    for (const t of pest.tiers) {
      expect(t.programFloorAnnual).toBeUndefined();
    }
    const mapped = mapV1ToLegacyShape(est);
    for (const t of mapped.results.pestTiers) {
      expect(t.floorAnn).toBeUndefined();
    }
  });
});

describe('shapeFromV1 public reprice honors the stored floor (via comboPricingEntry)', () => {
  const QUARTERLY = { key: 'quarterly', label: 'Quarterly' };

  // Platinum (4 qualifying services → 20%) with pest sitting exactly at the
  // quarterly floor: $89/visit, $356/yr, $29.67/mo.
  function floorPricedPlatinumV1({ withFloorMetadata }) {
    const floorFields = withFloorMetadata ? { floorPa: 89, floorAnn: 356, floorMo: 29.67 } : {};
    return {
      pestTiers: [
        { label: 'Quarterly', mo: 29.67, ann: 356, pa: 89, apps: 4, ...floorFields },
      ],
      services: [
        { name: 'Pest Control', service: 'pest_control', mo: 29.67, ann: 356, perTreatment: 89, visitsPerYear: 4 },
        { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 },
        { name: 'Mosquito Control', service: 'mosquito', mo: 79, ann: 948, perTreatment: 79, visitsPerYear: 12 },
        { name: 'Tree & Shrub', service: 'tree_shrub', mo: 45, ann: 540, perTreatment: 90, visitsPerYear: 6 },
      ],
      discount: 0.20,
      manualDiscount: null,
    };
  }

  test('pest holds the floor while the other services keep the full 20%', () => {
    const v1 = floorPricedPlatinumV1({ withFloorMetadata: true });
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    // pest clamps at 29.67 (NOT 29.67 × 0.8 = 23.74); lawn/mosquito/ts keep 20% off.
    const expected = Math.round((29.67 + (66.75 + 79 + 45) * 0.8) * 100) / 100;
    expect(entry.monthly).toBe(expected);
    expect(entry.annual).toBe(Math.round(expected * 12 * 100) / 100);
  });

  test('discounted per-treatment display price clamps at the per-visit floor', () => {
    const v1 = floorPricedPlatinumV1({ withFloorMetadata: true });
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    const pestRow = entry.perServiceTreatments.find(r => r.service === 'pest_control');
    expect(pestRow.perTreatment).toBe(89);
    expect(pestRow.displayPrice).toBe(89); // not 89 × 0.8 = 71.20
    const lawnRow = entry.perServiceTreatments.find(r => r.service === 'lawn_care');
    expect(lawnRow.displayPrice).toBe(Math.round(89 * 0.8 * 100) / 100);
  });

  test('legacy stored payloads without floor metadata reprice exactly as before', () => {
    const v1 = floorPricedPlatinumV1({ withFloorMetadata: false });
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    const expected = Math.round(((29.67 + 66.75 + 79 + 45) * 0.8) * 100) / 100;
    expect(entry.monthly).toBe(expected);
    const pestRow = entry.perServiceTreatments.find(r => r.service === 'pest_control');
    expect(pestRow.displayPrice).toBe(Math.round(89 * 0.8 * 100) / 100);
  });

  test('acceptance annual keeps the EXACT floor when the rounded monthly ×12 would shave it', () => {
    // Bimonthly at the $89 floor: floorAnn 453.90 but floorMo rounds to 37.82,
    // and 37.82 × 12 = 453.84 — six cents under the floor. The annual must be
    // rebuilt from the exact floor contribution (codex r2).
    const BIMONTHLY = { key: 'bimonthly', label: 'Bi-Monthly' };
    const v1 = {
      pestTiers: [
        { label: 'Bi-Monthly', mo: 37.82, ann: 453.90, pa: 75.65, apps: 6, floorPa: 75.65, floorAnn: 453.90, floorMo: 37.82 },
      ],
      services: [
        { name: 'Pest Control', service: 'pest_control', mo: 37.82, ann: 453.90, perTreatment: 75.65, visitsPerYear: 6 },
        { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 },
        { name: 'Mosquito Control', service: 'mosquito', mo: 79, ann: 948, perTreatment: 79, visitsPerYear: 12 },
        { name: 'Tree & Shrub', service: 'tree_shrub', mo: 45, ann: 540, perTreatment: 90, visitsPerYear: 6 },
      ],
      discount: 0.20,
      manualDiscount: null,
    };
    const entry = comboPricingEntry(v1, BIMONTHLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    // Display monthly uses the rounded floorMo; the billed annual carries the
    // exact 453.90 pest contribution: (453.90/12 + 152.60) × 12 = 2285.10.
    expect(entry.monthly).toBe(Math.round((37.82 + (66.75 + 79 + 45) * 0.8) * 100) / 100);
    expect(entry.annual).toBe(2285.10);
    expect(entry.annual).toBeGreaterThanOrEqual(453.90 + (66.75 + 79 + 45) * 0.8 * 12 - 1e-9);
  });

  test('floor never lifts the pest price above its pre-discount figure', () => {
    // Corrupted/oversized floor metadata must clamp to the list price, not raise it.
    const v1 = floorPricedPlatinumV1({ withFloorMetadata: true });
    v1.pestTiers[0].floorMo = 999;
    v1.pestTiers[0].floorAnn = 11988;
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    const expected = Math.round((29.67 + (66.75 + 79 + 45) * 0.8) * 100) / 100;
    expect(entry.monthly).toBe(expected);
    expect(entry.annual).toBe(Math.round((29.67 + (66.75 + 79 + 45) * 0.8) * 12 * 100) / 100);
  });
});

describe('pestFloorMonthlyLift — stored-payload repricers (select-tier / preferences / ladder)', () => {
  // Stored estimate_data shape: results.pest carries the selected cadence's
  // pre-discount monthly + the floor stamped by v1-legacy-mapper.
  const floorPricedEstData = {
    result: {
      results: {
        pest: { pa: 89, apps: 4, mo: 29.67, ann: 356, floorPa: 89, floorAnn: 356, floorMo: 29.67 },
      },
    },
  };
  const platinum = () => 0.20;

  test('gives back exactly the overshoot below the floor (exact floorAnn/12 basis)', () => {
    const lift = pestFloorMonthlyLift(floorPricedEstData, 'Platinum', platinum);
    // 356/12 − 29.67 × 0.8 = 29.6667 − 23.736
    expect(lift).toBeCloseTo(356 / 12 - 29.67 * 0.8, 6);
  });

  test('no lift at 0% discount, for legacy payloads, or when the discount stays above floor', () => {
    expect(pestFloorMonthlyLift(floorPricedEstData, 'Bronze', () => 0)).toBe(0);
    expect(pestFloorMonthlyLift({ result: { results: { pest: { mo: 29.67, ann: 356 } } } }, 'Platinum', platinum)).toBe(0);
    const aboveFloor = { result: { results: { pest: { mo: 39, ann: 468, floorAnn: 356, floorMo: 29.67 } } } };
    expect(pestFloorMonthlyLift(aboveFloor, 'Silver', () => 0.10)).toBe(0);
  });

  test('bimonthly lift annualizes to the EXACT floor despite the rounded stored monthly', () => {
    // The never-above-list cap must use the row's exact ann (453.90), not the
    // rounded mo (37.82) — min(floorAnn/12, mo) would re-shave the anchor-less
    // annual to 453.84 (codex r3).
    const estData = {
      result: {
        results: {
          pest: { pa: 75.65, apps: 6, mo: 37.82, ann: 453.90, floorPa: 75.65, floorAnn: 453.90, floorMo: 37.82 },
        },
      },
    };
    const lift = pestFloorMonthlyLift(estData, 'Platinum', platinum);
    // Collected pest monthly = mo × 0.8 + lift = exactly floorAnn/12.
    expect(37.82 * 0.8 + lift).toBeCloseTo(453.90 / 12, 9);
    expect((37.82 * 0.8 + lift) * 12).toBeCloseTo(453.90, 9);
  });

  test('monthlyForRecurringParts applies the lift before the manual/pref offs', () => {
    // Pest 29.67 + lawn/mosquito/ts 190.75, all WaveGuard-discountable.
    const parts = { discountableBaseMonthly: 220.42, nonDiscountableMonthly: 0 };
    const lift = pestFloorMonthlyLift(floorPricedEstData, 'Platinum', platinum);
    const total = monthlyForRecurringParts(parts, 'Platinum', 0, platinum, lift);
    // Pest holds the floor; the other services keep the full 20%.
    expect(total).toBe(Math.round((356 / 12 + 190.75 * 0.8) * 100) / 100);
    // Manual/pref offs still subtract after the lift (warn-only manual).
    expect(monthlyForRecurringParts(parts, 'Platinum', 10, platinum, lift)).toBe(Math.round((356 / 12 + 190.75 * 0.8 - 10) * 100) / 100);
  });
});

describe('normalizeClientPestFloorMetadata — server-authoritative restamp at save (client fallback)', () => {
  function clientStampedEstData() {
    // What the deprecated client engine persists: 89-literal floor fields.
    return {
      result: {
        results: {
          pestTiers: [
            { pa: 89, apps: 4, ann: 356, mo: 29.67, label: 'Quarterly', floorPa: 89, floorAnn: 356, floorMo: 29.67 },
            { pa: 75.65, apps: 6, ann: 453.90, mo: 37.82, label: 'Bi-Monthly', floorPa: 75.65, floorAnn: 453.90, floorMo: 37.82 },
            { pa: 62.30, apps: 12, ann: 747.60, mo: 62.30, label: 'Monthly', floorPa: 62.30, floorAnn: 747.60, floorMo: 62.30 },
          ],
          pest: { pa: 89, apps: 4, ann: 356, mo: 29.67, label: 'Quarterly', floorPa: 89, floorAnn: 356, floorMo: 29.67 },
        },
      },
    };
  }

  test('restamps the client 89-literal floors from the live DB-synced floor', () => {
    constants.PEST.floor = 79; // prod-style DB override
    const estData = clientStampedEstData();
    normalizeClientPestFloorMetadata(estData);
    const [q, b, m] = estData.result.results.pestTiers;
    // Per-visit basis rounded first: round(79 × fm) × visits (v1 curve).
    expect(q).toMatchObject({ floorPa: 79, floorAnn: 316 });
    expect(b).toMatchObject({ floorPa: 67.15, floorAnn: 402.90 });
    expect(m).toMatchObject({ floorPa: 55.30, floorAnn: 663.60 });
    expect(q.floorMo).toBe(Math.round((316 / 12) * 100) / 100);
    expect(estData.result.results.pest).toMatchObject({ floorPa: 79, floorAnn: 316 });
  });

  test('kill switch off strips the client-stamped floors entirely', () => {
    constants.PEST.enforceFloorPostDiscount = false;
    const estData = clientStampedEstData();
    normalizeClientPestFloorMetadata(estData);
    for (const row of [...estData.result.results.pestTiers, estData.result.results.pest]) {
      expect(row.floorPa).toBeUndefined();
      expect(row.floorAnn).toBeUndefined();
      expect(row.floorMo).toBeUndefined();
    }
  });

  test('unknown cadence rows are stripped, never guessed', () => {
    const estData = {
      result: { results: { pestTiers: [{ pa: 50, apps: 26, ann: 1300, mo: 108.33, floorPa: 89, floorAnn: 2314, floorMo: 192.83 }] } },
    };
    normalizeClientPestFloorMetadata(estData);
    const [row] = estData.result.results.pestTiers;
    expect(row.floorPa).toBeUndefined();
    expect(row.floorAnn).toBeUndefined();
    expect(row.floorMo).toBeUndefined();
  });

  test('no-op on payloads without pest results', () => {
    const estData = { result: { results: { lawn: [] } } };
    expect(() => normalizeClientPestFloorMetadata(estData)).not.toThrow();
    expect(() => normalizeClientPestFloorMetadata(null)).not.toThrow();
  });
});
