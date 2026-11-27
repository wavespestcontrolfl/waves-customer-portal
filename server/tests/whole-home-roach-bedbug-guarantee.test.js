/**
 * Whole-home sizing for the cockroach treatment, the bed bug treatment and the yearly rodent guarantee (owner ruling
 * 2026-11-26 "fix this", same rule as flea: total living area, not the ground-floor footprint). One-time pest and the
 * recurring pest program are NOT part of this change.
 *
 * Replay contract (the #8654 pattern, plan-wide): the engine stamps pricingMetadata.legacyWholeHomeSizing on every run, false
 * on a fresh quote. A priced estimate with no stamp, or one that kept only inputs asking for one of the three services, was
 * quoted on the ground-floor footprint and keeps it (estimate-floor-signal-replay.js savedLegacyWholeHomeSizingSignal), and
 * a legacy quote runs main's code path unchanged. One of the three added to a legacy estimate stays on the footprint.
 * Regressions it guards: a sent quote rising when the rule ships; an old quote read as new for lack of a stamp on any save
 * shape (lines only, mapped result, snapshot only, a dropped snapshot bundle, inputs only); the bed bug added-room rule
 * (#8648) and this size basis disagreeing; the browser fallback disagreeing with the server.
 */

jest.mock('../models/db', () => {
  const chain = () => {
    const builder = {
      orderBy: () => builder,
      where: () => builder,
      whereNotIn: () => builder,
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  };
  const db = jest.fn(() => chain());
  db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => new Proxy({}, {
  get: (_target, name) => (name === '__esModule' ? false : (_req, _res, next) => next()),
}));

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const sp = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const replay = require('../services/estimate-floor-signal-replay');
const { extractEngineInputs } = require('../routes/estimate-public');
const { buildEstimateServiceRevisionDraft } = require('../services/estimate-add-service-request');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');

const HOMES = [2000, 2800, 3500];
const ROACH_SERVICES = { pestInitialRoach: { roachType: 'regular' } };
const BED_BUG_SERVICES = { bedBug: { rooms: 2, method: 'CHEMICAL', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' } };
const GUARANTEE_SERVICES = {
  rodentGuarantee: { eligibility: { trappingCompleted: true, exclusionCompleted: true, noActivityAfterFinalTrapCheck: true } },
};

const home = (homeSqFt, stories, extra = {}) => ({ homeSqFt, stories, lotSqFt: 9000, ...extra });
const lineOf = (estimate, service) => estimate.lineItems.find((line) => line.service === service);
const bedBugServices = (rooms) => ({ bedBug: { ...BED_BUG_SERVICES.bedBug, rooms } });
// Every price below marked "main" was computed by running the same inputs through origin/main's engine (00bbc3972b) before this
// change: the legacy path must return exactly these.
const roach = (homeSqFt, stories, extra) => lineOf(generateEstimate({ ...home(homeSqFt, stories, extra), services: ROACH_SERVICES }), 'pest_initial_roach');
const bedBug = (homeSqFt, stories, extra) => lineOf(generateEstimate({ ...home(homeSqFt, stories, extra), services: BED_BUG_SERVICES }), 'bed_bug');
const guarantee = (homeSqFt, stories, extra, services = GUARANTEE_SERVICES) => lineOf(generateEstimate({ ...home(homeSqFt, stories, extra), services }), 'rodent_guarantee');

describe('cockroach treatment prices on the whole home', () => {
  test('a two-story home pays what a one-story home of the same living area pays (2,800 sq ft: $289, was $202.50)', () => {
    expect(roach(2800, 1).price).toBe(289);
    expect(roach(2800, 2).price).toBe(289);
    expect(roach(2800, 2, { legacyWholeHomeSizing: true }).price).toBe(202.5);
  });

  test('2,000 / 2,800 / 3,500 sq ft, one and two stories', () => {
    for (const homeSqFt of HOMES) {
      expect(roach(homeSqFt, 2).price).toBe(roach(homeSqFt, 1).price);
    }
    expect(HOMES.map((homeSqFt) => roach(homeSqFt, 2).price)).toEqual([239, 289, 289]);
    // The ground-floor basis it replaces.
    expect(HOMES.map((homeSqFt) => roach(homeSqFt, 2, { legacyWholeHomeSizing: true }).price)).toEqual([202.5, 202.5, 239]);
  });

  test('the roach added by a recurring pest plan sizes on the whole home too', () => {
    const planRoach = (homeSqFt, stories, extra) => lineOf(generateEstimate({
      ...home(homeSqFt, stories, extra), services: { pest: { frequency: 'quarterly', roachType: 'REGULAR' } },
    }), 'pest_initial_roach');
    expect(planRoach(3000, 2).price).toBe(169);
    expect(planRoach(3000, 2, { legacyWholeHomeSizing: true }).price).toBe(139);
  });

  test('the recurring pest program itself did not move (footprint-priced, out of scope)', () => {
    const pest = (extra) => lineOf(generateEstimate({ ...home(3000, 2, extra), services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    expect(pest({}).annual).toBe(pest({ legacyWholeHomeSizing: true }).annual);
  });

  test('the line says which basis priced it', () => {
    expect(roach(2800, 2).homeSizeBasis).toBe('total_living_area');
    expect(roach(2800, 2, { legacyWholeHomeSizing: true }).homeSizeBasis).toBe('ground_floor');
    expect(roach(2800, 2).legacyWholeHomeSizing).toBe(false);
    expect(roach(2800, 2, { legacyWholeHomeSizing: true }).legacyWholeHomeSizing).toBe(true);
  });

  test('an unclear size never raises a price without review: a building measurement on a multi-story home goes to review', () => {
    const line = sp.pricePestInitialRoach({ buildingSqFt: 2000, stories: 2 }, { roachType: 'regular', standalone: true });
    // Read as a living area (never inflated): the lower bracket, with a person confirming the total.
    expect(line.price).toBe(239);
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons).toContain('home_size_source_unclear');
    const clear = sp.pricePestInitialRoach({ homeSqFt: 2000, stories: 2 }, { roachType: 'regular', standalone: true });
    expect(clear.manualReviewReasons).not.toContain('home_size_source_unclear');
    // Beside an unmeasured building the first reason is unchanged (the website quote and the lead draft report reasons[0]).
    const both = sp.pricePestInitialRoach({ homeSqFt: 2600, buildingSqFt: 2600, stories: 2 }, { roachType: 'regular', standalone: true, buildingSizeMeasured: false });
    expect(both.manualReviewReasons).toEqual(['building_size_unmeasured_pest_footprint', 'home_size_source_unclear']);
    // A quote priced before the rule carries neither the size reason nor the warning.
    const legacy = sp.pricePestInitialRoach({ buildingSqFt: 2000, stories: 2, wholeHomeSizingLegacy: true }, { roachType: 'regular', standalone: true });
    expect(legacy.manualReviewReasons).not.toContain('home_size_source_unclear');
    expect(legacy.homeSizeBasis).toBe('ground_floor');
  });

  test('the living area beats a supplied footprint; a footprint alone is read x stories; nothing known keeps the 2,000 review fallback', () => {
    expect(sp.pricePestInitialRoach({ homeSqFt: 2800, footprint: 900, stories: 2 }, { roachType: 'regular', standalone: true }).price).toBe(289);
    expect(sp.pricePestInitialRoach({ footprint: 1400, stories: 2 }, { roachType: 'regular', standalone: true }).price).toBe(289);
    const unknown = sp.pricePestInitialRoach({ stories: 2 }, { roachType: 'regular', standalone: true });
    expect(unknown.footprintSource).toBe('fallback_2000');
    expect(unknown.requiresManualReview).toBe(true);
  });

  test('a unit-scoped association aggregate keeps the pest footprint rules (never prices a summed living area)', () => {
    const line = generateEstimate({ ...home(120000, 1, { footprintUnknown: true }), services: ROACH_SERVICES });
    expect(lineOf(line, 'pest_initial_roach')?.footprintSource).not.toBe('homeSqFt');
  });
});

describe('bed bug treatment prices on the whole home', () => {
  test('the size modifier steps on total living area: a two-story home of 2,800 sq ft gets the one-story size step', () => {
    const one = bedBug(2800, 1);
    const two = bedBug(2800, 2);
    expect(one.multipliers.footprint).toBe(1.1);
    expect(two.multipliers.footprint).toBe(1.1);
    expect(two.footprintUsed).toBe(2800);
    // The separate two-story access multiplier (x1.05) is a labor factor and stays.
    expect(two.multipliers.stories).toBe(1.05);
    expect(two.price).toBeGreaterThan(one.price);
    expect(bedBug(2800, 2, { legacyWholeHomeSizing: true }).multipliers.footprint).toBe(1);
  });

  test('2,000 / 2,800 / 3,500 sq ft, one and two stories: two-story differs from one-story only by the x1.05 story factor', () => {
    const prices = (stories, extra) => HOMES.map((homeSqFt) => bedBug(homeSqFt, stories, extra).price);
    // Two rooms: the first room with its factors, plus the flat $349 added room (#8648).
    expect(prices(1)).toEqual([821, 843, 843]);
    expect(prices(2)).toEqual([844, 868, 868]);
    // main: every one of these two-story homes has a ground floor under 1,800 sq ft, so no size step.
    expect(prices(2, { legacyWholeHomeSizing: true })).toEqual([821, 821, 821]);
    for (const homeSqFt of HOMES) {
      const one = bedBug(homeSqFt, 1);
      const two = bedBug(homeSqFt, 2);
      expect(two.multipliers.footprint).toBe(one.multipliers.footprint);
    }
  });

  test('whole-home heat with no separate heat area uses the total living area', () => {
    const heat = (extra, property) => sp.priceBedBugTreatment({ stories: 2, ...property, ...extra }, {
      rooms: 2, method: 'HEAT', equipment: 'INHOUSE', heatScope: 'WHOLE_HOME', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily',
    });
    expect(heat({}, { homeSqFt: 3000, footprint: 1500 }).sqftBasedPrice).toBe(6000);
    // No living area: the footprint x stories is the whole home, not the ground floor alone.
    expect(heat({}, { footprint: 1500 }).sqftBasedPrice).toBe(6000);
    expect(heat({ wholeHomeSizingLegacy: true }, { footprint: 1500 }).sqftBasedPrice).toBe(3000);
  });

  test('with no size at all the modifier stays 1 and the line goes to review, as before', () => {
    const line = sp.priceBedBugTreatment({}, { rooms: 1, method: 'CHEMICAL', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' });
    expect(line.multipliers.footprint).toBe(1);
    expect(line.requiresManualReview).toBe(true);
  });

  test('a building measurement on a multi-story home is read as a living area and routed to review', () => {
    const line = sp.priceBedBugTreatment({ buildingSqFt: 3000, stories: 2 }, { rooms: 1, method: 'CHEMICAL', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' });
    expect(line.multipliers.footprint).toBe(1.1);
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons).toContain('home_size_source_unclear');
  });

  test('an existing estimate keeps the footprint basis on replay, a fresh one stamps the new basis', () => {
    expect(bedBug(3500, 2).homeSizeBasis).toBe('total_living_area');
    expect(bedBug(3500, 2, { legacyWholeHomeSizing: true }).homeSizeBasis).toBe('ground_floor');
  });
});

describe('bed bug added rooms ($349 each, #8648) compose with the size basis', () => {
  const price = (rooms, extra) => lineOf(generateEstimate({ ...home(2800, 2, extra), services: bedBugServices(rooms) }), 'bed_bug');

  test('new quote, two-story 2,800 sq ft: the first room takes the whole-home size step, each added room is a flat $349', () => {
    expect([1, 2, 3].map((rooms) => price(rooms).price)).toEqual([519, 868, 1217]);
    expect(price(2).price - price(1).price).toBe(349);
    expect(price(3).price - price(2).price).toBe(349);
    expect(price(2)).toMatchObject({ addedRoomsTotal: 349, addedRoomPrice: 349, homeSizeBasis: 'total_living_area' });
    // The size step multiplies the first room only: one room on the whole home is the one-room footprint price x 1.10.
    expect(price(1).multipliers.footprint).toBe(1.1);
    expect(price(3).multipliers.footprint).toBe(1.1);
  });

  test('footprint basis, new room rule (a quote priced between the two changes): main\'s numbers, the same flat $349', () => {
    const legacy = (rooms) => price(rooms, { legacyWholeHomeSizing: true });
    expect([1, 2, 3].map((rooms) => legacy(rooms).price)).toEqual([472, 821, 1170]);
    expect(legacy(2).price - legacy(1).price).toBe(349);
    expect(legacy(1).multipliers.footprint).toBe(1);
  });

  test('both rules legacy (a quote priced before either): main\'s old room curve on the footprint', () => {
    const oldest = (rooms) => price(rooms, { legacyWholeHomeSizing: true, legacySpecialty1126: true });
    expect([1, 2, 3].map((rooms) => oldest(rooms).price)).toEqual([472, 786, 1101]);
  });

  test('the two stamps are independent: the old room curve on the whole-home basis is priced as each stamp says', () => {
    const mixed = (rooms) => price(rooms, { legacySpecialty1126: true });
    expect(mixed(1).price).toBe(519);
    expect(mixed(2).addedRoomsTotal).toBeUndefined();
    expect(mixed(2).homeSizeBasis).toBe('total_living_area');
    expect(mixed(2).legacySpecialty1126).toBe(true);
    expect(mixed(2).legacyWholeHomeSizing).toBe(false);
  });
});

describe('the yearly rodent guarantee prices on the whole home', () => {
  test('a two-story home above 4,000 sq ft total is an estate home (was complex on its ground-floor footprint)', () => {
    expect(guarantee(4500, 2).tier).toBe('estate');
    expect(guarantee(4500, 2).price).toBe(299);
    expect(guarantee(4500, 2, { legacyWholeHomeSizing: true }).price).toBe(249);
    expect(guarantee(4500, 1).price).toBe(299);
  });

  test('2,000 / 2,800 / 3,500 sq ft, one and two stories', () => {
    expect(HOMES.map((homeSqFt) => guarantee(homeSqFt, 1).price)).toEqual([199, 249, 249]);
    expect(HOMES.map((homeSqFt) => guarantee(homeSqFt, 2).price)).toEqual([249, 249, 249]);
    expect(HOMES.map((homeSqFt) => guarantee(homeSqFt, 2, { legacyWholeHomeSizing: true }).price)).toEqual([249, 249, 249]);
  });

  test('a caller that passes its own homeSqFt (the Admin V2 path) is unchanged', () => {
    const line = guarantee(1800, 2, {}, {
      rodentGuarantee: { homeSqFt: 4500, stories: 2, eligibility: GUARANTEE_SERVICES.rodentGuarantee.eligibility },
    });
    expect(line.price).toBe(299);
    const legacy = guarantee(1800, 2, { legacyWholeHomeSizing: true }, {
      rodentGuarantee: { homeSqFt: 4500, stories: 2, eligibility: GUARANTEE_SERVICES.rodentGuarantee.eligibility },
    });
    expect(legacy.price).toBe(299);
  });

  test('no size known keeps the 2,000 default', () => {
    const line = lineOf(generateEstimate({ stories: 1, lotSqFt: 9000, services: GUARANTEE_SERVICES }), 'rodent_guarantee');
    expect(line?.price).toBe(199);
  });

  test('the public price sweep sizes the cockroach and bed bug rows on home size (a 2-story 2,150 sq ft home reads the 2,150 bracket)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/pricing-engine/public-ranges.js'), 'utf8');
    expect(src).toContain('sp.pricePestInitialRoach({ homeSqFt, stories: 1 }');
    expect(src).toContain('{ homeSqFt, stories: 1 },');
  });
});

describe('replay: a quote priced before this change keeps the ground-floor basis', () => {
  const quoteInputs = (homeSqFt, stories, services = ROACH_SERVICES) => home(homeSqFt, stories, { services });
  // main, two-story 2,800 sq ft: stand-alone cockroach $202.50, bed bug two rooms $821, rodent guarantee $249 (4,500 sq ft: $249).
  const soldRoach = { engineResult: { lineItems: [{ service: 'pest_initial_roach', price: 202.5 }] }, engineInputs: quoteInputs(2800, 2) };

  test('the engine stamps the basis on every run, on the metadata and on the three lines', () => {
    expect(generateEstimate(quoteInputs(2800, 2)).pricingMetadata.legacyWholeHomeSizing).toBe(false);
    expect(generateEstimate({ ...quoteInputs(2800, 2), legacyWholeHomeSizing: true }).pricingMetadata.legacyWholeHomeSizing).toBe(true);
    for (const line of [roach(2800, 2), bedBug(2800, 2), guarantee(2800, 2)]) {
      expect(line.legacyWholeHomeSizing).toBe(false);
    }
    for (const line of [roach(2800, 2, { legacyWholeHomeSizing: true }), bedBug(2800, 2, { legacyWholeHomeSizing: true }), guarantee(2800, 2, { legacyWholeHomeSizing: true })]) {
      expect(line.legacyWholeHomeSizing).toBe(true);
    }
    // Only a literal true selects the old basis.
    expect(roach(2800, 2, { legacyWholeHomeSizing: 'true' }).price).toBe(289);
    expect(roach(2800, 2, { legacyWholeHomeSizing: undefined }).price).toBe(289);
  });

  test('a priced estimate with no stamp was quoted on the ground floor: it replays main\'s price through the real signal reader', () => {
    expect(replay.savedLegacyWholeHomeSizingSignal(soldRoach)).toEqual({ legacyWholeHomeSizing: true });
    expect(replay.savedFloorReplaySignals(soldRoach).legacyWholeHomeSizing).toBe(true);
    const replayed = generateEstimate(extractEngineInputs(soldRoach));
    expect(lineOf(replayed, 'pest_initial_roach').price).toBe(202.5);
    expect(replayed.pricingMetadata.legacyWholeHomeSizing).toBe(true);
  });

  test('the stamp is its own key: a quote stamped false by the other 11-26 rules is still legacy here', () => {
    const afterOtherRules = {
      engineResult: {
        pricingMetadata: {
          legacyPricingRules: false, legacyTwoStoryRoof: false, legacyOneTimePestBuffer: false, legacyPestAboveTable: false, legacySpecialty1126: false,
        },
        lineItems: [{ service: 'bed_bug', price: 821, legacySpecialty1126: false }],
      },
      engineInputs: quoteInputs(2800, 2, bedBugServices(2)),
    };
    const signals = replay.savedFloorReplaySignals(afterOtherRules);
    expect(signals.legacyWholeHomeSizing).toBe(true);
    expect(signals.legacySpecialty1126).toBe(false);
    expect(signals.legacyPestAboveTable).toBe(false);
    // The bed bug line keeps what it was sold at: the footprint size step with the flat $349 room.
    expect(lineOf(generateEstimate(extractEngineInputs(afterOtherRules)), 'bed_bug').price).toBe(821);
  });

  test('a stamped estimate reads back the basis it was priced with, and a fresh draft stays on the whole home through the replay path', () => {
    const fresh = generateEstimate(quoteInputs(2800, 2));
    const saved = { engineInputs: quoteInputs(2800, 2), engineResult: fresh, result: mapV1ToLegacyShape(fresh) };
    expect(replay.savedFloorReplaySignals(saved).legacyWholeHomeSizing).toBe(false);
    expect(lineOf(generateEstimate(extractEngineInputs(saved)), 'pest_initial_roach').price).toBe(289);
    const older = generateEstimate({ ...quoteInputs(2800, 2), legacyWholeHomeSizing: true });
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineResult: older }).legacyWholeHomeSizing).toBe(true);
  });

  test('mapped result: the v1-legacy-mapper output keeps the estimate-wide stamp, new and legacy', () => {
    const fresh = mapV1ToLegacyShape(generateEstimate(quoteInputs(2800, 2)));
    expect(fresh.pricingMetadata.legacyWholeHomeSizing).toBe(false);
    const persisted = { engineInputs: quoteInputs(2800, 2), result: fresh };
    expect(replay.savedLegacyWholeHomeSizingSignal(persisted).legacyWholeHomeSizing).toBe(false);
    expect(lineOf(generateEstimate(extractEngineInputs(persisted)), 'pest_initial_roach').price).toBe(289);
    const legacy = { engineInputs: quoteInputs(2800, 2), result: mapV1ToLegacyShape(generateEstimate({ ...quoteInputs(2800, 2), legacyWholeHomeSizing: true })) };
    expect(legacy.result.pricingMetadata.legacyWholeHomeSizing).toBe(true);
    expect(lineOf(generateEstimate(extractEngineInputs(legacy)), 'pest_initial_roach').price).toBe(202.5);
  });

  test('a save path that drops pricingMetadata still reads the stamp from the lines', () => {
    const fresh = roach(2800, 2);
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineResult: { lineItems: [fresh] } })).toEqual({ legacyWholeHomeSizing: false });
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineResult: { lineItems: [{ ...fresh, legacyWholeHomeSizing: true }] } }))
      .toEqual({ legacyWholeHomeSizing: true });
  });

  test('the same replay holds for the bed bug and rodent guarantee lines, and for the roach a pest plan adds', () => {
    // Unstamped, so it predates the bed bug room rule too: main's old room curve on the footprint (3,500 sq ft, two-story, two rooms).
    const storedBedBug = { engineResult: { lineItems: [{ service: 'bed_bug', price: 786 }] }, engineInputs: quoteInputs(3500, 2, BED_BUG_SERVICES) };
    expect(lineOf(generateEstimate(extractEngineInputs(storedBedBug)), 'bed_bug').price).toBe(786);
    const storedGuarantee = { engineResult: { lineItems: [{ service: 'rodent_guarantee', price: 249 }] }, engineInputs: quoteInputs(4500, 2, GUARANTEE_SERVICES) };
    expect(lineOf(generateEstimate(extractEngineInputs(storedGuarantee)), 'rodent_guarantee').price).toBe(249);
    const planServices = { pest: { frequency: 'quarterly', roachType: 'REGULAR' } };
    const storedPlan = { engineResult: { lineItems: [{ service: 'pest_initial_roach', price: 119 }] }, engineInputs: quoteInputs(2800, 2, planServices) };
    expect(lineOf(generateEstimate(extractEngineInputs(storedPlan)), 'pest_initial_roach').price).toBe(119);
    expect(lineOf(generateEstimate(quoteInputs(2800, 2, planServices)), 'pest_initial_roach').price).toBe(169);
  });

  test('an inputs-only estimate asking for one of the three reads legacy; one asking for none pins nothing; a stamped draft stays new', () => {
    const inputsOnly = (services) => ({ engineInputs: quoteInputs(2800, 2, services) });
    for (const services of [ROACH_SERVICES, BED_BUG_SERVICES, GUARANTEE_SERVICES, { pest: { frequency: 'quarterly', roachType: 'REGULAR' } }]) {
      expect(replay.savedLegacyWholeHomeSizingSignal(inputsOnly(services))).toEqual({ legacyWholeHomeSizing: true });
      // The stored text form reads the same.
      expect(replay.savedLegacyWholeHomeSizingSignal(JSON.stringify(inputsOnly(services)))).toEqual({ legacyWholeHomeSizing: true });
    }
    expect(lineOf(generateEstimate(extractEngineInputs(inputsOnly(ROACH_SERVICES))), 'pest_initial_roach').price).toBe(202.5);
    expect(lineOf(generateEstimate(extractEngineInputs(inputsOnly(bedBugServices(1)))), 'bed_bug').price).toBe(472);
    // A pest plan with no roach, or another service, asks for none of the three.
    for (const services of [{ pest: { frequency: 'quarterly' } }, { pest: { frequency: 'quarterly', roachType: 'none' } }, { lawn: {} }, { exclusion: { simple: 2 } }]) {
      expect(replay.savedLegacyWholeHomeSizingSignal(inputsOnly(services))).toEqual({ legacyWholeHomeSizing: undefined });
    }
    expect(replay.savedLegacyWholeHomeSizingSignal({ ...inputsOnly(ROACH_SERVICES), pricingMetadata: { legacyWholeHomeSizing: false } }))
      .toEqual({ legacyWholeHomeSizing: false });
    // The builder request names its services as tokens; the plan's roach rides its option.
    for (const selectedServices of [['ROACH'], ['BEDBUG'], ['RODENT_GUARANTEE'], ['bedbug']]) {
      expect(replay.savedLegacyWholeHomeSizingSignal({ engineRequest: { selectedServices } })).toEqual({ legacyWholeHomeSizing: true });
    }
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineRequest: { selectedServices: ['PEST'], options: { roachModifier: 'REGULAR' } } }))
      .toEqual({ legacyWholeHomeSizing: true });
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineRequest: { selectedServices: ['PEST'], options: { recurringRoachType: 'german' } } }))
      .toEqual({ legacyWholeHomeSizing: true });
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineRequest: { selectedServices: ['LAWN'], options: { standaloneRoachTreatment: true } } }))
      .toEqual({ legacyWholeHomeSizing: true });
    for (const request of [{ selectedServices: ['PEST'] }, { selectedServices: ['PEST'], options: { roachModifier: 'NONE' } }, { selectedServices: ['EXCLUSION', 'LAWN'] }]) {
      expect(replay.savedLegacyWholeHomeSizingSignal({ engineRequest: request })).toEqual({ legacyWholeHomeSizing: undefined });
    }
  });

  test('an estimate with no priced lines and no request pins nothing, so a quote started now takes the whole-home basis', () => {
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineResult: { lineItems: [] } })).toEqual({ legacyWholeHomeSizing: undefined });
    expect(replay.savedLegacyWholeHomeSizingSignal({})).toEqual({ legacyWholeHomeSizing: undefined });
    // The key is present and undefined, so a value left in stored inputs never selects the old basis when the signals are spread over them.
    expect('legacyWholeHomeSizing' in replay.savedFloorReplaySignals({})).toBe(true);
    expect({ legacyWholeHomeSizing: true, ...replay.savedFloorReplaySignals({}) }.legacyWholeHomeSizing).toBeUndefined();
  });

  test('plan-wide: one of the three added to a legacy estimate stays on the footprint, on the revision and on every later replay', () => {
    const base = home(2800, 2, { legacyWholeHomeSizing: true, services: { ...ROACH_SERVICES, ...bedBugServices(1) } });
    // The add-service rail names the added service; this rule has no per-service marker, so it changes nothing.
    const revised = generateEstimate({ ...base, addedServiceKeys: ['pest_initial_roach', 'bed_bug'], currentRulesServices: ['pest_initial_roach', 'bed_bug'] });
    expect(lineOf(revised, 'pest_initial_roach').price).toBe(202.5);
    expect(lineOf(revised, 'bed_bug').price).toBe(472);
    expect(revised.pricingMetadata.legacyWholeHomeSizing).toBe(true);
    expect(lineOf(revised, 'pest_initial_roach').legacyWholeHomeSizing).toBe(true);
    const signals = replay.savedFloorReplaySignals({ engineResult: revised });
    expect(signals.legacyWholeHomeSizing).toBe(true);
    expect(lineOf(generateEstimate({ ...base, ...signals }), 'pest_initial_roach').price).toBe(202.5);
  });

  test('add-service: a service added to a sold cockroach quote leaves the cockroach line as sold, and the replay key never persists in the inputs', async () => {
    const estimate = {
      id: 'estimate-1', token: 'public-token', customer_id: 'customer-1', customer_name: 'Taylor Morgan',
      status: 'sent', address: '123 Main St', monthly_total: 0, annual_total: 0, onetime_total: 202.5, waveguard_tier: 'Bronze',
      estimate_data: {
        inputs: {
          homeSqFt: 2800, stories: 2, lotSqFt: 9000, propertyType: 'single_family', zone: 'A', yearBuilt: 2021,
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' }, paymentMethod: 'card',
          services: ROACH_SERVICES,
        },
        result: { lineItems: [{ service: 'pest_initial_roach', price: 202.5 }] },
      },
    };
    const revision = await buildEstimateServiceRevisionDraft(estimate, 'Seasonal Mosquito');
    expect(revision.status).toBe('priced');
    expect(revision.draftEstimateData.inputs).not.toHaveProperty('legacyWholeHomeSizing');
    const result = revision.draftEstimateData.result;
    expect(result.pricingMetadata.legacyWholeHomeSizing).toBe(true);
    const rows = [...(result.oneTime?.items || []), ...(result.oneTime?.specItems || []), ...(result.specItems || [])];
    expect(rows.find((row) => row.service === 'pest_initial_roach').price).toBe(202.5);
  });

  test('snapshot-only: a priced send bundle with no stamp is legacy, a frozen stamp wins, and freezing keeps it through a bundle drop', () => {
    const bundle = { oneTimeBreakdown: { items: [{ service: 'pest_initial_roach', amount: 202.5 }] } };
    const snapshotOnly = { sendSnapshot: { pricingBundle: bundle } };
    expect(replay.savedLegacyWholeHomeSizingSignal(snapshotOnly)).toEqual({ legacyWholeHomeSizing: true });
    const copy = JSON.parse(JSON.stringify(snapshotOnly));
    replay.freezeSnapshotRuleStamps(copy);
    expect(copy.sendSnapshot.legacyWholeHomeSizing).toBe(true);
    delete copy.sendSnapshot.pricingBundle;
    expect(replay.savedLegacyWholeHomeSizingSignal(copy)).toEqual({ legacyWholeHomeSizing: true });
    expect(replay.savedFloorReplaySignals(copy).legacyWholeHomeSizing).toBe(true);
    // A snapshot that froze the new rule keeps it, with or without its bundle.
    expect(replay.savedLegacyWholeHomeSizingSignal({ sendSnapshot: { legacyWholeHomeSizing: false } })).toEqual({ legacyWholeHomeSizing: false });
    const frozenNew = { sendSnapshot: { legacyWholeHomeSizing: false, pricingBundle: bundle } };
    replay.freezeSnapshotRuleStamps(frozenNew);
    expect(frozenNew.sendSnapshot.legacyWholeHomeSizing).toBe(false);
    // Inputs-only beside a snapshot whose bundle is about to go: the request is the evidence, and it is frozen too.
    const inputsOnly = { engineInputs: quoteInputs(2800, 2), sendSnapshot: { renderedAt: '2026-11-20T15:00:00.000Z' } };
    replay.freezeSnapshotRuleStamps(inputsOnly);
    expect(inputsOnly.sendSnapshot.legacyWholeHomeSizing).toBe(true);
    // Nothing priced and nothing asked for: no stamp is invented.
    const empty = { sendSnapshot: { renderedAt: '2026-11-20T15:00:00.000Z' } };
    replay.freezeSnapshotRuleStamps(empty);
    expect(empty.sendSnapshot).not.toHaveProperty('legacyWholeHomeSizing');
  });

  test('the send snapshot builder reads the stamp before the old snapshot is dropped and freezes it beside the new bundle', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    expect(route).toContain('savedLegacyWholeHomeSizingSignal(estimateData).legacyWholeHomeSizing');
    expect(route).toContain('legacyWholeHomeSizing: priorWholeHomeSizing }');
    expect(route).toContain('sendSnapshot.legacyWholeHomeSizing = priorWholeHomeSizing === true;');
  });

  test('the public wizard and the lead quote keep the stamp when they compact the engine result', () => {
    const pq = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(pq).toContain('legacyWholeHomeSizing: estimate.pricingMetadata.legacyWholeHomeSizing');
    expect(pq).toContain('legacyWholeHomeSizing: item.legacyWholeHomeSizing');
    const lead = fs.readFileSync(path.join(__dirname, '../services/lead-estimate-automation.js'), 'utf8');
    expect(lead).toContain('legacyWholeHomeSizing: estimate.pricingMetadata.legacyWholeHomeSizing');
    const { compactLineItem } = require('../services/lead-estimate-automation');
    expect(compactLineItem(roach(2800, 2)).legacyWholeHomeSizing).toBe(false);
    expect(compactLineItem(roach(2800, 2, { legacyWholeHomeSizing: true })).legacyWholeHomeSizing).toBe(true);
    // The compacted shape (a line with its stamp, no metadata) reads back.
    expect(replay.savedLegacyWholeHomeSizingSignal({ engineResult: { lineItems: [compactLineItem(roach(2800, 2))] } })).toEqual({ legacyWholeHomeSizing: false });
  });

  test('a posted value never switches the rule, and the saved stamp reaches the add-service revision and the list-price replay', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('legacyWholeHomeSizing');
    expect(sanitizeClientIdentityFields({ legacyWholeHomeSizing: false })).toEqual({});
    expect(sanitizeClientIdentityFields({ legacyWholeHomeSizing: true })).toEqual({});
    const request = fs.readFileSync(path.join(__dirname, '../services/estimate-add-service-request.js'), 'utf8');
    expect(request).toContain("'legacyWholeHomeSizing'");
    expect(request).toContain('legacyWholeHomeSizing: _wh');
    const rateReview = fs.readFileSync(path.join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(rateReview).toContain("'legacyWholeHomeSizing'");
  });
});


describe('the deprecated browser estimator mirrors the server on total living area', () => {
  const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
  let calculateEstimate;

  beforeAll(() => {
    const out = esbuild.buildSync({
      stdin: {
        contents: fs.readFileSync(clientEstimatorPath, 'utf8'),
        resolveDir: path.dirname(clientEstimatorPath),
        sourcefile: 'estimateEngine.js',
        loader: 'js',
      },
      bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(module, module.exports, require);
    calculateEstimate = module.exports.calculateEstimate;
  });

  const clientLine = (inputs, match) => {
    const estimate = calculateEstimate({
      lotSqFt: 9000, propertyType: 'single_family', urgency: 'NONE', isAfterHours: false, isRecurringCustomer: false, ...inputs,
    });
    expect(estimate.error).toBeUndefined();
    return [...(estimate.oneTime.items || []), ...(estimate.oneTime.specItems || [])].find(match);
  };

  test('standalone cockroach treatment: a two-story home prices like a one-story home, as the server does', () => {
    for (const homeSqFt of HOMES) {
      const client = (stories) => clientLine({ homeSqFt, stories, svcRoach: true, roachType: 'REGULAR' }, (row) => row.service === 'pest_initial_roach').price;
      expect(client(2)).toBe(client(1));
      expect(client(2)).toBe(roach(homeSqFt, 2).price);
    }
    expect(calculateEstimate({ homeSqFt: 2800, stories: 2, lotSqFt: 9000, propertyType: 'single_family', svcRoach: true, roachType: 'REGULAR' }).pricingMetadata.legacyWholeHomeSizing).toBe(false);
  });

  test('the browser stamp is true to the browser price: a current bundle saves as whole-home, a bundle that predates the rule saves as footprint', () => {
    const inputs = { homeSqFt: 2800, stories: 2, lotSqFt: 9000, propertyType: 'single_family', svcRoach: true, roachType: 'REGULAR' };
    const current = calculateEstimate(inputs);
    expect(current.pricingMetadata.legacyWholeHomeSizing).toBe(false);
    expect(replay.savedLegacyWholeHomeSizingSignal({ inputs, result: current })).toEqual({ legacyWholeHomeSizing: false });
    // A cached bundle from before the rule priced the footprint and posts no stamp: its priced rows read as footprint-priced.
    // (The browser result carries its metadata under both names; the reader takes either.)
    const withoutStamp = (metadata) => Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => key !== 'legacyWholeHomeSizing'));
    const older = { ...current, pricingMetadata: withoutStamp(current.pricingMetadata), routingMetadata: withoutStamp(current.routingMetadata) };
    expect(replay.savedLegacyWholeHomeSizingSignal({ inputs, result: older })).toEqual({ legacyWholeHomeSizing: true });
  });

  test('the plan-added cockroach treatment sizes on the whole home in the browser too', () => {
    const planRoach = (stories) => clientLine({ homeSqFt: 2800, stories, svcPest: true, pestFreq: 4, roachModifier: 'REGULAR' }, (row) => row.service === 'pest_initial_roach');
    expect(planRoach(2).price).toBe(planRoach(1).price);
    expect(planRoach(2).price).toBe(169);
  });

  test('bed bug size step reads total living area (the browser fallback keeps no story factor)', () => {
    const client = (homeSqFt, stories) => clientLine({
      homeSqFt, stories, svcBedbug: true, bedbugRooms: 2, bedbugMethod: 'CHEMICAL',
    }, (row) => row.name === 'Bed Bug Chemical').price;
    for (const homeSqFt of HOMES) expect(client(homeSqFt, 2)).toBe(client(homeSqFt, 1));
  });
});
