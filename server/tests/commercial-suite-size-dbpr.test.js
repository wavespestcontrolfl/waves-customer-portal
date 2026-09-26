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

describe('designator-bearing target units match the bare extract unit', () => {
  const { matchDbprRow } = require('../services/commercial-suite-size/dbpr-food-license');
  const row102 = {
    'Location Street Address': '4400 TEST COMMONS PKWY E #102',
    'Location Zip Code': '00000',
    'Business Name': 'TEST TACO SHOP',
  };
  test.each(['Suite 102', 'Unit 102', 'Ste. 102', '#102', '102'])('%s matches the #102 license', (unit) => {
    expect(matchDbprRow([row102], { street: '4400 Test Commons Pkwy E', unit, zip: '00000' })).toBe(row102);
  });
});

describe('compound designators ("Bldg 9 Unit 204") normalize to the same key on both sides (primary review PR #4840 r5 P2)', () => {
  const { matchDbprRow, normalizeUnitValue } = require('../services/commercial-suite-size/dbpr-food-license');

  test('normalizeUnitValue reduces "Bldg 9 Unit 204" and "BLDG 9 UNIT 204" to the same key', () => {
    expect(normalizeUnitValue('Bldg 9 Unit 204')).toBe(normalizeUnitValue('BLDG 9 UNIT 204'));
    expect(normalizeUnitValue('Bldg 9 Unit 204')).toBe('9-204');
  });

  test('the compound designator sits in the street line — the "Bldg 9" prefix must not leak into the street name', () => {
    const row = {
      'Location Street Address': '4400 TEST COMMONS PKWY E BLDG 9 UNIT 204',
      'Location Zip Code': '00000',
      'Business Name': 'TEST TACO SHOP',
    };
    expect(matchDbprRow([row], { street: '4400 Test Commons Pkwy E', unit: 'Bldg 9 Unit 204', zip: '00000' })).toBe(row);
  });

  test('a DIFFERENT building/unit in the same compound form is still rejected', () => {
    const row = {
      'Location Street Address': '4400 TEST COMMONS PKWY E BLDG 9 UNIT 204',
      'Location Zip Code': '00000',
    };
    expect(matchDbprRow([row], { street: '4400 Test Commons Pkwy E', unit: 'Bldg 10 Unit 204', zip: '00000' })).toBeNull();
  });
});

describe('DBPR row unit in Location Address Line 2, and both phone columns', () => {
  const { matchDbprRow } = require('../services/commercial-suite-size/dbpr-food-license');
  const base = { 'Location Street Address': '4400 TEST COMMONS PKWY E', 'Location Zip Code': '00000' };
  test.each(['STE 102', 'SUITE 102', '#102', '102', 'UNIT 102'])('line 2 "%s" matches Suite 102', (line2) => {
    const row = { ...base, 'Location Address Line 2': line2 };
    expect(matchDbprRow([row], { street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000' })).toBe(row);
  });
  test('line 2 naming another suite is still rejected', () => {
    const row = { ...base, 'Location Address Line 2': 'STE 104' };
    expect(matchDbprRow([row], { street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000' })).toBeNull();
  });
  test('the caller matches the PRIMARY phone even when a secondary phone is also listed', () => {
    const row = { ...base, 'Primary Phone Number': '(555) 010-0111', 'Secondary Phone Number': '555-010-0999' };
    expect(matchDbprRow([row], { street: '4400 Test Commons Pkwy E', zip: '00000', phone: '+15550100111' })).toBe(row);
  });
});

describe('compound unit keys keep component boundaries', () => {
  const { normalizeUnitValue } = require('../services/commercial-suite-size/dbpr-food-license');
  test('Bldg 9 Unit 204 and Bldg 92 Unit 04 never collide', () => {
    expect(normalizeUnitValue('Bldg 9 Unit 204')).toBe('9-204');
    expect(normalizeUnitValue('BLDG 9 UNIT 204')).toBe('9-204');
    expect(normalizeUnitValue('Bldg 92 Unit 04')).toBe('92-04');
  });
  test('single designators reduce to the bare value; words containing a designator are not mangled', () => {
    expect(normalizeUnitValue('#102')).toBe('102');
    expect(normalizeUnitValue('Suite 102')).toBe('102');
    expect(normalizeUnitValue('Ste. 102')).toBe('102');
    expect(normalizeUnitValue('Suite WEST-2')).toBe('WEST-2');
  });
});

describe('Codex r6 DBPR matching', () => {
  const dbpr = require('../services/commercial-suite-size/dbpr-food-license');
  const base = { 'Location Street Address': '4400 TEST COMMONS PKWY E', 'Location Zip Code': '00000' };
  test('an alphabetic suite in Location Address Line 2 ("A", "A-1") matches Suite A / Suite A-1', () => {
    const a = { ...base, 'Location Address Line 2': 'A' };
    const a1 = { ...base, 'Location Address Line 2': 'A-1' };
    expect(dbpr.matchDbprRow([a], { street: '4400 Test Commons Pkwy E', unit: 'Suite A', zip: '00000' })).toBe(a);
    expect(dbpr.matchDbprRow([a1], { street: '4400 Test Commons Pkwy E', unit: 'Suite A-1', zip: '00000' })).toBe(a1);
  });
  test('a "SPACE 12" license row matches a Space 12 address', () => {
    const row = { ...base, 'Location Street Address': '4400 TEST COMMONS PKWY E SPACE 12' };
    expect(dbpr.matchDbprRow([row], { street: '4400 Test Commons Pkwy E', unit: 'Space 12', zip: '00000' })).toBe(row);
  });
  test('two licenses on the same suite: the caller phone picks one; no hint stays ambiguous', () => {
    const r1 = { ...base, 'Location Address Line 2': 'STE 102', 'Primary Phone Number': '555-010-0111' };
    const r2 = { ...base, 'Location Address Line 2': 'STE 102', 'Primary Phone Number': '555-010-0222' };
    expect(dbpr.matchDbprRow([r1, r2], { street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000', phone: '+15550100222' })).toBe(r2);
    expect(dbpr.matchDbprRow([r1, r2], { street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000' })).toBeNull();
  });
});

describe('Codex r7: Spc and Space compare equal', () => {
  const { normalizeUnitValue } = require('../services/commercial-suite-size/dbpr-food-license');
  test('"Spc 12", "Spc. 12" and "Space 12" all reduce to "12"', () => {
    expect(normalizeUnitValue('Spc 12')).toBe('12');
    expect(normalizeUnitValue('Spc. 12')).toBe('12');
    expect(normalizeUnitValue('Space 12')).toBe('12');
  });
});

describe('Codex #4872 r2: exact-unit licenses win over hint-only rows', () => {
  const { matchDbprRow } = require('../services/commercial-suite-size/dbpr-food-license');
  const base = { 'Location Street Address': '4400 TEST COMMONS PKWY E', 'Location Zip Code': '00000' };
  test('an exact-suite license is chosen over a unitless row that matches the caller phone', () => {
    const exact = { ...base, 'Location Address Line 2': 'STE 102', 'Business Name': 'SUITE TENANT' };
    const unitless = { ...base, 'Business Name': 'OTHER TENANT', 'Primary Phone Number': '555-010-0111' };
    expect(matchDbprRow([exact, unitless], {
      street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000', phone: '+15550100111',
    })).toBe(exact);
  });
  test('with no exact-suite license, a unitless row still matches on the caller phone', () => {
    const unitless = { ...base, 'Business Name': 'ONLY TENANT', 'Primary Phone Number': '555-010-0111' };
    expect(matchDbprRow([unitless], {
      street: '4400 Test Commons Pkwy E', unit: 'Suite 102', zip: '00000', phone: '+15550100111',
    })).toBe(unitless);
  });
});

describe('Codex #4872 r2: stale-if-error is bounded', () => {
  const dbpr = require('../services/commercial-suite-size/dbpr-food-license');
  beforeEach(() => dbpr._resetCacheForTests());
  const HOUR = 60 * 60 * 1000;
  test('a failed refresh serves the last extract within the window, and nothing after it', async () => {
    let t = 0;
    const good = jest.fn().mockResolvedValue('"Business Name","Location Zip Code"\r\n"TEST TACO SHOP","00000"\r\n');
    const rows = await dbpr.loadDistrictRows(7, { fetchText: good, now: () => t });
    expect(rows).toHaveLength(1);
    const failing = jest.fn().mockRejectedValue(new Error('HTTP 503'));
    t = 30 * HOUR; // past the 24h TTL, inside the 48h stale-if-error window
    await expect(dbpr.loadDistrictRows(7, { fetchText: failing, now: () => t })).resolves.toHaveLength(1);
    t = 80 * HOUR; // past TTL + window: a closed restaurant must not keep pricing as current
    await expect(dbpr.loadDistrictRows(7, { fetchText: failing, now: () => t })).resolves.toEqual([]);
  });
});

describe('Codex #4872 r3: a malformed HTTP-200 extract is a failed refresh', () => {
  const dbpr = require('../services/commercial-suite-size/dbpr-food-license');
  beforeEach(() => dbpr._resetCacheForTests());
  const HOUR = 60 * 60 * 1000;
  test.each([
    ['truncated quoting', '"Business Name","Location Zip Code"\r\n"TEST TACO SH'],
    ['empty body', ''],
    ['header only', '"Business Name","Location Zip Code"\r\n'],
  ])('%s: never cached, and the last good extract keeps serving within the window', async (_label, badBody) => {
    let t = 0;
    const good = jest.fn().mockResolvedValue('"Business Name","Location Zip Code"\r\n"TEST TACO SHOP","00000"\r\n');
    await expect(dbpr.loadDistrictRows(7, { fetchText: good, now: () => t })).resolves.toHaveLength(1);
    t = 30 * HOUR; // past the 24h TTL
    const bad = jest.fn().mockResolvedValue(badBody);
    await expect(dbpr.loadDistrictRows(7, { fetchText: bad, now: () => t })).resolves.toHaveLength(1);
    // Not cached: after the failure backoff the next call refetches.
    t += 11 * 60 * 1000;
    const good2 = jest.fn().mockResolvedValue('"Business Name","Location Zip Code"\r\n"TEST TACO SHOP","00000"\r\n"SECOND SHOP","00000"\r\n');
    await expect(dbpr.loadDistrictRows(7, { fetchText: good2, now: () => t })).resolves.toHaveLength(2);
    expect(good2).toHaveBeenCalledTimes(1);
  });
});
