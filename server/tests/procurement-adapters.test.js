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
      if (sel.startsWith(S.loginPass)) return el({ count: st.loggedIn ? 0 : 1 });
      if (sel === S.loginSubmit) return el({ count: 1, onClick: () => { st.loggedIn = true; st.url = 'https://www.siteone.com/en/'; } });
      if (sel === S.loginError) return el();
      if (sel === S.searchInput) return el({ count: 1 });
      if (sel === S.productLink) return el({ count: 1 });
      if (sel === S.productSku) return el({ count: 1, text: 'SKU: S1-77' });
      if (sel === S.unavailable) return el();
      if (sel === S.qtyInput) return el({ count: 1, onFill: (v) => { st.qty = Number(v); } });
      if (sel === S.addToCart) return el({ count: 1, onClick: () => { st.addClicked += 1; st.cart.push({ sku: 'S1-77', qty: st.qty }); if (st.addExtra) st.cart.push(st.addExtra); } });
      if (sel === S.cartLine) return el({ count: st.cart.length, nth: (i) => line(st.cart[i]) });
      if (sel === S.cartRemove) return el({ count: st.cart.length && st.removable ? 1 : 0, onClick: () => { st.cart.shift(); } });
      if (sel === S.cartTotal) return el({ count: 1, text: '$99.00' });
      if (sel === S.checkoutButton) return el({ count: 1 });
      if (sel === S.mfaField || sel === S.cardField) return el();
      if (sel === S.termsCheckbox) return el();
      if (sel === S.billToAccount) return el({ count: 1, checked: st.accountChecked === true, onClick: () => { if (st.accountSelectable) st.accountChecked = true; } });
      if (sel === S.billToAccountSelected) return el({ count: st.accountChecked ? 1 : 0 });
      if (sel === S.checkoutAccount) return el({ count: st.accountCount ?? 1, text: st.accountText === undefined ? 'Account # 12345' : st.accountText });
      if (sel === S.checkoutShipTo) return el({ count: st.shipToCount ?? 1, text: st.shipToText === undefined ? 'Ship to: Waves Pest Control\n 123 Example Ave\n Bradenton, FL 34205' : st.shipToText });
      if (sel === S.checkoutTotal) return el({ count: 1, text: 'Order total $105.93' });
      if (sel === S.placeOrder) return el({ count: 1, onClick: () => { st.placeClicked += 1; } });
      if (sel === S.orderNumber) return el({ count: 1, text: 'Order # SO-778899' });
      return el();
    };
    const page = {
      goto: async (u) => { st.url = u; },
      url: () => st.url,
      evaluate: async () => 'ok',
      waitForFunction: async () => {},
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => Buffer.from('png'),
      locator: resolve,
    };
    const browser = { newContext: async () => ({ newPage: async () => page }), close: jest.fn(async () => {}) };
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

  test('bill-to-account must be CONFIRMED selected before the place-order click (r1 P1)', async () => {
    const { st, deps } = fakeSiteOne({ accountSelectable: false });
    await expect(s1.place(args(), deps)).rejects.toMatchObject({ refuse: 'bill_to_account_unverified' });
    expect(st.placeClicked).toBe(0);
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
