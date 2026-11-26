// Rodent exclusion two-story factor (owner 2026-11-26, "fix this"): the roof/high ("advanced") points of a home of two or
// more stories take RODENT.exclusionV2.modifiers.twoStory. Ground points, bird boxes, linear mesh, the barrel closure,
// the job floor and the inspection never take it. Every V2 exclusion row carries its own stamp (twoStoryRoofRule +
// twoStoryRoofFactor); a replay reads the stored rows: no stamp = priced before the rule = no factor, whatever the
// quote's legacyPricingRules stamp says (quotes stamped false were already sent without it).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { generateEstimate, priceRodentExclusionV2 } = require('../services/pricing-engine');
const { RODENT } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { twoStoryRoofReplaySignal } = require('../services/estimate-roof-style-replay');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { extractEngineInputs } = require('../routes/estimate-public');

const FACTOR = RODENT.exclusionV2.modifiers.twoStory;
const MIX = { standardWireMeshPoints: 8, advancedWireMeshPoints: 4, waiveInspection: true };
const ADV_ONLY = { advancedWireMeshPoints: 4, waiveInspection: true };
const baseInput = (overrides = {}) => ({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
  features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
  ...overrides,
});
const estimate = (exclusion, overrides = {}) => generateEstimate(baseInput({
  services: { exclusion: { pricingVersion: 'v2', ...exclusion } },
  ...overrides,
}));
const rows = (est) => est.lineItems.filter((li) => li.service === 'rodent_exclusion');
const total = (est) => Math.round(rows(est).reduce((sum, li) => sum + li.price, 0) * 100) / 100;
const row = (est, component) => rows(est).find((li) => li.component === component);

describe('priceRodentExclusionV2 two-story roof points', () => {
  test('the factor is the existing constant', () => {
    expect(FACTOR).toBe(1.3);
  });

  test('one story: the same price, and every row is stamped with the rule and factor 1', () => {
    const one = priceRodentExclusionV2({ ...MIX, stories: 1 });
    expect(one).toEqual(priceRodentExclusionV2(MIX));
    expect(one.price).toBe(8 * 75 + 4 * 150);
    expect(one.twoStoryRoofRule).toBe(1);
    expect(one.twoStoryRoofFactor).toBe(1);
    expect(one.lineItems.every((li) => li.twoStoryRoofRule === 1 && li.twoStoryRoofFactor === 1)).toBe(true);
  });

  test('two stories: only the advanced points rise', () => {
    const one = priceRodentExclusionV2({ ...MIX, stories: 1 });
    const two = priceRodentExclusionV2({ ...MIX, stories: 2 });
    expect(two.price).toBe(8 * 75 + 4 * 150 * 1.3);
    expect(two.price - one.price).toBe(4 * 150 * 0.3);
    expect(two.twoStoryRoofFactor).toBe(1.3);
    expect(two.lineItems.every((li) => li.twoStoryRoofRule === 1 && li.twoStoryRoofFactor === 1.3)).toBe(true);
    expect(two.detail).toBe(one.detail);
    expect(two.lineItems.find((r) => r.component === 'wire_mesh_points').detail).toContain('roof/high two-story @ $195.00/pt');
    expect(priceRodentExclusionV2({ ...MIX, stories: 3 }).price).toBe(two.price);
  });

  test('advanced points only: the factor applies to the whole price above the job floor', () => {
    expect(priceRodentExclusionV2({ ...ADV_ONLY, stories: 1 }).price).toBe(600);
    expect(priceRodentExclusionV2({ ...ADV_ONLY, stories: 2 }).price).toBe(780);
  });

  test('bird boxes, linear mesh, the job floor and the inspection never take it', () => {
    const extras = {
      standardBirdBoxes: 1, tileHighBirdBoxes: 1, customBirdBoxes: 1, meshSoftLF: 10, meshConcreteLF: 5,
    };
    const one = priceRodentExclusionV2({ ...extras, advancedWireMeshPoints: 1, stories: 1 });
    const two = priceRodentExclusionV2({ ...extras, advancedWireMeshPoints: 1, stories: 2 });
    expect(two.price - one.price).toBe(150 * 0.3);
    for (const component of ['bird_boxes', 'linear_mesh']) {
      expect(two.lineItems.find((r) => r.component === component).price)
        .toBe(one.lineItems.find((r) => r.component === component).price);
    }
    // Standard points only: nothing to multiply.
    expect(priceRodentExclusionV2({ standardWireMeshPoints: 12, stories: 2 }).price)
      .toBe(priceRodentExclusionV2({ standardWireMeshPoints: 12, stories: 1 }).price);
    // The job floor and a charged inspection stay as they were.
    const small = priceRodentExclusionV2({ advancedWireMeshPoints: 1, stories: 2 });
    expect(small.floor).toBe(priceRodentExclusionV2({ advancedWireMeshPoints: 1, stories: 1 }).floor);
    expect(small.inspectionFee).toBe(RODENT.inspection.fee);
  });

  test('it multiplies with a tile roof style, and not the barrel closure', () => {
    const tileOne = priceRodentExclusionV2({ ...ADV_ONLY, stories: 1, roofStyle: 'barrel_tile', barrelEaveFt: 40 });
    const tileTwo = priceRodentExclusionV2({ ...ADV_ONLY, stories: 2, roofStyle: 'barrel_tile', barrelEaveFt: 40 });
    const points = (r) => r.lineItems.find((li) => li.component === 'wire_mesh_points').price;
    expect(points(tileOne)).toBe(4 * 150 * 1.25);
    expect(points(tileTwo)).toBe(4 * 150 * 1.25 * 1.3);
    expect(tileTwo.lineItems.find((li) => li.component === 'barrel_eave_closure').price)
      .toBe(tileOne.lineItems.find((li) => li.component === 'barrel_eave_closure').price);
  });

  test('a frozen factor from a stored row wins over the live constant and over the story count', () => {
    expect(priceRodentExclusionV2({ ...MIX, stories: 2, frozenTwoStoryFactor: 1 }).price).toBe(priceRodentExclusionV2({ ...MIX, stories: 1 }).price);
    expect(priceRodentExclusionV2({ ...MIX, stories: 2, frozenTwoStoryFactor: 1.5 }).price).toBe(8 * 75 + 4 * 150 * 1.5);
    expect(priceRodentExclusionV2({ ...MIX, stories: 1, frozenTwoStoryFactor: 1.5 }).price).toBe(8 * 75 + 4 * 150 * 1.5);
    expect(priceRodentExclusionV2({ ...MIX, frozenTwoStoryFactor: 1.5 }).price).toBe(8 * 75 + 4 * 150 * 1.5);
    expect(priceRodentExclusionV2({ ...MIX, stories: 1, frozenTwoStoryFactor: 1 }).price).toBe(8 * 75 + 4 * 150);
  });
});

describe('estimate engine: stories reach the exclusion pricer', () => {
  test('profile stories decide it, and a one-story home is unchanged', () => {
    expect(total(estimate(MIX, { stories: 1 }))).toBe(8 * 75 + 4 * 150);
    expect(total(estimate(MIX, { stories: 2 }))).toBe(8 * 75 + 4 * 150 * 1.3);
    expect(total(estimate(ADV_ONLY, { stories: 2 }))).toBe(780);
  });

  test('an exclusion that names its own stories wins over the profile', () => {
    expect(total(estimate({ ...ADV_ONLY, stories: 2 }, { stories: 1 }))).toBe(780);
  });

  test('a whole-home seal prices the same two-story rise on the points', () => {
    const gate = process.env.GATE_EXCLUSION_WHOLE_HOME;
    process.env.GATE_EXCLUSION_WHOLE_HOME = 'true';
    try {
      const whole = (stories) => estimate({ ...MIX, sealScope: 'whole_home', homeSqFt: 4000 }, { stories, homeSqFt: 4000 });
      const one = whole(1);
      const two = whole(2);
      // The 4,000 sq ft home minimum lifts both totals; the points row itself carries the factor.
      expect(row(one, 'wire_mesh_points').price).toBe(8 * 75 + 4 * 150);
      expect(row(two, 'wire_mesh_points').price).toBe(8 * 75 + 4 * 150 * 1.3);
      expect(total(two)).toBeGreaterThanOrEqual(total(one));
    } finally {
      if (gate === undefined) delete process.env.GATE_EXCLUSION_WHOLE_HOME;
      else process.env.GATE_EXCLUSION_WHOLE_HOME = gate;
    }
  });
});

describe('public price range note', () => {
  test('the exclusion range names the two-story rise on the roof points', () => {
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const row = computePublicPricingRanges({ refresh: true }).services.find((r) => r.key === 'rodent_exclusion');
    expect(row.notes).toContain('advanced/roof point $150, plus 30% on a two-story home');
  });
});

describe('replay: each stored exclusion row decides the factor', () => {
  const stripRule = (rowsIn) => rowsIn.map(({ twoStoryRoofRule: _r, twoStoryRoofFactor: _f, ...rest }) => rest);
  // A quote sold BEFORE this change on a two-story home: priced without the factor, so no row carries the stamp, and its
  // engine already wrote pricingMetadata.legacyPricingRules = false (the #8604 rules were live).
  function preChangeQuote() {
    const priced = estimate(ADV_ONLY, { stories: 1 });
    expect(priced.pricingMetadata.legacyPricingRules).toBe(false);
    priced.lineItems = priced.lineItems.map((li) => (li.service === 'rodent_exclusion' ? stripRule([li])[0] : li));
    return {
      engineInputs: baseInput({ stories: 2, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } }),
      engineResult: priced,
      result: mapV1ToLegacyShape(priced),
    };
  }
  const freshQuote = () => {
    const priced = estimate(ADV_ONLY, { stories: 2 });
    return {
      engineInputs: baseInput({ stories: 2, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } }),
      engineResult: priced,
      result: mapV1ToLegacyShape(priced),
    };
  };
  const publicReplayTotal = (saved) => total(generateEstimate(extractEngineInputs(saved)));

  test('a pre-change quote stamped legacyPricingRules=false replays at $600, not $780', () => {
    const saved = preChangeQuote();
    expect(total(saved.engineResult)).toBe(600);
    expect(twoStoryRoofReplaySignal(saved)).toEqual({ factor: 1 });
    expect(extractEngineInputs(saved).twoStoryRoofReplay).toEqual({ factor: 1 });
    expect(publicReplayTotal(saved)).toBe(600);
    // Edited-down to the raw row shapes too: engine lines only, mapped rows only.
    expect(twoStoryRoofReplaySignal({ engineResult: saved.engineResult })).toEqual({ factor: 1 });
    expect(twoStoryRoofReplaySignal({ result: saved.result })).toEqual({ factor: 1 });
  });

  test('a fresh two-story quote carries the stamp through the legacy mapper and replays at $780', () => {
    const saved = freshQuote();
    expect(total(saved.engineResult)).toBe(780);
    const mappedRows = [...(saved.result.oneTime.items || []), ...(saved.result.oneTime.specItems || [])].filter((r) => r.service === 'rodent_exclusion');
    expect(mappedRows.length).toBeGreaterThan(0);
    expect(mappedRows.every((r) => r.twoStoryRoofRule === 1 && r.twoStoryRoofFactor === 1.3)).toBe(true);
    for (const shape of [saved, { engineResult: saved.engineResult }, { result: saved.result }]) {
      expect(twoStoryRoofReplaySignal(shape)).toEqual({ factor: 1.3 });
    }
    expect(publicReplayTotal(saved)).toBe(780);
    // A later change of the live constant never moves it.
    const modifiers = RODENT.exclusionV2.modifiers;
    const prior = modifiers.twoStory;
    modifiers.twoStory = 1.5;
    try {
      expect(publicReplayTotal(saved)).toBe(780);
      expect(total(estimate(ADV_ONLY, { stories: 2 }))).toBe(4 * 150 * 1.5);
    } finally { modifiers.twoStory = prior; }
  });

  test('a one-story quote stamped factor 1 stays at factor 1 if stories are later edited to two', () => {
    const priced = estimate(ADV_ONLY, { stories: 1 });
    const saved = { engineInputs: baseInput({ stories: 2, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } }), engineResult: priced, result: mapV1ToLegacyShape(priced) };
    expect(publicReplayTotal(saved)).toBe(600);
  });

  test('a quote sold at 1.3 replays at $780 when its stories are later missing or edited to one', async () => {
    const saved = freshQuote();
    expect(total(saved.engineResult)).toBe(780);
    for (const stories of [1, undefined, null, 0]) {
      const edited = { ...saved, engineInputs: { ...saved.engineInputs, stories } };
      expect(publicReplayTotal(edited)).toBe(780);
    }
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    for (const stories of [1, undefined]) {
      const edited = { ...saved, engineInputs: { ...saved.engineInputs, stories } };
      const out = await serverRecomputeFromEstimateData(edited, { needsSync: () => false, replaySavedPricingKnobs: true });
      expect(total({ lineItems: out.rawEngineResult.lineItems })).toBe(780);
    }
    // Live pricing of the same one-story home stays $600.
    expect(total(estimate(ADV_ONLY, { stories: 1 }))).toBe(600);
  });

  // An issued estimate that kept only its inputs and a send snapshot (no result, no engineResult).
  const inputsOnly = (extra = {}) => ({
    engineInputs: baseInput({ stories: 2, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } }),
    sendSnapshot: { sentAt: '2026-11-20T15:00:00Z', pricingBundle: { oneTimeBreakdown: { items: [{ service: 'rodent_exclusion', price: 600 }] } } },
    ...extra,
  });
  // What the public route does before it rebuilds the pricing: drop the frozen bundle.
  const invalidated = (saved) => { const { pricingBundle: _b, ...rest } = saved.sendSnapshot; return { ...saved, sendSnapshot: rest }; };

  test('an issued inputs-only estimate sold at $600 replays at $600 after its snapshot is invalidated (public rebuild and recompute)', async () => {
    const saved = inputsOnly();
    expect(twoStoryRoofReplaySignal(saved)).toEqual({ factor: 1 });
    expect(twoStoryRoofReplaySignal(invalidated(saved))).toEqual({ factor: 1 });
    expect(publicReplayTotal(invalidated(saved))).toBe(600);
    expect(publicReplayTotal(saved)).toBe(600);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const out = await serverRecomputeFromEstimateData(invalidated(saved), { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(total({ lineItems: out.rawEngineResult.lineItems })).toBe(600);
  });

  test('every request carrier counts as asking for an exclusion', () => {
    const exclusionInputs = { services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } };
    for (const saved of [
      { engineRequest: { profile: {}, selectedServices: ['PEST', 'EXCLUSION'] } },
      { engineInputs: exclusionInputs },
      { inputs: exclusionInputs },
      { engineInput: exclusionInputs },
      { engineInputs: { services: { rodentExclusion: { pricingVersion: 'v2' } } } },
      { result: { inputs: exclusionInputs } },
      JSON.stringify({ engineInputs: exclusionInputs }),
    ]) expect(twoStoryRoofReplaySignal(saved)).toEqual({ factor: 1 });
  });

  test('a send snapshot that carries a stamped exclusion row restores its factor, an unstamped one replays factor 1', () => {
    const row = { service: 'rodent_exclusion', price: 780, twoStoryRoofRule: 1, twoStoryRoofFactor: 1.3 };
    const withBundle = (items) => ({ sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items } } } });
    expect(twoStoryRoofReplaySignal(withBundle([row]))).toEqual({ factor: 1.3 });
    expect(twoStoryRoofReplaySignal(withBundle([{ service: 'rodent_exclusion', price: 600 }]))).toEqual({ factor: 1 });
  });

  test('nothing asks for an exclusion: no signal', () => {
    expect(twoStoryRoofReplaySignal({ engineInputs: baseInput({ services: { flea: {} } }) })).toBeNull();
    expect(twoStoryRoofReplaySignal({ engineRequest: { profile: {}, selectedServices: ['PEST'] } })).toBeNull();
    expect(twoStoryRoofReplaySignal({})).toBeNull();
    expect(twoStoryRoofReplaySignal(null)).toBeNull();
  });

  test('no exclusion row stored: nothing is pinned and the current rule prices it', () => {
    expect(twoStoryRoofReplaySignal({ engineResult: { lineItems: [] } })).toBeNull();
    expect(twoStoryRoofReplaySignal({ engineResult: { lineItems: [{ service: 'flea_package', price: 300 }] } })).toBeNull();
  });

  test('a posted replay signal is never honored on a new quote and is stripped from bodies', () => {
    const posted = generateEstimate(baseInput({
      stories: 2, twoStoryRoofReplay: { factor: 1 }, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } },
    }));
    expect(total(posted)).toBe(780);
    // Even on a replay flag with a stored copy, the server signal replaces it (the key is always set, undefined when empty).
    expect(sanitizeClientIdentityFields({ twoStoryRoofReplay: { factor: 1 } })).toEqual({});
  });

  test('the authoritative recompute reads the stored rows the same way', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const recompute = async (saved) => {
      const out = await serverRecomputeFromEstimateData(saved, { needsSync: () => false, replaySavedPricingKnobs: true });
      expect(out.recomputed).toBe(true);
      return total({ lineItems: out.rawEngineResult.lineItems });
    };
    expect(await recompute(preChangeQuote())).toBe(600);
    expect(await recompute(freshQuote())).toBe(780);
    // A save path that is NOT a declared replay prices today's rule.
    const fresh = await serverRecomputeFromEstimateData(preChangeQuote(), { needsSync: () => false });
    expect(total({ lineItems: fresh.rawEngineResult.lineItems })).toBe(780);
  });
});
