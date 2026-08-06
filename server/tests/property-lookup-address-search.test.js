/**
 * Address-search half probes (canary surface).
 *
 * searchOnly pins the codex #3230 P2 contract: the canary's Sarasota probe
 * must stop at the search response — the production path's follow-up
 * detail-page request would double county traffic and misclassify a detail
 * timeout as an address-search failure.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private, searchCountyParcelByAddress } = require('../services/property-lookup/ai-property-lookup');

const SEARCH_HTML = `
  <span class="reg"><a href="/propertysearch/parcel/details/0757010259">12606 SHIMMERING OAK CIR VENICE, FL, 34293</a></span>
`;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({
    ok: true,
    url: 'https://www.sc-pa.com/propertysearch/Result',
    text: async () => SEARCH_HTML,
  }));
});

describe('searchSarasotaParcel searchOnly mode', () => {
  const address = '12606 Shimmering Oak Cir, Venice, FL 34293';

  test('searchOnly returns the validated match after exactly ONE county request', async () => {
    const match = await _private.searchSarasotaParcel(address, 8000, Date.now(), { searchOnly: true });
    expect(match).toMatchObject({ parcelId: '0757010259' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('default mode still follows up with the detail request (production contract unchanged)', async () => {
    await _private.searchSarasotaParcel(address, 8000, Date.now());
    expect(global.fetch.mock.calls.length).toBeGreaterThan(1);
  });

  test('the canary dispatcher routes Sarasota through searchOnly', async () => {
    const match = await searchCountyParcelByAddress('Sarasota', address, { timeoutMs: 8000 });
    expect(match).toMatchObject({ parcelId: '0757010259' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('COUNTY_PROVIDERS registry parity', () => {
  test('every provider row carries lookup + search + eligibility gate together', () => {
    const rows = _private.COUNTY_PROVIDERS;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(typeof row.county).toBe('string');
      expect(typeof row.lookup).toBe('function');
      expect(typeof row.search).toBe('function');
      expect(typeof row.shouldQuery).toBe('function');
    }
    // The canary's golden counties all dispatch through the registry.
    const counties = rows.map((r) => r.county);
    for (const county of ['MANATEE', 'SARASOTA', 'CHARLOTTE', 'HILLSBOROUGH']) {
      expect(counties).toContain(county);
    }
  });
});
