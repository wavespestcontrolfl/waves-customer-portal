const amazon = require('../services/price-scan/adapters/amazon-business');
const { selectAdapterKey, getAdapter } = require('../services/price-scan/adapters/registry');
const { specsNeedBrowser } = require('../services/price-scan/scanner');

const CRED_KEYS = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_BUSINESS_REFRESH_TOKEN', 'AMAZON_BUSINESS_USER_EMAIL'];
const setCreds = () => {
  process.env.AMAZON_LWA_CLIENT_ID = 'cid';
  process.env.AMAZON_LWA_CLIENT_SECRET = 'csecret';
  process.env.AMAZON_BUSINESS_REFRESH_TOKEN = 'rtok';
  process.env.AMAZON_BUSINESS_USER_EMAIL = 'buyer@wavespestcontrol.com';
};
const clearCreds = () => CRED_KEYS.forEach((k) => delete process.env[k]);
const noSleep = () => Promise.resolve(); // skip the real throttle delay in tests

// fetch stub routing the LWA token URL, the by-ASIN endpoint, and the keyword search.
function makeFetch({ products = [], byAsinProduct = null, tokenStatus = 200, productsStatus = 200, byAsinStatus = 200 } = {}) {
  return jest.fn(async (url) => {
    const s = String(url);
    if (s.includes('api.amazon.com/auth/o2/token')) {
      return { ok: tokenStatus < 400, status: tokenStatus, json: async () => ({ access_token: 'ATK', expires_in: 3600 }) };
    }
    if (/\/products\/2020-08-26\/products\/[^?]+/.test(s)) { // by-ASIN retrieval
      return { ok: byAsinStatus < 400, status: byAsinStatus, json: async () => (byAsinProduct || {}) };
    }
    return { ok: productsStatus < 400, status: productsStatus, json: async () => ({ products }) }; // keyword search
  });
}
const deps = (fetchImpl) => ({ amazonDeps: { fetch: fetchImpl, sleep: noSleep } });

const talstar = { vendorProductName: 'Talstar P', productName: 'Talstar P', packSizeValue: 96, packSizeUnit: 'oz' };
// product-level price shape (explicit NEW — missing condition now fails closed)
const talstarFlat = { asin: 'B001', title: 'Talstar P Professional Insecticide 96 oz', price: { amount: 44.5, currencyCode: 'USD' }, productCondition: 'New', inStock: true };
// documented nested OFFERS shape: offers[].price.value.amount
const talstarOffers = { asin: 'B010', title: 'Talstar P Professional Insecticide 96 oz', includedDataTypes: { OFFERS: [{ price: { value: { amount: 41.25, currencyCode: 'USD' } }, productCondition: 'New', inStock: true }] } };
const vendor = { vendor_id: 'amz', name: 'Amazon', website: 'https://www.amazon.com' };

describe('amazon-business adapter', () => {
  const saved = { ...process.env };
  beforeEach(() => { clearCreds(); amazon.resetState(); });
  afterAll(() => { process.env = saved; });

  describe('isConfigured / gating', () => {
    test('false until ALL four credentials are set', () => {
      expect(amazon.isConfigured()).toBe(false);
      setCreds(); delete process.env.AMAZON_BUSINESS_USER_EMAIL;
      expect(amazon.isConfigured()).toBe(false);
      setCreds();
      expect(amazon.isConfigured()).toBe(true);
    });
    test('fetchCandidate is inert (null, no fetch) when unconfigured', async () => {
      const f = makeFetch({ products: [talstarFlat] });
      const r = await amazon.fetchCandidate(null, vendor, talstar, deps(f));
      expect(r).toBeNull();
      expect(f).not.toHaveBeenCalled();
    });
  });

  describe('registry routing is anchored to a parsed host (#6)', () => {
    test('real Amazon hosts route to the amazon adapter', () => {
      expect(selectAdapterKey({ name: 'Amazon', website: 'https://www.amazon.com' })).toBe('amazon');
      expect(selectAdapterKey({ url: 'https://business.amazon.com/x' })).toBe('amazon');
      expect(getAdapter('amazon').key).toBe('amazon');
    });
    test('look-alike hosts do NOT route to amazon (no price misattribution)', () => {
      expect(selectAdapterKey({ website: 'https://notamazon.com' })).toBe('generic');
      expect(selectAdapterKey({ website: 'https://amazon.com.evil.com' })).toBe('generic');
      expect(selectAdapterKey({ name: 'amazon deals llc' })).toBe('generic'); // name alone never routes
    });
  });

  describe('getAccessToken', () => {
    test('exchanges the refresh token and caches the result', async () => {
      setCreds();
      const f = makeFetch();
      expect(await amazon.getAccessToken({ fetch: f })).toBe('ATK');
      expect(await amazon.getAccessToken({ fetch: f })).toBe('ATK');
      expect(f).toHaveBeenCalledTimes(1); // cached
      expect(f.mock.calls[0][1].body).toContain('grant_type=refresh_token');
    });
    test('throws on a non-OK token response (no body leak)', async () => {
      setCreds();
      await expect(amazon.getAccessToken({ fetch: makeFetch({ tokenStatus: 400 }) })).rejects.toThrow(/LWA token 400/);
    });
  });

  describe('fetchCandidate (configured)', () => {
    test('sends required params (productRegion/locale/includedDataTypes) + auth headers', async () => {
      setCreds();
      const f = makeFetch({ products: [talstarFlat] });
      const cand = await amazon.fetchCandidate(null, vendor, talstar, deps(f));
      expect(cand).toMatchObject({ price: 44.5, currency: 'USD', availability: 'in_stock', quantity: '96 oz', price_type: 'account', vendor: 'Amazon', vendor_id: 'amz' });
      expect(cand.source_url).toContain('/dp/B001');
      const call = f.mock.calls.find((c) => String(c[0]).includes('/products/'));
      const url = String(call[0]);
      expect(url).toContain('na.business-api.amazon.com'); // regional NA host, not the explorer host
      expect(url).toContain('productRegion=US');
      expect(url).toContain('locale=en_US');
      expect(url).toContain('facets=OFFERS');
      expect(url).toContain('shippingPostalCode=34211'); // delivery region
      expect(call[1].headers['x-amz-access-token']).toBe('ATK'); // Amazon Business auth header
      expect(call[1].headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/); // required ISO-basic UTC
      expect(call[1].headers['user-agent']).toBeTruthy();
      expect(call[1].headers.Authorization).toBeUndefined(); // Bearer fallback dropped
      expect(call[1].headers['x-amz-user-email']).toBe('buyer@wavespestcontrol.com');
      expect(call[1].signal).toBeTruthy(); // abort timeout wired
    });
    test('reads the documented nested OFFER price (offers[].price.value.amount) (#2)', async () => {
      setCreds();
      const cand = await amazon.fetchCandidate(null, vendor, talstar, deps(makeFetch({ products: [talstarOffers] })));
      expect(cand).toMatchObject({ price: 41.25, currency: 'USD' });
      expect(cand.source_url).toContain('/dp/B010');
    });
    test('skips offers the account cannot buy or that are not new -> no candidate (#5, BLOCKED, condition)', async () => {
      setCreds();
      const price = { value: { amount: 30, currencyCode: 'USD' } };
      const mk = (offer) => ({ asin: 'B0X', title: 'Talstar P Professional Insecticide 96 oz', includedDataTypes: { OFFERS: [offer] } });
      const cases = [
        mk({ price, buyingRestrictions: ['PROFESSIONAL_USE'] }), // restricted
        mk({ price, buyingGuidance: 'BLOCKED' }), // guided-buying blocked (flat/deprecated)
        mk({ price, buyingGuidanceV2: { buyingGuidance: [{ type: 'BLOCKED' }] } }), // guided-buying v2
        mk({ price, productCondition: 'Used - Like New' }), // non-new (contains "New")
        mk({ price, productCondition: 'OTHER' }), // ambiguous enum -> non-new
        mk({ price, productCondition: 'UNKNOWN' }), // ambiguous enum -> non-new
        mk({ price }), // MISSING condition -> fail closed (default)
      ];
      for (const p of cases) {
        // eslint-disable-next-line no-await-in-loop
        const cand = await amazon.fetchCandidate(null, vendor, talstar, deps(makeFetch({ products: [p] })));
        expect(cand).toBeNull();
      }
    });
    test('an explicit NEW offer is accepted', async () => {
      setCreds();
      const p = { asin: 'B0N', title: 'Talstar P Professional Insecticide 96 oz', includedDataTypes: { OFFERS: [{ price: { value: { amount: 40, currencyCode: 'USD' } }, productCondition: 'New' }] } };
      const cand = await amazon.fetchCandidate(null, vendor, talstar, deps(makeFetch({ products: [p] })));
      expect(cand).toMatchObject({ price: 40, currency: 'USD' });
    });
    test('a curated Amazon product URL uses the exact by-ASIN endpoint, not keyword search', async () => {
      setCreds();
      const f = makeFetch({ byAsinProduct: { ...talstarFlat, asin: 'B07XYZ1234' } });
      const curated = { ...vendor, url: 'https://www.amazon.com/dp/B07XYZ1234?ref=foo' };
      const cand = await amazon.fetchCandidate(null, curated, talstar, deps(f));
      const calls = f.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => /\/products\/2020-08-26\/products\/B07XYZ1234/.test(u))).toBe(true); // by-ASIN endpoint hit
      expect(calls.some((u) => u.includes('keywords='))).toBe(false); // no keyword fallback needed
      expect(cand).toMatchObject({ price: 44.5 });
    });
    test('an exact-ASIN miss (404) falls back to keyword search', async () => {
      setCreds();
      const f = makeFetch({ byAsinStatus: 404, products: [talstarFlat] });
      const curated = { ...vendor, url: 'https://www.amazon.com/dp/B0MISS1234' };
      const cand = await amazon.fetchCandidate(null, curated, talstar, deps(f));
      expect(f.mock.calls.map((c) => String(c[0])).some((u) => u.includes('keywords='))).toBe(true); // fell back
      expect(cand).toMatchObject({ price: 44.5 });
    });
    test('throws on an HTTP error so the scan records a retryable fetch_error', async () => {
      setCreds();
      await expect(amazon.fetchCandidate(null, vendor, talstar, deps(makeFetch({ productsStatus: 429 })))).rejects.toThrow(/amazon products 429/);
    });
    test('non-USD currency is carried through (scanner drops it before ranking)', async () => {
      setCreds();
      const cad = { asin: 'B002', title: 'Talstar P Professional Insecticide 96 oz', price: { amount: 60, currencyCode: 'CAD' }, productCondition: 'New', inStock: true };
      const cand = await amazon.fetchCandidate(null, vendor, talstar, deps(makeFetch({ products: [cad] })));
      expect(cand.currency).toBe('CAD');
    });
  });

  describe('response parsing helpers', () => {
    test('priceOf reads nested value.amount, flat amount, scalar value; rejects non-positive', () => {
      expect(amazon.priceOf({ price: { value: { amount: 12.34, currencyCode: 'USD' } } })).toEqual({ amount: 12.34, currency: 'USD' });
      expect(amazon.priceOf({ price: { amount: 9.99, currencyCode: 'USD' } })).toEqual({ amount: 9.99, currency: 'USD' });
      expect(amazon.priceOf({ buyingPrice: { value: 5 } })).toEqual({ amount: 5, currency: 'USD' });
      expect(amazon.priceOf({ price: { value: { amount: 0 } } })).toBeNull();
      expect(amazon.priceOf({})).toBeNull();
    });
    test('hasBuyingRestriction detects restriction arrays + non-purchasable flags', () => {
      expect(amazon.hasBuyingRestriction({ buyingRestrictions: ['X'] })).toBe(true);
      expect(amazon.hasBuyingRestriction({ purchasable: false })).toBe(true);
      expect(amazon.hasBuyingRestriction({ buyingGuidance: 'BLOCKED' })).toBe(true);
      expect(amazon.hasBuyingRestriction({ buyingGuidanceV2: { buyingGuidance: [{ type: 'BLOCKED' }] } })).toBe(true);
      expect(amazon.hasBuyingRestriction({})).toBe(false);
    });
    test('availabilityOf maps stock signals; unknown stays unknown', () => {
      expect(amazon.availabilityOf({ inStock: true })).toBe('in_stock');
      expect(amazon.availabilityOf({ inStock: false })).toBe('out_of_stock');
      expect(amazon.availabilityOf({})).toBe('unknown');
    });
  });

  describe('scanner does not force the HTTP adapter through Chromium (#4)', () => {
    test('specsNeedBrowser is false for an Amazon-only batch, true once a browser vendor is present', () => {
      const amazonSpec = { product: talstar, vendors: [{ name: 'Amazon', website: 'https://www.amazon.com' }] };
      const domyownSpec = { product: talstar, vendors: [{ name: 'DoMyOwn', url: 'https://www.domyown.com' }] };
      expect(specsNeedBrowser([amazonSpec])).toBe(false);
      expect(specsNeedBrowser([domyownSpec])).toBe(true);
      expect(specsNeedBrowser([amazonSpec, domyownSpec])).toBe(true);
    });
  });
});
