// GOOGLE key must exist before geocoder.js is required — it captures the env at module load.
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-key';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { rejectGeocodeResult, geocodeAddressWithStatus } = require('../services/geocoder');
const { isInServiceAreaBox, SERVICE_AREA_BOUNDS } = require('../services/service-area');

const rooftop = (lat, lng, extra = {}) => ({
  types: ['street_address'],
  geometry: { location: { lat, lng }, location_type: 'ROOFTOP' },
  ...extra,
});

describe('isInServiceAreaBox', () => {
  test('Bradenton is in, Fort Worth / Ontario / a half-set pair are out', () => {
    expect(isInServiceAreaBox(27.4989, -82.5748)).toBe(true);
    expect(isInServiceAreaBox('27.4989', '-82.5748')).toBe(true);
    // Served south-Hillsborough cities (SOUTH_HILLSBOROUGH_CITIES) sit north
    // of the Manatee county line and must stay inside the box.
    expect(isInServiceAreaBox(27.886, -82.326)).toBe(true); // Riverview
    expect(isInServiceAreaBox(27.853, -82.383)).toBe(true); // Gibsonton
    expect(isInServiceAreaBox(27.771, -82.407)).toBe(true); // Apollo Beach
    expect(isInServiceAreaBox(32.7555, -97.3308)).toBe(false);
    expect(isInServiceAreaBox(43.65, -79.38)).toBe(false);
    expect(isInServiceAreaBox(27.4989, null)).toBe(false);
    expect(isInServiceAreaBox(undefined, undefined)).toBe(false);
    expect(isInServiceAreaBox(NaN, -82.5)).toBe(false);
  });

  test('edges are inclusive', () => {
    expect(isInServiceAreaBox(SERVICE_AREA_BOUNDS.latMin, SERVICE_AREA_BOUNDS.lngMax)).toBe(true);
    expect(isInServiceAreaBox(SERVICE_AREA_BOUNDS.latMax, SERVICE_AREA_BOUNDS.lngMin)).toBe(true);
  });
});

describe('rejectGeocodeResult', () => {
  test('accepts a rooftop, range-interpolated, premise or subpremise hit inside the box', () => {
    expect(rejectGeocodeResult(rooftop(27.34, -82.53))).toBeNull();
    expect(rejectGeocodeResult({
      types: ['route'],
      geometry: { location: { lat: 27.34, lng: -82.53 }, location_type: 'RANGE_INTERPOLATED' },
    })).toBeNull();
    expect(rejectGeocodeResult({
      types: ['premise'],
      geometry: { location: { lat: 27.34, lng: -82.53 }, location_type: 'GEOMETRIC_CENTER' },
    })).toBeNull();
    expect(rejectGeocodeResult({
      types: ['subpremise'],
      geometry: { location: { lat: 27.34, lng: -82.53 }, location_type: 'GEOMETRIC_CENTER' },
    })).toBeNull();
  });

  test('rejects the shapes that put false coordinates on customer rows', () => {
    // "4696" → a New Zealand postal code
    expect(rejectGeocodeResult({
      types: ['postal_code'],
      geometry: { location: { lat: -39.43, lng: 175.28 }, location_type: 'APPROXIMATE' },
    })).toBe('coarse_result:postal_code');
    // ZIP centroid returned as a partial match
    expect(rejectGeocodeResult(rooftop(27.34, -82.53, { partial_match: true }))).toBe('partial_match');
    // "Venice" with no state → Venice, Ontario (locality)
    expect(rejectGeocodeResult({
      types: ['locality', 'political'],
      geometry: { location: { lat: 43.65, lng: -79.38 }, location_type: 'APPROXIMATE' },
    })).toBe('coarse_result:locality|political');
    // snowbird mailing address → a real rooftop in Fort Worth
    expect(rejectGeocodeResult(rooftop(32.7555, -97.3308))).toBe('outside_service_area');
    expect(rejectGeocodeResult({ types: [] , geometry: { location: { lat: 27.3, lng: -82.5 } } })).toBe('coarse_result:unknown');
    expect(rejectGeocodeResult(null)).toBe('no_location');
    expect(rejectGeocodeResult({ types: ['street_address'], geometry: {} })).toBe('no_location');
  });
});

describe('geocodeAddressWithStatus with a rejected result', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('a rejected geocode is a permanent null, memoized, and never returned as a coordinate', async () => {
    const payload = { status: 'OK', results: [rooftop(32.7555, -97.3308)] };
    global.fetch = jest.fn(async () => ({ json: async () => payload }));

    const first = await geocodeAddressWithStatus('100 Main St, Fort Worth, TX 76102');
    expect(first).toEqual({ location: null, permanent: true });

    const second = await geocodeAddressWithStatus('100 Main St, Fort Worth, TX 76102');
    expect(second).toEqual({ location: null, permanent: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a venue caller opts out of the guard and shares the memo with the guarded path', async () => {
    // A Tampa point of interest: outside the customer box and not street-level.
    const venue = {
      types: ['establishment', 'point_of_interest'],
      geometry: { location: { lat: 27.9506, lng: -82.4572 }, location_type: 'GEOMETRIC_CENTER' },
    };
    global.fetch = jest.fn(async () => ({ json: async () => ({ status: 'OK', results: [venue] }) }));

    const asVenue = await geocodeAddressWithStatus('Curtis Hixon Park, Tampa, FL', { serviceAddress: false });
    expect(asVenue).toEqual({ location: { lat: 27.9506, lng: -82.4572 }, permanent: false });

    const asCustomer = await geocodeAddressWithStatus('Curtis Hixon Park, Tampa, FL');
    expect(asCustomer).toEqual({ location: null, permanent: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a good rooftop inside the box still resolves', async () => {
    const payload = { status: 'OK', results: [rooftop(27.4989, -82.5748)] };
    global.fetch = jest.fn(async () => ({ json: async () => payload }));
    const out = await geocodeAddressWithStatus('1 Old Main St, Bradenton, FL 34205');
    expect(out).toEqual({ location: { lat: 27.4989, lng: -82.5748 }, permanent: false });
  });

  test('cache-only reads never start provider calls and retain the service-address guard', async () => {
    const address = '100 Fixture Cache Street, Bradenton, FL 34205';
    global.fetch = jest.fn(async () => ({ json: async () => ({
      status: 'OK', results: [rooftop(27.4989, -82.5748)],
    }) }));
    expect(await geocodeAddressWithStatus(address, { cacheOnly: true }))
      .toEqual({ location: null, permanent: false });
    expect(global.fetch).not.toHaveBeenCalled();
    await geocodeAddressWithStatus(address);
    expect(await geocodeAddressWithStatus(address, { cacheOnly: true }))
      .toEqual({ location: { lat: 27.4989, lng: -82.5748 }, permanent: false });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const rejected = '200 Fixture Cache Street, Bradenton, FL 34205';
    global.fetch.mockResolvedValue({ json: async () => ({
      status: 'OK', results: [rooftop(27.4989, -82.5748, { partial_match: true })],
    }) });
    await geocodeAddressWithStatus(rejected, { serviceAddress: false });
    expect(await geocodeAddressWithStatus(rejected, { cacheOnly: true }))
      .toEqual({ location: null, permanent: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
