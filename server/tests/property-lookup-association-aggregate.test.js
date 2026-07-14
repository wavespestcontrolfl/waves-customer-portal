/**
 * Stacked-parcel condo/HOA association aggregation.
 *
 * Real case this encodes: 1555 Tarpon Center Dr, Venice — a 118-unit condo
 * association whose units each own zero land. The Sarasota layer returns 151
 * parcels stacked on one polygon at any point inside the complex; the picker
 * can't choose a unit, so the lookup deferred and the panel came back 0/100
 * even though the roll knows units, sqft, year built, and the land geometry.
 *
 * Aggregation rules:
 *   - association-sized stacks (≥5 units) aggregate: units and living sqft
 *     summed, land from a master row's roll figure or the shared polygon,
 *     building count from distinct unit street numbers;
 *   - small stacks (a paired villa's 2 identical rows) still defer;
 *   - the aggregate is ALWAYS Multifamily → commercial lane (the synthesized
 *     "condo" wording must never map to the residential Condo type);
 *   - the enriched profile prices perimeter per building (N buildings of
 *     footprint/N each ≈ √N × one combined slab's perimeter).
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

const { buildCadastralRecord, attachParcelMeta } = aiPrivate;

const PT = { lat: 27.11, lng: -82.464 };
const RING = [[
  [-82.465, 27.109], [-82.463, 27.109], [-82.463, 27.111], [-82.465, 27.111], [-82.465, 27.109],
]];

function unitFeature(num, unit, overrides = {}) {
  return {
    geometry: { rings: RING },
    attributes: {
      id: `01731220${unit}`,
      fulladdress: `${num} TARPON CENTER DR ${unit}, VENICE FL, 34285`,
      loccity: 'VENICE',
      loczip: '34285',
      lsqft: 0,
      living: 920,
      grnd_area: 1000,
      livunits: 1,
      yrbl: 1970,
      stcd: '0403',
      subd: '7090',
      pool: null,
      ...overrides,
    },
  };
}

const MASTER_FEATURE = {
  geometry: { rings: RING },
  attributes: {
    id: '0000007090',
    fulladdress: '0 GIBBS RD VENICE FL, 34285',
    loccity: 'VENICE',
    loczip: '34285',
    lsqft: 0,
    living: null,
    grnd_area: null,
    livunits: 0,
    yrbl: null,
    stcd: '0900',
    subd: '7090',
    pool: null,
  },
};

function mockArcgis(features) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features }),
  });
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

describe('stacked-parcel association aggregation (county GIS)', () => {
  test('an association-sized stack aggregates units, sqft, land, and buildings', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1575, 201), unitFeature(1575, 202),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel).toMatchObject({
      county: 'Sarasota',
      aggregated: true,
      residentialUnits: 6,
      livingAreaSqft: 6 * 920,
      groundAreaSqft: 6 * 1000,
      buildingCount: 2, // 1555 + 1575
      situsAddress: '1555 TARPON CENTER DR',
      situsZip: '34285',
      yearBuilt: 1970,
      parcelId: '0000007090', // the master/common row keys the aggregate
      gisProvider: 'sarasota_gis',
    });
    // Units own no land — the shared polygon supplies the association's lot.
    expect(parcel.lotSqft).toBeGreaterThan(10000);
    expect(parcel.lotSqft).toBe(parcel.polygonAreaSqft);
    expect(parcel.landUseDescription).toMatch(/Multifamily.*6 units.*2 buildings/);
  });

  test('a master row carrying a roll land figure beats the polygon area', async () => {
    mockArcgis([
      { ...MASTER_FEATURE, attributes: { ...MASTER_FEATURE.attributes, lsqft: 98084 } },
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.lotSqft).toBe(98084);
    expect(parcel.buildingCount).toBe(1);
  });

  test('a small stack (paired villa) still defers — aggregation must not swallow a duplex', async () => {
    mockArcgis([unitFeature(1555, 101), unitFeature(1555, 102)]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel).toBeNull();
  });
});

describe('association aggregate → cadastral record → enriched profile', () => {
  function aggregateParcel(overrides = {}) {
    return {
      parcelId: '0000007090',
      county: 'Sarasota',
      gisProvider: 'sarasota_gis',
      situsAddress: '1555 TARPON CENTER DR',
      situsCity: 'VENICE',
      situsZip: '34285',
      lotSqft: 98084,
      livingAreaSqft: 104096,
      groundAreaSqft: 115086,
      stories: 2,
      yearBuilt: 1970,
      residentialUnits: 118,
      dorUseCode: '0403',
      landUseDescription: 'Multifamily condo/HOA association — 118 units, 3 buildings (county aggregate)',
      subdivision: '7090',
      poolFlag: true,
      imperviousAreaSf: null,
      aggregated: true,
      aggregateUnitParcels: 118,
      buildingCount: 3,
      sourceUrl: 'https://ags3.scgov.net/server/rest/services/Hosted/Parcels/FeatureServer/0',
      ...overrides,
    };
  }

  test('the aggregate is Multifamily with the summed sqft — never residential Condo', () => {
    const record = buildCadastralRecord(aggregateParcel(), '1555 Tarpon Center Dr, Venice, FL 34285');

    expect(record.propertyType).toBe('Multifamily');
    expect(record.squareFootage).toBe(104096); // commercial-sized, not nulled at 15k
    expect(record.lotSize).toBe(98084);
    expect(record.unitCount).toBe(118);
    expect(record._raw.landUse).toMatch(/multifamily/i);
  });

  test('the enriched profile routes COMMERCIAL and carries units + multi-building perimeter', () => {
    const record = attachParcelMeta(
      buildCadastralRecord(aggregateParcel(), '1555 Tarpon Center Dr, Venice, FL 34285'),
      aggregateParcel(),
    );

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.category).toBe('COMMERCIAL');
    expect(profile.isCommercial).toBe(true);
    expect(profile.unitCount).toBe(118);
    expect(profile.buildingCount).toBe(3);
    expect(profile.homeSqFt).toBe(104096);
    expect(profile.lotSqFt).toBe(98084);

    // 3 buildings of footprint/3 each: √3 × the single-slab perimeter.
    const footprint = Math.round(104096 / 2); // 2 stories known
    const single = Math.round(4 * Math.sqrt(footprint) * 1.35);
    const multi = Math.round(3 * 4 * Math.sqrt(footprint / 3) * 1.35);
    expect(profile.estimatedPerimeterLF).toBe(multi);
    expect(profile.estimatedPerimeterLF).toBeGreaterThan(single);
  });

  test('an aggregate with UNKNOWN stories gets NO perimeter prefill (codex P2)', () => {
    const parcel = aggregateParcel({ stories: null });
    const record = attachParcelMeta(
      buildCadastralRecord(parcel, '1555 Tarpon Center Dr, Venice, FL 34285'),
      parcel,
    );

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    // footprint would be the FULL summed living area (stories defaulted to
    // 1) — a prefilled perimeter off that inflates mid/high-rise complexes
    // by ~√stories, so the box stays empty for a field measurement.
    expect(profile.estimatedPerimeterLF).toBeNull();
  });

  test('the association unit total beats a PAO-won merge default of 1 (codex P2)', () => {
    const parcel = aggregateParcel();
    // Simulate a merge where a PAO record won: unitCount seeded to 1.
    const record = attachParcelMeta(
      { ...buildCadastralRecord(parcel, '1555 Tarpon Center Dr, Venice, FL 34285'), unitCount: 1 },
      parcel,
    );

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.unitCount).toBe(118);
  });

  test('a normal single-parcel profile keeps the single-building perimeter formula', () => {
    const profile = buildEnrichedProfile({
      propertyType: 'Single Family',
      lotSize: 10000,
      squareFootage: 2400,
      stories: 2,
    }, null, 27.4, -82.4);

    expect(profile.buildingCount).toBe(1);
    expect(profile.estimatedPerimeterLF).toBe(Math.round(4 * Math.sqrt(1200) * 1.35));
  });
});

describe('commercial county turf prior', () => {
  test('a county-dimensioned commercial record seeds the turf prior (was vision-only)', () => {
    const profile = buildEnrichedProfile({
      propertyType: 'Warehouse',
      _source: 'county',
      lotSize: 50000,
      squareFootage: 20000,
      stories: 1,
      imperviousAreaSf: 10000,
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
      },
    }, null, 27.4, -82.4);

    expect(profile.category).toBe('COMMERCIAL');
    // ceiling = 50000 − 20000 − 10000 = 20000; prior = 50%
    expect(profile.countyTurfPriorSf).toBe(10000);
    expect(profile.estimatedTurfSf).toBe(10000);
    expect(profile.turfSource).toBe('county_prior');
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'estimatedTurfSf', priority: 'HIGH' }),
    ]));
  });

  test('a residential shared-turf type (condo unit) still gets NO prior', () => {
    const profile = buildEnrichedProfile({
      propertyType: 'Condo',
      _source: 'county',
      lotSize: 50000,
      squareFootage: 1200,
      stories: 1,
      imperviousAreaSf: 10000,
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
      },
    }, null, 27.4, -82.4);

    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.countyTurfPriorSf).toBeNull();
  });
});

describe('codex round-1 hardening (#2721)', () => {
  const { aggregateSitusVerdict } = aiPrivate;

  test('mixed rows: living-only units each count as one unit', async () => {
    // Only one row exposes livunits; four more carry living area only. The
    // stack is still a 5-unit association, not a reject.
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1555, 101),
      unitFeature(1555, 102, { livunits: null }),
      unitFeature(1555, 103, { livunits: null }),
      unitFeature(1555, 104, { livunits: null }),
      unitFeature(1555, 105, { livunits: null }),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel).toMatchObject({ aggregated: true, residentialUnits: 5 });
  });

  test('no common row → no PAO parcel id (a unit id must not key by-parcel detail)', async () => {
    mockArcgis([
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.paoParcelId).toBeNull();
  });

  test('a genuine common row keeps its PAO parcel id', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.paoParcelId).toBe('0000007090');
  });

  test('the aggregate carries every building number for the situs guard', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1535, 101), unitFeature(1535, 102),
      unitFeature(1555, 103), unitFeature(1555, 104),
      unitFeature(1575, 205), unitFeature(1575, 206),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.situsHouseNumbers).toEqual(['1535', '1555', '1575']);
  });

  test('situs guard: any association building number is a valid hit', () => {
    const parcel = { aggregated: true, situsHouseNumbers: ['1535', '1555', '1575'] };

    expect(aggregateSitusVerdict(parcel, '1575 Tarpon Center Dr, Venice, FL 34285', 'rooftop')).toBe('keep');
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop')).toBe('keep');
    // A number OUTSIDE the association is still a wrong-building drop.
    expect(aggregateSitusVerdict(parcel, '1600 Tarpon Center Dr, Venice, FL 34285', 'rooftop')).toBe('drop');
    // Interpolated points need positive membership.
    expect(aggregateSitusVerdict(parcel, 'Tarpon Center Dr, Venice, FL 34285', 'interpolated')).toBe('drop');
    expect(aggregateSitusVerdict(parcel, '1575 Tarpon Center Dr, Venice, FL 34285', 'interpolated')).toBe('keep');
    // Rooftop with no typed number: keep (fail-open, matches single-parcel rule).
    expect(aggregateSitusVerdict(parcel, 'Tarpon Center Dr, Venice, FL 34285', 'rooftop')).toBe('keep');
  });
});

describe('codex round-2 hardening (#2721)', () => {
  const { aggregateSitusVerdict } = aiPrivate;

  test('interpolated verdict anchors to the RAW typed address, not the snapped canonical', () => {
    const parcel = { aggregated: true, situsHouseNumbers: ['1535', '1555', '1575'] };

    // Google snapped a nonexistent 1560 onto 1555 — the canonical says 1555
    // (in-association) but the customer typed 1560: drop.
    expect(aggregateSitusVerdict(
      parcel,
      '1555 Tarpon Center Dr, Venice, FL 34285',
      'interpolated',
      '1560 Tarpon Center Dr, Venice, FL 34285',
    )).toBe('drop');
    // Rooftop with the same snap: also a positive mismatch → drop.
    expect(aggregateSitusVerdict(
      parcel,
      '1555 Tarpon Center Dr, Venice, FL 34285',
      'rooftop',
      '1560 Tarpon Center Dr, Venice, FL 34285',
    )).toBe('drop');
    // Typed address with no number → canonical anchors (old behavior).
    expect(aggregateSitusVerdict(
      parcel,
      '1555 Tarpon Center Dr, Venice, FL 34285',
      'interpolated',
      'Tarpon Center Dr, Venice, FL 34285',
    )).toBe('keep');
  });

  test('a living-only unit row with a land figure can NOT become the master/common row', async () => {
    mockArcgis([
      // Looks land-bearing but is a UNIT (living area, no livunits) — must
      // not key PAO detail.
      unitFeature(1555, 101, { livunits: null, lsqft: 5000 }),
      unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.masterIsCommon).toBe(false);
    expect(parcel.paoParcelId).toBeNull();
  });

  test('aggregate dimensions survive a PAO-won merge (profile prices the association, not one unit)', () => {
    // Simulate the merged record a winning PAO unit record produces: unit
    // dimensions on the record, aggregate facts only in _parcel.
    const record = {
      propertyType: 'Multifamily',
      _source: 'hybrid',
      squareFootage: 920,
      lotSize: 0,
      stories: 2,
      unitCount: 1,
      _raw: { landUse: 'Multifamily condo/HOA association — 150 units, 3 buildings (county aggregate)' },
      _parcel: {
        aggregated: true,
        residentialUnits: 150,
        buildingCount: 3,
        livingAreaSqft: 122696,
        lotSqft: 240741,
      },
    };

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.homeSqFt).toBe(122696);
    expect(profile.lotSqFt).toBe(200000); // capped like the record caps
    expect(profile.unitCount).toBe(150);
    expect(profile.footprint).toBe(Math.round(122696 / 2));
  });

  test('unknown-stories aggregates get NO attic/slab prefill either', () => {
    const record = {
      propertyType: 'Multifamily',
      _source: 'county',
      squareFootage: 122696,
      lotSize: 200000,
      stories: null,
      _parcel: { aggregated: true, residentialUnits: 150, buildingCount: 3 },
    };

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.estimatedPerimeterLF).toBeNull();
    expect(profile.estimatedAtticSqFt).toBeNull();
    expect(profile.estimatedSlabSqFt).toBeNull();
  });
});
