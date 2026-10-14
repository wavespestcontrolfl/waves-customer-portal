/**
 * County parcel GIS: owner names on request only.
 *
 * The call last-name fill asks `lookupCountyParcelByPoint` for the parcel
 * owners (`includeOwners: true`). Every other caller must see exactly what it
 * saw before: no owner fields requested, no `ownerNames` on the result (so
 * nothing owner-shaped can reach a lookup cache or log). Names are invented;
 * field names and shapes match the three live layers.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { lookupCountyParcelByPoint, _private: { COUNTY_LAYERS } } = require('../services/property-lookup/county-parcel-gis');

const PT = { lat: 27.4, lng: -82.4 };
const RING = [[
  [-82.401, 27.399], [-82.399, 27.399], [-82.399, 27.401], [-82.401, 27.401], [-82.401, 27.399],
]];

const ROWS = {
  Manatee: { PARID: '1000000001', SITUS_ADDRESS: '100 SAMPLE AVE', PAR_OWNER_NAME1: 'EXAMPLE, PAT Q', PAR_OWNER_NAME2: '  SAMPLE,   ROBIN ' },
  Sarasota: { id: '2000000002', account: '2000000002', fulladdress: '100 SAMPLE AVE', name1: 'EXAMPLE PAT Q JR (E LIFE EST)', name_add2: '100 OTHER ST' },
  Charlotte: { ACCOUNT: '3000000003', FullPropertyAddress: '100 SAMPLE AVE', ownersname: '   EXAMPLE PAT Q & ROBIN L EXAMPLE   ' },
};

function mockArcgis(attributes) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [{ attributes, geometry: { rings: RING } }] }),
  });
}

const requestedFields = () => new URL(global.fetch.mock.calls[0][0]).searchParams.get('outFields').split(',');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

describe.each(['Manatee', 'Sarasota', 'Charlotte'])('%s', (county) => {
  test('default lookup: no owner fields requested, no ownerNames on the result', async () => {
    mockArcgis(ROWS[county]);
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county });
    expect(parcel.county).toBe(county);
    expect(requestedFields()).toEqual(COUNTY_LAYERS[county].outFields);
    for (const field of COUNTY_LAYERS[county].ownerFields) expect(requestedFields()).not.toContain(field);
    expect(parcel).not.toHaveProperty('ownerNames');
    expect(JSON.stringify(parcel)).not.toMatch(/EXAMPLE|SAMPLE, /);
  });

  test('includeOwners: asks for the owner fields and returns the raw strings, trimmed', async () => {
    mockArcgis(ROWS[county]);
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county, includeOwners: true });
    expect(requestedFields()).toEqual([...COUNTY_LAYERS[county].outFields, ...COUNTY_LAYERS[county].ownerFields]);
    expect(parcel.ownerNames).toEqual({
      Manatee: ['EXAMPLE, PAT Q', 'SAMPLE, ROBIN'],
      Sarasota: ['EXAMPLE PAT Q JR (E LIFE EST)', '100 OTHER ST'],
      Charlotte: ['EXAMPLE PAT Q & ROBIN L EXAMPLE'],
    }[county]);
  });

  test('includeOwners leaves every other field as the default lookup returns it', async () => {
    mockArcgis(ROWS[county]);
    const plain = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county });
    mockArcgis(ROWS[county]);
    const withOwners = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county, includeOwners: true });
    const { ownerNames, ...rest } = withOwners;
    expect(ownerNames).toBeDefined();
    expect(rest).toEqual(plain);
  });
});

test('empty owner fields give an empty list', async () => {
  mockArcgis({ PARID: '1000000001', SITUS_ADDRESS: '100 SAMPLE AVE', PAR_OWNER_NAME1: null, PAR_OWNER_NAME2: '' });
  const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee', includeOwners: true });
  expect(parcel.ownerNames).toEqual([]);
});

test('a stacked association gets no owner names', async () => {
  const unit = (n) => ({
    geometry: { rings: RING },
    attributes: {
      id: `0173122${n}`, fulladdress: `${n} SAMPLE CENTER DR ${n}, VENICE FL, 34285`, loccity: 'VENICE', loczip: '34285',
      lsqft: 0, living: 920, grnd_area: 1000, livunits: 1, yrbl: 1970, stcd: '0403', subd: '7090', name1: `UNIT OWNER ${n}`,
    },
  });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [1, 2, 3, 4, 5, 6].map(unit) }) });
  const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota', includeOwners: true });
  expect(parcel.aggregated).toBe(true);
  expect(parcel.ownerNames).toEqual([]);
});

test('owner names never reach a log line', async () => {
  mockArcgis(ROWS.Manatee);
  await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee', includeOwners: true });
  expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toMatch(/EXAMPLE|SAMPLE/i);
});
