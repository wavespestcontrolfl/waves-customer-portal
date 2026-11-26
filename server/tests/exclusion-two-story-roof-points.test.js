// Rodent exclusion two-story factor (owner 2026-11-26, "fix this"): the roof/high ("advanced") points of a home of two or
// more stories take RODENT.exclusionV2.modifiers.twoStory. Ground points, bird boxes, linear mesh, the barrel closure,
// the job floor and the inspection never take it. A saved quote replays under the estimate-level rule stamp
// pricingMetadata.legacyTwoStoryRoof (estimate-floor-signal-replay.js readRuleStamp): a priced estimate with no stamp was
// priced before the rule and keeps its price, whatever its legacyPricingRules stamp says (quotes stamped false were already
// sent without the factor).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { generateEstimate, priceRodentExclusionV2 } = require('../services/pricing-engine');
const { RODENT } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { savedLegacyTwoStoryRoofSignal, savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { extractEngineInputs, invalidateSendSnapshotPricingBundle } = require('../routes/estimate-public');

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

  test('one story: the same price as no stories at all', () => {
    const one = priceRodentExclusionV2({ ...MIX, stories: 1 });
    expect(one).toEqual(priceRodentExclusionV2(MIX));
    expect(one.price).toBe(8 * 75 + 4 * 150);
  });

  test('two stories: only the advanced points rise', () => {
    const one = priceRodentExclusionV2({ ...MIX, stories: 1 });
    const two = priceRodentExclusionV2({ ...MIX, stories: 2 });
    expect(two.price).toBe(8 * 75 + 4 * 150 * 1.3);
    expect(two.price - one.price).toBe(4 * 150 * 0.3);
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

  test('the legacy flag (a quote priced before the rule) drops the factor', () => {
    expect(priceRodentExclusionV2({ ...MIX, stories: 2, legacyTwoStory: true })).toEqual(priceRodentExclusionV2({ ...MIX, stories: 1 }));
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

describe('replay: the estimate-level rule stamp decides the factor', () => {
  const REQUEST = () => baseInput({ stories: 2, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } });
  // Every place the stamp lives (metadata, routing metadata, lines, mapped rows): a quote priced before the rule has none.
  const strip = (value) => JSON.parse(JSON.stringify(value), (key, v) => (key === 'legacyTwoStoryRoof' ? undefined : v));
  // A quote sold BEFORE this change on a two-story home: priced without the factor, so it carries no two-story stamp, and
  // the engine had already written legacyPricingRules = false (the seven fixes were live).
  function preChangeQuote() {
    const priced = estimate(ADV_ONLY, { stories: 1 });
    expect(priced.pricingMetadata.legacyPricingRules).toBe(false);
    return { engineInputs: REQUEST(), engineResult: strip(priced), result: strip(mapV1ToLegacyShape(priced)) };
  }
  const freshQuote = () => {
    const priced = estimate(ADV_ONLY, { stories: 2 });
    return { engineInputs: REQUEST(), engineResult: priced, result: mapV1ToLegacyShape(priced) };
  };
  const publicReplayTotal = (saved) => total(generateEstimate(extractEngineInputs(saved)));
  const recomputeTotal = async (saved) => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const out = await serverRecomputeFromEstimateData(saved, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(out.recomputed).toBe(true);
    return total({ lineItems: out.rawEngineResult.lineItems });
  };

  test('every fresh run stamps the metadata and the exclusion lines', () => {
    const one = estimate(ADV_ONLY, { stories: 1 });
    const two = freshQuote().engineResult;
    expect(one.pricingMetadata.legacyTwoStoryRoof).toBe(false);
    expect(two.pricingMetadata.legacyTwoStoryRoof).toBe(false);
    expect(rows(two).every((li) => li.legacyTwoStoryRoof === false)).toBe(true);
    const legacy = estimate(ADV_ONLY, { stories: 2, legacyTwoStoryRoof: true });
    expect(legacy.pricingMetadata.legacyTwoStoryRoof).toBe(true);
    expect(total(legacy)).toBe(600);
  });

  test('a pre-change quote stamped legacyPricingRules=false replays at $600, public and authoritative', async () => {
    const saved = preChangeQuote();
    expect(total(saved.engineResult)).toBe(600);
    expect(savedLegacyTwoStoryRoofSignal(saved)).toEqual({ legacyTwoStoryRoof: true });
    expect(savedFloorReplaySignals(saved)).toMatchObject({ legacyPricingRules: false, legacyTwoStoryRoof: true });
    expect(extractEngineInputs(saved).legacyTwoStoryRoof).toBe(true);
    expect(publicReplayTotal(saved)).toBe(600);
    expect(await recomputeTotal(saved)).toBe(600);
    for (const shape of [{ engineResult: saved.engineResult }, { result: saved.result }]) {
      expect(savedLegacyTwoStoryRoofSignal(shape)).toEqual({ legacyTwoStoryRoof: true });
    }
  });

  test('a fresh two-story quote replays at $780, public and authoritative, and its stamp survives a stale posted value', async () => {
    const saved = freshQuote();
    expect(total(saved.engineResult)).toBe(780);
    expect(savedLegacyTwoStoryRoofSignal(saved)).toEqual({ legacyTwoStoryRoof: false });
    expect(publicReplayTotal(saved)).toBe(780);
    expect(await recomputeTotal(saved)).toBe(780);
    // A value posted inside the stored inputs never switches the rule (the server-derived key is always set).
    const forged = { ...saved, engineInputs: { ...saved.engineInputs, legacyTwoStoryRoof: true } };
    expect(publicReplayTotal(forged)).toBe(780);
    expect(sanitizeClientIdentityFields({ legacyTwoStoryRoof: true })).toEqual({});
    // And a posted flag never freezes a NEW quote.
    expect(total(generateEstimate(baseInput({ stories: 2, legacyTwoStoryRoof: undefined, services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } })))).toBe(780);
  });

  test('a snapshot-only quote keeps its sold price after its pricing bundle is invalidated', async () => {
    const bundle = (price) => ({ oneTimeBreakdown: { items: [{ service: 'rodent_exclusion', price }] } });
    // The public route's own invalidation (a tier change drops the bundle and rebuilds pricing from the inputs).
    const invalidated = (saved) => { const copy = JSON.parse(JSON.stringify(saved)); invalidateSendSnapshotPricingBundle(copy); return copy; };
    // Sold before the rule: the bundle prices it and no stamp exists anywhere; the invalidation freezes it first.
    const before = { engineInputs: REQUEST(), sendSnapshot: { pricingBundle: bundle(600) } };
    expect(savedLegacyTwoStoryRoofSignal(before)).toEqual({ legacyTwoStoryRoof: true });
    expect(invalidated(before).sendSnapshot).toEqual({ legacyTwoStoryRoof: true });
    expect(publicReplayTotal(invalidated(before))).toBe(600);
    expect(await recomputeTotal(invalidated(before))).toBe(600);
    // Sold under the rule: the snapshot builder froze the stamp (buildEstimateSendSnapshot), so the bundle can go.
    const after = { engineInputs: REQUEST(), sendSnapshot: { legacyTwoStoryRoof: false, pricingBundle: bundle(780) } };
    expect(savedLegacyTwoStoryRoofSignal(after)).toEqual({ legacyTwoStoryRoof: false });
    expect(publicReplayTotal(invalidated(after))).toBe(780);
    expect(await recomputeTotal(invalidated(after))).toBe(780);
  });

  test('an issued inputs-only estimate (no rows, no stamp, no bundle) replays at $600; an unsent draft and a fresh quote stay on $780', async () => {
    const inputsOnly = () => ({ engineInputs: REQUEST() });
    // Issued (no never-issued mark): sold before the rule, so the replay never raises it.
    expect(savedLegacyTwoStoryRoofSignal(inputsOnly())).toEqual({ legacyTwoStoryRoof: undefined });
    expect(savedFloorReplaySignals(inputsOnly()).legacyTwoStoryRoof).toBe(true);
    expect(extractEngineInputs(inputsOnly()).legacyTwoStoryRoof).toBe(true);
    expect(publicReplayTotal(inputsOnly())).toBe(600);
    expect(await recomputeTotal(inputsOnly())).toBe(600);
    // Every request carrier counts, and a request with no exclusion pins nothing.
    const exclusionInputs = { services: { exclusion: { pricingVersion: 'v2', ...ADV_ONLY } } };
    for (const saved of [
      { inputs: exclusionInputs }, { engineInput: exclusionInputs }, { result: { inputs: exclusionInputs } },
      { engineRequest: { profile: {}, selectedServices: ['PEST', 'EXCLUSION'] } },
      { engineInputs: { services: { rodentExclusion: { pricingVersion: 'v2' } } } },
      JSON.stringify({ engineInputs: exclusionInputs }),
    ]) expect(savedFloorReplaySignals(saved).legacyTwoStoryRoof).toBe(true);
    expect(savedFloorReplaySignals({ engineInputs: baseInput({ services: { flea: {} } }) }).legacyTwoStoryRoof).toBeUndefined();
    expect(savedFloorReplaySignals({ engineRequest: { profile: {}, selectedServices: ['PEST'] } }).legacyTwoStoryRoof).toBeUndefined();
    // A draft the caller marked never-issued is not sold: current rule, $780.
    const draft = inputsOnly();
    draft[Symbol.for('waves.estimate.neverIssued')] = true;
    expect(savedFloorReplaySignals(draft).legacyTwoStoryRoof).toBeUndefined();
    expect(publicReplayTotal(draft)).toBe(780);
    // A fresh unsent quote (stamped false by the engine) is untouched by the fallback.
    expect(publicReplayTotal(freshQuote())).toBe(780);
    // The first send of an inputs-only draft reads the plain stamp (no fallback), so its snapshot prices on the current rule.
    expect(savedLegacyTwoStoryRoofSignal(inputsOnly())).toEqual({ legacyTwoStoryRoof: undefined });
  });

  test('the send-snapshot builder freezes the stamp beside the bundle', () => {
    const fs = require('fs');
    const route = fs.readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    expect(route).toContain('savedLegacyTwoStoryRoofSignal(estimateData).legacyTwoStoryRoof');
    expect(route).toContain('sendSnapshot.legacyTwoStoryRoof = priorTwoStory === true;');
  });

  test('stories edited from 2 to 1 on a fresh quote: the replay prices the stored inputs (a stories edit is a scope edit)', async () => {
    // Decision: the factor follows the stories of the inputs being priced, like every other stories-driven price (the rodent
    // guarantee tier, the whole-home minimum). The stamp only says WHICH RULE; it does not freeze the story count. The staff
    // editor re-prices live when stories change, so an edit to 1 story re-prices at $600.
    const saved = freshQuote();
    const edited = { ...saved, engineInputs: { ...saved.engineInputs, stories: 1 } };
    expect(publicReplayTotal(edited)).toBe(600);
    expect(await recomputeTotal(edited)).toBe(600);
  });

  test('the add-service rail and the compaction paths carry the stamp', () => {
    const fs = require('fs');
    const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
    expect(read('../services/estimate-add-service-request')).toContain("'legacyTwoStoryRoof'");
    expect(read('../services/rate-review')).toContain("'legacyTwoStoryRoof'");
    expect(read('../routes/public-quote')).toContain('legacyTwoStoryRoof: estimate.pricingMetadata.legacyTwoStoryRoof');
    expect(read('../services/lead-estimate-automation')).toContain('legacyTwoStoryRoof: estimate.pricingMetadata.legacyTwoStoryRoof');
  });
});
