const {
  parseDbprCsv,
  normalizeStreetName,
  matchDbprRow,
  seatsToSqft,
  resolveViaDbprLicense,
  _resetCacheForTests,
} = require('../services/commercial-suite-size/dbpr-food-license');

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

// Builds one synthetic CSV row from a sparse field map — every column the
// test doesn't care about is blank, matching how the real extract pads
// unused columns.
// Defaults describe an ACTIVE PERMANENT food-service license (type 2010,
// status 20, rank SEAT — NOST for a zero-seat takeout) unless a test
// overrides them.
function csvRow(fields = {}) {
  const seats = String(fields['Number of Seats or Rental Units'] ?? '');
  const withDefaults = {
    'License Type Code': '2010',
    'Primary Status Code': '20',
    'Rank Code': seats === '0' ? 'NOST' : 'SEAT',
    ...fields,
  };
  return DBPR_HEADER.map((h) => `"${String(withDefaults[h] ?? '').replace(/"/g, '""')}"`).join(',');
}

function csv(rows) {
  return [DBPR_HEADER.map((h) => `"${h}"`).join(','), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

describe('normalizeStreetName', () => {
  test('State Road / SR spellings and direction words compare equal', () => {
    expect(normalizeStreetName('State Road 999 East')).toBe(normalizeStreetName('SR 999 E'));
    expect(normalizeStreetName('State Rd 999 E')).toBe(normalizeStreetName('SR 999 East'));
  });

  test('punctuation and case fall away', () => {
    expect(normalizeStreetName('Main St.')).toBe(normalizeStreetName('MAIN STREET'));
  });
});

describe('parseDbprCsv', () => {
  test('maps header to synthetic rows', () => {
    const text = csv([
      { 'Business Name': 'TEST TACO SHOP', 'Location Zip Code': '00000', 'Number of Seats or Rental Units': '25' },
    ]);
    const rows = parseDbprCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Business Name']).toBe('TEST TACO SHOP');
    expect(rows[0]['Number of Seats or Rental Units']).toBe('25');
  });

  test('handles quoted commas inside a field', () => {
    const text = csv([{ 'Business Name': 'TEST, BAR & GRILL', 'Location Zip Code': '00000' }]);
    const rows = parseDbprCsv(text);
    expect(rows[0]['Business Name']).toBe('TEST, BAR & GRILL');
  });
});

describe('seatsToSqft', () => {
  test('formula: 600 base + 32/seat, clamped 1000-6000', () => {
    expect(seatsToSqft(25)).toBe(1400); // matches the owner's dry-run example
    expect(seatsToSqft(0)).toBe(1000); // floors at the minimum
    expect(seatsToSqft(null)).toBe(1000);
    expect(seatsToSqft(-5)).toBe(1000);
    expect(seatsToSqft(200)).toBe(6000); // ceilings at the maximum
  });
});

describe('matchDbprRow', () => {
  const baseRow = (overrides = {}) => ({
    'Location Street Address': '4400 Test Commons Pkwy E #102',
    'Location Zip Code': '00000',
    'Secondary Phone Number': '(941) 555-0199',
    'Business Name': 'TEST TACO SHOP',
    'Number of Seats or Rental Units': '25',
    ...overrides,
  });

  test('matches on zip + house number + normalized street + unit', () => {
    const rows = [baseRow()];
    const match = matchDbprRow(rows, {
      street: '4400 Test Commons Parkway East', unit: '102', zip: '00000',
    });
    expect(match).toBeTruthy();
    expect(match['Business Name']).toBe('TEST TACO SHOP');
  });

  test('disambiguates multiple suites at the same building by unit number', () => {
    const rows = [
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #102', 'Business Name': 'SUITE 102 EATERY' }),
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #104', 'Business Name': 'SUITE 104 EATERY', 'Secondary Phone Number': '941-000-0000' }),
    ];
    const match = matchDbprRow(rows, { street: '4400 Test Commons Pkwy E', unit: '104', zip: '00000' });
    expect(match['Business Name']).toBe('SUITE 104 EATERY');
  });

  test('disambiguates by phone digits when no unit is supplied', () => {
    const rows = [
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #102', 'Business Name': 'SUITE 102 EATERY', 'Secondary Phone Number': '(941) 555-0199' }),
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #104', 'Business Name': 'SUITE 104 EATERY', 'Secondary Phone Number': '941-000-0000' }),
    ];
    const match = matchDbprRow(rows, { street: '4400 Test Commons Pkwy E', zip: '00000', phone: '9415550199' });
    expect(match['Business Name']).toBe('SUITE 102 EATERY');
  });

  test('disambiguates by business-name hint', () => {
    const rows = [
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #102', 'Business Name': 'SUITE 102 EATERY', 'Secondary Phone Number': '941-111-1111' }),
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #104', 'Business Name': 'SUITE 104 EATERY', 'Secondary Phone Number': '941-222-2222' }),
    ];
    const match = matchDbprRow(rows, { street: '4400 Test Commons Pkwy E', zip: '00000', businessNameHint: 'Suite 104 Eatery' });
    expect(match['Business Name']).toBe('SUITE 104 EATERY');
  });

  test('skips (returns null) when several candidates match with no disambiguator', () => {
    const rows = [
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #102', 'Secondary Phone Number': '941-111-1111' }),
      baseRow({ 'Location Street Address': '4400 Test Commons Pkwy E #104', 'Secondary Phone Number': '941-222-2222' }),
    ];
    // No unit, no phone, no name hint on the target — neither row can be
    // singled out, and a wrong match is worse than no match.
    const match = matchDbprRow(rows, { street: '4400 Test Commons Pkwy E', zip: '00000' });
    expect(match).toBeNull();
  });

  test('does not match a different zip or a different house number', () => {
    const rows = [baseRow()];
    expect(matchDbprRow(rows, { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00001' })).toBeNull();
    expect(matchDbprRow(rows, { street: '8800 Test Commons Pkwy E', unit: '102', zip: '00000' })).toBeNull();
  });
});

describe('resolveViaDbprLicense', () => {
  beforeEach(() => _resetCacheForTests());

  test('resolves seats -> sqft with evidence on a matched suite', async () => {
    const text = csv([{
      'Location Street Address': '4400 Test Commons Pkwy E #102',
      'Location Zip Code': '00000',
      'Business Name': 'TEST TACO SHOP',
      'Number of Seats or Rental Units': '25',
      'License Number': 'SEA9999999',
    }]);
    const fetchText = jest.fn().mockResolvedValue(text);
    const result = await resolveViaDbprLicense({
      address: { street: '4400 Test Commons Parkway East', unit: '102', zip: '00000' },
    }, { fetchText });
    expect(result).toEqual(expect.objectContaining({
      value: 1400,
      businessName: 'TEST TACO SHOP',
      seats: 25,
    }));
    expect(result.evidence[0].detail).toMatch(/25 seats/);
  });

  test('a fetch failure resolves null, never throws', async () => {
    const fetchText = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(resolveViaDbprLicense({
      address: { street: '4400 Test Commons Parkway East', unit: '102', zip: '00000' },
    }, { fetchText })).resolves.toBeNull();
  });

  test('no address match resolves null', async () => {
    const text = csv([{ 'Location Street Address': '1 Other St', 'Location Zip Code': '00000' }]);
    const fetchText = jest.fn().mockResolvedValue(text);
    const result = await resolveViaDbprLicense({
      address: { street: '4400 Test Commons Parkway East', unit: '102', zip: '00000' },
    }, { fetchText });
    expect(result).toBeNull();
  });
});

describe('DBPR fetch failure backoff', () => {
  const { loadDistrictRows, _resetCacheForTests } = require('../services/commercial-suite-size/dbpr-food-license');
  beforeEach(() => _resetCacheForTests());

  test('a failed download is not retried on every lookup inside the backoff window', async () => {
    let t = 1_000_000;
    const fetchText = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(loadDistrictRows(7, { fetchText, now: () => t })).resolves.toEqual([]);
    t += 60 * 1000;
    await expect(loadDistrictRows(7, { fetchText, now: () => t })).resolves.toEqual([]);
    expect(fetchText).toHaveBeenCalledTimes(1);
    t += 11 * 60 * 1000;
    await loadDistrictRows(7, { fetchText, now: () => t });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});

describe('requireWarmCache — the cache-hit fast path never awaits a download', () => {
  const { peekDistrictRows, loadDistrictRows, warmDistrictRowsInBackground } = require('../services/commercial-suite-size/dbpr-food-license');
  beforeEach(() => _resetCacheForTests());

  test('peekDistrictRows returns null on a cold cache without ever calling fetchText', () => {
    const fetchText = jest.fn();
    expect(peekDistrictRows(7)).toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
  });

  test('peekDistrictRows returns the rows once loadDistrictRows has warmed the cache', async () => {
    const text = csv([{ 'Location Street Address': '4400 Test Commons Pkwy E #102', 'Location Zip Code': '00000' }]);
    const fetchText = jest.fn().mockResolvedValue(text);
    await loadDistrictRows(7, { fetchText });
    const warm = peekDistrictRows(7);
    expect(Array.isArray(warm)).toBe(true);
    expect(warm).toHaveLength(1);
  });

  test('requireWarmCache: a cold cache resolves null immediately and kicks a background warm-up, never awaiting the fetch', async () => {
    let releaseFetch;
    const pending = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchText = jest.fn().mockReturnValue(pending);
    const result = await resolveViaDbprLicense({
      address: { street: '4400 Test Commons Parkway East', unit: '102', zip: '00000' },
    }, { requireWarmCache: true, fetchText });
    expect(result).toBeNull();
    // The background warm-up DID kick the real fetch (for next time) — this
    // proves the resolve above returned without waiting on it.
    expect(fetchText).toHaveBeenCalledTimes(1);
    releaseFetch(csv([]));
    await Promise.resolve().then(() => Promise.resolve()); // let the background promise settle before the next test resets the cache
  });

  test('requireWarmCache: a warm cache resolves the match with zero fetch calls', async () => {
    const text = csv([{
      'Location Street Address': '4400 Test Commons Pkwy E #102',
      'Location Zip Code': '00000',
      'Business Name': 'TEST TACO SHOP',
      'Number of Seats or Rental Units': '25',
    }]);
    const warmFetch = jest.fn().mockResolvedValue(text);
    await loadDistrictRows(7, { fetchText: warmFetch }); // warm the cache first, same as a prior fresh lookup would

    const fetchText = jest.fn(); // must never be called on the warm path
    const result = await resolveViaDbprLicense({
      address: { street: '4400 Test Commons Parkway East', unit: '102', zip: '00000' },
    }, { requireWarmCache: true, fetchText });
    expect(result).toEqual(expect.objectContaining({ value: 1400, businessName: 'TEST TACO SHOP' }));
    expect(fetchText).not.toHaveBeenCalled();
  });

  test('warmDistrictRowsInBackground never throws even when the fetch rejects', () => {
    const fetchText = jest.fn().mockRejectedValue(new Error('network down'));
    expect(() => warmDistrictRowsInBackground(7, { fetchText })).not.toThrow();
  });
});

describe('isEligibleDineInLicense', () => {
  const { isEligibleDineInLicense } = require('../services/commercial-suite-size/dbpr-food-license');
  const base = {
    'License Type Code': '2010', 'Primary Status Code': '20', 'Rank Code': 'SEAT', 'Number of Seats or Rental Units': '25',
  };
  test('an active seated permanent food-service license is eligible', () => {
    expect(isEligibleDineInLicense(base)).toBe(true);
  });
  test('a takeout-only (NOST) license with zero seats is eligible', () => {
    expect(isEligibleDineInLicense({ ...base, 'Rank Code': 'NOST', 'Number of Seats or Rental Units': '0' })).toBe(true);
  });
  test.each([
    ['mobile food unit', { 'License Type Code': '2014', 'Rank Code': 'MFDV', 'Number of Seats or Rental Units': '0' }],
    ['caterer', { 'License Type Code': '2013', 'Rank Code': 'CATR', 'Number of Seats or Rental Units': '0' }],
    ['vending', { 'License Type Code': '2015', 'Rank Code': 'VEND' }],
    ['inactive prior-tenant license', { 'Primary Status Code': '45' }],
    ['blank seat count', { 'Number of Seats or Rental Units': '' }],
    ['non-numeric seat count', { 'Number of Seats or Rental Units': 'N/A' }],
    ['seated rank with zero seats', { 'Number of Seats or Rental Units': '0' }],
  ])('%s is not eligible', (_label, override) => {
    expect(isEligibleDineInLicense({ ...base, ...override })).toBe(false);
  });
});

describe('matchDbprRow never returns another suite', () => {
  const { matchDbprRow } = require('../services/commercial-suite-size/dbpr-food-license');
  const row104 = {
    'Location Street Address': '4400 TEST COMMONS PKWY E #104',
    'Location Zip Code': '00000',
    'Business Name': 'TEST TACO SHOP',
    'Secondary Phone Number': '555-010-0199',
  };
  test('a phone match on a different suite is rejected', () => {
    expect(matchDbprRow([row104], {
      street: '4400 Test Commons Pkwy E', unit: '#102', zip: '00000', phone: '+15550100199',
    })).toBeNull();
  });
  test('a name match on a different suite is rejected', () => {
    expect(matchDbprRow([row104], {
      street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000', businessNameHint: 'Test Taco Shop',
    })).toBeNull();
  });
  test('a phone match still picks a row that carries no unit', () => {
    const noUnit = { ...row104, 'Location Street Address': '4400 TEST COMMONS PKWY E' };
    expect(matchDbprRow([noUnit], {
      street: '4400 Test Commons Pkwy E', unit: '#102', zip: '00000', phone: '+15550100199',
    })).toBe(noUnit);
  });
});
