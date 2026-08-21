/**
 * Stacked association, ONE home per street number (paired villas / townhomes).
 *
 * The county stacks every villa of such a community on one shared polygon, so
 * the point query returns the whole association and buildStackedAggregate
 * summed it: the typed home came back as a 30-unit "Multifamily" COMMERCIAL
 * master parcel with the whole community's living area and acreage — even
 * though the roll carries that home's own row under its own street number.
 *
 * Rule: a typed house number that names exactly ONE unit row in the stack is
 * as unit-identifying as a Unit/Apt token. The verdict is 'unit' (not
 * 'keep'), the aggregate steps aside for that row's own parcel (own living
 * area / stories / year built / land use, by-parcel PAO id), land and polygon
 * are withheld (the association's common ground), and the association totals
 * ride along as context. A single-number condo building (dozens of
 * "NUMBER STREET 101" rows) keys no sole row and keeps association behavior.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { lookupCountyParcelByPoint, unitParcelFromAggregate } = require('../services/property-lookup/county-parcel-gis');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile, _private: routePrivate } = require('../routes/property-lookup-v2');

const {
  buildCadastralRecord, attachParcelMeta, aggregateSitusVerdict, resolveAggregateUnitParcel,
} = aiPrivate;

const PT = { lat: 27.44, lng: -82.52 };
const RING = [[
  [-82.521, 27.439], [-82.519, 27.439], [-82.519, 27.441], [-82.521, 27.441], [-82.521, 27.439],
]];

// Manatee-layer paired villa: every home has its own street number, its own
// PARID, its own living area — and LAND_SQFT_CAMA 0 (the unit owns no land).
function villaFeature(num, overrides = {}) {
  return {
    geometry: { rings: RING },
    attributes: {
      PARID: `1700${num}9`,
      SITUS_ADDRESS: `${num} PEBBLEWALK CT`,
      SITUS_POSTAL_CITY: 'BRADENTON',
      SITUS_POSTAL_ZIP: '34203',
      LAND_SQFT_CAMA: 0,
      BLDGS_SQFT_LIVING: 1600 + (num % 7) * 10,
      BLDG_R1_STORIES: 1,
      BLDG_R1_YRBUILT: 1993,
      BLDGS_LIVINGUNITS: 1,
      CUR_DOR_LUC_CODE: '04',
      CUR_MAN_LUC_DESC: 'Half Duplex/Paired Villa (1554)',
      PAR_SUBDIV_NAME: 'PEBBLEWALK',
      PAR_SWIMPOOL_FLAG: 'N',
      CUR_ROLL_YEAR: 2026,
      ...overrides,
    },
  };
}

const COMMON_FEATURE = {
  geometry: { rings: RING },
  attributes: {
    PARID: '1700000001',
    SITUS_ADDRESS: '0 PEBBLEWALK CT',
    SITUS_POSTAL_CITY: 'BRADENTON',
    SITUS_POSTAL_ZIP: '34203',
    LAND_SQFT_CAMA: 200000,
    BLDGS_SQFT_LIVING: null,
    BLDGS_LIVINGUNITS: 0,
    CUR_DOR_LUC_CODE: '09',
    CUR_MAN_LUC_DESC: 'Common Area',
    CUR_ROLL_YEAR: 2026,
  },
};

// Single-number condo building: many units under ONE street number.
function stackedUnitFeature(unit) {
  return villaFeature(4200, {
    PARID: `18004200${unit}`,
    SITUS_ADDRESS: `4200 PEBBLEWALK CT ${unit}`,
    BLDG_R1_STORIES: 3,
  });
}

const VILLA_NUMBERS = [4101, 4103, 4105, 4107, 4109, 4111];

function mockArcgis(features) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features }),
  });
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

async function villaAggregate() {
  mockArcgis([COMMON_FEATURE, ...VILLA_NUMBERS.map((n) => villaFeature(n))]);
  return lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });
}

describe('sole-unit rows on a stacked aggregate', () => {
  test('every own-numbered villa keys its own roll row; the common row does not', async () => {
    const parcel = await villaAggregate();

    expect(parcel).toMatchObject({ aggregated: true, residentialUnits: 6, buildingCount: 6 });
    expect(Object.keys(parcel.soleUnitRows).sort()).toEqual(VILLA_NUMBERS.map(String).sort());
    expect(parcel.soleUnitRows['4105']).toMatchObject({
      parcelId: '170041059', livingAreaSqft: 1600 + (4105 % 7) * 10, stories: 1, yearBuilt: 1993,
    });
    expect(parcel.soleUnitRows['0']).toBeUndefined();
  });

  test('a single-number condo building keys NO sole row (association behavior unchanged)', async () => {
    mockArcgis([COMMON_FEATURE, ...[101, 102, 103, 104, 105, 106].map(stackedUnitFeature)]);
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.soleUnitRows).toEqual({});
    expect(unitParcelFromAggregate(parcel, '4200')).toBeNull();
  });
});

describe('aggregateSitusVerdict → unit', () => {
  test('the typed own street number resolves to the unit, rooftop or interpolated', async () => {
    const parcel = await villaAggregate();

    expect(aggregateSitusVerdict(parcel, '4105 Pebblewalk Ct, Bradenton, FL 34203', 'rooftop',
      '4105 Pebblewalk Ct, Bradenton, FL 34203')).toBe('unit');
    expect(aggregateSitusVerdict(parcel, '4105 Pebblewalk Ct, Bradenton, FL 34203', 'interpolated',
      '4105 Pebblewalk Ct, Bradenton, FL 34203')).toBe('unit');
  });

  test('the existing guards still outrank it: subpremise and wrong street drop', async () => {
    const parcel = await villaAggregate();

    expect(aggregateSitusVerdict(parcel, '4105 Pebblewalk Ct, Bradenton, FL 34203', 'rooftop',
      '4105 Pebblewalk Ct Unit B, Bradenton, FL 34203')).toBe('drop');
    expect(aggregateSitusVerdict(parcel, '4105 Pebblewalk Ct, Bradenton, FL 34203', 'rooftop',
      '4105 Pebblewalk Dr, Bradenton, FL 34203')).toBe('drop');
  });

  test('a shared building number keeps the association (no sole row)', async () => {
    mockArcgis([COMMON_FEATURE, ...[101, 102, 103, 104, 105, 106].map(stackedUnitFeature)]);
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(aggregateSitusVerdict(parcel, '4200 Pebblewalk Ct, Bradenton, FL 34203', 'rooftop',
      '4200 Pebblewalk Ct, Bradenton, FL 34203')).toBe('keep');
  });

  test('the legacy number-only branch (no situs lines) reaches the same verdict', async () => {
    const parcel = await villaAggregate();
    const legacy = { ...parcel, situsLines: undefined };

    expect(aggregateSitusVerdict(legacy, '4107 Pebblewalk Ct, Bradenton, FL 34203', 'rooftop',
      '4107 Pebblewalk Ct, Bradenton, FL 34203')).toBe('unit');
  });
});

describe('the resolved unit parcel', () => {
  test('carries the unit\'s own facts and PAO id, withholds land and polygon, keeps association totals', async () => {
    const parcel = await villaAggregate();
    const unit = resolveAggregateUnitParcel(parcel,
      '4105 Pebblewalk Ct, Bradenton, FL 34203', '4105 Pebblewalk Ct, Bradenton, FL 34203');

    expect(unit).toMatchObject({
      county: 'Manatee',
      parcelId: '170041059',
      paoParcelId: '170041059',
      livingAreaSqft: 1600 + (4105 % 7) * 10,
      stories: 1,
      yearBuilt: 1993,
      residentialUnits: 1,
      landUseDescription: 'Half Duplex/Paired Villa (1554)',
      lotSqft: null,
      polygon: null,
      polygonAreaSqft: null,
      gisProvider: 'manatee_gis',
      association: { residentialUnits: 6, buildingCount: 6, lotSqft: 200000 },
    });
    expect(unit.aggregated).toBeUndefined();
    expect(unit.association.livingAreaSqft).toBe(
      VILLA_NUMBERS.reduce((sum, n) => sum + 1600 + (n % 7) * 10, 0),
    );
  });

  test('anchors to the TYPED number, not a snapped canonical one', async () => {
    const parcel = await villaAggregate();
    const unit = resolveAggregateUnitParcel(parcel,
      '4105 Pebblewalk Ct, Bradenton, FL 34203', '4109 Pebblewalk Ct, Bradenton, FL 34203');

    expect(unit.parcelId).toBe('170041099');
  });
});

describe('unit parcel → cadastral record → enriched profile', () => {
  test('prices as a RESIDENTIAL villa with its own sq ft, a blank lot, and the association flag', async () => {
    const parcel = await villaAggregate();
    const unit = resolveAggregateUnitParcel(parcel,
      '4105 Pebblewalk Ct, Bradenton, FL 34203', '4105 Pebblewalk Ct, Bradenton, FL 34203');
    const record = attachParcelMeta(
      buildCadastralRecord(unit, '4105 Pebblewalk Ct, Bradenton, FL 34203'),
      unit,
    );

    expect(record).toMatchObject({
      _source: 'county',
      propertyType: 'Townhome',
      squareFootage: 1600 + (4105 % 7) * 10,
      yearBuilt: 1993,
      stories: 1,
    });
    // shapeAsPropertyRecord reads an absent lot as 0 — either way, no land.
    expect(record.lotSize || 0).toBe(0);
    expect(record.unitCount).not.toBeGreaterThan(1);
    expect(record._parcel.aggregated).toBeUndefined();
    expect(record._parcel.association).toMatchObject({ residentialUnits: 6 });

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.isCommercial).toBe(false);
    expect(profile.commercialSubtype).toBeNull();
    expect(profile.homeSqFt).toBe(1600 + (4105 % 7) * 10);
    expect(profile.lotSqFt).toBe(0);
    expect(profile.unitCount).toBe(1);
    expect(profile.association).toMatchObject({ residentialUnits: 6, lotSqft: 200000 });

    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'association');
    expect(flag).toBeDefined();
    expect(flag.priority).toBe('MEDIUM');
    expect(flag.reason).toMatch(/6-unit condo\/HOA association/);
    expect(flag.reason).toMatch(/200,000 sf land/);
    expect(profile.fieldVerifyFlags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('a genuine association lookup (shared building number) still routes COMMERCIAL', async () => {
    mockArcgis([COMMON_FEATURE, ...[101, 102, 103, 104, 105, 106].map(stackedUnitFeature)]);
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });
    const record = attachParcelMeta(buildCadastralRecord(parcel, '4200 Pebblewalk Ct, Bradenton, FL 34203'), parcel);
    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.category).toBe('COMMERCIAL');
    expect(profile.association).toBeNull();
    expect(profile.fieldVerifyFlags.find((f) => f.field === 'association')).toBeUndefined();
  });
});

describe('cached aggregates from before own-unit resolution', () => {
  const { cachedAggregateResolvesToOwnUnit } = routePrivate;

  test('an own-numbered association (buildings === units) is re-run live', () => {
    expect(cachedAggregateResolvesToOwnUnit({
      _parcel: { aggregated: true, residentialUnits: 33, buildingCount: 33 },
    })).toBe(true);
  });

  test('a shared-number condo building keeps its cached aggregate', () => {
    expect(cachedAggregateResolvesToOwnUnit({
      _parcel: { aggregated: true, residentialUnits: 118, buildingCount: 3 },
    })).toBe(false);
  });

  test('non-aggregate, missing, and malformed rows are untouched', () => {
    expect(cachedAggregateResolvesToOwnUnit({ _parcel: { residentialUnits: 1, buildingCount: 1 } })).toBe(false);
    expect(cachedAggregateResolvesToOwnUnit({ _parcel: { aggregated: true, residentialUnits: 1, buildingCount: 1 } })).toBe(false);
    expect(cachedAggregateResolvesToOwnUnit({ _parcel: { aggregated: true } })).toBe(false);
    expect(cachedAggregateResolvesToOwnUnit(null)).toBe(false);
  });
});
