/**
 * Parent parcel (address-match PR 6, GATE_LOOKUP_BUSINESS_IDENTITY). A
 * storefront with its own street number inside a plaza parcel fails the situs
 * guard; the parcel's facts are dropped, and WHICH commercial parcel the point
 * sits in is kept as context. Synthetic fixtures only: no real address,
 * parcel id or coordinate.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('no database in this suite'); });
  db.raw = jest.fn(() => { throw new Error('no database in this suite'); });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/property-lookup/county-parcel-gis', () => {
  const actual = jest.requireActual('../services/property-lookup/county-parcel-gis');
  return { ...actual, lookupCountyParcelByPoint: jest.fn() };
});

const { pointToPolygonEdgeMeters } = require('../services/property-lookup/parcel-gis');
const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { _private, lookupPropertyFromAITrio, hasCountyEvidence } = require('../services/property-lookup/ai-property-lookup');
const { buildBusinessScopeContext } = require('../services/property-lookup/business-scope');

const { applyGisParcelGuards } = _private;

// A square about 111 m on a side around (27.4, -82.5).
const LAT = 27.4;
const LNG = -82.5;
const HALF = 0.0005;
const square = [[
  [LNG - HALF, LAT - HALF], [LNG + HALF, LAT - HALF], [LNG + HALF, LAT + HALF], [LNG - HALF, LAT + HALF], [LNG - HALF, LAT - HALF],
]];

const plazaParcel = (over = {}) => ({
  parcelId: 'EXAMPLE-PARCEL',
  paoParcelId: 'EXAMPLE-PARCEL',
  county: 'Examplecounty',
  situsAddress: '900 Example Rd',
  dorUseCode: '1600',
  landUseDescription: 'Community Shopping Centers',
  polygon: square,
  lotSqft: 600000,
  livingAreaSqft: 50000,
  ...over,
});

const TYPED = '100 Example Plaza Dr, Examplecity, FL 00000';
const guard = (parcel, over = {}) => applyGisParcelGuards(parcel, {
  searchAddress: TYPED, address: TYPED, gisPrecision: 'rooftop', point: { lat: LAT, lng: LNG }, ...over,
});

beforeEach(() => { process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true'; });
afterEach(() => { delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY; delete process.env.GATE_COMMERCIAL_SUITE_SIZING; });

describe('pointToPolygonEdgeMeters', () => {
  test('the center of a ~111 m square is ~55 m (north-south) or ~49 m (east-west) from the line: the nearer one wins', () => {
    const d = pointToPolygonEdgeMeters(square, LNG, LAT);
    expect(d).toBeGreaterThan(45);
    expect(d).toBeLessThan(56);
  });

  test('a point 2 m inside the line reads about 2 m', () => {
    const twoMetersLat = 2 / 111320;
    const d = pointToPolygonEdgeMeters(square, LNG, LAT + HALF - twoMetersLat);
    expect(d).toBeGreaterThan(1.5);
    expect(d).toBeLessThan(2.5);
  });

  test('no usable ring or point → null', () => {
    expect(pointToPolygonEdgeMeters(null, LNG, LAT)).toBeNull();
    expect(pointToPolygonEdgeMeters([[]], LNG, LAT)).toBeNull();
    expect(pointToPolygonEdgeMeters(square, NaN, LAT)).toBeNull();
  });
});

describe('the situs guard and the parent parcel', () => {
  test('gate off (the default): the parcel is dropped and nothing is kept, exactly as before', () => {
    const out = guard(plazaParcel());
    expect(out.parcel).toBeNull();
    expect(out.dropReason).toBe('situs_house_number_mismatch');
    expect(out.parentParcel).toBeNull();
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

    test('a rooftop point well inside a shopping-center parcel with another situs: the facts are still dropped, the parent parcel is kept as context', () => {
      const out = guard(plazaParcel());
      expect(out.parcel).toBeNull();
      expect(out.dropReason).toBe('situs_house_number_mismatch');
      expect(out.parentParcel).toEqual({
        parcelId: 'EXAMPLE-PARCEL',
        county: 'Examplecounty',
        situsAddress: '900 Example Rd',
        dorUseCode: '1600',
        landUseDescription: 'Community Shopping Centers',
        precision: 'rooftop',
        edgeDistanceM: expect.any(Number),
      });
      expect(out.parentParcel.edgeDistanceM).toBeGreaterThanOrEqual(5);
    });

    test('the context never carries the parcel\'s lot, building or polygon figures', () => {
      const { parentParcel } = guard(plazaParcel());
      for (const key of ['lotSqft', 'livingAreaSqft', 'polygon', 'polygonAreaSqft', 'residentialUnits']) {
        expect(parentParcel).not.toHaveProperty(key);
      }
      expect(JSON.stringify(parentParcel)).not.toMatch(/600000|50000/);
    });

    test('the suite-sizing gate off keeps nothing', () => {
      delete process.env.GATE_COMMERCIAL_SUITE_SIZING;
      expect(guard(plazaParcel()).parentParcel).toBeNull();
    });

    test('an interpolated point is a guess along the street: nothing kept', () => {
      const out = guard(plazaParcel(), { gisPrecision: 'interpolated' });
      expect(out.parcel).toBeNull();
      expect(out.parentParcel).toBeNull();
    });

    test('a point closer than 5 m to the parcel line may be the neighbor\'s: nothing kept', () => {
      const out = guard(plazaParcel(), { point: { lat: LAT + HALF - (2 / 111320), lng: LNG } });
      expect(out.parentParcel).toBeNull();
    });

    test.each([
      ['an apartment complex (multifamily)', '0300'],
      ['a condominium', '0400'],
      ['a single-family parcel', '0100'],
      ['a mobile home park', '2800'],
      ['a hotel', '3900'],
      ['an industrial parcel', '4100'],
      ['no use code', null],
    ])('%s is never a parent parcel', (_label, dorUseCode) => {
      expect(guard(plazaParcel({ dorUseCode, landUseDescription: null })).parentParcel).toBeNull();
    });

    test('a typed dwelling unit means a resident, not a storefront: nothing kept', () => {
      const typed = '100 Example Plaza Dr Apt 4, Examplecity, FL 00000';
      expect(guard(plazaParcel(), { searchAddress: typed, address: typed }).parentParcel).toBeNull();
    });

    test('a parcel whose situs matches the typed number is simply kept; there is no parent parcel', () => {
      const out = guard(plazaParcel({ situsAddress: '100 Example Plaza Dr' }));
      expect(out.parcel).not.toBeNull();
      expect(out.dropReason).toBeNull();
      expect(out.parentParcel).toBeNull();
    });

    test('a point 20 m OUTSIDE the parcel line is not inside it: nothing kept', () => {
      const out = guard(plazaParcel(), { point: { lat: LAT + HALF + (20 / 111320), lng: LNG } });
      expect(out.parentParcel).toBeNull();
    });

    test('a point inside a HOLE in the parcel is outside the parcel: nothing kept', () => {
      const H = 0.0003;
      const hole = [[LNG - H, LAT - H], [LNG - H, LAT + H], [LNG + H, LAT + H], [LNG + H, LAT - H], [LNG - H, LAT - H]];
      expect(guard(plazaParcel({ polygon: [square[0], hole] })).parentParcel).toBeNull();
      // Between the hole and the outer line (about 11 m from each) it is inside.
      const between = { lat: LAT + 0.0004, lng: LNG };
      expect(guard(plazaParcel({ polygon: [square[0], hole] }), { point: between }).parentParcel).not.toBeNull();
    });

    test('the shared unit predicate decides: a building designator is not a unit, a bare trailing unit is', () => {
      const bldg = '100 Example Plaza Dr Bldg #2, Examplecity, FL 00000';
      expect(guard(plazaParcel(), { searchAddress: bldg, address: bldg }).parentParcel).not.toBeNull();
      const bare = '100 Example Plaza Dr 201, Examplecity, FL 00000';
      expect(guard(plazaParcel(), { searchAddress: bare, address: bare }).parentParcel).toBeNull();
    });

    test('a parcel with no polygon cannot prove the point is inside it: nothing kept', () => {
      expect(guard(plazaParcel({ polygon: null })).parentParcel).toBeNull();
    });
  });
});

describe('the scope suggestion', () => {
  const identity = {
    source: 'google_places',
    matched: { placeId: 'places/EXAMPLE1', name: 'Example Nail Bar', primaryType: 'nail_salon', type: 'salon_spa', subpremise: null },
    matchedCount: 1, ambiguous: false, tenantsAtNumber: 1, neighbors: 5,
  };

  test('part-building evidence (which a parent parcel supplies) suggests one space; it never decides', () => {
    const ctx = buildBusinessScopeContext({
      identity, baseCategory: 'RESIDENTIAL', baseSubtype: null, scopeSignals: { countyPartBuildingEvidence: true },
    });
    expect(ctx.decision).toBe('scope_unresolved');
    expect(ctx.profileFields.serviceScopeSuggestion).toBe('suite');
  });
});

describe('the whole lookup when every fact provider fails', () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn().mockRejectedValue(new Error('provider down')); });
  afterEach(() => { global.fetch = realFetch; lookupCountyParcelByPoint.mockReset(); });
  const geo = { lat: LAT, lng: LNG, locationType: 'ROOFTOP', county: 'Examplecounty' };

  test('gate on: a facts-free record carries the parent parcel, and does not read as county evidence', async () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    lookupCountyParcelByPoint.mockResolvedValue(plazaParcel());
    const record = await lookupPropertyFromAITrio(TYPED, geo, null, { commercialSuiteSizing: true });
    expect(record).not.toBeNull();
    // Never cached: a failed lookup with a note attached stays retryable.
    expect(record._contextOnly).toBe(true);
    expect(record._parentParcel).toMatchObject({ parcelId: 'EXAMPLE-PARCEL', situsAddress: '900 Example Rd' });
    expect(record.squareFootage || 0).toBe(0);
    expect(record.lotSize || 0).toBe(0);
    expect(record._parcel).toBeUndefined();
    expect(hasCountyEvidence(record)).toBe(false);
  });

  test('gate on but the caller did not opt in: no record at all, as before', async () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    lookupCountyParcelByPoint.mockResolvedValue(plazaParcel());
    expect(await lookupPropertyFromAITrio(TYPED, geo)).toBeNull();
  });

  test('saveLookup never caches a context-only record', async () => {
    const cache = require('../services/property-lookup/lookup-cache');
    const db = require('../models/db');
    const result = (propertyRecord) => ({
      propertyRecord, satellite: { lat: LAT, lng: LNG }, aiAnalysis: {}, enriched: {}, meta: {},
    });
    await cache.saveLookup(TYPED, result({ _contextOnly: true, _parentParcel: { parcelId: 'EXAMPLE-PARCEL' } }));
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    // Control: an ordinary record does reach the database.
    await cache.saveLookup(TYPED, result({ squareFootage: 2000, _source: 'county' }));
    expect(db.mock.calls.length + db.raw.mock.calls.length).toBeGreaterThan(0);
  });

  test('gate off: no record at all, as before', async () => {
    lookupCountyParcelByPoint.mockResolvedValue(plazaParcel());
    expect(await lookupPropertyFromAITrio(TYPED, geo, null, { commercialSuiteSizing: true })).toBeNull();
  });
});

describe('who sees the parent parcel', () => {
  const { _private: route } = require('../routes/property-lookup-v2');
  const result = () => ({ propertyRecord: { squareFootage: 0, _parentParcel: { parcelId: 'EXAMPLE-PARCEL' } }, enriched: {}, meta: {} });

  test('with the identity gate off, even an opted-in caller gets the record without a cached parent parcel', () => {
    const shared = result();
    const view = route.withoutParentParcelUnlessOptedIn(shared, { commercialSuiteSizing: true });
    expect(view.propertyRecord).not.toHaveProperty('_parentParcel');
  });

  test('an opted-in caller keeps it; every other caller gets a copy of the record without it', () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    const shared = result();
    expect(route.withoutParentParcelUnlessOptedIn(shared, { commercialSuiteSizing: true })).toBe(shared);
    const publicView = route.withoutParentParcelUnlessOptedIn(shared, {});
    expect(publicView.propertyRecord).not.toHaveProperty('_parentParcel');
    expect(publicView.propertyRecord.squareFootage).toBe(0);
    // The shared result (and the cache row behind it) is not touched.
    expect(shared.propertyRecord._parentParcel).toEqual({ parcelId: 'EXAMPLE-PARCEL' });
  });

  test('the legacy rentcast alias of the same record is stripped too, and stays the same object as propertyRecord', () => {
    const record = { squareFootage: 0, _parentParcel: { parcelId: 'EXAMPLE-PARCEL' } };
    const publicView = route.withoutParentParcelUnlessOptedIn({ propertyRecord: record, rentcast: record, meta: {} }, {});
    expect(publicView.rentcast).not.toHaveProperty('_parentParcel');
    expect(publicView.rentcast).toBe(publicView.propertyRecord);
    expect(JSON.stringify(publicView)).not.toMatch(/EXAMPLE-PARCEL/);
    // A separate rentcast object carrying it is stripped as well.
    const split = route.withoutParentParcelUnlessOptedIn({ propertyRecord: null, rentcast: { _parentParcel: { parcelId: 'EXAMPLE-PARCEL' } } }, {});
    expect(JSON.stringify(split)).not.toMatch(/EXAMPLE-PARCEL/);
  });

  test('a record with no parent parcel, or no record, passes through as it is', () => {
    const plain = { propertyRecord: { squareFootage: 2000 } };
    expect(route.withoutParentParcelUnlessOptedIn(plain, {})).toBe(plain);
    const none = { propertyRecord: null };
    expect(route.withoutParentParcelUnlessOptedIn(none, {})).toBe(none);
  });
});
