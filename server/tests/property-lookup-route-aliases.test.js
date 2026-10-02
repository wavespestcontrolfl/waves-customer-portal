/**
 * Numbered-route aliases for the county roll search.
 *
 * Live miss (10-02): a plaza storefront typed "<number> FL-70" was
 * normalized to "<number> FL 70", so the roll search and the house-number audit
 * hunted for a street called "FL 70" and reported "street not found" — the
 * Manatee roll spells the road "SR 70 E". All house numbers below are synthetic.
 * "FL-70" also read as a floor designator in the aggregate guard.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { auditAddressHouseNumber, _private } = require('../services/property-lookup/ai-property-lookup');
const { routeSpellingVariants } = require('../services/property-lookup/route-spellings');

const { addressHasSubpremise, FL_FLOOR_RE, normalizeCountyStreetLine, manateeAddressSearchCandidates, countyAddressSearchCandidates } = _private;
const { queryStreetSitusAddresses } = require('../services/property-lookup/county-parcel-gis');

describe('normalizeCountyStreetLine route aliases', () => {
  test.each([
    ['9117 FL-70, Bradenton, FL 34202', '9117 SR 70'],
    ['9117 FL 70', '9117 SR 70'],
    ['9117 Fl-70 Bradenton FL 34202', '9117 SR 70'],
    ['9117 Florida 70', '9117 SR 70'],
    ['9117 State Road 70', '9117 SR 70'],
    ['9117 State Rd 70', '9117 SR 70'],
    ['9117 State Hwy 70', '9117 SR 70'],
    ['9117 State Highway 70', '9117 SR 70'],
    ['9117 State Route 70', '9117 SR 70'],
    ['9117 Hwy 70', '9117 SR 70'],
    ['9117 Highway 70', '9117 SR 70'],
    ['9117 SR-70', '9117 SR 70'],
    ['9117 SR70', '9117 SR 70'],
    ['9117 SR 70', '9117 SR 70'],
    ['9117 FL-70 East', '9117 SR 70 E'],
    ['9117 E FL 70', '9117 SR 70 E'],
    ['9117 FL-70 Ste 12', '9117 SR 70 STE 12'],
  ])('state road %s → %s', (typed, expected) => {
    expect(normalizeCountyStreetLine(typed)).toBe(expected);
  });

  test.each([
    ['2100 US-41, Bradenton, FL 34207', '2100 US 41'],
    ['2100 US 41 N', '2100 US 41 N'],
    ['2100 US Hwy 41', '2100 US 41'],
    ['2100 U.S. 41', '2100 US 41'],
    ['2100 U.S. Highway 301 North', '2100 US 301 N'],
    ['2100 Highway 41', '2100 US 41'],
    ['2100 Hwy 301', '2100 US 301'],
    ['2100 US41', '2100 US 41'],
  ])('US route %s → %s', (typed, expected) => {
    expect(normalizeCountyStreetLine(typed)).toBe(expected);
  });

  test.each([
    ['5200 CR 675', '5200 CR 675'],
    ['5200 CR-675', '5200 CR 675'],
    ['5200 County Road 675', '5200 CR 675'],
    ['5200 County Rd 675, Parrish, FL 34219', '5200 CR 675'],
  ])('county road %s → %s', (typed, expected) => {
    expect(normalizeCountyStreetLine(typed)).toBe(expected);
  });

  test('roll spellings land on the same key as the typed spelling', () => {
    expect(normalizeCountyStreetLine('9155 SR 70 E')).toBe('9155 SR 70 E');
    // Sarasota writes state roads out; Hillsborough writes US routes with HWY.
    expect(normalizeCountyStreetLine('7000 STATE ROAD 72')).toBe('7000 SR 72');
    expect(normalizeCountyStreetLine('5100 N US HWY 301')).toBe('5100 US 301 N');
    // Either direction position is one key (typed vs roll).
    expect(normalizeCountyStreetLine('123 US 41 N')).toBe(normalizeCountyStreetLine('123 N US HWY 41'));
    // Both positions filled stays as written.
    expect(normalizeCountyStreetLine('123 E SR 70 W')).toBe('123 E SR 70 W');
  });

  test.each([
    ['4867 Tobermory Way, Venice, FL 34285', '4867 TOBERMORY WAY'],
    ['4867 Tobermory Way', '4867 TOBERMORY WAY'],
    ['123 17th St E, Bradenton, FL 34208', '123 17TH ST E'],
    ['123 17th Street East', '123 17TH ST E'],
    ['100 Main St Venice FL 34285', '100 MAIN ST'],
    ['100 Main St Fl 3', '100 MAIN ST FL 3'],
    ['100 Main St Apt 4, Bradenton, FL 34202', '100 MAIN ST APT 4'],
    ['9000 Kings Hwy', '9000 KINGS HWY'],
    ['9000 Kings Highway', '9000 KINGS HWY'],
    ['250 Highway Ct', '250 HIGHWAY CT'],
    ['12 County Line Rd', '12 COUNTY LINE RD'],
    ['77 Florida Ave', '77 FLORIDA AVE'],
    ['45 Crane Rd', '45 CRANE RD'],
    ['45 US Open Loop', '45 US OPEN LOOP'],
  ])('ordinary street %s is unchanged → %s', (typed, expected) => {
    expect(normalizeCountyStreetLine(typed)).toBe(expected);
  });

  test('the typed address string is never rewritten', () => {
    const typed = '9117 FL-70, Bradenton, FL 34202';
    normalizeCountyStreetLine(typed);
    expect(typed).toBe('9117 FL-70, Bradenton, FL 34202');
  });
});

describe('routeSpellingVariants', () => {
  test('state road variants cover Sarasota "STATE ROAD n"', () => {
    expect(routeSpellingVariants('SR 72')).toEqual(['SR 72', 'STATE ROAD 72', 'STATE RD 72']);
    expect(routeSpellingVariants('9155 SR 70')).toEqual(['9155 SR 70', '9155 STATE ROAD 70', '9155 STATE RD 70']);
  });
  test('US and county road variants', () => {
    expect(routeSpellingVariants('US 41')).toEqual(['US 41', 'US HWY 41', 'US HIGHWAY 41']);
    expect(routeSpellingVariants('CR 675')).toEqual(['CR 675', 'COUNTY ROAD 675', 'COUNTY RD 675']);
  });
  test('ordinary street text passes through untouched', () => {
    expect(routeSpellingVariants('TOBERMORY')).toEqual(['TOBERMORY']);
    expect(routeSpellingVariants('17TH ST')).toEqual(['17TH ST']);
  });
});

describe('manateeAddressSearchCandidates for a route', () => {
  test('adds the bare route (no post-direction) and other counties spellings', () => {
    const c = manateeAddressSearchCandidates('9155 FL-70 E, Bradenton, FL 34202');
    expect(c).toEqual(expect.arrayContaining(['9155 SR 70 E', '9155 SR 70', '9155 STATE ROAD 70']));
  });
  test('a typed pre-direction is kept on the spellings ("5100 N US HWY 301")', () => {
    const c = manateeAddressSearchCandidates('5100 N US Hwy 301, Tampa, FL 33610');
    expect(c).toEqual(expect.arrayContaining(['5100 US 301 N', '5100 N US HWY 301', '5100 US 301']));
    expect(c.indexOf('5100 N US HWY 301')).toBeLessThan(c.indexOf('5100 US 301'));
  });
  test('expanded spelling with a trailing direction is a candidate ("5100 US HWY 301 N", + unit tail)', () => {
    const c = countyAddressSearchCandidates('5100 US 301 N Ste 4, Tampa, FL 33610');
    expect(c).toEqual(expect.arrayContaining(['5100 US HWY 301 N STE 4', '5100 US HWY 301 N', '5100 N US HWY 301 STE 4']));
  });
  test('a unit tail keeps the other spellings ("7000 FL-72 Ste 12")', () => {
    const c = countyAddressSearchCandidates('7000 FL-72 Ste 12, Sarasota, FL 34241');
    expect(c).toEqual(expect.arrayContaining(['7000 STATE ROAD 72 STE 12', '7000 STATE ROAD 72']));
  });
  test('an ordinary street gets no extra route candidates', () => {
    expect(manateeAddressSearchCandidates('4867 Tobermory Way, Bradenton, FL 34211'))
      .toEqual(['4867 TOBERMORY WAY', '4867 TOBERMORY']);
  });
});

describe('FL_FLOOR_RE / addressHasSubpremise', () => {
  test.each([
    '9117 FL-70, Bradenton, FL 34202',
    '9117 FL 70',
    '9117 FL 70 E',
    '9117 E FL 70, Bradenton, FL 34202',
    '4867 Tobermory Way, Venice, FL 34285',
    'Venice FL 34285',
    '123 17th St E, Bradenton, FL 34208',
    '4867 Tobermory Way',
  ])('route / state token is NOT a floor: %s', (addr) => {
    expect(addressHasSubpremise(addr)).toBe(false);
  });

  test.each([
    '123 Main St Fl 3, Bradenton, FL 34202',
    '123 Main St FL #2, Bradenton, FL 34202',
    '123 Main St, Fl 3, Bradenton, FL 34202',
    '123 Main St FL 3',
    '123 N Main St Fl. 4',
  ])('real floor designator still flags: %s', (addr) => {
    expect(addressHasSubpremise(addr)).toBe(true);
  });

  test('regex is exported for direct use', () => {
    expect(FL_FLOOR_RE.test('1 Oak St Fl 2')).toBe(true);
    expect(FL_FLOOR_RE.test('1 FL-70')).toBe(false);
  });
});

describe('auditAddressHouseNumber on a numbered route', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function mockRoll(situsList, capture) {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (capture) capture.push(decodeURIComponent(String(url).replace(/\+/g, ' ')));
      return {
        ok: true,
        json: async () => ({
          features: situsList.map((s) => ({ attributes: { SITUS_ADDRESS: s, SITUS_POSTAL_ZIP: '34202' } })),
        }),
      };
    });
  }

  // Live rows 10-02 (Manatee layer): road is "SR 70 E".
  const ROLL = ['9010 SR 70 E', '9155 SR 70 E', '9200 SR 70 E', '6000 SAMPLE RD'];

  test('typed "FL-70" matches the roll\'s "SR 70 E" row exactly', async () => {
    const urls = [];
    mockRoll(ROLL, urls);
    const audit = await auditAddressHouseNumber('9155 FL-70, Bradenton, FL 34202');
    expect(audit).toMatchObject({ county: 'Manatee', houseNumber: 9155, streetLabel: 'SR 70', streetExists: true, hasExactMatch: true });
    // Every spelling is queried (one request each, never "FL 70", and no OR
    // clause — Manatee's WAF rejects any OR, live 10-02).
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("LIKE '%SR 70%'");
    expect(urls.some((u) => u.includes("LIKE '%STATE ROAD 70%'"))).toBe(true);
    expect(urls.every((u) => !u.includes('FL 70') && !u.includes(' OR '))).toBe(true);
  });

  test('a house number that is not on the road → street exists, nearest numbers', async () => {
    mockRoll(ROLL);
    const audit = await auditAddressHouseNumber('9117 FL-70, Bradenton, FL 34202');
    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: false });
    expect(audit.nearestNumbers).toEqual(expect.arrayContaining([9010, 9155]));
    expect(audit.nearestNumbers).not.toContain(6015);
  });

  test('typed "State Road 70 East" and "SR-70 E" read the same roll row', async () => {
    for (const typed of ['9155 State Road 70 East, Bradenton, FL 34202', '9155 SR-70 E, Bradenton, FL 34202']) {
      mockRoll(ROLL);
      const audit = await auditAddressHouseNumber(typed);
      expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
    }
  });

  test('typed direction pins: "SR 70 W" does not collect "SR 70 E" rows', async () => {
    mockRoll(ROLL);
    const audit = await auditAddressHouseNumber('9155 SR 70 W, Bradenton, FL 34202');
    expect(audit.hasExactMatch).toBe(false);
  });

  test('a typed direction pins both positions: "US 41 N" never matches "S US 41" (and the reverse)', async () => {
    mockRoll(['123 S US 41']);
    expect((await auditAddressHouseNumber('123 US 41 N, Bradenton, FL 34202')).hasExactMatch).toBe(false);
    mockRoll(['123 US 41 S']);
    expect((await auditAddressHouseNumber('123 N US 41, Bradenton, FL 34202')).hasExactMatch).toBe(false);
    mockRoll(['123 N US 41']);
    expect((await auditAddressHouseNumber('123 US 41 N, Bradenton, FL 34202')).hasExactMatch).toBe(true);
  });

  test('truncated page: the targeted query reaches a pre-direction row ("123 N US 41")', async () => {
    const wheres = [];
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      wheres.push(where);
      const row = (s) => ({ attributes: { SITUS_ADDRESS: s, SITUS_POSTAL_ZIP: '34202' } });
      // The street-wide page is capped and lacks 123; only the targeted
      // query with the pre-direction finds it.
      if (where.includes("'%US 41%'")) return { ok: true, json: async () => ({ exceededTransferLimit: true, features: [row('900 N US 41')] }) };
      if (where.includes("'%123 %US 41%'")) return { ok: true, json: async () => ({ features: [row('123 N US 41')] }) };
      return { ok: true, json: async () => ({ features: [] }) };
    });
    const audit = await auditAddressHouseNumber('123 US 41 N, Bradenton, FL 34202');
    expect(audit).toMatchObject({ hasExactMatch: true });
    expect(wheres.some((w) => w.includes("'%123 %US 41%'"))).toBe(true);
  });

  test('truncated page: a pre-direction targeted query also tries the spelled-out route ("123 N US HWY 41")', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      const row = (s) => ({ attributes: { SITUS_ADDRESS: s, SITUS_POSTAL_ZIP: '34202' } });
      if (where.includes("'%US 41%'")) return { ok: true, json: async () => ({ exceededTransferLimit: true, features: [row('900 N US 41')] }) };
      if (where.includes("'%123 %US HWY 41%'")) return { ok: true, json: async () => ({ features: [row('123 N US HWY 41')] }) };
      return { ok: true, json: async () => ({ features: [] }) };
    });
    const audit = await auditAddressHouseNumber('123 US 41 N, Bradenton, FL 34202');
    expect(audit).toMatchObject({ hasExactMatch: true });
  });

  test('truncated page: a diagonal pre-direction row ("123 NE US 41") is reached', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      const row = (s) => ({ attributes: { SITUS_ADDRESS: s, SITUS_POSTAL_ZIP: '34202' } });
      if (where.includes("'%US 41%'")) return { ok: true, json: async () => ({ exceededTransferLimit: true, features: [row('900 NE US 41')] }) };
      if (where.includes("'%123 %US 41%'")) return { ok: true, json: async () => ({ features: [row('123 NE US 41')] }) };
      return { ok: true, json: async () => ({ features: [] }) };
    });
    const audit = await auditAddressHouseNumber('123 US 41, Bradenton, FL 34202');
    expect(audit).toMatchObject({ hasExactMatch: true });
  });

  test('a roll row spelled "SR 70" with no direction still matches a typed "SR 70 E"', async () => {
    mockRoll(['9155 SR 70']);
    const audit = await auditAddressHouseNumber('9155 SR 70 E, Bradenton, FL 34202');
    expect(audit).toMatchObject({ hasExactMatch: true });
  });

  test('a sibling road is not collected: "SR 700" / "SR 70A" are not "SR 70"', async () => {
    mockRoll(['9155 SR 700', '9155 SR 70A']);
    const audit = await auditAddressHouseNumber('9155 FL-70, Bradenton, FL 34202');
    expect(audit.streetExists).toBe(false);
  });

  test('Sarasota-style "STATE ROAD 72" rows are found from a typed "SR 72"', async () => {
    const wheres = [];
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      wheres.push(where);
      // Sarasota has no "SR 72" rows — only the spelled-out form.
      const features = where.includes('STATE ROAD 72')
        ? [{ attributes: { fulladdress: '7000 STATE ROAD 72 SARASOTA FL, 34241', loczip: '34241' } }]
        : [];
      return { ok: true, json: async () => ({ features }) };
    });
    const audit = await auditAddressHouseNumber('7000 SR-72, Sarasota, FL 34241');
    expect(audit).toMatchObject({ county: 'Sarasota', hasExactMatch: true });
    expect(wheres[0]).toContain("LIKE '%SR 72%'");
    expect(wheres.some((w) => w.includes("LIKE '%STATE ROAD 72%'"))).toBe(true);
    expect(wheres.every((w) => !w.includes(' OR '))).toBe(true);
  });

  test('a number listed only under another spelling is still found (variants are merged)', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      const features = where.includes('STATE ROAD 72')
        ? [{ attributes: { fulladdress: '7000 STATE ROAD 72 SARASOTA FL, 34241', loczip: '34241' } }]
        : [{ attributes: { fulladdress: '7100 SR 72 SARASOTA FL, 34241', loczip: '34241' } }];
      return { ok: true, json: async () => ({ features }) };
    });
    const audit = await auditAddressHouseNumber('7000 SR-72, Sarasota, FL 34241');
    expect(audit).toMatchObject({ county: 'Sarasota', hasExactMatch: true });
  });

  test('mixed route formats on one road: strict and relaxed matches are merged', async () => {
    // "7100 SR 70" matches the typed "SR 70" strictly; "7000 SR 70 E" only
    // relaxed. The relaxed row must not be hidden by the strict hit.
    mockRoll(['7100 SR 70', '7000 SR 70 E']);
    const audit = await auditAddressHouseNumber('7000 FL-70, Bradenton, FL 34202');
    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });

  test('route spellings share one timeout budget (no fresh timer per spelling)', async () => {
    const budgets = [];
    const realSetTimeout = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      budgets.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    });
    mockRoll([]);
    await queryStreetSitusAddresses('Manatee', 'SR 70', { timeoutMs: 3000 });
    spy.mockRestore();
    const perRequest = budgets.filter((ms) => ms > 0 && ms <= 3000);
    expect(perRequest.length).toBeGreaterThanOrEqual(3);
    // Each later request gets only what is left of the one 3 s budget.
    expect(perRequest.reduce((a, b) => Math.max(a, b), 0)).toBeLessThanOrEqual(3000);
    expect(perRequest[1]).toBeLessThanOrEqual(perRequest[0]);
  });

  test('a failed variant request is "no signal", not a street-missing verdict', async () => {
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ features: [] }) };
      throw new Error('gis down');
    });
    const audit = await auditAddressHouseNumber('7000 SR-72, Sarasota, FL 34241');
    expect(audit).toBeNull();
  });

  test('ordinary street audits are unchanged', async () => {
    mockRoll(['4857 TOBERMORY WAY', '4903 TOBERMORY WAY']);
    const audit = await auditAddressHouseNumber('4867 Tobermory Way, Bradenton, FL 34202');
    expect(audit).toMatchObject({ streetLabel: 'TOBERMORY WAY', streetExists: true, hasExactMatch: false });
    mockRoll(['123 17TH ST E']);
    const east = await auditAddressHouseNumber('123 17th St E, Bradenton, FL 34202');
    expect(east).toMatchObject({ hasExactMatch: true });
  });
});
