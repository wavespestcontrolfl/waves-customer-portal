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
