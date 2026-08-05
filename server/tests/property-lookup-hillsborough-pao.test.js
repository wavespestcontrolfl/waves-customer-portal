const {
  lookupPropertyFromHillsboroughPAO,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const {
  classifyPropertySource,
  hillsboroughLotSqft,
  hillsboroughPoolFeatures,
  parseHillsboroughPaoRecord,
  pickHillsboroughAddressResult,
  shouldQueryHillsboroughPAO,
  shouldQueryManateePAO,
} = aiPrivate;

// ── Fixtures mirror the live HCPA CommonServices shapes (probed 2026-08-05):
// BasicSearch returns an array of { address: 'STREET, CITY', folio, pin, … };
// ParcelData returns the CAMA record with buildings[] (heatedArea/grossArea/
// stories/yearBuilt/bedrooms/bathrooms/constructionInfo), landLines[] (units
// in sqft for SF/SE landType rows), acreage, and count-based extraFeatures.
// Synthetic address/values — not a customer property.

const BASIC_SEARCH_ROW = {
  address: '123 SANDPIPER SHORE DR, RUSKIN',
  displayFolio: '000000-0000',
  displayPin: 'U-00-00-00-XXX-000000-00000.0',
  folio: '0000000000',
  homestead: 'NO',
  landUse: '0100',
  pin: '0000000TEST00000000000U',
  saleDate: '2020-01-15',
  salePrice: 300000,
  totalCount: 1,
};

function parcelFixture(overrides = {}) {
  return {
    acreage: 0.16,
    landUse: { code: '0100', description: 'SINGLE FAMILY R' },
    landLines: [{
      acres: 0.17,
      depth: 112.0,
      frontage: 65.0,
      item: 1,
      landType: { code: 'SE', description: 'SF LOTS W/ EFF SIZE' },
      landUse: { code: 'REL2', description: 'Res SF Class 12.50' },
      units: 7280.0,
      value: 90090,
      zone: 'PD',
    }],
    buildings: [{
      bathrooms: 2.5,
      bedrooms: 4.0,
      cardNumber: 1,
      grossArea: 2976,
      heatedArea: 2186,
      noData: false,
      stories: 1.0,
      type: { code: '01  ', description: 'SINGLE FAMILY' },
      units: 1.0,
      yearBuilt: 2004,
      constructionInfo: [
        { constructionDetail: { code: 'C  ', description: 'Concrete Block' }, element: { code: '01  ', description: 'Class' }, sequence: 1 },
        { constructionDetail: { code: '7', description: 'Masonry Frm: Stucco' }, element: { code: 'EW  ', description: 'Exterior Wall' }, sequence: 2 },
        { constructionDetail: { code: '3', description: 'Asphalt/Comp. Shingle' }, element: { code: 'RC  ', description: 'Roof Cover' }, sequence: 3 },
      ],
    }],
    extraFeatures: [
      { building: 1, code: '0351  ', description: 'POOL 01 SCREENED', featureValue: 31853, length: '0', sequence: 1, units: '1', width: '0', year: 2005 },
    ],
    ...overrides,
  };
}

const SEARCH_MATCH = { parcelId: '0000000TEST00000000000U', situsAddress: '123 SANDPIPER SHORE DR', city: 'RUSKIN' };

describe('shouldQueryHillsboroughPAO', () => {
  it('opens on a south-Hillsborough ZIP or city in the raw address', () => {
    expect(shouldQueryHillsboroughPAO('123 Sandpiper Shore Dr, Ruskin, FL 33570')).toBe(true);
    expect(shouldQueryHillsboroughPAO('456 Any Rd, Wimauma, FL 33598')).toBe(true);
    expect(shouldQueryHillsboroughPAO('789 Some St, Apollo Beach, FL')).toBe(true);
  });

  it('stays closed for other-county and signal-less addresses', () => {
    expect(shouldQueryHillsboroughPAO('100 1st St, Bradenton, FL 34205')).toBe(false);
    expect(shouldQueryHillsboroughPAO('123 Main St')).toBe(false);
  });

  it('a confident FL geocode into Hillsborough opens the gate for a bare address', () => {
    const geo = { county: 'Hillsborough', state: 'FL', zip: null, partialMatch: false };
    expect(shouldQueryHillsboroughPAO('123 Main St', geo)).toBe(true);
    expect(shouldQueryManateePAO('123 Main St', geo)).toBe(false);
  });

  it('out-of-state geocodes and partial matches open nothing', () => {
    expect(shouldQueryHillsboroughPAO('123 Main St', { county: 'Hillsborough', state: 'NH', zip: '03570', partialMatch: false })).toBe(false);
    expect(shouldQueryHillsboroughPAO('123 Main St', { county: 'Hillsborough', state: 'FL', zip: '33570', partialMatch: true })).toBe(false);
  });
});

describe('pickHillsboroughAddressResult', () => {
  it('matches the unique row whose situs street equals the typed street', () => {
    const match = pickHillsboroughAddressResult([BASIC_SEARCH_ROW], '123 Sandpiper Shore Dr, Ruskin, FL 33570');
    expect(match).toEqual({
      parcelId: '0000000TEST00000000000U',
      folio: '0000000000',
      situsAddress: '123 SANDPIPER SHORE DR',
      city: 'RUSKIN',
    });
  });

  it('requires a city match when the typed address has no set ZIP', () => {
    // Typed city disagrees with the row's situs city → no match.
    expect(pickHillsboroughAddressResult([BASIC_SEARCH_ROW], '123 Sandpiper Shore Dr, Wimauma, FL')).toBeNull();
    // Same city → match, even without a ZIP.
    expect(pickHillsboroughAddressResult([BASIC_SEARCH_ROW], '123 Sandpiper Shore Dr, Ruskin, FL')).toBeTruthy();
  });

  it('rejects ambiguous result sets and rows without a pin or address', () => {
    const twin = { ...BASIC_SEARCH_ROW, pin: '111111TEST111111111111U', folio: '1111111111' };
    expect(pickHillsboroughAddressResult([BASIC_SEARCH_ROW, twin], '123 Sandpiper Shore Dr, Ruskin, FL 33570')).toBeNull();
    expect(pickHillsboroughAddressResult([{ folio: '2222222222' }], '123 Sandpiper Shore Dr, Ruskin, FL 33570')).toBeNull();
    expect(pickHillsboroughAddressResult(null, '123 Sandpiper Shore Dr, Ruskin, FL 33570')).toBeNull();
  });
});

describe('parseHillsboroughPaoRecord', () => {
  it('maps the CAMA record onto the county-record shape', () => {
    const parsed = parseHillsboroughPaoRecord({
      address: '123 Sandpiper Shore Dr, Ruskin, FL 33570',
      search: SEARCH_MATCH,
      parcel: parcelFixture(),
    });
    expect(parsed).toMatchObject({
      squareFootage: 2186,
      lotSize: 7280,
      yearBuilt: 2004,
      bedrooms: 4,
      bathrooms: 2.5,
      stories: 1,
      propertyType: 'Single Family',
      constructionMaterial: 'CBS',
      roofType: 'SHINGLE',
      confidence: 'high',
      county: 'Hillsborough',
      hasPool: true,
      poolAreaSqft: null,
      poolCageSqft: null,
      formattedAddress: '123 SANDPIPER SHORE DR, RUSKIN, FL',
    });
    expect(parsed.source).toBe('https://gis.hcpafl.org/propertysearch/#/parcel/basic/0000000TEST00000000000U');
    expect(parsed._buildings).toEqual([
      { description: 'SINGLE FAMILY', livingAreaSqft: 2186, underRoofSqft: 2976, stories: 1, yearBuilt: 2004 },
    ]);
  });

  it('skips noData building cards and picks the largest heated card as primary', () => {
    const parcel = parcelFixture({
      buildings: [
        { noData: true, cardNumber: 1 },
        { heatedArea: 900, grossArea: 1100, stories: 1, yearBuilt: 1990, type: { code: '01  ', description: 'SINGLE FAMILY' } },
        { heatedArea: 2400, grossArea: 3000, stories: 2, yearBuilt: 2010, type: { code: '01  ', description: 'SINGLE FAMILY' } },
      ],
    });
    const parsed = parseHillsboroughPaoRecord({ address: 'x', search: SEARCH_MATCH, parcel });
    expect(parsed.squareFootage).toBe(2400);
    expect(parsed.stories).toBe(2);
    expect(parsed._buildings).toHaveLength(2);
  });

  it('leaves the pool tri-state silent when the extra-features roll is absent', () => {
    const parsed = parseHillsboroughPaoRecord({
      address: 'x',
      search: SEARCH_MATCH,
      parcel: parcelFixture({ extraFeatures: null }),
    });
    expect('hasPool' in parsed).toBe(false);
  });

  it('still ships a lot-only record for an unimproved parcel', () => {
    const parsed = parseHillsboroughPaoRecord({
      address: 'x',
      search: SEARCH_MATCH,
      parcel: parcelFixture({ buildings: [], extraFeatures: null }),
    });
    expect(parsed.squareFootage).toBeNull();
    expect(parsed.lotSize).toBe(7280);
  });
});

describe('hillsboroughLotSqft', () => {
  it('sums SF/SE land-line units as square feet', () => {
    expect(hillsboroughLotSqft({
      landLines: [
        { landType: { code: 'SF' }, units: 5500, acres: 0.0 },
        { landType: { code: 'SE' }, units: 1200, acres: 0.03 },
      ],
    })).toBe(6700);
  });

  it('falls back to land-line acres, then parcel acreage', () => {
    expect(hillsboroughLotSqft({
      landLines: [{ landType: { code: 'AC' }, units: 0.25, acres: 0.25 }],
    })).toBe(10890);
    expect(hillsboroughLotSqft({ landLines: [], acreage: 0.13 })).toBe(5663);
    expect(hillsboroughLotSqft({})).toBeNull();
  });

  it('applies the shared lot bounds (floor rejects, cap clamps)', () => {
    expect(hillsboroughLotSqft({ landLines: [{ landType: { code: 'SF' }, units: 500 }] })).toBeNull();
    expect(hillsboroughLotSqft({ landLines: [], acreage: 40 })).toBe(200000);
  });
});

describe('hillsboroughPoolFeatures', () => {
  it('reads count-based POOL rows as presence, screened or not', () => {
    expect(hillsboroughPoolFeatures([{ description: 'POOL 01 SCREENED', units: '1' }]).hasPool).toBe(true);
    expect(hillsboroughPoolFeatures([{ description: 'POOL 01 NO ENCL', units: '1' }]).hasPool).toBe(true);
  });

  it('never reports pool area or cage sqft (the roll has no feature sqft)', () => {
    const facts = hillsboroughPoolFeatures([{ description: 'POOL 01 SCREENED', units: '1' }]);
    expect(facts.poolAreaSqft).toBeNull();
    expect(facts.poolCageSqft).toBeNull();
  });

  it('excludes accessory rows and stays silent without a parsed roll', () => {
    const facts = hillsboroughPoolFeatures([{ description: 'POOL HEATER', units: '1' }]);
    expect(facts.hasPool).toBe(false);
    expect(hillsboroughPoolFeatures([{ description: 'SPA', units: '1' }]).hasSpa).toBe(true);
    expect(hillsboroughPoolFeatures(null)).toEqual({});
  });
});

describe('classifyPropertySource', () => {
  it('scores hcpafl.org as a county source', () => {
    expect(classifyPropertySource('https://gis.hcpafl.org/propertysearch/#/parcel/basic/X'))
      .toEqual({ type: 'county', weight: 100 });
  });
});

describe('lookupPropertyFromHillsboroughPAO', () => {
  const savedFetch = global.fetch;
  afterEach(() => { global.fetch = savedFetch; });

  it('resolves BasicSearch → ParcelData into a shaped county record', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/BasicSearch')) {
        return { ok: true, url, text: async () => JSON.stringify([BASIC_SEARCH_ROW]) };
      }
      if (String(url).includes('/ParcelData')) {
        expect(String(url)).toContain('pin=0000000TEST00000000000U');
        return { ok: true, url, text: async () => JSON.stringify(parcelFixture()) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const record = await lookupPropertyFromHillsboroughPAO('123 Sandpiper Shore Dr, Ruskin, FL 33570');
    expect(record).toMatchObject({
      squareFootage: 2186,
      lotSize: 7280,
      stories: 1,
      propertyType: 'Single Family',
      county: 'Hillsborough',
      city: 'RUSKIN',
      addressLine1: '123 SANDPIPER SHORE DR',
      _source: 'county',
      _provider: 'hillsborough_pao',
    });
    expect(record._raw._provider).toBe('hillsborough_pao');
    expect(record._aiProviders).toEqual(['hillsborough_pao']);
  });

  it('never fetches when the county gate is closed', async () => {
    global.fetch = jest.fn();
    const record = await lookupPropertyFromHillsboroughPAO('100 1st St, Bradenton, FL 34205');
    expect(record).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when the county site errors', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => '' }));
    const record = await lookupPropertyFromHillsboroughPAO('123 Sandpiper Shore Dr, Ruskin, FL 33570');
    expect(record).toBeNull();
  });
});
