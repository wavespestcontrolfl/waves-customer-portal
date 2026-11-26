/**
 * One-time pest for NEW quotes only (owner 2026-11-26, "only new estimtes").
 * Behavior: a fresh quote prices 1.8x the quarterly visit with a 10% minimum over the first visit of a plan and no home-age
 * step; a quote saved before the rule (stamped legacy, unstamped, or inputs-only requesting pest) runs main's existing code
 * and gets main's exact output; the estimate page's choice follows the same split, and the new rule is code, never a Setting.
 * Regressions it guards: a sent quote moving when the rule ships; an old quote read as new (or the reverse) for lack of a stamp;
 * the page and the engine disagreeing; a Settings edit or a stray row key moving the price on a link already sent.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { priceOneTimePest } = require('../services/pricing-engine/service-pricing');
const { newRuleChoiceAmount } = require('../services/pricing-engine/one-time-pest-price');
const replay = require('../services/estimate-floor-signal-replay');
const { oneTimeChoiceAmountForEstimate, extractEngineInputs } = require('../routes/estimate-public');
const { buildEstimateServiceRevisionDraft } = require('../services/estimate-add-service-request');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { signUnitBandSnapshot } = require('../services/pricing-engine/unit-band-pricing');

const { ONE_TIME, PEST } = constants;
const SHOWN = { show_one_time_option: true };
const line = (result, service) => result.lineItems.find((l) => l.service === service);
const withLive = (patch, fn) => {
  const before = { ...ONE_TIME.pest };
  Object.assign(ONE_TIME.pest, patch);
  try { return fn(); } finally { Object.assign(ONE_TIME.pest, before); }
};
const NEW_RULE = ONE_TIME.pest.newRule;
const input = (home, yearBuilt, member, urgency, extra = {}) => ({
  homeSqFt: home, lotSqFt: 8000, stories: 1, yearBuilt, isRecurringCustomer: member, recurringCustomer: member,
  services: { pest: { frequency: 'quarterly' }, oneTimePest: { urgency } }, ...extra,
});
const OLD = new Date().getFullYear() - 65;
const NEW = new Date().getFullYear() - 5;

// [home sq ft, year built, member, urgency, plan visit, age step, plan annual, one-time price]: computed by running these same
// inputs through origin/main's engine (b7ec7c001c) before this change. Year-built values are 1961 and 2021 there.
const MAIN = [[1000,1961,false,"NONE",108,8,432,238],[1000,1961,false,"URGENT",108,8,432,357],[1000,1961,true,"NONE",108,8,432,208],[1000,1961,true,"URGENT",108,8,432,303],[1000,2021,false,"NONE",100,0,400,220],[1000,2021,false,"URGENT",100,0,400,330],[1000,2021,true,"NONE",100,0,400,200],[1000,2021,true,"URGENT",100,0,400,281],[1800,1961,false,"NONE",116,8,464,255],[1800,1961,false,"URGENT",116,8,464,383],[1800,1961,true,"NONE",116,8,464,217],[1800,1961,true,"URGENT",116,8,464,325],[1800,2021,false,"NONE",108,0,432,238],[1800,2021,false,"URGENT",108,0,432,357],[1800,2021,true,"NONE",108,0,432,208],[1800,2021,true,"URGENT",108,0,432,303],[2500,1961,false,"NONE",123,8,492,271],[2500,1961,false,"URGENT",123,8,492,407],[2500,1961,true,"NONE",123,8,492,230],[2500,1961,true,"URGENT",123,8,492,346],[2500,2021,false,"NONE",115,0,460,253],[2500,2021,false,"URGENT",115,0,460,380],[2500,2021,true,"NONE",115,0,460,215],[2500,2021,true,"URGENT",115,0,460,323],[3500,1961,false,"NONE",128,8,512,282],[3500,1961,false,"URGENT",128,8,512,423],[3500,1961,true,"NONE",128,8,512,240],[3500,1961,true,"URGENT",128,8,512,360],[3500,2021,false,"NONE",120,0,480,264],[3500,2021,false,"URGENT",120,0,480,396],[3500,2021,true,"NONE",120,0,480,224],[3500,2021,true,"URGENT",120,0,480,337],[5000,1961,false,"NONE",134,8,536,295],[5000,1961,false,"URGENT",134,8,536,443],[5000,1961,true,"NONE",134,8,536,251],[5000,1961,true,"URGENT",134,8,536,376],[5000,2021,false,"NONE",126,0,504,277],[5000,2021,false,"URGENT",126,0,504,416],[5000,2021,true,"NONE",126,0,504,235],[5000,2021,true,"URGENT",126,0,504,353]];
const fromMain = (row) => ({ home: row[0], member: row[2], urgency: row[3], visit: row[4], age: row[5], annual: row[6], oneTime: row[7], old: row[1] === 1961 });

describe('a fresh quote prices on the new rule', () => {
  test.each([1000, 1800, 2500, 3500, 5000])('%i sq ft: 1.8x or 10% over visit 1, floor $199, no home-age step', (home) => {
    const older = generateEstimate(input(home, OLD, false, 'NONE'));
    const newer = generateEstimate(input(home, NEW, false, 'NONE'));
    const q = line(older, 'pest_control').basePrice;
    // Age-free: the older home pays what the newer home pays, on the plan and the one-time visit.
    expect(line(older, 'pest_control')).toMatchObject({ pestAgeAdj: 0, basePrice: line(newer, 'pest_control').basePrice, annual: line(newer, 'pest_control').annual });
    expect(line(older, 'one_time_pest').price).toBe(line(newer, 'one_time_pest').price);
    const list = Math.max(Math.round(q * 1.8), Math.round(Math.round((q + 99) * 1.1 * 100) / 100));
    expect(line(older, 'one_time_pest').price).toBe(Math.max(199, list));
    // The member perk follows the list, held strictly above visit 1.
    const member = line(generateEstimate(input(home, OLD, true, 'NONE')), 'one_time_pest').price;
    expect(member).toBe(Math.max(199, Math.round(Math.max(199, list) * 0.85), q + 99 + 1));
    // The stamp: current, on the metadata and on the lines (a save path that drops the metadata keeps it).
    expect(older.pricingMetadata.legacyOneTimePestBuffer).toBe(false);
    expect(line(older, 'one_time_pest').legacyOneTimePestBuffer).toBe(false);
    expect(line(older, 'pest_control').legacyOneTimePestBuffer).toBe(false);
  });

  test('a stand-alone one-time job prices the same as one beside a plan; direct pricer calls default to the new rule', () => {
    const both = line(generateEstimate(input(1800, OLD, false, 'NONE')), 'one_time_pest').price;
    const solo = line(generateEstimate({ ...input(1800, OLD, false, 'NONE'), services: { oneTimePest: {} } }), 'one_time_pest').price;
    expect(solo).toBe(both);
    expect(priceOneTimePest({ footprint: 1800 }, {}).multiplier).toBe(1.8);
    expect(priceOneTimePest({ footprint: 1800 }, { legacyOneTimePestBuffer: true }).multiplier).toBe(2.2);
  });

  test('the new rule is code, not a Setting: no row key, no edit reaches it; the old multiplier is still the old quote\'s', () => {
    expect(NEW_RULE).toEqual({ multiplier: 1.8, firstVisitBufferPct: 0.1, floor: 199 });
    expect(Object.isFrozen(NEW_RULE)).toBe(true);
    const fresh = () => line(generateEstimate(input(1800, NEW, false, 'NONE')), 'one_time_pest').price;
    const old = () => line(generateEstimate(input(1800, NEW, false, 'NONE', { savedEstimateReplay: true, legacyOneTimePestBuffer: true })), 'one_time_pest').price;
    const [freshBefore, oldBefore] = [fresh(), old()];
    // The old multiplier is the old quote's alone: an edit moves it and never a new quote.
    withLive({ multiplier: 3 }, () => {
      expect(fresh()).toBe(freshBefore);
      expect(old()).toBe(324);
    });
    // The old keys on the live object cannot reach the new rule either (a stray row key is not read).
    withLive({ newRuleMultiplier: 3, firstVisitBufferPct: 0.5 }, () => expect(fresh()).toBe(freshBefore));
    expect(freshBefore).toBe(Math.max(199, Math.round(108 * 1.8), Math.round(Math.round((108 + 99) * 1.1 * 100) / 100)));
    expect(oldBefore).toBe(238);
  });
});

describe('a quote saved before the rule gets main\'s exact output', () => {
  test.each(MAIN.map(fromMain))('stamped legacy: $home sq ft, old home $old, member $member, $urgency', (row) => {
    const r = generateEstimate(input(row.home, row.old ? 1961 : 2021, row.member, row.urgency, { savedEstimateReplay: true, legacyOneTimePestBuffer: true }));
    expect(line(r, 'pest_control')).toMatchObject({ basePrice: row.visit, pestAgeAdj: row.age, annual: row.annual });
    expect(line(r, 'one_time_pest').price).toBe(row.oneTime);
    expect(r.pricingMetadata.legacyOneTimePestBuffer).toBe(true);
  });

  test('an unstamped priced estimate and an inputs-only estimate requesting pest both read legacy and price as main did', () => {
    const sold = { engineResult: { lineItems: [{ service: 'pest_control', basePrice: 116, annual: 464, perApp: 116 }, { service: 'one_time_pest', price: 255 }] } };
    expect(replay.savedLegacyOneTimePestBufferSignal(sold)).toEqual({ legacyOneTimePestBuffer: true });
    expect(replay.savedFloorReplaySignals(sold).legacyOneTimePestBuffer).toBe(true);
    const inputsOnly = { engineInputs: { homeSqFt: 1800, lotSqFt: 8000, stories: 1, yearBuilt: 1961, services: { pest: { frequency: 'quarterly' }, oneTimePest: {} } } };
    expect(replay.savedLegacyOneTimePestBufferSignal(inputsOnly)).toEqual({ legacyOneTimePestBuffer: true });
    const r = generateEstimate(extractEngineInputs(inputsOnly));
    expect(line(r, 'pest_control')).toMatchObject({ basePrice: 116, pestAgeAdj: 8 });
    // Plan and one-time on one estimate: the recurring-customer perk, as on main (the 217 row of the table above).
    expect(line(r, 'one_time_pest').price).toBe(217);
    // A request with no pest pins nothing, and a stamped draft (the engine wrote false) stays new.
    expect(replay.savedLegacyOneTimePestBufferSignal({ engineInputs: { services: { lawn: {} } } })).toEqual({ legacyOneTimePestBuffer: undefined });
    expect(replay.savedLegacyOneTimePestBufferSignal({ engineInputs: inputsOnly.engineInputs, pricingMetadata: { legacyOneTimePestBuffer: false } })).toEqual({ legacyOneTimePestBuffer: false });
    expect(replay.savedLegacyOneTimePestBufferSignal({})).toEqual({ legacyOneTimePestBuffer: undefined });
  });

  test('a stamp survives the frozen snapshot, and a posted value never switches the rule', () => {
    const snapshotOnly = { sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items: [{ service: 'one_time_pest', amount: 255 }] } } } };
    const copy = JSON.parse(JSON.stringify(snapshotOnly));
    replay.freezeSnapshotRuleStamps(copy);
    expect(copy.sendSnapshot.legacyOneTimePestBuffer).toBe(true);
    expect(CLIENT_IDENTITY_FIELDS).toContain('legacyOneTimePestBuffer');
    expect(sanitizeClientIdentityFields({ legacyOneTimePestBuffer: false })).toEqual({});
    // A value posted inside stored inputs is overwritten by the server-derived key on a replay.
    const forged = extractEngineInputs({ engineResult: { pricingMetadata: { legacyOneTimePestBuffer: true }, lineItems: [{ service: 'one_time_pest', price: 255 }] }, engineInputs: { legacyOneTimePestBuffer: false, services: { oneTimePest: {} } } });
    expect(forged.legacyOneTimePestBuffer).toBe(true);
  });

  test('the engine honors the flat history only through a line stamp: a pest_control entry with no pest stamp stays legacy', () => {
    const old = { savedEstimateReplay: true, legacyPricingRules: true, legacyOneTimePestBuffer: true, currentRulesServices: ['pest_control', 'one_time_pest'] };
    const r = generateEstimate(input(1800, 1961, false, 'NONE', old));
    expect(line(r, 'pest_control')).toMatchObject({ pestAgeAdj: 8, legacyOneTimePestBuffer: true });
    expect(line(r, 'one_time_pest')).toMatchObject({ multiplier: 2.2, legacyOneTimePestBuffer: true });
    // The saved line stamp is the evidence: replay signals carry it, and the engine then prices that service on the new rule.
    const saved = { engineResult: { pricingMetadata: { legacyOneTimePestBuffer: true }, lineItems: [{ service: 'pest_control', basePrice: 108, legacyOneTimePestBuffer: false }, { service: 'one_time_pest', price: 255, legacyOneTimePestBuffer: true }] } };
    expect(replay.savedOneTimePestCurrentServices(saved)).toEqual(['pest_control']);
    const again = generateEstimate({ ...input(1800, 1961, false, 'NONE'), savedEstimateReplay: true, ...replay.savedFloorReplaySignals(saved) });
    expect(line(again, 'pest_control')).toMatchObject({ pestAgeAdj: 0, legacyOneTimePestBuffer: false });
    expect(line(again, 'one_time_pest').legacyOneTimePestBuffer).toBe(true);
    // Server-owned: never posted.
    expect(CLIENT_IDENTITY_FIELDS).toContain('oneTimePestCurrentServices');
  });

  test('save -> map -> replay: a pest plan and a one-time visit a revision adds to an old quote keep the new rule through the mapped result', () => {
    // An old lawn-only quote (priced, unstamped = saved before the rule) on a 65-year-old home.
    const oldQuote = { engineInputs: { homeSqFt: 1800, lotSqFt: 8000, stories: 1, yearBuilt: 1961, services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } },
      result: { lineItems: [{ service: 'lawn_care', annual: 480, monthly: 40, perApp: 60 }] } };
    expect(replay.savedLegacyOneTimePestBufferSignal(oldQuote).legacyOneTimePestBuffer).toBe(true);
    const services = { lawn: { track: 'st_augustine', tier: 'enhanced' }, pest: { frequency: 'quarterly' }, oneTimePest: {} };
    const run = (estData, extra = {}) => generateEstimate({ ...estData.engineInputs, services, ...replay.savedFloorReplaySignals(estData), savedEstimateReplay: true, ...extra });
    // The revision adds pest (this run's addedServiceKeys); the raw lines carry the new-rule stamp and a $108 age-free visit.
    const added = run(oldQuote, { addedServiceKeys: ['pest_control', 'one_time_pest'] });
    expect(line(added, 'pest_control')).toMatchObject({ pestAgeAdj: 0, basePrice: 108, legacyOneTimePestBuffer: false });
    // What is persisted is the MAPPED result, which drops the raw lines and keeps the estimate-wide legacy flag.
    const persisted = { ...oldQuote, result: mapV1ToLegacyShape(added) };
    expect(persisted.result.lineItems).toBeUndefined();
    expect(persisted.result.results.pest.legacyOneTimePestBuffer).toBe(false);
    expect(replay.savedLegacyOneTimePestBufferSignal(persisted).legacyOneTimePestBuffer).toBe(true);
    expect(replay.savedOneTimePestCurrentServices(persisted).sort()).toEqual(['one_time_pest', 'pest_control']);
    // Replaying the mapped result prices the added services the same: $108 (never the aged $116) and the same one-time amount.
    const again = run(persisted);
    expect(line(again, 'pest_control')).toMatchObject({ pestAgeAdj: 0, basePrice: 108 });
    expect(line(again, 'one_time_pest').price).toBe(line(added, 'one_time_pest').price);
    expect(line(again, 'one_time_pest').legacyOneTimePestBuffer).toBe(false);
    // A third trip changes nothing, and the estimate page's choice reads the mapped stamp too.
    expect(line(run({ ...oldQuote, result: mapV1ToLegacyShape(again) }), 'pest_control').basePrice).toBe(108);
    expect(replay.savedOneTimePestRuleLegacy(persisted)).toBe(false);
  });

  test('remove -> restore round trip: a pest plan added to an old lawn estimate keeps its new-rule stamp through a removal and a restore ($108, never $116)', () => {
    const { captureServiceOptOutProvenance } = require('../services/estimate-service-opt-out');
    const lawn = { track: 'st_augustine', tier: 'enhanced' };
    const oldQuote = { engineInputs: { homeSqFt: 1800, lotSqFt: 8000, stories: 1, yearBuilt: 1961, services: { lawn } },
      result: { lineItems: [{ service: 'lawn_care', annual: 480, monthly: 40, perApp: 60 }] } };
    const run = (estData, services, extra = {}) => generateEstimate({ ...estData.engineInputs, services, ...replay.savedFloorReplaySignals(estData), savedEstimateReplay: true, ...extra });
    // The revision adds the pest plan; the persisted result is the mapped one (stamp on its plan row).
    const added = run(oldQuote, { lawn, pest: { frequency: 'quarterly' } }, { addedServiceKeys: ['pest_control'] });
    const withPest = { ...oldQuote, result: mapV1ToLegacyShape(added) };
    expect(line(run(withPest, { lawn, pest: { frequency: 'quarterly' } }), 'pest_control').basePrice).toBe(108);
    // Removal: capture the provenance from the row before the prune, then the pest rows go (the lawn-only mapped result), the event stays.
    const provenance = captureServiceOptOutProvenance(withPest, 'pest_control');
    expect(provenance.floorSignals.oneTimePestCurrentServices).toEqual(['pest_control']);
    const removed = {
      ...oldQuote,
      result: mapV1ToLegacyShape(run(oldQuote, { lawn })),
      serviceOptOut: { events: [{ serviceKey: 'pest_control', included: false, provenance }] },
    };
    expect(replay.savedOneTimePestCurrentServices(removed)).toEqual([]);
    expect(replay.savedFloorReplaySignals(removed).oneTimePestCurrentServices).toEqual(['pest_control']);
    // Restore: the same estimate with pest requested again prices on the new rule, age-free.
    const restored = run(removed, { lawn, pest: { frequency: 'quarterly' } });
    expect(line(restored, 'pest_control')).toMatchObject({ pestAgeAdj: 0, basePrice: 108, legacyOneTimePestBuffer: false });
    // Without the event (a removal that kept no provenance) the old quote's rule would return: $116.
    const { serviceOptOut: _gone, ...noEvent } = removed;
    expect(line(run(noEvent, { lawn, pest: { frequency: 'quarterly' } }), 'pest_control').basePrice).toBe(116);
  });

  test('an inputs-only estimate whose request carries the builder tokens PEST or OT_PEST reads legacy (as EXCLUSION does)', () => {
    for (const selectedServices of [['PEST'], ['OT_PEST'], ['LAWN', 'pest']]) {
      expect(replay.savedLegacyOneTimePestBufferSignal({ engineRequest: { profile: {}, selectedServices } })).toEqual({ legacyOneTimePestBuffer: true });
    }
    expect(replay.savedLegacyOneTimePestBufferSignal({ engineRequest: { profile: {}, selectedServices: ['LAWN', 'MOSQUITO'] } })).toEqual({ legacyOneTimePestBuffer: undefined });
  });

  test('a service added to an old quote prices on the new rule; the old lines keep theirs', () => {
    const old = { savedEstimateReplay: true, legacyOneTimePestBuffer: true };
    const replayed = generateEstimate(input(1800, 1961, false, 'NONE', old));
    expect(line(replayed, 'one_time_pest')).toMatchObject({ price: 255, legacyOneTimePestBuffer: true });
    const added = generateEstimate(input(1800, 1961, false, 'NONE', { ...old, addedServiceKeys: ['one_time_pest'] }));
    expect(line(added, 'one_time_pest')).toMatchObject({ multiplier: 1.8, legacyOneTimePestBuffer: false });
    expect(line(added, 'pest_control')).toMatchObject({ pestAgeAdj: 8, legacyOneTimePestBuffer: true });
    // The line stamp (false) is the evidence the next revision reads; the flat history is not used for this rule.
    expect(line(added, 'one_time_pest').legacyOneTimePestBuffer).toBe(false);
    expect(line(added, 'pest_control').legacyOneTimePestBuffer).toBe(true);
  });

  test('the add-service revision keeps an old quote\'s plan and one-time lines as sold', async () => {
    const savedLines = [
      { service: 'pest_control', basePrice: 116, pestAgeAdj: 8, perApp: 116, annual: 464, monthly: 38.67 },
      { service: 'one_time_pest', price: 255, multiplier: 2.2, quarterlyPerApp: 116, baseSource: 'recurringPestPerApp' },
    ];
    const estimate = {
      id: 'estimate-1', token: 'public-token', customer_id: 'customer-1', customer_name: 'Taylor Morgan',
      status: 'sent', address: '123 Main St', monthly_total: 38.67, annual_total: 464, onetime_total: 255, waveguard_tier: 'Bronze',
      estimate_data: {
        inputs: {
          homeSqFt: 1800, stories: 1, lotSqFt: 8000, propertyType: 'single_family', zone: 'A', yearBuilt: 1961,
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' }, paymentMethod: 'card',
          services: { pest: { frequency: 'quarterly', version: 'v1', roachType: 'none' }, oneTimePest: {} },
        },
        result: { lineItems: savedLines },
      },
    };
    const revision = await buildEstimateServiceRevisionDraft(estimate, 'Seasonal Mosquito');
    expect(revision.status).toBe('priced');
    const rows = [].concat(revision.draftEstimateData.result.oneTime?.items || [], revision.draftEstimateData.result.oneTime?.specItems || []);
    // The same one-time price main gives the same plan + one-time inputs (plan on the estimate: the member perk).
    expect(Number(rows.find((row) => /pest/i.test(`${row.service} ${row.name}`))?.price)).toBe(217);
    // The replay-only key never persists in the draft's stored inputs.
    expect(revision.draftEstimateData.inputs).not.toHaveProperty('legacyOneTimePestBuffer');
  });
});

// Every stored shape the estimate page's choice and breakdown readers read (routes/estimate-public.js), unstamped = saved before the
// rule: the stamp reader must call each legacy, and the page must show main's 2.2 amount where it derives one from a plan visit.
// [name, saved estimate, the page's choice]: 238 = max($199, round(108 x 2.2)); a one-time row's own amount is what it was sold at.
const OLD_238 = Math.max(199, Math.round(108 * 2.2));
const PAGE_SHAPES = [
  ['result.pestTiers (quarterly tier only)', { result: { pestTiers: [{ label: 'Quarterly', apps: 4, pa: 108 }] } }, OLD_238],
  ['result.results.pestTiers', { result: { results: { pestTiers: [{ label: 'Quarterly', apps: 4, pa: 108 }] } } }, OLD_238],
  ['bare estimate_data.pestTiers (no result, no engineResult)', { pestTiers: [{ label: 'Quarterly', apps: 4, pa: 108 }] }, OLD_238],
  ['result.results.pest', { result: { results: { pest: { label: 'Quarterly', apps: 4, pa: 108 } } } }, null],
  ['result.recurring.services pest row', { result: { recurring: { services: [{ name: 'Quarterly Pest Control', mo: 36, perTreatment: 108 }] } } }, OLD_238],
  ['result.lineItems pest_control', { result: { lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432 }] } }, OLD_238],
  ['engineResult.lineItems pest_control', { engineResult: { lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432 }] } }, OLD_238],
  ['result.oneTime.items one_time_pest', { result: { oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 238 }] } } }, 238],
  ['result.oneTime.specItems one_time_pest', { result: { oneTime: { specItems: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 238 }] } } }, null],
  ['result.results.oneTime (array)', { result: { results: { oneTime: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 238 }] } } }, null],
  ['result.results.oneTime.items', { result: { results: { oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 238 }] } } } }, 238],
  ['sendSnapshot bundle one-time breakdown', { sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items: [{ service: 'one_time_pest', amount: 238 }] } } } }, null],
  ['sendSnapshot bundle pest frequency row', { sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 36, annual: 432, perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control' }] }] } } }, null],
];

describe('every shape the page reads is legacy evidence for the stamp reader', () => {
  test.each(PAGE_SHAPES)('%s', (_name, estData, choice) => {
    expect(replay.savedLegacyOneTimePestBufferSignal(estData)).toEqual({ legacyOneTimePestBuffer: true });
    expect(replay.savedOneTimePestRuleLegacy(estData)).toBe(true);
    expect(replay.storedPestServices(estData).size).toBeGreaterThan(0);
    if (choice !== null) expect(oneTimeChoiceAmountForEstimate(SHOWN, estData)).toBe(choice);
    // The same shape stamped current reads current, and a shape with no pest in it pins nothing.
    const stamped = JSON.parse(JSON.stringify(estData));
    const container = stamped.result || stamped.engineResult;
    if (container) container.pricingMetadata = { legacyOneTimePestBuffer: false };
    else if (stamped.sendSnapshot) stamped.sendSnapshot.legacyOneTimePestBuffer = false;
    else stamped.pricingMetadata = { legacyOneTimePestBuffer: false };
    expect(replay.savedLegacyOneTimePestBufferSignal(stamped).legacyOneTimePestBuffer).toBe(false);
  });

  test('a non-pest plan row is no evidence', () => {
    expect(replay.savedLegacyOneTimePestBufferSignal({ result: { recurring: { services: [{ name: 'Lawn Care', mo: 40 }] } } }).legacyOneTimePestBuffer).toBe(true); // priced = legacy for every rule
    expect(replay.storedPestServices({ result: { recurring: { services: [{ name: 'Lawn Care', mo: 40 }, { name: 'Mosquito Pest Barrier', mo: 40 }] } } }).size).toBe(0);
  });
});

describe('a staff revision re-prices on the current rules (main\'s behavior for every rule); the customer add-service rail keeps the legacy stamp', () => {
  const stored = { engineInputs: { homeSqFt: 1800, lotSqFt: 8000, stories: 1, yearBuilt: 1961, services: { pest: { frequency: 'quarterly' } } },
    result: { lineItems: [{ service: 'pest_control', basePrice: 116, pestAgeAdj: 8, perApp: 116, annual: 464 }] } };

  test('the staff recompute passes no stored-row rule: the posted inputs price current (no age step, new formula)', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    let seen;
    await serverRecomputeFromEstimateData({ engineInputs: { ...stored.engineInputs, services: { pest: { frequency: 'quarterly' }, oneTimePest: {} } } }, {
      storedEstimateData: stored, needsSync: () => false, syncConstantsFromDB: async () => {},
      withTrustedCatalogPricing: async (v) => v,
      generateEstimate: (input) => { seen = input; return generateEstimate(input); },
    });
    expect(seen.legacyOneTimePestBuffer).toBeUndefined();
    expect(seen.oneTimePestCurrentServices).toBeUndefined();
    expect(replay.savedOneTimePestRevisionSignals).toBeUndefined();
  });

  test('a one-time visit added to a legacy plan anchors on the age-free quarterly: a 1961 and a 2021 home both $228, the plan keeps its aged price', () => {
    const run = (yearBuilt) => generateEstimate(input(1800, yearBuilt, false, 'NONE', {
      savedEstimateReplay: true, legacyOneTimePestBuffer: true, addedServiceKeys: ['one_time_pest'],
    }));
    const [old, fresh] = [run(1961), run(2021)];
    expect(line(old, 'pest_control')).toMatchObject({ pestAgeAdj: 8, basePrice: 116, legacyOneTimePestBuffer: true });
    expect(line(fresh, 'pest_control')).toMatchObject({ pestAgeAdj: 0, basePrice: 108 });
    expect(line(old, 'one_time_pest')).toMatchObject({ price: 228, legacyOneTimePestBuffer: false });
    expect(line(fresh, 'one_time_pest').price).toBe(228);
  });

  test('the page choice takes the one-time visit\'s own stamp (a plan-only offer takes the plan\'s): retained legacy plan + new visit, through acceptance', () => {
    const { resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    const added = generateEstimate(input(1800, 1961, false, 'NONE', {
      savedEstimateReplay: true, legacyOneTimePestBuffer: true, addedServiceKeys: ['one_time_pest'], services: { pest: { frequency: 'quarterly' }, oneTimePest: {} },
    }));
    const planOnly = generateEstimate(input(1800, 1961, false, 'NONE', { savedEstimateReplay: true, legacyOneTimePestBuffer: true, services: { pest: { frequency: 'quarterly' } } }));
    for (const shape of [{ engineResult: added }, { result: mapV1ToLegacyShape(added), pricingMetadata: added.pricingMetadata }]) {
      expect(replay.savedOneTimePestRuleLegacy(shape)).toBe(false);
      // The visit is on the new rule, anchored age-free: $228, never the aged plan's $237 and never the old 2.2 amount ($255).
      expect(oneTimeChoiceAmountForEstimate(SHOWN, shape)).toBe(228);
      expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: shape }, null)).toBe(228);
    }
    // A plan-only offer on the same old plan keeps the plan's (legacy) rule: main's 2.2 amount.
    expect(replay.savedOneTimePestRuleLegacy({ engineResult: planOnly })).toBe(true);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineResult: planOnly })).toBe(Math.max(199, Math.round(116 * 2.2)));
  });
});

describe('the page anchors on the plan\'s saved quote-time floor, with the engine\'s own helper', () => {
  test('$116 plan, $8 age step, $89 saved floor, live plan floor raised to $120: page and acceptance stay $228', () => {
    const { resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    const saved = { engineResult: {
      pricingMetadata: { legacyOneTimePestBuffer: true, pestProgramFloorArmed: false, pestProgramFloorPerVisit: 89 },
      lineItems: [
        { service: 'pest_control', basePrice: 116, pestAgeAdj: 8, perApp: 116, annual: 464, legacyOneTimePestBuffer: true },
        { service: 'one_time_pest', price: 228, legacyOneTimePestBuffer: false },
      ],
    } };
    const before = PEST.floor;
    try {
      PEST.floor = 120;
      // Today's floor would lift the age-free $108 anchor to $120 and show $241; the quote-time $89 floor keeps $108.
      expect(oneTimeChoiceAmountForEstimate(SHOWN, saved)).toBe(228);
      expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: saved }, null)).toBe(228);
      // The engine replays the same anchor with the same saved floor (one helper, no second copy).
      const replayed = generateEstimate(input(1800, 1961, false, 'NONE', {
        savedEstimateReplay: true, legacyOneTimePestBuffer: true, addedServiceKeys: ['one_time_pest'], pestProgramFloorPerVisit: 89,
      }));
      expect(line(replayed, 'one_time_pest').price).toBe(228);
    } finally { PEST.floor = before; }
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toContain('quarterlyPerAppWithoutHomeAge(amount, ageStep, savedFloor)');
  });
});

describe('the audit script mirrors the new rule\'s code floor (scripts/audit-estimator-pricing.js)', () => {
  test('a differing live onetime_pest.floor never moves the audit\'s new-quote expectation; the engine and the audit agree at both floors', () => {
    const audit = require('path').join(__dirname, '..', '..', 'scripts', 'audit-estimator-pricing.js');
    const { expectOneTimePest } = require(audit);
    const run = () => ({ audit: expectOneTimePest({ homeSqFt: 1000 }).price, member: expectOneTimePest({ homeSqFt: 1000, isRecurringCustomer: true }).price,
      engine: line(generateEstimate({ homeSqFt: 1000, lotSqFt: 8000, stories: 1, services: { oneTimePest: {} } }), 'one_time_pest').price });
    const base = run();
    expect(base.audit).toBe(base.engine);
    for (const floor of [150, 250]) {
      withLive({ floor }, () => {
        const moved = run();
        expect(moved).toEqual(base);
      });
    }
  });
});

describe('the new rule\'s floor is a code constant: a live onetime_pest.floor edit never moves a new quote', () => {
  test('raising the live floor to $250 leaves a new quote, its public choice and a replay from a frozen send bundle at $228 ($108 quarterly); a legacy quote still reads the live floor', () => {
    const { resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    expect(NEW_RULE.floor).toBe(199);
    const planOnly = { engineResult: { pricingMetadata: { legacyOneTimePestBuffer: false }, lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432, legacyOneTimePestBuffer: false }] } };
    // The frozen send bundle a customer link replays from: the quote's stamp and its quarterly pest row.
    const frozen = { sendSnapshot: { legacyOneTimePestBuffer: false, pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 36, annual: 432, perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', perApp: 108 }] }] } } };
    const fresh = () => line(generateEstimate(input(1800, NEW, false, 'NONE', { services: { oneTimePest: {} } })), 'one_time_pest').price;
    const before = [fresh(), oneTimeChoiceAmountForEstimate(SHOWN, planOnly), oneTimeChoiceAmountForEstimate(SHOWN, frozen, frozen.sendSnapshot.pricingBundle)];
    expect(before).toEqual([228, 228, 228]);
    withLive({ floor: 250 }, () => {
      expect(fresh()).toBe(228);
      expect(newRuleChoiceAmount(108)).toBe(228);
      expect(oneTimeChoiceAmountForEstimate(SHOWN, planOnly)).toBe(228);
      expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: planOnly }, null)).toBe(228);
      expect(oneTimeChoiceAmountForEstimate(SHOWN, frozen, frozen.sendSnapshot.pricingBundle)).toBe(228);
      // A plan priced 89 + 99 floor-bound stays on the code floor ($199), and a member's perk never lifts it to the live one.
      expect(line(generateEstimate(input(1000, NEW, true, 'NONE', { services: { oneTimePest: {} } })), 'one_time_pest').price).toBeLessThan(250);
      // The legacy path is main's, unchanged: it still reads the live floor.
      expect(line(generateEstimate(input(1000, NEW, false, 'NONE', { services: { oneTimePest: {} }, savedEstimateReplay: true, legacyOneTimePestBuffer: true })), 'one_time_pest').price).toBe(250);
    });
  });
});

describe('the fallback save: the new-rule stamp (admin-estimate-persistence)', () => {
  const { assertLivePestBaseForClientPayload } = require('../services/admin-estimate-persistence');
  const payload = (items, meta = {}) => ({
    result: {
      recurring: { discount: 0, pestProgramFloorApplied: false },
      pricingMetadata: { pestBasePerVisit: Math.round(constants.PEST.base), legacyOneTimePestBuffer: false, ...meta },
      results: { pestTiers: [{ pa: 112, apps: 4, ann: 448, mo: 37.33, label: 'Quarterly' }], pest: { pa: 112, apps: 4, ann: 448, mo: 37.33, label: 'Quarterly' } },
      oneTime: { items },
    },
  });
  const save = (p, extra = {}) => assertLivePestBaseForClientPayload(p, { liveConfigVerified: true, ...extra });

  test('identical rows copy the trusted stored stamps, never the browser\'s: an old browser resaves a mixed-rule estimate without a stamp, and the choice stays $228', () => {
    const rows = () => ({
      results: { pestTiers: [{ pa: 108, apps: 4, ann: 432, mo: 36, label: 'Quarterly' }], pest: { pa: 108, apps: 4, ann: 432, mo: 36, label: 'Quarterly' } },
      oneTime: { items: [{ service: 'one_time_pest', price: 228 }] },
    });
    const meta = { pestBasePerVisit: Math.round(constants.PEST.base) };
    // The stored estimate: an old quote (estimate-wide legacy) whose one-time visit was added under the new rule.
    const stored = { result: { recurring: { discount: 0, pestProgramFloorApplied: false }, ...rows(), pricingMetadata: { ...meta, legacyOneTimePestBuffer: true } } };
    stored.result.results.pest.legacyOneTimePestBuffer = true;
    stored.result.oneTime.items[0].legacyOneTimePestBuffer = false;
    // An old browser resaves the same rows with no stamp at all.
    const resave = { result: { recurring: { discount: 0, pestProgramFloorApplied: false }, ...rows(), pricingMetadata: { ...meta } } };
    expect(() => save(resave, { storedEstimateData: stored })).not.toThrow();
    expect(resave.result.pricingMetadata.legacyOneTimePestBuffer).toBe(true);
    expect(resave.result.results.pest.legacyOneTimePestBuffer).toBe(true);
    expect(resave.result.oneTime.items[0].legacyOneTimePestBuffer).toBe(false);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, resave)).toBe(228);
    // A forged false stamp on identical rows is overwritten by the stored one too.
    const forged = JSON.parse(JSON.stringify(resave));
    forged.result.pricingMetadata.legacyOneTimePestBuffer = false;
    forged.result.results.pest.legacyOneTimePestBuffer = false;
    expect(() => save(forged, { storedEstimateData: stored })).not.toThrow();
    expect(forged.result.pricingMetadata.legacyOneTimePestBuffer).toBe(true);
    expect(forged.result.results.pest.legacyOneTimePestBuffer).toBe(true);
  });

  test('the unchanged-rows comparison ignores key order (array order kept)', () => {
    const base = { service: 'one_time_pest', price: 228, name: 'One-Time Pest', detail: 'x' };
    const storedRows = payload([base]);
    storedRows.result.pricingMetadata.legacyOneTimePestBuffer = true;
    const reordered = payload([{ detail: 'x', name: 'One-Time Pest', price: 228, service: 'one_time_pest' }]);
    delete reordered.result.pricingMetadata.legacyOneTimePestBuffer;
    reordered.result.results.pest = Object.fromEntries(Object.entries(reordered.result.results.pest).reverse());
    reordered.result.results.pestTiers = [Object.fromEntries(Object.entries(reordered.result.results.pestTiers[0]).reverse())];
    expect(() => save(reordered, { storedEstimateData: storedRows })).not.toThrow();
    expect(reordered.result.pricingMetadata.legacyOneTimePestBuffer).toBe(true);
    // A real change (or a reordered ARRAY) is a new result and needs the stamp.
    const changed = payload([{ ...base, price: 229 }]);
    delete changed.result.pricingMetadata.legacyOneTimePestBuffer;
    expect(() => save(changed, { storedEstimateData: storedRows })).toThrow(/reload the page/);
    const two = (a, b) => payload([a, b]);
    const withTwo = two({ ...base, service: 'one_time_pest', name: 'A' }, { ...base, service: 'one_time_pest', name: 'B' });
    const swapped = two({ ...base, service: 'one_time_pest', name: 'B' }, { ...base, service: 'one_time_pest', name: 'A' });
    delete swapped.result.pricingMetadata.legacyOneTimePestBuffer;
    expect(() => save(swapped, { storedEstimateData: withTwo })).toThrow(/reload the page/);
  });

  test('a revision that leaves the pest rows as the stored row has them saves unchanged; changed rows need the stamp', () => {
    const storedOld = payload([{ service: 'one_time_pest', price: 232 }]);
    delete storedOld.result.pricingMetadata.legacyOneTimePestBuffer;
    const unchanged = JSON.parse(JSON.stringify(storedOld));
    expect(() => save(unchanged)).toThrow(/reload the page/);
    expect(() => save(unchanged, { storedEstimateData: storedOld })).not.toThrow();
    // Edited pest rows are a newly priced result: the stamp applies again.
    const edited = JSON.parse(JSON.stringify(storedOld));
    edited.result.oneTime.items[0].price = 240;
    expect(() => save(edited, { storedEstimateData: storedOld })).toThrow(/reload the page/);
  });
});

describe('the estimate page\'s choice beside a plan', () => {
  const plan = (q, meta) => ({ engineResult: { ...(meta ? { pricingMetadata: meta } : {}), lineItems: [{ service: 'pest_control', basePrice: q, perApp: q, annual: q * 4 }] } });

  test('a new quote shows the engine\'s amount; an old quote shows what it was sold at (main\'s 2.2 path)', () => {
    for (const home of [1000, 1800, 2500, 3500, 5000]) {
      const engine = generateEstimate(input(home, NEW, false, 'NONE', { services: { pest: { frequency: 'quarterly' } } }));
      const q = line(engine, 'pest_control').basePrice;
      const solo = generateEstimate(input(home, NEW, false, 'NONE', { services: { oneTimePest: {} } }));
      expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineResult: engine })).toBe(line(solo, 'one_time_pest').price);
      // Unstamped = priced before the rule: 2.2 x the plan visit, as main shows.
      const unstamped = plan(q);
      expect(oneTimeChoiceAmountForEstimate(SHOWN, unstamped)).toBe(Math.max(199, Math.round(q * 2.2)));
      expect(oneTimeChoiceAmountForEstimate(SHOWN, plan(q, { legacyOneTimePestBuffer: true }))).toBe(Math.max(199, Math.round(q * 2.2)));
      expect(oneTimeChoiceAmountForEstimate(SHOWN, plan(q, { legacyOneTimePestBuffer: false }))).toBe(newRuleChoiceAmount(q));
    }
  });

  test('mixed-rule snapshot, only the snapshot + bundle survive: a new-rule pest plan on an old estimate shows and accepts $228, not the old $238', async () => {
    const { buildPricingBundle, resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    const lawn = { track: 'st_augustine', tier: 'enhanced' };
    const oldQuote = { engineInputs: { homeSqFt: 1800, lotSqFt: 8000, stories: 1, yearBuilt: 1961, services: { lawn } },
      result: { lineItems: [{ service: 'lawn_care', annual: 480, monthly: 40, perApp: 60 }] } };
    const added = generateEstimate({ ...oldQuote.engineInputs, services: { lawn, pest: { frequency: 'quarterly' } }, ...replay.savedFloorReplaySignals(oldQuote), savedEstimateReplay: true, addedServiceKeys: ['pest_control'] });
    expect(line(added, 'pest_control')).toMatchObject({ basePrice: 108, pestAgeAdj: 0 });
    const persisted = { ...oldQuote, result: mapV1ToLegacyShape(added) };
    const bundle = await buildPricingBundle({ id: 'mixed-offer', show_one_time_option: true, estimate_data: persisted, monthly_total: 76, annual_total: 912, onetime_total: 0, waveguard_tier: 'Bronze' });
    expect(bundle.oneTimePestCurrentServices).toEqual(['pest_control']);
    // The send froze the estimate-wide stamp (old) and the bundle; the line stamp is gone.
    const snapshotOnly = { sendSnapshot: { legacyOneTimePestBuffer: true, pricingBundle: bundle } };
    expect(replay.savedLegacyOneTimePestBufferSignal(snapshotOnly).legacyOneTimePestBuffer).toBe(true);
    expect(replay.savedOneTimePestRuleLegacy(snapshotOnly)).toBe(false);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, snapshotOnly, bundle)).toBe(228);
    expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: snapshotOnly }, bundle)).toBe(228);
    // The same snapshot without the marker (an old send) stays on the old rule: 2.2 x 108.
    const { oneTimePestCurrentServices: _m, oneTimePestChoice: _f, ...plain } = bundle;
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { sendSnapshot: { legacyOneTimePestBuffer: true, pricingBundle: plain } }, plain)).toBe(238);
    // A tier change drops the bundle: the marker moves onto the snapshot first.
    const dropped = JSON.parse(JSON.stringify(snapshotOnly));
    replay.freezeSnapshotRuleStamps(dropped);
    delete dropped.sendSnapshot.pricingBundle;
    expect(replay.savedOneTimePestRuleLegacy(dropped)).toBe(false);
  });

  test('snapshot-only: the send froze the RESOLVED choice; display and acceptance use it, never a rebuild from partial rows', async () => {
    const { buildPricingBundle, resolveAcceptOneTimeTotal, stripInternalMarginFieldsDeep } = require('../routes/estimate-public');
    const run = async (extra, services, asked) => {
      const e = generateEstimate(input(1800, 1961, false, 'NONE', { savedEstimateReplay: true, legacyOneTimePestBuffer: true, services, ...extra }));
      const bundle = await buildPricingBundle({ id: `froze-${asked}`, show_one_time_option: true, estimate_data: { engineResult: e, result: mapV1ToLegacyShape(e), pricingMetadata: e.pricingMetadata }, monthly_total: 38.67, annual_total: 464, onetime_total: 0, waveguard_tier: 'Bronze' });
      return { e, bundle, snapshotOnly: { sendSnapshot: { legacyOneTimePestBuffer: true, pricingBundle: bundle } } };
    };
    // (a) a legacy $116 plan (age step $8) + a one-time visit a revision added: the visit is new, anchored age-free: $228.
    const a = await run({ addedServiceKeys: ['one_time_pest'] }, { pest: { frequency: 'quarterly' }, oneTimePest: {} }, 'a');
    expect(line(a.e, 'pest_control')).toMatchObject({ basePrice: 116, pestAgeAdj: 8, legacyOneTimePestBuffer: true });
    expect(a.bundle.oneTimePestChoice).toMatchObject({ amount: 228, legacy: false });
    expect(a.bundle.oneTimePestChoice.anchor).toBe(108);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, a.snapshotOnly, a.bundle)).toBe(228);
    expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: a.snapshotOnly }, a.bundle)).toBe(228);
    // (b) a legacy one-time visit + a plan a revision added under the new rule: the visit keeps the old amount: $238.
    const bb = await run({ addedServiceKeys: ['pest_control'] }, { pest: { frequency: 'quarterly' }, oneTimePest: {} }, 'b');
    expect(line(bb.e, 'pest_control')).toMatchObject({ pestAgeAdj: 0, legacyOneTimePestBuffer: false });
    expect(line(bb.e, 'one_time_pest')).toMatchObject({ legacyOneTimePestBuffer: true });
    expect(bb.bundle.oneTimePestChoice).toMatchObject({ amount: 238, legacy: true });
    expect(oneTimeChoiceAmountForEstimate(SHOWN, bb.snapshotOnly, bb.bundle)).toBe(238);
    expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: bb.snapshotOnly }, bb.bundle)).toBe(238);
    // The marker is internal: gone from the public projection, kept in the stored snapshot, and carried when the bundle is dropped.
    expect(stripInternalMarginFieldsDeep(a.bundle)).not.toHaveProperty('oneTimePestChoice');
    const dropped = JSON.parse(JSON.stringify(a.snapshotOnly));
    replay.freezeSnapshotRuleStamps(dropped);
    delete dropped.sendSnapshot.pricingBundle;
    expect(dropped.sendSnapshot.oneTimePestChoice.amount).toBe(228);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, dropped, null)).toBe(228);
    // An old snapshot with no frozen choice keeps today's path (rebuilt from what it has).
    const { oneTimePestChoice: _c, ...plain } = a.bundle;
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { sendSnapshot: { legacyOneTimePestBuffer: true, pricingBundle: plain } }, plain)).toBeGreaterThan(0);
  });

  test('a plan carries the new rule only on its own line stamp; the older flat history is no evidence', () => {
    // An older revision's currentRulesServices entry (it predates this rule) leaves the quote on the old rule.
    const history = { engineResult: { pricingMetadata: { legacyOneTimePestBuffer: true, currentRulesServices: ['pest_control'], legacyPricingRules: true }, lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432 }] } };
    expect(oneTimeChoiceAmountForEstimate(SHOWN, history)).toBe(Math.max(199, Math.round(108 * 2.2)));
    expect(replay.savedOneTimePestRuleLegacy(history)).toBe(true);
    const added = { engineResult: { pricingMetadata: { legacyOneTimePestBuffer: true, currentRulesServices: ['pest_control'], legacyPricingRules: true }, lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432, legacyOneTimePestBuffer: false }] } };
    expect(oneTimeChoiceAmountForEstimate(SHOWN, added)).toBe(newRuleChoiceAmount(108));
    const lineStamped = { engineResult: { pricingMetadata: { legacyOneTimePestBuffer: true }, lineItems: [{ service: 'pest_control', basePrice: 108, perApp: 108, annual: 432, legacyOneTimePestBuffer: false }] } };
    expect(oneTimeChoiceAmountForEstimate(SHOWN, lineStamped)).toBe(newRuleChoiceAmount(108));
    expect(replay.savedOneTimePestRuleLegacy(added)).toBe(false);
    expect(replay.savedOneTimePestRuleLegacy(plan(108, { legacyOneTimePestBuffer: true }))).toBe(true);
  });

  test('the page and the engine agree over many plan visits, and stay strictly above visit 1', () => {
    for (const quarterly of [60, 90, 100, 108, 126, 150, 187, 300]) {
      const engine = priceOneTimePest({ footprint: 1800 }, { recurringPestPerApp: quarterly });
      expect(newRuleChoiceAmount(quarterly)).toBe(engine.price);
      expect(oneTimeChoiceAmountForEstimate(SHOWN, plan(quarterly, { legacyOneTimePestBuffer: false }))).toBe(engine.price);
      expect(engine.price).toBeGreaterThan(quarterly + PEST.initialFee);
    }
  });
});

describe('no Settings, no database change', () => {
  const fs = require('fs');
  const path = require('path');
  const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');

  test('a stray row key is not read: the bridge leaves the new rule alone, and no migration or admin validation exists for it', async () => {
    const rows = [{ config_key: 'onetime_pest', data: { floor: 199, multiplier: 2.2, newRuleMultiplier: 3, firstVisitBufferPct: 0.9 } }];
    const db = (table) => ({ select: async () => (table === 'pricing_config' ? rows : []) });
    try { await syncConstantsFromDB(db); } catch { /* the loader shape is covered by pricing-engine-db-bridge.test.js */ }
    expect(NEW_RULE).toEqual({ multiplier: 1.8, firstVisitBufferPct: 0.1, floor: 199 });
    const root = path.join(__dirname, '..');
    expect(fs.readdirSync(path.join(root, 'models/migrations')).filter((f) => /onetime_pest|one_time_pest|new_quote_keys/i.test(f) && f.startsWith('202611'))).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'services/pricing-engine/db-bridge.js'), 'utf8')).not.toMatch(/newRule/);
    expect(fs.readFileSync(path.join(root, 'routes/admin-pricing-config.js'), 'utf8')).not.toMatch(/newRule/);
  });
});

describe('bedroom-band estimates stay on the existing band path', () => {
  const ADDRESS = '1400 Lakefront Dr Apt 7109, Sarasota, FL 34240';
  let priorSecret;
  beforeAll(() => { priorSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'band-choice-test-secret'; });
  afterAll(() => { if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret; });
  const signed = (r) => ({ ...r, ...signUnitBandSnapshot(r, ADDRESS) });
  const row = (serviceCode, frequency, price) => signed({
    serviceCode, frequency, band: 'two_bedroom', recurringPrice: price, initialPrice: price, includedScope: 'interior_unit_general_pest', oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13',
  });
  const bandInputs = (services, oneTimePrice, extra = {}) => ({
    services, propertyType: 'unknown', stories: 1, isCommercial: false, address: ADDRESS,
    unitBandPricing: {
      eligible: true, pricingBasis: 'caller_stated_bedroom_count', sizeBasis: 'bedroom_band', pricingBand: 'two_bedroom', bedroomCount: 2,
      pest: { ...row('pest', 'quarterly', 92), intentFrequency: 'quarterly' },
      pestCadences: { quarterly: row('pest', 'quarterly', 92) },
      ...(oneTimePrice ? { oneTimePest: row('oneTimePest', 'one_time', oneTimePrice) } : {}),
      missing: [], parked: {}, unresolved: null,
    },
    ...extra,
  });

  test('a fresh band quote: the engine prices the band row, and the page choice is the existing one, never the new footprint rule', () => {
    const input = bandInputs({ pest: { frequency: 'quarterly' }, oneTimePest: {} }, 202.4);
    const engine = generateEstimate(input);
    // The band row's list is $202.40 (the member price beside the plan is the floor, $199); no footprint multiple is involved.
    expect(line(engine, 'one_time_pest')).toMatchObject({ baseSource: 'unit_band_row', preUrgencyPrice: 202.4, multiplier: null });
    const planOnly = generateEstimate({ ...input, services: { pest: { frequency: 'quarterly' } } });
    expect(planOnly.pricingMetadata.legacyOneTimePestBuffer).toBe(false);
    // $92 plan visit: the new footprint rule would say 210 ((92 + 99) x 1.10); the band choice stays exactly what main shows for the
    // same quote (the existing calculation, $202), the same with the stamp true, false or absent.
    const estData = { engineInputs: input, engineResult: planOnly };
    const choice = oneTimeChoiceAmountForEstimate(SHOWN, estData);
    expect(choice).toBe(Math.max(199, Math.round(92 * 2.2)));
    expect(choice).not.toBe(newRuleChoiceAmount(92));
    const unstamped = JSON.parse(JSON.stringify(estData));
    delete unstamped.engineResult.pricingMetadata.legacyOneTimePestBuffer;
    delete unstamped.engineResult.routingMetadata.legacyOneTimePestBuffer;
    for (const l of unstamped.engineResult.lineItems) delete l.legacyOneTimePestBuffer;
    expect(oneTimeChoiceAmountForEstimate(SHOWN, unstamped)).toBe(choice);
  });

  test('the priced line\'s own basis decides, not a stored band row: a unit with measured square feet or a roach program is footprint-priced and takes the new rule', () => {
    // A stored signed band row, but the unit now carries a real measurement: the engine priced it on the footprint ladder.
    const measured = bandInputs({ pest: { frequency: 'quarterly' } }, 202.4, { homeSqFt: 1800 });
    const engine = generateEstimate(measured);
    expect(line(engine, 'pest_control').pricingBasis).not.toBe('caller_stated_bedroom_count');
    const q = line(engine, 'pest_control').basePrice;
    const planOnly = generateEstimate({ ...measured, services: { pest: { frequency: 'quarterly' } } });
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineInputs: measured, engineResult: planOnly })).toBe(newRuleChoiceAmount(q));
    // Same for a roach program on the plan.
    const roach = bandInputs({ pest: { frequency: 'quarterly', roachType: 'regular' } }, 202.4);
    const roachPlan = generateEstimate(roach);
    // Footprint-priced (not the band's 2.2 amount), so the page runs the new rule on that plan's own per-visit rate.
    const roachChoice = oneTimeChoiceAmountForEstimate(SHOWN, { engineInputs: roach, engineResult: roachPlan });
    expect(roachPlan.pricingMetadata.legacyOneTimePestBuffer).toBe(false);
    expect(line(roachPlan, 'pest_control').pricingBasis).not.toBe('caller_stated_bedroom_count');
    expect(roachChoice).not.toBe(Math.max(199, Math.round(92 * 2.2)));
    expect(roachChoice).toBeGreaterThanOrEqual(newRuleChoiceAmount(line(roachPlan, 'pest_control').basePrice));
  });

  test('when only the inputs survive, the engine\'s own helper is asked again: a trusted band row stays band, a measured or roach unit does not', () => {
    const mappedOnly = (inputs) => ({
      engineInputs: inputs,
      result: { pricingMetadata: { legacyOneTimePestBuffer: false }, results: { pestTiers: [{ label: 'Quarterly', apps: 4, pa: 92, ann: 368, mo: 30.67 }] }, recurring: { services: [{ name: 'Pest Control', mo: 30.67 }] } },
    });
    const band = bandInputs({ pest: { frequency: 'quarterly' } }, 202.4);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, mappedOnly(band))).toBe(Math.max(199, Math.round(92 * 2.2)));
    expect(oneTimeChoiceAmountForEstimate(SHOWN, mappedOnly(bandInputs({ pest: { frequency: 'quarterly' } }, 202.4, { homeSqFt: 1800 })))).toBe(newRuleChoiceAmount(92));
    expect(oneTimeChoiceAmountForEstimate(SHOWN, mappedOnly(bandInputs({ pest: { frequency: 'quarterly', roachType: 'regular' } }, 202.4)))).toBe(newRuleChoiceAmount(92));
  });

  test('only the stamped send snapshot + pricing bundle survive: the band offer shows and accepts at $202 (never the new rule\'s $210)', async () => {
    const { buildPricingBundle, resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    const input = bandInputs({ pest: { frequency: 'quarterly' } }, 202.4);
    const engine = generateEstimate(input);
    const full = { engineInputs: input, engineResult: engine, result: mapV1ToLegacyShape(engine) };
    const bundle = await buildPricingBundle({ id: 'band-offer', show_one_time_option: true, estimate_data: full, monthly_total: 30.67, annual_total: 368, onetime_total: 0, waveguard_tier: 'Bronze' });
    // The bundle froze the engine's verdict beside its rows when it was built.
    expect(bundle.bandPricedPest).toBe(true);
    // A footprint quote's bundle carries no such mark.
    const fp = generateEstimate(input.services && { homeSqFt: 1800, lotSqFt: 8000, stories: 1, services: { pest: { frequency: 'quarterly' } } });
    const fpBundle = await buildPricingBundle({ id: 'fp-offer', show_one_time_option: true, estimate_data: { engineResult: fp, result: mapV1ToLegacyShape(fp) }, monthly_total: 36, annual_total: 432, onetime_total: 0, waveguard_tier: 'Bronze' });
    expect(fpBundle.bandPricedPest).toBeUndefined();
    // Later only the snapshot remains: no inputs, no lines, no result.
    const snapshotOnly = { sendSnapshot: { legacyOneTimePestBuffer: false, pricingBundle: bundle } };
    const expected = Math.max(199, Math.round(92 * 2.2));
    expect(oneTimeChoiceAmountForEstimate(SHOWN, snapshotOnly, bundle)).toBe(expected);
    expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: snapshotOnly }, bundle)).toBe(expected);
    expect(expected).not.toBe(newRuleChoiceAmount(92));
  });

  test('dropping a bundle freezes every marker onto the snapshot: band verdict, resolved choice, per-service rule', () => {
    const replay = require('../services/estimate-floor-signal-replay');
    const estData = { sendSnapshot: { pricingBundle: { frequencies: [], bandPricedPest: true, oneTimePestChoice: { amount: 238, legacy: true, anchor: 108 }, oneTimePestCurrentServices: ['one_time_pest'] } } };
    replay.freezeSnapshotRuleStamps(estData);
    expect(estData.sendSnapshot.bandPricedPest).toBe(true);
    expect(estData.sendSnapshot.oneTimePestChoice).toEqual({ amount: 238, legacy: true, anchor: 108 });
    expect(estData.sendSnapshot.oneTimePestCurrentServices).toEqual(['one_time_pest']);
    delete estData.sendSnapshot.pricingBundle;
    expect(oneTimeChoiceAmountForEstimate(SHOWN, estData)).toBe(238);
  });

  test('mapped-only: the mapped result keeps the engine\'s band marker (pricingVersion unit_band): a $92 band offer shows and accepts $202', () => {
    const { resolveAcceptOneTimeTotal } = require('../routes/estimate-public');
    const engine = generateEstimate(bandInputs({ pest: { frequency: 'quarterly' } }, 202.4));
    const mapped = mapV1ToLegacyShape(engine);
    expect(mapped.results.pest.pricingVersion).toBe('unit_band');
    const mappedOnly = { result: mapped };
    const expected = Math.max(199, Math.round(92 * 2.2));
    expect(oneTimeChoiceAmountForEstimate(SHOWN, mappedOnly)).toBe(expected);
    expect(resolveAcceptOneTimeTotal({ ...SHOWN, estimate_data: mappedOnly }, null)).toBe(expected);
    expect(expected).not.toBe(newRuleChoiceAmount(92));
    // A footprint plan's mapped result is not band.
    const fp = mapV1ToLegacyShape(generateEstimate({ homeSqFt: 1800, lotSqFt: 8000, stories: 1, services: { pest: { frequency: 'quarterly' } } }));
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { result: fp })).toBe(newRuleChoiceAmount(108));
  });

  test('the public /data pricing projection never carries the internal rule markers; the stored snapshot keeps them', async () => {
    const { buildPricingBundle, stripInternalMarginFieldsDeep } = require('../routes/estimate-public');
    const input = bandInputs({ pest: { frequency: 'quarterly' } }, 202.4);
    const engine = generateEstimate(input);
    const bundle = await buildPricingBundle({ id: 'strip-offer', show_one_time_option: true, estimate_data: { engineInputs: input, engineResult: engine, result: mapV1ToLegacyShape(engine) }, monthly_total: 30.67, annual_total: 368, onetime_total: 0, waveguard_tier: 'Bronze' });
    expect(bundle.bandPricedPest).toBe(true);
    const projected = { ...stripInternalMarginFieldsDeep({ ...bundle, oneTimePestCurrentServices: ['pest_control'] }) };
    expect(projected).not.toHaveProperty('bandPricedPest');
    expect(projected).not.toHaveProperty('oneTimePestCurrentServices');
    expect(projected.frequencies).toBeDefined();
    // The /data handler spreads exactly that projection into `pricing`.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toContain('...stripInternalMarginFieldsDeep(pricingBundle),');
  });

  test('a roach program leaves the band: the plan and one-time visit are footprint-priced, so they take the new rule', () => {
    const r = generateEstimate(bandInputs({ pest: { frequency: 'quarterly', roachType: 'regular' }, oneTimePest: { roachType: 'regular' } }, 202.4));
    expect(line(r, 'pest_control').pricingBasis).not.toBe('caller_stated_bedroom_count');
    expect(line(r, 'one_time_pest').multiplier).toBe(1.8);
  });
});
