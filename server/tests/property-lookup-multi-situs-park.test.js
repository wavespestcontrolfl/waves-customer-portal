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

const { detectMultiSitusMasterParcel, _private } = require('../services/property-lookup/ai-property-lookup');
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
  test('detects DOR major 28 in every county code width and by description', () => {
    // Manatee 2-digit, FDOR 3-digit, Sarasota/Charlotte 4-digit county form.
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '28' })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '028' })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '2800' })).toBe(true);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: null, landUseDescription: 'Mobile Home Parks (1555)' })).toBe(true);
    // Ordinary residential / commercial codes and aggregates stay out.
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '0100' })).toBe(false);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '01' })).toBe(false);
    expect(_private.isMobileHomeParkParcel({ dorUseCode: '2800', aggregated: true })).toBe(false);
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
    expect(signal).toEqual({ situsCount: 226, parcelId: '900000100', situsAddress: null });
    // Missing unit count still marks it as multi-home.
    expect(_private.mobileHomeParkSignalFromParcel({ dorUseCode: '28' })).toMatchObject({ situsCount: 2 });
    expect(_private.mobileHomeParkSignalFromParcel({ dorUseCode: '0100' })).toBeNull();
  });

  test('stamped GIS signal reaches the detector like the address-search marker', () => {
    const merged = { _raw: {} };
    _private.stampMultiSitusParcelSignal(merged, { situsCount: 226, parcelId: '900000100', situsAddress: null });
    expect(detectMultiSitusMasterParcel(merged)).toMatchObject({ situsCount: 226 });
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

  test('no parkParcel flag on ordinary records', () => {
    const flags = routePrivate.buildFieldVerifyFlags({ squareFootage: 1400, lotSize: 6000, _raw: {} }, {});
    expect(flags.find((f) => f.field === 'parkParcel')).toBeUndefined();
  });
});
