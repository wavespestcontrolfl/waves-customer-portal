/**
 * Condo unit folio (unit-scope ruling #8, GATE_CONDO_UNIT_FOLIO).
 *
 * A condo building's units are stacked on ONE shared county polygon, so the
 * point query returns every unit row and buildStackedAggregate sums them into
 * an association. A typed Apt/Unit used to DROP that aggregate to the address
 * search, where a listing or the building's figures could price the unit.
 * The roll already carries the unit's own row (own parcel id, own living
 * area) in the same response — the Manatee layer labels it "UNIT 301" /
 * "APT 706", the Sarasota layer appends a bare "201" (both live-probed
 * 2026-09-27). With the gate on, a UNIQUE EXACT match resolves that row:
 * same "NUMBER STREET", same unit id, building agreeing when both name one,
 * and a row that is one dwelling with its own living area. More than one
 * match (repeated unit numbers across buildings) is flagged, never picked.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const {
  lookupPropertyFromAITrio,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile, _private: routePrivate } = require('../routes/property-lookup-v2');

const {
  buildCadastralRecord, attachParcelMeta, aggregateUnitDesignatorMatch, typedDwellingUnit,
} = aiPrivate;
const { cachedUnitFolioStale } = routePrivate;

const PT = { lat: 27.07, lng: -82.45 };
const RING = [[
  [-82.451, 27.069], [-82.449, 27.069], [-82.449, 27.071], [-82.451, 27.071], [-82.451, 27.069],
]];

// Sarasota layer: bare trailing unit number, one row per unit.
function sarasotaUnit(unit, overrides = {}) {
  return {
    geometry: { rings: RING },
    attributes: {
      id: `01731220${unit}`,
      account: `A${unit}`,
      fulladdress: `1555 TARPON CENTER DR ${unit}, VENICE FL, 34285`,
      loccity: 'VENICE',
      loczip: '34285',
      subd: 'TARPON TOWERS',
      pool: 'Y',
      grnd_area: 992,
      living: 900 + (unit % 5) * 10,
      livunits: 1,
      yrbl: 1970,
      lsqft: 0,
      stcd: '0403',
      ...overrides,
    },
  };
}

const SARASOTA_UNITS = [101, 102, 103, 201, 202, 203];

// Manatee layer: labeled designator, optional BLDG token.
function manateeUnit(situs, id, overrides = {}) {
  return {
    geometry: { rings: RING },
    attributes: {
      PARID: id,
      SITUS_ADDRESS: situs,
      SITUS_POSTAL_CITY: 'BRADENTON',
      SITUS_POSTAL_ZIP: '34202',
      LAND_SQFT_CAMA: 0,
      BLDGS_SQFT_LIVING: 1297,
      BLDG_R1_STORIES: 1,
      BLDG_R1_YRBUILT: 2019,
      BLDGS_LIVINGUNITS: 1,
      CUR_DOR_LUC_CODE: '04',
      CUR_MAN_LUC_DESC: 'Condominia Improved (1554)',
      PAR_SUBDIV_NAME: 'SAMPLE HARBOR',
      PAR_SWIMPOOL_FLAG: 'N',
      CUR_ROLL_YEAR: 2026,
      ...overrides,
    },
  };
}

function mockArcgis(features) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features }),
  });
}

const realFetch = global.fetch;
const savedGate = process.env.GATE_CONDO_UNIT_FOLIO;
afterEach(() => {
  global.fetch = realFetch;
  if (savedGate === undefined) delete process.env.GATE_CONDO_UNIT_FOLIO;
  else process.env.GATE_CONDO_UNIT_FOLIO = savedGate;
  jest.clearAllMocks();
});

async function sarasotaBuilding(extra = []) {
  mockArcgis([...SARASOTA_UNITS.map((u) => sarasotaUnit(u)), ...extra]);
  return lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });
}

const TARPON = (line2) => `1555 Tarpon Center Dr ${line2}, Venice, FL 34285`;

describe('unitDesignatorRows on the aggregate', () => {
  test('Sarasota bare trailing numbers read as units (cross-row evidence)', async () => {
    const parcel = await sarasotaBuilding();

    expect(parcel.aggregated).toBe(true);
    expect(parcel.unitDesignatorRows).toHaveLength(6);
    expect(parcel.unitDesignatorRows[0]).toMatchObject({ line: '1555 TARPON CENTER DR', building: null });
    expect(parcel.unitDesignatorRows.map((e) => e.unit).sort()).toEqual(SARASOTA_UNITS.map(String).sort());
  });

  test('Manatee labeled UNIT/APT with a BLDG token keeps the building', async () => {
    mockArcgis([1, 2, 3].flatMap((n) => [
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG A UNIT 30${n}`, `A30${n}`),
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG B APT 30${n}`, `B30${n}`),
    ]));
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.unitDesignatorRows).toContainEqual(expect.objectContaining({
      line: '8100 SAMPLE HARBOR WAY', unit: '301', building: 'B',
    }));
  });

  test('a county row "BLDG #2 UNIT 301" names unit 301 in building 2', async () => {
    mockArcgis([1, 2, 3].flatMap((n) => [
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG #2 UNIT 30${n}`, `B30${n}`),
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG #2 UNIT ${n}`, `B${n}`),
    ]));
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel.unitDesignatorRows).toContainEqual(expect.objectContaining({ unit: '301', building: '2' }));
    const addr = '8100 Sample Harbor Way Bldg #2 Unit 301, Bradenton, FL 34202';
    expect(aggregateUnitDesignatorMatch(parcel, addr, addr)).toMatchObject({ status: 'resolved', row: { parcelId: 'B301' } });
  });

  test('a numbered route ("123 US 41") is never read as a unit number', async () => {
    mockArcgis([1, 2, 3, 4, 5].map((n) => manateeUnit('123 US 41', `R${n}`)));
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });

    expect(parcel.aggregated).toBe(true);
    expect(parcel.unitDesignatorRows).toEqual([]);
  });
});

describe('typedDwellingUnit', () => {
  test.each([
    ['1555 Tarpon Center Dr Apt 201, Venice, FL 34285', '201'],
    ['1555 Tarpon Center Dr Apt. 201, Venice, FL 34285', '201'],
    ['1555 Tarpon Center Dr #201, Venice, FL 34285', '201'],
    ['1555 Tarpon Center Dr, Unit 0201, Venice, FL 34285', '201'],
    ['Unit 201, 1555 Tarpon Center Dr, Venice, FL 34285', '201'],
  ])('%s → unit %s on the street line', (address, unit) => {
    expect(typedDwellingUnit(address)).toEqual({ line: '1555 TARPON CENTER DR', unit, building: null });
  });

  test('a hash-prefixed building number is never read as the unit', () => {
    expect(typedDwellingUnit('100 Main St Bldg #2 Unit 301, Venice, FL 34285'))
      .toEqual({ line: '100 MAIN ST', unit: '301', building: '2' });
    expect(typedDwellingUnit('100 Main St Unit 301 Bldg #2, Venice, FL 34285'))
      .toEqual({ line: '100 MAIN ST', unit: '301', building: '2' });
  });

  test('suite / lot / trailer / room are not dwelling units', () => {
    expect(typedDwellingUnit('1555 Tarpon Center Dr Ste 201, Venice, FL 34285')).toBeNull();
    expect(typedDwellingUnit('1555 Tarpon Center Dr Lot 12, Venice, FL 34285')).toBeNull();
  });

  test('a bare trailing number leaves the unit to the caller', () => {
    expect(typedDwellingUnit(TARPON('201'))).toMatchObject({ unit: null });
  });
});

describe('aggregateUnitDesignatorMatch', () => {
  test('a unique exact match resolves the unit\'s own row — every typed form', async () => {
    const parcel = await sarasotaBuilding();
    for (const line2 of ['Apt 201', '#201', 'Unit 0201', '201']) {
      const match = aggregateUnitDesignatorMatch(parcel, TARPON(line2), TARPON(line2));
      expect(match).toMatchObject({ status: 'resolved', row: { parcelId: '01731220201', livingAreaSqft: 910 } });
    }
  });

  test('anchors to the TYPED address, not the canonical one', async () => {
    const parcel = await sarasotaBuilding();
    const match = aggregateUnitDesignatorMatch(parcel, TARPON('Apt 202'), TARPON('Apt 201'));
    expect(match.row.parcelId).toBe('01731220201');
  });

  test('a unit number the roll does not list is not matched', async () => {
    const parcel = await sarasotaBuilding();
    expect(aggregateUnitDesignatorMatch(parcel, TARPON('Apt 999'), TARPON('Apt 999')))
      .toEqual({ status: 'unit_not_matched' });
  });

  test('a row without its own living area, or covering several units, is never the folio', async () => {
    const parcel = await sarasotaBuilding([
      sarasotaUnit(301, { living: null }),
      sarasotaUnit(302, { livunits: 4, living: 3600 }),
    ]);
    // 301 has no living area and livunits 1 → still a unit row, not attested.
    expect(aggregateUnitDesignatorMatch(parcel, TARPON('Apt 301'), TARPON('Apt 301')).status).toBe('unit_not_matched');
    expect(aggregateUnitDesignatorMatch(parcel, TARPON('Apt 302'), TARPON('Apt 302')).status).toBe('unit_not_matched');
  });

  test('a row with living area but no unit count is not positively one dwelling', async () => {
    const parcel = await sarasotaBuilding([sarasotaUnit(303, { livunits: null })]);
    expect(aggregateUnitDesignatorMatch(parcel, TARPON('Apt 303'), TARPON('Apt 303')).status).toBe('unit_not_matched');
  });

  test('the same unit number in two buildings is ambiguous unless the building is typed', async () => {
    mockArcgis([1, 2, 3].flatMap((n) => [
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG A UNIT 30${n}`, `A30${n}`),
      manateeUnit(`8100 SAMPLE HARBOR WAY BLDG B UNIT 30${n}`, `B30${n}`, { BLDGS_SQFT_LIVING: 1156 }),
    ]));
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' });
    const addr = (line2) => `8100 Sample Harbor Way ${line2}, Bradenton, FL 34202`;

    expect(aggregateUnitDesignatorMatch(parcel, addr('Unit 301'), addr('Unit 301')))
      .toEqual({ status: 'multiple_unit_matches', candidates: 2 });
    expect(aggregateUnitDesignatorMatch(parcel, addr('Bldg B Unit 301'), addr('Bldg B Unit 301')))
      .toMatchObject({ status: 'resolved', row: { parcelId: 'B301', livingAreaSqft: 1156 } });
  });

  test('a different street, or no unit at all, is not a unit lookup on this building', async () => {
    const parcel = await sarasotaBuilding();
    expect(aggregateUnitDesignatorMatch(parcel, '1555 Harbor Dr Apt 201, Venice, FL', '1555 Harbor Dr Apt 201, Venice, FL')).toBeNull();
    expect(aggregateUnitDesignatorMatch(parcel, '1555 Harbor Dr 201, Venice, FL', '1555 Harbor Dr 201, Venice, FL')).toBeNull();
    expect(aggregateUnitDesignatorMatch(parcel, TARPON('Ste 201'), TARPON('Ste 201'))).toBeNull();
  });
});

describe('resolved unit → record → profile', () => {
  const savedUnitScope = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
  afterEach(() => {
    if (savedUnitScope === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
    else process.env.GATE_UNIT_SCOPE_GUARDRAILS = savedUnitScope;
  });

  test('prices ONE residential condo unit from its own county sq ft, no lot, association as context', async () => {
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    const { unitParcelFromAggregateRow } = require('../services/property-lookup/county-parcel-gis');
    const parcel = await sarasotaBuilding();
    const ADDR = TARPON('Apt 201');
    const { row } = aggregateUnitDesignatorMatch(parcel, ADDR, ADDR);
    const unit = unitParcelFromAggregateRow(parcel, row);
    const record = attachParcelMeta(buildCadastralRecord(unit, ADDR), unit);

    expect(record).toMatchObject({ propertyType: 'Condo', squareFootage: 910 });
    expect(record.lotSize || 0).toBe(0);
    expect(record._parcel.aggregated).toBeUndefined();
    expect(record._parcel.association).toMatchObject({ residentialUnits: 6 });

    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng, null, null, ADDR);
    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.homeSqFt).toBe(910);
    expect(profile.lotSqFt).toBe(0);
  });

  test('an ambiguous unit match raises a HIGH sq ft flag (gate on only)', () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    const record = {
      formattedAddress: '8100 Sample Harbor Way Unit 301, Bradenton, FL 34202',
      propertyType: 'Condo',
      _unitFolio: { status: 'multiple_unit_matches', candidates: 2 },
    };
    const profile = buildEnrichedProfile(record, null, PT.lat, PT.lng);
    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'squareFootage' && /2 county unit records/.test(f.reason));
    expect(flag).toMatchObject({ priority: 'HIGH' });

    delete process.env.GATE_CONDO_UNIT_FOLIO;
    const off = buildEnrichedProfile(record, null, PT.lat, PT.lng);
    expect(off.fieldVerifyFlags.some((f) => /county unit records/.test(f.reason))).toBe(false);
  });
});

describe('the trio, end to end', () => {
  const AI_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
  const saved = {};
  beforeEach(() => {
    for (const key of AI_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of AI_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const geo = {
    lat: PT.lat,
    lng: PT.lng,
    county: 'Sarasota',
    state: 'FL',
    city: 'Venice',
    zip: '34285',
    formattedAddress: '1555 Tarpon Center Dr #201, Venice, FL 34285, USA',
    partialMatch: false,
    locationType: 'ROOFTOP',
  };

  function mockSarasotaOnly() {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('scgov.net') && String(url).includes('FeatureServer')) {
        return { ok: true, json: async () => ({ features: SARASOTA_UNITS.map((u) => sarasotaUnit(u)) }) };
      }
      throw new Error('network disabled in test');
    });
  }

  test('gate ON: the typed unit resolves to its own county row and diag records it', async () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    mockSarasotaOnly();
    const diag = {};
    const merged = await lookupPropertyFromAITrio(TARPON('Apt 201'), geo, diag);

    expect(diag.unitFolio).toMatchObject({ status: 'resolved' });
    expect(diag.countyGisAnswered).toBe(true);
    expect(merged).toMatchObject({ squareFootage: 910 });
    expect(merged._parcel).toMatchObject({ parcelId: '01731220201', association: { residentialUnits: 6 } });
    expect(merged.lotSize || 0).toBe(0);
  });

  test('gate ON: a failed county leg never reads as a definitive answer', async () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    global.fetch = jest.fn(async () => { throw new Error('county GIS down'); });
    const diag = {};
    await lookupPropertyFromAITrio(TARPON('Apt 201'), geo, diag);

    expect(diag.unitFolio).toBeUndefined();
    expect(diag.countyGisAnswered).toBeUndefined();
  });

  test('gate OFF: the aggregate drops to the address search as before', async () => {
    delete process.env.GATE_CONDO_UNIT_FOLIO;
    mockSarasotaOnly();
    const diag = {};
    const merged = await lookupPropertyFromAITrio(TARPON('Apt 201'), geo, diag);

    expect(diag.unitFolio).toBeUndefined();
    expect(merged).toBeNull();
  });
});

describe('cached unit addresses vs the unit folio', () => {
  const ADDR = TARPON('Apt 201');

  test('gate ON: a unit-address row without the checked marker misses once', () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    expect(cachedUnitFolioStale({ squareFootage: 122696 }, ADDR)).toBe(true);
    expect(cachedUnitFolioStale({ _unitFolio: { status: 'no_stacked_building' } }, ADDR)).toBe(false);
    expect(cachedUnitFolioStale({ squareFootage: 1800 }, '1555 Tarpon Center Dr, Venice, FL 34285')).toBe(false);
    expect(cachedUnitFolioStale(null, ADDR)).toBe(false);
  });

  test('gate ON: a bare trailing unit number misses once too; a numbered route does not', () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    expect(cachedUnitFolioStale({ squareFootage: 122696 }, TARPON('201'))).toBe(true);
    expect(cachedUnitFolioStale({ _unitFolio: { status: 'no_stacked_building' } }, TARPON('201'))).toBe(false);
    expect(cachedUnitFolioStale({ squareFootage: 1800 }, '123 US 41, Venice, FL 34285')).toBe(false);
  });

  test('gate ON: a county_unavailable stamp retries after a day, not on every lookup', () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    const now = Date.parse('2026-09-28T12:00:00Z');
    const stamp = (checkedAt) => ({ _unitFolio: { status: 'county_unavailable', checkedAt } });
    expect(cachedUnitFolioStale(stamp('2026-09-28T01:00:00Z'), ADDR, now)).toBe(false);
    expect(cachedUnitFolioStale(stamp('2026-09-27T11:00:00Z'), ADDR, now)).toBe(true);
    expect(cachedUnitFolioStale(stamp(undefined), ADDR, now)).toBe(true);
  });

  test('gate ON: a two-letter post-direction bare unit ("Main St NW 201") misses once', () => {
    process.env.GATE_CONDO_UNIT_FOLIO = 'true';
    expect(cachedUnitFolioStale({ squareFootage: 122696 }, '1555 Main St NW 201, Venice, FL 34285')).toBe(true);
  });

  test('gate OFF (kill switch): a row the folio touched misses; untouched rows stay hits', () => {
    delete process.env.GATE_CONDO_UNIT_FOLIO;
    expect(cachedUnitFolioStale({ squareFootage: 910, _unitFolio: { status: 'resolved' } }, ADDR)).toBe(true);
    expect(cachedUnitFolioStale({ _unitFolio: { status: 'no_stacked_building' } }, ADDR)).toBe(true);
    expect(cachedUnitFolioStale({ squareFootage: 122696 }, ADDR)).toBe(false);
  });

  test('gate reads strictly: only exactly "true" is on', () => {
    for (const value of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env.GATE_CONDO_UNIT_FOLIO = value;
      expect(cachedUnitFolioStale({ squareFootage: 122696 }, ADDR)).toBe(false);
    }
  });
});
