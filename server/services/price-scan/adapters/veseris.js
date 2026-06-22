// Veseris (veseris.com) — professional pest/turf distributor, a DIRECT SiteOne competitor.
// Magento storefront (same platform as Solutions), but pricing is behind a B2B LOGIN, so
// this adapter authenticates first and then scrapes ACCOUNT pricing. Credentials live
// encrypted on the vendor row (services/vendor-credentials.js) and are passed in as
// vendor.credentials by the caller; base.js logs in ONCE per browser context.
//
// Scraping reuses the Magento path: configurable products expose size+price in jsonConfig
// (magentoVariants), single-size products fall to JSON-LD / DOM price.
const { makeAdapter, searchQuery } = require('./base');

const DEFAULT_LOGIN_URL = 'https://veseris.com/default/customer/account/login/';

module.exports = makeAdapter({
  key: 'veseris',
  priceType: 'account', // logged-in account pricing, not public list price
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://veseris.com/default/catalogsearch/result/?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: ['.product-item-link', '.product-item-info a.product', '.products a.product-item-link'],
  searchWaitMs: 8000, // Veseris search results render a beat after load — wait for the links
  settleMs: 1500, // and let the product page's price paint before snapshotting
  titleSelector: 'h1.page-title .base, h1.page-title, h1[itemprop="name"], h1',
  priceSelectors: ['[data-price-type="finalPrice"] .price', '[itemprop="price"]', '.price-wrapper .price', '.price'],
  availabilitySelector: '[itemprop="availability"], .stock.available, .stock.unavailable, .availability',
  magentoVariants: true, // configurable products carry size+price in Magento jsonConfig

  // Log in to the Magento storefront. The VISIBLE form uses login[username]/login[password]
  // (there's a hidden header mini-login with #customer-email — don't target that). Veseris
  // resolves login via an OAuth redirect chain (?code=...), which is slow + a bit flaky, so
  // we wait for the redirect to actually RESOLVE (password field gone AND off the login URL)
  // rather than a fixed pause, and retry once. Throws on failure so base.js never scrapes an
  // unauthenticated (list-price / gated) session.
  authenticate: async (page, creds) => {
    const LOGIN_TIMEOUT = 45000;
    const attempt = async () => {
      await page.goto(creds.loginUrl || DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
      const email = page.locator('input[name="login[username]"]:visible').first();
      const pass = page.locator('input[name="login[password]"]:visible').first();
      await email.waitFor({ state: 'visible', timeout: 30000 });
      await email.fill(creds.email || creds.username);
      await pass.fill(creds.password);
      const submit = page.locator(
        'form:has(input[name="login[password]"]) button[type="submit"]:visible, form:has(input[name="login[password]"]) button:visible',
      ).first();
      await submit.click().catch(() => pass.press('Enter'));
      // Wait for the OAuth login to FULLY settle into the priced/registered session: password
      // field gone, off the login page, AND past the transient code-exchange state. Veseris
      // redirects through `?code=...&userState=AuthenticatedNotRegistered` while it finalizes
      // the session — and shows $0.00 prices until it does — so proceeding then yields a
      // gated, unpriced scrape. Wait for that transient marker to clear.
      await page.waitForFunction(() => {
        const pw = document.querySelector('input[name="login[password]"]');
        const transient = /[?&]code=|AuthenticatedNotRegistered/i.test(location.href);
        return (!pw || !pw.offsetParent) && !/customer\/account\/login/i.test(location.href) && !transient;
      }, { timeout: LOGIN_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(2000);
      const stillPw = await page.locator('input[name="login[password]"]:visible').count();
      // Not logged in if the form remains, or we're stuck in the unregistered (unpriced) state.
      return stillPw === 0 && !/AuthenticatedNotRegistered/i.test(page.url());
    };
    let ok = false;
    for (let i = 0; i < 3 && !ok; i += 1) {
      if (i) await page.waitForTimeout(3000); // brief cooldown between attempts (transient redirect / rate-limit)
      ok = await attempt();
    }
    if (!ok) {
      const err = (await page.locator('.message-error, div.message.error').first().textContent().catch(() => '') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new Error(`veseris login failed${err ? `: ${err}` : ''}`);
    }
  },
});
