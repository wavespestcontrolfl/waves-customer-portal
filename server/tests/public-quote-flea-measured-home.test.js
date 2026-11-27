/**
 * Flea package on the public website quote (owner ruling 2026-11-26 "whole home"): with no home size posted the route used to
 * price the synthetic 2,000 sq ft default. When the SERVER-SIDE lookup measured a residential home (footprint x trusted
 * stories), that whole home is the size. Drives POST /api/public/quote/calculate.
 */
jest.mock('../models/db', () => {
  const recorded = [];
  let seq = 0;
  const makeBuilder = (table) => {
    const state = { table };
    const builder = new Proxy(function builderTarget() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve(state.result !== undefined ? state.result : []).then(resolve, reject);
        }
        if (prop === 'catch') return (reject) => Promise.resolve(state.result !== undefined ? state.result : []).catch(reject);
        if (prop === 'first') return async () => null;
        if (prop === 'insert') {
          return (data) => {
            const rows = Array.isArray(data) ? data : [data];
            rows.forEach((row) => recorded.push({ op: 'insert', table, row }));
            state.result = rows.map(() => ({ id: `id-${seq += 1}` }));
            return builder;
          };
        }
        if (prop === 'update') {
          return (data) => { recorded.push({ op: 'update', table, row: data }); state.result = 1; return builder; };
        }
        if (prop === 'del' || prop === 'delete') return async () => 0;
        if (prop === 'count') return () => { state.result = [{ count: '0' }]; return builder; };
        if (prop === 'returning') return () => builder;
        return () => builder;
      },
      apply() { return builder; },
    });
    return builder;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql) => ({ toSQL: () => sql, sql }));
  db.fn = { now: () => new Date(), uuid: () => 'uuid' };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.__recorded = recorded;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

// The route allows 10 quotes an hour per address; this suite sends more.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

// The route's own cache-only server re-read. A test sets what it answers.
let mockServerLookup = null;
jest.mock('../routes/property-lookup-v2', () => ({
  ...jest.requireActual('../routes/property-lookup-v2'),
  performPropertyLookup: jest.fn(async () => mockServerLookup),
}));

// The catalog gate of a keyed request (the stand-alone cockroach package is reachable only by its catalog key). A test sets the
// rows it answers; with none set a key is unknown, as with the empty database above.
let mockCatalogRows = {};
jest.mock('../services/public-services-menu', () => ({
  ...jest.requireActual('../services/public-services-menu'),
  publicSelectableService: jest.fn(async (key) => mockCatalogRows[key] || null),
}));

const express = require('express');

jest.setTimeout(30000);

describe('POST /api/public/quote/calculate: flea size from the server lookup when no home size is posted', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/quote', require('../routes/public-quote'));
    app.use((err, req, res, next) => res.status(500).json({ error: 'boom' }));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/public/quote`; done(); });
  });
  afterAll((done) => { server.closeAllConnections(); server.close(done); });
  beforeEach(() => { mockServerLookup = null; mockCatalogRows = {}; });

  const quote = async (extra = {}) => {
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Test', lastName: 'Quoter', email: 'flea.size@example.com', phone: '9415550143',
        address: '123 Sample St, Parrish, FL 34219', city: 'Parrish', zip: '34219',
        lotSqFt: 7500, stories: 1, services: { flea: {} }, ...extra,
      }),
    });
    expect(res.status).toBeLessThan(300);
    return res.json();
  };

  const LOOKUP = { enriched: { storiesSource: 'verified', stories: 2, footprint: 1500, homeSqFt: 3000 }, propertyRecord: null };

  test('no home size posted + a server-measured 1,500 sq ft footprint on two stories prices the whole home ($390)', async () => {
    mockServerLookup = LOOKUP;
    expect((await quote()).one_time_total).toBe(390);
  });

  test('a footprint-only lookup (no living area) on two stories prices the whole home; a permit-sourced story count does not double the area', async () => {
    mockServerLookup = { enriched: { storiesSource: 'verified', stories: 2, footprint: 1500 }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(390);
    mockServerLookup = { enriched: { storiesSource: 'permit', stories: 2, footprint: 2000, homeSqFt: 2000 }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
  });

  test('a reliable lookup living area prices the whole home even when the story count is unknown', async () => {
    mockServerLookup = { enriched: { storiesSource: 'default', stories: 1, homeSqFt: 3000 }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(390);
    // An aggregate whose summed living area is not one home never sizes the flea package.
    mockServerLookup = { enriched: { storiesSource: 'default', stories: 1, homeSqFt: 48000, footprintUnknown: true }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
  });

  test('the wizard\'s untouched 2,000 sq ft placeholder uses the server measurement; a confirmed 2,000 sq ft home does not', async () => {
    mockServerLookup = LOOKUP;
    // The wizard posts its enriched profile with the confirm step; a direct API caller posts none, so its explicit size is genuine.
    expect((await quote({ homeSqFt: 2000, buildingSizeConfirmed: false, enriched: {} })).one_time_total).toBe(390);
    expect((await quote({ homeSqFt: 2000, enriched: {} })).one_time_total).toBe(390);
    expect((await quote({ homeSqFt: 2000, buildingSizeConfirmed: true, enriched: {} })).one_time_total).toBe(350);
    expect((await quote({ homeSqFt: 2000, buildingSizeConfirmed: false })).one_time_total).toBe(350);
    expect((await quote({ homeSqFt: 2000 })).one_time_total).toBe(350);
    // A different posted size (a lookup-seeded or hand-entered value) is never replaced.
    const with1800 = (await quote({ homeSqFt: 1800, buildingSizeConfirmed: false, enriched: {} })).one_time_total;
    mockServerLookup = null;
    expect(with1800).toBe((await quote({ homeSqFt: 1800, buildingSizeConfirmed: false, enriched: {} })).one_time_total);
  });

  test('no measured footprint: unchanged, the 2,000 sq ft default and an instant price ($350)', async () => {
    mockServerLookup = null;
    expect((await quote()).one_time_total).toBe(350);
    // A footprint whose story count is only a default is not a trusted footprint (no living area to fall back on).
    mockServerLookup = { enriched: { storiesSource: 'default', stories: 1, footprint: 1500 }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
    // A lookup the verify flags mark unreliable never sizes the package.
    mockServerLookup = { enriched: { ...LOOKUP.enriched, fieldVerifyFlags: [{ field: 'squareFootage', reason: 'conflicting evidence', priority: 'HIGH' }] }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
  });

  test('a confirmed posted home size still wins over the lookup', async () => {
    mockServerLookup = LOOKUP;
    const posted = await quote({ homeSqFt: 2000, buildingSizeConfirmed: true });
    mockServerLookup = null;
    expect(posted.one_time_total).toBe((await quote({ homeSqFt: 2000, buildingSizeConfirmed: true })).one_time_total);
  });

  test('a client-supplied enriched profile never sizes the flea package (only the server lookup does)', async () => {
    mockServerLookup = null;
    const client = await quote({ enriched: { storiesSource: 'verified', stories: 2, footprint: 1500, homeSqFt: 3000, footprintSqFt: 400 } });
    expect(client.one_time_total).toBe(350);
  });

  test('a pest line in the same request is unchanged by the lookup', async () => {
    const withPest = (extra) => quote({ services: { pest: { frequency: 'quarterly' }, flea: {} }, ...extra });
    mockServerLookup = null;
    const base = await withPest();
    mockServerLookup = LOOKUP;
    const looked = await withPest();
    expect(looked.monthly_total).toBe(base.monthly_total);
    expect(looked.annual_total).toBe(base.annual_total);
    expect(looked.one_time_total).toBeGreaterThan(base.one_time_total);
    // And a pest-only quote is identical with and without the lookup.
    mockServerLookup = null;
    const pestOnly = await quote({ services: { pest: { frequency: 'quarterly' } } });
    mockServerLookup = LOOKUP;
    expect((await quote({ services: { pest: { frequency: 'quarterly' } } })).monthly_total).toBe(pestOnly.monthly_total);
  });

  test('a multi-unit parcel never sizes the flea package (its lookup area can be the sum of every unit)', async () => {
    mockServerLookup = { enriched: { ...LOOKUP.enriched, unitCount: 12 }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
    mockServerLookup = { enriched: { ...LOOKUP.enriched, parcel: { residentialUnits: 2 } }, propertyRecord: null };
    expect((await quote()).one_time_total).toBe(350);
  });

  // Whole-home sizing (owner 2026-11-26): the cockroach and bed bug treatments read the same server measurement flea does.
  describe('cockroach and bed bug treatments use the server measurement too', () => {
    const db = require('../models/db');
    const LOOKUP_2800 = { enriched: { storiesSource: 'verified', stories: 2, footprint: 1400, homeSqFt: 2800 }, propertyRecord: null };
    const PLAN_WITH_ROACH = { pest: { frequency: 'quarterly', roachType: 'regular' } };
    const BED_BUG = { bedBug: { rooms: 1, method: 'chemical', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' } };
    // The draft row the quote stored (the compact engine result the replay reads).
    const storedRow = (service) => {
      const drafts = db.__recorded.filter((entry) => entry.row && entry.row.estimate_data);
      const data = drafts[drafts.length - 1].row.estimate_data;
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      return parsed.engineResult.lineItems.find((line) => line.service === service);
    };
    const wizard = (services, extra = {}) => quote({ homeSqFt: 2000, stories: 2, buildingSizeConfirmed: false, enriched: {}, services, ...extra });

    test('the wizard\'s untouched 2,000 sq ft placeholder on a home the lookup measured at 2,800 sq ft: the plan-added cockroach treatment prices 2,800', async () => {
      mockServerLookup = null;
      const placeholder = await wizard(PLAN_WITH_ROACH);
      const placeholderRow = storedRow('pest_initial_roach');
      mockServerLookup = LOOKUP_2800;
      const measured = await wizard(PLAN_WITH_ROACH);
      const measuredRow = storedRow('pest_initial_roach');
      expect(placeholderRow).toMatchObject({ footprintUsed: 2000, footprintSource: 'homeSqFt' });
      // The stored row carries the size, its source and the posted size it replaced: the replay restores the measurement from it.
      expect(measuredRow).toMatchObject({ homeSizeBasis: 'total_living_area', footprintUsed: 2800, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000 });
      const { pricePestInitialRoach } = require('../services/pricing-engine/service-pricing');
      const bracket = (homeSqFt) => pricePestInitialRoach({ homeSqFt, stories: 2 }, { roachType: 'regular' }).price;
      expect(bracket(2800)).toBeGreaterThan(bracket(2000));
      expect(measured.one_time_total - placeholder.one_time_total).toBe(bracket(2800) - bracket(2000));
      // The pest plan itself is unchanged by the lookup (it stays on the footprint of the posted size).
      expect(measured.monthly_total).toBe(placeholder.monthly_total);
    });

    test('a customer-confirmed 2,000 sq ft home is never replaced', async () => {
      mockServerLookup = LOOKUP_2800;
      await wizard(PLAN_WITH_ROACH, { buildingSizeConfirmed: true });
      expect(storedRow('pest_initial_roach')).toMatchObject({ footprintUsed: 2000, footprintSource: 'homeSqFt' });
    });

    test('the bed bug treatment steps on the measured home as well', async () => {
      mockServerLookup = LOOKUP_2800;
      await wizard(BED_BUG);
      expect(storedRow('bed_bug')).toMatchObject({ footprintUsed: 2800, footprintSource: 'lookup_measured_home' });
      await wizard(BED_BUG, { buildingSizeConfirmed: true });
      expect(storedRow('bed_bug')).toMatchObject({ footprintUsed: 2000 });
    });

    // The draft the quote stored, parsed (the record a later staff revision reads).
    const storedDraft = () => {
      const drafts = db.__recorded.filter((entry) => entry.row && entry.row.estimate_data);
      const data = drafts[drafts.length - 1].row.estimate_data;
      return typeof data === 'string' ? JSON.parse(data) : data;
    };

    test('a bed bug draft held for inspection (severe infestation) keeps the measured home: a staff revision that clears the hold prices 2,800, not the placeholder', async () => {
      const { fleaSizeReplayOverrides, fleaPriceRecord, generateWithFleaRecord } = require('../services/estimate-flea-size-replay');
      const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
      mockServerLookup = LOOKUP_2800;
      await wizard({ bedBug: { ...BED_BUG.bedBug, severity: 'severe' } });
      const heldRow = storedRow('bed_bug');
      // Held: the draft parks for a hand quote and the row has no price.
      expect(storedDraft().quoteRequired).toBe(true);
      expect(heldRow.price).toBeNull();
      expect(heldRow).toMatchObject({ homeSizeBasis: 'total_living_area', footprintUsed: 2800, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000 });
      // The replay restores the measurement from the held row, and so does a revision of the draft.
      const draft = storedDraft();
      expect(fleaSizeReplayOverrides(draft)).toMatchObject({ fleaMeasuredHomeSqFt: 2800, homeSqFtIsDefault: true });
      const record = fleaPriceRecord({ status: 'draft', address: '123 Sample St, Parrish, FL 34219' }, draft);
      expect(record).toMatchObject({ basis: 'measured_home', measuredHomeSqFt: 2800, postedHomeSqFt: 2000 });
      // Staff clear the hold (light, not severe) and leave the size alone: the line prices on the measured 2,800 sq ft home.
      const cleared = { homeSqFt: 2000, stories: 2, lotSqFt: 7500, services: { bedBug: { rooms: 1, method: 'CHEMICAL', severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' } } };
      const line = (estimate) => estimate.lineItems.find((item) => item.service === 'bed_bug');
      const revised = line(generateWithFleaRecord(generateEstimate, cleared, record));
      expect(revised).toMatchObject({ footprintUsed: 2800, footprintSource: 'lookup_measured_home' });
      expect(revised.price).toBeGreaterThan(line(generateEstimate(cleared)).price);
      // Staff type a different home size: that size prices, the measurement is not forced over it.
      expect(line(generateWithFleaRecord(generateEstimate, { ...cleared, homeSqFt: 1700 }, record))).toMatchObject({ footprintUsed: 1700, footprintSource: 'homeSqFt' });
    });

    test('the stand-alone cockroach package (keyed): the lookup\'s measured home satisfies its size check, so it prices $289 instantly instead of parking as unmeasured', async () => {
      mockCatalogRows = { cockroach_control: { service_key: 'cockroach_control', name: 'Cockroach Treatment Service', instant: true, booking_enabled: true } };
      const keyed = (extra = {}) => quote({ serviceKey: 'cockroach_control', homeSqFt: 2000, stories: 2, buildingSizeConfirmed: false, enriched: {}, services: {}, ...extra });
      // No lookup measurement: the 2,000 sq ft placeholder is a guess, so the package parks for the team (unchanged).
      mockServerLookup = null;
      const unmeasured = await keyed();
      expect(unmeasured).toMatchObject({ quote_required: true });
      expect(storedDraft().quoteRequiredReason).toBe('building_size_unmeasured_pest_footprint');
      // The server lookup measured 2,800 sq ft: the measured bracket, an instant price, no size hold.
      mockServerLookup = LOOKUP_2800;
      const measured = await keyed();
      expect(measured.quote_required).not.toBe(true);
      expect(measured.one_time_total).toBe(289);
      expect(storedDraft().quoteRequired).toBe(false);
      expect(storedRow('pest_initial_roach')).toMatchObject({
        price: 289, homeSizeBasis: 'total_living_area', footprintUsed: 2800, footprintSource: 'lookup_measured_home', fleaPostedHomeSqFt: 2000,
      });
      // A customer-confirmed 2,000 sq ft home is a measured size of its own: $239, the lookup is not read.
      const confirmed = await keyed({ buildingSizeConfirmed: true });
      expect(confirmed.one_time_total).toBe(239);
      expect(storedRow('pest_initial_roach')).toMatchObject({ footprintUsed: 2000, footprintSource: 'homeSqFt' });
    });

    test('the public size ceiling applies to the measured home a line prices on: a 24,000 sq ft measurement behind the placeholder goes to the team, as a posted 24,000 does', async () => {
      const LOOKUP_24000 = { enriched: { storiesSource: 'verified', stories: 2, footprint: 12000, homeSqFt: 24000 }, propertyRecord: null };
      const LOOKUP_19000 = { enriched: { storiesSource: 'verified', stories: 2, footprint: 9500, homeSqFt: 19000 }, propertyRecord: null };
      mockServerLookup = LOOKUP_24000;
      for (const services of [BED_BUG, { flea: {} }, PLAN_WITH_ROACH]) {
        const parked = await wizard(services);
        expect(parked).toMatchObject({ quote_required: true });
        expect(storedDraft()).toMatchObject({ quoteRequired: true, quoteRequiredReason: 'home_size_above_public_limit' });
      }
      // The same size posted directly parks the same way (unchanged).
      mockServerLookup = null;
      expect(await wizard(BED_BUG, { homeSqFt: 24000, buildingSizeConfirmed: true })).toMatchObject({ quote_required: true });
      expect(storedDraft().quoteRequiredReason).toBe('home_size_above_public_limit');
      // Under the ceiling the measured home still prices instantly.
      mockServerLookup = LOOKUP_19000;
      const under = await wizard(BED_BUG);
      expect(under.quote_required).not.toBe(true);
      expect(storedRow('bed_bug')).toMatchObject({ footprintUsed: 19000, footprintSource: 'lookup_measured_home' });
      // A quote no line of which prices on the measurement is untouched by it (the pest plan stays on the posted size).
      mockServerLookup = null;
      const pestOnly = await wizard({ pest: { frequency: 'quarterly' } });
      mockServerLookup = LOOKUP_24000;
      const pestOnlyLooked = await wizard({ pest: { frequency: 'quarterly' } });
      expect(pestOnlyLooked.quote_required).toBe(pestOnly.quote_required);
      expect(pestOnlyLooked.monthly_total).toBe(pestOnly.monthly_total);
    });

    test('a commercial building keeps its measured footprint: a 6,000 sq ft one-story hotel, two rooms, light chemical, is $992 (not $962 on the 2,000 placeholder)', async () => {
      const saved = process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
      process.env.GATE_COMMERCIAL_ONETIME_SCOPED = 'true';
      try {
        mockServerLookup = null;
        const hotel = await quote({
          homeSqFt: 2000, stories: 1, lotSqFt: 20000, buildingSizeConfirmed: false, isCommercial: true, propertyType: 'commercial', commercialSubtype: 'hotel',
          enriched: { propertyType: 'commercial', isCommercial: true, commercialSubtype: 'hotel', footprintSqFt: 6000, stories: 1 },
          services: { bedBug: { rooms: 2, method: 'chemical', severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } },
        });
        const row = storedRow('bed_bug');
        expect(row).toMatchObject({ price: 992, footprintUsed: 6000, footprintSource: 'footprint', homeSizeBasis: 'ground_floor' });
        expect(row.fleaPostedHomeSqFt).toBeUndefined();
        expect(hotel.one_time_total).toBe(992);
      } finally {
        if (saved === undefined) delete process.env.GATE_COMMERCIAL_ONETIME_SCOPED; else process.env.GATE_COMMERCIAL_ONETIME_SCOPED = saved;
      }
    });
  });

  test('trustedFleaHomeSqFt is the trusted footprint x the trusted stories, or null', () => {
    const { trustedFleaHomeSqFt } = require('../routes/public-quote')._internals;
    expect(trustedFleaHomeSqFt(LOOKUP.enriched, null)).toBe(3000);
    // A footprint alone (no living area) is scaled by the trusted stories.
    expect(trustedFleaHomeSqFt({ storiesSource: 'verified', stories: 2, footprint: 1500 }, null)).toBe(3000);
    // A permit-sourced story count beside a footprint that is the living area / 1 must not count the floor area twice.
    expect(trustedFleaHomeSqFt({ storiesSource: 'permit', stories: 2, footprint: 2000, homeSqFt: 2000 }, null)).toBe(2000);
    expect(trustedFleaHomeSqFt({ storiesSource: 'permit', stories: 2, footprint: 2000, livingAreaSqFt: 2000 }, null)).toBe(2000);
    expect(trustedFleaHomeSqFt({ storiesSource: 'verified', stories: 1, footprint: 1500 }, null)).toBe(1500);
    expect(trustedFleaHomeSqFt({ storiesSource: 'default', stories: 2, footprint: 1500 }, null)).toBeNull();
    expect(trustedFleaHomeSqFt({ storiesSource: 'verified', stories: 2, footprint: 0, footprintUnknown: true, homeSqFt: 48000 }, null)).toBeNull();
    expect(trustedFleaHomeSqFt(null, null)).toBeNull();
  });
});
