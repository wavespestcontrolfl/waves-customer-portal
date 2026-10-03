/**
 * Terminal suffix aliases + bare trailing unit tokens in the county street
 * matcher. Streets are invented; the shapes mirror live roll spellings.
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

describe('normalizeCountyStreetLine: WY → WAY', () => {
  test('a terminal "Wy" canonicalizes to the roll spelling WAY', () => {
    expect(_private.normalizeCountyStreetLine('100 Example Creek Wy, Parrish, FL 34219')).toBe('100 EXAMPLE CREEK WAY');
    expect(_private.normalizeCountyStreetLine('100 Example Creek Wy')).toBe('100 EXAMPLE CREEK WAY');
    // Before a post-direction or a unit tail, like the other terminal aliases.
    expect(_private.normalizeCountyStreetLine('100 Example Creek Wy E')).toBe('100 EXAMPLE CREEK WAY E');
    expect(_private.normalizeCountyStreetLine('100 Example Creek Wy Apt 4')).toBe('100 EXAMPLE CREEK WAY APT 4');
  });

  test('WY inside a street name is left alone', () => {
    expect(_private.normalizeCountyStreetLine('100 Wy Oak Dr')).toBe('100 WY OAK DR');
  });

  test('an already-spelled WAY is unchanged', () => {
    expect(_private.normalizeCountyStreetLine('100 Example Creek Way')).toBe('100 EXAMPLE CREEK WAY');
  });

  test('manatee candidates for a typed "Wy" address carry the roll spelling', () => {
    expect(_private.manateeAddressSearchCandidates('100 Example Creek Wy, Parrish, FL 34219')).toEqual([
      '100 EXAMPLE CREEK WAY',
      '100 EXAMPLE CREEK',
    ]);
  });

  test('the audit finds a typed "Wy" street on a roll that spells WAY', async () => {
    mockSitusResponse(['100 EXAMPLE CREEK WAY', '102 EXAMPLE CREEK WAY']);

    const audit = await auditAddressHouseNumber('100 Example Creek Wy, Parrish, FL 34219');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });
});

describe('stripUnitDesignators: bare trailing unit tokens (opt-in)', () => {
  const strip = (value) => _private.stripUnitDesignators(value, { bareUnit: true });

  test('peels a digit-led token that directly follows a street suffix', () => {
    expect(strip('EXAMPLE BAY DR 10A')).toBe('EXAMPLE BAY DR');
    expect(strip('EXAMPLE BAY DR 2')).toBe('EXAMPLE BAY DR');
    expect(strip('EXAMPLE COVE CT 12-B')).toBe('EXAMPLE COVE CT');
    expect(strip('100 EXAMPLE BAY DR 10A')).toBe('100 EXAMPLE BAY DR');
  });

  test('peels it past one post-suffix direction', () => {
    expect(strip('EXAMPLE COVE CT E 2')).toBe('EXAMPLE COVE CT E');
    expect(strip('EXAMPLE COVE CT NE 14')).toBe('EXAMPLE COVE CT NE');
  });

  test('never peels a route number', () => {
    expect(strip('US 41')).toBe('US 41');
    expect(strip('SR 70 E')).toBe('SR 70 E');
    expect(strip('100 US 41 N')).toBe('100 US 41 N');
    expect(strip('CR 675')).toBe('CR 675');
    // A suffix that routinely precedes a route number keeps it.
    expect(strip('OLD EXAMPLE HWY 41')).toBe('OLD EXAMPLE HWY 41');
    expect(strip('EXAMPLE RD 70')).toBe('EXAMPLE RD 70');
  });

  test('never peels a numbered street (the number precedes the suffix)', () => {
    expect(strip('5TH ST')).toBe('5TH ST');
    expect(strip('100 5TH ST')).toBe('100 5TH ST');
    expect(strip('17TH AVE E')).toBe('17TH AVE E');
    expect(strip('100 N 5TH ST E')).toBe('100 N 5TH ST E');
  });

  test('a letter-only token is left alone (could be a direction or a name)', () => {
    expect(strip('EXAMPLE BAY DR B')).toBe('EXAMPLE BAY DR B');
    expect(strip('EXAMPLE BAY DR E')).toBe('EXAMPLE BAY DR E');
  });

  test('still peels labeled designators, with or without the opt-in', () => {
    expect(strip('EXAMPLE BAY DR APT 4')).toBe('EXAMPLE BAY DR');
    expect(_private.stripUnitDesignators('EXAMPLE BAY DR APT 4')).toBe('EXAMPLE BAY DR');
  });

  test('default behavior keeps a bare trailing number (condo-unit folio matchers read it)', () => {
    expect(_private.stripUnitDesignators('EXAMPLE BAY DR 10A')).toBe('EXAMPLE BAY DR 10A');
    expect(_private.stripUnitDesignators('EXAMPLE COVE CT E 2')).toBe('EXAMPLE COVE CT E 2');
  });
});

describe('auditAddressHouseNumber: roll rows with a bare trailing unit', () => {
  // Sarasota writes condo units as "<number> <STREET> DR 10A, CITY FL, ZIP".
  const sarasotaSitus = [
    '100 EXAMPLE BAY DR 10A, SARASOTA FL, 34238',
    '100 EXAMPLE BAY DR 10B, SARASOTA FL, 34238',
    '100 EXAMPLE BAY DR 11A, SARASOTA FL, 34238',
  ];

  test('a street that IS on the roll only through bare-unit rows is found', async () => {
    mockSitusResponse(sarasotaSitus, 'fulladdress');

    const audit = await auditAddressHouseNumber('100 Example Bay Dr, Sarasota, FL 34238');

    expect(audit).toMatchObject({ county: 'Sarasota', streetExists: true, hasExactMatch: true });
  });

  test('a different house number on that street reports nearest numbers, not street-not-found', async () => {
    mockSitusResponse(sarasotaSitus.concat('104 EXAMPLE BAY DR 2, SARASOTA FL, 34238'), 'fulladdress');

    const audit = await auditAddressHouseNumber('102 Example Bay Dr, Sarasota, FL 34238');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: false });
    expect(audit.nearestNumbers).toEqual([100, 104]);
  });

  test('a typed bare unit on the address audits the street itself', async () => {
    mockSitusResponse(sarasotaSitus, 'fulladdress');

    const audit = await auditAddressHouseNumber('100 Example Bay Dr 10A, Sarasota, FL 34238');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true, streetLabel: 'EXAMPLE BAY DR' });
  });

  test('a post-direction before the bare unit still matches', async () => {
    mockSitusResponse(['100 EXAMPLE COVE CT E 2, SARASOTA FL, 34238'], 'fulladdress');

    const audit = await auditAddressHouseNumber('100 Example Cove Ct E, Sarasota, FL 34238');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });

  test('a numbered street is not mistaken for a unit', async () => {
    mockSitusResponse(['100 5TH ST E, SARASOTA FL, 34236', '102 5TH ST E, SARASOTA FL, 34236'], 'fulladdress');

    const audit = await auditAddressHouseNumber('100 5th St E, Sarasota, FL 34236');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true, streetLabel: '5TH ST E' });
  });

  test('a numbered route keeps its number', async () => {
    mockSitusResponse(['100 SR 70 E', '102 SR 70 E']);

    const audit = await auditAddressHouseNumber('100 SR 70 E, Bradenton, FL 34202');

    expect(audit).toMatchObject({ streetExists: true, hasExactMatch: true });
  });
});

describe('typed house-number override', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const roll = (rows) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ features: rows.map((r) => ({ attributes: { SITUS_ADDRESS: r, SITUS_POSTAL_ZIP: '34219' } })) }) });
  };
  test('a hyphenated typed number never overrides the canonical one', async () => {
    roll(['14384 EXAMPLE STONE LOOP']);
    const audit = await auditAddressHouseNumber('14384 Example Stone Loop, Parrish, FL 34219', null, { typedAddress: '14-384 Example Stone Loop' });
    expect(audit).toMatchObject({ houseNumber: 14384, hasExactMatch: true });
  });
  test('a plain typed number still overrides a snapped canonical number', async () => {
    roll(['14384 EXAMPLE STONE LOOP']);
    const audit = await auditAddressHouseNumber('14384 Example Stone Loop, Parrish, FL 34219', null, { typedAddress: '14386 Example Stone Loop, Parrish, FL 34219' });
    expect(audit).toMatchObject({ houseNumber: 14386, hasExactMatch: false });
  });
});
