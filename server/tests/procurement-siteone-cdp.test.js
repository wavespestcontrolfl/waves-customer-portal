/**
 * procurement/adapters/siteone-cdp — the SiteOne adapter that drives the
 * owner's own Chrome over CDP. A fake Chrome (browser / context / page /
 * locator objects over a tiny storefront model) stands in for the real one:
 * no real Chrome, no network, no DB.
 *
 * Proven here: every refusal parks with nothing submitted; the cart is only
 * touched for the line this run added; a dry run never clicks Place order;
 * a live click with no order number is ambiguous; the bot never closes the
 * owner's browser and never clicks "remove all".
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const adapter = require('../services/procurement/adapters/siteone-cdp');

const S = adapter._internals.SELECTORS;
const SKU = '82003599';
const ENV = Object.freeze({
  SITEONE_CDP_URL: 'http://127.0.0.1:9222',
  SITEONE_APPROVED_STORE_ID: '238',
  SITEONE_APPROVED_PICKUP: '#238,5115 Lena Rd',
  SITEONE_BOT_DRY_RUN: 'false',
});
const OPTS = { settleMs: 0, confirmStep: 1 };

// ---- fake storefront ----------------------------------------------------------

const el = (spec = {}) => ({ visible: true, text: '', attrs: {}, value: '', checked: false, enabled: true, children: {}, ...spec });

function makeWorld(over = {}) {
  const w = {
    url: 'about:blank', clicks: [], fills: [], gotos: [], cart: [], po: '', step: 'order-type', radioChecked: false,
    signedOut: false, signInFails: false, identifierValue: 'owner-prefilled', closeCalls: 0, pageCloseCalls: 0,
    brandText: `CSI-PEST : ${SKU}`, formSku: SKU, formStore: '238', uomRows: [], searchHits: 1,
    pickupClass: 'cart-top-fulfillment-method__tile fullfillment-pickup fullfilment-select', pickupText: 'Pickup #238,5115 Lena Rd',
    cartTotalText: '$105.93', addBehavior: 'normal', checkoutLocText: 'Pickup at #238, 5115 Lena Rd',
    reviewBody: 'Review your order. Reference 5500990. Store 238.', reviewTenderText: 'Payment Method Pay At branch, Lakewood Ranch 238',
    reviewPickupText: 'Pickup Lakewood Ranch 238', hideTender: false, oktaAction: 'https://www.siteone.com/en/login', oktaFormMissing: false, oktaButtonForm: 'same', oktaButtonFormAction: null, confirmEverywhere: false, confirmationField: true, poOccupied: '', signInUrl: null,
    checkoutUrl: null, confirmUrl: null, reviewCode: `Item # : ${SKU}`, reviewQtyText: 'Qty: 2',
    reviewQtyNode: true, closeOrder: [], reviewTotalText: '$110.40', placeButtons: 1, cardField: false, noRadioCheck: false,
    confirmationBody: 'Order Number: 7700123', noConfirmation: false, placeClickThrows: false, placed: 0, qty: 0,
    formA: { id: 'a' }, formB: { id: 'b' },
    ...over,
  };
  w.cartRowEls = () => w.cart.map((row) => el({
    attrs: { 'data-itemnumber': row.sku, 'data-requestedqty': String(row.qty) },
    children: {
      [S.cartQtyInput]: [el({ value: String(row.qty) })],
      [S.cartRemoveLine]: [el({ name: `remove:${row.sku}`, onClick: () => { w.cart = w.cart.filter((r) => r !== row); } })],
    },
  }));
  return w;
}

function screens(w) {
  const go = (path) => () => { w.url = `https://www.siteone.com${path}`; };
  const cart = {
    [S.cartRow]: w.cartRowEls(),
    [S.pickupTile]: [el({ attrs: { class: w.pickupClass }, text: w.pickupText })],
    [S.cartTotal]: [el({ text: w.cartTotalText })],
    [S.continueCheckout]: [el({ name: 'continue-checkout', onClick: () => { w.url = w.checkoutUrl || 'https://www.siteone.com/en/checkout/multi/siteOne-checkout'; } })],
  };
  const payment = w.step === 'payment' ? {
    [S.payAtBranchLabel]: [el({ name: 'label:PAY_AT_BRANCH', onClick: () => { w.radioChecked = !w.noRadioCheck; } })],
    [S.payAtBranchRadio]: [el({ visible: false, checked: w.radioChecked })],
    [S.paymentBlockers]: w.cardField ? [el({ name: 'card-field' })] : [],
    [S.reviewButton]: [el({ name: 'review-your-order', onClick: go('/en/checkout/multi/order-summary/view') })],
  } : {};
  const checkout = {
    [S.orderTypeForm]: [el({ visible: false })],
    [S.pickupLocation]: [el({ text: w.checkoutLocText })],
    [S.checkoutStoreId]: [el({ visible: false, value: '238' })],
    [S.poInput]: [el({ value: w.po || w.poOccupied, onFill: (v) => { w.po = v; w.poOccupied = ''; } })],
    [S.orderTypeSubmit]: [el({ name: 'order-type-submit', onClick: () => { w.step = 'payment'; } })],
    ...payment,
  };
  const placeBtn = () => el({ name: 'place-order', text: 'Place Your Order', onClick: () => { w.placed += 1; if (w.placeClickThrows) throw new Error('Target page closed'); if (!w.noConfirmation) { w.url = w.confirmUrl || 'https://www.siteone.com/en/checkout/orderConfirmation/7700123'; } } });
  const review = {
    [S.body]: [el({ text: w.reviewBody })],
    [S.reviewTender]: w.hideTender ? [] : [el({ text: w.reviewTenderText })],
    [S.reviewPickup]: [el({ text: w.reviewPickupText })],
    [S.reviewItemCode]: [el({ text: w.reviewCode, children: { [S.reviewItemBlock]: [el({ children: { [S.reviewQty]: w.reviewQtyNode ? [el({ text: w.reviewQtyText })] : [] } })] } })],
    [S.reviewTotal]: [el({ text: w.reviewTotalText })],
    [S.placeOrder]: Array.from({ length: w.placeButtons }, placeBtn),
  };
  const confirmation = { [S.body]: [el({ text: w.confirmationBody })], ...(w.confirmationField ? { [S.confirmationNumber]: [el({ text: w.confirmationBody })] } : {}), [S.heading]: [el({ text: 'Order Received' })] };
  const product = {
    [S.brandItemNumber]: [el({ text: w.brandText })],
    [S.formBrandItemNumber]: [el({ visible: false, value: w.formSku })],
    [S.formStoreId]: [el({ visible: false, value: w.formStore })],
    [S.uomRow]: w.uomRows.map((r) => el({ attrs: {}, text: r.label })),
    [S.uomSelected]: w.uomRows.filter((r) => r.selected).map((r) => el({ attrs: { 'data-inventorymultiplier': String(r.mult) } })),
    [S.pdpQty]: [el({ onFill: (v) => { w.qty = Number(v); } })],
    [S.addToCart]: [el({ name: 'add-to-cart', onClick: () => {
      w.cart.push({ sku: SKU, qty: w.addBehavior === 'wrongQty' ? w.qty + 1 : w.qty });
      if (w.addBehavior === 'extraRow') w.cart.push({ sku: 'OTHER-1', qty: 1 });
    } })],
  };
  const search = { [S.searchResult]: Array.from({ length: w.searchHits }, () => el({ attrs: { href: '/p/PRODUCT-1' } })) };
  // What the browser would report: the form owner and the RESOLVED submission URL.
  const formA = w.oktaFormMissing ? null : w.formA; // one DOM object per form, stable across reads
  const buttonForm = w.oktaButtonForm === 'same' ? formA : w.formB;
  const submitUrl = w.oktaButtonFormAction ?? w.oktaAction;
  const okta = {
    [S.oktaIdentifier]: [el({ value: w.identifierValue, dom: { form: formA } })],
    [S.oktaSubmit]: [el({ name: 'okta-sign-in', dom: { form: buttonForm, formAction: submitUrl }, onClick: () => { if (!w.signInFails) w.signedOut = false; } })],
  };
  const byPath = { '/en/cart': cart, '/en/checkout/multi/siteOne-checkout': checkout, '/en/checkout/multi/order-summary/view': review, '/en/search': search, '/p/PRODUCT-1': product };
  return { byPath, okta, confirmation };
}

function collection(els) {
  return { count: async () => els.length, nth: (i) => wrap(els[i]) };
}
function wrap(spec) {
  return {
    isVisible: async () => spec.visible,
    isEnabled: async () => spec.enabled,
    isChecked: async () => spec.checked,
    innerText: async () => spec.text,
    inputValue: async () => spec.value,
    getAttribute: async (name) => (name in spec.attrs ? spec.attrs[name] : null),
    click: async () => { if (spec.name) spec.world?.clicks.push(spec.name); if (spec.onClick) spec.onClick(); },
    fill: async (v) => { if (spec.onFill) spec.onFill(v); },
    locator: (sel) => collection(spec.children[sel] || []),
    elementHandle: async () => ({ dom: spec.dom || {}, dispose: async () => {} }),
  };
}

function makeBrowser(w) {
  const tag = (specs) => specs.map((s) => Object.assign(s, { world: w }));
  const tagAll = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, tag(v).map((s) => { Object.values(s.children).forEach((c) => tag(c)); return s; })]));
  const current = () => {
    const { byPath, okta, confirmation } = screens(w);
    if (w.signedOut) return tagAll(okta);
    let path = '/';
    try { path = new URL(w.url).pathname; } catch { path = '/'; }
    if (path.startsWith('/en/checkout/orderConfirmation/') || (w.confirmEverywhere && !byPath[path])) return tagAll(confirmation);
    return tagAll(byPath[path] || {});
  };
  const page = {
    url: () => (w.signedOut && w.signInUrl ? w.signInUrl : w.url),
    goto: async (url) => { w.gotos.push(url); w.url = url; },
    waitForTimeout: async () => {},
    setDefaultTimeout: () => {},
    locator: (sel) => collection(current()[sel] || []),
    close: async () => { w.pageCloseCalls += 1; w.closeOrder.push('page'); },
    evaluate: async (fn, arg) => fn(arg.map((h) => h.dom)),
  };
  const browser = {
    contexts: () => [{ newPage: async () => page }],
    close: async () => { w.closeCalls += 1; w.closeOrder.push('browser'); },
  };
  return { browser, page };
}

async function run(over = {}, { env = ENV, args = {}, verdicts, onCall } = {}) {
  const w = makeWorld(over);
  const { browser } = makeBrowser(w);
  const calls = [];
  const beforeSubmit = jest.fn(async (cents) => {
    calls.push(cents);
    if (onCall) onCall(calls.length, w);
    const v = verdicts ? verdicts[calls.length - 1] : { ok: true };
    return v || { ok: true };
  });
  let result;
  let error;
  try {
    result = await adapter.place({ vendorSku: SKU, quantity: 2, beforeSubmit, ...args }, { env, connect: async () => browser, ...OPTS });
  } catch (e) { error = e; }
  return { w, result, error, beforeSubmit, calls };
}

// Invariants that hold on EVERY run.
function expectSafe(w) {
  // Our own page closes first, then our connection drops (browser.close() on a
  // CDP browser only disconnects — playwright-core 1.59.1, see the adapter header).
  expect(w.closeOrder).toEqual(['page', 'browser']);
  expect(w.pageCloseCalls).toBe(1);
  expect(w.clicks.some((c) => /remove-all/.test(c))).toBe(false);
}

// ---- tests -----------------------------------------------------------------------

test('contract: no static quote, packaged quantity, no stored login; selectors never name remove-all', () => {
  expect(adapter).toMatchObject({ key: 'siteone-cdp', quotesAtPlace: true, packagedQuantity: true, acceptsPoNumber: true, loginRequired: false, preSubmitTotal: 'vendor' });
  expect(typeof adapter.place).toBe('function');
  expect(adapter.quote()).toBeNull();
  expect(Object.isFrozen(S)).toBe(true);
  expect(Object.values(S).join(' ')).not.toMatch(/remove-all-items-cart/);
});

test('configured() is false without SITEONE_CDP_URL, store id or pickup', () => {
  expect(adapter.configured({})).toBe(false);
  expect(adapter.configured({ ...ENV, SITEONE_CDP_URL: '' })).toBe(false);
  expect(adapter.configured({ ...ENV, SITEONE_APPROVED_STORE_ID: '' })).toBe(false);
  expect(adapter.configured({ ...ENV, SITEONE_APPROVED_PICKUP: ' , ' })).toBe(false);
  expect(adapter.configured(ENV)).toBe(true);
  const saved = process.env.SITEONE_CDP_URL;
  delete process.env.SITEONE_CDP_URL;
  expect(adapter.configured()).toBe(false);
  if (saved !== undefined) process.env.SITEONE_CDP_URL = saved;
});

test('brand-prefixed item number parses to the part after the last colon', () => {
  const { itemNumberAfterColon } = adapter._internals;
  expect(itemNumberAfterColon('CSI-PEST : 82003599')).toBe('82003599');
  expect(itemNumberAfterColon('A : B : 123')).toBe('123');
  expect(itemNumberAfterColon('82003599')).toBe('82003599');
});

test('happy live path: one add, pay at branch, one Place click, order number + review total', async () => {
  const { w, result, calls } = await run({}, { args: { poNumber: 'PO-77' } });
  expect(result).toMatchObject({ externalOrderNumber: '7700123', amountCents: 11040, dryRun: false });
  expect(result.evidence).toMatchObject({ shownItemNumber: SKU, formItemNumber: SKU, uom: 'single_unit', cartTotalCents: 10593, reviewTotalCents: 11040 });
  expect(calls).toEqual([10593, 11040, 11040]); // cart pre-check, the review total, then the claim re-asserted at the click
  expect(w.placed).toBe(1);
  expect(w.po).toBe('PO-77');
  expect(w.cart).toEqual([{ sku: SKU, qty: 2 }]); // submitted: nothing cleaned up
  expectSafe(w);
});

test('brandItemNumber (hidden) mismatch refuses sku_mismatch and adds nothing', async () => {
  const { w, error } = await run({ formSku: '99999999' });
  expect(error.refuse).toBe('sku_mismatch');
  expect(w.cart).toEqual([]);
  expect(w.clicks).not.toContain('add-to-cart');
  expectSafe(w);
});

test('shown item number mismatch refuses sku_mismatch', async () => {
  const { w, error } = await run({ brandText: 'CSI-PEST : 11111111' });
  expect(error.refuse).toBe('sku_mismatch');
  expect(w.clicks).not.toContain('add-to-cart');
  expectSafe(w);
});

test('search that does not show exactly one result refuses sku_not_found', async () => {
  expect((await run({ searchHits: 0 })).error.refuse).toBe('sku_not_found');
  expect((await run({ searchHits: 2 })).error.refuse).toBe('sku_not_found');
});

test('storeId mismatch refuses store_mismatch', async () => {
  const { w, error } = await run({ formStore: '104' });
  expect(error.refuse).toBe('store_mismatch');
  expect(w.clicks).not.toContain('add-to-cart');
  expectSafe(w);
});

test('Case / Pallet unit of measure refuses uom_mismatch; Each / Bag passes', async () => {
  const caseRun = await run({ uomRows: [{ label: 'Each', mult: 1 }, { label: 'Case(4)', mult: 4, selected: true }] });
  expect(caseRun.error.refuse).toBe('uom_mismatch');
  expect(caseRun.w.clicks).not.toContain('add-to-cart');
  expect((await run({ uomRows: [{ label: 'Pallet(180)', mult: 180, selected: true }] })).error.refuse).toBe('uom_mismatch');
  expect((await run({ uomRows: [{ label: 'Each', mult: 1, selected: true }, { label: 'Case(4)', mult: 4 }] })).result.evidence.uom).toBe('multiplier_1');
});

test('a non-empty cart refuses cart_not_empty and touches nothing', async () => {
  const { w, error } = await run({ cart: [{ sku: 'PHONE-APP-1', qty: 3 }] });
  expect(error.refuse).toBe('cart_not_empty');
  expect(w.clicks).toEqual([]);
  expect(w.cart).toEqual([{ sku: 'PHONE-APP-1', qty: 3 }]);
  expect(w.gotos).toEqual(['https://www.siteone.com/en/cart']);
  expectSafe(w);
});

test('cart mismatch removes ONLY our row (when it is exactly what we added) and refuses cart_mismatch', async () => {
  // A quantity that is not what we set belongs to the owner now: left alone.
  const wrong = await run({ addBehavior: 'wrongQty' });
  expect(wrong.error.refuse).toBe('cart_mismatch');
  expect(wrong.w.cart).toEqual([{ sku: SKU, qty: 3 }]);
  expect(wrong.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(wrong.error.evidence).toMatchObject({ cleanup: 'cart_left_for_owner', cart_left_for_owner: true });
  expect(wrong.w.clicks).not.toContain('continue-checkout');
  // Someone else's line appears beside ours: theirs stays.
  const extra = await run({ addBehavior: 'extraRow' });
  expect(extra.error.refuse).toBe('cart_mismatch');
  expect(extra.w.cart).toEqual([{ sku: 'OTHER-1', qty: 1 }]);
  expect(extra.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([`remove:${SKU}`]);
  expectSafe(wrong.w);
  expectSafe(extra.w);
});

test('pickup tile not selected / wrong branch refuses pickup_not_selected and cleans up', async () => {
  const unselected = await run({ pickupClass: 'cart-top-fulfillment-method__tile fullfillment-pickup' });
  expect(unselected.error.refuse).toBe('pickup_not_selected');
  expect(unselected.w.cart).toEqual([]);
  expect(unselected.w.clicks).not.toContain('continue-checkout');
  const wrongBranch = await run({ pickupText: 'Pickup #104,1 Other Rd' });
  expect(wrongBranch.error.refuse).toBe('pickup_not_selected');
  expectSafe(unselected.w);
});

test('a review page that is not Pay at Branch refuses and cleans up', async () => {
  const { w, error } = await run({ reviewTenderText: 'Payment Method Credit Card, Lakewood Ranch 238' });
  expect(error.refuse).toBe('not_pay_at_branch');
  expect(w.placed).toBe(0);
  expect(w.cart).toEqual([]);
  expectSafe(w);
});

test('a payment step whose radio does not check refuses not_pay_at_branch', async () => {
  const { w, error } = await run({ noRadioCheck: true });
  expect(error.refuse).toBe('not_pay_at_branch');
  expect(w.clicks).not.toContain('review-your-order');
  expectSafe(w);
});

test('a card / CVV / MFA field on the payment step refuses payment_prompt', async () => {
  const { w, error } = await run({ cardField: true });
  expect(error.refuse).toBe('payment_prompt');
  expect(w.clicks).not.toContain('label:PAY_AT_BRANCH');
  expect(w.cart).toEqual([]);
  expectSafe(w);
});

test('review item / quantity mismatches refuse', async () => {
  const item = await run({ reviewCode: 'Item # : 55555555' });
  expect(item.error.refuse).toBe('review_item_mismatch');
  const qty = await run({ reviewQtyText: 'Qty: 3' });
  expect(qty.error.refuse).toBe('review_qty_mismatch');
  const unreadable = await run({ reviewQtyNode: false });
  expect(unreadable.error.refuse).toBe('review_qty_unreadable');
  for (const r of [item, qty, unreadable]) { expect(r.w.placed).toBe(0); expect(r.w.cart).toEqual([]); expectSafe(r.w); }
});

test('beforeSubmit not ok at the cart refuses with its reason, before checkout', async () => {
  const { w, error } = await run({}, { verdicts: [{ ok: false, reason: 'over_per_order_cap' }] });
  expect(error.refuse).toBe('over_per_order_cap');
  expect(error.cents).toBe(10593);
  expect(w.clicks).not.toContain('continue-checkout');
  expect(w.cart).toEqual([]);
  expectSafe(w);
});

test('beforeSubmit not ok on the review total refuses, never clicks Place order, and cleans up', async () => {
  const { w, error, calls } = await run({}, { args: { poNumber: 'PO-9' }, verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }] });
  expect(error.refuse).toBe('over_monthly_cap');
  expect(error.cents).toBe(11040);
  expect(calls).toEqual([10593, 11040]);
  expect(w.placed).toBe(0);
  expect(w.po).toBe(''); // the PO we typed is cleared
  expect(w.cart).toEqual([]);
  expectSafe(w);
});

test('a cap check that throws is run-level, not a parked order', async () => {
  const w = makeWorld();
  const { browser } = makeBrowser(w);
  const beforeSubmit = async () => { throw new Error('db down'); };
  await expect(adapter.place({ vendorSku: SKU, quantity: 2, beforeSubmit }, { env: ENV, connect: async () => browser, ...OPTS })).rejects.toMatchObject({ runLevel: true });
  expect(w.cart).toEqual([]);
  expectSafe(w);
});

test('dry run never clicks Place order and removes only our row', async () => {
  const { w, result } = await run({}, { env: { ...ENV, SITEONE_BOT_DRY_RUN: 'true' }, args: { poNumber: 'PO-5' } });
  expect(result).toMatchObject({ dryRun: true, amountCents: 11040, externalOrderNumber: null });
  expect(result.evidence).toMatchObject({ reviewTotalCents: 11040, reviewItem: SKU, placeButton: 'place your order', cleanup: 'row_removed', poCleared: true });
  expect(w.placed).toBe(0);
  expect(w.po).toBe('');
  expect(w.cart).toEqual([]);
  expect(w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([`remove:${SKU}`]);
  expectSafe(w);
});

test('dry run is the default: unset, empty, "FALSE" and an explicit dryRun all stay dry', async () => {
  for (const flag of [undefined, '', 'FALSE', '0', 'no']) {
    const env = { ...ENV };
    if (flag === undefined) delete env.SITEONE_BOT_DRY_RUN; else env.SITEONE_BOT_DRY_RUN = flag;
    const r = await run({}, { env });
    expect(r.result.dryRun).toBe(true);
    expect(r.w.placed).toBe(0);
  }
  const r = await run({}, { args: { dryRun: true } });
  expect(r.result.dryRun).toBe(true);
  expect(r.w.placed).toBe(0);
});

test('live click with no order number is ambiguous, never re-clicked, and leaves the order alone', async () => {
  const { w, error } = await run({ noConfirmation: true }, { args: { poNumber: 'PO-3' } });
  expect(error.ambiguous).toBe(true);
  expect(error.evidence).toMatchObject({ poNumber: 'PO-3' });
  expect(error.evidence.url).toMatch(/order-summary/);
  expect(w.placed).toBe(1);
  expect(w.cart).toEqual([{ sku: SKU, qty: 2 }]); // submitted: no cleanup
  expect(w.po).toBe('PO-3');
  expectSafe(w);
});

test('an error after the Place click is ambiguous', async () => {
  const { w, error } = await run({ placeClickThrows: true });
  expect(error.ambiguous).toBe(true);
  expect(w.placed).toBe(1);
  expect(w.cart).toEqual([{ sku: SKU, qty: 2 }]);
  expectSafe(w);
});

test('a confirmation that shows our PO or two different numbers is not read as an order number', () => {
  const { orderNumberIn } = adapter._internals;
  expect(orderNumberIn('Order Number: 7700123', null)).toBe('7700123');
  expect(orderNumberIn('Order # PO-3 placed', 'PO-3')).toBeNull();
  expect(orderNumberIn('Order Number: 7700123 and Confirmation # 8800456', null)).toBeNull();
  expect(orderNumberIn('Order confirmation. Thank you', null)).toBeNull();
});

test('Chrome unreachable is run-level; a non-local DevTools URL is run-level and never connected', async () => {
  const w = makeWorld();
  const down = jest.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9222'); });
  await expect(adapter.place({ vendorSku: SKU, quantity: 2, beforeSubmit: async () => ({ ok: true }) }, { env: ENV, connect: down, ...OPTS })).rejects.toMatchObject({ runLevel: true });
  const remote = jest.fn();
  await expect(adapter.place({ vendorSku: SKU, quantity: 2, beforeSubmit: async () => ({ ok: true }) }, { env: { ...ENV, SITEONE_CDP_URL: 'http://203.0.113.9:9222' }, connect: remote, ...OPTS })).rejects.toMatchObject({ runLevel: true });
  expect(remote).not.toHaveBeenCalled();
  expect(w.closeCalls).toBe(0);
});

test('Okta sign-in: one click on the prefilled form; still signed out, or not prefilled, is run-level', async () => {
  const ok = await run({ signedOut: true });
  expect(ok.result.dryRun).toBe(false);
  expect(ok.w.clicks.filter((c) => c === 'okta-sign-in').length).toBeGreaterThanOrEqual(1);
  expectSafe(ok.w);
  const stuck = await run({ signedOut: true, signInFails: true });
  expect(stuck.error.runLevel).toBe(true);
  expect(stuck.w.cart).toEqual([]);
  const empty = await run({ signedOut: true, identifierValue: '' });
  expect(empty.error.runLevel).toBe(true);
  expect(empty.w.clicks).not.toContain('okta-sign-in');
  expectSafe(stuck.w);
  expectSafe(empty.w);
});

test('bad arguments refuse before any browser work', async () => {
  const connect = jest.fn();
  const base = { vendorSku: SKU, quantity: 2, beforeSubmit: async () => ({ ok: true }) };
  await expect(adapter.place({ ...base, vendorSku: '' }, { env: ENV, connect })).rejects.toMatchObject({ refuse: 'no_sku' });
  await expect(adapter.place({ ...base, quantity: 1.5 }, { env: ENV, connect })).rejects.toMatchObject({ refuse: 'bad_quantity' });
  await expect(adapter.place({ ...base, poNumber: 'lower case!' }, { env: ENV, connect })).rejects.toMatchObject({ refuse: 'bad_po_number' });
  await expect(adapter.place({ ...base, beforeSubmit: undefined }, { env: ENV, connect })).rejects.toMatchObject({ refuse: 'no_cap_check' });
  expect(connect).not.toHaveBeenCalled();
});

// ---- pre-push Codex round: P0 1-5, P1 x2 -----------------------------------------

test('P0 1: sign-in is clicked only on an approved identity-provider origin with an approved form action', async () => {
  const { isApprovedSignInOrigin } = adapter._internals;
  expect(isApprovedSignInOrigin('https://www.siteone.com/login', {})).toBe(true);
  expect(isApprovedSignInOrigin('https://sso.siteone.com/login', {})).toBe(true);
  for (const bad of ['http://www.siteone.com/', 'https://siteone.com.evil.example/', 'https://evilsiteone.com/', 'https://www.siteone.com:8443/', 'https://login.example-idp.test/']) {
    expect(isApprovedSignInOrigin(bad, {})).toBe(false);
  }
  // An exact Okta host is added by env, https only.
  expect(isApprovedSignInOrigin('https://login.example-idp.test/x', { SITEONE_SIGN_IN_ORIGINS: 'https://login.example-idp.test' })).toBe(true);
  expect(isApprovedSignInOrigin('http://login.example-idp.test/x', { SITEONE_SIGN_IN_ORIGINS: 'http://login.example-idp.test' })).toBe(false);
  expect(isApprovedSignInOrigin('https://other.example-idp.test/x', { SITEONE_SIGN_IN_ORIGINS: 'https://login.example-idp.test' })).toBe(false);

  const offOrigin = await run({ signedOut: true, signInUrl: 'https://siteone.com.evil.example/login' });
  expect(offOrigin.error.runLevel).toBe(true);
  expect(offOrigin.w.clicks).not.toContain('okta-sign-in');
  const badAction = await run({ signedOut: true, oktaAction: 'https://evil.example/collect' });
  expect(badAction.error.runLevel).toBe(true);
  expect(badAction.w.clicks).not.toContain('okta-sign-in');
  const noForm = await run({ signedOut: true, oktaFormMissing: true });
  expect(noForm.error.runLevel).toBe(true);
  expect(noForm.w.clicks).not.toContain('okta-sign-in');
  const okIdp = await run({ signedOut: true, signInUrl: 'https://login.example-idp.test/signin' }, { env: { ...ENV, SITEONE_SIGN_IN_ORIGINS: 'https://login.example-idp.test' } });
  expect(okIdp.result.dryRun).toBe(false);
  expect(okIdp.w.clicks).toContain('okta-sign-in');
  for (const r of [offOrigin, badAction, noForm, okIdp]) expectSafe(r.w);
});

test('P0 2: transitions parse the URL: exact origin and pathname, never a substring', async () => {
  const lookalike = await run({ checkoutUrl: 'https://www.siteone.com.evil.example/en/checkout/multi/siteOne-checkout' });
  expect(lookalike.error.runLevel).toBe(true);
  expect(lookalike.w.clicks).not.toContain('order-type-submit');
  const queryTrick = await run({ checkoutUrl: 'https://www.siteone.com/other?next=/en/checkout/multi/siteOne-checkout' });
  expect(queryTrick.error.refuse).toBe('page_unrecognized');
  expect(queryTrick.w.clicks).not.toContain('order-type-submit');
  const suffix = await run({ checkoutUrl: 'https://www.siteone.com/en/checkout/multi/siteOne-checkout-evil' });
  expect(suffix.error.refuse).toBe('page_unrecognized');
  // Right before the Place click the page is on the wrong origin: nothing clicked.
  const atClick = await run({}, { onCall: (n, w) => { if (n === 3) w.url = 'https://evil.example/en/checkout/multi/order-summary/view'; } });
  expect(atClick.error.runLevel).toBe(true);
  expect(atClick.w.placed).toBe(0);
  const wrongPath = await run({}, { onCall: (n, w) => { if (n === 3) w.url = 'https://www.siteone.com/en/checkout/multi/order-summary/view/extra'; } });
  expect(wrongPath.w.placed).toBe(0);
  expect(wrongPath.error.ambiguous).toBeUndefined();
  for (const r of [lookalike, queryTrick, suffix, atClick, wrongPath]) { expect(r.w.placed).toBe(0); expectSafe(r.w); }
});

test('P0 3: the reservation is bound to the click: a changed total, item, quantity, tender or pickup refuses with no click', async () => {
  const changes = {
    total: (w) => { w.reviewTotalText = '$150.00'; },
    quantity: (w) => { w.reviewQtyText = 'Qty: 3'; },
    item: (w) => { w.reviewCode = 'Item # : 55555555'; },
    tender: (w) => { w.reviewTenderText = 'Payment Method Credit Card, Lakewood Ranch 238'; },
    pickup: (w) => { w.reviewPickupText = 'Pickup Other Branch 104'; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const r = await run({}, { onCall: (n, w) => { if (n === 3) change(w); } });
    expect(r.error.refuse).toBeTruthy();
    expect(r.error.ambiguous).toBeUndefined();
    expect(r.w.placed).toBe(0);
    expect(r.w.cart).toEqual([]);
    expectSafe(r.w);
    if (name !== 'total') continue;
    expect(r.error.refuse).toBe('review_changed');
  }
  // The claim is re-asserted at the click; if it is lost, nothing is clicked.
  const lost = await run({}, { verdicts: [{ ok: true }, { ok: true }, { ok: false, reason: 'claim_lost' }] });
  expect(lost.error.refuse).toBe('claim_lost');
  expect(lost.w.placed).toBe(0);
});

test('P0 4: tender and pickup come from their own review fields; unreadable fields refuse', async () => {
  const noField = await run({ hideTender: true });
  expect(noField.error.refuse).toBe('review_fields_unreadable');
  // Pay at Branch in a stray part of the page does not count.
  const stray = await run({ reviewTenderText: 'Payment Method Credit Card', reviewBody: 'Pay At branch Lakewood Ranch 238 Reference 5500990' });
  expect(stray.error.refuse).toBe('not_pay_at_branch');
  const lookalike = await run({ reviewTenderText: 'Payment Method Pay At Branch Plus, Lakewood Ranch 238' });
  expect(lookalike.error.refuse).toBe('not_pay_at_branch');
  const store = await run({ reviewPickupText: 'Pickup Lakewood Ranch 2385' });
  expect(store.error.refuse).toBe('pickup_not_selected');
  const okLabel = await run({ reviewTenderText: 'Pay At branch, Lakewood Ranch 238' });
  expect(okLabel.result.dryRun).toBe(false);
  for (const r of [noField, stray, lookalike, store]) { expect(r.w.placed).toBe(0); expect(r.w.cart).toEqual([]); expectSafe(r.w); }
});

test('P0 5: only a NEW number on a siteone.com page that is no longer the review page is an order number', async () => {
  // The number was already on the review page before the click: not new.
  const old = await run({ confirmationBody: 'Thank you. Order Number: 5500990', confirmUrl: 'https://www.siteone.com/en/checkout/orderConfirmation/5500990' });
  expect(old.error.ambiguous).toBe(true);
  expect(old.w.placed).toBe(1);
  // A number shown while the page is still the review page: not a confirmation.
  const stillReview = await run({ noConfirmation: true, reviewBody: 'Review. Reference 5500990.' });
  expect(stillReview.error.ambiguous).toBe(true);
  // A confirmation on another origin: ambiguous.
  const offSite = await run({ confirmUrl: 'https://www.siteone.com.evil.example/en/checkout/orderConfirmation/7700123' });
  expect(offSite.error.ambiguous).toBe(true);
  expect(offSite.error.evidence.url).toBe('/en/checkout/orderConfirmation/7700123');
  // Our own PO is never the number.
  const po = await run({ confirmationBody: 'Thank you. Order #: PO-8 placed', confirmUrl: 'https://www.siteone.com/en/checkout/orderConfirmation/PO-8' }, { args: { poNumber: 'PO-8' } });
  expect(po.error.ambiguous).toBe(true);
  const fresh = await run({ confirmationBody: 'Order Number: 7700123' });
  expect(fresh.result.externalOrderNumber).toBe('7700123');
  const { numberTokens } = adapter._internals;
  expect([...numberTokens('Reference 5500990, store 238, ship 1234-AB, Thank you')].sort()).toEqual(['1234-AB', '5500990']);
});

test('P1: cleanup removes our row only when its quantity is exactly what we added; otherwise it is left for the owner', async () => {
  // Merged / changed quantity after the add: left alone.
  const merged = await run({}, { verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }], onCall: (n, w) => { if (n === 2) w.cart[0].qty = 5; } });
  expect(merged.error.refuse).toBe('over_monthly_cap');
  expect(merged.w.cart).toEqual([{ sku: SKU, qty: 5 }]);
  expect(merged.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(merged.error.evidence.cart_left_for_owner).toBe(true);
  // A second line with our item number: ambiguous, left alone.
  const twice = await run({}, { verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }], onCall: (n, w) => { if (n === 2) w.cart.push({ sku: SKU, qty: 2 }); } });
  expect(twice.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(twice.error.evidence.cart_left_for_owner).toBe(true);
  // Exactly what we added: removed.
  const exact = await run({}, { verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }] });
  expect(exact.w.cart).toEqual([]);
  expect(exact.error.evidence.cart_left_for_owner).toBeUndefined();
  for (const r of [merged, twice, exact]) expectSafe(r.w);
});

test('P1: browser.close() is called once, after our own page closed; Chrome stays up (it only drops the CDP socket)', async () => {
  const r = await run({}, { env: { ...ENV, SITEONE_BOT_DRY_RUN: 'true' } });
  expect(r.w.closeOrder).toEqual(['page', 'browser']);
  expect(r.w.closeCalls).toBe(1);
});

// ---- round 3 -----------------------------------------------------------------------

test('R3 P0: the order number is read only on the vendor confirmation path (one segment), from its own node or the URL code', async () => {
  const { confirmationCodeOf } = adapter._internals;
  expect(confirmationCodeOf('/en/checkout/orderConfirmation/7700123')).toBe('7700123');
  expect(confirmationCodeOf('/en/checkout/orderConfirmation/so-778899')).toBe('SO-778899');
  for (const bad of ['/en/checkout/orderConfirmation/', '/en/checkout/orderConfirmation/7700123/extra', '/en/checkout/orderConfirmation', '/en/my-account/orders/7700123', '/en/checkout/orderConfirmationX/7700123', '/en/checkout/orderConfirmation/abcdefgh']) {
    expect(confirmationCodeOf(bad)).toBeNull();
  }
  // Field on the confirmation page wins; with no field the URL code is the number.
  const field = await run({ confirmationBody: 'Order Number: 8800456' });
  expect(field.result.externalOrderNumber).toBe('8800456');
  const urlOnly = await run({ confirmationField: false });
  expect(urlOnly.result.externalOrderNumber).toBe('7700123');
  // Any other destination (history, account page, a deeper path) is ambiguous, even with a fresh-looking number on it.
  for (const confirmUrl of ['https://www.siteone.com/en/my-account/orders/7700999', 'https://www.siteone.com/en/checkout/orderConfirmation/7700123/extra', 'https://www.siteone.com/en/checkout/multi/order-summary/view']) {
    const r = await run({ confirmUrl, confirmEverywhere: true, confirmationBody: 'Order Number: 7700999' });
    expect(r.error.ambiguous).toBe(true);
    expect(r.w.placed).toBe(1);
    expectSafe(r.w);
  }
});

test('R3 P0: sign-in needs one form owner and an approved browser-resolved submission URL', async () => {
  const split = await run({ signedOut: true, oktaButtonForm: 'other' });
  expect(split.error.runLevel).toBe(true);
  expect(split.w.clicks).not.toContain('okta-sign-in');
  // A button formaction overrides the form's action: the resolved URL is judged.
  const override = await run({ signedOut: true, oktaButtonFormAction: 'https://evil.example/collect' });
  expect(override.error.runLevel).toBe(true);
  expect(override.w.clicks).not.toContain('okta-sign-in');
  const lookalike = await run({ signedOut: true, oktaButtonFormAction: 'https://www.siteone.com.evil.example/login' });
  expect(lookalike.error.runLevel).toBe(true);
  const unresolved = await run({ signedOut: true, oktaButtonFormAction: '' , oktaAction: '' });
  expect(unresolved.error.runLevel).toBe(true);
  const relative = await run({ signedOut: true, oktaButtonFormAction: '/en/login' });
  expect(relative.error.runLevel).toBe(true); // the browser reports an absolute URL; a relative one is unproven
  const noForm = await run({ signedOut: true, oktaFormMissing: true });
  expect(noForm.error.runLevel).toBe(true);
  const good = await run({ signedOut: true });
  expect(good.w.clicks).toContain('okta-sign-in');
  for (const r of [split, override, lookalike, unresolved, relative, noForm, good]) expectSafe(r.w);
});

test('R3 P1: a PO box that already holds a value refuses; cleanup clears it only while it still equals our PO', async () => {
  const occupied = await run({ poOccupied: 'OWNER-123' }, { args: { poNumber: 'PO-4' } });
  expect(occupied.error.refuse).toBe('po_field_occupied');
  expect(occupied.w.poOccupied).toBe('OWNER-123'); // untouched
  expect(occupied.w.fills ?? []).toEqual([]);
  expect(occupied.w.cart).toEqual([]); // our row still removed
  // Our PO is cleared when it is still ours...
  const ours = await run({}, { args: { poNumber: 'PO-4' }, verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }] });
  expect(ours.w.po).toBe('');
  expect(ours.error.evidence.poCleared).toBe(true);
  // ...and left alone when it changed under us.
  const changed = await run({}, { args: { poNumber: 'PO-4' }, verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }], onCall: (n, w) => { if (n === 2) w.po = 'OWNER-999'; } });
  expect(changed.w.po).toBe('OWNER-999');
  expect(changed.error.evidence).toMatchObject({ poCleared: false, po_left_for_owner: true });
  for (const r of [occupied, ours, changed]) expectSafe(r.w);
});
