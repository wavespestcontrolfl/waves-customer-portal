/**
 * Street suffixes in the county street matcher are driven by the USPS
 * Publication 28 Appendix C1 table (usps-street-suffixes.js). Streets are
 * invented; the shapes mirror live roll spellings.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  auditAddressHouseNumber,
  _private,
} = require('../services/property-lookup/ai-property-lookup');
const { USPS_STREET_SUFFIXES } = require('../services/property-lookup/usps-street-suffixes');

const norm = (value) => _private.normalizeCountyStreetLine(value);

// The twelve historical long forms stay GLOBAL replacements (they also
// canonicalize inside a name); every other table word is terminal-only.
const GLOBAL_LONG_FORMS = new Set([
  'AVENUE', 'BOULEVARD', 'CIRCLE', 'COURT', 'DRIVE', 'LANE', 'PARKWAY', 'PLACE', 'ROAD', 'STREET', 'TERRACE', 'TRAIL',
]);
// Canonical key differs from the USPS standard where the rolls spell the word
// out (see STREET_SUFFIX_CANON_OVERRIDES), and TRAILER is left alone.
const KEY_OVERRIDES = { CRK: 'CREEK', HOLW: 'HOLLOW', IS: 'ISLAND', KY: 'KEY', MDWS: 'MDW', VIS: 'VISTA' };
const entries = Object.entries(USPS_STREET_SUFFIXES);

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockSitusResponse(situsList, field = 'SITUS_ADDRESS') {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: situsList.map((s) => ({ attributes: { [field]: s } })),
    }),
  });
}

describe('USPS Publication 28 Appendix C1 table', () => {
  test('carries the whole published table', () => {
    expect(entries.length).toBeGreaterThanOrEqual(540);
    expect(new Set(Object.values(USPS_STREET_SUFFIXES)).size).toBe(202);
    expect(USPS_STREET_SUFFIXES.WY).toBe('WAY');
    expect(USPS_STREET_SUFFIXES.PLACE).toBe('PL');
    expect(USPS_STREET_SUFFIXES.HIGHWY).toBe('HWY');
    expect(USPS_STREET_SUFFIXES.CRSSNG).toBe('XING');
  });

  test('every standard abbreviation maps to itself', () => {
    for (const standard of new Set(Object.values(USPS_STREET_SUFFIXES))) {
      expect(USPS_STREET_SUFFIXES[standard]).toBe(standard);
    }
  });
});

describe('normalizeCountyStreetLine: terminal USPS suffixes', () => {
  test('every table variant keys the same as its standard abbreviation at the end of a street', () => {
    for (const [variant, standard] of entries) {
      if (standard === 'TRLR') continue; // TRAILER is left alone (unit designator)
      const expected = norm(`100 EXAMPLE NAME ${KEY_OVERRIDES[standard] || standard}`);
      expect(norm(`100 EXAMPLE NAME ${variant}`)).toBe(expected);
    }
  });

  test('the key is the USPS standard except for the documented spelled-out families', () => {
    expect(norm('100 Example Lake')).toBe('100 EXAMPLE LK');
    expect(norm('100 Example Heights')).toBe('100 EXAMPLE HTS');
    expect(norm('100 Example Village')).toBe('100 EXAMPLE VLG');
    expect(norm('100 Example Springs')).toBe('100 EXAMPLE SPGS');
    expect(norm('100 Example Drv')).toBe('100 EXAMPLE DR');
    expect(norm('100 Example Str')).toBe('100 EXAMPLE ST');
    expect(norm('100 Example Av')).toBe('100 EXAMPLE AVE');
    expect(norm('100 Example Wy')).toBe('100 EXAMPLE WAY');
    expect(norm('100 Example Lp')).toBe('100 EXAMPLE LOOP');
    expect(norm('100 Example Pointe')).toBe('100 EXAMPLE PT');
    // Spelled out on the Charlotte / Hillsborough / Sarasota rolls.
    expect(norm('100 Example Crk')).toBe('100 EXAMPLE CREEK');
    expect(norm('100 Example Creek')).toBe('100 EXAMPLE CREEK');
    expect(norm('100 Example Is')).toBe('100 EXAMPLE ISLAND');
    expect(norm('100 Example Ky')).toBe('100 EXAMPLE KEY');
    expect(norm('100 Example Vis')).toBe('100 EXAMPLE VISTA');
    expect(norm('100 Example Holw')).toBe('100 EXAMPLE HOLLOW');
    // MDW is both the MEADOW standard and a MEADOWS variant in the USPS table.
    expect(norm('100 Example Meadow')).toBe('100 EXAMPLE MDW');
    expect(norm('100 Example Meadows')).toBe('100 EXAMPLE MDW');
    expect(norm('100 Example Mdws')).toBe('100 EXAMPLE MDW');
  });

  test('canonicalizes before a post-direction (including diagonals) and a unit tail', () => {
    expect(norm('100 Example Lake E')).toBe('100 EXAMPLE LK E');
    expect(norm('100 Example Lake NW')).toBe('100 EXAMPLE LK NW');
    expect(norm('100 Example Harbor Apt 4')).toBe('100 EXAMPLE HBR APT 4');
    expect(norm('100 Example Ridge W Unit B')).toBe('100 EXAMPLE RDG W UNIT B');
    expect(norm('100 Example Cove Nw')).toBe('100 EXAMPLE CV NW');
    expect(norm('100 Example Creek Wy, Parrish, FL 34219')).toBe('100 EXAMPLE CREEK WAY');
  });

  test('TRAILER is left exactly as typed (TRLR is a unit designator)', () => {
    expect(norm('100 Example Trailer')).toBe('100 EXAMPLE TRAILER');
    expect(norm('100 Example Trailers')).toBe('100 EXAMPLE TRAILERS');
  });
});

describe('normalizeCountyStreetLine: suffix words inside a name are never touched', () => {
  test.each([
    ['100 Glen Oaks Dr', '100 GLEN OAKS DR'],
    ['100 Park Lake Cir', '100 PARK LAKE CIR'],
    ['100 Creek View Way', '100 CREEK VIEW WAY'],
    ['100 Harbor Island Blvd', '100 HARBOR ISLAND BLVD'],
    ['100 Meadows Edge Ln', '100 MEADOWS EDGE LN'],
    ['100 Spring Hill Ct', '100 SPRING HILL CT'],
    ['100 Village Green Pl', '100 VILLAGE GREEN PL'],
    ['100 Ridge Crest Ter', '100 RIDGE CREST TER'],
    ['100 Cove Point Rd', '100 COVE POINT RD'],
  ])('%s keeps its inner words', (typed, expected) => {
    expect(norm(typed)).toBe(expected);
  });

  test('canonicalizes only the terminal word when the name also ends in a suffix word', () => {
    expect(norm('100 Glen Oaks Cove')).toBe('100 GLEN OAKS CV');
    expect(norm('100 Park Lake Heights')).toBe('100 PARK LAKE HTS');
    expect(norm('100 Creek View Springs')).toBe('100 CREEK VIEW SPGS');
    expect(norm('100 Harbor Island Point')).toBe('100 HARBOR ISLAND PT');
  });

  test('no non-historical table word is rewritten anywhere but the end', () => {
    for (const variant of Object.keys(USPS_STREET_SUFFIXES)) {
      if (GLOBAL_LONG_FORMS.has(variant)) continue;
      // A numbered-route token ("HWY 41" etc.) is a different rule; the
      // inner position here sits before a plain name word, never a number.
      expect(norm(`100 ${variant} EXAMPLE DR`)).toBe(`100 ${variant} EXAMPLE DR`);
    }
  });

  test('a lone suffix word is not wiped from a bare-direction street', () => {
    expect(_private.manateeAddressSearchCandidates('100 W Lake')).toEqual(['100 W LK']);
  });
});

describe('normalizeCountyStreetLine: routes and numbered streets are unaffected', () => {
  test('numbered routes keep the route canonicalization', () => {
    expect(norm('100 US Highway 41 N')).toBe('100 US 41 N');
    expect(norm('100 N US Hwy 41')).toBe('100 US 41 N');
    expect(norm('100 State Road 70 E')).toBe('100 SR 70 E');
    expect(norm('100 Hwy 70')).toBe('100 SR 70');
    expect(norm('100 County Road 675')).toBe('100 CR 675');
    expect(norm('100 FL-70')).toBe('100 SR 70');
  });

  test('numbered streets and historical globals behave as before', () => {
    expect(norm('100 5th Street West')).toBe('100 5TH ST W');
    expect(norm('100 17th Avenue NW')).toBe('100 17TH AVE NW');
    expect(norm('100 N 5th St')).toBe('100 N 5TH ST');
    expect(norm('100 Example Boulevard')).toBe('100 EXAMPLE BLVD');
    expect(norm('100 Avenue Example Dr')).toBe('100 AVE EXAMPLE DR');
    expect(norm('100 Example Highway')).toBe('100 EXAMPLE HWY');
  });
});

describe('county search candidates and the audit with USPS suffixes', () => {
  test('manatee candidates for a typed variant carry the key and the stripped street', () => {
    expect(_private.manateeAddressSearchCandidates('100 Example Lake, Parrish, FL 34219')).toEqual([
      '100 EXAMPLE LK',
      '100 EXAMPLE',
    ]);
  });

  test('a typed abbreviation finds a roll that spells the suffix out', async () => {
    mockSitusResponse(['100 EXAMPLE LAKE', '102 EXAMPLE LAKE']);

    const audit = await auditAddressHouseNumber('100 Example Lk, Parrish, FL 34219');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });

  test('a typed spelled-out suffix finds a roll that abbreviates it', async () => {
    mockSitusResponse(['100 EXAMPLE HTS', '102 EXAMPLE HTS']);

    const audit = await auditAddressHouseNumber('100 Example Heights, Parrish, FL 34219');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });
});

describe('diagonal post-directions through the suffix helpers', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  test('typed "Example Lake NW" finds a roll spelled "EXAMPLE LAKE NW" (query strips the suffix)', async () => {
    const { auditAddressHouseNumber } = require('../services/property-lookup/ai-property-lookup');
    const wheres = [];
    global.fetch = jest.fn().mockImplementation(async (url) => {
      wheres.push(new URL(url).searchParams.get('where'));
      return { ok: true, json: async () => ({ features: [{ attributes: { SITUS_ADDRESS: '100 EXAMPLE LAKE NW', SITUS_POSTAL_ZIP: '34202' } }] }) };
    });
    const audit = await auditAddressHouseNumber('100 Example Lake NW, Bradenton, FL 34202');
    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
    expect(wheres[0]).toContain("'%EXAMPLE%'");
    expect(wheres[0]).not.toContain('LK NW');
  });
});
