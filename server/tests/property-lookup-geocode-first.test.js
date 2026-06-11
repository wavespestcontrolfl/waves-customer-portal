const { _private: routePrivate } = require('../routes/property-lookup-v2');
const {
  canonicalLookupAddress,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const { parseGeocodeResult } = routePrivate;
const {
  geoOpensCountyGate,
  shouldQueryManateePAO,
  shouldQuerySarasotaPAO,
  shouldQueryCharlottePAO,
  lookupPropertyFromCountyRecords,
} = aiPrivate;

function geocodeFixture(overrides = {}) {
  return {
    formatted_address: '5510 Lakewood Ranch Blvd, Bradenton, FL 34211, USA',
    geometry: { location: { lat: 27.4458, lng: -82.4012 } },
    address_components: [
      { long_name: '5510', short_name: '5510', types: ['street_number'] },
      { long_name: 'Lakewood Ranch Boulevard', short_name: 'Lakewood Ranch Blvd', types: ['route'] },
      { long_name: 'Bradenton', short_name: 'Bradenton', types: ['locality', 'political'] },
      { long_name: 'Manatee County', short_name: 'Manatee County', types: ['administrative_area_level_2', 'political'] },
      { long_name: 'Florida', short_name: 'FL', types: ['administrative_area_level_1', 'political'] },
      { long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
      { long_name: '34211', short_name: '34211', types: ['postal_code'] },
    ],
    ...overrides,
  };
}

describe('parseGeocodeResult', () => {
  it('shapes a full geocoder result into geo context', () => {
    const geo = parseGeocodeResult(geocodeFixture());
    expect(geo).toEqual({
      lat: 27.4458,
      lng: -82.4012,
      formattedAddress: '5510 Lakewood Ranch Blvd, Bradenton, FL 34211, USA',
      county: 'Manatee',
      city: 'Bradenton',
      zip: '34211',
      partialMatch: false,
    });
  });

  it('flags partial matches as low-trust', () => {
    const geo = parseGeocodeResult(geocodeFixture({ partial_match: true }));
    expect(geo.partialMatch).toBe(true);
  });

  it('returns null when geometry is missing', () => {
    expect(parseGeocodeResult({ formatted_address: 'x' })).toBeNull();
    expect(parseGeocodeResult(null)).toBeNull();
  });

  it('tolerates missing address components', () => {
    const geo = parseGeocodeResult({ geometry: { location: { lat: 1, lng: 2 } } });
    expect(geo).toEqual({
      lat: 1,
      lng: 2,
      formattedAddress: null,
      county: null,
      city: null,
      zip: null,
      partialMatch: false,
    });
  });
});

describe('canonicalLookupAddress', () => {
  const typed = '5510 lakewood rnch blvd bradenton fl';

  it('prefers the geocoded formatted address and strips trailing USA', () => {
    const geo = { formattedAddress: '5510 Lakewood Ranch Blvd, Bradenton, FL 34211, USA', partialMatch: false };
    expect(canonicalLookupAddress(typed, geo)).toBe('5510 Lakewood Ranch Blvd, Bradenton, FL 34211');
  });

  it('strips a trailing "United States" too', () => {
    const geo = { formattedAddress: '100 Main St, Venice, FL 34285, United States', partialMatch: false };
    expect(canonicalLookupAddress(typed, geo)).toBe('100 Main St, Venice, FL 34285');
  });

  it('keeps the typed address on partial matches', () => {
    const geo = { formattedAddress: '5510 Lakewood Ranch Blvd, Bradenton, FL 34211, USA', partialMatch: true };
    expect(canonicalLookupAddress(typed, geo)).toBe(typed);
  });

  it('keeps the typed address when geo is missing or empty', () => {
    expect(canonicalLookupAddress(typed, null)).toBe(typed);
    expect(canonicalLookupAddress(typed, {})).toBe(typed);
    expect(canonicalLookupAddress(typed, { formattedAddress: '  USA ', partialMatch: false })).toBe(typed);
  });
});

describe('county PAO gates with geo context', () => {
  // Raw string carries no usable ZIP/city — today every gate fails on it.
  const bareAddress = '123 Main St';

  it('confident geocoded county opens the matching gate only', () => {
    const geo = { county: 'Manatee', zip: null, partialMatch: false };
    expect(shouldQueryManateePAO(bareAddress, geo)).toBe(true);
    expect(shouldQuerySarasotaPAO(bareAddress, geo)).toBe(false);
    expect(shouldQueryCharlottePAO(bareAddress, geo)).toBe(false);
  });

  it('geocoded ZIP opens the gate when the county name is absent', () => {
    expect(shouldQueryCharlottePAO(bareAddress, { county: null, zip: '33948', partialMatch: false })).toBe(true);
    expect(shouldQuerySarasotaPAO(bareAddress, { county: null, zip: '34285-1234', partialMatch: false })).toBe(true);
  });

  it('partial-match geocodes are ignored (raw-address logic decides)', () => {
    const geo = { county: 'Manatee', zip: '34211', partialMatch: true };
    expect(shouldQueryManateePAO(bareAddress, geo)).toBe(false);
    expect(shouldQueryManateePAO('100 1st St, Bradenton, FL 34205', geo)).toBe(true);
  });

  it('never blocks: a geo pointing at another county leaves raw matches open', () => {
    const geo = { county: 'Manatee', zip: '34211', partialMatch: false };
    expect(shouldQuerySarasotaPAO('100 Tampa Ave, Venice, FL 34285', geo)).toBe(true);
  });

  it('raw-address behavior is unchanged without geo', () => {
    expect(shouldQueryManateePAO('100 1st St, Bradenton, FL 34205')).toBe(true);
    expect(shouldQueryManateePAO(bareAddress)).toBe(false);
  });

  it('geoOpensCountyGate handles malformed geo defensively', () => {
    expect(geoOpensCountyGate(null, 'MANATEE', new Set(['34211']))).toBe(false);
    expect(geoOpensCountyGate({ county: 42, zip: 34211, partialMatch: false }, 'MANATEE', new Set(['34211']))).toBe(false);
    expect(geoOpensCountyGate({ county: ' manatee ', partialMatch: false }, 'MANATEE', new Set())).toBe(true);
  });
});

describe('lookupPropertyFromCountyRecords provider ordering', () => {
  // 34243 sits in both the Manatee and Sarasota ZIP sets, so both gates open
  // from the raw address alone and the loop order decides who is tried first.
  const sharedZipAddress = '7000 Whitfield Ave, Sarasota, FL 34243';
  const originalFetch = global.fetch;
  let fetchedUrls;

  beforeEach(() => {
    fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      fetchedUrls.push(String(url));
      throw new Error('network disabled in test');
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('tries Manatee first by default on a shared-ZIP address', async () => {
    const record = await lookupPropertyFromCountyRecords(sharedZipAddress, { timeoutMs: 5000 });
    expect(record).toBeNull();
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls[0]).toContain('manateepao.gov');
  });

  it('tries the geocoded county first when geo context says Sarasota', async () => {
    const record = await lookupPropertyFromCountyRecords(sharedZipAddress, {
      timeoutMs: 5000,
      geoContext: { county: 'Sarasota', zip: '34243', partialMatch: false },
    });
    expect(record).toBeNull();
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls[0]).toContain('sc-pa.com');
  });

  it('ignores partial-match geo for ordering', async () => {
    const record = await lookupPropertyFromCountyRecords(sharedZipAddress, {
      timeoutMs: 5000,
      geoContext: { county: 'Sarasota', zip: '34243', partialMatch: true },
    });
    expect(record).toBeNull();
    expect(fetchedUrls[0]).toContain('manateepao.gov');
  });
});
