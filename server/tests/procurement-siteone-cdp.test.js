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
  SITEONE_APPROVED_ACCOUNT: '5550123',
  SITEONE_BOT_DRY_RUN: 'false',
});
const OPTS = { settleMs: 0, confirmStep: 1 };

// ---- fake storefront ----------------------------------------------------------

const el = (spec = {}) => ({ visible: true, text: '', attrs: {}, value: '', checked: false, enabled: true, children: {}, ...spec });
// A node whose text is read live (the browser's innerText), so a change after the node was found shows.
const live = (spec, read) => Object.defineProperty(spec, 'text', { configurable: true, get: read });

function makeWorld(over = {}) {
  const w = {
    url: 'about:blank', clicks: [], fills: [], gotos: [], cart: [], po: '', productAccountText: null, checkoutAccountText: null, rowReads: 0, onRowRead: null, handleClicks: [], locatorPlaceClicks: 0, placeBtns: null, tenderReads: 0, onTenderRead: null, signedOutHeader: false, signInText: 'Sign In', emptyText: 'Your cart is empty.', hideEmptyState: false, poDraft: null, poSticky: false, bodyThrows: false, entrySeq: 0, flipOnRead: 0, flipCount: 0, removeNoop: false, step: 'order-type', radioChecked: false,
    signedOut: false, signInFails: false, identifierValue: 'owner-prefilled', closeCalls: 0, pageCloseCalls: 0,
    brandText: `CSI-PEST : ${SKU}`, formSku: SKU, formStore: '238', uomRows: [], searchHits: 1,
    pickupClass: 'cart-top-fulfillment-method__tile fullfillment-pickup fullfilment-select', pickupText: 'Pickup #238,5115 Lena Rd',
    cartTotalText: '$105.93', addBehavior: 'normal', checkoutLocText: 'Pickup at #238, 5115 Lena Rd',
    reviewBody: 'Review your order. Reference 5500990. Store 238.', reviewTenderText: 'Payment Method Pay At branch, Lakewood Ranch 238',
    reviewPickupText: 'Pickup Lakewood Ranch 238', hideTender: false, confirmEverywhere: false, confirmationField: true, poOccupied: '', signInUrl: null, signOutAfter: null, accountText: 'Signed in as account 5550123', accountAttr: null, hideAccount: false,
    reviewAccountText: 'Bill to account 5550123', hideReviewAccount: false, locators: [],
    checkoutUrl: null, confirmUrl: null, reviewCode: `Item # : ${SKU}`, reviewQtyText: 'Qty: 2',
    reviewQtyNode: true, closeOrder: [], reviewTotalText: '$110.40', placeButtons: 1, cardField: false, noRadioCheck: false,
    confirmationBody: 'Order Number: 7700123', noConfirmation: false, placeClickThrows: false, placed: 0, qty: 0,
    ...over,
  };
  w.cartRowEls = () => w.cart.map((row) => el({
    // What the browser would give an evaluate over this row's handle (live, so a replaced row reads detached).
    dom: {
      getAttribute: (name) => {
        if (name === 'data-requestedqty') {
          if (w.flipOnRead) { w.flipCount += 1; if (w.flipCount === w.flipOnRead) row.qty = 9; }
          const v = String(row.qty);
          w.rowReads += 1;
          if (w.onRowRead) w.onRowRead(w.rowReads, w);
          return v;
        }
        return { 'data-itemnumber': row.sku, 'data-cartentry': row.entry || '' }[name] ?? null;
      },
      querySelector: () => ({ value: String(row.qty) }),
      get isConnected() { return w.cart.includes(row); },
      contains: (link) => link.owner === row,
    },
    attrs: {
      'data-itemnumber': row.sku,
      'data-cartentry': row.entry || '',
      // A getter: a test can flip the quantity between two reads of the same row.
      get 'data-requestedqty'() {
        if (w.flipOnRead) { w.flipCount += 1; if (w.flipCount === w.flipOnRead) row.qty = 9; }
        return String(row.qty);
      },
    },
    children: {
      [S.cartQtyInput]: [el({ value: String(row.qty) })],
      [S.cartRemoveLine]: [el({ dom: { owner: row, get isConnected() { return w.cart.includes(row); } }, name: `remove:${row.sku}`, onClick: () => { if (!w.removeNoop) w.cart = w.cart.filter((r) => r !== row); } })],
    },
  }));
  return w;
}

function screens(w) {
  const go = (path) => () => { w.url = `https://www.siteone.com${path}`; };
  const cart = {
    [S.cartRow]: w.cartRowEls(),
    [S.pickupTile]: [el({ attrs: { class: w.pickupClass }, text: w.pickupText })],
    [S.cartTotal]: w.cart.length ? [el({ text: w.cartTotalText })] : [], // not shown on an empty cart (walked live)
    [S.cartEmpty]: w.cart.length === 0 && !w.hideEmptyState ? [el({ text: w.emptyText })] : [],
    [S.accountNode]: w.hideAccount ? [] : [el({ text: w.accountText, attrs: w.accountAttr ? { 'data-account-number': w.accountAttr } : {} })],
    [S.continueCheckout]: [el({ name: 'continue-checkout', onClick: () => { w.url = w.checkoutUrl || 'https://www.siteone.com/en/checkout/multi/siteOne-checkout'; if (w.signOutAfter === 'continue') w.signedOut = true; } })],
  };
  const payment = w.step === 'payment' ? {
    [S.payAtBranchLabel]: [el({ name: 'label:PAY_AT_BRANCH', onClick: () => { w.radioChecked = !w.noRadioCheck; } })],
    [S.payAtBranchRadio]: [el({ visible: false, checked: w.radioChecked })],
    [S.paymentBlockers]: w.cardField ? [el({ name: 'card-field' })] : [],
    [S.reviewButton]: [el({ name: 'review-your-order', onClick: () => { go('/en/checkout/multi/order-summary/view')(); if (w.signOutAfter === 'review') w.signedOut = true; } })],
  } : {};
  const checkout = {
    [S.accountNode]: w.hideAccount ? [] : [el({ text: w.checkoutAccountText ?? w.accountText, attrs: w.accountAttr ? { 'data-account-number': w.accountAttr } : {} })],
    [S.orderTypeForm]: [el({ visible: false })],
    [S.pickupLocation]: [el({ text: w.checkoutLocText })],
    [S.checkoutStoreId]: [el({ visible: false, value: '238' })],
    [S.poInput]: [el({ value: w.poDraft ?? (w.po || w.poOccupied), onFill: (v) => { w.poDraft = v; w.fills.push(v); } })],
    [S.orderTypeSubmit]: [el({ name: 'order-type-submit', onClick: () => {
      // The PO is saved with the form; a sticky server ignores an empty save.
      if (w.poDraft != null && !(w.poSticky && w.poDraft === '')) { w.po = w.poDraft; w.poOccupied = ''; }
      w.poDraft = null;
      w.step = 'payment';
      if (w.signOutAfter === 'order-type') w.signedOut = true;
    } })],
    ...payment,
  };
  // The SAME element objects on every read, so a handle can be proven to be the same element.
  const placeBtns = () => { if (!w.placeBtns) w.placeBtns = Array.from({ length: w.placeButtons }, placeBtn); return w.placeBtns; };
  const placeBtn = () => el({ name: 'place-order', text: 'Place Your Order', onClick: () => { w.placed += 1; if (w.placeClickThrows) throw new Error('Target page closed'); if (!w.noConfirmation) { w.url = w.confirmUrl || 'https://www.siteone.com/en/checkout/orderConfirmation/7700123'; } } });
  const review = {
    [S.body]: [el({ text: w.reviewBody, throws: w.bodyThrows })],
    [S.reviewTender]: w.hideTender ? [] : [live(el({ onRead: () => { w.tenderReads += 1; if (w.onTenderRead) w.onTenderRead(w.tenderReads, w); } }), () => w.reviewTenderText)],
    [S.reviewPickup]: [live(el({}), () => w.reviewPickupText)],
    [S.reviewAccount]: w.hideReviewAccount ? [] : [el({ text: w.reviewAccountText })],
    [S.reviewItemCode]: [el({ text: w.reviewCode, children: { [S.reviewItemBlock]: [el({ children: { [S.reviewQty]: w.reviewQtyNode ? [el({ text: w.reviewQtyText })] : [] } })] } })],
    [S.reviewTotal]: [live(el({}), () => w.reviewTotalText)],
    [S.placeOrder]: placeBtns(),
  };
  const confirmation = { [S.body]: [el({ text: w.confirmationBody })], ...(w.confirmationField ? { [S.confirmationNumber]: [el({ text: w.confirmationBody })] } : {}), [S.heading]: [el({ text: 'Order Received' })] };
  const product = {
    [S.accountNode]: (w.productAccountText ?? w.accountText) === '' ? [] : [el({ text: w.productAccountText ?? w.accountText, attrs: w.accountAttr ? { 'data-account-number': w.accountAttr } : {} })],
    [S.brandItemNumber]: [el({ text: w.brandText })],
    [S.formBrandItemNumber]: [el({ visible: false, value: w.formSku })],
    [S.formStoreId]: [el({ visible: false, value: w.formStore })],
    [S.uomRow]: w.uomRows.map((r) => el({ attrs: {}, text: r.label })),
    [S.uomSelected]: w.uomRows.filter((r) => r.selected).map((r) => el({ attrs: { 'data-inventorymultiplier': String(r.mult) } })),
    [S.pdpQty]: [el({ onFill: (v) => { w.qty = Number(v); } })],
    [S.addToCart]: [el({ name: 'add-to-cart', onClick: () => {
      w.entrySeq += 1;
      w.cart.push({ sku: SKU, qty: w.addBehavior === 'wrongQty' ? w.qty + 1 : w.qty, entry: `E${w.entrySeq}` });
      if (w.addBehavior === 'noEntry') w.cart[w.cart.length - 1].entry = '';
      if (w.addBehavior === 'extraRow') w.cart.push({ sku: 'OTHER-1', qty: 1, entry: 'X1' });
    } })],
  };
  const search = { [S.searchResult]: Array.from({ length: w.searchHits }, () => el({ attrs: { href: '/p/PRODUCT-1' } })) };
  const okta = { [S.oktaIdentifier]: [el({ name: 'okta-identifier', value: w.identifierValue })] };
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
    innerText: async () => { if (spec.onRead) spec.onRead(); if (spec.throws) throw new Error('detached'); return spec.text; },
    inputValue: async () => spec.value,
    getAttribute: async (name) => (name in spec.attrs ? spec.attrs[name] : null),
    click: async () => { if (spec.name === 'place-order') spec.world.locatorPlaceClicks += 1; if (spec.name) spec.world?.clicks.push(spec.name); if (spec.onClick) spec.onClick(); },
    elementHandle: async () => {
      spec.dom = spec.dom || { isConnected: true };
      // What page.evaluate sees for this handle: live text, disabled state and a DOM click.
      if (!Object.getOwnPropertyDescriptor(spec.dom, 'innerText')) {
        Object.defineProperty(spec.dom, 'innerText', { configurable: true, get: () => { if (spec.onRead) spec.onRead(); return spec.text; } });
        Object.defineProperty(spec.dom, 'disabled', { configurable: true, get: () => !spec.enabled });
        // The page this node lives on, as the click step sees it: its URL and the shown matches of a selector.
        Object.defineProperty(spec.dom, 'ownerDocument', { configurable: true, get: () => ({
          location: { get href() { return spec.world.url; } },
          querySelectorAll: (sel) => (spec.world.currentScreen()[sel] || []).filter((n) => n.visible).map(() => ({ offsetParent: {} })),
        }) });
        spec.dom.click = () => { spec.world.handleClicks.push({ dom: true }); if (spec.name) spec.world.clicks.push(spec.name); if (spec.onClick) spec.onClick(); };
      }
      return {
        dom: spec.dom,
        isVisible: async () => spec.visible,
        isEnabled: async () => spec.enabled,
        click: async (opts) => { spec.world.handleClicks.push(opts); if (spec.name) spec.world.clicks.push(spec.name); if (spec.onClick) spec.onClick(); },
      };
    },
    fill: async (v) => { if (spec.onFill) spec.onFill(v); },
    locator: (sel) => collection(spec.children[sel] || []),
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
    const screen = tagAll(byPath[path] || {});
    if (w.signedOutHeader) screen[S.signInMarker] = tag([el({ text: w.signInText })]);
    return screen;
  };
  w.currentScreen = () => current();
  const page = {
    url: () => (w.signedOut && w.signInUrl ? w.signInUrl : w.url),
    goto: async (url) => { w.gotos.push(url); w.url = url; w.poDraft = null; },
    waitForTimeout: async () => {},
    setDefaultTimeout: () => {},
    locator: (sel) => {
      w.locators.push(sel);
      // A row bound to its cart entry: `.js-cart-items-row[data-cartentry="<id>"]`.
      const bound = sel.match(/^(.*)\[data-cartentry="([^"]+)"\]$/);
      if (bound && bound[1] === S.cartRow) return collection((current()[S.cartRow] || []).filter((r) => r.attrs['data-cartentry'] === bound[2]));
      return collection(current()[sel] || []);
    },
    close: async () => { w.pageCloseCalls += 1; w.closeOrder.push('page'); },
    // Handles anywhere in the argument (as Playwright serializes them) arrive as their DOM nodes.
    evaluate: async (fn, arg) => { const unwrap = (v) => (v && v.dom ? v.dom : Array.isArray(v) ? v.map(unwrap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)])) : v); return fn(unwrap(arg)); },
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
  expect(adapter.configured({ ...ENV, SITEONE_APPROVED_ACCOUNT: '' })).toBe(false);
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
  expect(w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'E1' }]); // submitted: nothing cleaned up
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
  expect(wrong.w.cart).toEqual([{ sku: SKU, qty: 3, entry: 'E1' }]);
  expect(wrong.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(wrong.error.evidence).toMatchObject({ cleanup: 'cart_left_for_owner', cart_left_for_owner: true });
  expect(wrong.w.clicks).not.toContain('continue-checkout');
  // Someone else's line appears beside ours: theirs stays.
  const extra = await run({ addBehavior: 'extraRow' });
  expect(extra.error.refuse).toBe('cart_mismatch');
  expect(extra.w.cart).toEqual([{ sku: 'OTHER-1', qty: 1, entry: 'X1' }]);
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
  expect(result.evidence).toMatchObject({ reviewTotalCents: 11040, reviewItem: SKU, placeButton: 'place your order', cleanup: 'row_removed', poSkipped: 'dry_run' });
  expect(w.fills).toEqual([]); // a dry run never types a PO
  expect(result.evidence.poCleared).toBeUndefined();
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
  expect(w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'E1' }]); // submitted: no cleanup
  expect(w.po).toBe('PO-3');
  expectSafe(w);
});

test('an error after the Place click is ambiguous', async () => {
  const { w, error } = await run({ placeClickThrows: true });
  expect(error.ambiguous).toBe(true);
  expect(w.placed).toBe(1);
  expect(w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'E1' }]);
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
  expect(merged.w.cart).toEqual([{ sku: SKU, qty: 5, entry: 'E1' }]);
  expect(merged.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(merged.error.evidence.cart_left_for_owner).toBe(true);
  // The owner adds another line of the same item: ours is found by its own cart entry, theirs stays.
  const twice = await run({}, { verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }], onCall: (n, w) => { if (n === 2) w.cart.push({ sku: SKU, qty: 2, entry: 'THEIRS' }); } });
  expect(twice.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([`remove:${SKU}`]);
  expect(twice.w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'THEIRS' }]);
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

test('R3 P1: a PO box that already holds a value refuses; cleanup clears it only while it still equals our PO', async () => {
  const occupied = await run({ poOccupied: 'OWNER-123' }, { args: { poNumber: 'PO-4' } });
  expect(occupied.error.refuse).toBe('po_field_occupied');
  expect(occupied.w.poOccupied).toBe('OWNER-123'); // untouched
  expect(occupied.w.fills).toEqual([]);
  expect(occupied.w.cart).toEqual([]); // our row still removed
  // Our PO is cleared when it is still ours...
  const ours = await run({}, { args: { poNumber: 'PO-4' }, verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }] });
  expect(ours.w.po).toBe('');
  expect(ours.error.evidence.poCleared).toBe(true);
  expect(ours.w.fills).toEqual(['PO-4', '']); // typed, then cleared through the form and verified after a reload
  // ...and left alone when it changed under us.
  const changed = await run({}, { args: { poNumber: 'PO-4' }, verdicts: [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }], onCall: (n, w) => { if (n === 2) w.po = 'OWNER-999'; } });
  expect(changed.w.po).toBe('OWNER-999');
  expect(changed.error.evidence.po_left_for_owner).toBe(true);
  expect(changed.error.evidence.poCleared).toBeUndefined(); // never a claim it was cleared
  for (const r of [occupied, ours, changed]) expectSafe(r.w);
});

// ---- round 4 -----------------------------------------------------------------------

test('R4 sign-in: the adapter never submits a sign-in form; any sign-in page stops the run, run-level', async () => {
  const MESSAGE = 'SiteOne signed Chrome out — sign in to siteone.com in Chrome on the Mac';
  const cases = [
    { signedOut: true }, // the Okta identifier box is shown
    { signedOut: true, signInFails: true },
    { signedOut: true, signInUrl: 'https://www.siteone.com/en/login' },
    { signedOut: true, signInUrl: 'https://login.example-idp.test/signin' },
    { signedOut: true, signInUrl: 'https://siteone.com.evil.example/login' },
  ];
  for (const over of cases) {
    const r = await run(over);
    expect(r.error.runLevel).toBe(true);
    expect(r.error.message).toBe(MESSAGE);
    expect(r.w.clicks).toEqual([]); // nothing clicked, nothing filled
    expect(r.w.fills).toEqual([]);
    expect(r.w.cart).toEqual([]);
    expectSafe(r.w);
  }
  // An exact identity-provider origin can no longer be allowed by env.
  const env = { ...ENV, SITEONE_SIGN_IN_ORIGINS: 'https://login.example-idp.test' };
  const r = await run({ signedOut: true, signInUrl: 'https://login.example-idp.test/signin' }, { env });
  expect(r.error.runLevel).toBe(true);
  expect(r.w.clicks).toEqual([]);
  // Signed in: no sign-in code path is involved at all.
  expect((await run({})).result.dryRun).toBe(false);
});

test('R4 cleanup: removal is bound to the verified row (cart entry, item, quantity), re-checked on the same element, and confirmed gone', async () => {
  const refuse = [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }];
  // Removed: exactly the row verified after the add.
  const exact = await run({}, { verdicts: refuse });
  expect(exact.error.evidence.cleanup).toBe('row_removed');
  expect(exact.w.cart).toEqual([]);
  // The owner's phone replaced our line with a new one (same item, same quantity): not ours.
  const replaced = await run({}, { verdicts: refuse, onCall: (n, w) => { if (n === 2) w.cart[0] = { sku: SKU, qty: 2, entry: 'REPLACED' }; } });
  expect(replaced.w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'REPLACED' }]);
  expect(replaced.error.evidence.cleanup).toBe('row_absent'); // our entry is gone; the new line is not ours
  expect(replaced.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  // The quantity changes between locating the row and clicking its remove link: re-verified, left.
  const flipped = await run({}, { verdicts: refuse, onCall: (n, w) => { if (n === 2) { w.flipOnRead = 2; w.flipCount = 0; } } });
  expect(flipped.w.cart).toEqual([{ sku: SKU, qty: 9, entry: 'E1' }]);
  expect(flipped.error.evidence.cart_left_for_owner).toBe(true);
  expect(flipped.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  // The click did nothing: the row is not gone after a reload, so row_removed is never recorded.
  const stuck = await run({ removeNoop: true }, { verdicts: refuse });
  expect(stuck.w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'E1' }]);
  expect(stuck.error.evidence.cleanup).toBe('cart_left_for_owner');
  expect(stuck.error.evidence.cart_left_for_owner).toBe(true);
  for (const r of [exact, replaced, flipped, stuck]) expectSafe(r.w);
});

test('R4 PO: a dry run never types a PO; a live run clears it through the form and proves it after a reload, else says po_left_for_owner', async () => {
  const dry = await run({}, { env: { ...ENV, SITEONE_BOT_DRY_RUN: 'true' }, args: { poNumber: 'PO-6' } });
  expect(dry.w.fills).toEqual([]);
  expect(dry.w.po).toBe('');
  expect(dry.result.evidence.poSkipped).toBe('dry_run');
  const refuse = [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }];
  const cleared = await run({}, { args: { poNumber: 'PO-6' }, verdicts: refuse });
  expect(cleared.w.po).toBe('');
  expect(cleared.error.evidence.poCleared).toBe(true);
  expect(cleared.error.evidence.po_left_for_owner).toBeUndefined();
  // The server keeps the PO (the clear was not saved): after the reload it is still there, so we do not claim it.
  const sticky = await run({ poSticky: true }, { args: { poNumber: 'PO-6' }, verdicts: refuse });
  expect(sticky.w.po).toBe('PO-6');
  expect(sticky.error.evidence.po_left_for_owner).toBe(true);
  expect(sticky.error.evidence.poCleared).toBeUndefined();
  for (const r of [dry, cleared, sticky]) expectSafe(r.w);
});

test('R4 baseline: the pre-click page text must be readable and non-empty, else nothing is clicked', async () => {
  const empty = await run({ reviewBody: '   ' });
  expect(empty.error.refuse).toBe('baseline_unreadable');
  const throws = await run({ bodyThrows: true });
  expect(throws.error.refuse).toBe('baseline_unreadable');
  for (const r of [empty, throws]) { expect(r.w.placed).toBe(0); expect(r.w.cart).toEqual([]); expectSafe(r.w); }
});

// ---- round 5 -----------------------------------------------------------------------

test('R5 account: the signed-in account must be exactly the approved one, before the cart is touched and again at the click', async () => {
  const MISMATCH = ['Signed in as account 15550123', 'Signed in as account 233073', 'Signed in as account 5550123 and 5550001', 'account 2330738'];
  for (const accountText of MISMATCH) {
    const r = await run({ accountText, cart: [{ sku: 'PHONE-APP-1', qty: 3 }] });
    expect(r.error.refuse).toBe('account_mismatch');
    expect(r.w.clicks).toEqual([]); // nothing touched, not even the cart read's follow-ups
    expect(r.w.cart).toEqual([{ sku: 'PHONE-APP-1', qty: 3 }]);
    expectSafe(r.w);
  }
  for (const over of [{ hideAccount: true }, { accountText: 'Signed in' }, { accountText: '  ' }]) {
    const r = await run(over);
    expect(r.error.refuse).toBe('account_unreadable');
    expect(r.w.clicks).toEqual([]);
    expect(r.w.cart).toEqual([]);
    expectSafe(r.w);
  }
  // An attribute reading is preferred over the node text.
  expect((await run({ accountText: 'menu', accountAttr: '5550123' })).result.dryRun).toBe(false);
  expect((await run({ accountText: 'Signed in as account 5550123', accountAttr: '9999999' })).error.refuse).toBe('account_mismatch');
  // Final review page: a different or unreadable bill-to account refuses with no click, and cleans up.
  const wrongAtReview = await run({}, { onCall: (n, w) => { if (n === 3) w.reviewAccountText = 'Bill to account 5550001'; } });
  expect(wrongAtReview.error.refuse).toBe('account_mismatch');
  const noReviewAccount = await run({ hideReviewAccount: true });
  expect(noReviewAccount.error.refuse).toBe('account_unreadable');
  expect(noReviewAccount.w.cart).toEqual([]);
  // After an account mismatch the session is not the approved account: cleanup touches nothing.
  expect(wrongAtReview.w.cart).toHaveLength(1);
  expect(wrongAtReview.error.evidence.cart_left_for_owner).toBe(true);
  for (const r of [wrongAtReview, noReviewAccount]) { expect(r.w.placed).toBe(0); expectSafe(r.w); }
});

test('R5 cleanup: no verified cart entry id → never remove; the remove locator is bound to the entry', async () => {
  const refuse = [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }];
  const noEntry = await run({ addBehavior: 'noEntry' }, { verdicts: refuse });
  expect(noEntry.error.evidence).toMatchObject({ cleanup: 'cart_left_for_owner', cart_left_for_owner: true });
  expect(noEntry.w.cart).toHaveLength(1);
  expect(noEntry.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  const ok = await run({}, { verdicts: refuse });
  expect(ok.error.evidence.cleanup).toBe('row_removed');
  expect(ok.w.locators).toContain(`${S.cartRow}[data-cartentry="E1"]`);
  // An unsafe id is never put in a selector.
  const odd = await run({}, { verdicts: refuse, onCall: (n, w) => { if (n === 2) w.cart[0].entry = 'a"]'; } });
  expect(odd.w.locators.some((l) => l.includes('a"]'))).toBe(false);
  for (const r of [noEntry, ok, odd]) expectSafe(r.w);
});

test('R5 sign-out after any checkout step is run-level (the claim is released), never a refusal', async () => {
  const MESSAGE = 'SiteOne signed Chrome out — sign in to siteone.com in Chrome on the Mac';
  for (const signOutAfter of ['continue', 'order-type', 'review']) {
    const r = await run({ signOutAfter });
    expect(r.error.runLevel).toBe(true);
    expect(r.error.message).toBe(MESSAGE);
    expect(r.error.refuse).toBeUndefined();
    expect(r.w.placed).toBe(0);
    expect(r.w.clicks).not.toContain('place-order');
    // Cleanup cannot sign in either, so our line stays (the owner empties it); nothing was clicked after the sign-out.
    expect(r.w.cart).toHaveLength(1);
    expect(r.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
    expectSafe(r.w);
  }
  // Redirected to a sign-in path on siteone.com is the same.
  const viaPath = await run({ signOutAfter: 'continue', checkoutUrl: 'https://www.siteone.com/en/login' });
  expect(viaPath.error.runLevel).toBe(true);
  expect(viaPath.w.placed).toBe(0);
});

// ---- round 6 -----------------------------------------------------------------------

test('R6 account: the WHOLE token incl. any suffix must equal the approved account string', async () => {
  for (const accountText of ['Signed in as account 5550123-01', 'Signed in as account 5550123 - 01', 'Signed in as account 5550123.01', 'Account 5550123-', 'Accounts 5550123 5550123-01']) {
    const r = await run({ accountText });
    expect(r.error.refuse).toBe('account_mismatch');
    expect(r.w.clicks).toEqual([]);
    expectSafe(r.w);
  }
  expect((await run({ accountText: 'Signed in as account 5550123' })).result.dryRun).toBe(false);
  // A short suffix on the final review page: refuse, nothing clicked, cleanup touches nothing.
  const suffix = await run({}, { onCall: (n, w) => { if (n === 3) w.reviewAccountText = 'Bill to account 5550123-01'; } });
  expect(suffix.error.refuse).toBe('account_mismatch');
  expect(suffix.w.placed).toBe(0);
  expect(suffix.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expectSafe(suffix.w);
});

test('R6 click: the click goes to the element that passed review, inside one browser step, never a locator click', async () => {
  const ok = await run({});
  expect(ok.result.externalOrderNumber).toBe('7700123');
  // One synchronous in-browser step checks the total, the tender and the button, then clicks it (a DOM click).
  expect(ok.w.handleClicks).toEqual([{ dom: true }]);
  expect(ok.w.locatorPlaceClicks).toBe(0);
  // Replaced between resolving the handle and the final re-read.
  const replaced = await run({ onTenderRead: (n, w) => { if (n === 2) w.placeBtns = null; } });
  expect(replaced.error.refuse).toBe('place_button_replaced');
  // Detached after the re-read started.
  const detached = await run({ onTenderRead: (n, w) => { if (n === 2) w.placeBtns[0].dom.isConnected = false; } });
  expect(detached.error.refuse).toBe('place_button_replaced');
  // Disabled by the re-read.
  const disabled = await run({ onTenderRead: (n, w) => { if (n === 2) w.placeBtns[0].enabled = false; } });
  expect(disabled.error.refuse).toBe('place_button_ambiguous');
  for (const r of [replaced, detached, disabled]) {
    expect(r.w.clicks).not.toContain('place-order'); // (the handle clicks seen here are cleanup's own remove link)
    expect(r.w.placed).toBe(0);
    expect(r.w.cart).toEqual([]); // not an account problem: cleanup runs
    expectSafe(r.w);
  }
});

test('R8 click: the total and tender are the last reads before the click; a change there refuses with no click', async () => {
  // Tender reads: 1 = review, 2 = re-read, 3 = the last read in node, 4 = inside the one browser step that clicks.
  const atBind = await run({ onTenderRead: (n, w) => { if (n === 3) w.reviewTotalText = '$190.40'; } });
  expect(atBind.error.refuse).toBe('review_changed');
  // A switch to a saved card DURING the final step (after the total was read there): refused, no click.
  const inStep = await run({ onTenderRead: (n, w) => { if (n === 4) w.reviewTenderText = 'Payment Method Credit Card, Spark-6646'; } });
  expect(inStep.error.refuse).toBe('review_changed');
  expect(inStep.error.message).toMatch(/changed/);
  // A different pickup branch, or a new URL, appearing inside that same step: refused, no click.
  const pickup = await run({ onTenderRead: (n, w) => { if (n === 4) w.reviewPickupText = 'Pickup Sarasota 112'; } });
  expect(pickup.error.refuse).toBe('review_changed');
  const moved = await run({ onTenderRead: (n, w) => { if (n === 4) w.url += '?cart=other'; } });
  expect(moved.error.refuse).toBe('review_changed');
  expect(moved.error.message).toMatch(/\(url\)/);
  for (const r of [atBind, inStep, pickup, moved]) {
    expect(r.w.placed).toBe(0);
    expect(r.w.clicks).not.toContain('place-order');
    expectSafe(r.w);
  }
});

test('R9 confirmation: a confirmation field that is present but ambiguous is unknown, never the URL code', async () => {
  const twoNumbers = await run({ confirmationBody: 'Order Number: 7700123 Order Number: 7700124' });
  expect(twoNumbers.error.ambiguous).toBe(true);
  expect(twoNumbers.w.placed).toBe(1);
});

test('R6 cleanup: the approved account is proven on each cleanup page, else the cart and PO are left for the owner', async () => {
  const refuse = [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }];
  const switched = await run({}, { args: { poNumber: 'PO-6' }, verdicts: refuse, onCall: (n, w) => { if (n === 2) w.accountText = 'Signed in as account 5550001'; } });
  expect(switched.error.refuse).toBe('over_monthly_cap');
  expect(switched.w.cart).toHaveLength(1);
  expect(switched.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]);
  expect(switched.w.po).toBe('PO-6');
  expect(switched.error.evidence).toMatchObject({ cart_left_for_owner: true, po_left_for_owner: true });
  expect(switched.error.evidence.poCleared).toBeUndefined();
  const unreadable = await run({}, { verdicts: refuse, onCall: (n, w) => { if (n === 2) w.hideAccount = true; } });
  expect(unreadable.w.cart).toHaveLength(1);
  expect(unreadable.error.evidence.cart_left_for_owner).toBe(true);
  // An account mismatch refusal runs no cleanup page at all.
  const mismatch = await run({}, { args: { poNumber: 'PO-6' }, onCall: (n, w) => { if (n === 3) w.reviewAccountText = 'Bill to account 5550001'; } });
  expect(mismatch.error.refuse).toBe('account_mismatch');
  expect(mismatch.w.po).toBe('PO-6');
  expect(mismatch.w.cart).toHaveLength(1);
  expect(mismatch.error.evidence).toMatchObject({ cart_left_for_owner: true, po_left_for_owner: true });
  const after = mismatch.w.gotos.slice(-1)[0];
  expect(after).toBeDefined();
  expect(mismatch.w.clicks.filter((c) => c === 'order-type-submit')).toHaveLength(1); // no PO-clearing submit
  for (const r of [switched, unreadable, mismatch]) expectSafe(r.w);
});

test('R6 empty cart: positive evidence is required (the cart\'s own empty state), else cart_state_unreadable before anything is added', async () => {
  for (const over of [{ hideEmptyState: true }, { emptyText: 'Welcome back' }]) {
    const r = await run(over);
    expect(r.error.refuse).toBe('cart_state_unreadable');
    expect(r.w.clicks).toEqual([]);
    expect(r.w.cart).toEqual([]);
    expectSafe(r.w);
  }
  expect((await run({})).result.dryRun).toBe(false);
  expect((await run({ cart: [{ sku: 'PHONE-APP-1', qty: 3 }] })).error.refuse).toBe('cart_not_empty');
});

test('R6 sign-out marker: a shown header "Sign In" (no redirect, no Okta box) is run-level, checked before the account read', async () => {
  const MESSAGE = 'SiteOne signed Chrome out — sign in to siteone.com in Chrome on the Mac';
  // The account node cannot be read while signed out: this must NOT become account_unreadable.
  const out = await run({ signedOutHeader: true, hideAccount: true });
  expect(out.error.runLevel).toBe(true);
  expect(out.error.message).toBe(MESSAGE);
  expect(out.error.refuse).toBeUndefined();
  expect(out.w.clicks).toEqual([]);
  expectSafe(out.w);
  // Only the exact text counts.
  for (const signInText of ['Sign In Now', 'sign in', 'My Account']) {
    expect((await run({ signedOutHeader: true, signInText })).result.dryRun).toBe(false);
  }
  // Signed out in the middle of checkout: run-level, claim released.
  const mid = await run({}, { onCall: (n, w) => { if (n === 1) w.signedOutHeader = true; } });
  expect(mid.error.runLevel).toBe(true);
  expect(mid.w.placed).toBe(0);
});

// ---- round 7 -----------------------------------------------------------------------

test('R7 money: the WHOLE text must be one amount with exactly two decimals', async () => {
  const { parseMoney } = adapter._internals;
  expect(parseMoney('$1,250.00')).toBe(125000);
  expect(parseMoney('$105.93')).toBe(10593);
  expect(parseMoney(' $12.50 ')).toBe(1250);
  expect(parseMoney('$1250.00')).toBe(125000);
  for (const bad of ['$1 250.00', '$1 250.00', '$1 250.00', '$1,250', '$1,250.0', '$12.345', '$12', '$0.00', 'Total $105.93', '$105.93 $5.00', '$1,25.00', '$-5.00', '', null]) {
    expect(parseMoney(bad)).toBeNull();
  }
  // End to end: an unreadable total refuses before anything is checked out or clicked.
  const cart = await run({ cartTotalText: '$1,250' });
  expect(cart.error.refuse).toBe('cart_total_unreadable');
  expect(cart.w.clicks).not.toContain('continue-checkout');
  const review = await run({ reviewTotalText: '$1 250.00' });
  expect(review.error.refuse).toBe('review_total_unreadable');
  expect(review.w.placed).toBe(0);
  expect((await run({ reviewTotalText: '$1,250.00' })).result.amountCents).toBe(125000);
  for (const r of [cart, review]) { expect(r.w.cart).toEqual([]); expectSafe(r.w); }
});

test('R7 account: re-proven on the product page before Add to Cart and on the checkout page before the PO / form submit', async () => {
  const product = await run({ productAccountText: 'Signed in as account 5550001' });
  expect(product.error.refuse).toBe('account_mismatch');
  expect(product.w.clicks).not.toContain('add-to-cart');
  expect(product.w.cart).toEqual([]);
  const productGone = await run({ productAccountText: '' });
  expect(productGone.error.refuse).toBe('account_unreadable');
  expect(productGone.w.clicks).not.toContain('add-to-cart');
  const checkout = await run({ checkoutAccountText: 'Signed in as account 5550001' }, { args: { poNumber: 'PO-7' } });
  expect(checkout.error.refuse).toBe('account_mismatch');
  expect(checkout.w.fills).toEqual([]); // no PO typed
  expect(checkout.w.clicks).not.toContain('order-type-submit');
  // Account mismatch: cleanup touches nothing, so the line is left for the owner.
  expect(checkout.w.cart).toHaveLength(1);
  expect(checkout.error.evidence.cart_left_for_owner).toBe(true);
  for (const r of [product, productGone, checkout]) expectSafe(r.w);
});

test('R7 cleanup: the remove click goes to the link handle inside the verified row handle; a row replaced in between is never clicked', async () => {
  const refuse = [{ ok: true }, { ok: false, reason: 'over_monthly_cap' }];
  const exact = await run({}, { verdicts: refuse });
  expect(exact.error.evidence.cleanup).toBe('row_removed');
  expect(exact.w.handleClicks).toEqual([{ force: true, noWaitAfter: true, timeout: 1000 }]);
  // The row is replaced by an identical-looking one after the handle was read: the old handle is detached.
  const replaced = await run({}, { verdicts: refuse, onCall: (n, w) => { if (n === 2) w.onRowRead = (reads, world) => { if (reads === 1) world.cart[0] = { sku: SKU, qty: 2, entry: 'E1' }; }; } });
  expect(replaced.error.evidence).toMatchObject({ cleanup: 'cart_left_for_owner', cart_left_for_owner: true });
  expect(replaced.w.clicks.filter((c) => c.startsWith('remove:'))).toEqual([]); // a locator click would have logged here
  expect(replaced.w.handleClicks).toEqual([]);
  expect(replaced.w.cart).toEqual([{ sku: SKU, qty: 2, entry: 'E1' }]);
  for (const r of [exact, replaced]) expectSafe(r.w);
});
