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

describe('codex round-3 hardening (#2721)', () => {
  const { aggregateSitusVerdict, addressHasSubpremise } = aiPrivate;

  test('a typed unit/suite bypasses aggregation — a condo resident is not the HOA', () => {
    const parcel = { aggregated: true, situsHouseNumbers: ['1535', '1555', '1575'] };

    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr #101, Venice, FL 34285')).toBe('drop');
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr unit 105, Venice, FL 34285')).toBe('drop');
    // Canonical (snapped) subpremise counts too — Google formats units as "#105".
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr #105, Venice, FL 34285', 'rooftop',
      undefined)).toBe('drop');
    // No subpremise → association behavior unchanged.
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr, Venice, FL 34285')).toBe('keep');
    expect(addressHasSubpremise('1555 Tarpon Center Dr Ste 200, Venice, FL')).toBe(true);
    expect(addressHasSubpremise('1555 Tarpon Center Dr, Venice, FL')).toBe(false);
  });

  test('a page-capped (truncated) stack defers instead of aggregating a partial sum', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        exceededTransferLimit: true,
        features: [
          MASTER_FEATURE,
          unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
          unitFeature(1555, 104), unitFeature(1555, 105),
        ],
      }),
    });

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel).toBeNull();
  });

  test('unknown-stories aggregates publish NO footprint claim, with a HIGH flag', () => {
    const record = {
      propertyType: 'Multifamily',
      _source: 'county',
      squareFootage: 122696,
      lotSize: 200000,
      stories: null,
      _parcel: { aggregated: true, residentialUnits: 150, buildingCount: 3 },
    };

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.footprint).toBe(0); // pricing must not read summed living area as a slab
    expect(profile.homeSqFt).toBe(122696); // interior work measure stays
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'footprint', priority: 'HIGH' }),
    ]));
  });

  test('known-stories aggregates still publish the derived footprint', () => {
    const record = {
      propertyType: 'Multifamily',
      _source: 'county',
      squareFootage: 122696,
      lotSize: 200000,
      stories: 2,
      _parcel: { aggregated: true, residentialUnits: 150, buildingCount: 3 },
    };

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.footprint).toBe(Math.round(122696 / 2));
    expect(profile.estimatedPerimeterLF).toBeGreaterThan(0);
  });
});

describe('codex round-4 hardening (#2721)', () => {
  const { aggregateSitusVerdict } = aiPrivate;
  const AGG = {
    aggregated: true,
    situsHouseNumbers: ['1535', '1555', '1575'],
    situsLines: ['1535 TARPON CENTER DR', '1555 TARPON CENTER DR', '1575 TARPON CENTER DR'],
  };

  test('a BARE trailing unit token drops the aggregate (unit lookup, not the HOA)', () => {
    expect(aggregateSitusVerdict(AGG, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr 101, Venice, FL 34285')).toBe('drop');
  });

  test('a matching number on a DIFFERENT street drops the aggregate', () => {
    expect(aggregateSitusVerdict(AGG, '1555 Tarpon Center Dr, Venice, FL', 'rooftop',
      '1555 Harbor Dr, Venice, FL 34285')).toBe('drop');
  });

  test('a full number+street match keeps the aggregate (rooftop and interpolated)', () => {
    expect(aggregateSitusVerdict(AGG, '1575 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1575 Tarpon Center Dr, Venice, FL 34285')).toBe('keep');
    expect(aggregateSitusVerdict(AGG, '1575 Tarpon Center Dr, Venice, FL 34285', 'interpolated',
      '1575 Tarpon Center Dr, Venice, FL 34285')).toBe('keep');
  });

  test('the aggregate carries full situs lines', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1575, 204), unitFeature(1575, 205),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.situsLines).toEqual(['1555 TARPON CENTER DR', '1575 TARPON CENTER DR']);
  });

  test('footprintUnknown rides the profile and blocks pricing-side re-derivation', () => {
    const { calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');

    const profile = buildEnrichedProfile({
      propertyType: 'Multifamily',
      _source: 'county',
      squareFootage: 122696,
      lotSize: 200000,
      stories: null,
      _parcel: { aggregated: true, residentialUnits: 150, buildingCount: 3 },
    }, null, PT.lat, PT.lng);

    expect(profile.footprintUnknown).toBe(true);
    // calculatePropertyProfile must NOT re-derive homeSqFt/stories into a slab.
    const property = calculatePropertyProfile({
      homeSqFt: profile.homeSqFt,
      stories: profile.stories,
      lotSqFt: profile.lotSqFt,
      footprintSqFt: profile.footprint,
      footprintUnknown: profile.footprintUnknown,
      propertyType: 'commercial',
    });
    expect(property.footprint || 0).toBe(0);
  });

  test('known-footprint paths are untouched by the footprintUnknown guard', () => {
    const { calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');
    const property = calculatePropertyProfile({
      homeSqFt: 2400,
      stories: 2,
      lotSqFt: 10000,
      propertyType: 'Single Family',
    });
    expect(property.footprint).toBe(1200);
  });
});

describe('codex round-5 hardening (#2721)', () => {
  const { aggregateSitusVerdict } = aiPrivate;

  test('aggregation strips labeled unit designators from situs lines', async () => {
    // "APT 101"-shaped situs: the bare-number strip alone would store
    // "13510 LUXE AVE APT" and the situs guard would read a valid
    // association lookup as a wrong street.
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(13510, 101, { fulladdress: '13510 LUXE AVE APT 101, VENICE FL, 34285' }),
      unitFeature(13510, 102, { fulladdress: '13510 LUXE AVE APT 102, VENICE FL, 34285' }),
      unitFeature(13510, 103, { fulladdress: '13510 LUXE AVE UNIT B-3, VENICE FL, 34285' }),
      unitFeature(13510, 104, { fulladdress: '13510 LUXE AVE # 104, VENICE FL, 34285' }),
      unitFeature(13510, 105, { fulladdress: '13510 LUXE AVE 105, VENICE FL, 34285' }),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.situsLines).toEqual(['13510 LUXE AVE']);
    expect(parcel.situsAddress).toBe('13510 LUXE AVE');
  });

  test('the situs guard also strips designators on cached aggregate lines', () => {
    // An aggregate cached before the aggregation-side strip still carries
    // the designator word — the guard must not read it as a different street.
    const parcel = {
      aggregated: true,
      situsHouseNumbers: ['13510'],
      situsLines: ['13510 LUXE AVE APT'],
    };

    expect(aggregateSitusVerdict(parcel, '13510 Luxe Ave, Venice, FL 34285', 'rooftop',
      '13510 Luxe Ave, Venice, FL 34285')).toBe('keep');
    // A genuinely different street still drops.
    expect(aggregateSitusVerdict(parcel, '13510 Luxe Ave, Venice, FL 34285', 'rooftop',
      '13510 Harbor Dr, Venice, FL 34285')).toBe('drop');
  });

  test('tech-verified dimensions outrank the county aggregate on re-lookup', () => {
    const record = {
      propertyType: 'Multifamily',
      _source: 'county',
      squareFootage: 90000, // verified downward correction
      lotSize: 150000,
      stories: 2,
      _fieldEvidence: {
        squareFootage: { sourceType: 'verified' },
        lotSize: { sourceType: 'verified' },
      },
      _parcel: {
        aggregated: true,
        residentialUnits: 150,
        buildingCount: 3,
        livingAreaSqft: 122696,
        lotSqft: 240741,
      },
    };

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);

    expect(profile.homeSqFt).toBe(90000);
    expect(profile.lotSqFt).toBe(150000);
  });

  test('translate zeroes an explicit footprint when footprintUnknown (client-derived slabs)', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const { calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');

    // The admin client re-derives profile.footprint = homeSqFt / stories
    // when building the request payload — the translation must not let that
    // positive value bypass the pricing-side derivation guard.
    const input = translateV2CallToV1Input({
      homeSqFt: 122696,
      lotSqFt: 200000,
      stories: 1,
      footprint: 122696,
      footprintUnknown: true,
      propertyType: 'commercial',
      isCommercial: true,
    }, [], {});

    expect(input.footprintSqFt).toBe(0);
    expect(input.footprintUnknown).toBe(true);

    const property = calculatePropertyProfile({
      homeSqFt: input.homeSqFt,
      stories: input.stories,
      lotSqFt: input.lotSqFt,
      footprintSqFt: input.footprintSqFt,
      footprintUnknown: input.footprintUnknown,
      propertyType: 'commercial',
    });
    expect(property.footprint || 0).toBe(0);
    // The returned property re-publishes the flag so downstream consumers
    // (the admin price-breakdown fallback included) don't re-derive either.
    expect(property.footprintUnknown).toBe(true);
  });

  test('translate forwards explicit footprints unchanged when stories are known', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const { calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');

    const input = translateV2CallToV1Input({
      homeSqFt: 2400,
      lotSqFt: 10000,
      stories: 2,
      footprint: 1200,
      propertyType: 'Single Family',
    }, [], {});

    expect(input.footprintSqFt).toBe(1200);
    expect(input.footprintUnknown).toBeUndefined();

    const property = calculatePropertyProfile({
      homeSqFt: 2400,
      stories: 2,
      lotSqFt: 10000,
      footprintSqFt: input.footprintSqFt,
      propertyType: 'Single Family',
    });
    expect(property.footprint).toBe(1200);
    expect(property.footprintUnknown).toBe(false);
  });
});

describe('codex round-6 hardening (#2721)', () => {
  const { aggregateSitusVerdict, addressHasSubpremise } = aiPrivate;

  test('a numbered route keeps its route number in situs lines', async () => {
    // "123 US 41": the trailing 41 is the street name, not a unit — every
    // row carries the identical full line, so stripping it would make the
    // situs guard reject the association as a wrong street.
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(123, 101, { fulladdress: '123 US 41, VENICE FL, 34285' }),
      unitFeature(123, 102, { fulladdress: '123 US 41, VENICE FL, 34285' }),
      unitFeature(123, 103, { fulladdress: '123 US 41, VENICE FL, 34285' }),
      unitFeature(123, 104, { fulladdress: '123 US 41, VENICE FL, 34285' }),
      unitFeature(123, 105, { fulladdress: '123 US 41, VENICE FL, 34285' }),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.situsLines).toEqual(['123 US 41']);
    expect(parcel.situsAddress).toBe('123 US 41');
    expect(aggregateSitusVerdict(parcel, '123 US 41, Venice, FL 34285', 'rooftop',
      '123 US 41, Venice, FL 34285')).toBe('keep');
  });

  test('varying trailing numbers still strip as unit numbers', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.situsLines).toEqual(['1555 TARPON CENTER DR']);
  });

  test('BLDG designators count as buildings under one street number', async () => {
    mockArcgis([
      MASTER_FEATURE,
      unitFeature(100, 101, { fulladdress: '100 MAIN ST BLDG A, VENICE FL, 34285' }),
      unitFeature(100, 102, { fulladdress: '100 MAIN ST BLDG A, VENICE FL, 34285' }),
      unitFeature(100, 103, { fulladdress: '100 MAIN ST BLDG B, VENICE FL, 34285' }),
      unitFeature(100, 104, { fulladdress: '100 MAIN ST BLDG B, VENICE FL, 34285' }),
      unitFeature(100, 105, { fulladdress: '100 MAIN ST BLDG C, VENICE FL, 34285' }),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.buildingCount).toBe(3);
    // The BLDG token is still a unit designator for street identity.
    expect(parcel.situsLines).toEqual(['100 MAIN ST']);
  });

  test('a common row with a BLANK parcel id exposes NO PAO parcel id', async () => {
    mockArcgis([
      { ...MASTER_FEATURE, attributes: { ...MASTER_FEATURE.attributes, id: null } },
      unitFeature(1555, 101), unitFeature(1555, 102), unitFeature(1555, 103),
      unitFeature(1555, 104), unitFeature(1555, 105),
    ]);

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.masterIsCommon).toBe(true);
    // parcelId fell back to a unit id — that unit id must NOT key by-parcel
    // PAO detail, or a single-unit record collapses the aggregate on merge.
    expect(parcel.paoParcelId).toBeNull();
  });

  test('punctuated unit designators (Apt. 101 / Ste. 200) bypass aggregation', () => {
    const parcel = {
      aggregated: true,
      situsHouseNumbers: ['1555'],
      situsLines: ['1555 TARPON CENTER DR'],
    };

    expect(addressHasSubpremise('1555 Tarpon Center Dr Apt. 101, Venice, FL')).toBe(true);
    expect(addressHasSubpremise('1555 Tarpon Center Dr Ste. 200, Venice, FL')).toBe(true);
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr Apt. 101, Venice, FL 34285')).toBe('drop');
    // Unpunctuated forms keep working.
    expect(aggregateSitusVerdict(parcel, '1555 Tarpon Center Dr, Venice, FL 34285', 'rooftop',
      '1555 Tarpon Center Dr, Venice, FL 34285')).toBe('keep');
  });

  test('commercial pest quote-requires instead of pricing off summed living area', () => {
    const { priceCommercialPest } = require('../services/pricing-engine/service-pricing');

    // footprintUnknown: resolvePestFootprint must NOT fall through to the
    // homeSqFt/stories alias (122,696 sf treated as a one-story slab).
    const line = priceCommercialPest({
      homeSqFt: 122696,
      stories: 1,
      footprintUnknown: true,
      commercialSubtype: 'multifamily_common_area_residential',
    }, {});

    expect(line.quoteRequired).toBe(true);
    expect(line.price).toBeNull();
    expect(line.manualReviewReasons).toContain('commercial_pest_missing_building_footprint');

    // A known building size still auto-prices.
    const priced = priceCommercialPest({ homeSqFt: 20000, stories: 2 }, {});
    expect(priced.quoteRequired).not.toBe(true);
    expect(priced.annual).toBeGreaterThan(0);
  });
});

describe('codex round-7 hardening (#2721)', () => {
  test('a measured termite footprint beats footprintUnknown (no 2,000 sf fallback pricing)', () => {
    const { priceCommercialTermiteBait, priceCommercialPest } = require('../services/pricing-engine/service-pricing');

    // Rep measured the building on site: options.footprintSqFt is injected
    // onto property.footprint/footprintSqFt — the explicit measurement must
    // win over the footprintUnknown suppression.
    const line = priceCommercialTermiteBait({
      homeSqFt: 122696,
      stories: 1,
      footprintUnknown: true,
    }, {
      termiteScope: 'monitoring_only',
      footprintSqFt: 30000,
    });

    expect(line.quoteRequired).not.toBe(true);
    expect(line.footprint).toBe(30000);
    // Perimeter re-derived from the MEASURED footprint (4·√30000), never
    // from the 2,000 sf fallback or the summed living area.
    expect(line.perimeter).toBeCloseTo(4 * Math.sqrt(30000), 0);

    // Same rule on commercial pest via an explicit property footprint.
    const pest = priceCommercialPest({
      homeSqFt: 122696,
      stories: 1,
      footprint: 30000,
      footprintUnknown: true,
    }, {});
    expect(pest.quoteRequired).not.toBe(true);
    expect(pest.annual).toBeGreaterThan(0);

    // Without a measurement the quote-required gate still holds.
    const gated = priceCommercialPest({ homeSqFt: 122696, stories: 1, footprintUnknown: true }, {});
    expect(gated.quoteRequired).toBe(true);
  });

  test('verified sqft covers the aggregate/commercial range', () => {
    const { sanitizeVerifiedValue } = require('../services/property-lookup/lookup-cache');

    // A rep correcting a 122k aggregate down to 90k must not be silently
    // dropped by the old 50k cap.
    expect(sanitizeVerifiedValue('squareFootage', 90000)).toBe(90000);
    expect(sanitizeVerifiedValue('squareFootage', 200000)).toBe(200000);
    // A verified fact above the old 200k publish cap persists — the range is
    // a typo guard, not a pricing bound (270k warehouses are real).
    expect(sanitizeVerifiedValue('squareFootage', 270000)).toBe(270000);
    expect(sanitizeVerifiedValue('squareFootage', 2000001)).toBeUndefined();
    // A verified story count on a mid-rise (>4 floors) must persist — it is
    // exactly how an unknown-stories aggregate resolves.
    expect(sanitizeVerifiedValue('stories', 6)).toBe(6);
    expect(sanitizeVerifiedValue('stories', 51)).toBeUndefined();
  });
});

describe('codex round-8 hardening (#2721)', () => {
  const { aggregateSitusVerdict, addressHasSubpremise } = aiPrivate;

  test('LOT and FL floor designators read as subpremises — state FL does not', () => {
    expect(addressHasSubpremise('1555 Main St Lot 12, Venice, FL')).toBe(true);
    expect(addressHasSubpremise('100 Main St FL 2, Venice, FL 34285')).toBe(true);
    // The state abbreviation must NEVER read as a floor designator — with
    // or without commas, with or without the +4 zip.
    expect(addressHasSubpremise('1555 Tarpon Center Dr, Venice, FL 34285')).toBe(false);
    expect(addressHasSubpremise('1555 Tarpon Center Dr Venice FL 34285')).toBe(false);
    expect(addressHasSubpremise('1555 Tarpon Center Dr, Venice, FL 34285-1234')).toBe(false);
    expect(addressHasSubpremise('1555 Tarpon Center Dr, Venice, FL')).toBe(false);

    const parcel = {
      aggregated: true,
      situsHouseNumbers: ['1555'],
      situsLines: ['1555 MAIN ST'],
    };
    expect(aggregateSitusVerdict(parcel, '1555 Main St, Venice, FL 34285', 'rooftop',
      '1555 Main St Lot 12, Venice, FL 34285')).toBe('drop');
  });

  test('a known high-rise story count on an aggregate survives the cadastral parse', () => {
    const parcel = {
      parcelId: '0000007090',
      county: 'Sarasota',
      gisProvider: 'sarasota_gis',
      situsAddress: '1555 TARPON CENTER DR',
      situsCity: 'VENICE',
      situsZip: '34285',
      lotSqft: 98084,
      livingAreaSqft: 104096,
      stories: 8,
      yearBuilt: 1970,
      residentialUnits: 118,
      dorUseCode: '0403',
      landUseDescription: 'Multifamily condo/HOA association — 118 units, 1 building (county aggregate)',
      aggregated: true,
      aggregateUnitParcels: 118,
      buildingCount: 1,
    };

    const record = attachParcelMeta(
      buildCadastralRecord(parcel, '1555 Tarpon Center Dr, Venice, FL 34285'),
      parcel,
    );
    expect(record.stories).toBe(8);

    // With the story count intact the profile derives a real footprint —
    // no footprintUnknown, prefills present.
    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);
    expect(profile.footprintUnknown).toBeUndefined();
    expect(profile.footprint).toBe(Math.round(104096 / 8));
    expect(profile.estimatedPerimeterLF).toBeGreaterThan(0);

    // Residential parses keep the 1–4 clamp.
    const house = buildCadastralRecord({
      parcelId: 'X', gisProvider: 'sarasota_gis', livingAreaSqft: 2400,
      lotSqft: 10000, stories: 8, dorUseCode: '0100',
      landUseDescription: 'Single Family Residential',
    }, '100 Oak St, Venice, FL');
    expect(house.stories).toBeNull(); // out of residential range → dropped, not trusted
  });
});
