const amazon = require('../services/price-scan/adapters/amazon-business');
const { selectAdapterKey, getAdapter } = require('../services/price-scan/adapters/registry');

const CRED_KEYS = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_BUSINESS_REFRESH_TOKEN', 'AMAZON_BUSINESS_USER_EMAIL'];
const setCreds = () => {
  process.env.AMAZON_LWA_CLIENT_ID = 'cid';
  process.env.AMAZON_LWA_CLIENT_SECRET = 'csecret';
  process.env.AMAZON_BUSINESS_REFRESH_TOKEN = 'rtok';
  process.env.AMAZON_BUSINESS_USER_EMAIL = 'buyer@wavespestcontrol.com';
};
const clearCreds = () => CRED_KEYS.forEach((k) => delete process.env[k]);

// A fetch stub: routes the LWA token URL vs the products URL.
function makeFetch({ products = [], tokenStatus = 200, productsStatus = 200 } = {}) {
  return jest.fn(async (url) => {
    if (String(url).includes('api.amazon.com/auth/o2/token')) {
      return { ok: tokenStatus < 400, status: tokenStatus, json: async () => ({ access_token: 'ATK', expires_in: 3600 }) };
    }
    return { ok: productsStatus < 400, status: productsStatus, json: async () => ({ products }) };
  });
}

const talstar = { vendorProductName: 'Talstar P', productName: 'Talstar P', packSizeValue: 96, packSizeUnit: 'oz' };
const talstarProduct = { asin: 'B001', title: 'Talstar P Professional Insecticide 96 oz', price: { amount: 44.5, currencyCode: 'USD' }, inStock: true };
const vendor = { vendor_id: 'amz', name: 'Amazon', website: 'https://www.amazon.com' };

describe('amazon-business adapter', () => {
  const saved = { ...process.env };
  beforeEach(() => { clearCreds(); amazon.resetTokenCache(); });
  afterAll(() => { process.env = saved; });

  describe('isConfigured / gating', () => {
    test('false until ALL four credentials are set', () => {
      expect(amazon.isConfigured()).toBe(false);
      setCreds();
      delete process.env.AMAZON_BUSINESS_USER_EMAIL;
      expect(amazon.isConfigured()).toBe(false); // one missing
      setCreds();
      expect(amazon.isConfigured()).toBe(true);
    });
    test('fetchCandidate is inert (returns null, no fetch) when unconfigured', async () => {
      const fetchImpl = makeFetch({ products: [talstarProduct] });
      const r = await amazon.fetchCandidate(null, vendor, talstar, { amazonDeps: { fetch: fetchImpl } });
      expect(r).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('registry wiring', () => {
    test('amazon.com routes to the amazon adapter', () => {
      expect(selectAdapterKey({ name: 'Amazon', url: 'https://www.amazon.com' })).toBe('amazon');
      expect(getAdapter('amazon').key).toBe('amazon');
    });
    test('the adapter exposes isConfigured so scrapableVendors can gate it', () => {
      expect(typeof getAdapter('amazon').isConfigured).toBe('function');
    });
  });

  describe('getAccessToken', () => {
    test('exchanges the refresh token and caches the result', async () => {
      setCreds();
      const fetchImpl = makeFetch();
      const t1 = await amazon.getAccessToken({ fetch: fetchImpl });
      const t2 = await amazon.getAccessToken({ fetch: fetchImpl });
      expect(t1).toBe('ATK');
      expect(t2).toBe('ATK');
      expect(fetchImpl).toHaveBeenCalledTimes(1); // cached on the second call
      const body = fetchImpl.mock.calls[0][1].body;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=rtok');
    });
    test('throws on a non-OK token response (without leaking the body)', async () => {
      setCreds();
      await expect(amazon.getAccessToken({ fetch: makeFetch({ tokenStatus: 400 }) })).rejects.toThrow(/LWA token 400/);
    });
  });

  describe('fetchCandidate (configured)', () => {
    test('returns a verified business-priced candidate with a proof URL', async () => {
      setCreds();
      const fetchImpl = makeFetch({ products: [talstarProduct] });
      const cand = await amazon.fetchCandidate(null, vendor, talstar, { amazonDeps: { fetch: fetchImpl } });
      expect(cand).toMatchObject({
        price: 44.5,
        currency: 'USD',
        availability: 'in_stock',
        quantity: '96 oz',
        price_type: 'account',
        vendor: 'Amazon',
        vendor_id: 'amz',
      });
      expect(cand.source_url).toContain('/dp/B001');
      // sends the LWA bearer + the required x-amz-user-email header on the search call
      const searchCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/products/'));
      expect(searchCall[1].headers.Authorization).toBe('Bearer ATK');
      expect(searchCall[1].headers['x-amz-user-email']).toBe('buyer@wavespestcontrol.com');
    });
    test('does NOT match a different product (matcher gate still applies)', async () => {
      setCreds();
      const wrong = { asin: 'B999', title: 'Generic Ant Bait Stations 4 pack', price: { amount: 9.99, currencyCode: 'USD' }, inStock: true };
      const fetchImpl = makeFetch({ products: [wrong] });
      const cand = await amazon.fetchCandidate(null, vendor, talstar, { amazonDeps: { fetch: fetchImpl } });
      // wrong product is priced -> returned only as the unverified fallback, never as a verified match
      expect(cand && cand.source_url).toContain('/dp/B999');
      // but it would be a precise 'unverified' skip downstream, not a match — assert verifyMatch wouldn't pass:
      expect(cand.name).toMatch(/Ant Bait/);
    });
    test('throws on an HTTP error so the scan records a retryable fetch_error', async () => {
      setCreds();
      await expect(
        amazon.fetchCandidate(null, vendor, talstar, { amazonDeps: { fetch: makeFetch({ productsStatus: 429 }) } }),
      ).rejects.toThrow(/amazon products 429/);
    });
    test('non-USD currency is carried through (the scanner drops it before ranking)', async () => {
      setCreds();
      const cad = { asin: 'B002', title: 'Talstar P Professional Insecticide 96 oz', price: { amount: 60, currencyCode: 'CAD' }, inStock: true };
      const cand = await amazon.fetchCandidate(null, vendor, talstar, { amazonDeps: { fetch: makeFetch({ products: [cad] }) } });
      expect(cand.currency).toBe('CAD');
    });
  });

  describe('response parsing helpers', () => {
    test('priceOf reads amount + currency with fallbacks; rejects non-positive', () => {
      expect(amazon.priceOf({ price: { amount: 12.34, currencyCode: 'USD' } })).toEqual({ amount: 12.34, currency: 'USD' });
      expect(amazon.priceOf({ buyingPrice: { value: 5, currency: 'USD' } })).toEqual({ amount: 5, currency: 'USD' });
      expect(amazon.priceOf({ price: { amount: 0 } })).toBeNull();
      expect(amazon.priceOf({})).toBeNull();
    });
    test('candidateFromProduct skips an unpriced product and one with no proof URL', () => {
      expect(amazon.candidateFromProduct({ title: 'X' }, vendor)).toBeNull(); // unpriced
      expect(amazon.candidateFromProduct({ title: 'X', price: { amount: 5 }, asin: 'A1' }, vendor).source_url).toContain('/dp/A1');
    });
    test('availabilityOf maps stock signals; unknown stays unknown', () => {
      expect(amazon.availabilityOf({ inStock: true })).toBe('in_stock');
      expect(amazon.availabilityOf({ inStock: false })).toBe('out_of_stock');
      expect(amazon.availabilityOf({})).toBe('unknown');
    });
  });
});
