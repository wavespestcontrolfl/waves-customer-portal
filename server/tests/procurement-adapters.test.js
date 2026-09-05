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
    const mkForm = (action, fields) => ({ getAttribute: () => action, querySelector: () => fields.user || null });
    const pw = field('password'); const user = field('username');
    const form = mkForm('/login', { user }); pw.form = form; user.form = form;
    const newsletter = field('email');
    const hiddenPw = field('password', { offsetParent: null });
    global.location = { hostname: 'www.siteone.com', protocol: 'https:', href: 'https://www.siteone.com/en/login' };
    global.document = { querySelectorAll: (sel) => (sel === S.loginPass ? [hiddenPw, pw] : [newsletter, user]) };
    global.Event = class { constructor(type) { this.type = type; } };
    try {
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('ok');
      expect(user.value).toBe('u@x'); expect(pw.value).toBe('p');
      expect(newsletter.value).toBe(''); // the document-wide first email input is untouched
      const pw2 = field('password', { form }); global.document.querySelectorAll = (sel) => (sel === S.loginPass ? [pw, pw2] : [user]);
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('ambiguousform');
      const orphan = field('password'); orphan.form = mkForm('/login', {}); global.document.querySelectorAll = (sel) => (sel === S.loginPass ? [orphan] : []);
      expect(fillLoginForm({ user: 'u@x', pw: 'p', userSel: S.loginUser, passSel: S.loginPass })).toBe('nofields');
    } finally { delete global.location; delete global.document; delete global.Event; }
  });

  test('every selector lives in the frozen SELECTORS map', () => {
    expect(Object.isFrozen(SELECTORS)).toBe(true);
    for (const k of ['loginUser', 'loginPass', 'searchInput', 'qtyInput', 'addToCart', 'cartTotal', 'cardField', 'mfaField', 'billToAccount', 'placeOrder', 'orderNumber']) expect(typeof SELECTORS[k]).toBe('string');
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
      press: async () => {},
      waitFor: async () => {},
      locator: (sub) => (spec.sub ? spec.sub(sub) : el()),
    });
    const line = (l) => el({ count: 1, sub: (sub) => sub === S.cartLineSku ? el({ count: 1, text: l.sku }) : sub === S.cartLineQty ? el({ count: 1, value: l.qty }) : el() });
    const resolve = (sel) => {
      // loginPassHiddenAfterLogin: a hidden responsive duplicate of the password input survives a successful sign-in
      if (sel === S.loginPass) return st.loggedIn ? (st.loginPassHiddenAfterLogin ? el({ count: 1, visible: false }) : el()) : el({ count: 1, visible: true });
      if (sel === S.loginSubmit) return el({ count: 1, onClick: () => { if (st.loginRejects) return; st.loggedIn = true; st.url = 'https://www.siteone.com/en/'; } });
      if (sel === S.loginError) return el();
      if (sel === S.searchInput) return el({ count: 1 });
      if (sel === S.productLink) return el({ count: 1 });
      if (sel === S.productSku) return el({ count: 1, text: 'SKU: S1-77' });
      if (sel === S.unavailable) return el();
      if (sel === S.qtyInput) return el({ count: 1, onFill: (v) => { st.qty = Number(v); } });
      if (sel === S.addToCart) return el({ count: 1, onClick: () => { st.addClicked += 1; st.cart.push({ sku: 'S1-77', qty: st.qty }); if (st.addExtra) st.cart.push(st.addExtra); } });
      if (sel === S.cartLine) return el({ count: st.cart.length, nth: (i) => line(st.cart[i]) });
      if (sel === S.cartRemove) return el({ count: st.cart.length && st.removable ? 1 : 0, onClick: () => { st.cart.shift(); } });
      // cartTotalHiddenFirst: a hidden responsive copy carrying a stale figure precedes the visible total
      if (sel === S.cartTotal) return st.cartTotalHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: '$999.00' }) : el({ count: 1, visible: true, text: '$99.00' })) }) : el({ count: 1, visible: true, text: '$99.00' });
      // checkoutHiddenFirst: a hidden responsive copy of the checkout button precedes the visible one
      if (sel === S.checkoutButton) return st.checkoutHiddenFirst ? el({ count: 2, nth: (i) => el({ count: 1, visible: i === 1 }) }) : el({ count: 1, visible: true });
      // mfaHiddenFirst: a responsive duplicate — the first matching node is hidden, the second is the visible prompt
      // mfaAfterTender: the verification step appears only once bill-to-account is selected
      if (sel === S.mfaField) return st.mfaHiddenFirst ? el({ count: 2, nth: (i) => el({ count: 1, visible: i === 1 }) }) : st.mfaAfterTender && st.accountChecked ? el({ count: 1, visible: true }) : el();
      // cardUntilBillTo: the checkout defaults to card entry and hides the field once bill-to-account is selected
      if (sel === S.cardField) return st.cardUntilBillTo ? el({ count: 1, visible: !st.accountChecked }) : el();
      if (sel === S.termsCheckbox) {
        // termsHiddenCheckedFirst: a hidden CHECKED copy precedes the visible UNCHECKED checkbox the checkout shows
        if (st.termsHiddenCheckedFirst) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, checked: true }) : el({ count: 1, visible: true, checked: false })) });
        // termsAfterTender: an account-specific terms box appears (unchecked) only once bill-to-account is selected
        if (st.termsAfterTender) return st.accountChecked ? el({ count: 1, visible: true, checked: false }) : el();
        return el(st.termsUnreadable ? { count: 1 } : {}); // count 1 with no `checked` → isChecked throws
      }
      // `checked` is a live getter: a real locator re-resolves, so the option clicked a moment ago reads its CURRENT state
      // The option: a radio input, or (billIsLabel) a wrapping label whose radio is the sub-locator
      const radio = (id = 'acct-radio') => el({ count: 1, id, visible: st.radioVisible ?? true, get checked() { return st.accountChecked === true; } });
      const billOption = () => el({ count: 1, visible: true, tag: st.billIsLabel ? 'label' : 'input', get checked() { return st.accountChecked === true; }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; }, sub: (sub) => (sub === 'input[type="radio"]' ? radio() : el()) });
      // billHiddenFirst: a hidden responsive copy of the option precedes the usable visible one; billVisibleCopies: N visible copies
      if (sel === S.billToAccount) {
        if (st.billHiddenFirst) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, tag: 'input', checked: false }) : billOption()) });
        // billVisibleCopies: N visible copies, each its OWN radio (distinct ids)
        if (st.billVisibleCopies) return el({ count: st.billVisibleCopies, nth: (i) => el({ count: 1, id: `acct-${i}`, visible: true, tag: 'input', get checked() { return st.accountChecked === true; }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } }) });
        // billLabelAndRadio: ordinary markup — the selector union matches the visible radio AND its visible label (for=acct-radio) = ONE option
        if (st.billLabelAndRadio) return el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, id: 'acct-radio', visible: true, tag: 'input', get checked() { return st.accountChecked === true; }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } }) : el({ count: 1, visible: true, tag: 'label', attrs: { for: 'acct-radio' }, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } })) });
        return billOption();
      }
      if (sel === '#acct-radio') return radio();
      // extraCheckedAccounts = checked account radios ELSEWHERE on the page (hidden responsive duplicates, stale nodes)
      // first() = the clicked radio when it took (visible); an extra checked radio elsewhere is a hidden duplicate
      if (sel === S.billToAccountSelected) return el({ count: (st.accountChecked ? 1 : 0) + (st.extraCheckedAccounts || 0) });
      if (sel === S.checkoutAccount) return el({ count: st.accountCount ?? 1, visible: st.accountVisible ?? true, text: st.accountText === undefined ? 'Account # 12345' : st.accountText });
      if (sel === S.checkoutShipTo) return el({ count: st.shipToCount ?? 1, visible: st.shipToVisible ?? true, text: st.shipToText === undefined ? 'Ship to: Waves Pest Control\n 123 Example Ave\n Bradenton, FL 34205' : st.shipToText });
      if (sel === S.checkoutTotal) return el({ count: st.totalCount ?? 1, visible: st.totalVisible ?? true, text: 'Order total $105.93' });
      // placeOrderHiddenFirst: a hidden responsive copy of Place Order precedes the visible one (only the visible one may be clicked)
      const placeBtn = () => el({ count: 1, visible: true, onClick: () => { st.placeClicked += 1; } });
      if (sel === S.placeOrder && st.placeOrderHiddenOnly) return el({ count: 1, visible: false, onClick: () => { st.hiddenPlaceClicked = (st.hiddenPlaceClicked || 0) + 1; } });
      if (sel === S.placeOrder) return st.placeOrderHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, onClick: () => { st.hiddenPlaceClicked = (st.hiddenPlaceClicked || 0) + 1; } }) : placeBtn()) }) : placeBtn();
      // orderNumberHiddenFirst: a hidden stale confirmation node precedes the visible current one
      if (sel === S.orderNumber) return st.orderNumberHiddenFirst ? el({ count: 2, nth: (i) => (i === 0 ? el({ count: 1, visible: false, text: 'Order # SO-000001' }) : el({ count: 1, visible: true, text: st.orderNumberText || 'Order # SO-778899' })) }) : el({ count: 1, visible: true, text: st.orderNumberText || 'Order # SO-778899' });
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
    ['checkout_total_ambiguous', { totalCount: 2 }], // hidden desktop/mobile duplicate
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
    const { st, deps } = fakeSiteOne();
    let calls = 0;
    const beforeSubmit = async (cents) => { calls += 1; return calls === 1 ? { ok: true } : { ok: false, reason: 'over_cap', message: `${cents} over the per-order cap` }; };
    await expect(s1.place(args({ beforeSubmit }), deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 10593 });
    expect(st.placeClicked).toBe(0);
    const first = fakeSiteOne();
    await expect(s1.place(args({ beforeSubmit: async () => ({ ok: false, reason: 'over_cap' }) }), first.deps)).rejects.toMatchObject({ refuse: 'over_cap', cents: 9900 });
  });

  test('an ambiguous submit (no confirmation number after the click) carries the checkout total the click happened at (pre-push P0)', async () => {
    const { st, deps } = fakeSiteOne({ orderNumberText: 'Thank you for your order' });
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

  test('a transient login navigation failure is one attempt of three, not a terminal failure (r4 P2)', async () => {
    const { st, deps } = fakeSiteOne({ gotoFailOnce: true });
    const r = await s1.place(args(), deps);
    expect(r).toMatchObject({ externalOrderNumber: 'SO-778899' });
    expect(st.loggedIn).toBe(true);
  });

  test('bill-to-account confirmed → checkout total cap-checked → one place-order click, cart left to the vendor', async () => {
    const { st, deps } = fakeSiteOne();
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
