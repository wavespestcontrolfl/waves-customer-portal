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
    expect(_private.manateeAddressSearchCandidates('100 W Lake')).toEqual(['100 W LK', '100 W LAKE']);
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
    expect(_private.manateeAddressSearchCandidates('100 Example Lake, Parrish, FL 34219')).toEqual(['100 EXAMPLE LK', '100 EXAMPLE LAKE', '100 EXAMPLE']);
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

describe('a street whose name is a suffix word', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  test('typed "100 W Lake" finds a roll that spells "100 W LAKE" (mock filters by the outbound LIKE)', async () => {
    const { auditAddressHouseNumber } = require('../services/property-lookup/ai-property-lookup');
    const ROLL = ['100 W LAKE', '120 W LAKE'];
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const where = new URL(url).searchParams.get('where');
      const like = /LIKE '%(.*)%'/.exec(where)[1].split('%');
      const rows = ROLL.filter((r) => { let i = 0; return like.every((part) => { const j = r.indexOf(part, i); if (j < 0) return false; i = j + part.length; return true; }); });
      return { ok: true, json: async () => ({ features: rows.map((r) => ({ attributes: { SITUS_ADDRESS: r, SITUS_POSTAL_ZIP: '34202' } })) }) };
    });
    const audit = await auditAddressHouseNumber('100 W Lake, Bradenton, FL 34202');
    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });
});

describe('round-3 pre-push fixes', () => {
  const { routeSpellingVariants } = require('../services/property-lookup/route-spellings');
  const { _private } = require('../services/property-lookup/ai-property-lookup');
  test('expansion uses the USPS primary name, never a listed misspelling', () => {
    expect(routeSpellingVariants('W VLG')).toEqual(['W VLG', 'W VILLAGE']);
    expect(routeSpellingVariants('100 W LK')).toEqual(['100 W LK', '100 W LAKE']);
  });
  test('a numbered street name ("Avenue 2") is never peeled as a bare unit', () => {
    expect(_private.stripUnitDesignators('100 AVE 2', { bareUnit: true })).toBe('100 AVE 2');
    expect(_private.stripUnitDesignators('100 AVE 2', { bareUnit: true }))
      .not.toBe(_private.stripUnitDesignators('100 AVE 1', { bareUnit: true }));
    expect(_private.stripUnitDesignators('100 EXAMPLE DR 10A', { bareUnit: true })).toBe('100 EXAMPLE DR');
  });
  test('typed "100 Avenue 2" does not match a roll row "100 AVENUE 1"', async () => {
    const { auditAddressHouseNumber } = require('../services/property-lookup/ai-property-lookup');
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [{ attributes: { SITUS_ADDRESS: '100 AVENUE 1', SITUS_POSTAL_ZIP: '34217' } }] }) });
    try {
      const audit = await auditAddressHouseNumber('100 Avenue 2, Bradenton Beach, FL 34217');
      expect(audit?.hasExactMatch).not.toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('parcel search never loses a pre-suffix-table spelling', () => {
  test('"100 Example Lake East" still sends the old "100 EXAMPLE LAKE E" alongside the new key', () => {
    const c = _private.countyAddressSearchCandidates('100 Example Lake East, Port Charlotte, FL 33948');
    expect(c).toEqual(expect.arrayContaining(['100 EXAMPLE LK E', '100 EXAMPLE LAKE E', '100 EXAMPLE LAKE EAST']));
  });
});

describe('bare-unit guard ignores a lone direction', () => {
  test('"100 N AVE 2" keeps its number; a named street still peels', () => {
    expect(_private.stripUnitDesignators('100 N AVE 2', { bareUnit: true })).toBe('100 N AVE 2');
    expect(_private.stripUnitDesignators('100 NE AVE 1', { bareUnit: true })).toBe('100 NE AVE 1');
    expect(_private.stripUnitDesignators('100 E EXAMPLE CT 3', { bareUnit: true })).toBe('100 E EXAMPLE CT');
  });
});

describe('codex r2: spelled-out keys and Charlotte situs locality', () => {
  const { routeSpellingVariants } = require('../services/property-lookup/route-spellings');
  test('a name-only street whose key is spelled out also searches the abbreviation', () => {
    expect(routeSpellingVariants('100 W ISLAND')).toEqual(['100 W ISLAND', '100 W IS']);
    expect(routeSpellingVariants('CREEK')).toEqual(['CREEK', 'CRK']);
    // Not name-only: an ordinary street ending in the word is untouched.
    expect(routeSpellingVariants('EXAMPLE ISLAND')).toEqual(['EXAMPLE ISLAND']);
  });

  test('the Charlotte record parser exposes the verified situs city and ZIP', () => {
    const html = '<table><tr><td>Property Address:</td><td>100 EXAMPLE TER</td></tr><tr><td>Property City &amp; Zip:</td><td>PORT CHARLOTTE 33948</td></tr></table>';
    const parsed = _private.parseCharlottePaoRecord({ address: '100 Example Ter, Port Charlotte, FL 33948', search: { parcelId: '400000000001', situsAddress: '100 EXAMPLE TER', city: null, zipCode: null }, detailHtml: html, ownership: { attributes: { city: 'OWNERTOWN', zipcode: '10001' } } });
    // Never the ownership layer's mailing locality.
    expect(parsed._situsCity).not.toBe('OWNERTOWN');
    expect(parsed._situsZip).not.toBe('10001');
  });
});

describe('codex r3: directional city vs the wider suffix set', () => {
  test('a name word that is also a USPS suffix does not take the city\'s WEST', () => {
    expect(norm('100 Harbor Island West Bradenton FL 34209')).toBe('100 HARBOR ISLAND');
    // The historical suffixes keep the street's direction, as before.
    expect(norm('4506 45th Street West Bradenton FL 34209')).toBe('4506 45TH ST W');
  });
});
