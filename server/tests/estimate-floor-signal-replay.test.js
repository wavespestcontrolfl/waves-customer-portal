/**
 * Saved floor-signal replay — the reader, and the parity that motivates it.
 *
 * The public read path (estimate-public savedFloorReplayOverrides) has threaded
 * the lawn cost floor, the lawn program minimum and the pest program floor into
 * every engine replay since #2827. serverRecomputeFromEstimateData's
 * replaySavedPricingKnobs branch did NOT, and it is the AUTHORITATIVE recompute
 * whose output callers persist — so it resolved those knobs from the live
 * globals and wrote them over the estimate's quote-time pricingMetadata stamps.
 * The next replay then read the overwritten stamps as the saved evidence.
 *
 * The parity block below is the regression guard for that; it fails on the code
 * that predates the shared module.
 */
const {
  rawEngineInputs,
  estimateLawnFloorArmed,
  lawnRowsShowFloorEnforcement,
  estimatePestFloorSignal,
  savedFloorReplaySignals,
} = require('../services/estimate-floor-signal-replay');

describe('savedFloorReplaySignals — tri-state', () => {
  it('threads an explicitly stamped ARMED estimate', () => {
    expect(savedFloorReplaySignals({
      result: { pricingMetadata: { lawnCostFloorArmed: true, pestProgramFloorArmed: true, pestProgramFloorPerVisit: 62.5 } },
    })).toEqual({
      useLawnCostFloor: true,
      pestProgramFloorArmed: true,
      pestProgramFloorPerVisit: 62.5,
    });
  });

  it('threads an explicitly stamped DISARMED estimate as false, not as absence', () => {
    // The distinction is load-bearing: `false` pins a quote that priced with the
    // floor off even after a global re-arm; absence would let it re-price.
    const signals = savedFloorReplaySignals({ result: { pricingMetadata: { lawnCostFloorArmed: false } } });
    expect(signals.useLawnCostFloor).toBe(false);
    expect('useLawnCostFloor' in signals).toBe(true);
  });

  it('injects NOTHING for a silent estimate (absence = replay live)', () => {
    expect(savedFloorReplaySignals({ result: {} })).toEqual({});
    expect(savedFloorReplaySignals({})).toEqual({});
  });

  it('arms from legacy stored-row enforcement evidence', () => {
    expect(savedFloorReplaySignals({
      result: { lineItems: [{ service: 'lawn_care', costFloorApplied: true }] },
    }).useLawnCostFloor).toBe(true);
  });

  it('does NOT arm from margin REPORTING fields, which ride every quote', () => {
    // The exact trap: minimumCollectedAnnualPrice / costFloorAnnual are present
    // on post-disarm quotes too, so treating them as evidence would silently
    // re-arm every new estimate.
    expect(savedFloorReplaySignals({
      result: { lineItems: [{ service: 'lawn_care', minimumCollectedAnnualPrice: 900, costFloorAnnual: 900 }] },
    })).toEqual({});
  });

  it('prefers the engineRequest option over stored inputs, and the stamp over both', () => {
    const withOption = { engineRequest: { options: { useLawnCostFloor: true } } };
    expect(estimateLawnFloorArmed(withOption)).toBe(true);
    const stampWins = { ...withOption, result: { pricingMetadata: { lawnCostFloorArmed: false } } };
    expect(estimateLawnFloorArmed(stampWins)).toBe(false);
  });
});

describe('the moved readers keep their contracts', () => {
  it('rawEngineInputs prefers engineInputs, falls back to inputs, else null', () => {
    expect(rawEngineInputs({ engineInputs: { a: 1 }, inputs: { b: 2 } })).toEqual({ a: 1 });
    expect(rawEngineInputs({ inputs: { b: 2 } })).toEqual({ b: 2 });
    expect(rawEngineInputs({})).toBeNull();
    expect(rawEngineInputs(null)).toBeNull();
  });

  it('lawnRowsShowFloorEnforcement counts only ENFORCEMENT stamps', () => {
    expect(lawnRowsShowFloorEnforcement([{ costFloorApplied: true }])).toBe(true);
    expect(lawnRowsShowFloorEnforcement([{ pricingSource: 'COST_FLOOR' }])).toBe(true);
    expect(lawnRowsShowFloorEnforcement([{ prov: { costFloorApplied: true } }])).toBe(true);
    expect(lawnRowsShowFloorEnforcement([{ minimumCollectedAnnualPrice: 900 }])).toBe(false);
    expect(lawnRowsShowFloorEnforcement([])).toBe(false);
  });

  it('estimatePestFloorSignal derives per-visit from client-fallback rows via the cadence discount', () => {
    // floorPa 510 at 6 apps ⇒ 510 / 0.85 = 600
    expect(estimatePestFloorSignal({
      result: { lineItems: [{ service: 'pest_control', floorPa: 510, apps: 6 }] },
    })).toEqual({ armed: true, perVisit: 600 });
    expect(estimatePestFloorSignal({ result: {} })).toEqual({ armed: null, perVisit: null });
  });
});

describe('replay PARITY — the read path and the authoritative recompute agree', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');

  // A quote that priced with the lawn cost floor ARMED and a pest program floor,
  // carrying the engine's own stamps. The live globals are irrelevant here: what
  // matters is that both replays hand the engine the same saved state.
  const stampedEstimate = () => ({
    engineInputs: { services: { lawn: { track: 'st_augustine' }, pest: { apps: 4, version: 'v1' } } },
    result: {
      pricingMetadata: {
        lawnCostFloorArmed: true,
        pestProgramFloorArmed: true,
        pestProgramFloorPerVisit: 62.5,
      },
    },
  });

  it('serverRecomputeFromEstimateData threads every saved floor signal the read path threads', async () => {
    const seen = [];
    await serverRecomputeFromEstimateData(stampedEstimate(), {
      replaySavedPricingKnobs: true,
      needsSync: () => false,
      syncConstantsFromDB: async () => {},
      generateEstimate: (input) => { seen.push(input); return { lineItems: [] }; },
      mapV1ToLegacyShape: () => ({ recurring: { services: [] } }),
      translateV2CallToV1Input: null,
    });

    expect(seen).toHaveLength(1);
    const threaded = seen[0];
    const expected = savedFloorReplaySignals(stampedEstimate());
    // Every signal the shared reader resolves reaches generateEstimate. Before
    // the shared module this branch injected only the tree-shrub knobs and the
    // commercial arming, so all three of these were undefined and the engine
    // resolved them from the live globals — then stamped the live state back
    // over the quote's own, permanently.
    for (const [key, value] of Object.entries(expected)) {
      expect(threaded[key]).toBe(value);
    }
    expect(threaded.useLawnCostFloor).toBe(true);
    expect(threaded.pestProgramFloorArmed).toBe(true);
    expect(threaded.pestProgramFloorPerVisit).toBe(62.5);
  });

  it('a silent estimate still injects nothing on the recompute path', async () => {
    const seen = [];
    await serverRecomputeFromEstimateData(
      { engineInputs: { services: { lawn: { track: 'st_augustine' } } }, result: {} },
      {
        replaySavedPricingKnobs: true,
        needsSync: () => false,
        syncConstantsFromDB: async () => {},
        generateEstimate: (input) => { seen.push(input); return { lineItems: [] }; },
        mapV1ToLegacyShape: () => ({ recurring: { services: [] } }),
        translateV2CallToV1Input: null,
      },
    );
    expect('useLawnCostFloor' in seen[0]).toBe(false);
    expect('pestProgramFloorArmed' in seen[0]).toBe(false);
  });

  it('does not thread saved knobs when the caller has NOT declared a persisted replay', async () => {
    // Browser-controlled estimateData on a create/revision save must never
    // override DB-authoritative config.
    const seen = [];
    await serverRecomputeFromEstimateData(stampedEstimate(), {
      needsSync: () => false,
      syncConstantsFromDB: async () => {},
      generateEstimate: (input) => { seen.push(input); return { lineItems: [] }; },
      mapV1ToLegacyShape: () => ({ recurring: { services: [] } }),
      translateV2CallToV1Input: null,
    });
    expect('useLawnCostFloor' in seen[0]).toBe(false);
  });
});
