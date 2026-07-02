/**
 * House-number audit: when every property provider comes back empty, the
 * lookup checks the typed house number against the county roll's situs
 * addresses for the same street, so the data-quality panel can say "house
 * number not on the county roll — nearest existing: N" (typo / misheard call
 * transcription) instead of an unexplained all-zeros panel.
 *
 * Real case this encodes: a voice transcription produced "4867 Tober Morey
 * Way" — Google geocodes the nonexistent 4867 happily, every provider fails
 * closed, and the actual parcel (deed on file) is 4857 Tobermory Way.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { auditAddressHouseNumber, hasCountyEvidence } = require('../services/property-lookup/ai-property-lookup');
const { queryStreetSitusAddresses } = require('../services/property-lookup/county-parcel-gis');
const { buildFieldVerifyFlags } = require('../routes/property-lookup-v2')._private;

// Manatee layer response shape; multi-situs strings (paired villas share a
// parcel) carry several addresses in one field, semicolon-delimited.
const TOBERMORY_SITUS = [
  ';4834 TOBERMORY WAY;4836 TOBERMORY WAY;',
  '4853 TOBERMORY WAY',
  '4857 TOBERMORY WAY',
  '4903 TOBERMORY WAY',
];

function mockSitusResponse(situsList) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: situsList.map((s) => ({ attributes: { SITUS_ADDRESS: s } })),
    }),
  });
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
  delete process.env.COUNTY_PARCEL_GIS_DISABLED;
});

// Zip 34211 opens the Manatee gate without needing a geocode.
const BAD_ADDRESS = '4867 Tobermory Way, Bradenton, FL 34211, USA';
const GOOD_ADDRESS = '4857 Tobermory Way, Bradenton, FL 34211, USA';

describe('auditAddressHouseNumber', () => {
  test('nonexistent house number on an existing street → nearest numbers', async () => {
    mockSitusResponse(TOBERMORY_SITUS);

    const audit = await auditAddressHouseNumber(BAD_ADDRESS);

    expect(audit).toMatchObject({
      county: 'Manatee',
      houseNumber: 4867,
      streetLabel: 'TOBERMORY WAY',
      streetExists: true,
      hasExactMatch: false,
      parcelCount: 4,
    });
    // 4857 (Δ10) and 4853 (Δ14) beat the paired-villa numbers (Δ31+)
    expect(audit.nearestNumbers).toContain(4857);
    expect(audit.nearestNumbers).toContain(4853);
    expect(audit.nearestNumbers).not.toContain(4867);
  });

  test('existing house number → exact match, no nearest list', async () => {
    mockSitusResponse(TOBERMORY_SITUS);

    const audit = await auditAddressHouseNumber(GOOD_ADDRESS);

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
    expect(audit.nearestNumbers).toEqual([]);
  });

  test('a GIS failure yields NO audit — an outage must not read as "street missing"', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('gis down'));

    const audit = await auditAddressHouseNumber(BAD_ADDRESS);

    expect(audit).toBeNull();
  });

  test('roll answered with zero matches → streetExists false (misspelling / new plat)', async () => {
    mockSitusResponse([]);

    const audit = await auditAddressHouseNumber('4867 Tober Morey Way, Bradenton, FL 34211');

    expect(audit).toMatchObject({
      county: 'Manatee',
      streetExists: false,
      hasExactMatch: false,
      parcelCount: 0,
    });
  });

  test('address outside every serviced county gate → null', async () => {
    mockSitusResponse(TOBERMORY_SITUS);

    const audit = await auditAddressHouseNumber('100 Biscayne Blvd, Miami, FL 33132');

    expect(audit).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('address without a leading house number → null', async () => {
    mockSitusResponse(TOBERMORY_SITUS);

    const audit = await auditAddressHouseNumber('Tobermory Way, Bradenton, FL 34211');

    expect(audit).toBeNull();
  });
});

describe('queryStreetSitusAddresses', () => {
  test('sanitizes the street text before building the where clause', async () => {
    mockSitusResponse(['4857 TOBERMORY WAY']);

    await queryStreetSitusAddresses('Manatee', "TOBER'MORY; DROP TABLE--");

    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('where')).toBe("UPPER(SITUS_ADDRESS) LIKE '%TOBER MORY DROP TABLE%'");
  });

  test('returns null (not []) on an HTTP error so failure is distinguishable', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    expect(await queryStreetSitusAddresses('Manatee', 'TOBERMORY')).toBeNull();
  });

  test('unknown county → null without a network call', async () => {
    mockSitusResponse([]);

    expect(await queryStreetSitusAddresses('Broward', 'TOBERMORY')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('hasCountyEvidence', () => {
  test.each([
    [null, false],
    [{ _source: 'ai' }, false],
    [{ _source: 'county' }, true],
    [{ _source: 'hybrid' }, true],
    [{ _source: 'cadastral' }, true],
    [{ _source: 'ai', _parcel: { parcelId: '579428409' } }, true],
  ])('%o → %s', (rc, expected) => {
    expect(hasCountyEvidence(rc)).toBe(expected);
  });
});

describe('buildFieldVerifyFlags address flag', () => {
  test('house-number miss renders first, HIGH, with the nearest numbers', () => {
    const flags = buildFieldVerifyFlags(null, null, {
      county: 'Manatee', houseNumber: 4867, streetLabel: 'TOBERMORY WAY',
      streetExists: true, hasExactMatch: false, parcelCount: 111, nearestNumbers: [4853, 4857],
    });

    expect(flags[0].field).toBe('address');
    expect(flags[0].priority).toBe('HIGH');
    expect(flags[0].reason).toContain('4867');
    expect(flags[0].reason).toContain('4857');
    expect(flags[0].reason).toContain('TOBERMORY WAY');
  });

  test('street-not-found phrasing when the roll answered empty', () => {
    const flags = buildFieldVerifyFlags(null, null, {
      county: 'Manatee', houseNumber: 4867, streetLabel: 'TOBER MOREY WAY',
      streetExists: false, hasExactMatch: false, parcelCount: 0, nearestNumbers: [],
    });

    expect(flags[0].field).toBe('address');
    expect(flags[0].reason).toContain('not found');
  });

  test('no audit → no address flag (existing flags unchanged)', () => {
    const flags = buildFieldVerifyFlags(null, null, null);
    expect(flags.some((f) => f.field === 'address')).toBe(false);
  });

  test('exact match → no address flag', () => {
    const flags = buildFieldVerifyFlags(null, null, {
      county: 'Manatee', houseNumber: 4857, streetLabel: 'TOBERMORY WAY',
      streetExists: true, hasExactMatch: true, parcelCount: 111, nearestNumbers: [],
    });
    expect(flags.some((f) => f.field === 'address')).toBe(false);
  });
});
