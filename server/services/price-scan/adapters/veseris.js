/* global document, location */ // page.evaluate / waitForFunction callbacks run in the browser, not Node
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

// Magento's wrong-password / locked-account banner on the login page.
const LOGIN_ERROR_SELECTOR = '.message-error, div.message.error, [data-ui-id$="message-error"]';

// The Veseris sign-in form is labelled "Username" ("If you have an account, sign in with your
// username"), NOT email. The vendor row can carry both a login_username and a login_email
// (often the account's contact address), and typing the email into that field is rejected as
// "account sign-in was incorrect". So the username wins; the email is only the fallback for a
// row that stores nothing else. PURE.
function loginIdentifier(creds) {
  return (creds && (creds.username || creds.email)) || '';
}

// SECURITY: the login URL is stored vendor data, and we type the decrypted password into the
// page it loads. Only ever do that on HTTPS + a Veseris-owned host — a bad/tampered login_url
// with matching login[username]/login[password] fields would otherwise exfiltrate the password.
function isTrustedVeserisLoginUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    return h === 'veseris.com' || h.endsWith('.veseris.com');
  } catch (e) {
    return false;
  }
}

const adapter = makeAdapter({
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
    const loginUrl = creds.loginUrl || DEFAULT_LOGIN_URL;
    // Fail CLOSED before typing the password anywhere off a trusted Veseris host.
    if (!isTrustedVeserisLoginUrl(loginUrl)) {
      throw new Error('veseris login aborted: login URL is not an https veseris.com host');
    }
    const attempt = async () => {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
      // Re-validate the LANDED host: goto follows redirects, and we type the password into
      // whatever page loaded — an open redirect / tampered URL could bounce off-host. Never
      // fill credentials unless we're still on a trusted Veseris host.
      if (!isTrustedVeserisLoginUrl(page.url())) {
        throw new Error('veseris login aborted: navigation redirected off the trusted host');
      }
      const pass = page.locator('input[name="login[password]"]:visible').first();
      await page.locator('input[name="login[username]"]:visible').first().waitFor({ state: 'visible', timeout: 30000 });
      // Validate the host AND write BOTH credentials in ONE page-context execution — no await
      // between the check and the writes, so there is no window for a delayed redirect to slip
      // the password onto a foreign page (a check-then-await-fill is racy: Playwright locators
      // are live across navigations and each awaited fill is another navigation point). The
      // trusted-host predicate is inlined to match isTrustedVeserisLoginUrl.
      const filled = await page.evaluate(({ user, pw }) => {
        const h = location.hostname.toLowerCase();
        if (location.protocol !== 'https:' || !(h === 'veseris.com' || h.endsWith('.veseris.com'))) return 'offhost';
        const u = document.querySelector('input[name="login[username]"]');
        const p = document.querySelector('input[name="login[password]"]');
        if (!u || !p) return 'nofields';
        for (const [el, v] of [[u, user], [p, pw]]) {
          el.focus();
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return 'ok';
      }, { user: loginIdentifier(creds), pw: creds.password });
      if (filled !== 'ok') {
        throw new Error(`veseris login aborted: ${filled === 'offhost' ? 'navigation redirected off the trusted host' : 'login fields not found'}`);
      }
      const submit = page.locator(
        'form:has(input[name="login[password]"]) button[type="submit"]:visible, form:has(input[name="login[password]"]) button:visible',
      ).first();
      await submit.click().catch(() => pass.press('Enter'));
      // Wait for the OAuth login to FULLY settle into the priced/registered session: password
      // field gone, off the login page, AND past the transient code-exchange state. Veseris
      // redirects through `?code=...&userState=AuthenticatedNotRegistered` while it finalizes
      // the session — and shows $0.00 prices until it does — so proceeding then yields a
      // gated, unpriced scrape. Wait for that transient marker to clear. ALSO stop early when
      // Magento answers with its error banner: a rejected sign-in must be reported at once,
      // not waited out (45 s) and retried — every retry is another failed attempt on a
      // lockout-protected account.
      const settled = await page.waitForFunction((errSel) => {
        const pw = document.querySelector('input[name="login[password]"]');
        const transient = /[?&]code=|AuthenticatedNotRegistered/i.test(location.href);
        if ((!pw || !pw.offsetParent) && !/customer\/account\/login/i.test(location.href) && !transient) return 'ok';
        const err = document.querySelector(errSel);
        if (err && (err.textContent || '').trim()) return 'rejected';
        return false;
      }, LOGIN_ERROR_SELECTOR, { timeout: LOGIN_TIMEOUT }).then((h) => h.jsonValue()).catch(() => 'timeout');
      if (settled === 'rejected') return 'rejected';
      await page.waitForTimeout(2000);
      const stillPw = await page.locator('input[name="login[password]"]:visible').count();
      // Success requires the SAME conditions as the wait predicate (its timeout is swallowed,
      // so re-check here): password form gone, off the login page, AND past the transient
      // OAuth state (?code= mid-exchange or AuthenticatedNotRegistered). Otherwise a stalled
      // exchange would be marked logged-in and the first scan would hit the gated/$0 session.
      const url = page.url();
      const transient = /[?&]code=|AuthenticatedNotRegistered/i.test(url);
      const onLoginPage = /customer\/account\/login/i.test(url);
      return stillPw === 0 && !transient && !onLoginPage ? 'ok' : 'stalled';
    };
    // Retry only a STALLED login (transient redirect / rate-limit). A REJECTED one (wrong
    // username or password, or a temporarily locked account) is final: retrying cannot fix it
    // and each try counts toward Magento's failed-login lockout.
    let outcome = 'stalled';
    for (let i = 0; i < 3 && outcome === 'stalled'; i += 1) {
      if (i) await page.waitForTimeout(3000); // brief cooldown between attempts
      outcome = await attempt();
    }
    if (outcome !== 'ok') {
      const err = (await page.locator(LOGIN_ERROR_SELECTOR).first().textContent().catch(() => '') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`veseris login ${outcome === 'rejected' ? 'rejected' : 'failed'}${err ? `: ${err}` : ''}`);
    }
  },
});

// Exposed for unit testing the login-URL host guard.
adapter.isTrustedVeserisLoginUrl = isTrustedVeserisLoginUrl;
adapter.loginIdentifier = loginIdentifier;
module.exports = adapter;
