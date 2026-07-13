/**
 * Commercial-aware building square footage.
 *
 * The 15,000 sqft sanity cap on building size is a RESIDENTIAL guard against
 * listing-scrape garbage — but commercial buildings routinely exceed it, and
 * the commercial pest pricer (PR #2207) consumes footprints far past 15k (its
 * own low-confidence flag sits at 30k). A residential-only cap read every
 * mid-size warehouse/office as "no square footage" and forced a manual quote
 * the engine could have priced. Real case this encodes: 1805 51st Ave E,
 * Palmetto — Manatee roll carries 270,900 sf "Warehousing, Distribution";
 * the old cap nulled it.
 *
 * Rules under test:
 *   - residential keeps reject-above-15k semantics (unchanged);
 *   - commercial-typed records accept up to 200k and CLAMP above it
 *     (mirroring the lot rule: verified oversized values cap, not discard);
 *   - Manatee's GIS layer falls back to the commercial BLDG_C1_* block when
 *     the residential BLDG_R1_* fields are empty (pure-commercial parcels).
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');

const {
  buildCadastralRecord,
  coerceBuildingSqft,
  isCommercialBuildingType,
  parcelLooksCommercial,
  parsePropertyJSON,
} = aiPrivate;

const PT = { lat: 27.4, lng: -82.4 };
const RING = [[
  [-82.401, 27.399], [-82.399, 27.399], [-82.399, 27.401], [-82.401, 27.401], [-82.401, 27.399],
]];

function mockArcgis(attributes) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [{ attributes, geometry: { rings: RING } }] }),
  });
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

describe('coerceBuildingSqft', () => {
  test('residential: rejects above the 15k sanity cap (unchanged behavior)', () => {
    expect(coerceBuildingSqft(2450, false)).toBe(2450);
    expect(coerceBuildingSqft(15000, false)).toBe(15000);
    expect(coerceBuildingSqft(15001, false)).toBeNull();
    expect(coerceBuildingSqft(270900, false)).toBeNull();
    expect(coerceBuildingSqft(300, false)).toBeNull();
  });

  test('commercial: accepts big buildings and clamps at 200k instead of discarding', () => {
    expect(coerceBuildingSqft(42000, true)).toBe(42000);
    expect(coerceBuildingSqft(270900, true)).toBe(200000);
    expect(coerceBuildingSqft('75,000', true)).toBe(75000);
    expect(coerceBuildingSqft(300, true)).toBeNull(); // below min = still garbage
    expect(coerceBuildingSqft(null, true)).toBeNull();
  });
});

describe('isCommercialBuildingType / parcelLooksCommercial', () => {
  test('commercial estimator types are commercial-sized; residential are not', () => {
    for (const t of ['Warehouse', 'Office', 'Retail', 'Commercial', 'Industrial', 'Multifamily']) {
      expect(isCommercialBuildingType(t)).toBe(true);
    }
    for (const t of ['Single Family', 'Townhome', 'Condo', 'Duplex', null, '']) {
      expect(isCommercialBuildingType(t)).toBe(false);
    }
  });

  test('DOR majors 10-49 (commercial/industrial) and commercial land-use text signal commercial', () => {
    expect(parcelLooksCommercial({ dorUseCode: '48' })).toBe(true); // warehousing
    expect(parcelLooksCommercial({ dorUseCode: '011' })).toBe(true); // FDOR stores
    expect(parcelLooksCommercial({ dorUseCode: '1700' })).toBe(true); // 4-digit office
    expect(parcelLooksCommercial({ dorUseCode: '01' })).toBe(false); // SFR
    expect(parcelLooksCommercial({ dorUseCode: '0100' })).toBe(false);
    expect(parcelLooksCommercial({ landUseDescription: 'Warehousing, Distribution (1555)' })).toBe(true);
    expect(parcelLooksCommercial({ landUseDescription: 'Single Family Residential (1554)' })).toBe(false);
    expect(parcelLooksCommercial({})).toBe(false);
  });
});

describe('buildCadastralRecord (county GIS / cadastral evidence)', () => {
  const warehouseParcel = {
    parcelId: '815800008',
    county: 'Manatee',
    gisProvider: 'manatee_gis',
    situsAddress: '1805 51ST AVE E',
    situsCity: 'PALMETTO',
    situsZip: '34221',
    lotSqft: 1931886,
    livingAreaSqft: 270900,
    stories: 1,
    yearBuilt: 1998,
    dorUseCode: '48',
    landUseDescription: 'Warehousing, Distribution (1555)',
    sourceUrl: 'https://gis.manateepao.gov/',
  };

  test('a commercial parcel keeps its building sqft (clamped at 200k), not nulled', () => {
    const record = buildCadastralRecord(warehouseParcel, '1805 51st Ave E, Palmetto, FL 34221');
    expect(record.squareFootage).toBe(200000);
  });

  test('an implausible sqft on a RESIDENTIAL parcel still reads as garbage', () => {
    const record = buildCadastralRecord({
      ...warehouseParcel,
      dorUseCode: '01',
      landUseDescription: 'Single Family Residential (1554)',
    }, '1805 51st Ave E, Palmetto, FL 34221');
    // shapeAsPropertyRecord coerces a rejected (null) sqft to 0.
    expect(record.squareFootage).toBe(0);
  });

  test('a mid-size commercial building passes through un-clamped', () => {
    const record = buildCadastralRecord(
      { ...warehouseParcel, livingAreaSqft: 42000 },
      '1805 51st Ave E, Palmetto, FL 34221',
    );
    expect(record.squareFootage).toBe(42000);
  });
});

describe('parsePropertyJSON (AI web-search response)', () => {
  test('commercial propertyType unlocks the commercial cap', () => {
    const parsed = parsePropertyJSON(JSON.stringify({
      squareFootage: 42000,
      propertyType: 'Warehouse',
      lotSize: 80000,
      source: 'https://www.loopnet.com/Listing/x',
      confidence: 'high',
    }));
    expect(parsed.squareFootage).toBe(42000);
    expect(parsed.propertyType).toBe('Warehouse');
  });

  test('oversized commercial sqft clamps at 200k; residential still rejects', () => {
    const big = parsePropertyJSON(JSON.stringify({ squareFootage: 350000, propertyType: 'Industrial' }));
    expect(big.squareFootage).toBe(200000);

    const home = parsePropertyJSON(JSON.stringify({ squareFootage: 42000, propertyType: 'Single Family' }));
    expect(home.squareFootage).toBeNull();

    const untyped = parsePropertyJSON(JSON.stringify({ squareFootage: 42000 }));
    expect(untyped.squareFootage).toBeNull(); // no type evidence → conservative residential cap
  });
});

describe('Manatee GIS layer: commercial BLDG_C1_* fallback', () => {
  test('a pure-commercial parcel (no residential building block) still yields stories/year/sqft', async () => {
    mockArcgis({
      PARID: '2110600159',
      SITUS_ADDRESS: '2110 60TH DR E',
      SITUS_POSTAL_CITY: 'BRADENTON',
      SITUS_POSTAL_ZIP: '34203',
      LAND_SQFT_CAMA: 15447,
      BLDGS_SQFT_LIVING: null,
      BLDG_R1_STORIES: null,
      BLDG_R1_YRBUILT: null,
      BLDG_C1_SQFTLIVNG: 4800,
      BLDG_C1_STORIES: 1,
      BLDG_C1_YRBUILT: 1999,
      CUR_DOR_LUC_CODE: '48',
      CUR_MAN_LUC_DESC: 'Warehousing, Distribution (1555)',
    });

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel).toMatchObject({
      county: 'Manatee',
      livingAreaSqft: 4800,
      stories: 1,
      yearBuilt: 1999,
    });
    // The C1 fields must actually be requested from the layer.
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('outFields')).toContain('BLDG_C1_SQFTLIVNG');
  });

  test('residential R1 fields still win when both blocks are present', async () => {
    mockArcgis({
      PARID: '3331410104',
      SITUS_ADDRESS: '17742 LUCAYA DR',
      LAND_SQFT_CAMA: 7200,
      BLDGS_SQFT_LIVING: 2450,
      BLDG_R1_STORIES: 2,
      BLDG_R1_YRBUILT: 2020,
      BLDG_C1_SQFTLIVNG: 999,
      BLDG_C1_STORIES: 1,
      BLDG_C1_YRBUILT: 1980,
      CUR_DOR_LUC_CODE: '01',
      CUR_MAN_LUC_DESC: 'Single Family Residential (1554)',
    });

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel).toMatchObject({ livingAreaSqft: 2450, stories: 2, yearBuilt: 2020 });
  });
});
