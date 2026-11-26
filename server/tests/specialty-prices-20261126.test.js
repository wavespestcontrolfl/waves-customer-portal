// Specialty prices of 2026-11-26 (owner, evening), new quotes only:
//   1. Bed bug chemical: room 1 as before (every factor), each added room a flat $349 on the FINAL price.
//   2. Recurring mosquito above 2 acres: priced (2-acre visit + $85 per added acre, pro-rated), no longer held for a hand price.
//   3. Wasp / hornet / yellow jacket: the second level is $275 (was $250).
// ONE estimate stamp, pricingMetadata.legacySpecialty1126 (the legacyTwoStoryRoof #8609 / legacyOneTimePestBuffer #8626
// mechanism): the engine writes false on a fresh run; a priced estimate with no stamp, or one that kept only inputs asking for
// bed bug, mosquito or a stinging insect, reads legacy and keeps the price, the hold and the $250 level it was sold with.
// The "main" figures below were read from the engine on main (origin/main 6c8f04ed81) before the change.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The send-snapshot builder's pricing bundle build is captured (the test reads the estimate data it is handed).
jest.mock('../routes/estimate-public', () => {
  const actual = jest.requireActual('../routes/estimate-public');
  actual.buildPricingBundle = jest.fn(async () => ({ captured: true }));
  return actual;
});

const fs = require('fs');
const { generateEstimate, priceBedBugTreatment, priceMosquito, priceStingingInsect } = require('../services/pricing-engine');
const { BED_BUG, SPECIALTY } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  savedLegacySpecialty1126Signal, savedFloorReplaySignals, freezeSnapshotRuleStamps,
} = require('../services/estimate-floor-signal-replay');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { extractEngineInputs, invalidateSendSnapshotPricingBundle } = require('../routes/estimate-public');

const ACRE = 43560;
const LEGACY = { legacySpecialty1126: true };

const HOME = (overrides = {}) => ({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
  features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
  ...overrides,
});
const lineOf = (est, service) => est.lineItems.find((l) => l.service === service);

// ── 1. bed bug ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const bedBug = (rooms, extra = {}) => priceBedBugTreatment({ footprint: 2000, stories: 1 }, {
  rooms, method: 'CHEMICAL', severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily', ...extra,
});

describe('bed bug chemical: each added room adds a flat $349 to the first-room price', () => {
  test('the constant is a code constant', () => {
    expect(BED_BUG.chemical.addedRoomPrice).toBe(349);
  });

  test.each([
    // rooms, customer price at 2,000 sq ft, moderate, ready, single family: the first room keeps today's price ($677), then +$349 each
    [1, 677], [2, 1026], [3, 1375], [4, 1724], [5, 2073],
  ])('moderate, %s room(s): $%s', (rooms, price) => {
    expect(bedBug(rooms).price).toBe(price);
  });

  test('moderate, ready, single family at a 1,500 sq ft footprint (no size factor): first room x1.15 severity, then $349 flat', () => {
    // Today (main) the same job is $644 / $1,069 / $1,493; the $1,122 two-room price is the 2,000 sq ft footprint (x1.05 size).
    const at1500 = (rooms, extra = {}) => priceBedBugTreatment({ footprint: 1500, stories: 1 }, {
      rooms, method: 'CHEMICAL', severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily', ...extra,
    }).price;
    expect([1, 2, 3].map((rooms) => at1500(rooms))).toEqual([644, 993, 1342]);
    expect([1, 2, 3].map((rooms) => at1500(rooms, LEGACY))).toEqual([644, 1069, 1493]);
  });

  test('the first-room base is the $560 moderate one-room base; the added rooms ride on the final price', () => {
    for (const rooms of [1, 2, 3, 4]) expect(Math.round(bedBug(rooms).basePrice * 100) / 100).toBe(560.43);
    expect(bedBug(3).addedRoomsTotal).toBe(698);
    expect(bedBug(1).addedRoomsTotal).toBeUndefined();
  });

  test.each([
    ['light', [472, 821, 1170, 1519, 1868]],
    ['moderate', [677, 1026, 1375, 1724, 2073]],
    ['heavy', [765, 1114, 1463, 1812, 2161]],
  ])('%s severity: the first room keeps today\'s price, every added room is $349 flat', (severity, prices) => {
    expect([1, 2, 3, 4, 5].map((rooms) => bedBug(rooms, { severity }).price)).toEqual(prices);
  });

  test('room 1 is exactly what main priced for one room (every severity, prep and occupancy)', () => {
    for (const severity of ['light', 'moderate', 'heavy']) {
      for (const prepStatus of ['ready', 'partial', 'poor']) {
        for (const occupancyType of ['singleFamily', 'apartment']) {
          const one = bedBug(1, { severity, prepStatus, occupancyType });
          expect(one.price).toBe(bedBug(1, { severity, prepStatus, occupancyType, ...LEGACY }).price);
        }
      }
    }
  });

  test('prep, occupancy, size and urgency factors apply to the first room only; added rooms take none', () => {
    const plain = bedBug(1, { severity: 'light' }).price;
    for (const extra of [{ prepStatus: 'partial' }, { prepStatus: 'poor' }, { occupancyType: 'apartment' }, { urgency: 'emergency' }]) {
      const one = bedBug(1, { severity: 'light', ...extra }).price;
      expect(one).toBeGreaterThan(plain);
      expect(bedBug(4, { severity: 'light', ...extra }).price).toBe(one + 3 * 349);
    }
    // The cost model (direct cost, margin) still describes the real job: more rooms, more cost.
    expect(bedBug(4).directCostEstimate).toBeGreaterThan(bedBug(3).directCostEstimate);
  });

  test('legacy (a quote priced before the rule) is main exactly', () => {
    // Read from main: light / moderate / heavy, ready, single family, 2,000 sq ft, 1 to 5 rooms.
    const main = {
      light: [472, 786, 1101, 1415, 1729], moderate: [677, 1122, 1567, 2013, 2458], heavy: [765, 1268, 1772, 2275, 2778],
    };
    for (const [severity, prices] of Object.entries(main)) {
      expect([1, 2, 3, 4, 5].map((rooms) => bedBug(rooms, { severity, ...LEGACY }).price)).toEqual(prices);
    }
  });

  test('heat is untouched', () => {
    for (const rooms of [1, 2, 3]) {
      const heat = (extra = {}) => bedBug(rooms, { method: 'HEAT', equipment: 'INHOUSE', heatScope: 'ROOMS_ONLY', ...extra }).price;
      expect(heat()).toBe(heat(LEGACY));
    }
  });

  test('the engine line carries the stamp; a legacy run keeps the old price and stamps true', () => {
    const run = (extra = {}) => generateEstimate(HOME({
      ...extra, services: { bedBug: { rooms: 3, method: 'CHEMICAL', severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily' } },
    }));
    const fresh = run();
    expect(fresh.pricingMetadata.legacySpecialty1126).toBe(false);
    expect(lineOf(fresh, 'bed_bug').legacySpecialty1126).toBe(false);
    expect(lineOf(fresh, 'bed_bug').price).toBe(1375);
    const legacy = run(LEGACY);
    expect(legacy.pricingMetadata.legacySpecialty1126).toBe(true);
    expect(lineOf(legacy, 'bed_bug').price).toBe(1567);
  });
});

// ── 2. mosquito above 2 acres ──────────────────────────────────────────────────────────────────────────────────────────────
const mosquito = (acres, tier, extra = {}, footprint = 2000) => priceMosquito(
  { lotSqFt: Math.round(acres * ACRE), footprint, homeSqFt: 2000, stories: 1, features: {} }, { tier, ...extra },
);
const tierPrices = (r) => Object.fromEntries(r.tiers.map((t) => [t.tier, t.perVisit]));

describe('recurring mosquito above 2 acres is priced', () => {
  test.each([
    // acres, seasonal per visit (the owner table: 2 ac $117, 3 ac $202, 4 ac $287), monthly per visit
    [2, 117, 103], [2.5, 160, 140], [3, 202, 178], [4, 287, 253], [5, 372, 327],
  ])('%s acres: seasonal $%s a visit, monthly $%s a visit', (acres, seasonal, monthly) => {
    const r = mosquito(acres, 'seasonal9');
    expect(tierPrices(r)).toEqual({ seasonal9: seasonal, monthly12: monthly });
    // Annual and monthly are the per-visit price times the program's visits.
    const byTier = Object.fromEntries(r.tiers.map((t) => [t.tier, t]));
    expect(byTier.seasonal9.annual).toBe(seasonal * 9);
    expect(byTier.monthly12.annual).toBe(monthly * 12);
    expect(mosquito(acres, 'monthly12').perVisit).toBe(monthly);
    // The monthly program keeps its existing ratio to seasonal (never above it).
    expect(monthly).toBeLessThanOrEqual(seasonal);
    // The hand-price reason is gone for a new quote.
    expect(r.manualReviewReasons).not.toContain('mosquito_lot_above_2_acres');
  });

  test('every added acre is exactly $85 on the seasonal visit, pro-rated by the square foot, no cap', () => {
    const seasonal = (acres) => mosquito(acres, 'seasonal9').perVisit;
    expect(seasonal(3) - seasonal(2)).toBe(85);
    expect(seasonal(4) - seasonal(3)).toBe(85);
    expect(seasonal(5) - seasonal(4)).toBe(85);
    expect(seasonal(12) - seasonal(2)).toBe(850);
    expect(seasonal(2.5) - seasonal(2)).toBe(43); // $42.50, rounded
    // One extra square foot adds a fraction of a cent.
    expect(mosquito(87121 / ACRE, 'seasonal9').perVisit).toBe(seasonal(2));
  });

  test('2 acres and under are the same as main, new and legacy', () => {
    for (const acres of [0.5, 1, 1.5, 2]) {
      for (const tier of ['seasonal9', 'monthly12']) {
        const fresh = mosquito(acres, tier);
        const legacy = mosquito(acres, tier, LEGACY);
        expect(fresh.perVisit).toBe(legacy.perVisit);
        expect(fresh.annual).toBe(legacy.annual);
        expect(fresh.manualReviewReasons).toEqual(legacy.manualReviewReasons);
      }
    }
    expect(mosquito(2, 'seasonal9').perVisit).toBe(117);
  });

  test('legacy (a quote priced before the rule) is main exactly: the flat price and the hand-price reason first', () => {
    for (const acres of [2.5, 3, 4, 5]) {
      const r = mosquito(acres, 'seasonal9', LEGACY);
      expect(tierPrices(r)).toEqual({ seasonal9: 117, monthly12: 103 });
      expect(r.manualReviewReasons[0]).toBe('mosquito_lot_above_2_acres');
    }
  });

  test('an unmeasured lot keeps its hold and the flat price; an explicit treatable area above 2 acres is priced', () => {
    const unmeasured = mosquito(3, 'seasonal9', { lotSizeMeasured: false });
    expect(unmeasured.perVisit).toBe(117);
    expect(unmeasured.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
    const treatable = priceMosquito({ lotSqFt: 100000, footprint: 2000, homeSqFt: 2000, stories: 1, mosquitoTreatableSqFt: 130680, features: {} }, { tier: 'seasonal9' });
    expect(treatable.perVisit).toBe(202);
  });

  test('the pressure multiplier is not scaled by the added acres, and add-ons stay annual', () => {
    const heavy = priceMosquito({ lotSqFt: 3 * ACRE, footprint: 2000, homeSqFt: 2000, stories: 1, features: { trees: 'heavy', pool: true } }, { tier: 'seasonal9' });
    const heavyTwo = priceMosquito({ lotSqFt: 2 * ACRE, footprint: 2000, homeSqFt: 2000, stories: 1, features: { trees: 'heavy', pool: true } }, { tier: 'seasonal9' });
    expect(heavy.perVisit - heavyTwo.perVisit).toBe(85);
    const withStations = mosquito(3, 'seasonal9', { stationCount: 2 });
    expect(withStations.annual).toBe(202 * 9 + 2 * withStations.addOns.stationAddOn / 2);
  });

  test('a big footprint anchors the price at the 2-acre boundary: 2 ac $112 -> 3 ac $197 (35,000 sq ft footprint)', () => {
    const big = (acres, tier = 'seasonal9') => mosquito(acres, tier, {}, 35000);
    expect(big(2).perVisit).toBe(112);
    expect(big(3).perVisit).toBe(197);
    expect(big(4).perVisit).toBe(282);
    expect(big(2.5).perVisit).toBe(155);
    // The monthly program is its 2-acre price scaled by its ratio to seasonal at 2 acres ($98 / $112).
    expect(big(2, 'monthly12').perVisit).toBe(98);
    expect(big(3, 'monthly12').perVisit).toBe(172);
    // The flat curve at a bigger treatable area would have said $202; the boundary anchor is what the owner ruled.
    expect(mosquito(3, 'seasonal9').perVisit).toBe(202);
  });

  test('through the estimate engine the 2-acre price is the same home on exactly 2 acres, so added acres are exactly $85 each', () => {
    const pv = (acres, extra = {}) => lineOf(generateEstimate(HOME({ homeSqFt: 35000, lotSqFt: Math.round(acres * ACRE), services: { mosquito: { tier: 'seasonal9' } }, ...extra })), 'mosquito').perVisit;
    expect(pv(2)).toBe(114);
    expect(pv(3)).toBe(199);
    expect(pv(4)).toBe(284);
    expect(pv(3) - pv(2)).toBe(85);
    expect(pv(2.5) - pv(2)).toBe(43);
    // An explicit treatable area above 2 acres is capped to the boundary too.
    const explicit = lineOf(generateEstimate(HOME({ homeSqFt: 2000, lotSqFt: 100000, mosquitoTreatableSqFt: 130680, services: { mosquito: { tier: 'seasonal9' } } })), 'mosquito');
    const twoAcre = lineOf(generateEstimate(HOME({ homeSqFt: 2000, lotSqFt: 87120, mosquitoTreatableSqFt: 87120, services: { mosquito: { tier: 'seasonal9' } } })), 'mosquito');
    expect(explicit.perVisit).toBe(twoAcre.perVisit + 85);
  });

  test('the engine line: stamped false, no hold reason; legacy stamped true and held; one-time mosquito is untouched', () => {
    const run = (extra = {}, services = { mosquito: { tier: 'seasonal9' } }) => generateEstimate(HOME({ lotSqFt: 3 * ACRE, ...extra, services }));
    const fresh = run();
    const freshLine = lineOf(fresh, 'mosquito');
    expect(fresh.pricingMetadata.legacySpecialty1126).toBe(false);
    expect(freshLine.legacySpecialty1126).toBe(false);
    expect(freshLine.perVisit).toBe(207); // the 2-acre price on this home's pressure ($122) + $85
    expect(freshLine.manualReviewReasons).not.toContain('mosquito_lot_above_2_acres');
    const legacy = run(LEGACY);
    expect(lineOf(legacy, 'mosquito').perVisit).toBe(122);
    expect(lineOf(legacy, 'mosquito').manualReviewReasons[0]).toBe('mosquito_lot_above_2_acres');
    // The one-time ladder already prices past an acre and is not part of this rule.
    const oneTime = (extra = {}) => lineOf(run(extra, { oneTimeMosquito: {} }), 'one_time_mosquito').price;
    expect(oneTime()).toBe(oneTime(LEGACY));
  });
});

// ── 3. wasp / hornet / yellow jacket ───────────────────────────────────────────────────────────────────────────────────────
describe('wasp, hornet and yellow jacket: level 2 is $275', () => {
  test('the tables are code constants', () => {
    expect(SPECIALTY.wasp.tiers).toEqual([150, 275, 435, 775]);
    expect(SPECIALTY.wasp.legacyTiers).toEqual([150, 250, 435, 775]);
  });

  test.each([
    // level, no removal, small removal ($75), large removal ($250)
    [1, 150, 225, 400], [2, 275, 350, 525], [3, 435, 510, 685], [4, 775, 850, 1025],
  ])('level %s: $%s, with the small nest removal $%s, with the large comb $%s', (tier, none, small, large) => {
    expect(priceStingingInsect({ tier, removal: 'NONE' }).price).toBe(none);
    expect(priceStingingInsect({ tier, removal: 'SMALL' }).price).toBe(small);
    expect(priceStingingInsect({ tier, removal: 'LARGE' }).price).toBe(large);
  });

  test('level 2 plus the $75 nest removal is $350', () => {
    expect(priceStingingInsect({ tier: 2, removal: 'SMALL' }).price).toBe(350);
  });

  test('legacy (a quote priced before the rule) is main exactly: $250 at level 2', () => {
    const legacy = (tier, removal) => priceStingingInsect({ tier, removal, ...LEGACY }).price;
    expect([1, 2, 3, 4].map((tier) => legacy(tier, 'NONE'))).toEqual([150, 250, 435, 775]);
    expect([1, 2, 3, 4].map((tier) => legacy(tier, 'SMALL'))).toEqual([225, 325, 510, 850]);
    expect(legacy(2, 'LARGE')).toBe(500);
  });

  test('the level-1 free-with-plan rule, the add-ons and the urgent multiplier are unchanged', () => {
    const onPlan = priceStingingInsect({ species: 'PAPER_WASP', tier: 1, removal: 'NONE', hasRecurringPest: true });
    expect(onPlan.price).toBe(0);
    // Yellow jackets are never free on a plan.
    expect(priceStingingInsect({ species: 'YJ_GROUND', tier: 1, removal: 'NONE', hasRecurringPest: true }).price).toBe(150);
    expect(priceStingingInsect({ tier: 2, removal: 'SMALL', aggressive: 'MILD', height: 'MID', confined: 'YES' }).price).toBe(275 + 75 + 75 + 100 + 75);
  });

  test('yellow jackets price through the same levels as wasps, in the estimate engine, and the line names them', () => {
    const run = (species, tier, removal, extra = {}) => lineOf(generateEstimate(HOME({
      ...extra, services: { stinging: { species, tier, removal } },
    })), 'stinging_insect');
    for (const species of ['PAPER_WASP', 'YELLOW_JACKET', 'YJ_AERIAL', 'YJ_GROUND']) {
      expect(run(species, 2, 'NONE').price).toBe(275);
      expect(run(species, 2, 'SMALL').price).toBe(350);
    }
    expect(run('YELLOW_JACKET', 2, 'SMALL').name).toBe('Stinging Insect — Yellow Jackets');
    expect(run('YJ_AERIAL', 2, 'NONE').name).toBe('Stinging Insect — Yellow Jackets (aerial)');
    expect(run('YJ_GROUND', 2, 'NONE').name).toBe('Stinging Insect — Yellow Jackets (ground)');
    // The line carries the stamp; an estimate priced before the change keeps $250 and its old (raw) name.
    expect(run('YELLOW_JACKET', 2, 'NONE').legacySpecialty1126).toBe(false);
    const legacy = run('YELLOW_JACKET', 2, 'NONE', LEGACY);
    expect(legacy.price).toBe(250);
    expect(legacy.name).toBe('Stinging Insect — YELLOW_JACKET');
    expect(legacy.legacySpecialty1126).toBe(true);
  });

  test('the call / Intelligence Bar intent species (YELLOW_JACKET) is a species the pricer prices and names', () => {
    const schema = fs.readFileSync(require.resolve('../services/estimator-engine/intent-schema'), 'utf8');
    expect(schema).toContain("'YELLOW_JACKET'");
    expect(priceStingingInsect({ species: 'YELLOW_JACKET', tier: 2, removal: 'SMALL' }).name).toBe('Stinging Insect — Yellow Jackets');
  });

  test('the public price range is $150 to $350 and names yellow jackets', () => {
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const row = computePublicPricingRanges({ refresh: true }).services.find((r) => r.key === 'wasp_hornet_removal');
    expect(row.low).toBe(150);
    expect(row.high).toBe(350);
    expect(row.name).toMatch(/Yellow Jacket/);
    expect(row.notes).toMatch(/yellow jackets/);
  });
});

// ── 4. the stamp: replay, resend, snapshot ─────────────────────────────────────────────────────────────────────────────────
describe('legacySpecialty1126: one stamp for the three rules', () => {
  const SERVICES = {
    bedBug: { rooms: 3, method: 'CHEMICAL', severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily' },
    mosquito: { tier: 'seasonal9' },
    stinging: { species: 'YELLOW_JACKET', tier: 2, removal: 'SMALL' },
  };
  const REQUEST = (services = SERVICES) => HOME({ lotSqFt: 3 * ACRE, services });
  const prices = (est) => ({
    bed: lineOf(est, 'bed_bug')?.price, mq: lineOf(est, 'mosquito')?.perVisit, wasp: lineOf(est, 'stinging_insect')?.price,
  });
  const NEW = { bed: 1375, mq: 207, wasp: 350 };
  const OLD = { bed: 1567, mq: 122, wasp: 325 };
  // Every place the stamp lives (metadata, lines, mapped rows): a quote priced before the rule has none.
  const strip = (value) => JSON.parse(JSON.stringify(value), (key, v) => (key === 'legacySpecialty1126' ? undefined : v));
  const preChangeQuote = (services = SERVICES) => {
    const priced = generateEstimate({ ...REQUEST(services), ...LEGACY });
    return { engineInputs: REQUEST(services), engineResult: strip(priced), result: strip(mapV1ToLegacyShape(priced)) };
  };
  const freshQuote = (services = SERVICES) => {
    const priced = generateEstimate(REQUEST(services));
    return { engineInputs: REQUEST(services), engineResult: priced, result: mapV1ToLegacyShape(priced) };
  };
  const publicReplay = (saved) => prices(generateEstimate(extractEngineInputs(saved)));
  const recompute = async (saved) => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const out = await serverRecomputeFromEstimateData(saved, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(out.recomputed).toBe(true);
    return prices({ lineItems: out.rawEngineResult.lineItems });
  };

  test('a fresh run writes false (metadata and lines); the engine inputs never carry a hand-set true past the signal', () => {
    const fresh = generateEstimate(REQUEST());
    expect(prices(fresh)).toEqual(NEW);
    expect(fresh.pricingMetadata.legacySpecialty1126).toBe(false);
    for (const service of ['bed_bug', 'mosquito', 'stinging_insect']) expect(lineOf(fresh, service).legacySpecialty1126).toBe(false);
    expect(prices(generateEstimate({ ...REQUEST(), ...LEGACY }))).toEqual(OLD);
  });

  test('an unstamped priced estimate replays on main prices, public and authoritative, all three services', async () => {
    const saved = preChangeQuote();
    expect(prices(saved.engineResult)).toEqual(OLD);
    expect(savedLegacySpecialty1126Signal(saved)).toEqual({ legacySpecialty1126: true });
    expect(savedFloorReplaySignals(saved).legacySpecialty1126).toBe(true);
    expect(extractEngineInputs(saved).legacySpecialty1126).toBe(true);
    expect(publicReplay(saved)).toEqual(OLD);
    expect(await recompute(saved)).toEqual(OLD);
    for (const shape of [{ engineResult: saved.engineResult }, { result: saved.result }]) {
      expect(savedLegacySpecialty1126Signal(shape)).toEqual({ legacySpecialty1126: true });
    }
  });

  test('a stamped-legacy estimate (true) replays the same; a stamped-new estimate (false) replays the new prices and survives a posted flag', async () => {
    const legacyStamped = freshQuote();
    legacyStamped.engineResult.pricingMetadata.legacySpecialty1126 = true;
    expect(savedLegacySpecialty1126Signal(legacyStamped)).toEqual({ legacySpecialty1126: true });
    const fresh = freshQuote();
    expect(savedLegacySpecialty1126Signal(fresh)).toEqual({ legacySpecialty1126: false });
    expect(publicReplay(fresh)).toEqual(NEW);
    expect(await recompute(fresh)).toEqual(NEW);
    // A value posted inside the stored inputs never switches the rule; the identity strip drops it.
    const forged = { ...fresh, engineInputs: { ...fresh.engineInputs, legacySpecialty1126: true } };
    expect(publicReplay(forged)).toEqual(NEW);
    expect(sanitizeClientIdentityFields({ legacySpecialty1126: true })).toEqual({});
  });

  test('each service alone is pinned the same way (an estimate priced before the rule never moves)', () => {
    for (const services of [{ bedBug: SERVICES.bedBug }, { mosquito: SERVICES.mosquito }, { stinging: SERVICES.stinging }]) {
      const saved = preChangeQuote(services);
      expect(publicReplay(saved)).toEqual(prices(saved.engineResult));
      expect(savedFloorReplaySignals(saved).legacySpecialty1126).toBe(true);
    }
  });

  test('a snapshot-only quote keeps its sold price after its pricing bundle is invalidated', async () => {
    const bundle = (price) => ({ oneTimeBreakdown: { items: [{ service: 'bed_bug', price }] } });
    const invalidated = (saved) => { const copy = JSON.parse(JSON.stringify(saved)); invalidateSendSnapshotPricingBundle(copy); return copy; };
    const request = () => REQUEST({ bedBug: SERVICES.bedBug });
    const before = { engineInputs: request(), sendSnapshot: { pricingBundle: bundle(1567) } };
    expect(savedLegacySpecialty1126Signal(before)).toEqual({ legacySpecialty1126: true });
    expect(invalidated(before).sendSnapshot.legacySpecialty1126).toBe(true);
    expect(publicReplay(invalidated(before)).bed).toBe(1567);
    expect(await recompute(invalidated(before))).toMatchObject({ bed: 1567 });
    const after = { engineInputs: request(), sendSnapshot: { legacySpecialty1126: false, pricingBundle: bundle(1375) } };
    expect(savedLegacySpecialty1126Signal(after)).toEqual({ legacySpecialty1126: false });
    expect(publicReplay(invalidated(after)).bed).toBe(1375);
    // freezeSnapshotRuleStamps names this stamp beside the others.
    const frozen = { sendSnapshot: { pricingBundle: bundle(1567) }, engineInputs: request() };
    freezeSnapshotRuleStamps(frozen);
    expect(frozen.sendSnapshot.legacySpecialty1126).toBe(true);
  });

  test('an inputs-only estimate asking for any of the three replays on main prices; one asking for none pins nothing', async () => {
    const inputsOnly = (services = SERVICES) => ({ engineInputs: REQUEST(services) });
    expect(savedLegacySpecialty1126Signal(inputsOnly())).toEqual({ legacySpecialty1126: true });
    expect(extractEngineInputs(inputsOnly()).legacySpecialty1126).toBe(true);
    expect(publicReplay(inputsOnly())).toEqual(OLD);
    expect(await recompute(inputsOnly())).toEqual(OLD);
    const exclusionInputs = (service) => ({ services: { [service]: SERVICES[service] } });
    for (const service of ['bedBug', 'mosquito', 'stinging']) {
      for (const saved of [
        { inputs: exclusionInputs(service) }, { engineInput: exclusionInputs(service) }, { result: { inputs: exclusionInputs(service) } },
        JSON.stringify({ engineInputs: exclusionInputs(service) }),
      ]) expect(savedFloorReplaySignals(saved).legacySpecialty1126).toBe(true);
    }
    for (const token of ['BEDBUG', 'MOSQUITO', 'STING']) {
      expect(savedFloorReplaySignals({ engineRequest: { profile: {}, selectedServices: ['PEST', token] } }).legacySpecialty1126).toBe(true);
    }
    expect(savedFloorReplaySignals({ engineInputs: HOME({ services: { flea: {} } }) }).legacySpecialty1126).toBeUndefined();
    expect(savedFloorReplaySignals({ engineRequest: { profile: {}, selectedServices: ['PEST'] } }).legacySpecialty1126).toBeUndefined();
    // A fresh quote (stamped false by the engine) is untouched by the fallback.
    expect(publicReplay(freshQuote())).toEqual(NEW);
  });

  test('a first send and a resend of an inputs-only quote keep the old prices; a stamped-new draft and its resend keep the new', async () => {
    const { buildEstimateSendSnapshot } = require('../routes/admin-estimates');
    const { buildPricingBundle } = require('../routes/estimate-public');
    const build = async (estimateData, row = {}) => {
      buildPricingBundle.mockClear();
      const out = await buildEstimateSendSnapshot({ id: 'est-1', status: 'sending', estimate_data: estimateData, ...row }, () => new Date('2026-11-26T12:00:00Z'), { delivered: false });
      return { handed: buildPricingBundle.mock.calls[0][0].estimate_data, snapshot: out.sendSnapshot };
    };
    const data = { engineInputs: REQUEST() };
    for (const row of [{}, { sent_at: '2026-11-20T15:00:00Z', status: 'sent' }]) {
      const built = await build(data, row);
      expect(built.handed.sendSnapshot.legacySpecialty1126).toBe(true);
      expect(publicReplay(built.handed)).toEqual(OLD);
      expect(built.snapshot.legacySpecialty1126).toBe(true);
    }
    // The resend of a snapshot the first send built: the stamp rides the old snapshot into the new one.
    const first = await build(data);
    const resend = await build({ ...data, sendSnapshot: first.snapshot }, { sent_at: '2026-11-26T12:00:00Z', status: 'sent' });
    expect(resend.snapshot.legacySpecialty1126).toBe(true);
    expect(publicReplay(resend.handed)).toEqual(OLD);
    // A bundle build that throws leaves a snapshot with an error and no stamp: the readback still prices the old figures.
    buildPricingBundle.mockImplementationOnce(async () => { throw new Error('bundle failed'); });
    const failed = await buildEstimateSendSnapshot({ id: 'est-1', status: 'sending', estimate_data: data }, () => new Date('2026-11-26T12:00:00Z'), { delivered: false });
    expect(failed.sendSnapshot.pricingBundleError).toBe('bundle failed');
    expect(publicReplay({ ...data, sendSnapshot: failed.sendSnapshot })).toEqual(OLD);
    // A fresh draft saved by the estimate tool carries the engine's false stamp, on a first send and on a resend.
    const fresh = freshQuote();
    const builtFresh = await build(fresh);
    expect(builtFresh.snapshot.legacySpecialty1126).toBe(false);
    expect(publicReplay(builtFresh.handed)).toEqual(NEW);
    const freshResend = await build({ ...fresh, sendSnapshot: builtFresh.snapshot }, { sent_at: '2026-11-26T12:00:00Z', status: 'sent' });
    expect(freshResend.snapshot.legacySpecialty1126).toBe(false);
    expect(publicReplay(freshResend.handed)).toEqual(NEW);
  });

  test('a service a revision adds to a legacy estimate prices on the new rule; the lines it already had keep theirs', () => {
    const run = (added) => prices(generateEstimate({ ...REQUEST(), ...LEGACY, addedServiceKeys: added }));
    expect(run(['bed_bug'])).toEqual({ ...OLD, bed: NEW.bed });
    expect(run(['mosquito'])).toEqual({ ...OLD, mq: NEW.mq });
    expect(run(['stinging_insect'])).toEqual({ ...OLD, wasp: NEW.wasp });
    // The next revision and replay keep them there (this rule's own list, specialty1126CurrentServices, rides the saved result).
    const added = generateEstimate({ ...REQUEST(), ...LEGACY, addedServiceKeys: ['bed_bug'] });
    // This rule's own list rides the saved result (the flat currentRulesServices predates the rule and is never read for it).
    expect(added.pricingMetadata.specialty1126CurrentServices).toEqual(['bed_bug']);
    const replay = prices(generateEstimate({ ...REQUEST(), ...LEGACY, specialty1126CurrentServices: added.pricingMetadata.specialty1126CurrentServices }));
    expect(replay).toEqual({ ...OLD, bed: NEW.bed });
  });

  test('an old estimate whose flat currentRulesServices lists a service keeps that service\'s OLD price (the list predates this rule)', async () => {
    // A quote sold before the rule: another rule's revision put 'mosquito' in the flat list. No specialty stamp, no line stamp.
    const saved = preChangeQuote();
    saved.engineResult.pricingMetadata.currentRulesServices = ['mosquito', 'bed_bug', 'stinging_insect'];
    saved.result.pricingMetadata.currentRulesServices = ['mosquito', 'bed_bug', 'stinging_insect'];
    expect(savedFloorReplaySignals(saved).currentRulesServices).toEqual(['mosquito', 'bed_bug', 'stinging_insect']);
    expect(savedFloorReplaySignals(saved).specialty1126CurrentServices).toBeUndefined();
    expect(publicReplay(saved)).toEqual(OLD);
    expect(await recompute(saved)).toEqual(OLD);
    expect(lineOf(generateEstimate({ ...REQUEST(), ...LEGACY, currentRulesServices: ['mosquito'] }), 'mosquito').perVisit).toBe(OLD.mq);
    expect(lineOf(generateEstimate({ ...REQUEST(), ...LEGACY, currentRulesServices: ['mosquito'] }), 'mosquito').manualReviewReasons[0]).toBe('mosquito_lot_above_2_acres');
  });

  test('a service a revision added is current by its saved line stamp (raw lines, the mapped result, or the frozen snapshot list); the others stay old', async () => {
    const revised = generateEstimate({ ...REQUEST(), ...LEGACY, addedServiceKeys: ['mosquito'] });
    const saved = { engineInputs: REQUEST(), engineResult: revised, result: mapV1ToLegacyShape(revised) };
    expect(savedFloorReplaySignals(saved).specialty1126CurrentServices).toEqual(['mosquito']);
    expect(savedFloorReplaySignals({ engineResult: revised }).specialty1126CurrentServices).toEqual(['mosquito']);
    expect(savedFloorReplaySignals({ result: saved.result }).specialty1126CurrentServices).toEqual(['mosquito']);
    expect(extractEngineInputs(saved).specialty1126CurrentServices).toEqual(['mosquito']);
    expect(publicReplay(saved)).toEqual({ ...OLD, mq: NEW.mq });
    expect(await recompute(saved)).toEqual({ ...OLD, mq: NEW.mq });
    // The send snapshot freezes the list when its bundle goes, and a posted copy never switches the rule.
    const withBundle = { ...saved, sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items: [{ service: 'bed_bug', price: 1567 }] } } } };
    const copy = JSON.parse(JSON.stringify(withBundle));
    invalidateSendSnapshotPricingBundle(copy);
    expect(copy.sendSnapshot.specialty1126CurrentServices).toEqual(['mosquito']);
    expect(sanitizeClientIdentityFields({ specialty1126CurrentServices: ['mosquito'] })).toEqual({});
  });

  test('lines-only evidence: ANY retained legacy specialty line makes the estimate legacy, in either line order; only the per-service list says what is current', async () => {
    const mosquitoNew = { service: 'mosquito', perVisit: 207, annual: 1863, legacySpecialty1126: false };
    const waspOld = { service: 'stinging_insect', price: 325 }; // sold before the rule: no stamp
    const waspLegacyStamped = { service: 'stinging_insect', price: 325, legacySpecialty1126: true };
    const request = () => REQUEST({ mosquito: SERVICES.mosquito, stinging: SERVICES.stinging });
    for (const wasp of [waspOld, waspLegacyStamped]) {
      for (const lineItems of [[mosquitoNew, wasp], [wasp, mosquitoNew]]) {
        const saved = { engineInputs: request(), engineResult: { lineItems } };
        expect(savedLegacySpecialty1126Signal(saved)).toEqual({ legacySpecialty1126: true });
        expect(savedFloorReplaySignals(saved).specialty1126CurrentServices).toEqual(['mosquito']);
        const replay = prices(generateEstimate(extractEngineInputs(saved)));
        expect(replay.wasp).toBe(OLD.wasp); // the wasp stays $325 ($250 level + the $75 removal)
        expect(replay.mq).toBe(NEW.mq);     // the mosquito line a revision priced under the rule stays on it
        expect(await recompute(saved)).toMatchObject({ wasp: OLD.wasp, mq: NEW.mq });
      }
    }
    // Every retained specialty line stamped false = the whole estimate is on the new rule, in either order.
    const waspNew = { service: 'stinging_insect', price: 350, legacySpecialty1126: false };
    for (const lineItems of [[mosquitoNew, waspNew], [waspNew, mosquitoNew]]) {
      expect(savedLegacySpecialty1126Signal({ engineInputs: request(), engineResult: { lineItems } })).toEqual({ legacySpecialty1126: false });
    }
  });

  test('a staff revision re-prices on the CURRENT rules (owner 2026-09-26, as #8626 / #8631 / the pest PR): a delivered wasp goes $250 -> $275; the customer replay keeps the sent price', async () => {
    const sold = preChangeQuote({ stinging: { species: 'PAPER_WASP', tier: 2, removal: 'NONE' } });
    expect(lineOf(sold.engineResult, 'stinging_insect').price).toBe(250);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    // The staff revision path: the saved inputs, no replay of the saved stamps.
    const revised = await serverRecomputeFromEstimateData(sold, { needsSync: () => false });
    expect(revised.recomputed).toBe(true);
    expect(lineOf({ lineItems: revised.rawEngineResult.lineItems }, 'stinging_insect').price).toBe(275);
    expect(revised.rawEngineResult.pricingMetadata.legacySpecialty1126).toBe(false);
    // The customer's view of the sent quote still replays $250.
    expect(lineOf(generateEstimate(extractEngineInputs(sold)), 'stinging_insect').price).toBe(250);
    expect((await recompute(sold)).wasp).toBe(250);
  });

  test('the add-service rail, compaction paths, identity strip and rate-review pins carry the stamp', () => {
    const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
    expect(read('../services/estimate-add-service-request')).toContain("'legacySpecialty1126'");
    expect(read('../services/estimate-add-service-request')).toContain('legacySpecialty1126: _s');
    expect(read('../services/rate-review')).toContain("'legacySpecialty1126'");
    expect(read('../routes/public-quote')).toContain('legacySpecialty1126: estimate.pricingMetadata.legacySpecialty1126');
    expect(read('../routes/public-quote')).toContain('legacySpecialty1126: item.legacySpecialty1126');
    expect(read('../services/lead-estimate-automation')).toContain('legacySpecialty1126: estimate.pricingMetadata.legacySpecialty1126');
    expect(read('../services/lead-estimate-automation')).toContain('legacySpecialty1126: item.legacySpecialty1126');
    const route = read('../routes/admin-estimates');
    expect(route).toContain('savedLegacySpecialty1126Signal(estimateData).legacySpecialty1126');
    expect(route).toContain('sendSnapshot.legacySpecialty1126 = priorSpecialty === true;');
  });

  test('the browser fallback never stamps the specialty rule (it does not mirror the $349 rooms, the $85 acres or the wasp levels)', () => {
    const client = fs.readFileSync(require.resolve('../../client/src/lib/estimateEngine.js'), 'utf8');
    expect(client).not.toContain('legacySpecialty1126');
  });
});

describe('the fallback save: the specialty stamp (admin-estimate-persistence)', () => {
  const { assertSpecialtyRuleStampForClientPayload: save } = require('../services/admin-estimate-persistence');
  const rows = () => ({
    results: { mq: [{ pv: 117, v: 9, ann: 1053, mo: 87.75, n: 'Seasonal Mosquito Program (9 visits)' }, { pv: 103, v: 12, ann: 1236, mo: 103, n: 'Monthly' }] },
    oneTime: { items: [], specItems: [{ name: 'Bed Bug Chemical', price: 1026, det: '2 rooms, 2 visits' }, { name: 'Wasp/Bee', price: 150, det: 'Standalone removal' }] },
  });
  const payload = (meta = {}, extra = {}) => ({ result: { recurring: { discount: 0, pestProgramFloorApplied: false }, ...rows(), pricingMetadata: { ...meta }, ...extra } });

  test('newly priced bed bug, mosquito or wasp rows need the false stamp; a browser that predates the rule is refused', () => {
    expect(() => save(payload({ legacySpecialty1126: false }))).not.toThrow();
    for (const meta of [{}, { legacySpecialty1126: true }]) {
      expect(() => save(payload(meta))).toThrow(/out of date/);
      try { save(payload(meta)); } catch (err) { expect(err.statusCode).toBe(409); }
    }
    // Each kind alone is gated.
    const only = (rowsOnly) => ({ result: { recurring: { discount: 0, pestProgramFloorApplied: false }, ...rowsOnly, pricingMetadata: {} } });
    expect(() => save(only({ results: { mq: rows().results.mq } }))).toThrow(/out of date/);
    expect(() => save(only({ oneTime: { items: [], specItems: [rows().oneTime.specItems[0]] } }))).toThrow(/out of date/);
    expect(() => save(only({ oneTime: { items: [], specItems: [rows().oneTime.specItems[1]] } }))).toThrow(/out of date/);
  });

  test('the browser\'s real output shape: pest + a tier-2 wasp keeps the $0 on-program row only in the full specItems list, and the save is refused', () => {
    // calculateEstimate returns specItems (the full list, onProg rows included) at the result root; oneTime.specItems drops them.
    const pestAndWasp = () => ({ result: {
      recurring: { discount: 0, pestProgramFloorApplied: false },
      results: { pest: { pa: 112, apps: 4, ann: 448, mo: 37.33, label: 'Quarterly' } },
      oneTime: { items: [], specItems: [] },
      specItems: [{ name: 'Wasp/Bee', price: 0, det: 'Included on Quarterly program', onProg: true }],
      pricingMetadata: {},
    } });
    expect(() => save(pestAndWasp())).toThrow(/out of date/);
    try { save(pestAndWasp()); } catch (err) { expect(err.statusCode).toBe(409); }
    // The browser never sends the stamp, so even a payload with a forged-true stamp is not a new-rule save.
    const legacyStamped = pestAndWasp();
    legacyStamped.result.pricingMetadata.legacySpecialty1126 = true;
    expect(() => save(legacyStamped)).toThrow(/out of date/);
    // The same rows exactly as the stored estimate has them keep the stored stamp (an old quote re-saved elsewhere).
    const stored = pestAndWasp();
    stored.result.pricingMetadata.legacySpecialty1126 = true;
    const resave = pestAndWasp();
    expect(() => save(resave, { storedEstimateData: stored })).not.toThrow();
    expect(resave.result.pricingMetadata.legacySpecialty1126).toBe(true);
  });

  test('a 3-acre mosquito client save on an unmeasured lot is refused too; the server keeps its unverified-area hold', () => {
    const mosquitoOnly = { result: { recurring: { discount: 0, pestProgramFloorApplied: false }, results: { mq: rows().results.mq }, oneTime: { items: [] }, pricingMetadata: {} } };
    expect(() => save(mosquitoOnly)).toThrow(/out of date/);
    // The server pricer is the one that holds an unmeasured lot, at the flat price, with the unverified-area reason.
    const unmeasured = priceMosquito({ lotSqFt: 3 * ACRE, footprint: 2000, homeSqFt: 2000, stories: 1, features: {} }, { tier: 'seasonal9', lotSizeMeasured: false });
    expect(unmeasured.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
    expect(unmeasured.perVisit).toBe(117);
    const line = lineOf(generateEstimate(HOME({ lotSqFt: 3 * ACRE, lotSizeMeasured: false, services: { mosquito: { tier: 'seasonal9' } } })), 'mosquito');
    expect(line.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
  });

  test('a payload with none of the three rows, or not from the browser fallback, is not gated', () => {
    expect(() => save({ result: { recurring: { discount: 0, pestProgramFloorApplied: false }, results: {}, oneTime: { items: [] }, pricingMetadata: {} } })).not.toThrow();
    expect(() => save({ result: { recurring: { discount: 0 }, ...rows(), pricingMetadata: {} } })).not.toThrow();
  });

  test('unchanged rows keep the TRUSTED stored stamp: an old browser re-saves an old quote, and a forged false is overwritten', () => {
    const stored = payload({ legacySpecialty1126: true });
    const resave = payload({});
    expect(() => save(resave, { storedEstimateData: stored })).not.toThrow();
    expect(resave.result.pricingMetadata.legacySpecialty1126).toBe(true);
    const forged = payload({ legacySpecialty1126: false });
    expect(() => save(forged, { storedEstimateData: stored })).not.toThrow();
    expect(forged.result.pricingMetadata.legacySpecialty1126).toBe(true);
    // A stored quote with no stamp anywhere (priced rows = legacy) is stamped legacy; the browser's false is dropped.
    const unstamped = payload({ legacySpecialty1126: false });
    expect(() => save(unstamped, { storedEstimateData: payload({}) })).not.toThrow();
    expect(unstamped.result.pricingMetadata.legacySpecialty1126).toBe(true);
    // Key order of the stored rows does not matter.
    const reordered = payload({});
    reordered.result.results.mq = reordered.result.results.mq.map((row) => Object.fromEntries(Object.entries(row).reverse()));
    expect(() => save(reordered, { storedEstimateData: stored })).not.toThrow();
  });

  test('a repriced row (a room added) is a new price: it needs the false stamp again', () => {
    const stored = payload({ legacySpecialty1126: true });
    const changed = payload({});
    changed.result.oneTime.specItems[0].price = 1375;
    expect(() => save(changed, { storedEstimateData: stored })).toThrow(/out of date/);
    const stamped = payload({ legacySpecialty1126: false });
    stamped.result.oneTime.specItems[0].price = 1375;
    expect(() => save(stamped, { storedEstimateData: stored })).not.toThrow();
    expect(stamped.result.pricingMetadata.legacySpecialty1126).toBe(false);
  });
});

