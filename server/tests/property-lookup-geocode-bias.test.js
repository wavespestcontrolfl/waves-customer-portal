/**
 * Property-lookup geocoding is restricted to Florida. A city-less street
 * string used to geocode to the same street name in another state or country
 * and every county gate then read that far-away point; the components filter
 * turns it into ZERO_RESULTS, the geocode-failure path the lookup already has.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private } = require('../routes/property-lookup-v2');

const { geocodeAddress } = _private;

const realFetch = global.fetch;
const savedKey = process.env.GOOGLE_MAPS_API_KEY;
const savedFallbackKey = process.env.GOOGLE_API_KEY;
beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
});
afterEach(() => {
  global.fetch = realFetch;
  if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = savedKey;
  if (savedFallbackKey === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = savedFallbackKey;
  jest.clearAllMocks();
});

function mockGeocode(body) {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => body });
}

describe('geocodeAddress (property lookup)', () => {
  test('sends the address, a US + Florida components filter and the key', async () => {
    mockGeocode({
      status: 'OK',
      results: [{
        formatted_address: '100 Example Creek Way, Parrish, FL 34219, USA',
        geometry: { location: { lat: 27.5, lng: -82.4 }, location_type: 'ROOFTOP' },
        address_components: [],
      }],
    });

    const geo = await geocodeAddress('100 Example Creek Way');

    expect(geo).toMatchObject({ lat: 27.5, lng: -82.4 });
    const [url] = global.fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(parsed.searchParams.get('address')).toBe('100 Example Creek Way');
    expect(parsed.searchParams.get('components')).toBe('country:US|administrative_area:FL');
    expect(parsed.searchParams.get('key')).toBe('test-key');
  });

  test('a non-Florida-only match (ZERO_RESULTS) is a geocode failure, not a far-away point', async () => {
    mockGeocode({ status: 'ZERO_RESULTS', results: [] });

    await expect(geocodeAddress('100 Example Creek Way')).rejects.toThrow('Geocode failed: ZERO_RESULTS');
  });

  test('an out-of-state address the filter falls back to "Florida, USA" is a failure, not a state-center point', async () => {
    mockGeocode({
      status: 'OK',
      results: [{
        formatted_address: 'Florida, USA',
        types: ['administrative_area_level_1', 'political'],
        partial_match: true,
        geometry: { location: { lat: 27.66, lng: -81.51 }, location_type: 'APPROXIMATE' },
        address_components: [],
      }],
    });

    await expect(geocodeAddress('100 Example Rd, Exampleville, IL 60000')).rejects.toThrow('Geocode failed: OUTSIDE_SERVICE_STATE');
  });

  test('a street-level result with types still geocodes', async () => {
    mockGeocode({
      status: 'OK',
      results: [{
        formatted_address: '100 Example Creek Way, Parrish, FL 34219, USA',
        types: ['street_address'],
        geometry: { location: { lat: 27.5, lng: -82.4 }, location_type: 'ROOFTOP' },
        address_components: [],
      }],
    });

    await expect(geocodeAddress('100 Example Creek Way')).resolves.toMatchObject({ lat: 27.5 });
  });

  test('a missing key still fails before any request', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    global.fetch = jest.fn();

    await expect(geocodeAddress('100 Example Creek Way')).rejects.toThrow('No GOOGLE_MAPS_API_KEY');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
