/**
 * Business identity at an address (address-match PR 5): the Places request
 * shape, the reply reduction (match, subpremise, tenants, neighbors), the
 * type table and fail-open. Synthetic fixtures only — no real business,
 * address, place id or coordinate.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  identifyBusinessAtAddress,
  buildBusinessIdentity,
  businessIdentityIsFresh,
  businessTypeFor,
  typedStreetParts,
  PLACES_SEARCH_NEARBY_URL,
  PLACES_FIELD_MASK,
  IDENTITY_FRESH_MS,
} = require('../services/property-lookup/business-identity');
const { defaultSuiteSizeBasis } = require('../services/commercial-suite-size/type-defaults');

const ADDRESS = '100 Example Plaza Dr, Examplecity, FL 00000';

function place({
  id = 'places/EXAMPLE1', name = 'Example Nail Bar', primaryType = 'nail_salon', types,
  status = 'OPERATIONAL', number = '100', route = 'Example Plaza Drive', subpremise = null,
} = {}) {
  const components = [];
  if (number) components.push({ longText: number, shortText: number, types: ['street_number'] });
  if (route) components.push({ longText: route, shortText: route, types: ['route'] });
  if (subpremise) components.push({ longText: subpremise, shortText: subpremise, types: ['subpremise'] });
  return {
    id,
    displayName: { text: name, languageCode: 'en' },
    primaryType,
    types: types || [primaryType, 'point_of_interest', 'establishment'],
    businessStatus: status,
    addressComponents: components,
    location: { latitude: 27.4, longitude: -82.5 },
  };
}

describe('request shape', () => {
  const savedKey = process.env.GOOGLE_MAPS_API_KEY;
  beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = 'test-key'; });
  afterEach(() => {
    jest.clearAllMocks();
    if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = savedKey;
  });

  test('posts searchNearby with a 60 m circle at the geocode point and the narrow field mask', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ places: [place()] }) }));
    const identity = await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl });
    expect(identity.matched.name).toBe('Example Nail Bar');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchNearby');
    expect(url).toBe(PLACES_SEARCH_NEARBY_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(init.headers['X-Goog-FieldMask']).toBe(PLACES_FIELD_MASK);
    expect(JSON.parse(init.body)).toEqual({
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: 27.4, longitude: -82.5 }, radius: 60 } },
    });
  });

  test('the field mask names only the seven fields the decision needs — no reviews, phones or hours', () => {
    expect(PLACES_FIELD_MASK.split(',').sort()).toEqual([
      'places.addressComponents', 'places.businessStatus', 'places.displayName', 'places.id',
      'places.location', 'places.primaryType', 'places.types',
    ]);
    expect(PLACES_FIELD_MASK).not.toMatch(/review|phone|hours|website|rating/i);
  });

  test('falls back to GOOGLE_API_KEY when there is no maps key', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const savedApi = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'fallback-key';
    try {
      const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ places: [] }) }));
      await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl });
      expect(fetchImpl.mock.calls[0][1].headers['X-Goog-Api-Key']).toBe('fallback-key');
    } finally {
      if (savedApi === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = savedApi;
    }
  });
});

describe('fail-open', () => {
  const savedKey = process.env.GOOGLE_MAPS_API_KEY;
  beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = 'test-key'; });
  afterEach(() => {
    jest.clearAllMocks();
    if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = savedKey;
  });

  test('no key → null, no request', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const fetchImpl = jest.fn();
    expect(await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('no coordinates, or an address with no street number → null, no request', async () => {
    const fetchImpl = jest.fn();
    expect(await identifyBusinessAtAddress({ address: ADDRESS, lat: null, lng: null, fetchImpl })).toBeNull();
    expect(await identifyBusinessAtAddress({ address: 'Example Plaza Dr, Examplecity, FL', lat: 27.4, lng: -82.5, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('HTTP error, thrown error and unreadable reply are all null', async () => {
    const http500 = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl: http500 })).toBeNull();
    const thrown = jest.fn(async () => { throw new Error('boom'); });
    expect(await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl: thrown })).toBeNull();
    const badJson = jest.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }));
    expect(await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl: badJson })).toBeNull();
  });

  test('a hung request is aborted at the timeout and is null', async () => {
    const fetchImpl = jest.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    const started = Date.now();
    const identity = await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, timeoutMs: 40, fetchImpl });
    expect(identity).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('an empty reply is an answer (nobody here), not a failure', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
    const identity = await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl });
    expect(identity).toMatchObject({ matched: null, matchedCount: 0, tenantsAtNumber: 0, neighbors: 0, ambiguous: false });
  });

  test('logs counts and elapsed time only — never a name, address or place id', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ places: [place(), place({ id: 'places/EXAMPLE2', name: 'Example Pizza', number: '102' })] }) }));
    await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl });
    const failing = jest.fn(async () => { throw new Error('Example Nail Bar 100 Example Plaza Dr'); });
    await identifyBusinessAtAddress({ address: ADDRESS, lat: 27.4, lng: -82.5, fetchImpl: failing });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toMatch(/Example Nail Bar|Example Pizza|Example Plaza|EXAMPLE1|EXAMPLE2|27\.4|82\.5/);
    expect(logged).toMatch(/elapsedMs/);
    expect(logged).toMatch(/tenantsAtNumber/);
  });
});

describe('buildBusinessIdentity', () => {
  test('exactly one operational place at the street number is the match, with its type and subpremise', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [place({ subpremise: '103' })],
    });
    expect(identity.matched).toEqual({
      placeId: 'places/EXAMPLE1', name: 'Example Nail Bar', primaryType: 'nail_salon', type: 'salon_spa', subpremise: '103',
    });
    expect(identity).toMatchObject({ matchedCount: 1, tenantsAtNumber: 1, neighbors: 0, ambiguous: false });
  });

  test('the route compares through the county street normalizer ("Drive" vs "Dr", USPS spellings)', () => {
    const identity = buildBusinessIdentity({
      address: '100 Example Plaza Drive, Examplecity, FL 00000',
      places: [place({ route: 'Example Plaza Dr' })],
    });
    expect(identity.matched).not.toBeNull();
  });

  test('a place at another street number is a neighbor, not a match', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [place({ id: 'places/EXAMPLE2', number: '110' }), place({ id: 'places/EXAMPLE3', number: '120' })],
    });
    expect(identity).toMatchObject({ matched: null, matchedCount: 0, tenantsAtNumber: 0, neighbors: 2, ambiguous: false });
  });

  test('the same number on a different street is not a match', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [place({ route: 'Sample Other Road' })],
    });
    expect(identity.matched).toBeNull();
    expect(identity.neighbors).toBe(1);
  });

  test('closed, temporarily closed and status-less places do not count', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [
        place({ id: 'places/EXAMPLE2', status: 'CLOSED_PERMANENTLY' }),
        place({ id: 'places/EXAMPLE3', status: 'CLOSED_TEMPORARILY' }),
        place({ id: 'places/EXAMPLE4', status: null }),
      ],
    });
    expect(identity).toMatchObject({ matched: null, tenantsAtNumber: 0, neighbors: 0 });
  });

  test('parking lots, ATMs and apartment complexes are not tenants', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [
        place({ id: 'places/EXAMPLE2', primaryType: 'parking', types: ['parking', 'point_of_interest'] }),
        place({ id: 'places/EXAMPLE3', primaryType: 'atm', types: ['atm', 'finance'] }),
        place({ id: 'places/EXAMPLE4', primaryType: 'apartment_complex', types: ['apartment_complex', 'point_of_interest'] }),
      ],
    });
    expect(identity).toMatchObject({ matched: null, tenantsAtNumber: 0, neighbors: 0 });
  });

  test('several operating places share the number: none is picked, and the tenant count carries', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [
        place({ id: 'places/EXAMPLE1' }),
        place({ id: 'places/EXAMPLE2', name: 'Example Pizza', primaryType: 'pizza_restaurant' }),
        place({ id: 'places/EXAMPLE3', name: 'Example Dental', primaryType: 'dentist' }),
      ],
    });
    expect(identity).toMatchObject({ matched: null, matchedCount: 3, tenantsAtNumber: 3, ambiguous: true });
    expect(identity.ambiguousType).toBe('office_retail');
    expect(identity.tenantPlaceKey).toBe('places/EXAMPLE1|places/EXAMPLE2|places/EXAMPLE3');
  });

  test('tenants that all share one type report that type', () => {
    const identity = buildBusinessIdentity({
      address: ADDRESS,
      places: [place({ id: 'places/EXAMPLE1' }), place({ id: 'places/EXAMPLE2', primaryType: 'hair_salon' })],
    });
    expect(identity.ambiguous).toBe(true);
    expect(identity.ambiguousType).toBe('salon_spa');
  });

  test('a typed unit picks the one tenant whose subpremise matches', () => {
    const places = [
      place({ id: 'places/EXAMPLE1', subpremise: '101' }),
      place({ id: 'places/EXAMPLE2', name: 'Example Pizza', primaryType: 'pizza_restaurant', subpremise: '102' }),
    ];
    const identity = buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 102, Examplecity, FL 00000', places });
    expect(identity.matched).toMatchObject({ placeId: 'places/EXAMPLE2', type: 'restaurant_food_service' });
    expect(identity.ambiguous).toBe(false);
    expect(identity.tenantsAtNumber).toBe(2);
  });

  test('a typed unit that matches no tenant (or two) leaves the address ambiguous', () => {
    const places = [place({ id: 'places/EXAMPLE1', subpremise: '101' }), place({ id: 'places/EXAMPLE2', subpremise: '102' })];
    expect(buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 999, Examplecity, FL 00000', places }).ambiguous).toBe(true);
  });

  test('one tenant at the number, in a DIFFERENT suite than the one typed, is not the customer\'s business', () => {
    const places = [place({ id: 'places/EXAMPLE1', subpremise: '101' })];
    const identity = buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 102, Examplecity, FL 00000', places });
    expect(identity.matched).toBeNull();
    // A place with no suite of its own cannot conflict and still matches.
    const noSuite = buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 102, Examplecity, FL 00000', places: [place({ id: 'places/EXAMPLE3' })] });
    expect(noSuite.matched).toMatchObject({ placeId: 'places/EXAMPLE3' });
  });

  test('a typed unit that no tenant matches never borrows the neighbors\' type: shared-building evidence stays, the type is generic', () => {
    const places = [
      place({ id: 'places/EXAMPLE1', subpremise: '101' }),
      place({ id: 'places/EXAMPLE2', primaryType: 'hair_salon', subpremise: '102' }),
    ];
    const identity = buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 999, Examplecity, FL 00000', places });
    expect(identity).toMatchObject({ matched: null, ambiguous: true, tenantsAtNumber: 2, ambiguousType: 'office_retail' });
  });

  test('suite-compatible tenants (no subpremise of their own) still lend a shared type; incompatible ones do not', () => {
    const places = [
      place({ id: 'places/EXAMPLE1' }),
      place({ id: 'places/EXAMPLE2', primaryType: 'hair_salon' }),
      place({ id: 'places/EXAMPLE3', primaryType: 'dentist', subpremise: '102' }),
    ];
    const identity = buildBusinessIdentity({ address: '100 Example Plaza Dr Ste 999, Examplecity, FL 00000', places });
    expect(identity.ambiguousType).toBe('salon_spa');
  });

  test('an address with no street number has no identity', () => {
    expect(buildBusinessIdentity({ address: 'Example Plaza Dr, Examplecity, FL', places: [place()] })).toBeNull();
  });

  test('a malformed reply never throws', () => {
    expect(() => buildBusinessIdentity({ address: ADDRESS, places: [null, 7, {}, { id: 'x' }] })).not.toThrow();
    expect(buildBusinessIdentity({ address: ADDRESS, places: 'nope' }).matched).toBeNull();
  });
});

describe('type table', () => {
  const cases = [
    ['restaurant', 'restaurant_food_service', 1800],
    ['pizza_restaurant', 'restaurant_food_service', 1800],
    ['coffee_shop', 'restaurant_food_service', 1800],
    ['bakery', 'restaurant_food_service', 1800],
    ['bar', 'restaurant_food_service', 1800],
    ['nail_salon', 'salon_spa', 1200],
    ['hair_salon', 'salon_spa', 1200],
    ['barber_shop', 'salon_spa', 1200],
    ['spa', 'salon_spa', 1200],
    ['beauty_salon', 'salon_spa', 1200],
    ['dentist', 'medical_office', 2500],
    ['doctor', 'medical_office', 2500],
    ['medical_clinic', 'medical_office', 2500],
    ['veterinary_care', 'veterinary_clinic', 2500],
    ['preschool', 'school_daycare', 1500],
    ['child_care_agency', 'school_daycare', 1500],
    ['clothing_store', 'office_retail', 1500],
    ['insurance_agency', 'office_retail', 1500],
    [null, 'office_retail', 1500],
  ];
  test.each(cases)('%s → %s, which the suite type default sizes at %i sq ft', (type, subtype, sqft) => {
    expect(businessTypeFor(type, [])).toBe(subtype);
    expect(defaultSuiteSizeBasis({ commercialSubtype: subtype }).sqft).toBe(sqft);
  });

  test('primaryType decides; otherwise the first other type the table knows', () => {
    expect(businessTypeFor('store', ['point_of_interest', 'hair_care'])).toBe('salon_spa');
    expect(businessTypeFor('nail_salon', ['restaurant'])).toBe('salon_spa');
    expect(businessTypeFor('store', ['point_of_interest'])).toBe('office_retail');
  });
});

describe('typedStreetParts', () => {
  test('number and normalized street, unit stripped', () => {
    expect(typedStreetParts('100 Example Plaza Dr Ste 3, Examplecity, FL 00000')).toMatchObject({ number: '100' });
    expect(typedStreetParts('100 Example Plaza Dr Ste 3, Examplecity, FL 00000').key)
      .toBe(typedStreetParts(ADDRESS).key);
    expect(typedStreetParts('no number here')).toBeNull();
  });
});

describe('freshness', () => {
  test('a stamp is fresh for 30 days, then stale; no stamp or a bad date is not fresh', () => {
    const now = Date.now();
    expect(businessIdentityIsFresh({ fetchedAt: new Date(now - 1000).toISOString() }, now)).toBe(true);
    expect(businessIdentityIsFresh({ fetchedAt: new Date(now - IDENTITY_FRESH_MS - 1000).toISOString() }, now)).toBe(false);
    expect(businessIdentityIsFresh({ fetchedAt: 'not a date' }, now)).toBe(false);
    expect(businessIdentityIsFresh(null, now)).toBe(false);
    expect(IDENTITY_FRESH_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
