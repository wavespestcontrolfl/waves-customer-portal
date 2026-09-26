/**
 * A cache-hit property lookup must never block on a cold DBPR download
 * (primary review of commit b1150dec5c). This exercises the REAL
 * commercial-suite-size + dbpr-food-license modules end to end (only
 * `fetchText` is injected, via the opts chain applyCommercialSuiteSize ->
 * resolveCommercialSuiteSize -> resolveViaDbprLicense already forwards) so
 * a reintroduced "await the fetch" leak fails here, not just at the unit
 * level.
 */

// Suite sizing ships dark behind GATE_COMMERCIAL_SUITE_SIZING; these tests exercise it ON.
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private: routePrivate, buildEnrichedProfile } = require('../routes/property-lookup-v2');
const { _resetCacheForTests } = require('../services/commercial-suite-size/dbpr-food-license');

const DBPR_HEADER = [
  'Board Code', 'License Type Code', 'Licensee Name', 'Rank Code', 'Modifier Code',
  'Mailing Name', 'Mailing Street Address', 'Mailing Address Line 2', 'Mailing Address Line 3',
  'Mailing City', 'Mailing State Code', 'Mailing Zip Code', 'Primary Phone Number',
  'Mailing County Code', 'Business Name', 'Filler', 'Location Street Address',
  'Location Address Line 2', 'Location Address Line 3', 'Location City', 'Location State Code',
  'Location Zip Code', 'Location County Code', 'Location County', 'Secondary Phone Number',
  'District', 'Region', 'License Number', 'Primary Status Code', 'Secondary Status Code',
  'License Expiry Date', 'Last Inspection Date', 'Number of Seats or Rental Units',
  'Base Risk Level', 'Secondary Risk Level',
];
function csvRow(fields = {}) {
  return DBPR_HEADER.map((h) => `"${String(fields[h] ?? '').replace(/"/g, '""')}"`).join(',');
}
// Unrelated licenses elsewhere in the district: a real extract has
// thousands of rows, and the loader rejects one under 1,000 as partial.
const FILLER_ROWS = Array.from({ length: 1000 }, (_, i) => ({
  'Location Street Address': `${9000 + i} Filler Rd`,
  'Location Zip Code': '99999',
  'Business Name': `Filler ${i}`,
}));
function csv(rows) {
  const all = rows.length ? [...rows, ...FILLER_ROWS] : rows;
  return [DBPR_HEADER.map((h) => `"${h}"`).join(','), ...all.map(csvRow)].join('\r\n') + '\r\n';
}

function plazaSuiteRecord(overrides = {}) {
  return {
    formattedAddress: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    propertyType: 'Commercial',
    squareFootage: 46031,
    _parcel: { landUseDescription: 'Community Shopping Centers (1555)' },
    unitCount: 1,
    _source: 'county',
    _fieldEvidence: {
      propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
    },
    ...overrides,
  };
}
const SUITE_ADDRESS = '4400 Test Commons Pkwy E #102, Bradenton, FL 00000';

beforeEach(() => {
  _resetCacheForTests();
  process.env.COMMERCIAL_SUITE_WEB_SEARCH = 'false'; // deterministic — skipWebSearch is also passed regardless
});
afterEach(() => {
  delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
});

test('a cold DBPR cache on a cache-hit request falls back to the type default without blocking on the fetch, and kicks a background warm-up', async () => {
  let releaseFetch;
  const pending = new Promise((resolve) => { releaseFetch = resolve; });
  const fetchText = jest.fn().mockReturnValue(pending);

  const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
  await routePrivate.applyCommercialSuiteSize(profile, { skipWebSearch: true, requireWarmCache: true, fetchText });

  expect(profile.suiteSize.source).toBe('suite_type_default');
  expect(Number(profile.homeSqFt)).toBeGreaterThan(0);
  // The background warm-up DID kick the real download (for the NEXT
  // request) — proving this call returned without awaiting it.
  expect(fetchText).toHaveBeenCalledTimes(1);

  releaseFetch(csv([]));
  await Promise.resolve().then(() => Promise.resolve());
});

test('a warm DBPR cache on a cache-hit request resolves the real match with zero fetch calls', async () => {
  const warmupText = csv([{
    'Location Street Address': '4400 Test Commons Pkwy E #102',
    'Location Zip Code': '00000',
    'Business Name': 'Test Taco Shop',
    'Number of Seats or Rental Units': '25',
    'License Type Code': '2010',
    'Primary Status Code': '20',
    'Rank Code': 'SEAT',
  }]);
  const warmFetch = jest.fn().mockResolvedValue(warmupText);
  // Simulates a prior FRESH lookup that already warmed DBPR's in-process
  // cache (no requireWarmCache/skipWebSearch restriction on that call).
  const warmupProfile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
  await routePrivate.applyCommercialSuiteSize(warmupProfile, { fetchText: warmFetch });
  expect(warmupProfile.suiteSize.source).toBe('license_seats');

  // A SEPARATE cache-hit request for the same address, on a record with no
  // stamp of its own (a pre-existing cached row from before this feature).
  const fetchText = jest.fn(); // must never be called
  const cacheHitProfile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, { commercialSuiteSizing: true });
  await routePrivate.applyCommercialSuiteSize(cacheHitProfile, { skipWebSearch: true, requireWarmCache: true, fetchText });

  expect(cacheHitProfile.suiteSize.source).toBe('license_seats');
  expect(cacheHitProfile.homeSqFt).toBe(1400);
  expect(fetchText).not.toHaveBeenCalled();
});

describe('coalescing key separates suite-sizing lookups', () => {
  test('an opt-in suite-sizing lookup never joins an ordinary in-flight lookup', () => {
    const key = require('../routes/property-lookup-v2')._private.lookupCoalesceKey;
    const a = key('4400 Test Commons Pkwy E #102, Bradenton, FL 00000', {});
    const b = key('4400 Test Commons Pkwy E #102, Bradenton, FL 00000', { commercialSuiteSizing: true });
    expect(a).not.toBe(b);
  });
});
