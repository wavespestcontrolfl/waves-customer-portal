// Veseris search redirect + short-query retry, and Cloudflare bot-check detection with a
// per-run breaker (base.js). Fake page objects only: no browser, no vendor traffic.
const {
  makeAdapter, collectSnapshot, isBotCheckSignals, landedOnProductUrl, shortSearchQuery, BOT_CHECK_BREAKER_LIMIT,
} = require('../services/price-scan/adapters/base');
const veseris = require('../services/price-scan/adapters/veseris');
const domyown = require('../services/price-scan/adapters/domyown');
const keystone = require('../services/price-scan/adapters/keystone');

const HOST = 'https://shop.example';
const searchUrlFor = (q) => `${HOST}/default/catalogsearch/result/?q=${encodeURIComponent(q)}`;

const ld = (name, price) => JSON.stringify({
  '@type': 'Product', name, offers: { '@type': 'Offer', price, priceCurrency: 'USD', availability: 'http://schema.org/InStock' },
});

const termidor = {
  productName: 'Termidor SC', vendorProductName: 'Termidor SC Termiticide Insecticide', quantity: '78 oz', packSizeValue: 78, packSizeUnit: 'oz',
};
const TERMIDOR_URL = `${HOST}/default/termidor-sc-termiticide-insecticide-78-oz`;
const TERMIDOR_PAGE = { title: 'Termidor SC Termiticide Insecticide - 78 oz', jsonLd: [ld('Termidor SC Termiticide Insecticide - 78 oz', 152.1)] };

// pages: url -> { title, body, form, jsonLd, links }. redirects: requested url -> landing url.
function fakePage({ pages = {}, redirects = {}, ctx = {} } = {}) {
  let current = 'about:blank';
  const calls = { goto: [], wait: [] };
  const at = () => pages[current] || {};
  return {
    calls,
    context: () => ctx,
    url: () => current,
    goto: async (u) => { calls.goto.push(u); current = redirects[u] || u; },
    waitForSelector: async (sel, opts) => { calls.wait.push({ sel, opts }); },
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      if (fn.name === 'readBotCheckSignals') {
        const p = at();
        return { botCheckTitle: p.blockTitle || '', botCheckBody: p.body || '', botCheckForm: !!p.form };
      }
      if (fn === collectSnapshot) return { title: at().title || '', jsonLd: at().jsonLd || [], bodyText: '' };
      return at().links || []; // collectResultLinks
    },
  };
}

const makeShop = (extra = {}) => makeAdapter({
  key: 'shop',
  buildSearchUrl: (p) => searchUrlFor(String(p.searchQuery || p.vendorProductName || p.productName)),
  productLinkSelectors: ['.product-item-link'],
  searchWaitMs: 50,
  titleSelector: 'h1',
  ...extra,
});
const vendor = { vendor_id: 'v1', name: 'Shop' };

describe('pure helpers', () => {
  test('isBotCheckSignals: Cloudflare title, body text or challenge form', () => {
    expect(isBotCheckSignals({ botCheckTitle: 'Just a moment...', botCheckBody: '' })).toBe(true);
    expect(isBotCheckSignals({ botCheckTitle: '', botCheckBody: 'Performing security verification\nThis website uses a security service' })).toBe(true);
    expect(isBotCheckSignals({ botCheckTitle: '', botCheckBody: 'Please Verify you are human to continue' })).toBe(true);
    expect(isBotCheckSignals({ botCheckTitle: '', botCheckBody: '', botCheckForm: true })).toBe(true);
  });
  test('isBotCheckSignals: ordinary pages, junk and snapshot-shaped objects are not blocks', () => {
    expect(isBotCheckSignals({ botCheckTitle: 'Termidor SC - 78 oz', botCheckBody: 'Add to cart', botCheckForm: false })).toBe(false);
    expect(isBotCheckSignals({ botCheckTitle: 'Wait, just a moment of your time' })).toBe(false); // title must START with it
    expect(isBotCheckSignals({ title: 'Just a moment...', bodyText: 'verify you are human' })).toBe(false); // not the signal shape
    expect(isBotCheckSignals(null)).toBe(false);
    expect(isBotCheckSignals([])).toBe(false);
    expect(isBotCheckSignals('Just a moment')).toBe(false);
  });
  test('landedOnProductUrl: same host, not the search path, not the home page', () => {
    const search = 'https://veseris.com/default/catalogsearch/result/?q=Snapshot%202.5TG';
    expect(landedOnProductUrl('https://veseris.com/default/snapshot-2-5-tg-granular-herbicide', search)).toBe(true);
    expect(landedOnProductUrl('https://www.veseris.com/default/snapshot-2-5-tg-granular-herbicide', search)).toBe(true);
    expect(landedOnProductUrl('https://veseris.com/default/catalogsearch/result/?q=other', search)).toBe(false);
    expect(landedOnProductUrl('https://veseris.com/default/catalogsearch/result/index/?q=x', search)).toBe(false);
    expect(landedOnProductUrl('https://veseris.com/', search)).toBe(false);
    expect(landedOnProductUrl('https://evil.example/default/snapshot', search)).toBe(false);
    expect(landedOnProductUrl('about:blank', search)).toBe(false);
  });
  test('shortSearchQuery: first two tokens of the search query', () => {
    expect(shortSearchQuery({ searchQuery: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide' })).toBe('Dimension 2EW');
    expect(shortSearchQuery({ productName: 'Taurus  SC' })).toBe('Taurus SC');
    expect(shortSearchQuery({ productName: 'Snapshot' })).toBe('Snapshot');
  });
});

describe('veseris adapter opts in; the others do not', () => {
  test('flags', () => {
    expect(veseris.config.searchMayLandOnProduct).toBe(true);
    expect(veseris.config.shortQueryFallback).toBe(true);
    expect(domyown.config.searchMayLandOnProduct).toBeFalsy();
    expect(domyown.config.shortQueryFallback).toBeFalsy();
    expect(keystone.config.shortQueryFallback).toBeFalsy();
  });
});

describe('search that lands on a product page (searchMayLandOnProduct)', () => {
  const full = searchUrlFor('Termidor SC Termiticide Insecticide');

  test('uses the landed URL as the only candidate, without the link wait', async () => {
    const adapter = makeShop({ searchMayLandOnProduct: true });
    const page = fakePage({ pages: { [TERMIDOR_URL]: TERMIDOR_PAGE }, redirects: { [full]: TERMIDOR_URL } });
    const cand = await adapter.fetchCandidate(page, vendor, termidor);
    expect(cand).toMatchObject({ price: 152.1, source_url: TERMIDOR_URL });
    expect(page.calls.goto).toEqual([full, TERMIDOR_URL]);
    expect(page.calls.wait).toEqual([]); // no 50 ms (8 s on Veseris) wait for result links
  });

  test('a product page full of related-product links is still read as the product', async () => {
    const adapter = makeShop({ searchMayLandOnProduct: true });
    const page = fakePage({
      pages: { [TERMIDOR_URL]: { ...TERMIDOR_PAGE, links: [`${HOST}/default/other-product`] } },
      redirects: { [full]: TERMIDOR_URL },
    });
    expect((await adapter.fetchCandidate(page, vendor, termidor)).source_url).toBe(TERMIDOR_URL);
  });

  test('staying on the search results path follows the result links as before', async () => {
    const adapter = makeShop({ searchMayLandOnProduct: true });
    const page = fakePage({ pages: { [full]: { links: [TERMIDOR_URL] }, [TERMIDOR_URL]: TERMIDOR_PAGE } });
    const cand = await adapter.fetchCandidate(page, vendor, termidor);
    expect(cand.source_url).toBe(TERMIDOR_URL);
    expect(page.calls.goto).toEqual([full, TERMIDOR_URL]);
  });

  test('without the flag a landed product page yields no candidate (old behavior)', async () => {
    const adapter = makeShop();
    const page = fakePage({ pages: { [TERMIDOR_URL]: TERMIDOR_PAGE }, redirects: { [full]: TERMIDOR_URL } });
    expect(await adapter.fetchCandidate(page, vendor, termidor)).toBeNull();
  });

  test('a landed page that does not verify is not reported as a match', async () => {
    const adapter = makeShop({ searchMayLandOnProduct: true });
    const wrong = { title: 'Totally Different Fungicide - 78 oz', jsonLd: [ld('Totally Different Fungicide - 78 oz', 20)] };
    const page = fakePage({ pages: { [TERMIDOR_URL]: wrong }, redirects: { [full]: TERMIDOR_URL } });
    const cand = await adapter.fetchCandidate(page, vendor, termidor);
    // base returns the best priced page as the 'unverified' fallback; scanProduct's verifyMatch rejects it
    const { verifyMatch } = require('../services/price-scan/extract');
    expect(cand && verifyMatch({ name: cand.name, text: cand.text, quantity: cand.quantity }, termidor).matched).toBe(false);
  });
});

describe('short-query retry (shortQueryFallback)', () => {
  const longName = 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide';
  const dimension = { productName: 'Dimension 2EW', searchQuery: longName, quantity: '78 oz', packSizeValue: 78, packSizeUnit: 'oz' };
  const dimUrl = `${HOST}/default/dimension-2ew-herbicide-78-oz`;
  const dimPage = { title: 'Dimension 2EW Herbicide - 78 oz', jsonLd: [ld('Dimension 2EW Herbicide - 78 oz', 90)] };

  test('retries ONCE with the first two words and reads the match', async () => {
    const adapter = makeShop({ shortQueryFallback: true });
    const page = fakePage({ pages: { [searchUrlFor('Dimension 2EW')]: { links: [dimUrl] }, [dimUrl]: dimPage } });
    const cand = await adapter.fetchCandidate(page, vendor, dimension);
    expect(cand).toMatchObject({ price: 90, source_url: dimUrl });
    expect(page.calls.goto).toEqual([searchUrlFor(longName), searchUrlFor('Dimension 2EW'), dimUrl]);
  });

  test('no retry when the full query finds links', async () => {
    const adapter = makeShop({ shortQueryFallback: true });
    const page = fakePage({ pages: { [searchUrlFor(longName)]: { links: [dimUrl] }, [dimUrl]: dimPage } });
    await adapter.fetchCandidate(page, vendor, dimension);
    expect(page.calls.goto).toEqual([searchUrlFor(longName), dimUrl]);
  });

  test('a second empty answer ends it: exactly two searches, never a third', async () => {
    const adapter = makeShop({ shortQueryFallback: true });
    const page = fakePage();
    expect(await adapter.fetchCandidate(page, vendor, dimension)).toBeNull();
    expect(page.calls.goto).toEqual([searchUrlFor(longName), searchUrlFor('Dimension 2EW')]);
  });

  test('skipped when the short query equals the full query', async () => {
    const adapter = makeShop({ shortQueryFallback: true });
    const page = fakePage();
    expect(await adapter.fetchCandidate(page, vendor, { productName: 'Snapshot', searchQuery: 'Snapshot TG' })).toBeNull();
    expect(page.calls.goto).toEqual([searchUrlFor('Snapshot TG')]);
  });

  test('not retried when the first search landed on a product page', async () => {
    const adapter = makeShop({ shortQueryFallback: true, searchMayLandOnProduct: true });
    const page = fakePage({ pages: { [dimUrl]: dimPage }, redirects: { [searchUrlFor(longName)]: dimUrl } });
    await adapter.fetchCandidate(page, vendor, dimension);
    expect(page.calls.goto).toEqual([searchUrlFor(longName), dimUrl]);
  });

  test('the short search may itself land on a product page', async () => {
    const adapter = makeShop({ shortQueryFallback: true, searchMayLandOnProduct: true });
    const page = fakePage({ pages: { [dimUrl]: dimPage }, redirects: { [searchUrlFor('Dimension 2EW')]: dimUrl } });
    const cand = await adapter.fetchCandidate(page, vendor, dimension);
    expect(cand.source_url).toBe(dimUrl);
  });

  test('without the flag there is one search only', async () => {
    const adapter = makeShop();
    const page = fakePage();
    await adapter.fetchCandidate(page, vendor, dimension);
    expect(page.calls.goto).toEqual([searchUrlFor(longName)]);
  });
});

describe('Cloudflare bot check -> VENDOR_BLOCKED', () => {
  const full = searchUrlFor('Termidor SC Termiticide Insecticide');
  const blockedPages = (extra = {}) => ({ [full]: { blockTitle: 'Just a moment...', ...extra } });

  test.each([
    ['title', { blockTitle: 'Just a moment...' }],
    ['body text', { blockTitle: 'DoMyOwn', body: 'Performing security verification\nPerformance and Security by Cloudflare' }],
    ['verify-human text', { blockTitle: '', body: 'Please verify you are human' }],
    ['challenge form', { blockTitle: '', form: true }],
  ])('search page blocked (%s): throws at once, no link wait', async (_n, shape) => {
    const adapter = makeShop({ searchWaitMs: 9000 });
    const page = fakePage({ pages: { [full]: shape } });
    const err = await adapter.fetchCandidate(page, vendor, termidor).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VENDOR_BLOCKED');
    expect(err.message).toBe('Shop blocked the scan with a bot check (Cloudflare)');
    expect(page.calls.wait).toEqual([]); // the 9 s DoMyOwn wait is not burned
  });

  test('uses the adapter key when the vendor has no name', async () => {
    const adapter = makeShop();
    const page = fakePage({ pages: blockedPages() });
    await expect(adapter.fetchCandidate(page, { vendor_id: 'v1' }, termidor)).rejects.toThrow('shop blocked the scan with a bot check (Cloudflare)');
  });

  test('a blocked candidate page is not swallowed as one failed candidate', async () => {
    const adapter = makeShop();
    const second = `${HOST}/default/second`;
    const page = fakePage({
      pages: { [full]: { links: [TERMIDOR_URL, second] }, [TERMIDOR_URL]: { blockTitle: 'Just a moment...' }, [second]: TERMIDOR_PAGE },
    });
    const err = await adapter.fetchCandidate(page, vendor, termidor).catch((e) => e);
    expect(err.code).toBe('VENDOR_BLOCKED');
    expect(page.calls.goto).not.toContain(second); // no retry against the check
  });

  test('a blocked direct product URL is reported too', async () => {
    const adapter = makeShop();
    const page = fakePage({ pages: { 'https://shop.example/p': { blockTitle: 'Just a moment...' } } });
    const err = await adapter.fetchCandidate(page, { ...vendor, url: 'https://shop.example/p' }, termidor).catch((e) => e);
    expect(err.code).toBe('VENDOR_BLOCKED');
  });

  test('an ordinary page is not flagged', async () => {
    const adapter = makeShop();
    const page = fakePage({ pages: { [full]: { links: [TERMIDOR_URL] }, [TERMIDOR_URL]: TERMIDOR_PAGE } });
    await expect(adapter.fetchCandidate(page, vendor, termidor)).resolves.toMatchObject({ price: 152.1 });
  });

  test('a page whose signals cannot be read falls through to the normal fetch path', async () => {
    const adapter = makeShop();
    const page = fakePage({ pages: { [full]: { links: [] } } });
    const orig = page.evaluate;
    page.evaluate = async (fn, arg) => { if (fn.name === 'readBotCheckSignals') throw new Error('Execution context was destroyed'); return orig(fn, arg); };
    expect(await adapter.fetchCandidate(page, vendor, termidor)).toBeNull();
  });
});

describe('bot-check breaker (per adapter, per browser context)', () => {
  const full = searchUrlFor('Termidor SC Termiticide Insecticide');
  const pages = { [full]: { blockTitle: 'Just a moment...' } };

  test('the limit is 2', () => {
    expect(BOT_CHECK_BREAKER_LIMIT).toBe(2);
  });

  test('after 2 blocks later calls throw VENDOR_BLOCKED without loading a page', async () => {
    const adapter = makeShop();
    const ctx = {};
    const a = fakePage({ pages, ctx });
    await expect(adapter.fetchCandidate(a, vendor, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    const b = fakePage({ pages, ctx });
    await expect(adapter.fetchCandidate(b, vendor, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    expect(a.calls.goto).toHaveLength(1);
    expect(b.calls.goto).toHaveLength(1); // the 2nd block still loaded the page: that is how it was counted
    const c = fakePage({ pages, ctx });
    const err = await adapter.fetchCandidate(c, vendor, termidor).catch((e) => e);
    expect(err.code).toBe('VENDOR_BLOCKED');
    expect(err.message).toBe('Shop blocked the scan with a bot check (Cloudflare)');
    expect(c.calls.goto).toEqual([]);
    expect(c.calls.wait).toEqual([]);
  });

  test('one block does not trip it', async () => {
    const adapter = makeShop();
    const ctx = {};
    await expect(adapter.fetchCandidate(fakePage({ pages, ctx }), vendor, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    const ok = fakePage({ pages: { [full]: { links: [TERMIDOR_URL] }, [TERMIDOR_URL]: TERMIDOR_PAGE }, ctx });
    await expect(adapter.fetchCandidate(ok, vendor, termidor)).resolves.toMatchObject({ price: 152.1 });
  });

  test('another adapter key in the same context is unaffected', async () => {
    const blocked = makeShop();
    const other = makeShop({ key: 'other' });
    const ctx = {};
    for (let i = 0; i < 2; i += 1) {
      await expect(blocked.fetchCandidate(fakePage({ pages, ctx }), vendor, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    }
    const ok = fakePage({ pages: { [full]: { links: [TERMIDOR_URL] }, [TERMIDOR_URL]: TERMIDOR_PAGE }, ctx });
    await expect(other.fetchCandidate(ok, vendor, termidor)).resolves.toMatchObject({ price: 152.1 });
  });

  test('a new browser context starts clean', async () => {
    const adapter = makeShop();
    const ctx = {};
    for (let i = 0; i < 2; i += 1) {
      await expect(adapter.fetchCandidate(fakePage({ pages, ctx }), vendor, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    }
    const fresh = fakePage({ pages: { [full]: { links: [TERMIDOR_URL] }, [TERMIDOR_URL]: TERMIDOR_PAGE }, ctx: {} });
    await expect(adapter.fetchCandidate(fresh, vendor, termidor)).resolves.toMatchObject({ price: 152.1 });
  });

  test('the breaker fires before login, so a blocked vendor never re-authenticates', async () => {
    const authenticate = jest.fn(async () => {});
    const adapter = makeShop({ authenticate });
    const ctx = { __priceScanBlocked: new Map([['shop', 2]]) };
    const page = fakePage({ pages, ctx });
    await expect(adapter.fetchCandidate(page, { ...vendor, credentials: { username: 'u', password: 'p' } }, termidor)).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});
