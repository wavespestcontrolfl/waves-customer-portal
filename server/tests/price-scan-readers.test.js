// Reader fixes from the 2026-10-05 live scan of 20 lawn-program products:
//   Solutions    no_candidate 20/20  -> the site's WAF 403s a stale "Chrome/124" UA on a newer Chromium
//   DoMyOwn      no results          -> the Rfk search widget reads `w`, not `q`
//   Veseris      fetch_error 20/20   -> sign-in rejected; retries now stop at a rejection (lockout)
//   verifyMatch  accepted wrong fertilizer analyses / wrong brands (Induce for LESCO 90/10 ...)
// Page fixtures in fixtures/price-scan are trimmed copies of the real pages fetched that day.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { collectSnapshot, rankedMatchingLinks } = require('../services/price-scan/adapters/base');
const solutions = require('../services/price-scan/adapters/solutions');
const domyown = require('../services/price-scan/adapters/domyown');
const veseris = require('../services/price-scan/adapters/veseris');
const { desktopUserAgent } = require('../services/price-scan/scanner');
const { analysesIn } = require('../utils/fertilizer-analysis');
const {
  offerFromSnapshot, verifyMatch, namesConflict,
} = require('../services/price-scan/extract');

const FIX = path.join(__dirname, 'fixtures', 'price-scan');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

function snapshotOf(html, config) {
  const dom = new JSDOM(html);
  const prev = global.document;
  global.document = dom.window.document;
  try {
    return collectSnapshot({
      titleSelector: config.titleSelector,
      priceSelectors: config.priceSelectors,
      availabilitySelector: config.availabilitySelector,
      magentoVariants: !!config.magentoVariants,
      optionCardSelector: config.optionCardSelector || null,
    });
  } finally { global.document = prev; }
}

function linksOf(html, config) {
  const doc = new JSDOM(html).window.document;
  const seen = [];
  for (const s of config.productLinkSelectors) {
    for (const a of doc.querySelectorAll(s)) {
      const href = a.getAttribute('href');
      if (href && !seen.includes(href)) seen.push(href);
    }
  }
  return seen;
}

describe('scanner user agent (Solutions WAF)', () => {
  test('carries the major version of the browser actually launched', () => {
    expect(desktopUserAgent('147.0.7727.15')).toMatch(/Chrome\/147\.0\.0\.0 Safari/);
    expect(desktopUserAgent('147.0.7727.15')).not.toMatch(/Headless/);
  });
  test('falls back to a fixed major when the browser version is unknown', () => {
    expect(desktopUserAgent(undefined)).toMatch(/Chrome\/124\.0\.0\.0/);
    expect(desktopUserAgent('weird')).toMatch(/Chrome\/124\.0\.0\.0/);
  });
});

describe('Solutions product page (trimmed real page)', () => {
  test('size-explicit Magento config yields the 10 oz price, not the single-dose packet', () => {
    const snap = snapshotOf(read('solutions-celsius.html'), solutions.config);
    expect(snap.variants.map((v) => v.size).sort()).toEqual(['0.226 Ounce', '10 Ounce']);
    const offer = offerFromSnapshot(snap, { targetOz: 10 });
    expect(offer).toMatchObject({ price: 126.35, quantity: '10 Ounce', fromVariant: true });
  });
});

describe('DoMyOwn search (Rfk widget)', () => {
  test('search URL uses the widget keyword parameter w', () => {
    expect(domyown.config.buildSearchUrl({ productName: 'Celsius WG' }))
      .toBe('https://www.domyown.com/search?w=Celsius%20WG');
    expect(domyown.config.buildSearchUrl({})).toBeNull();
  });
  test('reads product tiles from the rendered results and ranks the exact product first', () => {
    const links = linksOf(read('domyown-search.html'), domyown.config);
    expect(links).toHaveLength(4);
    const ranked = rankedMatchingLinks(links, { productName: 'Celsius WG', quantity: '10 oz' });
    expect(ranked.slice(0, 2)).toContain('https://www.domyown.com/celsius-wg-herbicide-p-1923.html');
    expect(ranked).toEqual(expect.arrayContaining(links));
  });
});

describe('Veseris (B2B login)', () => {
  test('public search tiles are readable with the adapter link selectors', () => {
    const links = linksOf(read('veseris-search.html'), veseris.config);
    expect(links[0]).toBe('https://veseris.com/default/celsius-wg-herbicide-2');
    expect(links).toContain('https://veseris.com/default/celsius-wg-herbicide');
  });

  test('the sign-in form is labelled Username: the username is typed, the email is only a fallback', () => {
    expect(veseris.loginIdentifier({ username: 'acct-user', email: 'a@b.co' })).toBe('acct-user');
    expect(veseris.loginIdentifier({ username: null, email: 'a@b.co' })).toBe('a@b.co');
    expect(veseris.loginIdentifier({})).toBe('');
  });

  // A page double that answers like Magento does for a bad sign-in: the form posts, the
  // login page comes back carrying the error banner.
  function rejectedLoginPage() {
    const calls = { goto: 0 };
    const el = {
      first() { return el; },
      waitFor: async () => {},
      press: async () => {},
      click: async () => {},
      count: async () => 1,
      textContent: async () => 'The account sign-in was incorrect or your account is disabled temporarily.',
    };
    const page = {
      calls,
      goto: async () => { calls.goto += 1; },
      url: () => 'https://veseris.com/default/customer/account/login/',
      locator: () => el,
      evaluate: async () => 'ok',
      waitForFunction: async () => ({ jsonValue: async () => 'rejected' }),
      waitForTimeout: async () => {},
    };
    return page;
  }

  test('a rejected sign-in is reported once and never retried (each retry counts toward lockout)', async () => {
    const page = rejectedLoginPage();
    await expect(veseris.config.authenticate(page, { username: 'u', password: 'p' }))
      .rejects.toThrow(/veseris login rejected: The account sign-in was incorrect/);
    expect(page.calls.goto).toBe(1);
  });

  test('a stalled sign-in (no banner, still on the login page) is retried up to three times', async () => {
    const page = rejectedLoginPage();
    page.waitForFunction = async () => ({ jsonValue: async () => 'timeout' });
    await expect(veseris.config.authenticate(page, { username: 'u', password: 'p' }))
      .rejects.toThrow(/veseris login failed/);
    expect(page.calls.goto).toBe(3);
  });
});

describe('verifyMatch product identity (2026-10-05 false positives)', () => {
  const NO_EPA = { text: '' };
  const accepts = (scrapedName, expectedName, quantity) => verifyMatch(
    { name: scrapedName, quantity, ...NO_EPA },
    { productName: expectedName, quantity },
  ).matched;

  test('SeedBarn LESCO Stonewall 0-0-7 is not the 15-0-15 fertilizer', () => {
    expect(accepts(
      'LESCO Stonewall 0.43% 0-0-7 AM Pre-Emergent Granular Herbicide Plus Fertilizer 50 lb. Bag',
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
      '50 lb',
    )).toBe(false);
    expect(accepts(
      'LESCO Fertilizer/Herbicide Pre Emergent Stonewall 0.43% 0-0-8 Mini - 50 lb.',
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
      '50 lb',
    )).toBe(false);
  });

  test('the same analysis still verifies, whatever the coating percentage', () => {
    expect(accepts(
      'Lesco Fertilizer Granular 24-0-11 - 50% PolyPlus AS 1%Fe 0.4%Mn - 50 lbs.',
      'LESCO 24-0-11 with PolyPlus OPTI',
      '50 lb',
    )).toBe(true);
    expect(accepts(
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer 50 lb',
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
      '50 lb',
    )).toBe(true);
  });

  test('separator variants of the same analysis still verify (en dash, spaced dash, slashes)', () => {
    const expected = 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer';
    for (const analysis of ['15\u20130\u201315', '15 - 0 - 15', '15 / 0 / 15', '15/0/15']) {
      expect(accepts(`LESCO Stonewall 0.43% ${analysis} 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer 50 lb`, expected, '50 lb')).toBe(true);
    }
    expect(accepts('LESCO Stonewall 0.43% 0\u20130\u20137 AM Pre-Emergent Plus Fertilizer 50 lb', expected, '50 lb')).toBe(false);
    expect(accepts('LESCO Stonewall 0.43% 0 / 0 / 7 AM Pre-Emergent Plus Fertilizer 50 lb', expected, '50 lb')).toBe(false);
  });

  test('an analysis on only one side is not a conflict: catalog aliases drop it', () => {
    // migration 20260712000051: "LESCO 12-0-0 Chelated Iron Plus" is the keeper "LESCO Chelated Iron Plus"
    expect(accepts('LESCO 12-0-0 Chelated Iron Plus 2.5 gal', 'LESCO Chelated Iron Plus', '2.5 gal')).toBe(true);
    expect(accepts('LESCO Chelated Iron Plus 2.5 gal', 'LESCO 12-0-0 Chelated Iron Plus', '2.5 gal')).toBe(true);
    // ...but the rest of the name check still decides
    expect(accepts('Acme Plus Stabilizer 12-0-0 2.5 gal', 'LESCO Chelated Iron Plus', '2.5 gal')).toBe(false);
  });

  test('Induce is not LESCO 90/10 Nonionic Surfactant', () => {
    expect(accepts('Induce Nonionic Surfactant jug (2.5 gal)', 'LESCO 90/10 Nonionic Surfactant', '2.5 gal')).toBe(false);
  });

  test('Soaker Plus is not LESCO-Wet Plus; the real LESCO Wet Plus listing still verifies', () => {
    expect(accepts('Soaker Plus Wetting Agent jug (2.5 gal)', 'LESCO-Wet Plus Nonionic Wetting Agent', '2.5 gal')).toBe(false);
    expect(accepts('LESCO Wet Plus Liquid Wetting Agent - 2.5 Gallon', 'LESCO-Wet Plus Nonionic Wetting Agent', '2.5 gal')).toBe(true);
  });

  test('ordinary listings with extra vendor words and the maker still verify', () => {
    expect(accepts('Celsius WG Herbicide, Bayer', 'Celsius WG', '10 oz')).toBe(true);
    expect(accepts('Velista WDG Turf Fungicide, Syngenta', 'Velista', '22 oz')).toBe(true);
    expect(accepts('Acelepryn SC Insecticide bottle (64 oz)', 'Acelepryn Insecticide', '64 oz')).toBe(true);
    expect(accepts('Arena S.E. 50 WDG Granular Insecticide - 2.5 lbs.', 'Arena 50 WDG', '2.5 lb')).toBe(true);
  });

  test('an EPA registration in the page text can still verify a differently branded listing', () => {
    const verdict = verifyMatch(
      { name: 'Induce Nonionic Surfactant jug (2.5 gal)', quantity: '2.5 gal', text: 'EPA Reg. No. 53883-279' },
      { productName: 'LESCO 90/10 Nonionic Surfactant', quantity: '2.5 gal', epaReg: '53883-279' },
    );
    expect(verdict.signals.name).toBe(false);
    expect(verdict.matched).toBe(true); // EPA identity, not name overlap
  });

  describe('analysesIn (shared with the procurement matcher)', () => {
    test('reads N-P-K analyses across separators and dash styles', () => {
      expect(analysesIn('Lesco 24-0-11 and 12-0-0.5 blend')).toEqual(['24-0-11', '12-0-0.5']);
      expect(analysesIn('Stonewall 0.43% 15\u20130\u201315 50%')).toEqual(['15-0-15']);
      expect(analysesIn('Stonewall 15 / 0 / 15')).toEqual(['15-0-15']);
    });
    test('ignores EPA registrations, mixed numbers, cued dates and plain sizes', () => {
      expect(analysesIn('EPA Reg 55260-1-12345')).toEqual([]);
      expect(analysesIn('Taurus SC 1-1/2 gal')).toEqual([]);
      expect(analysesIn('buy by 9/27/26')).toEqual([]);
      expect(analysesIn('Talstar P 1-gal')).toEqual([]);
    });
  });

  describe('namesConflict', () => {
    test('sees an analysis kept only in the catalog productName', () => {
      expect(namesConflict('LESCO Stonewall 0-0-7', ['LESCO Stonewall', 'LESCO Stonewall 15-0-15 Plus Fertilizer'])).toBe(true);
      expect(namesConflict('LESCO Stonewall 15-0-15', ['LESCO Stonewall', 'LESCO Stonewall 15-0-15 Plus Fertilizer'])).toBe(false);
      expect(namesConflict('LESCO Stonewall 15-0-15', ['LESCO Stonewall Plus Fertilizer'])).toBe(false); // one side only
    });
    test('needs a shared brand token only when both sides have brand tokens', () => {
      expect(namesConflict('Soaker Plus Wetting Agent', 'LESCO-Wet Plus Nonionic Wetting Agent')).toBe(true);
      expect(namesConflict('Wetting Agent jug (2.5 gal)', 'LESCO-Wet Plus Nonionic Wetting Agent')).toBe(false);
    });
  });
});
