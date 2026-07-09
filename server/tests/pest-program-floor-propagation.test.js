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
} = require('../routes/estimate-public');

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

  test('floor never lifts the pest price above its pre-discount figure', () => {
    // Corrupted/oversized floor metadata must clamp to the list price, not raise it.
    const v1 = floorPricedPlatinumV1({ withFloorMetadata: true });
    v1.pestTiers[0].floorMo = 999;
    v1.pestTiers[0].floorAnn = 11988;
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, nonPestTierBaseMap({}), {});
    const expected = Math.round((29.67 + (66.75 + 79 + 45) * 0.8) * 100) / 100;
    expect(entry.monthly).toBe(expected);
  });
});
