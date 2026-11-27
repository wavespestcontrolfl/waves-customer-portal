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

  test('whole-home heat heats the resolved whole home, the size the modifier steps on (homeSqFt 1,500 beside livingAreaSqFt 3,000 heats 3,000)', () => {
    // homeSqFt equal to buildingSqFt may be a building measurement, so the resolver takes the explicit living area: 3,000.
    const property = { homeSqFt: 1500, buildingSqFt: 1500, livingAreaSqFt: 3000, stories: 2 };
    const heatOptions = { rooms: 2, method: 'HEAT', equipment: 'INHOUSE', heatScope: 'WHOLE_HOME', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' };
    const line = sp.priceBedBugTreatment(property, heatOptions);
    expect(line).toMatchObject({ footprintUsed: 3000, heatAreaSqFt: 3000, sqftBasedPrice: 6000 });
    expect(line.multipliers.footprint).toBe(1.1);
    // Through the engine too, and the hybrid method reads the same area.
    const engineLine = lineOf(generateEstimate({ ...property, lotSqFt: 9000, services: { bedBug: heatOptions } }), 'bed_bug');
    expect(engineLine).toMatchObject({ footprintUsed: 3000, heatAreaSqFt: 3000, sqftBasedPrice: 6000 });
    expect(sp.priceBedBugTreatment(property, { ...heatOptions, method: 'HYBRID' }).heatAreaSqFt).toBe(3000);
    // A heat area of the treatment's own still wins for the heat charge.
    expect(sp.priceBedBugTreatment(property, { ...heatOptions, heatAreaSqFt: 2200 }).sqftBasedPrice).toBe(4400);
    // A quote priced before the rule: main's two areas, unchanged (heat on homeSqFt 1,500, the modifier on the 750 footprint).
    const legacy = sp.priceBedBugTreatment({ ...property, wholeHomeSizingLegacy: true }, heatOptions);
    expect(legacy).toMatchObject({ footprintUsed: 750, heatAreaSqFt: 1500, sqftBasedPrice: 3000 });
    // No size evidence (an association aggregate): nothing throws, the heat area is read as before and the line goes to review.
    const aggregate = sp.priceBedBugTreatment({ homeSqFt: 120000, stories: 1, footprintUnknown: true }, heatOptions);
    expect(aggregate).toMatchObject({ heatAreaSqFt: 120000, requiresManualReview: true });
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

  test('a held row (severe infestation, prep refused) carries the same size evidence a priced row does', () => {
    const held = (overrides, extra) => lineOf(generateEstimate({
      ...home(3000, 2, extra), services: { bedBug: { ...BED_BUG_SERVICES.bedBug, ...overrides } },
    }), 'bed_bug');
    for (const overrides of [{ severity: 'severe' }, { prepStatus: 'refused' }]) {
      const line = held(overrides);
      expect(line.quoteRequired).toBe(true);
      expect(line).toMatchObject({ homeSizeBasis: 'total_living_area', footprintUsed: 3000, footprintSource: 'homeSqFt', footprintWasDefaulted: false });
      // A website quote: the lookup's measured home and the posted size it replaced ride on the held row too.
      expect(held(overrides, { homeSqFt: 2000, fleaMeasuredHomeSqFt: 3400, homeSqFtIsDefault: true })).toMatchObject({
        quoteRequired: true, homeSizeBasis: 'total_living_area', footprintUsed: 3400, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000,
      });
      // An unclear size keeps its review reason beside the hold reason.
      expect(held(overrides, { homeSqFt: undefined, buildingSqFt: 3000 }).manualReviewReasons).toEqual(expect.arrayContaining(['home_size_source_unclear']));
      // A quote priced before the rule: the ground-floor footprint, as main held it.
      expect(held(overrides, { legacyWholeHomeSizing: true })).toMatchObject({ homeSizeBasis: 'ground_floor', footprintUsed: 1500, footprintSource: 'footprint' });
      expect(held(overrides, { legacyWholeHomeSizing: true })).not.toHaveProperty('fleaPostedHomeSqFt');
    }
  });
});

describe('a commercial building keeps the footprint path (the whole-home rule is for homes)', () => {
  const GATE = 'GATE_COMMERCIAL_ONETIME_SCOPED';
  let saved;
  beforeEach(() => { saved = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });
  // What public-quote.js hands the engine for a commercial building: the measured footprint beside its 2,000 sq ft homeSqFt default.
  const hotel = (extra = {}) => ({
    isCommercial: true, propertyType: 'commercial', commercialSubtype: 'hotel', homeSqFt: 2000, footprintSqFt: 6000, stories: 1,
    buildingSizeMeasured: true, lotSqFt: 20000,
    services: { bedBug: { method: 'CHEMICAL', rooms: 2, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }, ...extra,
  });

  test('a 6,000 sq ft one-story hotel, two rooms, light chemical: $992 on the measured building, never the 2,000 placeholder', () => {
    const line = lineOf(generateEstimate(hotel()), 'bed_bug');
    expect(line).toMatchObject({ price: 992, footprintUsed: 6000, footprintSource: 'footprint', homeSizeBasis: 'ground_floor' });
    expect(line.requiresManualReview).toBe(false);
    expect(line).not.toHaveProperty('fleaPostedHomeSqFt');
    // The same line a quote priced before the rule replays (main's footprint path).
    const legacy = lineOf(generateEstimate(hotel({ legacyWholeHomeSizing: true })), 'bed_bug');
    for (const key of ['price', 'footprintUsed', 'footprintSource', 'homeSizeBasis', 'multipliers', 'requiresManualReview']) expect(line[key]).toEqual(legacy[key]);
  });

  test('story count, a lookup measurement and a stale home size never move a commercial line off its footprint', () => {
    const base = lineOf(generateEstimate(hotel()), 'bed_bug');
    // The building footprint is not multiplied by the stories, and a measured-home key (never sent for commercial) is not read.
    expect(lineOf(generateEstimate(hotel({ stories: 2 })), 'bed_bug')).toMatchObject({ footprintUsed: 6000, footprintSource: 'footprint' });
    expect(lineOf(generateEstimate(hotel({ fleaMeasuredHomeSqFt: 9000, homeSqFtIsDefault: true })), 'bed_bug')).toMatchObject({ price: base.price, footprintUsed: 6000 });
    expect(lineOf(generateEstimate(hotel({ homeSqFt: 1200 })), 'bed_bug')).toMatchObject({ price: base.price, footprintUsed: 6000 });
    // The same building as a home (residential): the whole-home rule applies and the living area is the size.
    expect(lineOf(generateEstimate(hotel({ isCommercial: false, propertyType: 'single_family', commercialSubtype: undefined })), 'bed_bug'))
      .toMatchObject({ homeSizeBasis: 'total_living_area', footprintUsed: 2000, footprintSource: 'homeSqFt' });
  });

  test('the basis helper reads the engine\'s commercial verdict, for the cockroach treatment and the guarantee size too', () => {
    const commercial = { homeSqFt: 2000, footprintSqFt: 6000, footprint: 6000, stories: 1, wholeHomeSizingCommercial: true };
    expect(sp.pricePestInitialRoach(commercial, { roachType: 'regular' })).toMatchObject({ homeSizeBasis: 'ground_floor', footprintUsed: 6000 });
    expect(sp.pricePestInitialRoach({ ...commercial, wholeHomeSizingCommercial: false }, { roachType: 'regular' }))
      .toMatchObject({ homeSizeBasis: 'total_living_area', footprintUsed: 2000 });
    expect(sp.resolveGuaranteeHomeSize(commercial)).toEqual({ homeSqFt: 6000, lineFields: {} });
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

  test('a story count in the guarantee\'s own options scales a footprint as the same count on the property does (2,300 footprint x 2 = 4,600: $299)', () => {
    const eligibility = GUARANTEE_SERVICES.rodentGuarantee.eligibility;
    const inOptions = (extra) => lineOf(generateEstimate({ footprintSqFt: 2300, lotSqFt: 9000, ...extra, services: { rodentGuarantee: { stories: 2, eligibility } } }), 'rodent_guarantee');
    const onProperty = (extra) => lineOf(generateEstimate({ footprintSqFt: 2300, stories: 2, lotSqFt: 9000, ...extra, services: GUARANTEE_SERVICES }), 'rodent_guarantee');
    expect(inOptions()).toMatchObject({ tier: 'estate', price: 299 });
    expect(onProperty()).toMatchObject({ tier: 'estate', price: 299 });
    // A living area is never scaled: 2,300 sq ft of living area on two stories stays a complex home.
    expect(guarantee(2300, 1, {}, { rodentGuarantee: { stories: 2, eligibility } })).toMatchObject({ tier: 'complex', price: 249 });
    // A quote priced before the rule: main's price for both (the profile's ground-floor footprint).
    expect(inOptions({ legacyWholeHomeSizing: true }).price).toBe(249);
    expect(onProperty({ legacyWholeHomeSizing: true }).price).toBe(249);
  });

  test('a size that may be the ground floor only (two-story, buildingSqFt alone) puts the guarantee line in review', () => {
    const building = (extra) => lineOf(generateEstimate({ buildingSqFt: 2300, stories: 2, lotSqFt: 9000, ...extra, services: GUARANTEE_SERVICES }), 'rodent_guarantee');
    const line = building();
    // Priced as a living area (never inflated), but a ground-floor reading would be 4,600 sq ft and the $299 tier: a person confirms.
    expect(line.price).toBe(249);
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons).toEqual(['home_size_source_unclear']);
    expect(line.warnings).toEqual([expect.stringMatching(/ground floor only/)]);
    // A clear size, a caller's own homeSqFt and a quote priced before the rule carry no mark (the legacy line is main's, key for key).
    for (const clear of [guarantee(2300, 2), building({ legacyWholeHomeSizing: true }),
      guarantee(2300, 2, { buildingSqFt: 2300 }, { rodentGuarantee: { homeSqFt: 2300, eligibility: GUARANTEE_SERVICES.rodentGuarantee.eligibility } })]) {
      expect(clear).not.toHaveProperty('requiresManualReview');
      expect(clear).not.toHaveProperty('manualReviewReasons');
      expect(clear).not.toHaveProperty('warnings');
    }
  });

  test('no size known keeps the 2,000 default price and sends the line to review (a quote priced before the rule: no mark)', () => {
    const unmeasured = (extra) => lineOf(generateEstimate({ stories: 1, lotSqFt: 9000, ...extra, services: GUARANTEE_SERVICES }), 'rodent_guarantee');
    const line = unmeasured();
    expect(line?.price).toBe(199);
    // The shared resolver's own reason for "no usable size" rides on the line, as it does on a cockroach or bed bug line.
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons).toEqual(roach(undefined, 1).manualReviewReasons);
    expect(line.manualReviewReasons.length).toBeGreaterThan(0);
    expect(line.manualReviewReasons).not.toContain('home_size_source_unclear');
    expect(line.warnings.length).toBeGreaterThan(0);
    // An association aggregate (the lookup refused to claim a size): the 2,000 default with the field-measurement reason.
    expect(unmeasured({ homeSqFt: 90000, footprintUnknown: true })).toMatchObject({
      price: 199, requiresManualReview: true, manualReviewReasons: ['footprint_unknown_field_measurement_required'],
    });
    // A two-story home with no size: the story count still picks the tier, and the review still rides.
    expect(unmeasured({ stories: 2 })).toMatchObject({ price: 249, requiresManualReview: true });
    // Legacy: main's line, key for key.
    const legacy = unmeasured({ legacyWholeHomeSizing: true });
    expect(legacy.price).toBe(199);
    expect(legacy).not.toHaveProperty('requiresManualReview');
    expect(legacy).not.toHaveProperty('manualReviewReasons');
    expect(legacy).not.toHaveProperty('warnings');
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


describe('website quote: the server lookup\'s measured home replaces the wizard\'s 2,000 sq ft placeholder for every whole-home service', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
  const { fleaSizeReplayOverrides, fleaPriceRecord, generateWithFleaRecord } = require('../services/estimate-flea-size-replay');
  // What public-quote.js hands the engine when the wizard kept its placeholder and the lookup measured a 2,800 sq ft home.
  const website = (services) => ({ homeSqFt: 2000, stories: 2, lotSqFt: 9000, propertyType: 'single_family', services, fleaMeasuredHomeSqFt: 2800, homeSqFtIsDefault: true });
  const placeholderOnly = (services) => ({ homeSqFt: 2000, stories: 2, lotSqFt: 9000, propertyType: 'single_family', services });
  // The compact row the public writer stores (the fields it carries for a whole-home row).
  const compact = (line) => ({
    service: line.service, name: line.label, price: line.price, legacyWholeHomeSizing: line.legacyWholeHomeSizing,
    homeSizeBasis: line.homeSizeBasis, footprintUsed: line.footprintUsed, footprintSource: line.footprintSource, fleaPostedHomeSqFt: line.fleaPostedHomeSqFt,
  });

  test('cockroach quotes $289 on the measured 2,800 sq ft home, not $239 on the placeholder; bed bug and the plan-added roach follow', () => {
    const line = lineOf(generateEstimate(website(ROACH_SERVICES)), 'pest_initial_roach');
    expect(line).toMatchObject({ price: 289, footprintUsed: 2800, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000 });
    expect(line.requiresManualReview).toBe(false);
    expect(lineOf(generateEstimate(placeholderOnly(ROACH_SERVICES)), 'pest_initial_roach').price).toBe(239);
    expect(lineOf(generateEstimate(website(bedBugServices(1))), 'bed_bug')).toMatchObject({ price: 519, footprintUsed: 2800, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000 });
    expect(lineOf(generateEstimate(website({ pest: { frequency: 'quarterly', roachType: 'regular' } })), 'pest_initial_roach')).toMatchObject({ price: 169, footprintUsed: 2800 });
    expect(lineOf(generateEstimate(website(GUARANTEE_SERVICES)), 'rodent_guarantee').tier).toBe('complex');
    // The pest plan itself stays on the footprint of the posted size (out of scope).
    expect(lineOf(generateEstimate(website({ pest: { frequency: 'quarterly' } })), 'pest_control').footprintUsed)
      .toBe(lineOf(generateEstimate(placeholderOnly({ pest: { frequency: 'quarterly' } })), 'pest_control').footprintUsed);
    // A quote priced before the rule ignores the measurement: main's footprint price.
    expect(lineOf(generateEstimate({ ...website(ROACH_SERVICES), legacyWholeHomeSizing: true }), 'pest_initial_roach')).toMatchObject({ price: 202.5, footprintSource: 'footprint' });
  });

  test('the route sends the measurement whatever the request asks for, but only while the home size is the default; a confirmed size wins', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    // Not tied to a flea request any more: the cockroach and bed bug pricers read the same two keys.
    expect(route).toMatch(/const fleaMeasuredHomeSqFt = !commercialDetected && homeSizeIsDefault\n\s+\? trustedFleaHomeSqFt\(trustedTurf, trustedRecord\)\n\s+: null;/);
    // The default test is unchanged: no posted size, or the wizard's untouched 2,000 placeholder (never a confirmed size).
    expect(route).toContain("const homeSizeIsDefault = !(Number(homeSqFt) > 0) || (wizardShaped && buildingSizeConfirmed !== true && Number(homeSqFt) === 2000);");
    expect(route).toContain("...(fleaMeasuredHomeSqFt ? { fleaMeasuredHomeSqFt, homeSqFtIsDefault: true } : {}),");
    // Its compact row writer keeps the size, its source and the posted size on a cockroach or bed bug row.
    expect(route).toContain('...(item.homeSizeBasis ? { homeSizeBasis: item.homeSizeBasis, footprintUsed: item.footprintUsed, footprintSource: item.footprintSource, fleaPostedHomeSqFt: item.fleaPostedHomeSqFt } : {}),');
    // Without the two keys (a customer-confirmed 2,000 sq ft home) the posted size prices: $239.
    expect(lineOf(generateEstimate(placeholderOnly(ROACH_SERVICES)), 'pest_initial_roach')).toMatchObject({ price: 239, footprintSource: 'homeSqFt' });
  });

  test('the replay restores the measurement from the stored cockroach row only, so a view or accept keeps $289', async () => {
    const fresh = generateEstimate(website(ROACH_SERVICES));
    const row = compact(lineOf(fresh, 'pest_initial_roach'));
    const published = { engineInputs: website(ROACH_SERVICES), engineResult: { pricingMetadata: { legacyWholeHomeSizing: false }, lineItems: [row] } };
    expect(fleaSizeReplayOverrides(published)).toMatchObject({ fleaMeasuredHomeSqFt: 2800, homeSqFtIsDefault: true });
    // The mapped result an Admin save stores keeps the same record, for the bed bug row too.
    expect(fleaSizeReplayOverrides({ result: mapV1ToLegacyShape(fresh) })).toMatchObject({ fleaMeasuredHomeSqFt: 2800, homeSqFtIsDefault: true });
    expect(fleaSizeReplayOverrides({ result: mapV1ToLegacyShape(generateEstimate(website(bedBugServices(1)))) })).toMatchObject({ fleaMeasuredHomeSqFt: 2800 });
    const replayed = await serverRecomputeFromEstimateData(published, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(replayed.recomputed).toBe(true);
    expect(lineOf(replayed.rawEngineResult, 'pest_initial_roach').price).toBe(289);
    // A copy in the stored inputs with no measured row behind it never prices (a browser cannot supply a measurement).
    const forged = { engineInputs: { ...website(ROACH_SERVICES), fleaMeasuredHomeSqFt: 5000 }, engineResult: { pricingMetadata: { legacyWholeHomeSizing: false }, lineItems: [compact(lineOf(generateEstimate(placeholderOnly(ROACH_SERVICES)), 'pest_initial_roach'))] } };
    expect(fleaSizeReplayOverrides(forged)).toMatchObject({ fleaMeasuredHomeSqFt: undefined, homeSqFtIsDefault: undefined });
    const forgedReplay = await serverRecomputeFromEstimateData(forged, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(lineOf(forgedReplay.rawEngineResult, 'pest_initial_roach').price).toBe(239);
  });

  test('the rodent guarantee row records the measured home that chose its tier, and a replay reads it: $299 stays $299, not $249 on the placeholder', async () => {
    // A two-story home the lookup measured at 4,500 sq ft, behind the wizard's 2,000 sq ft placeholder.
    const measured = (services = GUARANTEE_SERVICES) => ({ ...website(services), fleaMeasuredHomeSqFt: 4500 });
    const line = lineOf(generateEstimate(measured()), 'rodent_guarantee');
    expect(line).toMatchObject({
      price: 299, tier: 'estate', homeSizeBasis: 'total_living_area', footprintUsed: 4500, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000,
    });
    expect(lineOf(generateEstimate(placeholderOnly(GUARANTEE_SERVICES)), 'rodent_guarantee')).toMatchObject({ price: 249, footprintUsed: 2000, footprintSource: 'homeSqFt' });
    // The guarantee row alone (no flea, cockroach or bed bug row beside it) restores the measurement on a view or accept.
    const published = { engineInputs: measured(), engineResult: { pricingMetadata: { legacyWholeHomeSizing: false }, lineItems: [compact(line)] } };
    expect(fleaSizeReplayOverrides(published)).toMatchObject({ fleaMeasuredHomeSqFt: 4500, homeSqFtIsDefault: true });
    expect(fleaSizeReplayOverrides({ result: mapV1ToLegacyShape(generateEstimate(measured())) })).toMatchObject({ fleaMeasuredHomeSqFt: 4500 });
    const replayed = await serverRecomputeFromEstimateData(published, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(lineOf(replayed.rawEngineResult, 'rodent_guarantee')).toMatchObject({ price: 299, footprintUsed: 4500 });
    // A staff revision that leaves the size alone keeps it; an edited size prices as typed.
    const record = fleaPriceRecord({ status: 'sent', address: '1 Sample Way' }, { ...published, engineInputs: placeholderOnly(GUARANTEE_SERVICES) });
    expect(record).toMatchObject({ basis: 'measured_home', measuredHomeSqFt: 4500, postedHomeSqFt: 2000 });
    const revised = (inputs) => lineOf(generateWithFleaRecord(generateEstimate, inputs, record), 'rodent_guarantee');
    expect(revised(placeholderOnly(GUARANTEE_SERVICES))).toMatchObject({ price: 299, footprintUsed: 4500 });
    expect(revised({ ...placeholderOnly(GUARANTEE_SERVICES), homeSqFt: 2400 })).toMatchObject({ price: 249, footprintUsed: 2400 });
    // The Admin V2 path copies the profile's size into the guarantee's own options. A copy of the placeholder is not a size:
    // the measured home still tiers the line. A size the operator typed for the guarantee (not the placeholder) is read as given.
    const eligibility = GUARANTEE_SERVICES.rodentGuarantee.eligibility;
    const ownSize = (homeSqFt) => ({ rodentGuarantee: { homeSqFt, stories: 2, eligibility } });
    expect(revised(placeholderOnly(ownSize(2000)))).toMatchObject({ price: 299, footprintUsed: 4500, footprintSource: 'lookup_measured_home' });
    expect(lineOf(generateEstimate(measured(ownSize(3000))), 'rodent_guarantee')).toMatchObject({ price: 249, footprintUsed: 3000, footprintSource: 'service_home_sqft' });
    expect(lineOf(generateEstimate(measured(ownSize(3000))), 'rodent_guarantee')).not.toHaveProperty('fleaPostedHomeSqFt');
    // A quote priced before the rule: main's line, no size field added, and the measurement is not read.
    const legacy = lineOf(generateEstimate({ ...measured(), legacyWholeHomeSizing: true }), 'rodent_guarantee');
    expect(legacy.price).toBe(249);
    for (const key of ['homeSizeBasis', 'footprintUsed', 'footprintSource', 'footprintWasDefaulted', 'fleaPostedHomeSqFt']) expect(legacy).not.toHaveProperty(key);
  });

  test('a staff revision keeps the measured home while the home size is left alone, and re-prices when it is edited', () => {
    const row = compact(lineOf(generateEstimate(website(ROACH_SERVICES)), 'pest_initial_roach'));
    const stored = { engineInputs: placeholderOnly(ROACH_SERVICES), engineResult: { pricingMetadata: { legacyWholeHomeSizing: false }, lineItems: [row] } };
    const record = fleaPriceRecord({ status: 'sent', address: '1 Sample Way' }, stored);
    expect(record).toMatchObject({ basis: 'measured_home', measuredHomeSqFt: 2800, postedHomeSqFt: 2000 });
    const revised = (inputs) => lineOf(generateWithFleaRecord(generateEstimate, inputs, record), 'pest_initial_roach');
    expect(revised(placeholderOnly(ROACH_SERVICES))).toMatchObject({ price: 289, footprintUsed: 2800 });
    expect(revised({ ...placeholderOnly(ROACH_SERVICES), homeSqFt: 2400 })).toMatchObject({ price: 239, footprintUsed: 2400 });
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

  describe('a browser-priced save (the server could not price it)', () => {
    const { guardWholeHomeSizingOnClientFallbackSave, resolveServerAuthoritativePricing } = require('../services/admin-estimate-persistence');
    const inputs = { homeSqFt: 2800, stories: 2, lotSqFt: 9000, propertyType: 'single_family', svcRoach: true, roachType: 'REGULAR' };
    const withoutStamp = (metadata) => Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => key !== 'legacyWholeHomeSizing'));
    const currentBundle = (extraInputs) => ({ inputs: { ...inputs, ...extraInputs }, result: calculateEstimate({ ...inputs, ...extraInputs }) });
    // A page cached before the rule: no stamp anywhere, and the cockroach treatment priced on the 1,400 sq ft ground floor.
    const cachedBundle = (extraInputs) => {
      const save = currentBundle(extraInputs);
      const result = { ...save.result, pricingMetadata: withoutStamp(save.result.pricingMetadata), routingMetadata: withoutStamp(save.result.routingMetadata) };
      for (const row of [...(result.oneTime.items || []), ...(result.oneTime.specItems || [])]) {
        if (row.service === 'pest_initial_roach') row.price = 202.5;
      }
      return { ...save, result };
    };
    const stampOf = (save) => replay.savedLegacyWholeHomeSizingSignal(save).legacyWholeHomeSizing;
    const guard = (save, storedEstimateData = null) => guardWholeHomeSizingOnClientFallbackSave(save, { storedEstimateData });

    test('a browser-priced save with a cockroach or rodent guarantee row is refused, whatever stamp it posts', () => {
      // A page cached before the rule (footprint price, no stamp) and the current page (whole-home price, stamp false) alike:
      // the browser's cockroach brackets are hard-coded, so its stamp cannot prove the price matches Settings.
      for (const save of [cachedBundle(), currentBundle(), cachedBundle({ stories: 1 }), currentBundle({ stories: 1 })]) {
        expect(() => guard(save)).toThrow(expect.objectContaining({ statusCode: 409 }));
      }
      expect(stampOf(currentBundle())).toBe(false);
      const forged = cachedBundle();
      forged.result.pricingMetadata.legacyWholeHomeSizing = true;
      expect(() => guard(forged)).toThrow(expect.objectContaining({ statusCode: 409 }));
      // The cockroach treatment a pest plan adds is refused the same way.
      const planRoach = currentBundle({ svcRoach: false, svcPest: true, pestFreq: 4, roachModifier: 'REGULAR' });
      expect([...(planRoach.result.oneTime.items || []), ...(planRoach.result.oneTime.specItems || [])].some((row) => row.service === 'pest_initial_roach')).toBe(true);
      expect(() => guard(planRoach)).toThrow(expect.objectContaining({ statusCode: 409 }));
      // A rodent guarantee row, a row known only by its name, a camelCase block, a list: every posted shape is read.
      expect(() => guard({ result: { lineItems: [{ service: 'rodent_guarantee', price: 249 }] } })).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard({ result: { oneTime: { specItems: [{ name: 'Cockroach Treatment Service', price: 239 }] } } })).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard({ result: { pestInitialRoach: { price: 239 } } })).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard({ result: { oneTime: { items: [{ name: 'German Roach Cleanout', price: 450 }] } } })).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard([{ service: 'pest_initial_roach', price: 202.5 }])).toThrow(expect.objectContaining({ statusCode: 409 }));
      // Not a cockroach row: "approach" in a note, a lawn row, the pest plan's own roach option with no treatment added.
      expect(() => guard([{ service: 'lawn_care', price: 60, detail: 'A new approach to weeds' }])).not.toThrow();
      expect(() => guard({ result: { lineItems: [{ service: 'pest_control', roachType: 'none', price: 39 }] } })).not.toThrow();
    });

    test('a stored estimate re-saved this way is refused too (no unchanged-resave exception): the server must price it', () => {
      const storedLegacy = cachedBundle();
      expect(() => guard(cachedBundle(), storedLegacy)).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard(currentBundle(), storedLegacy)).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => guard(currentBundle(), currentBundle())).toThrow(expect.objectContaining({ statusCode: 409 }));
    });

    test('a save with none of the rows is not refused, and its stamp is the server\'s reading: new on a first save, the stored estimate\'s on a revision', () => {
      const pestOnly = (bundle) => bundle({ svcRoach: false, roachType: 'NONE', svcPest: true, pestFreq: 4 });
      for (const bundle of [cachedBundle, currentBundle]) {
        const first = pestOnly(bundle);
        expect(() => guard(first)).not.toThrow();
        expect(first.result.pricingMetadata.legacyWholeHomeSizing).toBe(false);
        // A revision of an estimate sold before the rule stays on it (one of the three added later by the server keeps the footprint).
        const revision = pestOnly(bundle);
        expect(() => guard(revision, cachedBundle())).not.toThrow();
        expect(stampOf(revision)).toBe(true);
        // A posted stamp is never read: a forged legacy stamp on a first save is overwritten.
        const forged = pestOnly(bundle);
        forged.result.pricingMetadata.legacyWholeHomeSizing = true;
        guard(forged);
        expect(forged.result.pricingMetadata.legacyWholeHomeSizing).toBe(false);
      }
    });

    test('the check sits on the CLIENT_FALLBACK decision; a server price is untouched', async () => {
      const price = (estimateData, recompute) => resolveServerAuthoritativePricing({
        estimateData, clientPreview: { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 202.5 }, quoteRequired: false, now: () => new Date('2026-11-27T15:00:00Z'), recompute,
      });
      for (const reason of ['NO_INPUTS', 'ENGINE_ERROR']) {
        const recompute = async () => ({ recomputed: false, reason, ...(reason === 'ENGINE_ERROR' ? { error: new Error('down') } : {}) });
        await expect(price(cachedBundle(), recompute)).rejects.toMatchObject({ statusCode: 409 });
        await expect(price(currentBundle(), recompute)).rejects.toMatchObject({ statusCode: 409 });
        const pestOnly = currentBundle({ svcRoach: false, roachType: 'NONE', svcPest: true, pestFreq: 4 });
        const out = await price(pestOnly, recompute);
        expect(out.audit.pricing_authority).toBe('CLIENT_FALLBACK');
        expect(stampOf(pestOnly)).toBe(false);
      }
      const served = cachedBundle();
      const out = await price(served, async () => ({ recomputed: true, serverResult: { recurring: {} }, serverTotals: { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 289 } }));
      expect(out.audit.pricing_authority).toBe('SERVER');
    });
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
