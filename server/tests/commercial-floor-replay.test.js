/**
 * Commercial floor replay (codex #3432 r1 P0): the commercial account
 * minimums are disarmed for NEW pricing (owner 2026-08-17), but an
 * outstanding tokenized estimate quoted at the minimum must keep its quoted
 * price when its pricing bundle is rebuilt from engineInputs. Row evidence
 * (a stored commercial annual sitting exactly at its era's minimum) injects
 * commercialFloorsArmed into the replay inputs, re-arming the clamp for
 * that replay only.
 */

const {
  priceCommercialLawn,
  priceCommercialTreeShrub,
  priceCommercialPest,
  priceCommercialMosquito,
  priceCommercialTermiteBait,
  priceCommercialRodentBait,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { extractEngineInputs } = require('../routes/estimate-public');

describe('pricers re-arm the minimum under options.floorsArmed (replay only)', () => {
  test('each commercial pricer clamps a sub-minimum buildup when armed', () => {
    expect(priceCommercialLawn({ turfSf: 5000 }, { floorsArmed: true }).annual).toBe(1200);
    expect(priceCommercialTreeShrub({ bedArea: 200 }, { treeCount: 0, floorsArmed: true }).annual).toBe(900);
    expect(priceCommercialTermiteBait({ footprint: 10000, perimeter: 400 }, { floorsArmed: true }).annual).toBe(900);
    expect(priceCommercialRodentBait({ footprint: 10000 }, { floorsArmed: true }).annual).toBe(900);
    const pest = priceCommercialPest({ footprint: 3000 }, { pestVisits: 4, floorsArmed: true });
    expect(pest.annual).toBe(900);
    expect(pest.perApp).toBe(225);
    // Both snapshot variants clamp too — a legacy replay must never expose a
    // sub-quoted figure through the selector math.
    expect(pest.interiorOption.combined.annual).toBe(900);
    expect(pest.interiorOption.exteriorOnly.annual).toBe(900);
  });

  test('armed is a no-op above the minimum, and absent means disarmed', () => {
    // Above the floor the clamp never binds — armed and live agree.
    const bigArmed = priceCommercialPest({ footprint: 20000, perimeter: 600 }, { floorsArmed: true });
    expect(bigArmed.annual).toBe(3472.73);
    // Absent/false → the disarmed default prices the raw buildup.
    expect(priceCommercialLawn({ turfSf: 5000 }).annual).toBeCloseTo(1031.52, 2);
    expect(priceCommercialPest({ footprint: 3000 }, { pestVisits: 4 }).annual).toBeCloseTo(620.21, 2);
    // Mosquito above its $720 floor is identical either way.
    const prop = { lotSqFt: 8000, homeSqFt: 1500 };
    expect(priceCommercialMosquito(prop, { floorsArmed: true }).annual)
      .toBe(priceCommercialMosquito(prop, {}).annual);
  });
});

describe('extractEngineInputs injects commercialFloorsArmed from row evidence', () => {
  const LEGACY_INPUTS = {
    propertyType: 'commercial',
    isCommercial: true,
    footprintSqFt: 3000,
    commercialPestCadence: 'quarterly',
    services: { pest: {} },
  };

  test('a stored commercial row exactly at its era minimum re-arms the replay', () => {
    // Pre-disarm quote: the $900 floor bound ($225/application × 4).
    const estData = {
      engineInputs: LEGACY_INPUTS,
      engineResult: {
        lineItems: [{ service: 'commercial_pest', annual: 900, monthly: 75, perApp: 225, visitsPerYear: 4 }],
      },
    };
    const replayInputs = extractEngineInputs(estData);
    expect(replayInputs.commercialFloorsArmed).toBe(true);
    const replayed = generateEstimate(replayInputs).lineItems.find((l) => l.service === 'commercial_pest');
    // The replay reproduces the QUOTED price, not the disarmed buildup.
    expect(replayed.annual).toBe(900);
    expect(replayed.perApp).toBe(225);
  });

  test('mapped-shape row evidence (result.recurring.services) arms too', () => {
    const estData = {
      engineInputs: LEGACY_INPUTS,
      result: {
        recurring: { services: [{ name: 'Commercial Pest Control', service: 'commercial_pest', mo: 75, annual: 900, perTreatment: 225 }] },
      },
    };
    expect(extractEngineInputs(estData).commercialFloorsArmed).toBe(true);
  });

  test('a post-disarm estimate (sub-minimum stored annual) replays live — no injection', () => {
    const estData = {
      engineInputs: LEGACY_INPUTS,
      engineResult: {
        lineItems: [{ service: 'commercial_pest', annual: 629.53, monthly: 52.46, perApp: 157.38, visitsPerYear: 4 }],
      },
    };
    const replayInputs = extractEngineInputs(estData);
    expect(replayInputs.commercialFloorsArmed).toBeUndefined();
    const replayed = generateEstimate(replayInputs).lineItems.find((l) => l.service === 'commercial_pest');
    expect(replayed.annual).toBeCloseTo(629.53, 2);
  });

  test('an above-minimum legacy estimate replays live to the same price — no injection needed', () => {
    const estData = {
      engineInputs: { ...LEGACY_INPUTS, footprintSqFt: 20000, commercialPestCadence: '' },
      engineResult: {
        lineItems: [{ service: 'commercial_pest', annual: 3527.2, monthly: 293.93, perApp: 293.93, visitsPerYear: 12 }],
      },
    };
    const replayInputs = extractEngineInputs(estData);
    expect(replayInputs.commercialFloorsArmed).toBeUndefined();
    expect(generateEstimate(replayInputs).lineItems.find((l) => l.service === 'commercial_pest').annual).toBe(3527.2);
  });

  test('non-commercial rows never trigger the commercial signal', () => {
    const estData = {
      engineInputs: { propertyType: 'single_family', homeSqFt: 2000, lotSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
      result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 75, annual: 900 }] } },
    };
    expect(extractEngineInputs(estData).commercialFloorsArmed).toBeUndefined();
  });
});

// codex #3432 r2 P0: the AUTHORITATIVE recompute (membership-lapse
// reconciliation writes its result back over stored totals) replays the
// stored inputs without going through extractEngineInputs — the same row
// evidence must re-arm the floors there too.
describe('serverRecomputeFromEstimateData replays commercial floors (persisted-estimate replays)', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');

  const flooredEstimateData = () => ({
    engineInputs: {
      propertyType: 'commercial',
      isCommercial: true,
      footprintSqFt: 3000,
      commercialPestCadence: 'quarterly',
      services: { pest: {} },
    },
    engineResult: {
      lineItems: [{ service: 'commercial_pest', annual: 900, monthly: 75, perApp: 225, visitsPerYear: 4 }],
    },
  });

  test('declared persisted-estimate replay keeps the quoted floored price', async () => {
    const out = await serverRecomputeFromEstimateData(flooredEstimateData(), {
      replaySavedPricingKnobs: true,
      needsSync: () => false,
    });
    expect(out.recomputed).toBe(true);
    const row = out.serverResult.recurring.services.find((svc) => svc.service === 'commercial_pest');
    expect(row.annual).toBe(900);
  });

  test('a fresh (non-replay) recompute prices live — evidence not injected', async () => {
    const out = await serverRecomputeFromEstimateData(flooredEstimateData(), {
      needsSync: () => false,
    });
    expect(out.recomputed).toBe(true);
    const row = out.serverResult.recurring.services.find((svc) => svc.service === 'commercial_pest');
    expect(row.annual).toBeCloseTo(629.53, 2);
  });
});
