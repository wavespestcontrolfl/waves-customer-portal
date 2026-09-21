/**
 * Plat-median size estimate for an unassessed vacant parcel (new
 * construction the county roll hasn't posted). Real case this encodes
 * (live-probed 2026-09-21): a Lakewood Ranch new-build lot — Manatee
 * roll "Vacant Residential Platted (1554)", DOR '00', BLDGS_SQFT_LIVING 0,
 * lot 9,541 sq ft, while the same plat (a Lakewood Ranch plat) already
 * carried 174 assessed homes, median 3,071 sq ft. The admin lookup showed
 * "Not found" and the estimator priced on a flat 2,000 sq ft.
 *
 * Pins: the fresh path stamps _subdivisionMedian on the record (cache-borne
 * like _floodZone), the enriched profile exposes it as an ESTIMATE beside an
 * empty homeSqFt, the sq ft verify flag names it, and a built record never
 * triggers the plat query at all.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');

const PLAT = 'EXAMPLE ESPLANADE PH VI SUBPH A & B PB80/131';
const trioRecord = { current: null };

jest.mock('../services/property-lookup/ai-property-lookup', () => {
  const actual = jest.requireActual('../services/property-lookup/ai-property-lookup');
  return {
    ...actual,
    lookupPropertyFromAITrio: jest.fn(async () => trioRecord.current()),
    lookupStoriesFromAI: jest.fn(async () => null),
  };
});

// Pass-through mock so one test can make the helper REJECT (the route binds
// it at load time, so a late spy would never be seen).
jest.mock('../services/property-lookup/county-parcel-gis', () => {
  const actual = jest.requireActual('../services/property-lookup/county-parcel-gis');
  return { ...actual, lookupSubdivisionMedianLivingSqft: jest.fn((...args) => actual.lookupSubdivisionMedianLivingSqft(...args)) };
});
const { lookupSubdivisionMedianLivingSqft } = require('../services/property-lookup/county-parcel-gis');
const { performPropertyLookup } = require('../routes/property-lookup-v2');

const ADDRESS = '1010 Example Loop, Lakewood Ranch, FL 34211';

function vacantTrioRecord(overrides = {}) {
  return {
    formattedAddress: ADDRESS,
    county: 'Manatee',
    squareFootage: null,
    yearBuilt: null,
    lotSize: 9541,
    stories: null,
    propertyType: 'Single Family',
    hasPool: false,
    _provider: 'manatee_gis',
    _source: 'county',
    _aiProviders: ['manatee_gis'],
    _fieldEvidence: {
      lotSize: { value: 9541, sourceType: 'county', fieldVerify: false, evidence: [] },
    },
    _raw: { county: 'Manatee', dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)', subdivision: PLAT },
    _parcel: {
      parcelId: '999990002',
      county: 'Manatee',
      polygon: null,
      polygonAreaSqft: 9580,
      lotSqft: 9541,
      dorUseCode: '00',
      landUseDescription: 'Vacant Residential Platted (1554)',
      subdivision: PLAT,
    },
    ...overrides,
  };
}

function fakeTable() {
  const builder = {
    where() { return builder; },
    whereIn() { return builder; },
    orderBy() { return builder; },
    first: async () => null,
    update: async () => {},
    insert() {
      const done = Promise.resolve();
      return {
        onConflict: () => ({ merge: async () => {} }),
        then: (...args) => done.then(...args),
        catch: (...args) => done.catch(...args),
      };
    },
  };
  return builder;
}

const savedEnv = {};
const KEYS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'COUNTY_PARCEL_GIS_DISABLED'];
const originalFetch = global.fetch;
const platQueries = [];

beforeEach(() => {
  for (const key of KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.GOOGLE_MAPS_API_KEY = 'current-maps-key';
  mockDbHandler = () => fakeTable();
  platQueries.length = 0;
  trioRecord.current = () => vacantTrioRecord();

  global.fetch = jest.fn(async (url) => {
    const urlText = String(url);
    if (urlText.includes('geocode')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{
            formatted_address: '1010 Example Loop, Lakewood Ranch, FL 34211, USA',
            geometry: { location: { lat: 27.4678, lng: -82.3852 }, location_type: 'ROOFTOP' },
            address_components: [{ long_name: 'Manatee County', types: ['administrative_area_level_2'] }],
          }],
        }),
      };
    }
    if (urlText.includes('staticmap')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    if (urlText.includes('gis.manateepao.gov') && urlText.includes('BLDGS_SQFT_LIVING')) {
      platQueries.push(decodeURIComponent(urlText).replace(/\+/g, ' '));
      const values = [2101, 2650, 2980, 3050, 3071, 3100, 3120, 3180, 3242];
      return { ok: true, json: async () => ({ features: values.map((v) => ({ attributes: { BLDGS_SQFT_LIVING: v } })) }) };
    }
    throw new Error(`unexpected fetch: ${urlText}`);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('performPropertyLookup — plat median for an unassessed vacant parcel', () => {
  it('stamps the plat median on the record and exposes it as an estimate beside an empty homeSqFt', async () => {
    const result = await performPropertyLookup(ADDRESS, { refresh: true });

    expect(platQueries).toHaveLength(1);
    expect(platQueries[0]).toContain(`LIKE '${PLAT.toUpperCase()}%'`);
    expect(result.propertyRecord._subdivisionMedian).toMatchObject({
      medianSqft: 3071, sampleCount: 9, minSqft: 2101, maxSqft: 3242, county: 'Manatee', subdivisionQueried: PLAT,
    });
    // Never a measurement: the record and the profile still carry no home sqft.
    expect(result.propertyRecord.squareFootage).toBeNull();
    expect(result.enriched.homeSqFt).toBe(0);
    expect(result.enriched.unassessedVacantParcel).toBe(true);
    expect(result.enriched.subdivisionMedian).toMatchObject({ medianSqft: 3071, sampleCount: 9, minSqft: 2101, maxSqft: 3242 });
    const sqftFlag = result.enriched.fieldVerifyFlags.find((f) => f.field === 'homeSqFt');
    expect(sqftFlag.reason).toContain('9 assessed homes');
    expect(sqftFlag.reason).toContain('3,071 sq ft');
  });

  it('accuracy mode (the admin wrapper) queries the plat even when the interactive budget is spent', async () => {
    process.env.PROPERTY_LOOKUP_TOTAL_BUDGET_MS = '1';
    try {
      await performPropertyLookup(ADDRESS, { refresh: true });
      expect(platQueries).toHaveLength(0);
      const result = await performPropertyLookup(ADDRESS, { refresh: true, prioritizeAccuracy: true });
      expect(platQueries).toHaveLength(1);
      expect(result.enriched.subdivisionMedian).toMatchObject({ medianSqft: 3071 });
    } finally {
      delete process.env.PROPERTY_LOOKUP_TOTAL_BUDGET_MS;
    }
  });

  it('stamps an explicit null for a plat the county answered but found too thin — a settled negative', async () => {
    const baseFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('gis.manateepao.gov')) {
        return { ok: true, json: async () => ({ features: [2101, 2200, 2300].map((v) => ({ attributes: { BLDGS_SQFT_LIVING: v } })) }) };
      }
      return baseFetch(url);
    });
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._subdivisionMedian).toBeNull();
    expect('_subdivisionMedian' in result.propertyRecord).toBe(true);
    // Profile reports "withheld" (null), so the call estimator never re-runs the same query.
    expect(result.enriched.subdivisionMedian).toBeNull();
    expect(result.enriched.fieldVerifyFlags.find((f) => f.field === 'homeSqFt').reason).toContain('defaults to 2,000');
  });

  it('is fail-open: a plat-layer outage leaves the lookup intact with no estimate', async () => {
    const baseFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('gis.manateepao.gov')) return { ok: false, status: 503 };
      return baseFetch(url);
    });
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.propertyRecord._subdivisionMedian).toBeUndefined();
    // No stamp → undefined (nothing judged), not the explicit-withheld null.
    expect(result.enriched.subdivisionMedian).toBeUndefined();
    expect(result.enriched.lotSqFt).toBe(9541);
    // Observable: the county helper logs the outage (it resolves null by design).
    expect(logger.warn).toHaveBeenCalledWith(
      '[county-parcel-gis] subdivision median lookup failed',
      expect.objectContaining({ county: 'Manatee', error: expect.stringContaining('503') }),
    );
  });

  it('records an escaped helper failure on result.errors instead of dropping it', async () => {
    lookupSubdivisionMedianLivingSqft.mockRejectedValueOnce(new Error('layer exploded'));
    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.errors).toEqual(expect.arrayContaining([{ source: 'subdivision-median', message: 'layer exploded' }]));
    expect(result.enriched.subdivisionMedian).toBeUndefined();
  });

  it('never queries the plat for a built record or a vacant parcel without a plat name', async () => {
    trioRecord.current = () => vacantTrioRecord({
      squareFootage: 2980,
      yearBuilt: 2025,
      _raw: { county: 'Manatee', dorUseCode: '01', landUseDescription: 'Single Family', subdivision: PLAT },
      _parcel: { parcelId: '999990002', county: 'Manatee', dorUseCode: '01', landUseDescription: 'Single Family', subdivision: PLAT },
    });
    let result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(platQueries).toHaveLength(0);
    expect(result.enriched.subdivisionMedian).toBeUndefined();

    trioRecord.current = () => vacantTrioRecord({
      _raw: { county: 'Manatee', dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)', subdivision: null },
      _parcel: { parcelId: '999990002', county: 'Manatee', dorUseCode: '00', landUseDescription: 'Vacant Residential Platted (1554)' },
    });
    result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(platQueries).toHaveLength(0);
    expect(result.enriched.unassessedVacantParcel).toBe(true);
    expect(result.enriched.subdivisionMedian).toBeUndefined();
  });
});
