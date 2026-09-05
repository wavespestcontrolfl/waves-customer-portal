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
    for (const k of ['loginUser', 'loginPass', 'searchInput', 'qtyInput', 'addToCart', 'cartTotal', 'cardField', 'mfaField', 'billToAccount', 'checkoutLine', 'placeOrder', 'orderNumber']) expect(typeof SELECTORS[k]).toBe('string');
  });
});

// A minimal fake Playwright page driven by the SELECTORS map: enough surface
// for place() to walk login → cart reset → add → verify → checkout → submit.
describe('siteone bot cart + tender rules (fake page)', () => {
  const s1 = require('../services/procurement/adapters/siteone');
  const S = s1._internals.SELECTORS;

  function fakeSiteOne(opts = {}) {
    const st = { cart: [], removable: true, accountSelectable: true, url: 'https://www.siteone.com/en/login', loggedIn: false, placeClicked: 0, addClicked: 0, qty: null, ...opts };
    const el = (spec = {}) => ({
      count: async () => { if (spec.countThrows) throw new Error('locator.count: Target closed'); return spec.count ?? 0; },
      evaluate: async (fn) => fn({ tagName: (spec.tag || 'input').toUpperCase(), id: spec.id || '', name: spec.name || '', value: spec.value ?? '' }),
      getAttribute: async (n) => (spec.attrs ? spec.attrs[n] ?? null : null),
      first() { return this; },
      elementHandle() { return Promise.resolve(spec.detached ? { textContent: async () => spec.text ?? null, isVisible: async () => false, $$: async () => [], click: async () => { throw new Error('Element is not attached to the DOM'); } } : this); },
      // ElementHandle.$$: the handle's OWN children — a row detached since (detachedWhen) has none (r11 P1)
      $$: async (sub) => { if (spec.detachedWhen && spec.detachedWhen()) return []; const l = spec.sub ? spec.sub(sub) : el(); const n = await l.count(); return Array.from({ length: n }, (_, i) => l.nth(i)); },
      nth: (i) => spec.nth ? spec.nth(i) : el(spec),
      textContent: async () => { if (spec.onRead) spec.onRead(); return spec.text ?? null; }, // onRead: a rerender lands the moment this node is read (r11 P1)
      inputValue: async () => { if (spec.value == null) throw new Error('not an input'); return String(spec.value); },
      isVisible: async () => { if (spec.isVisibleThrows) throw new Error('Element is not attached to the DOM'); return !!spec.visible; },
      isChecked: async () => { if (spec.checked == null) throw new Error('n/a'); return spec.checked; },
      // `disabled` models Playwright's actionability failure; `{ trial: true }` runs the checks without dispatching (r5 P2)
      // onTrial models a delayed rerender landing DURING the awaited trial wait (r6 P1)
      // A forced click skips the actionability wait: on a disabled control the browser ignores it (nothing dispatched) — it never throws (r8 P1)
      click: async (o) => { if (spec.disabled) { if (o && o.force) return; throw new Error('element is not enabled'); } if (o && o.trial) { if (spec.onTrial) await spec.onTrial(); return; } if (spec.onClick) await spec.onClick(o); },
      fill: async (v) => { if (spec.onFill) spec.onFill(v); },
      press: async (key) => { if (spec.onPress) await spec.onPress(key); },
      waitFor: async () => {},
      locator: (sub) => (spec.sub ? spec.sub(sub) : el()),
    });
    // cartRowChildrenHiddenFirst: inside a visible row, a hidden stale SKU / quantity copy precedes the shown one (r20 P2)
    const child = (spec) => (st.cartRowChildrenHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: 'STALE-9', value: 9 }) : el({ count: 1, visible: true, ...spec })) }) : el({ count: 1, visible: true, ...spec }));
    // cartSkuInAttribute: the row's SKU node carries the code in data-product-code and shows unrelated text (r21 P2)
    // checkoutRowSwapAtClick: reading the row's SKU is the moment SiteOne replaces the row with a substitute product (S1-99 × same qty):
    // a re-resolving locator then reads the substitute's quantity beside the old SKU; the old row's handle is detached instead (r11 P1)
    const swapping = (l) => st.checkoutRowSwapAtClick && st.atClick && l.sku === 'S1-77';
    // l.detachedDuringScan: this row's visibility read throws (it detached between the count and the scan) (r13 P1)
    const line = (l) => el({ count: 1, isVisibleThrows: !!l.detachedDuringScan, get visible() { return !(swapping(l) && st.rowSwapped); }, detachedWhen: () => swapping(l) && st.rowSwapped, sub: (sub) => sub === S.cartLineSku ? child(st.cartSkuInAttribute ? { text: 'Remove', attrs: { 'data-product-code': l.sku } } : { text: swapping(l) && st.rowSwapped ? 'S1-99' : l.sku, onRead: () => { if (swapping(l)) st.rowSwapped = true; } }) : sub === S.cartLineQty ? child({ value: l.qty }) : el() });
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
      // loginInspectThrows: the post-submit password-field count throws mid-navigation (pre-push hook P1)
      if (sel === S.loginPass && st.loggedIn && st.loginInspectThrows) return el({ countThrows: true });
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
      // The checkout order summary mirrors the cart unless checkoutLines overrides it, or checkoutLinesAtClick once the Place Order stage has begun (r7 P1)
      // checkoutLineAppearsAtClick: a second row appears between the scan's count and the re-count (r13 P1)
      if (sel === S.checkoutLine) { const ls = st.checkoutLines || (st.checkoutLinesAtClick && st.atClick ? st.checkoutLinesAtClick : st.cart); st.lineCounts = (st.lineCounts || 0) + 1; const grow = st.checkoutLineAppearsAtClick && st.atClick && st.lineCounts % 2 === 0 ? 1 : 0; return el({ count: ls.length + grow, nth: (i) => (i < ls.length ? line(ls[i]) : line({ sku: 'S1-99', qty: 1 })) }); }
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
      // checkoutHiddenFirst: a hidden responsive copy of the checkout button precedes the visible one
      if (sel === S.checkoutButton) return st.checkoutHiddenFirst ? el({ count: 2, nth: (i) => el({ count: 1, visible: i === 1 }) }) : el({ count: 1, visible: true });
      // mfaHiddenFirst: a responsive duplicate — the first matching node is hidden, the second is the visible prompt
      // mfaAfterTender: the verification step appears only once bill-to-account is selected
      // mfaUnreadable: the MFA node's visibility read throws (detached mid-rerender) — must refuse, never read as absent
      if (sel === S.mfaField && st.mfaUnreadable) return el({ count: 1, isVisibleThrows: true });
      // mfaAtClick: the MFA step appears only once the Place Order stage has begun (after the last scan)
      if (sel === S.mfaField && st.mfaAtClick) return st.atClick ? el({ count: 1, visible: true }) : el();
      if (sel === S.mfaField) return st.mfaHiddenFirst ? el({ count: 2, nth: (i) => el({ count: 1, visible: i === 1 }) }) : st.mfaAfterTender && st.accountChecked ? el({ count: 1, visible: true }) : el();
      // cardUntilBillTo: the checkout defaults to card entry and hides the field once bill-to-account is selected
      if (sel === S.cardField) return st.cardUntilBillTo ? el({ count: 1, visible: !st.accountChecked }) : el();
      if (sel === S.termsCheckbox) {
        // termsHiddenCheckedFirst: a hidden CHECKED copy precedes the visible UNCHECKED checkbox the checkout shows
        if (st.termsHiddenCheckedFirst) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, checked: true }) : el({ count: 1, visible: true, checked: false })) });
        // termsAfterTender: an account-specific terms box appears (unchecked) only once bill-to-account is selected
        if (st.termsAfterTender) return st.accountChecked ? el({ count: 1, visible: true, checked: false }) : el();
        if (st.termsVisibilityThrows) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: true, checked: true }) : el({ count: 1, isVisibleThrows: true, checked: false })) }); // a required box detaches mid-scan
        return el(st.termsUnreadable ? { count: 1 } : {}); // count 1 with no `checked` → isChecked throws
      }
      // `checked` is a live getter: a real locator re-resolves, so the option clicked a moment ago reads its CURRENT state
      // The option: a radio input, or (billIsLabel) a wrapping label whose radio is the sub-locator
      // uncheckAccountAtClick: a delayed rerender resets the verified radio once the Place Order stage has begun
      // uncheckAccountAtTrial: the reset lands during the trial click's wait (r6 P1)
      const isChecked = () => st.accountChecked === true && !(st.uncheckAccountAtClick && st.atClick) && !(st.uncheckAccountAtTrial && st.trialDone);
      // hideRadioAtClick: a rerender hides the checked account radio once the Place Order stage has begun
      // Every real radio carries name="tender" (its payment group); radioUnnamed models markup without a name (the value-selector fallback)
      const grp = () => ({ name: st.radioUnnamed ? null : 'tender' });
      const radio = (id = 'acct-radio') => el({ count: 1, id, attrs: grp(), get visible() { return (st.radioVisible ?? true) && !(st.hideRadioAtClick && st.atClick); }, get checked() { return isChecked(); } });
      const billOption = () => el({ count: 1, attrs: st.billIsLabel ? {} : grp(), get visible() { return !(st.hideRadioAtClick && st.atClick); }, tag: st.billIsLabel ? 'label' : 'input', get checked() { return isChecked(); }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; }, sub: (sub) => (sub === 'input[type="radio"]' ? radio() : el()) });
      // billHiddenFirst: a hidden responsive copy of the option precedes the usable visible one; billVisibleCopies: N visible copies
      if (sel === S.billToAccount) {
        if (st.billHiddenFirst) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, tag: 'input', checked: false }) : billOption()) });
        // billVisibleCopies: N visible copies, each its OWN radio (distinct ids)
        if (st.billVisibleCopies) return el({ count: st.billVisibleCopies, nth: (i) => el({ count: 1, id: `acct-${i}`, attrs: grp(), visible: true, tag: 'input', get checked() { return st.accountChecked === true; }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } }) });
        // billLabelAndRadio: ordinary markup — the selector union matches the visible radio AND its visible label (for=acct-radio) = ONE option
        // labelForId: the label's `for` target id (a legal id with punctuation must resolve exactly — r12 P2)
        if (st.billLabelAndRadio) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, id: st.labelForId || 'acct-radio', attrs: grp(), visible: true, tag: 'input', get checked() { return st.accountChecked === true; }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } }) : el({ count: 1, visible: true, tag: 'label', attrs: { for: st.labelForId || 'acct-radio' }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } })) });
        return billOption();
      }
      if (sel === `[id="${st.labelForId || 'acct-radio'}"]`) return radio(st.labelForId || 'acct-radio');
      // extraCheckedAccounts = checked account radios ELSEWHERE on the page (hidden responsive duplicates, stale nodes)
      // first() = the clicked radio when it took (visible); an extra checked radio elsewhere is a hidden duplicate
      // The group count (name="tender") is what a named radio is judged by; the value-based selector only answers for an unnamed radio (r16 P2)
      if (sel === 'input[type="radio"][name="tender"]:checked') return el({ count: (isChecked() ? 1 : 0) + (st.extraCheckedAccounts || 0) });
      if (sel === S.billToAccountSelected) return el({ count: st.radioUnnamed ? (isChecked() ? 1 : 0) + (st.extraCheckedAccounts || 0) : 0 });
      // accountAtClick: a delayed rerender swaps the displayed billing account once the Place Order stage has begun (r5 P1)
      // accountAtTrial: the swap lands during the trial click's wait (r6 P1)
      if (sel === S.checkoutAccount) return el({ count: st.accountCount ?? 1, visible: st.accountVisible ?? true, text: st.accountAtTrial && st.trialDone ? st.accountAtTrial : st.accountAtClick && st.atClick ? st.accountAtClick : st.accountText === undefined ? 'Account # 12345' : st.accountText });
      if (sel === S.checkoutShipTo) return el({ count: st.shipToCount ?? 1, visible: st.shipToVisible ?? true, text: st.shipToText === undefined ? 'Ship to: Waves Pest Control\n 123 Example Ave\n Bradenton, FL 34205' : st.shipToText });
      // checkoutTotalText: the checkout total (default = the cart total, so a dry run's bell reports 9900);
      // totalAtClick: a DIFFERENT total shown once the Place Order stage re-reads it (async tax / shipping recalculation)
      // totalByRead: a function of the read index for a total that keeps moving
      // totalNodeReplacedMidRead: at the click boundary the total node is replaced between the text read and the visibility read —
      // the first resolution is the OLD node (detached once read), the second the NEW visible node with the recalculated figure (r10 P1)
      if (sel === S.checkoutTotal && st.totalNodeReplacedMidRead && st.atClick) return el({ count: 1, nth: () => el({ count: 1, visible: true, detached: true, text: st.checkoutTotalText || 'Order total $99.00' }) });
      // responsiveIdentity: a HIDDEN stale copy of the account / ship-to / total precedes the one visible reading (r12 P2)
      const hiddenThen = (stale, live) => el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: stale }) : el({ count: 1, visible: true, text: live })) });
      if (st.responsiveIdentity && sel === S.checkoutAccount) return hiddenThen('Account # 99999', 'Account # 12345');
      if (st.responsiveIdentity && sel === S.checkoutShipTo) return hiddenThen('Ship to: 9 Other Rd', 'Ship to: Waves Pest Control, 123 Example Ave, Bradenton, FL 34205');
      if (st.responsiveIdentity && sel === S.checkoutTotal) return hiddenThen('Order total $999.00', st.checkoutTotalText || 'Order total $99.00');
      // totalTexts: N shown total nodes, each its own text (nested `.grand-total` + `.price` = same figure twice; two figures = ambiguous) (r17 P2)
      if (sel === S.checkoutTotal && st.totalTexts) return el({ count: st.totalTexts.length, nth: (i) => el({ count: 1, visible: true, text: st.totalTexts[i] }) });
      if (sel === S.checkoutTotal) { st.totalReads = (st.totalReads || 0) + 1; return el({ count: st.totalCount ?? 1, visible: st.totalVisible ?? true, text: st.totalByRead ? st.totalByRead(st.totalReads) : st.totalAtClick && st.totalReads > 1 ? st.totalAtClick : (st.checkoutTotalText || 'Order total $99.00') }); }
      // placeOrderHiddenFirst: a hidden responsive copy of Place Order precedes the visible one (only the visible one may be clicked)
      if (sel === S.placeOrder) st.atClick = true; // the Place Order stage has begun (the at-click re-checks run after this)
      // placeOrderDisabled: the visible Place Order button is not enabled (actionability fails, nothing dispatched)
      // placeOrderDisabledAfterTrial: a rerender disables Place Order between the trial click and the dispatch (r8 P1)
      // placeOrderReplacedAtClick: the button element the trial validated is removed and replaced once the confirmation baseline has been sampled —
      // the handle taken at the trial reads detached (not visible); a locator would re-resolve to the replacement (hook P1)
      const placeBtn = () => el({ count: 1, get visible() { return !(st.placeOrderReplacedAtClick && st.baselineSampled); }, get disabled() { return !!st.placeOrderDisabled || (!!st.placeOrderDisabledAfterTrial && !!st.trialDone); }, onTrial: () => { st.trialDone = true; }, onClick: (o) => { st.placeClicked += 1; st.placeClickOpts = o; } });
      if (sel === S.placeOrder && st.placeOrderHiddenOnly) return el({ count: 1, visible: false, onClick: () => { st.hiddenPlaceClicked = (st.hiddenPlaceClicked || 0) + 1; } });
      if (sel === S.placeOrder) return st.placeOrderHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenPlaceClicked = (st.hiddenPlaceClicked || 0) + 1; } }) : placeBtn()) }) : placeBtn();
      // orderNumberHiddenFirst: a hidden stale confirmation node precedes the visible current one
      // Before the click there is no confirmation node — unless orderNumberBeforeClick models a pre-existing reference element
      // orderNumberDuringLoop: a reference node appears only once the Place Order stage's re-checks are under way (after the loop's first total read) (r6 P2)
      // orderNumberBaselineUnreadable: the pre-click node's visibility read throws; orderNumbersBeforeClick: N shown reference nodes before the click (r7 P2)
      if (sel === S.orderNumber && !st.placeClicked && st.atClick) st.baselineSampled = true;
      if (sel === S.orderNumber && !st.placeClicked && st.orderNumberBaselineUnreadable) return el({ count: 1, isVisibleThrows: true });
      if (sel === S.orderNumber && !st.placeClicked && st.orderNumbersBeforeClick) return el({ count: st.orderNumbersBeforeClick.length, nth: (i) => el({ count: 1, visible: true, text: st.orderNumbersBeforeClick[i] }) });
      if (sel === S.orderNumber && !st.placeClicked) return st.orderNumberBeforeClick ? el({ count: 1, visible: true, text: st.orderNumberBeforeClick }) : st.orderNumberDuringLoop && (st.totalReads || 0) > 1 ? el({ count: 1, visible: true, text: st.orderNumberDuringLoop }) : el();
      // orderNumberRetained: the SPA keeps the pre-click reference node (orderNumberBeforeClick) shown and APPENDS the confirmation node (r17 P2)
      if (sel === S.orderNumber && st.orderNumberRetained) return el({ count: 2, nth: (i) => el({ count: 1, visible: true, text: i === 0 ? st.orderNumberBeforeClick : 'Order # SO-778899' }) });
      // orderNumberLate: the confirmation element renders first as "Processing order…" and populates a few polls later
      if (sel === S.orderNumber && st.orderNumberLate) { st.confReads = (st.confReads || 0) + 1; return el({ count: 1, visible: true, text: st.confReads <= 3 ? (st.orderNumberLateText || 'Processing order…') : 'Order # SO-778899' }); }
      // orderNumberNested: the h1 wrapping the strong — both match, both shown, one identifier (r12 P2); orderNumberNestedDifferent: two shown nodes, different ids
      if (sel === S.orderNumber && st.orderNumberNested) return el({ count: 2, nth: (i) => el({ count: 1, visible: true, text: i === 0 ? 'Order # SO-778899 — thank you for your order' : 'Order # SO-778899' }) });
      if (sel === S.orderNumber && st.orderNumberNestedDifferent) return el({ count: 2, nth: (i) => el({ count: 1, visible: true, text: i === 0 ? 'Order # SO-778899' : 'Order # SO-000001' }) });
      if (sel === S.orderNumber) return st.orderNumberHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: 'Order # SO-000001' }) : el({ count: 1, visible: true, text: st.orderNumberText || 'Order # SO-778899' })) }) : el({ count: 1, visible: true, text: st.orderNumberText || 'Order # SO-778899' });
      return el();
    };
    const page = {
      goto: async (u) => { if (st.gotoFailOnce) { st.gotoFailOnce = false; throw new Error('net::ERR_TIMED_OUT'); } st.url = u; },
      url: () => (st.placeClicked && st.urlAfterClick ? st.urlAfterClick : st.url), // urlAfterClick: the submit navigates off SiteOne (an allowed asset host) (r10 P2)
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

  test.each([
    ['account_mismatch', { accountText: 'Account # 99999' }],
    ['account_mismatch', { accountText: 'Account # 912345' }], // superstring is not a match
    ['account_mismatch', { accountText: 'Account # 12345 (was 54321)' }], // two runs = ambiguous
    ['ship_to_mismatch', { shipToText: 'Ship to: 123 Example Ave, Bradenton FL 342051' }], // zip token must be whole
    ['account_unverified', { accountText: '' }],
    ['ship_to_mismatch', { shipToText: 'Ship to: 9 Other Rd, Venice, FL 34285' }],
    ['ship_to_unverified', { shipToText: null }],
    ['account_ambiguous', { accountCount: 2 }],
    ['terms_unreadable', { termsUnreadable: true }], // unknown ≠ accepted (r4 P2)
    ['account_hidden', { accountVisible: false }], // a hidden node carrying the right number is not what the checkout shows
    ['ship_to_hidden', { shipToVisible: false }],
    ['checkout_total_ambiguous', { totalTexts: ['Order total $99.00', 'Order total $105.93'] }], // two shown figures
    ['checkout_total_ambiguous', { totalTexts: ['Order total $99.00', 'Subtotal $49.00 · Total $99.00'] }], // an unparsable sibling is not the same figure
    ['checkout_total_hidden', { totalVisible: false }],
    ['no_checkout_total', { totalCount: 0 }],
    ['ship_to_ambiguous', { shipToCount: 3 }],
    ['account_unverified', { accountCount: 0 }],
  ])('checkout %s → refused, no place-order click, cart cleaned (pre-push P0)', async (reason, patch) => {
    const { st, deps } = fakeSiteOne(patch);
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: reason });
    expect(st.placeClicked).toBe(0);
    expect(st.cart).toEqual([]);
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
    expect(st.placeClicked).toBe(0);
  });

  test('an unexpected extra cart line refuses cart_mismatch with the lines in evidence (r1 P1)', async () => {
    const { st, deps } = fakeSiteOne({ addExtra: { sku: 'OTHER-9', qty: 1 } });
    const err = await s1.place(args(), deps).catch((e) => e);
    expect(err.refuse).toBe('cart_mismatch');
    expect(err.evidence.cartLines).toEqual([{ sku: 'S1-77', qty: 2 }, { sku: 'OTHER-9', qty: 1 }]);
    expect(st.placeClicked).toBe(0);
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

  test('bill-to proof is the CLICKED option: a checked account radio elsewhere does not count, and two checked refuse (r7 P1)', async () => {
    // The click did not take, but a checked account radio exists elsewhere → the CLICKED option's radio is not checked → unverified.
    const masked = fakeSiteOne({ accountSelectable: false, extraCheckedAccounts: 1 });
    await expect(s1.place(args(), masked.deps)).rejects.toMatchObject({ refuse: 'bill_to_account_unverified' });
    expect(masked.st.placeClicked).toBe(0);
    // The click took, but a second account radio is also checked → ambiguous, never submit.
    const doubled = fakeSiteOne({ extraCheckedAccounts: 1 });
    await expect(s1.place(args(), doubled.deps)).rejects.toMatchObject({ refuse: 'bill_to_account_ambiguous' });
    expect(doubled.st.placeClicked).toBe(0);
  });

  test('the option may be a wrapping label: the proof is its radio (PR3 r3 P1); a hidden associated radio refuses', async () => {
    const labelled = fakeSiteOne({ billIsLabel: true });
    const r = await s1.place(args(), labelled.deps);
    expect(r.externalOrderNumber).toBe('SO-778899');
    const hidden = fakeSiteOne({ billIsLabel: true, radioVisible: false });
    await expect(s1.place(args(), hidden.deps)).rejects.toMatchObject({ refuse: 'bill_to_account_hidden' });
    expect(hidden.st.placeClicked).toBe(0);
  });

  test('a cap check that THROWS (reservation transaction error) is run-level — claim released, never parked failed (PR3 r3 P2)', async () => {
    const { st, deps } = fakeSiteOne();
    await expect(s1.place(args({ beforeSubmit: async () => { throw new Error('connection reset'); } }), deps)).rejects.toMatchObject({ runLevel: true });
    expect(st.placeClicked).toBe(0);
    expect(st.cart).toEqual([]); // cleaned before leaving
  });

  test('SiteOne rejecting the stored login parks (refusal, no submit) instead of aborting the batch; network failures stay run-level (PR3 r1 P1)', async () => {
    const rejected = fakeSiteOne({ loginRejects: true });
    await expect(s1.place(args(), rejected.deps)).rejects.toMatchObject({ refuse: 'login_rejected' });
    expect(rejected.st.placeClicked).toBe(0);
    expect(rejected.browser.close).toHaveBeenCalled();
  });

  test('the order number must be an identifier: a label word next to "Order" never becomes the recorded number (PR3 r1 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberText: 'Order Confirmation Number: SO-778899' });
    const r = await s1.place(args(), deps);
    expect(r.externalOrderNumber).toBe('SO-778899');
    expect(st.placeClicked).toBe(1);
    expect(s1._internals.orderNumberIn('Thank you for your order')).toBeNull();
    expect(s1._internals.orderNumberIn('Order # 12345678')).toBe('12345678');
    expect(s1._internals.orderNumberIn('Order date 2026-09-05 · Order # SO-778899')).toBe('SO-778899'); // every labeled match is tried; a date is never an id (r2 P2)
    expect(s1._internals.orderNumberIn('Placed 2026-09-05')).toBeNull();
    expect(s1._internals.orderNumberIn('Order date 09-05-2026')).toBeNull(); // any date shape (r3 P2)
    expect(s1._internals.orderNumberIn('Order date 05/09/26 ref')).toBeNull();
    expect(s1._internals.orderNumberIn('Order date 20260905')).toBeNull(); // compact date (r4 P2)
    expect(s1._internals.orderNumberIn('Order date 09052026')).toBeNull(); // compact, month first (r5 P2)
    expect(s1._internals.orderNumberIn('Order date 05092026')).toBeNull(); // compact, day first
    expect(s1._internals.orderNumberIn('Order # 55501234')).toBe('55501234'); // an 8-digit id that is not a date stays an id
    expect(s1._internals.orderNumberIn('Order # 12345-67890')).toBe('12345-67890'); // separator-joined groups that cannot be a date are an id (r8 P2)
    expect(s1._internals.orderNumberIn('Order # pending · Total $105.93')).toBeNull(); // a price is never an id (r10 P2)
    expect(s1._internals.orderNumberIn('Order # pending · Ships to 34205')).toBeNull(); // no unlabeled fallback: a ZIP is never an id (r16 P2)
    expect(s1._internals.orderNumberIn('Your confirmation number is 55501234')).toBe('55501234');
    expect(s1._internals.orderNumberIn('Your order number is 55501234.')).toBe('55501234'); // the sentence's period is not part of the id (r17 P2)
    expect(s1._internals.orderNumberIn('Order # SO-12345.')).toBe('SO-12345');
    expect(s1._internals.orderNumberIn('Order date 2026-09-05.')).toBeNull();
    expect(s1._internals.orderNumberIn('Order # pending. Total $105.93.')).toBeNull();
    expect(s1._internals.orderNumberIn('Order ref SO-778899')).toBe('SO-778899');
    expect(s1._internals.orderNumberIn('Reference 55501 · Ready')).toBeNull();
    expect(s1._internals.orderNumberIn('Total 1,234.56 · Order # SO-778899')).toBe('SO-778899');
    expect(s1._internals.orderNumberIn('Subtotal 1,234 items')).toBeNull();
    expect(s1._internals.orderNumberIn('Order # 2026-778899')).toBe('2026-778899');
    expect(s1._internals.orderNumberIn('Order date 09-2026')).toBeNull(); // month-year
    expect(s1._internals.orderNumberIn('Order date 5.9.2026')).toBeNull();
    expect(s1._internals.orderNumberIn('Order date Sep-05-2026')).toBeNull(); // named month
    expect(s1._internals.orderNumberIn('Placed 05-Sep-2026')).toBeNull();
    expect(s1._internals.orderNumberIn('Order date Sep-05-2026 · Order # SO-778899')).toBe('SO-778899');
  });

  test('bill-to-account must be CONFIRMED selected before the place-order click (r1 P1)', async () => {
    const { st, deps } = fakeSiteOne({ accountSelectable: false });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'bill_to_account_unverified' });
    expect(st.placeClicked).toBe(0);
  });

  test('a transient failure followed by SiteOne rejecting the login parks as login_rejected — the stale transient error is not read as run-level (r4 P1)', async () => {
    const { st, deps, browser } = fakeSiteOne({ gotoFailOnce: true, loginRejects: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_rejected' });
    expect(st.placeClicked).toBe(0);
    expect(browser.close).toHaveBeenCalled();
  });

  test('a cap refusal carries the vendor total it refused: the checkout total, not the earlier cart total (r4 P2)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutTotalText: 'Order total $105.93' });
    let calls = 0;
    const beforeSubmit = async (cents) => { calls += 1; return calls === 1 ? { ok: true } : { ok: false, reason: 'over_cap', message: `${cents} over the per-order cap` }; };
    await expect(s1.place(args({ beforeSubmit }), deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 10593 });
    expect(st.placeClicked).toBe(0);
    const first = fakeSiteOne();
    await expect(s1.place(args({ beforeSubmit: async () => ({ ok: false, reason: 'over_cap' }) }), first.deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 9900 });
  });

  test('an ambiguous submit (no confirmation number after the click) carries the checkout total the click happened at (pre-push P0)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberText: 'Thank you for your order', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a hidden CHECKED terms copy ahead of the visible unchecked checkbox is not acceptance — every shown checkbox is judged (r12 P1)', async () => {
    const { st, deps } = fakeSiteOne({ termsHiddenCheckedFirst: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'terms_required' });
    expect(st.placeClicked).toBe(0);
  });

  test('the bill-to option is the ONE visible copy: a hidden copy ahead of it is skipped, two visible copies refuse (r12 P2)', async () => {
    const { st, deps } = fakeSiteOne({ billHiddenFirst: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
    const dup = fakeSiteOne({ billVisibleCopies: 2 });
    await expect(s1.place(args(), dup.deps)).rejects.toMatchObject({ refuse: 'bill_to_account_ambiguous' });
    expect(dup.st.placeClicked).toBe(0);
  });

  test.each([
    ['mfa_required', { mfaAfterTender: true }],
    ['terms_required', { termsAfterTender: true }],
  ])('a blocker revealed by the tender change (%s) is caught by the post-click scan — no Place Order click (r14 P1)', async (reason, patch) => {
    const { st, deps } = fakeSiteOne(patch);
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: reason });
    expect(st.accountChecked).toBe(true); // the tender WAS switched — the blocker appeared afterwards
    expect(st.placeClicked).toBe(0);
  });

  test('the checkout and Place Order clicks target the ONE visible control — hidden responsive copies are never clicked (r14 P2)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutHiddenFirst: true, placeOrderHiddenFirst: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
    expect(st.hiddenPlaceClicked).toBeUndefined();
  });

  test('a Place Order button that is only hidden refuses BEFORE the click and still clears the cart — submitted flips at the click, not before (r15 P2)', async () => {
    const { st, deps } = fakeSiteOne({ placeOrderHiddenOnly: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'no_place_order' });
    expect(st.hiddenPlaceClicked).toBeUndefined();
    expect(st.cart).toEqual([]); // cleaned: nothing was submitted
  });

  test('the confirmation number is the ONE visible node — a hidden stale copy ahead of it is never recorded (r15 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberHiddenFirst: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
  });

  test('a visible radio and its visible label are ONE bill-to option — counted by the associated radio, the order places (r13 P1)', async () => {
    const { st, deps } = fakeSiteOne({ billLabelAndRadio: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
  });

  test('the cart total is the ONE visible total — a hidden stale copy ahead of it is never the dry-run or cap figure (r12 P2)', async () => {
    const { deps } = fakeSiteOne({ cartTotalHiddenFirst: true });
    expect(await s1.place(args({ dryRun: true }), deps)).toMatchObject({ dryRun: true, amountCents: 9900 });
  });

  test('nested checkout-total markup (.grand-total wrapping its .price) is ONE figure — the order places on it (r17 P2)', async () => {
    const { st, deps } = fakeSiteOne({ totalTexts: ['Order total $105.93', '$105.93'] });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899', amountCents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a retained pre-click reference node beside the appended confirmation node: the ONE new identifier is the order number (r17 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBeforeClick: 'Order ref SO-000001', orderNumberRetained: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
  });

  test('a dry run validates the Place Order control: hidden-only, disabled, or duplicated refuses at the dry-run stop, nothing clicked, cart emptied (r17 P2)', async () => {
    for (const [patch, reason] of [[{ placeOrderHiddenOnly: true }, 'no_place_order'], [{ placeOrderDisabled: true }, 'place_order_unactionable'], [{ placeOrderHiddenFirst: true, placeOrderDisabled: true }, 'place_order_unactionable']]) {
      const { st, deps } = fakeSiteOne(patch);
      await expect(s1.place(args({ dryRun: true }), deps)).rejects.toMatchObject({ refuse: reason });
      expect(st.placeClicked).toBe(0);
      expect(st.hiddenPlaceClicked).toBeUndefined();
      expect(st.cart).toEqual([]);
    }
    const ok = fakeSiteOne({ placeOrderHiddenFirst: true });
    const r = await s1.place(args({ dryRun: true }), ok.deps);
    expect(r).toMatchObject({ dryRun: true, amountCents: 9900 });
    expect(r.evidence.placeOrderValidated).toBe(true);
    expect(ok.st.trialDone).toBe(true);
    expect(ok.st.placeClicked).toBe(0);
  });

  test('loginConfigured mirrors validatePlaceArgs: login + account number (r12 P2)', () => {
    expect(s1.loginConfigured(creds)).toBe(true);
    expect(s1.loginConfigured(null)).toBe(false);
    expect(s1.loginConfigured({ ...creds, password: null })).toBe(false);
    expect(s1.loginConfigured({ ...creds, accountNumber: '' })).toBe(false);
  });

  test('a visible MFA prompt behind a hidden duplicate node still refuses — every match is checked, not the first (r11 P1)', async () => {
    const { st, deps } = fakeSiteOne({ mfaHiddenFirst: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'mfa_required' });
    expect(st.placeClicked).toBe(0);
  });

  test('a checkout that defaults to card entry is switched to bill-to-account before the card field is judged (r6 P1)', async () => {
    const { st, deps } = fakeSiteOne({ cardUntilBillTo: true });
    const r = await s1.place(args(), deps);
    expect(r).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
    const stuck = fakeSiteOne({ cardUntilBillTo: true, accountSelectable: false });
    await expect(s1.place(args(), stuck.deps)).rejects.toMatchObject({ refuse: expect.stringMatching(/card_required|bill_to_account/) });
    expect(stuck.st.placeClicked).toBe(0);
  });

  test('a login form whose action would post credentials off the trusted host is never filled — run-level, no submit (pre-push P0)', async () => {
    const { st, deps, browser } = fakeSiteOne({ loginFill: 'badform' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ runLevel: true, message: expect.stringMatching(/post credentials off the trusted host/) });
    expect(st.loggedIn).toBe(false);
    expect(st.placeClicked).toBe(0);
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

  test('a post-submit inspection that THROWS (locator count mid-navigation) is not a retry: login_unverified, adapter down, the credential sent once (pre-push hook P1)', async () => {
    const { st, deps } = fakeSiteOne({ loginInspectThrows: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'login_unverified', adapterDown: true });
    expect(st.loginSubmits).toBe(1);
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
    const r = await s1.place(args(), deps);
    expect(r).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.loggedIn).toBe(true);
  });

  test('a total that changes DURING the tender re-check is caught by the final read, re-gated and recorded (r4 P1)', async () => {
    // read 1 = checkout stage; read 2 = loop; [tender re-check]; read 3 differs → gate → read 4 equal; [re-check]; read 5 equal → click
    const seq = { 1: '$105.93', 2: '$105.93', 3: '$112.40' };
    const { st, deps } = fakeSiteOne({ totalByRead: (n) => `Order total ${seq[n] || '$112.40'}` });
    const totals = [];
    const r = await s1.place(args({ beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps);
    expect(totals).toEqual([9900, 10593, 11240]);
    expect(r).toMatchObject({ amountCents: 11240 });
    expect(st.placeClicked).toBe(1);
  });

  test('a checked bill-to radio that a rerender HIDES at the click boundary refuses bill_to_account_hidden, no click (r4 P1)', async () => {
    const { st, deps } = fakeSiteOne({ hideRadioAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'bill_to_account_hidden' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a terms checkbox whose visibility cannot be read refuses terms_unreadable — never dropped from the scan (r4 P1)', async () => {
    const { st, deps } = fakeSiteOne({ termsVisibilityThrows: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'terms_unreadable' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a confirmation element that first renders "Processing order…" is polled until its text yields a number (r4 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberLate: true });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.confReads).toBeGreaterThan(3);
  });

  test('the tender is re-checked immediately before the click: a rerender that unselects bill-to-account refuses, no click (r3 P1)', async () => {
    const { st, deps } = fakeSiteOne({ uncheckAccountAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'bill_to_account_unverified' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a blocker revealed at the click boundary (MFA after the last scan) refuses, no click (r3 P1)', async () => {
    const { st, deps } = fakeSiteOne({ mfaAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'mfa_required' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a confirmation-number node already on the page BEFORE the click is not the outcome: unchanged after the click = ambiguous (r3 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBeforeClick: 'PO reference 55501', orderNumberText: 'PO reference 55501', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a pre-click reference node whose status text alone changes keeps the same identifier — ambiguous, not placed (r5 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBeforeClick: 'PO reference 55501 · Ready', orderNumberText: 'PO reference 55501 · Validation failed', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a billing account that changes once the Place Order stage has begun refuses at the click boundary (r5 P1)', async () => {
    const { st, deps } = fakeSiteOne({ accountAtClick: 'Account # 99999' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'account_mismatch' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]); // pre-click refusal: cart emptied
  });

  test('a visible but disabled Place Order button refuses BEFORE the submitted guard flips — cart emptied, nothing ambiguous (r5 P2)', async () => {
    const { st, deps } = fakeSiteOne({ placeOrderDisabled: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'place_order_unactionable' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a rerender DURING the trial click that unselects bill-to-account is caught by the tender re-check after it — refused, no click (r6 P1)', async () => {
    const { st, deps } = fakeSiteOne({ uncheckAccountAtTrial: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'bill_to_account_unverified' });
    expect(st.trialDone).toBe(true);
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a rerender DURING the trial click that swaps the billing account is caught by the identity re-check after it — refused, no click (r6 P1)', async () => {
    const { st, deps } = fakeSiteOne({ accountAtTrial: 'Account # 99999' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'account_mismatch' });
    expect(st.trialDone).toBe(true);
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a reference node that appears DURING the pre-click loop is the baseline, not the outcome: unchanged after the click = ambiguous (r6 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberDuringLoop: 'Order # SO-556677', orderNumberText: 'Order # SO-556677', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a checkout order summary that no longer matches [SKU × packages] at the stage refuses checkout_lines_mismatch — dry run included, no click (r7 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutLines: [{ sku: 'S1-77', qty: 2 }, { sku: 'S1-99', qty: 1 }] });
    await expect(s1.place(args({ dryRun: true }), deps)).rejects.toMatchObject({ refuse: 'checkout_lines_mismatch' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a quantity SiteOne adjusts once the Place Order stage has begun is caught at the click boundary — refused, no click (r7 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutLinesAtClick: [{ sku: 'S1-77', qty: 1 }] });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_lines_mismatch' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a separator-formatted account display ("12345-01") matches the configured number digit for digit; a superstring still does not (r7 P2)', async () => {
    const dashed = { ...creds, accountNumber: '12345-01' };
    const ok = fakeSiteOne({ accountText: 'Account # 12345-01' });
    await expect(s1.place(args({ credentials: dashed, dryRun: true }), ok.deps)).resolves.toMatchObject({ dryRun: true });
    const bad = fakeSiteOne({ accountText: 'Account # 912345-01' });
    await expect(s1.place(args({ credentials: dashed }), bad.deps)).rejects.toMatchObject({ refuse: 'account_mismatch' });
    expect(bad.st.placeClicked || 0).toBe(0);
  });

  test('two shown reference nodes before the click are BOTH the baseline: one left standing after a rejected click is ambiguous, not placed (r7 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumbersBeforeClick: ['Order # SO-111111', 'PO reference 55501'], orderNumberText: 'PO reference 55501', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a pre-click confirmation baseline that cannot be read refuses confirmation_baseline_unreadable BEFORE the click (r7 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBaselineUnreadable: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'confirmation_baseline_unreadable' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('the dispatch click is FORCED — it never waits on actionability past the validated state; a control disabled after the trial submits nothing and parks ambiguous, one click attempt (r8 P1)', async () => {
    const ok = fakeSiteOne();
    await expect(s1.place(args(), ok.deps)).resolves.toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(ok.st.placeClickOpts).toMatchObject({ force: true });
    const { st, deps } = fakeSiteOne({ placeOrderDisabledAfterTrial: true, orderNumberText: 'Thank you', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(0); // the browser ignored the forced click on a disabled control — nothing dispatched, nothing retried
  });

  test('a pre-click reference whose only post-click change is casing (so-12345 → SO-12345) is the same node — ambiguous, not placed (r8 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBeforeClick: 'Order ref so-12345', orderNumberText: 'Order ref SO-12345', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('the total is read from ONE element: a node replaced between the text and visibility reads refuses (detached = not visible), never approves the old figure (r10 P1)', async () => {
    const { st, deps } = fakeSiteOne({ totalNodeReplacedMidRead: true, checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_total_hidden' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a confirmation node that first shows a price ("Order # pending · Total $105.93") is polled until the real number renders — the price is never the order id (r10 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberLate: true, orderNumberLateText: 'Order # pending · Total $105.93' });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.confReads).toBeGreaterThan(3);
  });

  test('a submit that lands off the trusted host is ambiguous — a numeric id on the foreign page is never a placement (r10 P2)', async () => {
    const { st, deps } = fakeSiteOne({ urlAfterClick: 'https://cdn.example.com/error/12345678', orderNumberText: 'Order # 12345678', checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
    expect(st.placeClicked).toBe(1);
  });

  test('a checkout row replaced the moment its SKU is read is ONE detached snapshot — the substitute\'s quantity is never paired with the old SKU; refused, no click (r11 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutRowSwapAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_lines_mismatch' });
    expect(st.rowSwapped).toBe(true);
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a hidden responsive copy beside the ONE visible account / ship-to / total reading is not ambiguity — the dry run reports the visible total (r12 P2)', async () => {
    const { st, deps } = fakeSiteOne({ responsiveIdentity: true, checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args({ dryRun: true }), deps)).resolves.toMatchObject({ dryRun: true, amountCents: 10593 });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('nested confirmation matches (h1 wrapping the strong) carrying ONE identifier are the confirmation; two shown nodes with different ids stay ambiguous (r12 P2)', async () => {
    const ok = fakeSiteOne({ orderNumberNested: true });
    await expect(s1.place(args(), ok.deps)).resolves.toMatchObject({ externalOrderNumber: 'SO-778899' });
    const bad = fakeSiteOne({ orderNumberNestedDifferent: true, checkoutTotalText: 'Order total $105.93' });
    await expect(s1.place(args(), bad.deps)).rejects.toMatchObject({ ambiguous: true, cents: 10593 });
  });

  test('a bill-to label whose `for` target is a legal id with punctuation (payment:account) resolves its radio exactly — the order places (r12 P2)', async () => {
    const { st, deps } = fakeSiteOne({ billLabelAndRadio: true, labelForId: 'payment:account' });
    await expect(s1.place(args(), deps)).resolves.toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
  });

  test('a checkout row that detaches DURING the line scan fails the proof closed — the briefly-present extra line is never dropped to make the cart look exact (r13 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutLinesAtClick: [{ sku: 'S1-77', qty: 2 }, { sku: 'S1-99', qty: 1, detachedDuringScan: true }] });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_lines_mismatch' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('a row count that differs after the scan from before it is churn — refused, no click (r13 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutLineAppearsAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_lines_mismatch' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('the dispatch goes to the ELEMENT the trial validated: a Place Order button replaced after the final checks refuses place_order_replaced — no click, cart emptied (hook P1)', async () => {
    const { st, deps } = fakeSiteOne({ placeOrderReplacedAtClick: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'place_order_replaced' });
    expect(st.trialDone).toBe(true);
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('the selected-tender count is the radio\'s OWN group: a label-associated radio with an opaque value places; an unnamed radio still uses the account-value fallback (r16 P2)', async () => {
    const named = fakeSiteOne({ billLabelAndRadio: true });
    await expect(s1.place(args(), named.deps)).resolves.toMatchObject({ externalOrderNumber: 'SO-778899' });
    const unnamed = fakeSiteOne({ radioUnnamed: true });
    await expect(s1.place(args(), unnamed.deps)).resolves.toMatchObject({ externalOrderNumber: 'SO-778899' });
    const unnamedDoubled = fakeSiteOne({ radioUnnamed: true, extraCheckedAccounts: 1 });
    await expect(s1.place(args(), unnamedDoubled.deps)).rejects.toMatchObject({ refuse: 'bill_to_account_ambiguous' });
  });

  test('a confirmation node that first shows an unlabeled number ("Order # pending · Ships to 34205") is polled until the labeled number renders (r16 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberLate: true, orderNumberLateText: 'Order # pending · Ships to 34205' });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.confReads).toBeGreaterThan(3);
  });

  test('a pre-click reference node that CHANGES to the confirmation after the click is read (r3 P2)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberBeforeClick: 'PO reference 55501' });
    expect(await s1.place(args(), deps)).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.placeClicked).toBe(1);
  });

  test('a dry run walks through the checkout verifications and the final cap check, then stops BEFORE the click and bells the checkout total (r2 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutTotalText: 'Order total $105.93' });
    const totals = [];
    const r = await s1.place(args({ dryRun: true, beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps);
    expect(r).toMatchObject({ dryRun: true, amountCents: 10593, externalOrderNumber: null });
    expect(r.evidence.billToAccountVerified).toBe(true);
    expect(r.evidence.accountVerified).toBe(true);
    expect(totals).toEqual([9900, 10593]);
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]); // nothing submitted: the cart is emptied
  });

  test('a dry run still refuses on a checkout blocker — the selectors are exercised (r2 P1)', async () => {
    const { st, deps } = fakeSiteOne({ mfaAfterTender: true });
    await expect(s1.place(args({ dryRun: true }), deps)).rejects.toMatchObject({ refuse: 'mfa_required' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('the total is re-read at the click boundary: a changed figure is cap-gated again and is the amount recorded (r2 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutTotalText: 'Order total $105.93', totalAtClick: 'Order total $112.40' });
    const totals = [];
    const r = await s1.place(args({ beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps);
    expect(totals).toEqual([9900, 10593, 11240]);
    expect(r).toMatchObject({ externalOrderNumber: 'SO-778899', amountCents: 11240 });
    expect(r.evidence.totalChangedBeforeClick).toEqual({ from: 10593, to: 11240 });
    expect(st.placeClicked).toBe(1);
  });

  test('a total that changes AGAIN during the cap reservation is re-read and re-gated; the click waits for a stable, approved figure (pre-push P0)', async () => {
    // read 1 = the checkout-stage read; read 2 differs → gated → read 3 differs again → gated → read 4 stable
    const seq = { 1: '$105.93', 2: '$112.40', 3: '$118.00', 4: '$118.00', 5: '$118.00' };
    const { st, deps } = fakeSiteOne({ totalByRead: (n) => `Order total ${seq[n] || '$118.00'}` });
    const totals = [];
    const r = await s1.place(args({ beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps);
    expect(totals).toEqual([9900, 10593, 11240, 11800]);
    expect(r).toMatchObject({ amountCents: 11800 });
    expect(st.placeClicked).toBe(1);
  });

  test('a total that never settles before the click refuses checkout_total_unstable — nothing submitted (pre-push P0)', async () => {
    const { st, deps } = fakeSiteOne({ totalByRead: (n) => `Order total $${100 + n}.00` });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'checkout_total_unstable' });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]);
  });

  test('a changed total at the click boundary that the cap refuses is NOT clicked (r2 P1)', async () => {
    const { st, deps } = fakeSiteOne({ checkoutTotalText: 'Order total $105.93', totalAtClick: 'Order total $999.00' });
    const beforeSubmit = async (cents) => (cents > 20000 ? { ok: false, reason: 'over_cap', message: 'over' } : { ok: true });
    await expect(s1.place(args({ beforeSubmit }), deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 99900 });
    expect(st.placeClicked || 0).toBe(0);
    expect(st.cart).toEqual([]); // pre-click refusal: cart emptied
  });

  test('an MFA check whose visibility cannot be read refuses (mfa_unreadable) — never read as absent (r2 P1)', async () => {
    const { st, deps } = fakeSiteOne({ mfaUnreadable: true });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'mfa_unreadable' });
    expect(st.placeClicked || 0).toBe(0);
  });

  test('bill-to-account confirmed → checkout total cap-checked → one place-order click, cart left to the vendor', async () => {
    const { st, deps } = fakeSiteOne({ checkoutTotalText: 'Order total $105.93' });
    const totals = [];
    const r = await s1.place(args({ beforeSubmit: async (c) => { totals.push(c); return { ok: true }; } }), deps);
    expect(r).toMatchObject({ externalOrderNumber: 'SO-778899', amountCents: 10593, dryRun: false });
    expect(r.evidence.billToAccountVerified).toBe(true);
    expect(r.evidence.accountVerified).toBe(true);
    expect(r.evidence.shipToVerified).toMatch(/123 example ave/);
    expect(totals).toEqual([9900, 10593]);
    expect(st.placeClicked).toBe(1);
    expect(st.cart).toEqual([{ sku: 'S1-77', qty: 2 }]); // submitted: never cleared
  });
});
