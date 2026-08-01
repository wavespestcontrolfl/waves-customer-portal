/**
 * Multi-situs master parcels (land-lease mobile-home parks).
 *
 * Real shape this encodes (identities synthetic per the no-live-data rule):
 * a Manatee land-lease park — a couple hundred tenant-owned homes on five
 * streets, assessed as ONE parcel whose PAO search row packs every address
 * into a single ';'-delimited situs cell. Two failures stacked:
 *   - the picker compared the typed street against the JOINED cell, so an
 *     in-park address could never match its own situs line and the county
 *     lookup silently missed;
 *   - even matched, the parcel's land rows sum the whole park (~47 acres)
 *     and there are zero building rows — parcel-level dimensions must never
 *     price a single home.
 *
 * Rules:
 *   - delimited situs cells split into one candidate per address; matches on
 *     a multi-situs parcel carry situsCount > 1;
 *   - a multi-situs match parses to a slim identity-only record (no sqft /
 *     lot / stories / type) marked _multiSitusParcel, which survives the
 *     AI-trio merge via preserveMultiSitusParcelSignal;
 *   - the GIS by-point lane has the same hole from the other side: a park
 *     master parcel (FL DOR major 28, which also sits in the COMMERCIAL DOR
 *     band) must drop its parcel-level facts and contribute only the marker;
 *   - the panel surfaces a HIGH parkParcel verify flag instead of the
 *     misleading "address not found on the county roll".
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../services/property-lookup/county-parcel-gis', () => {
  const actual = jest.requireActual('../services/property-lookup/county-parcel-gis');
  return { ...actual, lookupCountyParcelByPoint: jest.fn() };
});

const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { detectMultiSitusMasterParcel, isPreMarkerParkRecord, lookupPropertyFromAITrio, _private } = require('../services/property-lookup/ai-property-lookup');
const { _private: routePrivate } = require('../routes/property-lookup-v2');

const PARK_SEARCH_RESULTS = {
  cols: [
    { title: 'Parcel ID' },
    { title: 'Property Type' },
    { title: 'Owner(s)' },
    { title: 'Situs Address' },
    { title: 'Postal City' },
  ],
  rows: [
    [
      '900000100',
      'REAL PROPERTY',
      ';SUNSHINE COVE MHP LLC;',
      ';2901 PELICAN CT;2902 PELICAN CT;4501 SEAGRAPE CIR;4512 SEAGRAPE CIR;3108 SANDPIPER LN;7001 IBIS CT;',
      'PALMETTO',
    ],
  ],
};

describe('multi-situs master parcel matching', () => {
  test('splitPaoSitusCell splits a delimited cell and passes single cells through', () => {
    expect(_private.splitPaoSitusCell(';2901 PELICAN CT;4512  SEAGRAPE CIR;')).toEqual([
      '2901 PELICAN CT',
      '4512 SEAGRAPE CIR',
    ]);
    expect(_private.splitPaoSitusCell(';14375 SKIPPING STONE LOOP;')).toEqual(['14375 SKIPPING STONE LOOP']);
    expect(_private.splitPaoSitusCell(null)).toEqual([]);
  });

  test('matches an in-park address against its own situs line and carries situsCount', () => {
    expect(_private.pickManateeSearchResult(
      PARK_SEARCH_RESULTS,
      '4512 Seagrape Cir, Palmetto, FL 34221',
    )).toMatchObject({
      parcelId: '900000100',
      situsAddress: '4512 SEAGRAPE CIR',
      city: 'PALMETTO',
      situsCount: 6,
    });
  });

  test('a street on no situs line still misses (phantom street name)', () => {
    expect(_private.pickManateeSearchResult(
      PARK_SEARCH_RESULTS,
      '4512 Palmetto Grove, Palmetto, FL 34221',
    )).toBeNull();
  });

  test('single-situs rows keep situsCount 1 and match as before', () => {
    const singleRow = {
      ...PARK_SEARCH_RESULTS,
      rows: [['497332659', 'REAL PROPERTY', '', ';14375 SKIPPING STONE LOOP;', 'PARRISH']],
    };
    expect(_private.pickManateeSearchResult(singleRow, '14375 Skipping Stone Lp, Parrish, FL 34219')).toMatchObject({
      parcelId: '497332659',
      situsCount: 1,
    });
  });
});

describe('multi-situs master parcel record', () => {
  const parkSearch = {
    parcelId: '900000100',
    situsAddress: '4512 SEAGRAPE CIR',
    city: 'PALMETTO',
    situsCount: 6,
  };
  // Real shape of a park parcel's detail models: whole-park ACREAGE land
  // rows, zero building rows.
  const parkLand = {
    cols: [{ title: 'Area' }, { title: 'Type' }, { title: 'Acreage' }, { title: 'SqFootage' }],
    rows: [
      ['1', 'ACREAGE', '34.8100', '1,516,324'],
      ['2', 'ACREAGE', '12.0989', '527,028'],
    ],
  };
  const parkBuildings = { cols: [], rows: [] };

  test('parses to a slim identity-only record — park-wide land must not become the lot size', () => {
    const parsed = _private.parseManateePaoRecord({
      address: '4512 Seagrape Cir, Palmetto, FL 34221',
      search: parkSearch,
      land: parkLand,
      buildings: parkBuildings,
      features: null,
    });

    expect(parsed.lotSize).toBeNull();
    expect(parsed.squareFootage).toBeNull();
    expect(parsed.stories).toBeNull();
    expect(parsed.propertyType).toBeNull();
    expect(parsed._multiSitusParcel).toEqual({ situsCount: 6 });
    expect(parsed.formattedAddress).toBe('4512 SEAGRAPE CIR, PALMETTO, FL');
    // The slim record has no facts by design, but must still ship.
    expect(_private.hasAnyPropertyFact(parsed)).toBe(false);
  });

  test('single-situs parses are unchanged by the guard', () => {
    const parsed = _private.parseManateePaoRecord({
      address: '123 Main St, Bradenton, FL 34205',
      search: { parcelId: '111', situsAddress: '123 MAIN ST', city: 'BRADENTON', situsCount: 1 },
      land: parkLand,
      buildings: parkBuildings,
      features: null,
    });
    expect(parsed._multiSitusParcel).toBeUndefined();
    expect(parsed.lotSize).toBe(200000); // existing LOT_SQFT_MAX clamp path
  });

  const RETAIL_BUILDINGS = {
    cols: [
      { title: 'Type' }, { title: 'Bldg' }, { title: 'Classification' }, { title: 'Yrblt' },
      { title: 'Effyr' }, { title: 'Stories' }, { title: 'UnRoof' }, { title: 'LivBus' },
      { title: 'Rooms' }, { title: 'Const/ExtWall' }, { title: 'RoofMaterial' }, { title: 'RoofType' },
    ],
    rows: [
      ['RETAIL STORE', '1', 'RETAIL', '1998', '2005', '1', '42,000', '38,500', '', 'CONCRETE BLOCK', 'BUILT-UP', 'FLAT'],
    ],
  };

  test('commercial multi-situs parcels keep the full parse — with parcel-level evidence', () => {
    // A shopping center's storefront addresses share one parcel, but the
    // commercial lane prices whole buildings — the parcel-wide facts are
    // the right ones. The exemption requires the parcel ROLL to classify
    // commercial with zero residential units; a commercial building alone
    // is not evidence.
    const parsed = _private.parseManateePaoRecord({
      address: '210 Commerce Way, Bradenton, FL 34205',
      search: { parcelId: '900000400', situsAddress: '210 COMMERCE WAY', city: 'BRADENTON', situsCount: 5 },
      land: parkLand,
      buildings: RETAIL_BUILDINGS,
      features: null,
      parcelAttrs: { dorUseCode: '1100', landUseDescription: 'Stores, one story', residentialUnits: 0 },
    });

    expect(parsed._multiSitusParcel).toBeUndefined();
    expect(parsed.propertyType).toBe('Retail');
    expect(parsed.squareFootage).toBe(38500);
    expect(parsed.yearBuilt).toBe(1998);
  });

  test('without parcel-level evidence a commercial-looking multi-situs parcel stays slim', () => {
    // Fail-safe: a verify flag on a storefront is a nuisance; park-wide
    // dimensions on a resident's quote is a mispricing.
    const parsed = _private.parseManateePaoRecord({
      address: '210 Commerce Way, Bradenton, FL 34205',
      search: { parcelId: '900000400', situsAddress: '210 COMMERCE WAY', city: 'BRADENTON', situsCount: 5 },
      land: parkLand,
      buildings: RETAIL_BUILDINGS,
      features: null,
      parcelAttrs: null,
    });
    expect(parsed._multiSitusParcel).toEqual({ situsCount: 5 });
    expect(parsed.squareFootage).toBeNull();
  });

  test('a SMALL park with an assessed office still goes slim with park identity', () => {
    // codex P1 r3: no address-count threshold can split a 9-home park with
    // an office from a 9-storefront plaza — the parcel roll can.
    const parsed = _private.parseManateePaoRecord({
      address: '4501 Seagrape Cir, Palmetto, FL 34221',
      search: { parcelId: '900000500', situsAddress: '4501 SEAGRAPE CIR', city: 'PALMETTO', situsCount: 9 },
      land: parkLand,
      buildings: {
        ...RETAIL_BUILDINGS,
        rows: [['OFFICE', '1', 'OFFICE', '1985', '1999', '1', '3,200', '2,800', '', 'CONCRETE BLOCK', 'SHINGLE', 'GABLE']],
      },
      features: null,
      parcelAttrs: { dorUseCode: '28', landUseDescription: 'Mobile Home Parks (1555)', residentialUnits: 9 },
    });
    expect(parsed._multiSitusParcel).toEqual({ situsCount: 9, parkConfirmed: true });
    expect(parsed.propertyType).toBeNull();
    expect(parsed.squareFootage).toBeNull();
    expect(parsed.lotSize).toBeNull();
  });

  test('park signal survives an AI-trio merge the county record does not win', () => {
    const countyRecord = {
      _source: 'county',
      _provider: 'manatee_pao',
      _raw: { multiSitusParcel: { situsCount: 6, parcelId: '900000100', situsAddress: '4512 SEAGRAPE CIR' } },
    };
    const merged = { _source: 'hybrid', _raw: { _provider: 'gemini' } };

    _private.preserveMultiSitusParcelSignal(merged, countyRecord);
    expect(detectMultiSitusMasterParcel(merged)).toMatchObject({ situsCount: 6, parcelId: '900000100' });

    // Never clobbers an existing signal; no-ops without one.
    const untouched = { _raw: {} };
    _private.preserveMultiSitusParcelSignal(untouched, {});
    expect(detectMultiSitusMasterParcel(untouched)).toBeNull();
    expect(detectMultiSitusMasterParcel(null)).toBeNull();
  });
});

describe('GIS by-point lane: mobile-home-park master parcels', () => {
  test('detects DOR major 28 in every county code width — with corroboration', () => {
    // FL DOR 28 covers BOTH mobile-home parks and commercial parking lots,
    // so the code alone is never enough: residential units on the roll (or
    // explicit park wording) corroborate. Manatee 2-digit, FDOR 3-digit,
    // Sarasota/Charlotte 4-digit county form.
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '28', residentialUnits: 226 })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '028', residentialUnits: 12 })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '2800', residentialUnits: 40 })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: null, landUseDescription: 'Mobile Home Parks (1555)' })).toBe(true);
    // A commercial parking lot is DOR 28 with zero residential units — it
    // must keep its commercial classification.
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '28' })).toBe(false);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '2800', residentialUnits: 0 })).toBe(false);
    // Ordinary residential / commercial codes and aggregates stay out.
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '0100', residentialUnits: 1 })).toBe(false);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '2800', residentialUnits: 40, aggregated: true })).toBe(false);
    expect(_private.isMobileHomeParkParcel(null)).toBe(false);
  });

  test('a park parcel yields only the marker — units count, no situs, no dimensions', () => {
    const signal = _private.mobileHomeParkSignalFromParcel({
      paoParcelId: '900000100',
      dorUseCode: '28',
      landUseDescription: 'Mobile Home Parks (1555)',
      residentialUnits: 226,
      lotSqft: 2043352,
    });
    expect(signal).toEqual({ situsCount: 226, parcelId: '900000100', situsAddress: null, parkConfirmed: true });
    // Park wording without a unit count still marks it as multi-home — and
    // keeps the positive park evidence so the flag copy never reads duplex.
    expect(_private.mobileHomeParkSignalFromParcel({ landUseDescription: 'Mobile Home Park' })).toMatchObject({ situsCount: 2, parkConfirmed: true });
    expect(_private.mobileHomeParkSignalFromParcel({ dorUseCode: '0100' })).toBeNull();
  });

  test('isPreMarkerParkRecord flags park-shaped records only when the marker is missing', () => {
    const parkParcelMeta = { dorUseCode: '28', landUseDescription: 'Mobile Home Parks (1555)', residentialUnits: 226 };
    expect(isPreMarkerParkRecord({ _parcel: parkParcelMeta, _raw: {} })).toBe(true);
    expect(isPreMarkerParkRecord({ _raw: { landUse: 'Mobile Home Parks (1555)' } })).toBe(true);
    // Marker present = post-guard record; ordinary parcels never match.
    expect(isPreMarkerParkRecord({ _parcel: parkParcelMeta, _raw: { multiSitusParcel: { situsCount: 226 } } })).toBe(false);
    expect(isPreMarkerParkRecord({ _parcel: { dorUseCode: '0100', residentialUnits: 1 }, _raw: {} })).toBe(false);
    expect(isPreMarkerParkRecord(null)).toBe(false);
  });

  test('stamped GIS signal reaches the detector like the address-search marker', () => {
    const merged = { _raw: {} };
    _private.stampMultiSitusParcelSignal(merged, { situsCount: 226, parcelId: '900000100', situsAddress: null });
    expect(detectMultiSitusMasterParcel(merged)).toMatchObject({ situsCount: 226 });
  });

  test('marker-only record ships when GIS finds a park but every fact provider fails', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({
      county: 'Manatee',
      gisProvider: 'manatee_gis',
      parcelId: '900000100',
      paoParcelId: '900000100',
      situsAddress: '2901 PELICAN CT',
      dorUseCode: '28',
      landUseDescription: 'Mobile Home Parks (1555)',
      residentialUnits: 226,
      lotSqft: 2043352,
    });
    // Every downstream provider (PAO search, AI trio) fails hard.
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('provider down'));
    try {
      const record = await lookupPropertyFromAITrio('4512 Seagrape Cir, Palmetto, FL 34221', {
        lat: 27.55, lng: -82.55, locationType: 'ROOFTOP', county: 'Manatee',
      });
      expect(record).not.toBeNull();
      expect(detectMultiSitusMasterParcel(record)).toMatchObject({ situsCount: 226, parkConfirmed: true });
      // Marker only — no park-wide facts leak.
      expect(record.squareFootage || 0).toBe(0);
      expect(record.lotSize || 0).toBe(0);
      expect(record._source).toBe('cadastral');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('park parcel verify flag', () => {
  test('panel surfaces a HIGH parkParcel flag with the situs count', () => {
    const rc = {
      squareFootage: 0,
      lotSize: 0,
      _raw: { multiSitusParcel: { situsCount: 226, parcelId: '900000100', situsAddress: '4512 SEAGRAPE CIR' } },
    };
    const flags = routePrivate.buildFieldVerifyFlags(rc, {});
    const parkFlag = flags.find((f) => f.field === 'parkParcel');
    expect(parkFlag).toBeDefined();
    expect(parkFlag.priority).toBe('HIGH');
    expect(parkFlag.reason).toContain('226');
    expect(parkFlag.reason).toContain('land-lease');
  });

  test('small multi-situs parcels (duplex scale) get neutral copy, not park semantics', () => {
    const rc = {
      squareFootage: 0,
      lotSize: 0,
      _raw: { multiSitusParcel: { situsCount: 2, parcelId: '900000200', situsAddress: '210 DUNLIN CT' } },
    };
    const flags = routePrivate.buildFieldVerifyFlags(rc, {});
    const parkFlag = flags.find((f) => f.field === 'parkParcel');
    expect(parkFlag).toBeDefined();
    expect(parkFlag.priority).toBe('HIGH');
    expect(parkFlag.reason).toContain('duplex or small multi-unit');
    expect(parkFlag.reason).not.toContain('land-lease');
  });

  test('GIS-confirmed park keeps park copy even at the situsCount fallback floor', () => {
    const rc = {
      squareFootage: 0,
      lotSize: 0,
      _raw: { multiSitusParcel: { situsCount: 2, parcelId: '900000300', situsAddress: null, parkConfirmed: true } },
    };
    const parkFlag = routePrivate.buildFieldVerifyFlags(rc, {}).find((f) => f.field === 'parkParcel');
    expect(parkFlag.reason).toContain('land-lease');
    expect(parkFlag.reason).not.toContain('duplex');
  });

  test('no parkParcel flag on ordinary records', () => {
    const flags = routePrivate.buildFieldVerifyFlags({ squareFootage: 1400, lotSize: 6000, _raw: {} }, {});
    expect(flags.find((f) => f.field === 'parkParcel')).toBeUndefined();
  });
});
