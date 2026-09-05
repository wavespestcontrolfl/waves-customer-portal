/**
 * procurement/adapters — Sticker Mule reorder API + SiteOne bot internals.
 *
 * Sticker Mule contract:
 *   - bindingQuote = the account's latest single-item order of this item at this
 *     exact quantity (vendor total); no match / unreadable shape → null
 *   - no API key → RefusedError no_api_key before any call
 *   - item not on the account / ≠1 address / ≠1 payment → RefusedError, NO POST
 *   - POST failure / missing number → err.ambiguous (never re-POSTed)
 *   - success → order number + the vendor's read-back total (quote fallback)
 * SiteOne internals: trusted-host guard, allowlist parsing, money parsing,
 * and the SELECTORS map is the only place selectors live.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const sm = require('../services/procurement/adapters/stickermule');

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const r = routes[`${init.method} ${path}`];
    if (typeof r === 'function') return r();
    const status = r?.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r?.body ?? r ?? {}) };
  });
  return { fetchImpl, calls };
}

const happy = () => ({
  'GET /api/items': { items: [{ id: 4242, name: 'Serviced by Waves 4x5' }] },
  'GET /api/addresses': { addresses: [{ id: 'addr-1' }] },
  'GET /api/payments': { payments: [{ id: 'pay-1' }] },
  'POST /api/orders': { order: { number: 'SM-90001' } },
  'GET /api/orders': { orders: [{ number: 'SM-90001', total: '318.40' }] },
});

beforeEach(() => { process.env.STICKERMULE_API_KEY = 'test-key'; });
afterAll(() => { delete process.env.STICKERMULE_API_KEY; });

test('bindingQuote = the latest identical single-item order on the account, vendor total', async () => {
  const orders = { orders: [
    { number: 'SM-1', total: '318.40', createdAt: '2026-07-01T00:00:00Z', items: [{ id: 4242, quantity: 500 }] },
    { number: 'SM-2', total: '322.10', createdAt: '2026-08-01T00:00:00Z', items: [{ id: 4242, quantity: 500 }] },
    { number: 'SM-3', total: '600.00', createdAt: '2026-08-15T00:00:00Z', items: [{ id: 4242, quantity: 500 }, { id: 9, quantity: 1 }] },
    { number: 'SM-4', total: '520.00', createdAt: '2026-08-20T00:00:00Z', items: [{ id: 4242, quantity: 1000 }] },
  ] };
  const { fetchImpl, calls } = fakeFetch({ 'GET /api/orders': orders });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).toEqual({ cents: 32210, source: 'order SM-2' });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 1000 }, { fetchImpl })).toEqual({ cents: 52000, source: 'order SM-4' });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 300 }, { fetchImpl })).toBeNull();
  expect(await sm.bindingQuote({ vendorSku: '9999', quantity: 500 }, { fetchImpl })).toBeNull();
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 500 }, { fetchImpl: fakeFetch({ 'GET /api/orders': { orders: [{ number: 'X', total: '100', lines: [] }] } }).fetchImpl })).toBeNull();
});

test('no API key → refused before any call', async () => {
  delete process.env.STICKERMULE_API_KEY;
  const { fetchImpl } = fakeFetch(happy());
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ refuse: 'no_api_key' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('places a reorder: bearer auth, one item, the single address + payment, vendor total read back', async () => {
  const { fetchImpl, calls } = fakeFetch(happy());
  const r = await sm.place({ vendorSku: '4242', quantity: 500, quoteCents: 31400 }, { fetchImpl });
  expect(r.externalOrderNumber).toBe('SM-90001');
  expect(r.amountCents).toBe(31840);
  expect(r.evidence).toMatchObject({ itemId: 4242, addressId: 'addr-1', paymentId: 'pay-1', totalSource: 'vendor' });
  const post = calls.find((c) => c.method === 'POST');
  expect(post.body).toEqual({ items: [{ id: 4242, quantity: 500 }], addressId: 'addr-1', paymentId: 'pay-1' });
  expect(post.auth).toBe('Bearer test-key');
});

test('item not on the account → refused, no POST', async () => {
  const { fetchImpl, calls } = fakeFetch(happy());
  await expect(sm.place({ vendorSku: '9999', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ refuse: 'item_not_found' });
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});

test('two addresses or two payment methods → refused, no POST', async () => {
  const twoAddr = { ...happy(), 'GET /api/addresses': { addresses: [{ id: 'a' }, { id: 'b' }] } };
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl: fakeFetch(twoAddr).fetchImpl })).rejects.toMatchObject({ refuse: 'multiple_addresses' });
  const noPay = { ...happy(), 'GET /api/payments': { payments: [] } };
  const f = fakeFetch(noPay);
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl: f.fetchImpl })).rejects.toMatchObject({ refuse: 'no_payment' });
  expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
});

test('a failing POST is ambiguous — surfaced, never repeated', async () => {
  const { fetchImpl, calls } = fakeFetch({ ...happy(), 'POST /api/orders': { status: 504, body: { message: 'upstream timeout' } } });
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ ambiguous: true, status: 504 });
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
});

test('a POST that returns no order number is ambiguous', async () => {
  const { fetchImpl } = fakeFetch({ ...happy(), 'POST /api/orders': { ok: true } });
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ ambiguous: true });
});

test('a failed read-back keeps the order and falls back to the quote', async () => {
  const { fetchImpl } = fakeFetch({ ...happy(), 'GET /api/orders': { status: 500 } });
  const r = await sm.place({ vendorSku: '4242', quantity: 500, quoteCents: 31400 }, { fetchImpl });
  expect(r.externalOrderNumber).toBe('SM-90001');
  expect(r.amountCents).toBe(31400);
  expect(r.evidence.totalSource).toBe('quote');
});

describe('siteone internals', () => {
  const s1 = require('../services/procurement/adapters/siteone');
  const { isTrustedSiteOneUrl, allowedHosts, parseMoney, normalizeSku, SELECTORS } = s1._internals;

  test('SKU match is exact after label/whitespace/case normalization; empty never matches', () => {
    expect(normalizeSku('SKU: 123-ABC ')).toBe('123-ABC');
    expect(normalizeSku('Item # 123 abc')).toBe('123ABC');
    expect(normalizeSku('123-ABC') === normalizeSku(' sku:123-abc')).toBe(true);
    expect(normalizeSku('123-ABC') === normalizeSku('123-ABCD')).toBe(false);
    expect(normalizeSku('')).toBe('');
  });

  test('trusted host = https + siteone.com or a subdomain', () => {
    expect(isTrustedSiteOneUrl('https://www.siteone.com/en/login')).toBe(true);
    expect(isTrustedSiteOneUrl('https://siteone.com/')).toBe(true);
    expect(isTrustedSiteOneUrl('http://www.siteone.com/en/login')).toBe(false);
    expect(isTrustedSiteOneUrl('https://siteone.com.evil.example/')).toBe(false);
    expect(isTrustedSiteOneUrl('https://notsiteone.com/')).toBe(false);
    expect(isTrustedSiteOneUrl('garbage')).toBe(false);
  });

  test('allowlist = siteone hosts + SITEONE_BOT_ALLOWED_HOSTS (csv, lowercased, deduped)', () => {
    expect(allowedHosts({})).toEqual(['siteone.com', 'www.siteone.com']);
    expect(allowedHosts({ SITEONE_BOT_ALLOWED_HOSTS: ' CDN.siteone.com, static.example.net,,www.siteone.com ' })).toEqual(['siteone.com', 'www.siteone.com', 'cdn.siteone.com', 'static.example.net']);
  });

  test('cart total parses to cents', () => {
    expect(parseMoney('Order total: $1,234.56')).toBe(123456);
    expect(parseMoney('$99')).toBe(9900);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('$0.00')).toBeNull();
    // exactly ONE $ amount, or nothing (pre-push P0): a count before the total, or two amounts, never cap-check as the wrong figure
    expect(parseMoney('2 items · Total $105.93')).toBe(10593);
    expect(parseMoney('2 items · Total 105.93')).toBeNull();
    expect(parseMoney('Subtotal $99.00 Total $105.93')).toBeNull();
  });

  test('missing credentials / account number / sku refuse before any browser work', async () => {
    const launchBrowser = jest.fn();
    await expect(s1.place({ vendorSku: 'X', quantity: 1, credentials: null }, { launchBrowser })).rejects.toMatchObject({ refuse: 'no_credentials' });
    await expect(s1.place({ vendorSku: 'X', quantity: 1, credentials: { email: 'a', password: 'b' } }, { launchBrowser })).rejects.toMatchObject({ refuse: 'no_account_number' });
    await expect(s1.place({ vendorSku: null, quantity: 1, credentials: { email: 'a', password: 'b', accountNumber: '1' } }, { launchBrowser })).rejects.toMatchObject({ refuse: 'no_sku' });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  test('no playwright → run-level error (claim released, batch aborts)', async () => {
    await expect(s1.place({ vendorSku: 'X', quantity: 1, credentials: { email: 'a', password: 'b', accountNumber: '1' } }, { launchBrowser: null })).rejects.toMatchObject({ runLevel: true });
  });

  test('www.siteone.com not resolving public → run-level, no launch', async () => {
    const launchBrowser = jest.fn();
    await expect(s1.place({ vendorSku: 'X', quantity: 1, credentials: { email: 'a', password: 'b', accountNumber: '1' }, approvedShipTo: '1 x' }, { launchBrowser, resolveHostIps: async () => [] })).rejects.toMatchObject({ runLevel: true });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  test('context / page setup failing after launch → run-level (claim released, not parked), Chromium closed (Codex r6 P2)', async () => {
    const browser = { newContext: async () => { throw new Error('context boom'); }, close: jest.fn(async () => {}) };
    const deps = { launchBrowser: async () => browser, resolveHostIps: async () => ['203.0.113.10'] };
    await expect(s1.place({ vendorSku: 'X', quantity: 1, credentials: { email: 'a', password: 'b', accountNumber: '1' }, approvedShipTo: '1 x' }, deps)).rejects.toMatchObject({ runLevel: true, message: expect.stringMatching(/browser setup failed: context boom/) });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('egress permits https on a pinned host only — http to the pinned host is denied before credentials could travel (PR3 r1 P1)', () => {
    const pinned = new Set(['www.siteone.com', 'siteone.com']);
    expect(s1._internals.requestPermitted('https://www.siteone.com/en/login', pinned)).toBe(true);
    expect(s1._internals.requestPermitted('http://www.siteone.com/en/login', pinned)).toBe(false);
    expect(s1._internals.requestPermitted('https://evil.example.com/x', pinned)).toBe(false);
    expect(s1._internals.requestPermitted(undefined, pinned)).toBe(false);
  });

  test('the login fill binds both fields to the ONE visible password form — a newsletter email input ahead of it is never the username; two visible forms abort (r15 P1)', () => {
    const { fillLoginForm, SELECTORS: S } = s1._internals;
    const field = (name, extra = {}) => ({ name, value: '', events: [], focus() {}, dispatchEvent(e) { this.events.push(e.type); }, offsetParent: {}, ...extra });
    // The form's username lookup returns every match in document order: a hidden honeypot email input sits AHEAD of the visible username (r19 P1)
    const mkForm = (action, fields) => ({ getAttribute: () => action, querySelectorAll: () => fields.users || [] });
    const pw = field('password'); const user = field('username');
    const honeypot = field('email', { offsetParent: null });
    const form = mkForm('/login', { users: [honeypot, user] }); pw.form = form; user.form = form;
    const newsletter = field('email');
    const hiddenPw = field('password', { offsetParent: null });
    global.location = { hostname: 'www.siteone.com', protocol: 'https:', href: 'https://www.siteone.com/en/login' };
    global.document = { querySelectorAll: (sel) => (sel === S.loginPass ? [hiddenPw, pw] : [newsletter, user]) };
    global.Event = class { constructor(type) { this.type = type; } };
    try {
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('ok');
      expect(user.value).toBe('u@x'); expect(pw.value).toBe('p');
      expect(newsletter.value).toBe(''); // the document-wide first email input is untouched
      expect(honeypot.value).toBe(''); // the form's hidden first username match is untouched (r19 P1)
      const user2 = field('username', { form }); form.querySelectorAll = () => [user, user2];
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('ambiguousform'); // two visible username fields in the form
      form.querySelectorAll = () => [honeypot, user];
      const pw2 = field('password', { form }); global.document.querySelectorAll = (sel) => (sel === S.loginPass ? [pw, pw2] : [user]);
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('ambiguousform');
      const orphan = field('password'); orphan.form = mkForm('/login', {}); global.document.querySelectorAll = (sel) => (sel === S.loginPass ? [orphan] : []);
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('nofields');
    } finally { delete global.location; delete global.document; delete global.Event; }
  });

  test('every selector lives in the frozen SELECTORS map', () => {
    expect(Object.isFrozen(SELECTORS)).toBe(true);
    for (const k of ['loginUser', 'loginPass', 'searchInput', 'qtyInput', 'addToCart', 'cartTotal']) expect(typeof SELECTORS[k]).toBe('string');
  });
});

// A minimal fake Playwright page driven by the SELECTORS map: enough surface
// for place() to walk login → cart reset → add → verify → checkout → submit.
describe('siteone bot cart + tender rules (fake page)', () => {
  const s1 = require('../services/procurement/adapters/siteone');
  const S = s1._internals.SELECTORS;

  function fakeSiteOne(opts = {}) {
    const st = { cart: [], removable: true, url: 'https://www.siteone.com/en/login', loggedIn: false, addClicked: 0, qty: null, ...opts };
    const el = (spec = {}) => ({
      count: async () => spec.count ?? 0,
      evaluate: async (fn) => fn({ tagName: (spec.tag || 'input').toUpperCase(), id: spec.id || '', name: spec.name || '', value: spec.value ?? '' }),
      getAttribute: async (n) => (spec.attrs ? spec.attrs[n] ?? null : null),
      first() { return this; },
      nth: (i) => spec.nth ? spec.nth(i) : el(spec),
      textContent: async () => spec.text ?? null,
      inputValue: async () => { if (spec.value == null) throw new Error('not an input'); return String(spec.value); },
      isVisible: async () => !!spec.visible,
      isChecked: async () => { if (spec.checked == null) throw new Error('n/a'); return spec.checked; },
      click: async () => { if (spec.onClick) await spec.onClick(); },
      fill: async (v) => { if (spec.onFill) spec.onFill(v); },
      press: async (key) => { if (spec.onPress) await spec.onPress(key); },
      waitFor: async () => {},
      locator: (sub) => (spec.sub ? spec.sub(sub) : el()),
    });
    // cartRowChildrenHiddenFirst: inside a visible row, a hidden stale SKU / quantity copy precedes the shown one (r20 P2)
    const child = (spec) => (st.cartRowChildrenHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: 'STALE-9', value: 9 }) : el({ count: 1, visible: true, ...spec })) }) : el({ count: 1, visible: true, ...spec }));
    // cartSkuInAttribute: the row's SKU node carries the code in data-product-code and shows unrelated text (r21 P2)
    const line = (l) => el({ count: 1, visible: true, sub: (sub) => sub === S.cartLineSku ? child(st.cartSkuInAttribute ? { text: 'Remove', attrs: { 'data-product-code': l.sku } } : { text: l.sku }) : sub === S.cartLineQty ? child({ value: l.qty }) : el() });
    const resolve = (sel) => {
      // loginPassHiddenAfterLogin: a hidden responsive duplicate of the password input survives a successful sign-in
      // The visible password field's own form carries the real submit control (formSubmitCount: 0 = none → Enter submits);
      // a document-wide loginSubmit read is what a hidden responsive login form ahead of the visible one would poison.
      // loginClickThrows: the submit click's promise rejects — 'unsent' before anything posted, 'sent' after the credential went out (a slow navigation)
      const submit = el({ count: 1, visible: true, onClick: () => { if (st.loginClickThrows === 'unsent') throw new Error('locator.click: Target closed'); st.loginSubmits = (st.loginSubmits || 0) + 1; if (st.loginClickThrows === 'sent') { st.loggedIn = true; st.url = 'https://www.siteone.com/en/'; throw new Error('locator.click: Navigation interrupted'); } if (st.loginRejects) return; st.loggedIn = true; st.url = 'https://www.siteone.com/en/'; } });
      // Models Playwright's descendant matching from the form: a selector that itself starts with `form` would
      // look for a NESTED form and miss the button (r18 P1) — only a form-relative control selector resolves it.
      const loginForm = el({ count: 1, sub: (sub) => (sub === S.loginSubmit && !/^\s*form\b/.test(sub) ? (st.formSubmitCount === 0 ? el() : submit) : el()) });
      const passField = el({ count: 1, visible: true, sub: (sub) => (sub === 'xpath=ancestor::form[1]' ? loginForm : el()), onPress: async (key) => { st.pressed = [...(st.pressed || []), key]; if (key === 'Enter') await submit.click(); } });
      if (sel === S.loginPass) return st.loggedIn ? (st.loginPassHiddenAfterLogin ? el({ count: 1, visible: false }) : el()) : passField;
      if (sel === S.loginSubmit) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenSubmitClicked = (st.hiddenSubmitClicked || 0) + 1; } }) : submit) });
      if (sel === S.loginError) return el();
      // The signed-in account page shows the sign-out link; noAccountMarker models an intermediate (MFA / maintenance) page (r22 P1)
      // accountMarkerOnLoginPage: the unauthenticated login page's header carries a generic account link (r24 P1)
      if (sel === S.accountMarker) return (st.loggedIn && !st.noAccountMarker) || st.accountMarkerOnLoginPage ? el({ count: 1, visible: true }) : el();
      if (sel === S.searchInput) return el({ count: 1, visible: true });
      // productLinkHiddenFirst: a hidden responsive copy of the result link precedes the visible one
      const hitLink = el({ count: 1, visible: true, onClick: () => { st.hitClicked = (st.hitClicked || 0) + 1; } });
      if (sel === S.productLink) return st.productLinkHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenControlClicked = (st.hiddenControlClicked || 0) + 1; } }) : hitLink) }) : hitLink;
      // productSkuInAttribute: the matched node carries the code in data-product-code and shows unrelated text
      if (sel === S.productSku) return st.productSkuInAttribute ? el({ count: 1, visible: true, text: 'Add to list', attrs: { 'data-product-code': 'S1-77' } }) : el({ count: 1, visible: true, text: 'SKU: S1-77' });
      if (sel === S.unavailable) return el();
      // productControlsHiddenFirst: hidden desktop/mobile copies of the quantity + Add to Cart controls precede the visible ones
      const qtyInput = el({ count: 1, visible: true, onFill: (v) => { st.qty = Number(v); } });
      const addToCart = el({ count: 1, visible: true, onClick: () => { st.addClicked += 1; st.cart.push({ sku: 'S1-77', qty: st.qty }); if (st.addExtra) st.cart.push(st.addExtra); } });
      const hiddenCopy = (target) => el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenControlClicked = (st.hiddenControlClicked || 0) + 1; }, onFill: () => { st.hiddenControlClicked = (st.hiddenControlClicked || 0) + 1; } }) : target) });
      if (sel === S.qtyInput) return st.productControlsHiddenFirst ? hiddenCopy(qtyInput) : qtyInput;
      if (sel === S.addToCart) return st.productControlsHiddenFirst ? hiddenCopy(addToCart) : addToCart;
      // cartLinesResponsive: every cart line is rendered twice — a hidden mobile copy after the visible row
      if (sel === S.cartLine) return st.cartLinesResponsive
        ? el({ count: st.cart.length * 2, nth: (i) => (i % 2 ? el({ count: 1, visible: false }) : line(st.cart[i / 2])) })
        : el({ count: st.cart.length, nth: (i) => line(st.cart[i]) });
      // cartRemoveHiddenFirst: the hidden responsive cart copy's Remove precedes the visible row's (clicking it does nothing)
      const removeBtn = el({ count: 1, visible: true, onClick: () => { st.cart.shift(); } });
      if (sel === S.cartRemove) {
        if (!(st.cart.length && st.removable)) return el();
        return st.cartRemoveHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenRemoveClicked = (st.hiddenRemoveClicked || 0) + 1; } }) : removeBtn) }) : removeBtn;
      }
      // cartTotalHiddenFirst: a hidden responsive copy carrying a stale figure precedes the visible total
      if (sel === S.cartTotal) return st.cartTotalHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: '$999.00' }) : el({ count: 1, visible: true, text: '$99.00' })) }) : el({ count: 1, visible: true, text: '$99.00' });
      return el();
    };
    const page = {
      goto: async (u) => { if (st.gotoFailOnce) { st.gotoFailOnce = false; throw new Error('net::ERR_TIMED_OUT'); } st.url = u; },
      url: () => st.url,
      evaluate: async () => st.loginFill || 'ok', // loginFill: what the in-page fill reports ('badform' = the form posts off-host)
      waitForFunction: async () => {},
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => Buffer.from('png'),
      locator: resolve,
    };
    const context = { newPage: async () => page, route: async () => {} };
    // routeWebSocket: undefined → a working interception; null → the API is missing; a function → that registration
    if (st.routeWebSocket !== null) context.routeWebSocket = st.routeWebSocket || (async () => {});
    const browser = { newContext: async () => context, close: jest.fn(async () => {}) };
    const deps = { launchBrowser: async () => browser, resolveHostIps: async () => ['203.0.113.10'], upload: async () => 'evidence-key' };
    return { st, deps, browser };
  }
  const creds = { email: 'buyer@example.com', password: 'pw', accountNumber: '12345' };
  const args = (extra = {}) => ({ vendorSku: 'S1-77', quantity: 2, credentials: creds, beforeSubmit: async () => ({ ok: true }), dryRun: false, approvedShipTo: '123 Example Ave, 34205', ...extra });

  test('no approved ship-to configured → refused before the browser launches (pre-push P0)', async () => {
    const { st, deps } = fakeSiteOne();
    await expect(s1.place(args({ approvedShipTo: '' }), deps).catch((e) => e)).resolves.toMatchObject({ refuse: 'ship_to_unconfigured' });
    expect(st.loggedIn).toBe(false);
  });


  test('a leftover cart the bot cannot empty refuses before anything is added (r1 P1)', async () => {
    const { st, deps } = fakeSiteOne({ cart: [{ sku: 'OLD-1', qty: 5 }], removable: false });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'cart_not_empty' });
    expect(st.addClicked).toBe(0);
  });

  test('a leftover cart is emptied first; the cart must then be exactly [sku × packages]; a dry run leaves the cart empty', async () => {
    const { st, deps } = fakeSiteOne({ cart: [{ sku: 'OLD-1', qty: 5 }] });
    const r = await s1.place(args({ dryRun: true }), deps);
    expect(r).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.qty).toBe(2);
    expect(st.cart).toEqual([]); // post-run cleanup: nothing left for the next run
  });

  test('an unexpected extra cart line refuses cart_mismatch with the lines in evidence (r1 P1)', async () => {
    const { st, deps } = fakeSiteOne({ addExtra: { sku: 'OTHER-9', qty: 1 } });
    const err = await s1.place(args(), deps).catch((e) => e);
    expect(err.refuse).toBe('cart_mismatch');
    expect(err.evidence.cartLines).toEqual([{ sku: 'S1-77', qty: 2 }, { sku: 'OTHER-9', qty: 1 }]);
    expect(st.cart).toEqual([]); // cleaned up after the refusal
  });

  test('the egress lock fails CLOSED: no WebSocket interception API, or a throwing registration → run-level, Chromium closed, no login (r7 P1)', async () => {
    const missing = fakeSiteOne({ routeWebSocket: null });
    await expect(s1.place(args(), missing.deps)).rejects.toMatchObject({ runLevel: true });
    expect(missing.browser.close).toHaveBeenCalled();
    expect(missing.st.loggedIn).toBe(false);
    const throwing = fakeSiteOne({ routeWebSocket: async () => { throw new Error('ws route boom'); } });
    await expect(s1.place(args(), throwing.deps)).rejects.toMatchObject({ runLevel: true });
    expect(throwing.browser.close).toHaveBeenCalled();
    expect(throwing.st.loggedIn).toBe(false);
  });



  test('a cap check that THROWS (reservation transaction error) is run-level — claim released, never parked failed (PR3 r3 P2)', async () => {
    const { st, deps } = fakeSiteOne();
    await expect(s1.place(args({ beforeSubmit: async () => { throw new Error('connection reset'); } }), deps)).rejects.toMatchObject({ runLevel: true });
    expect(st.cart).toEqual([]); // cleaned before leaving
  });

  test('SiteOne rejecting the stored login parks (refusal, no submit) instead of aborting the batch; network failures stay run-level (PR3 r1 P1)', async () => {
    const rejected = fakeSiteOne({ loginRejects: true });
    await expect(s1.place(args(), rejected.deps)).rejects.toMatchObject({ refuse: 'login_rejected' });
    expect(rejected.browser.close).toHaveBeenCalled();
  });



  test('a transient failure followed by SiteOne rejecting the login parks as login_rejected — the stale transient error is not read as run-level (r4 P1)', async () => {
    const { st, deps, browser } = fakeSiteOne({ gotoFailOnce: true, loginRejects: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_rejected' });
    expect(browser.close).toHaveBeenCalled();
  });

  test('a cap refusal carries the vendor total it refused — the cart total (r4 P2)', async () => {
    const first = fakeSiteOne();
    await expect(s1.place(args({ beforeSubmit: async () => ({ ok: false, reason: 'over_cap' }) }), first.deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 9900 });
    expect(first.st.cart).toEqual([]);
  });

  test('PR 3a: a non-dry-run call refuses checkout_not_shipped AFTER the cart-total cap check — nothing submitted, the cart is cleared (split ruling 2026-09-05)', async () => {
    const { st, deps } = fakeSiteOne();
    const totals = [];
    await expect(s1.place(args({ beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps)).rejects.toMatchObject({ refuse: 'checkout_not_shipped', cents: 9900 });
    expect(totals).toEqual([9900]);
    expect(st.loggedIn).toBe(true);
    expect(st.cart).toEqual([]);
  });







  test('the cart total is the ONE visible total — a hidden stale copy ahead of it is never the dry-run or cap figure (r12 P2)', async () => {
    const { deps } = fakeSiteOne({ cartTotalHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
  });

  test('loginConfigured mirrors validatePlaceArgs: login + account number (r12 P2)', () => {
    expect(s1.loginConfigured(creds)).toBe(true);
    expect(s1.loginConfigured(null)).toBe(false);
    expect(s1.loginConfigured({ ...creds, password: null })).toBe(false);
    expect(s1.loginConfigured({ ...creds, accountNumber: '' })).toBe(false);
  });



  test('a login form whose action would post credentials off the trusted host is never filled — run-level, no submit (pre-push P0)', async () => {
    const { st, deps, browser } = fakeSiteOne({ loginFill: 'badform' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ runLevel: true, message: expect.stringMatching(/post credentials off the trusted host/) });
    expect(st.loggedIn).toBe(false);
    expect(browser.close).toHaveBeenCalled();
  });

  test('a hidden password input left behind after a successful sign-in is not "still on the login page" — every field is judged (pre-push P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginPassHiddenAfterLogin: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.loggedIn).toBe(true);
  });

  test('the login submit is the visible password form\'s own control — a hidden responsive login form ahead of it is never clicked (r16 P1)', async () => {
    const { st, deps } = fakeSiteOne();
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.loggedIn).toBe(true);
    expect(st.hiddenSubmitClicked || 0).toBe(0); // the document-wide first submit (hidden) was never used
    expect(st.pressed || []).toEqual([]); // the form's own submit control was clicked — no Enter fallback (r18 P1)
  });

  test('a visible login form without its own submit control is submitted with Enter on the password field (r16 P1)', async () => {
    const { st, deps } = fakeSiteOne({ formSubmitCount: 0 });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.pressed).toEqual(['Enter']);
    expect(st.loggedIn).toBe(true);
  });

  test('hidden responsive copies of the quantity + Add to Cart controls are never acted on — the visible ones are (r16 P2)', async () => {
    const { st, deps } = fakeSiteOne({ productControlsHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.hiddenControlClicked || 0).toBe(0);
    expect(st.addClicked).toBe(1); // the visible Add to Cart, once (the dry run then empties the cart)
  });

  test('a cart item rendered again in a hidden responsive container is ONE line — the exact-cart proof passes (r16 P2)', async () => {
    const { st, deps } = fakeSiteOne({ cartLinesResponsive: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 }); // the total was read = the one-line proof passed
    expect(st.addClicked).toBe(1);
  });

  test('a leftover cart whose visible Remove sits behind a hidden responsive copy is still emptied — the hidden control is never clicked (r17 P2)', async () => {
    const { st, deps } = fakeSiteOne({ cart: [{ sku: 'OLD-1', qty: 1 }], cartLinesResponsive: true, cartRemoveHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.hiddenRemoveClicked || 0).toBe(0);
    expect(st.addClicked).toBe(1);
  });

  test('the search result clicked is the first SHOWN link — a hidden copy ahead of it is never clicked (r17 P2)', async () => {
    const { st, deps } = fakeSiteOne({ productLinkHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.hitClicked).toBe(1);
    expect(st.hiddenControlClicked || 0).toBe(0);
  });

  test('a definitive login rejection is submitted ONCE — no retry with the same credential (vendor lockout; r20 P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginRejects: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_rejected', adapterDown: true }); // adapterDown: the dispatcher claims no more SiteOne requests this run (r21 P1)
    expect(st.loginSubmits).toBe(1);
  });

  test('a submit click whose promise rejects AFTER the credential went out is not resubmitted with Enter — the signed-in page is accepted, one submit (r23 P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginClickThrows: 'sent' });
    await expect(s1.place(args({ dryRun: true }), deps)).resolves.toMatchObject({ dryRun: true });
    expect(st.loginSubmits).toBe(1);
    expect(st.pressed || []).not.toContain('Enter');
  });

  test('a submit click whose promise rejects with the login form still up is neither retried nor Enter-submitted: login_unverified, adapter down (r23 P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginClickThrows: 'unsent' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_unverified', adapterDown: true });
    expect(st.loginSubmits || 0).toBe(0);
    expect(st.pressed || []).not.toContain('Enter');
    expect(st.addClicked).toBe(0);
  });

  test('an Enter submission whose press rejects AFTER the credential went out is not retried — the signed-in page is accepted, one submit (r24 P1)', async () => {
    const { st, deps } = fakeSiteOne({ formSubmitCount: 0, loginClickThrows: 'sent' });
    await expect(s1.place(args({ dryRun: true }), deps)).resolves.toMatchObject({ dryRun: true });
    expect(st.loginSubmits).toBe(1);
    expect(st.pressed).toEqual(['Enter']);
  });

  test('an Enter submission whose press rejects with the login form still up is never retried: login_unverified, adapter down (r24 P1)', async () => {
    const { st, deps } = fakeSiteOne({ formSubmitCount: 0, loginClickThrows: 'unsent' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_unverified', adapterDown: true });
    expect(st.loginSubmits || 0).toBe(0);
    expect(st.pressed).toEqual(['Enter']); // one press, no second attempt
    expect(st.addClicked).toBe(0);
  });

  test('a login page that keeps its password field up beside a generic account link is a REJECTED login, not a session — one submit, nothing done on the page (r24 P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginRejects: true, accountMarkerOnLoginPage: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_rejected', adapterDown: true });
    expect(st.loginSubmits).toBe(1);
    expect(st.addClicked).toBe(0);
  });

  test('a same-host page with no password field but no signed-in marker (MFA step / maintenance) is NOT a login: login_unverified, adapter down for the run, one submit (r22 P1)', async () => {
    const { st, deps } = fakeSiteOne({ noAccountMarker: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_unverified', adapterDown: true });
    expect(st.loginSubmits).toBe(1);
    expect(st.addClicked).toBe(0); // nothing was done on the unauthenticated page
  });

  test('inside a visible cart row the SHOWN SKU / quantity node is read, not a hidden stale copy (r20 P2)', async () => {
    const { st, deps } = fakeSiteOne({ cartRowChildrenHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.addClicked).toBe(1);
  });

  test('a cart row whose SKU node carries the code in data-product-code passes the exact-cart proof (r21 P2)', async () => {
    const { st, deps } = fakeSiteOne({ cartSkuInAttribute: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.addClicked).toBe(1);
  });

  test('a SKU node matched by data-product-code is read from the attribute, not its button text (r20 P2)', async () => {
    const { st, deps } = fakeSiteOne({ productSkuInAttribute: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.addClicked).toBe(1);
  });

  test('a transient login navigation failure is one attempt of three, not a terminal failure (r4 P2)', async () => {
    const { st, deps } = fakeSiteOne({ gotoFailOnce: true });
    const r = await s1.place(args({ dryRun: true }), deps);
    expect(r).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(st.loggedIn).toBe(true);
  });

});
