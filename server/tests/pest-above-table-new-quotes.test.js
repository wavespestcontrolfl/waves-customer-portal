/**
 * Recurring pest above the 5,500 sq ft footprint table, NEW quotes only (owner 2026-11-26): +$8 per visit at quarterly for each
 * 1,000 sq ft above 5,500, pro-rated, no cap (8,000 = $148, 10,000 = $164). Bi-monthly, monthly and one-time pest follow.
 * A quote saved before the rule (stamped legacy, unstamped, or inputs-only requesting pest) runs main's flat code and gets main's
 * exact output. Regressions it guards: a sent quote rising when the rule ships; an old quote read as new (or the reverse) for lack of
 * a stamp on any save shape (snapshot only, mapped result, resend, add-service); a Settings edit moving the price; the client
 * fallback disagreeing with the server.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { pricePestControl, priceOneTimePest } = require('../services/pricing-engine/service-pricing');
const replay = require('../services/estimate-floor-signal-replay');
const { extractEngineInputs } = require('../routes/estimate-public');
const { buildEstimateServiceRevisionDraft } = require('../services/estimate-add-service-request');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');

const { PEST } = constants;
const line = (result, service) => result.lineItems.find((l) => l.service === service);
const run = (homeSqFt, services, extra = {}) => generateEstimate({
  homeSqFt, lotSqFt: 9000, stories: 1, yearBuilt: 2021, services, ...extra,
});
const plan = (homeSqFt, frequency, extra) => line(run(homeSqFt, { pest: { frequency } }, extra), 'pest_control');

// [home sq ft, frequency, basePrice, perApp, annual]: computed by running these same inputs through origin/main's engine
// (6c8f04ed81) before this change. Above 5,500 main is flat at $128.
const MAIN_PLAN = [
  [5000, 'quarterly', 126, 126, 504], [5000, 'bimonthly', 126, 110.88, 665.28], [5000, 'monthly', 126, 98.28, 1179.36],
  [5500, 'quarterly', 128, 128, 512], [5500, 'bimonthly', 128, 112.64, 675.84], [5500, 'monthly', 128, 99.84, 1198.08],
  [6000, 'quarterly', 128, 128, 512], [6000, 'bimonthly', 128, 112.64, 675.84], [6000, 'monthly', 128, 99.84, 1198.08],
  [7000, 'quarterly', 128, 128, 512], [7000, 'bimonthly', 128, 112.64, 675.84], [7000, 'monthly', 128, 99.84, 1198.08],
  [8000, 'quarterly', 128, 128, 512], [8000, 'bimonthly', 128, 112.64, 675.84], [8000, 'monthly', 128, 99.84, 1198.08],
  [10000, 'quarterly', 128, 128, 512], [10000, 'bimonthly', 128, 112.64, 675.84], [10000, 'monthly', 128, 99.84, 1198.08],
  [12000, 'quarterly', 128, 128, 512], [12000, 'bimonthly', 128, 112.64, 675.84], [12000, 'monthly', 128, 99.84, 1198.08],
  [15000, 'quarterly', 128, 128, 512], [15000, 'bimonthly', 128, 112.64, 675.84], [15000, 'monthly', 128, 99.84, 1198.08],
];
// [home sq ft, one-time beside a plan, stand-alone one-time]: same origin/main run (the visit anchors on the quarterly).
const MAIN_ONE_TIME = [[5000, 226, 248], [5500, 228, 250], [6000, 228, 250], [8000, 228, 250], [10000, 228, 250], [15000, 228, 250]];

// The new table, hand-derived from the rule: 112 base + round(16 + 8 x (sqft - 5500) / 1000), then the v2 cadence multipliers.
const FRESH_QUARTERLY = { 5000: 126, 5500: 128, 6000: 132, 7000: 140, 8000: 148, 10000: 164, 12000: 180, 15000: 204 };

describe('a fresh quote keeps rising above 5,500 sq ft', () => {
  test.each(Object.entries(FRESH_QUARTERLY))('%i sq ft quarterly = $%i, and the engine stamps the new rule', (sqft, expected) => {
    const r = run(Number(sqft), { pest: { frequency: 'quarterly' } });
    expect(line(r, 'pest_control').basePrice).toBe(expected);
    expect(r.pricingMetadata.legacyPestAboveTable).toBe(false);
    expect(line(r, 'pest_control').legacyPestAboveTable).toBe(false);
  });

  test('owner examples: 8,000 sq ft = $148 and 10,000 = $164, pro-rated to the square foot with no cap', () => {
    expect(plan(8000, 'quarterly').basePrice).toBe(148);
    expect(plan(10000, 'quarterly').basePrice).toBe(164);
    // Pro-rated: 6,750 sq ft = 16 + 10 = $26 over base; 6,625 = 16 + 9 = $25, rounded like the table.
    expect(plan(6750, 'quarterly').basePrice).toBe(138);
    expect(plan(6625, 'quarterly').basePrice).toBe(137);
    expect(plan(6560, 'quarterly').basePrice).toBe(136); // 16 + 8.48 = 24.48 rounds to 24
    expect(plan(40000, 'quarterly').basePrice).toBe(112 + 16 + 276);
  });

  test.each([5000, 5500, 6000, 8000, 10000, 15000])('%i sq ft: bimonthly and monthly follow quarterly through the cadence ratios', (sqft) => {
    const q = plan(sqft, 'quarterly').basePrice;
    const bi = plan(sqft, 'bimonthly');
    const mo = plan(sqft, 'monthly');
    expect(bi.basePrice).toBe(q);
    expect(mo.basePrice).toBe(q);
    expect(bi.perApp).toBe(Math.round(q * PEST.frequencyDiscounts.v2.bimonthly * 100) / 100);
    expect(mo.perApp).toBe(Math.round(q * PEST.frequencyDiscounts.v2.monthly * 100) / 100);
  });

  test('one-time pest follows the quarterly price (beside a plan and stand-alone); at or below 5,500 it is main\'s number', () => {
    for (const [sqft, , solo] of MAIN_ONE_TIME) {
      const beside = line(run(sqft, { pest: { frequency: 'quarterly' }, oneTimePest: {} }), 'one_time_pest').price;
      const alone = line(run(sqft, { oneTimePest: {} }), 'one_time_pest').price;
      const q = FRESH_QUARTERLY[sqft];
      // Beside a plan the visit anchors on the quarterly and stays strictly above visit 1 (quarterly + $99 setup).
      expect(beside).toBeGreaterThan(q + 99);
      if (sqft <= 5500) expect([beside, alone]).toEqual([MAIN_ONE_TIME.find((r) => r[0] === sqft)[1], solo]);
      else {
        expect(beside).toBeGreaterThan(228);
        expect(alone).toBeGreaterThan(solo);
        // Beside a plan and alone it is the same quarterly anchor: the stand-alone visit is the plan's quarterly with no perk.
        expect(alone).toBe(Math.max(199, Math.round(q * 1.8), Math.round(Math.round((q + 99) * 1.1 * 100) / 100)));
      }
    }
    expect(line(run(10000, { pest: { frequency: 'quarterly' }, oneTimePest: {} }), 'one_time_pest').legacyPestAboveTable).toBe(false);
  });

  test('the $4 is a code constant: a Settings-shaped edit of the footprint table never moves the step', () => {
    expect(PEST.aboveTablePer1000).toBe(8);
    const before = PEST.footprintBrackets.map((b) => ({ ...b }));
    try {
      PEST.footprintBrackets[PEST.footprintBrackets.length - 1].adj = 20;
      // The table's last row moves; the step above it keeps its own $8 per 1,000 sq ft from that row.
      expect(plan(8000, 'quarterly').basePrice).toBe(112 + 20 + 20);
    } finally {
      PEST.footprintBrackets.splice(0, PEST.footprintBrackets.length, ...before);
    }
    expect(plan(8000, 'quarterly').basePrice).toBe(148);
  });

  test('a Settings edit moving the last bracket moves the table price as on main, never the premium (new quote and replay of a new quote)', () => {
    expect(PEST.aboveTableStartSqFt).toBe(5500);
    const before = PEST.footprintBrackets.map((b) => ({ ...b }));
    const premium8000 = 20; // 8 x (8000 - 5500) / 1000
    try {
      // The last bracket moves up to 6,500 and out to +$16 still: the table is flat to 6,500 and the premium still starts at 5,500.
      PEST.footprintBrackets[PEST.footprintBrackets.length - 1].sqft = 6500;
      expect(plan(8000, 'quarterly').basePrice).toBe(112 + 16 + premium8000);
      // The last bracket moves DOWN to 4,500: the premium still starts at 5,500, not at the table's end.
      PEST.footprintBrackets[PEST.footprintBrackets.length - 1].sqft = 4500;
      expect(plan(5000, 'quarterly').basePrice).toBe(112 + 16);
      expect(plan(8000, 'quarterly').basePrice).toBe(112 + 16 + premium8000);
      // A replay of a quote stamped new keeps the same premium after the edit.
      const replayed = run(8000, { pest: { frequency: 'quarterly' } }, { savedEstimateReplay: true, legacyPestAboveTable: false });
      expect(line(replayed, 'pest_control').basePrice).toBe(112 + 16 + premium8000);
    } finally {
      PEST.footprintBrackets.splice(0, PEST.footprintBrackets.length, ...before);
    }
    expect(plan(8000, 'quarterly').basePrice).toBe(148);
  });

  test('a bedroom-band (unit) estimate is untouched by the footprint rule', () => {
    const direct = pricePestControl({ footprint: 9000 }, { frequency: 'quarterly' });
    expect(direct.basePrice).toBe(112 + 16 + 28);
    expect(pricePestControl({ footprint: 9000 }, { frequency: 'quarterly', legacyPestAboveTable: true }).basePrice).toBe(128);
    expect(priceOneTimePest({ footprint: 9000 }, {}).price).toBeGreaterThan(priceOneTimePest({ footprint: 9000 }, { legacyPestAboveTable: true }).price);
  });
});

describe('a quote saved before the rule gets main\'s exact output', () => {
  test.each(MAIN_PLAN)('stamped legacy: %i sq ft %s = main (basePrice %d, perApp %d, annual %d)', (sqft, freq, base, perApp, annual) => {
    const r = run(sqft, { pest: { frequency: freq } }, { savedEstimateReplay: true, legacyPestAboveTable: true });
    expect(line(r, 'pest_control')).toMatchObject({ basePrice: base, perApp, annual });
    expect(r.pricingMetadata.legacyPestAboveTable).toBe(true);
    expect(line(r, 'pest_control').legacyPestAboveTable).toBe(true);
  });

  test.each(MAIN_ONE_TIME)('stamped legacy one-time at %i sq ft: beside a plan $%d, alone $%d (main)', (sqft, beside, alone) => {
    const extra = { savedEstimateReplay: true, legacyPestAboveTable: true };
    expect(line(run(sqft, { pest: { frequency: 'quarterly' }, oneTimePest: {} }, extra), 'one_time_pest').price).toBe(beside);
    expect(line(run(sqft, { oneTimePest: {} }, extra), 'one_time_pest').price).toBe(alone);
  });

  test('an unstamped priced estimate replays main\'s price through the real signal reader', () => {
    const sold = { engineResult: { lineItems: [{ service: 'pest_control', basePrice: 128, annual: 512, perApp: 128 }] },
      engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, yearBuilt: 2021, services: { pest: { frequency: 'quarterly' } } } };
    expect(replay.savedLegacyPestAboveTableSignal(sold)).toEqual({ legacyPestAboveTable: true });
    expect(replay.savedFloorReplaySignals(sold).legacyPestAboveTable).toBe(true);
    const r = generateEstimate(extractEngineInputs(sold));
    expect(line(r, 'pest_control').basePrice).toBe(128);
  });

  test('an inputs-only estimate requesting pest reads legacy; a request with no pest pins nothing; a stamped draft stays new', () => {
    const inputsOnly = { engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, services: { pest: { frequency: 'quarterly' } } } };
    expect(replay.savedLegacyPestAboveTableSignal(inputsOnly)).toEqual({ legacyPestAboveTable: true });
    expect(line(generateEstimate(extractEngineInputs(inputsOnly)), 'pest_control').basePrice).toBe(128);
    const oneTimeOnly = { engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, services: { oneTimePest: {} } } };
    expect(replay.savedLegacyPestAboveTableSignal(oneTimeOnly)).toEqual({ legacyPestAboveTable: true });
    expect(replay.savedLegacyPestAboveTableSignal({ engineInputs: { services: { lawn: {} } } })).toEqual({ legacyPestAboveTable: undefined });
    expect(replay.savedLegacyPestAboveTableSignal({ engineInputs: inputsOnly.engineInputs, pricingMetadata: { legacyPestAboveTable: false } }))
      .toEqual({ legacyPestAboveTable: false });
    expect(replay.savedLegacyPestAboveTableSignal({})).toEqual({ legacyPestAboveTable: undefined });
    // The builder request names its services as tokens.
    expect(replay.savedLegacyPestAboveTableSignal({ engineRequest: { selectedServices: ['PEST'] } })).toEqual({ legacyPestAboveTable: true });
  });

  test('the new stamp is its own key: a quote stamped false by the other 11-26 rules is still legacy here', () => {
    const afterOtherRules = {
      engineResult: {
        pricingMetadata: { legacyPricingRules: false, legacyTwoStoryRoof: false, legacyOneTimePestBuffer: false },
        lineItems: [{ service: 'pest_control', basePrice: 128, annual: 512, perApp: 128 }],
      },
    };
    expect(replay.savedLegacyPestAboveTableSignal(afterOtherRules).legacyPestAboveTable).toBe(true);
    expect(replay.savedFloorReplaySignals(afterOtherRules).legacyOneTimePestBuffer).toBe(false);
  });

  test('a fresh draft\'s stamp survives the replay path (stamp false in, new rule out)', () => {
    const fresh = run(10000, { pest: { frequency: 'quarterly' } });
    const saved = { engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, yearBuilt: 2021, services: { pest: { frequency: 'quarterly' } } },
      result: { lineItems: fresh.lineItems, pricingMetadata: fresh.pricingMetadata } };
    expect(replay.savedLegacyPestAboveTableSignal(saved).legacyPestAboveTable).toBe(false);
    expect(line(generateEstimate({ ...saved.engineInputs, ...replay.savedFloorReplaySignals(saved), savedEstimateReplay: true }), 'pest_control').basePrice).toBe(164);
  });
});

describe('the stamp rides every save shape', () => {
  test('snapshot-only: a priced send bundle with no stamp is legacy, a frozen stamp wins, and freezing keeps it through a bundle drop', () => {
    const snapshotOnly = { sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 42.67, annual: 512, perVisit: 128, perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', perApp: 128 }] }] } } };
    expect(replay.savedLegacyPestAboveTableSignal(snapshotOnly).legacyPestAboveTable).toBe(true);
    const copy = JSON.parse(JSON.stringify(snapshotOnly));
    replay.freezeSnapshotRuleStamps(copy);
    expect(copy.sendSnapshot.legacyPestAboveTable).toBe(true);
    delete copy.sendSnapshot.pricingBundle;
    expect(replay.savedLegacyPestAboveTableSignal(copy).legacyPestAboveTable).toBe(true);
    expect(replay.savedFloorReplaySignals(copy).legacyPestAboveTable).toBe(true);
    // A snapshot that froze the new rule keeps it.
    expect(replay.savedLegacyPestAboveTableSignal({ sendSnapshot: { legacyPestAboveTable: false } }).legacyPestAboveTable).toBe(false);
    const frozenNew = { sendSnapshot: { legacyPestAboveTable: false, pricingBundle: snapshotOnly.sendSnapshot.pricingBundle } };
    replay.freezeSnapshotRuleStamps(frozenNew);
    expect(frozenNew.sendSnapshot.legacyPestAboveTable).toBe(false);
  });

  test('the line stamp alone (a save path that drops pricingMetadata) is read', () => {
    const fresh = run(10000, { pest: { frequency: 'quarterly' } });
    expect(replay.savedLegacyPestAboveTableSignal({ engineResult: { lineItems: fresh.lineItems } }).legacyPestAboveTable).toBe(false);
  });

  test('mapped result: the v1-legacy-mapper output keeps the estimate-wide stamp, and a replay of it prices the same', () => {
    const fresh = run(10000, { pest: { frequency: 'quarterly' } });
    const mapped = mapV1ToLegacyShape(fresh);
    expect(mapped.lineItems).toBeUndefined();
    expect(mapped.pricingMetadata.legacyPestAboveTable).toBe(false);
    const persisted = { engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, yearBuilt: 2021, services: { pest: { frequency: 'quarterly' } } }, result: mapped };
    expect(replay.savedLegacyPestAboveTableSignal(persisted).legacyPestAboveTable).toBe(false);
    const again = generateEstimate({ ...persisted.engineInputs, ...replay.savedFloorReplaySignals(persisted), savedEstimateReplay: true });
    expect(line(again, 'pest_control').basePrice).toBe(164);
    // A legacy replay maps to a result that stays legacy.
    const legacyRun = run(10000, { pest: { frequency: 'quarterly' } }, { savedEstimateReplay: true, legacyPestAboveTable: true });
    const legacyMapped = { result: mapV1ToLegacyShape(legacyRun) };
    expect(legacyMapped.result.pricingMetadata.legacyPestAboveTable).toBe(true);
    expect(replay.savedLegacyPestAboveTableSignal(legacyMapped).legacyPestAboveTable).toBe(true);
  });

  test('a posted value never switches the rule, and the replay-only key is stripped and pinned', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('legacyPestAboveTable');
    expect(sanitizeClientIdentityFields({ legacyPestAboveTable: false })).toEqual({});
    const reviewSource = fs.readFileSync(path.resolve(__dirname, '../services/rate-review.js'), 'utf8');
    expect(reviewSource).toContain("'legacyPestAboveTable'");
  });

  test('add-service: a service added to a legacy pest quote leaves the pest line as sold, and the replay key never persists in the inputs', async () => {
    const savedLines = [{ service: 'pest_control', basePrice: 128, perApp: 128, annual: 512, monthly: 42.67 }];
    const estimate = {
      id: 'estimate-1', token: 'public-token', customer_id: 'customer-1', customer_name: 'Taylor Morgan',
      status: 'sent', address: '123 Main St', monthly_total: 42.67, annual_total: 512, onetime_total: 0, waveguard_tier: 'Bronze',
      estimate_data: {
        inputs: {
          homeSqFt: 10000, stories: 1, lotSqFt: 9000, propertyType: 'single_family', zone: 'A', yearBuilt: 2021,
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' }, paymentMethod: 'card',
          services: { pest: { frequency: 'quarterly', roachType: 'none' } },
        },
        result: { lineItems: savedLines },
      },
    };
    const revision = await buildEstimateServiceRevisionDraft(estimate, 'Seasonal Mosquito');
    expect(revision.status).toBe('priced');
    expect(revision.draftEstimateData.inputs).not.toHaveProperty('legacyPestAboveTable');
    const result = revision.draftEstimateData.result;
    const pest = result.results?.pest;
    expect(pest.basePrice ?? pest.pa).toBe(128);
    expect(result.pricingMetadata.legacyPestAboveTable).toBe(true);
  });
});

describe('the fallback save: the new-rule stamp (admin-estimate-persistence)', () => {
  const { assertLivePestBaseForClientPayload } = require('../services/admin-estimate-persistence');
  const meta = (extra = {}) => ({ pestBasePerVisit: Math.round(constants.PEST.base), legacyOneTimePestBuffer: false, ...extra });
  const payload = (pa, pricingMetadata) => ({
    result: {
      recurring: { discount: 0, pestProgramFloorApplied: false },
      pricingMetadata,
      results: { pestTiers: [{ pa, apps: 4, ann: pa * 4, mo: pa / 3, label: 'Quarterly' }], pest: { pa, apps: 4, ann: pa * 4, mo: pa / 3, label: 'Quarterly' } },
      oneTime: { items: [] },
    },
  });
  const save = (p, extra = {}) => assertLivePestBaseForClientPayload(p, { liveConfigVerified: true, ...extra });

  test('a newly priced client pest row must say it was priced under the new rule: no stamp (stale browser) or true is a 409', () => {
    expect(() => save(payload(164, meta({ legacyPestAboveTable: false })))).not.toThrow();
    for (const stale of [meta(), meta({ legacyPestAboveTable: true })]) {
      let error;
      try { save(payload(128, stale)); } catch (e) { error = e; }
      expect(error && error.statusCode).toBe(409);
      expect(error.message).toMatch(/reload the page and regenerate/);
    }
  });

  test('identical rows keep the stored stamp: an old browser resaving a new quote without the stamp stays new, and a legacy quote stays legacy', () => {
    const stored = payload(164, meta({ legacyPestAboveTable: false }));
    const resave = payload(164, meta());
    expect(() => save(resave, { storedEstimateData: stored })).not.toThrow();
    expect(resave.result.pricingMetadata.legacyPestAboveTable).toBe(false);
    // A forged false on a stored legacy quote's identical rows is overwritten by the stored value.
    const legacyStored = { ...payload(128, meta()), engineInputs: { services: { pest: {} } } };
    const forged = payload(128, meta({ legacyPestAboveTable: false }));
    expect(() => save(forged, { storedEstimateData: legacyStored })).not.toThrow();
    expect(forged.result.pricingMetadata.legacyPestAboveTable).toBe(true);
  });

  test('equal rows are not enough: a home-size edit that leaves the browser rows unchanged is a new price and takes the stamp check', () => {
    // 5,500 sq ft priced under the rule ($128, premium zero). Staff correct the size to 10,000 sq ft: the browser still prices the flat
    // $128 and leaves the stamp off above 5,500, so the save is refused and the server prices it ($164).
    const refused = (data, stored) => {
      let error;
      try { save(data, { storedEstimateData: stored }); } catch (e) { error = e; }
      expect(error && error.statusCode).toBe(409);
    };
    const sized = (pricingMetadata, carriers) => ({ ...payload(128, pricingMetadata), ...carriers });
    const stored = sized(meta({ legacyPestAboveTable: false }), { inputs: { homeSqFt: 5500, stories: '1' } });
    refused(sized(meta(), { inputs: { homeSqFt: 10000, stories: '1' } }), stored);
    // A story-count edit moves the footprint too, and every carrier of the size is compared.
    refused(sized(meta(), { inputs: { homeSqFt: 5500, stories: '2' } }), sized(meta({ legacyPestAboveTable: false }), { inputs: { homeSqFt: 5500, stories: '1' } }));
    for (const carrier of ['engineInputs', 'engineInput']) {
      refused(sized(meta(), { [carrier]: { homeSqFt: 10000, stories: 1 } }), sized(meta({ legacyPestAboveTable: false }), { [carrier]: { homeSqFt: 5500, stories: 1 } }));
    }
    refused(sized(meta(), { engineRequest: { profile: { footprint: 10000 } } }),
      sized(meta({ legacyPestAboveTable: false }), { engineRequest: { profile: { footprint: 5500 } } }));
    // The same rows with the same size are still the stored estimate's own: the stored stamp is copied, as before.
    const same = sized(meta(), { inputs: { homeSqFt: 5500, stories: '1' } });
    expect(() => save(same, { storedEstimateData: stored })).not.toThrow();
    expect(same.result.pricingMetadata.legacyPestAboveTable).toBe(false);
    // A legacy quote resized through the fallback is not kept flat either: it reloads and the server re-prices it on current rules.
    const legacyStored = sized(meta(), { inputs: { homeSqFt: 10000, stories: '1', svcPest: true }, engineInputs: { homeSqFt: 10000, services: { pest: {} } } });
    refused(sized(meta(), { inputs: { homeSqFt: 12000, stories: '1', svcPest: true }, engineInputs: { homeSqFt: 12000, services: { pest: {} } } }), legacyStored);
  });
});

describe('staff revisions re-price on current rules; customer replays keep the sent price', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
  const sold = () => ({
    engineInputs: { homeSqFt: 10000, lotSqFt: 9000, stories: 1, yearBuilt: 2021, services: { pest: { frequency: 'quarterly' } } },
    result: {
      pricingMetadata: { legacyPestAboveTable: true },
      lineItems: [{ service: 'pest_control', basePrice: 128, annual: 512, perApp: 128, legacyPestAboveTable: true }],
    },
  });
  const recompute = (deps) => serverRecomputeFromEstimateData(sold(), { needsSync: () => false, ...deps });

  test('a staff revision of a delivered estimate is a fresh pass on the posted inputs: $164 at 10,000 sq ft, as on main for every rule', async () => {
    const revised = await recompute({});
    expect(revised.recomputed).toBe(true);
    expect(revised.rawEngineResult.pricingMetadata.legacyPestAboveTable).toBe(false);
    expect(revised.rawEngineResult.lineItems.find((l) => l.service === 'pest_control').basePrice).toBe(164);
  });

  test('a persisted-estimate replay (membership reconcile, opt-out) keeps the sent $128', async () => {
    const replayed = await recompute({ replaySavedPricingKnobs: true });
    expect(replayed.rawEngineResult.pricingMetadata.legacyPestAboveTable).toBe(true);
    expect(replayed.rawEngineResult.lineItems.find((l) => l.service === 'pest_control').basePrice).toBe(128);
  });
});

test('the public pest range note says the $8 is per application on the quarterly plan and names the cadence amounts', () => {
  const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
  const pest = computePublicPricingRanges({ refresh: true }).services.find((r) => r.key === 'general_pest_quarterly');
  expect(pest.notes).toContain('$8 per application on the quarterly plan for each additional 1,000 sq ft');
  expect(pest.notes).toContain('$7.04 and $6.24 per application');
});

describe('the client fallback estimator: the premium is server-only', () => {
  const clientPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
  const load = () => {
    const out = esbuild.buildSync({
      stdin: { contents: fs.readFileSync(clientPath, 'utf8'), resolveDir: path.dirname(clientPath), sourcefile: clientPath, loader: 'js' },
      bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'silent',
    }).outputFiles[0].text;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', out)(module, module.exports, require);
    return module.exports.calculateEstimate;
  };
  const input = (homeSqFt, extra = {}) => ({
    homeSqFt, stories: 1, lotSqFt: 9000, propertyType: 'single_family', shrubDensity: 'MODERATE',
    landscapeComplexity: 'MODERATE', treeDensity: 'MODERATE', hasLargeDriveway: false, svcPest: true, pestFreq: 4,
    urgency: 'NONE', isAfterHours: false, isRecurringCustomer: false, ...extra,
  });
  const { assertLivePestBaseForClientPayload } = require('../services/admin-estimate-persistence');
  const save = (estimate) => assertLivePestBaseForClientPayload(
    { result: { ...estimate, pricingMetadata: { ...estimate.pricingMetadata, pestBasePerVisit: Math.round(constants.PEST.base) } } },
    { liveConfigVerified: true },
  );

  test('at or below 5,500 sq ft the fallback is unchanged: same quarterly visit as the server, stamp false, the save passes', () => {
    const calculateEstimate = load();
    for (const sqft of [2000, 5000, 5500]) {
      const client = calculateEstimate(input(sqft));
      expect(client.results.pest.pa).toBe(plan(sqft, 'quarterly').basePrice);
      expect(client.pricingMetadata.legacyPestAboveTable).toBe(false);
      expect(() => save(client)).not.toThrow();
    }
  });

  test('above 5,500 sq ft with pest the fallback leaves the stamp MISSING, so the save is a 409 and the server prices it', () => {
    const calculateEstimate = load();
    for (const extra of [{}, { svcPest: false, svcOnetimePest: true }]) {
      const client = calculateEstimate(input(8000, extra));
      expect(Object.prototype.hasOwnProperty.call(client.pricingMetadata, 'legacyPestAboveTable')).toBe(false);
      let error;
      try { save(client); } catch (e) { error = e; }
      expect(error && error.statusCode).toBe(409);
    }
    // A fallback with no pest above the table has nothing to refuse: it keeps the stamp.
    const lawnOnly = calculateEstimate(input(8000, { svcPest: false }));
    expect(lawnOnly.pricingMetadata.legacyPestAboveTable).toBe(false);
  });
});
