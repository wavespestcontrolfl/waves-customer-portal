/**
 * procurement/adapters/siteone-cdp.js — SiteOne ordering through the owner's
 * OWN signed-in Chrome, driven over the DevTools protocol (CDP).
 *
 * SiteOne blocks headless browsers that come from a server and refuses email
 * orders, so a job on the owner's Mac connects to his Chrome on
 * SITEONE_CDP_URL (http://127.0.0.1:9222), opens ONE new page in the default
 * context, and walks the storefront as a person would. order-dispatch.js stays
 * the brain (claims, caps, ledger, bells); this file is only the hands. It
 * implements the same contract as adapters/siteone.js:
 *
 *   quotesAtPlace = true     no static quote; the vendor's total is the quote
 *   packagedQuantity = true  `quantity` is a package count
 *   loginRequired = false    the Chrome profile is the login — no stored one
 *   configured()             true only when SITEONE_CDP_URL AND
 *                            SITEONE_APPROVED_STORE_ID AND SITEONE_APPROVED_PICKUP
 *                            AND SITEONE_APPROVED_ACCOUNT are all set
 *   place({ vendorSku, quantity, beforeSubmit, dryRun, poNumber }) →
 *     { externalOrderNumber, amountCents, evidence, dryRun }
 *   RefusedError (err.refuse) = parked, nothing submitted.
 *   err.runLevel = Chrome not reachable / not signed in: the claim is released.
 *   err.ambiguous = Place order was clicked and the outcome is unknown. The
 *     bot never clicks it again.
 *
 * Hard rules:
 *   - Dry run unless SITEONE_BOT_DRY_RUN is exactly 'false' (fail closed).
 *   - The bot never types a credential and NEVER submits a sign-in form. Any
 *     step that lands on a sign-in page (the Okta identifier box, a sign-in
 *     path, any origin other than https://www.siteone.com) is run-level:
 *     "SiteOne signed Chrome out — sign in to siteone.com in Chrome on the Mac".
 *   - The signed-in account must be exactly SITEONE_APPROVED_ACCOUNT (the only
 *     4+ digit run in its node, UNVERIFIED selector), read before the cart is
 *     touched and again on the review page before the click: account_mismatch /
 *     account_unreadable.
 *   - The account token must equal SITEONE_APPROVED_ACCOUNT as a whole string,
 *     suffix included ("12345-01" is not "12345"). After an account mismatch
 *     cleanup touches nothing; every other cleanup page proves the account first.
 *   - The empty cart needs positive evidence (`.empty-cart` "Your cart is
 *     empty." — walked live 11-24), else cart_state_unreadable.
 *   - The Place click goes to the ElementHandle that passed review (same
 *     element, still attached, visible + enabled) with force / noWaitAfter /
 *     a 1 s timeout; never a locator click.
 *   - A signed-out SiteOne can stay on the same URL: a shown header node reading
 *     exactly "Sign In" is the sign-out marker (run-level).
 *   - A total is the WHOLE text of its node and one amount with exactly two
 *     decimals (no spaces inside the digits); anything else is *_total_unreadable.
 *   - The approved account is proven again on the product page right before Add
 *     to Cart and on the checkout page before a PO is typed / the form submitted.
 *   - Cleanup resolves the row and its own remove link to handles once, proves
 *     both attached with the item / entry / quantity unchanged in one evaluate,
 *     and clicks the link handle (force / noWaitAfter / 1 s), never a locator.
 *   - After every navigation or submit in checkout the sign-out detection of
 *     openPage runs again (run-level, so the claim is released and retried).
 *   - The cart is shared with the owner's phone app: the bot starts only from
 *     an EMPTY cart, and removes only the line it added. It never clicks
 *     "remove all".
 *   - Payment is Pay at Branch, proven by a checked radio. The bot never
 *     touches a saved card, "Pay with a New Card" or a card iframe.
 *   - The cap check (beforeSubmit) runs on the cart total and again, bound,
 *     on the review page's total right before the click.
 *   - The bot closes only the page it opened, then browser.close(), which on a
 *     connectOverCDP browser only drops the WebSocket (playwright-core 1.59.1:
 *     chromium.js:98-101 doClose = transport.closeAndWait; Browser.close is
 *     sent only in the launch path, browserType.js:205-222). It never closes
 *     a context, so the owner's Chrome and tabs stay up.
 *   - After the click an order number is read only on the vendor's confirmation
 *     path (URLS.confirmationPathPrefix + one segment, UNVERIFIED) and must be
 *     NEW against the review page's strings. Any other destination is ambiguous.
 *   - A dry run never types a PO. A live run refuses on a PO box that already
 *     holds a value (po_field_occupied). If a live run refuses after typing its
 *     PO, cleanup clears it only while it still equals ours, saves the form and
 *     verifies the box is empty after a reload; otherwise evidence says
 *     po_left_for_owner (never a claim it was cleared).
 *   - Cleanup removes a cart line only when it is the exact row verified after
 *     the add (data-cartentry, item number, quantity), re-checked on that same
 *     element just before its own remove link is clicked, and gone afterwards;
 *     otherwise evidence says cart_left_for_owner.
 *   - The pre-click page text (the order-number baseline) must be readable and
 *     non-empty, else baseline_unreadable and nothing is clicked.
 *   - Every transition (checkout, review, the Place click) parses page.url() and
 *     requires origin https://www.siteone.com and the exact pathname.
 *   - The reservation is bound to the click: after the cap check passes, the
 *     review total, item code, quantity, tender and pickup are read AGAIN right
 *     before the click and must be unchanged, else nothing is clicked.
 *   - Evidence never holds an input value (except our own PO number), a
 *     cookie, or a card field.
 *   - Every selector lives in SELECTORS. They were walked on the owner's
 *     Chrome on 10-26 and 10-29, except reviewItemBlock / reviewQty (the
 *     review page's quantity node), which stay UNVERIFIED until the first
 *     dry run: an unreadable quantity refuses (review_qty_unreadable).
 */
const logger = require('../../logger');

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const SELECTORS = Object.freeze({
  oktaIdentifier: 'input[name="identifier"]',
  searchResult: '.product-item a.name',
  brandItemNumber: 'div.brand-itemnumber',
  formBrandItemNumber: 'form#addToCartForm input[name="brandItemNumber"]',
  formStoreId: 'form#addToCartForm input[name="storeId"]',
  uomRow: '.multipleUomItem',
  uomSelected: '.multipleUomItem.selected-uom-item',
  pdpQty: 'input#pdpAddtoCartInput',
  addToCart: 'button#showAddtoCart',
  cartRow: '.js-cart-items-row',
  cartQtyInput: 'input.cart-qty-input',
  cartRemoveLine: '.js-remove-entry-button a',
  pickupTile: '.cart-top-fulfillment-method__tile.fullfillment-pickup',
  cartTotal: '.js-cart-total-with-tax',
  // Walked live 11-24: the empty cart shows `.empty-cart` with "Your cart is empty."
  // and no `.js-cart-items-row` or cart total.
  cartEmpty: '.empty-cart',
  // Walked live 11-24: a signed-out Chrome stays on the same URL (no redirect, no
  // Okta box); the only marker is a shown header node reading exactly "Sign In".
  signInMarker: 'header span, header a, header button',
  continueCheckout: 'button.js-continue-checkout-button',
  orderTypeForm: 'form#siteOneOrderTypeForm',
  pickupLocation: '.step-body-form.page-choosePickupDeliveryMethodPage',
  checkoutStoreId: 'input#storeId',
  poInput: 'input#PurchaseOrderNumber',
  orderTypeSubmit: 'button.orderTypeFormSubmit',
  payAtBranchRadio: '#PAY_AT_BRANCH',
  payAtBranchLabel: 'label[for="PAY_AT_BRANCH"]',
  // A card number, CVV or MFA box SHOWN on the payment step parks the order.
  // (An iframe is not listed: its fields are not readable from the page and
  // the bot never opens the card section.)
  paymentBlockers: 'input[autocomplete="cc-number"], input[autocomplete="cc-csc"], input[autocomplete="one-time-code"], input[name*="cardNumber" i], input[name*="card_number" i], input[name*="cvv" i], input[name*="securityCode" i], input[name*="otp" i], input[name*="verificationCode" i]',
  reviewButton: 'input#btnShow.payment-to-branch',
  // UNVERIFIED: the review page's own tender and pickup fields (the page reads
  // "Payment Method Pay At branch, Lakewood Ranch 238"). Not found, or not
  // exactly one shown each → refuse review_fields_unreadable; the first dry run
  // shows the real DOM.
  reviewTender: '[data-test="payment-method"], .order-summary__payment-method, [class*="payment-method" i]',
  reviewPickup: '[data-test="pickup-location"], .order-summary__pickup, [class*="pickup-location" i]',
  reviewItemCode: 'div.item__code',
  // UNVERIFIED: the nearest ancestor of the item code that holds a quantity node.
  reviewItemBlock: 'xpath=ancestor::*[.//*[contains(@class,"item__qty") or contains(@class,"item__quantity")]][1]',
  reviewQty: '[class*="item__qty"], [class*="item__quantity"]',
  reviewTotal: 'strong#totalPriceWithTax',
  // UNVERIFIED: the signed-in account node (the 10-26 walk read "Signed in as
  // account <number>"; an attribute is preferred over the menu text) and the
  // review page's account / bill-to field. Unreadable → account_unreadable.
  accountNode: '[data-account-number], [data-test="account-number"], .js-account-number, [data-account-menu]',
  reviewAccount: '[data-test="bill-to-account"], [data-test="account-number"], .order-summary__account, [class*="bill-to" i]',
  // UNVERIFIED: the confirmation page's own order-number node. Without it the
  // number comes from the confirmation URL's <code> segment.
  confirmationNumber: '[data-test="order-number"], .order-confirmation__number, .confirmation-number',
  // UNVERIFIED (first live order shows it): the order total on the confirmation page.
  confirmationTotal: '[data-test="order-total"], .order-confirmation__total, [class*="order-total" i]',
  placeOrder: 'button#placeOrder, #placeOrder2',
  body: 'body',
  heading: 'h1',
});

const BASE = 'https://www.siteone.com';
const PATHS = Object.freeze({
  search: '/en/search',
  cart: '/en/cart',
  checkout: '/en/checkout/multi/siteOne-checkout',
  review: '/en/checkout/multi/order-summary/view',
});
const URLS = Object.freeze({
  search: (sku) => `${BASE}${PATHS.search}?text=${encodeURIComponent(sku)}`,
  cart: `${BASE}${PATHS.cart}`,
  checkout: `${BASE}${PATHS.checkout}`,
  // UNVERIFIED: SiteOne is Hybris, whose confirmation page is
  // /checkout/orderConfirmation/<code>. After the click ONLY this path (one
  // segment after the prefix) is read for an order number; any other
  // destination (order history, an account page) is ambiguous.
  confirmationPathPrefix: '/en/checkout/orderConfirmation/',
});
const NAV_TIMEOUT = 45000;
const ACTION_TIMEOUT = 15000;
const WAIT_STEP = 500;
const EMPTY_CART_WAIT = 10000; // bounded wait for positive evidence of an empty cart
const STEP_WAIT = 20000; // bounded wait for the next checkout step
const CONFIRMATION_WAIT = 30000; // bounded wait for the order number after the click
const SETTLE_MS = 2500;
const PO_PATTERN = /^[A-Z0-9-]{1,20}$/;

class RefusedError extends Error {
  // cents: the vendor total a cap refusal was decided on — the dispatcher
  // parks the ledger row with THIS amount.
  constructor(reason, message, evidence, cents = null) {
    super(message || reason);
    this.refuse = reason;
    if (evidence) this.evidence = evidence;
    if (cents != null) this.cents = cents;
  }
}
function runLevel(message) { const e = new Error(message); e.runLevel = true; return e; }

// ---- configuration ----------------------------------------------------------

const csv = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
const isLocalCdpUrl = (u) => {
  try {
    const url = new URL(String(u));
    return ['http:', 'ws:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
};
function configured(env = process.env) {
  return !!String(env.SITEONE_CDP_URL || '').trim()
    && !!String(env.SITEONE_APPROVED_STORE_ID || '').trim()
    && csv(env.SITEONE_APPROVED_PICKUP).length > 0
    && !!String(env.SITEONE_APPROVED_ACCOUNT || '').trim();
}
// Fail closed: only the exact string 'false' turns the dry run off.
const isDryRun = (env, dryRun) => dryRun === true || env.SITEONE_BOT_DRY_RUN !== 'false';

// ---- small readers ----------------------------------------------------------

const normalizeText = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim().toLowerCase();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, token) => new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizeText(token))}($|[^a-z0-9])`).test(normalizeText(text));
const hasEveryToken = (text, tokens) => tokens.length > 0 && tokens.every((t) => hasToken(text, t));

// The WHOLE text must be one dollar amount with exactly two decimals:
// "$1,250.00", "$12.50", "$1250.00". A space or narrow space inside the digits,
// a missing or third decimal, or extra words → null (the caller refuses).
function parseMoney(text) {
  const t = String(text || '').trim();
  if (!/^\$?\s?\d{1,3}(,\d{3})*\.\d{2}$/.test(t) && !/^\$?\d+\.\d{2}$/.test(t)) return null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
// "CSI-PEST : 82003599" → "82003599": the item number after the last ":".
const itemNumberAfterColon = (text) => { const t = String(text || ''); return t.slice(t.lastIndexOf(':') + 1).trim(); };

// Every match of a selector as { all, shown } (SiteOne renders hidden
// responsive copies, so no check may judge `.first()`).
async function matches(scope, selector) {
  const els = scope.locator(selector);
  const n = await els.count();
  const all = [];
  const shown = [];
  for (let i = 0; i < n; i += 1) {
    const el = els.nth(i);
    all.push(el);
    if (await el.isVisible().catch(() => false)) shown.push(el);
  }
  return { all, shown };
}
async function shownAll(scope, selector) { return (await matches(scope, selector)).shown; }
// The ONE shown match, or a refusal that names the control.
async function oneShown(scope, selector, what, evidence) {
  const shown = await shownAll(scope, selector);
  if (shown.length !== 1) throw new RefusedError('page_unrecognized', `SiteOne page: ${shown.length} visible ${what} (expected exactly one)`, evidence);
  return shown[0];
}
async function oneAttached(scope, selector, what, evidence) {
  const { all } = await matches(scope, selector);
  if (all.length !== 1) throw new RefusedError('page_unrecognized', `SiteOne page: ${all.length} ${what} (expected exactly one)`, evidence);
  return all[0];
}
const textOf = async (el) => String((await el.innerText().catch(() => '')) || '').trim();

async function poll(page, fn, ms, step = WAIT_STEP) {
  const rounds = Math.max(1, Math.ceil(ms / step));
  for (let i = 0; i < rounds; i += 1) {
    try { const v = await fn(); if (v) return v; } catch (e) {
      if (e.refuse || e.runLevel || e.ambiguous) throw e;
      // otherwise the page is mid-navigation: read again
    }
    await page.waitForTimeout(step);
  }
  return null;
}

function parseUrl(u, base) { try { return new URL(String(u), base); } catch { return null; } }

// The page is exactly on https://www.siteone.com (and, when given, this exact
// pathname). Parsed, never a substring match.
function atSiteOne(page, pathname = null) {
  const u = parseUrl(page.url());
  return !!u && u.origin === BASE && (pathname == null || u.pathname === pathname);
}
// A transition check: off siteone.com is run-level (the browser went somewhere
// we do not control); the wrong page on siteone.com refuses.
function assertAt(run, pathname, what) {
  if (!atSiteOne(run.page)) throw runLevel(`siteone cdp: the ${what} left https://www.siteone.com`);
  if (pathname != null && !atSiteOne(run.page, pathname)) throw new RefusedError('page_unrecognized', `SiteOne is not on the ${what} page`, run.evidence);
}

// ---- navigation ---------------------------------------------------------------

async function signInFormShown(page) { return (await shownAll(page, SELECTORS.oktaIdentifier)).length > 0; }

const SIGNED_OUT_MESSAGE = 'SiteOne signed Chrome out — sign in to siteone.com in Chrome on the Mac';
const SIGN_IN_PATH = /\/(?:log-?in|sign-?in|logon)(?:\/|$)/i;

// `pathname`: when given, the page must end exactly there (the cart, checkout).
// A sign-in page is never filled or submitted: the run stops, run-level.
// After every navigation or submit: off siteone.com, a sign-in path, or the
// identifier box means Chrome was signed out — run-level, so the claim is
// released and retried.
async function assertSignedIn(run) {
  const here = parseUrl(run.page.url());
  if (!here || here.origin !== BASE || SIGN_IN_PATH.test(here.pathname) || await signInFormShown(run.page) || await signInMarkerShown(run.page)) throw runLevel(SIGNED_OUT_MESSAGE);
}
// A shown header node whose text is exactly "Sign In": SiteOne signed out without a redirect.
async function signInMarkerShown(page) {
  for (const node of await shownAll(page, SELECTORS.signInMarker)) if ((await textOf(node)) === 'Sign In') return true;
  return false;
}

async function openPage(run, url, pathname = null) {
  const { page } = run;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertSignedIn(run);
  assertAt(run, pathname, 'navigation');
  await page.waitForTimeout(run.opts.settleMs);
}

// ---- cart helpers -----------------------------------------------------------

async function cartRows(page) { return (await matches(page, SELECTORS.cartRow)).all; }
async function rowReading(row) {
  return {
    sku: String((await row.getAttribute('data-itemnumber').catch(() => '')) || '').trim(),
    entry: String((await row.getAttribute('data-cartentry').catch(() => '')) || '').trim(),
    requested: String((await row.getAttribute('data-requestedqty').catch(() => '')) || '').trim(),
    inputQty: await row.locator(SELECTORS.cartQtyInput).count().then(async (n) => {
      if (!n) return null;
      const el = row.locator(SELECTORS.cartQtyInput).nth(0);
      return (await el.isVisible().catch(() => false)) ? String(await el.inputValue().catch(() => '')).trim() : null;
    }),
  };
}

// Browser-side readers for the row handles (self-contained: they are serialized).
const READ_ROW = ([row, qtySel]) => {
  const q = row.querySelector(qtySel);
  return {
    attached: !!row.isConnected,
    sku: String(row.getAttribute('data-itemnumber') || '').trim(),
    entry: String(row.getAttribute('data-cartentry') || '').trim(),
    requested: String(row.getAttribute('data-requestedqty') || '').trim(),
    inputQty: q ? String(q.value).trim() : null,
  };
};
const READ_ROW_AND_LINK = ([row, link, qtySel]) => {
  const q = row.querySelector(qtySel);
  return {
    linked: !!(row.isConnected && link.isConnected && row.contains(link)),
    sku: String(row.getAttribute('data-itemnumber') || '').trim(),
    entry: String(row.getAttribute('data-cartentry') || '').trim(),
    requested: String(row.getAttribute('data-requestedqty') || '').trim(),
    inputQty: q ? String(q.value).trim() : null,
  };
};

// The row is exactly what this run added: our item, the cart entry verified
// after the add, and the quantity we set. No verified entry id → never ours.
// Ownership proven and the remove link clicked in ONE browser task: the row cannot change between
// the check and the click (an in-place quantity edit from the owner's phone app is never removed).
const REMOVE_IF_OWN = ([row, link, qtySel, want]) => {
  if (!(row.isConnected && link.isConnected && row.contains(link))) return { clicked: false };
  const q = row.querySelector(qtySel);
  const qtys = [String(row.getAttribute('data-requestedqty') || '').trim(), q ? String(q.value).trim() : ''].filter((x) => x !== '');
  const own = String(row.getAttribute('data-cartentry') || '').trim() === want.entry
    && String(row.getAttribute('data-itemnumber') || '').trim() === want.sku
    && qtys.length > 0 && qtys.every((x) => Number(x) === want.qty);
  if (!own) return { clicked: false };
  link.click();
  return { clicked: true };
};

function isOwnRow(run, reading) {
  const qtys = [reading.requested, reading.inputQty].filter((q) => q != null && q !== '');
  return !!run.ownEntry && reading.entry === run.ownEntry && reading.sku === run.vendorSku
    && qtys.length > 0 && qtys.every((q) => Number(q) === run.quantity);
}
// The one row with this cart entry: `.js-cart-items-row[data-cartentry="<id>"]`.
const rowSelectorFor = (entry) => `${SELECTORS.cartRow}[data-cartentry="${entry}"]`;
const leaveCart = (run, why) => { run.evidence.cleanup = why; run.evidence.cart_left_for_owner = true; };

// Remove ONLY the line this run added, bound to that row's identity: the
// locator is the verified data-cartentry, the row is checked against the item
// and quantity, checked AGAIN on the same element just before its own remove
// link is clicked, and confirmed gone (after a reload) before row_removed is
// recorded. No verified entry id, or anything else, belongs to the owner now.
async function removeOwnRow(run) {
  const { page } = run;
  if (!run.ownEntry || !/^[A-Za-z0-9_-]{1,64}$/.test(run.ownEntry)) { leaveCart(run, 'cart_left_for_owner'); return; }
  await openPage(run, URLS.cart, PATHS.cart);
  if (!(await accountProven(run))) { leaveCart(run, 'cart_left_for_owner'); return; }
  const bound = (await matches(page, rowSelectorFor(run.ownEntry))).all;
  if (!bound.length) { run.evidence.cleanup = 'row_absent'; return; }
  if (!run.cartEmptyBefore || bound.length !== 1) { leaveCart(run, 'cart_left_for_owner'); return; }
  // The row and its own remove link are resolved to handles ONCE; the click
  // goes to the link handle, never a locator that could re-resolve to another row.
  const links = await shownAll(bound[0], SELECTORS.cartRemoveLine);
  const rowHandle = await bound[0].elementHandle().catch(() => null);
  const linkHandle = links.length === 1 ? await links[0].elementHandle().catch(() => null) : null;
  if (!rowHandle || !linkHandle) { leaveCart(run, 'remove_link_unreadable'); return; }
  let before;
  let now;
  try {
    before = await page.evaluate(READ_ROW, [rowHandle, SELECTORS.cartQtyInput]);
    if (!before.attached || !isOwnRow(run, before)) { leaveCart(run, 'cart_left_for_owner'); return; }
    // One evaluate: both still attached, the link is inside the row, item / entry / quantity unchanged.
    now = await page.evaluate(READ_ROW_AND_LINK, [rowHandle, linkHandle, SELECTORS.cartQtyInput]);
  } catch { leaveCart(run, 'cart_left_for_owner'); return; }
  if (!now.linked || !isOwnRow(run, now)) { leaveCart(run, 'cart_left_for_owner'); return; }
  let removed;
  try {
    removed = await page.evaluate(REMOVE_IF_OWN, [rowHandle, linkHandle, SELECTORS.cartQtyInput, { entry: run.ownEntry, sku: run.vendorSku, qty: run.quantity }]);
  } catch { removed = null; }
  if (!removed || removed.clicked !== true) { leaveCart(run, 'cart_left_for_owner'); return; }
  await page.waitForTimeout(run.opts.settleMs);
  const gone = await poll(page, async () => {
    await openPage(run, URLS.cart, PATHS.cart);
    return (await accountProven(run)) && (await matches(page, rowSelectorFor(run.ownEntry))).all.length === 0;
  }, 3 * run.opts.settleMs + 3 * WAIT_STEP, run.opts.settleMs || WAIT_STEP);
  if (!gone) { leaveCart(run, 'cart_left_for_owner'); return; }
  run.evidence.cleanup = 'row_removed';
}

// A live run that typed its PO and then refused: clear it through the checkout
// form (the PO is saved with the form) and prove it is empty after a reload.
// Not provable → po_left_for_owner, never a claim it was cleared.
async function clearPo(run) {
  const { page, poNumber } = run;
  const left = () => { run.evidence.po_left_for_owner = true; };
  await openPage(run, URLS.checkout, PATHS.checkout);
  if (!(await accountProven(run))) { left(); return; }
  const po = await shownAll(page, SELECTORS.poInput);
  // Only while it still holds exactly the PO we typed.
  if (po.length !== 1 || (await po[0].inputValue().catch(() => null)) !== poNumber) { left(); return; }
  await po[0].fill('');
  const submit = await shownAll(page, SELECTORS.orderTypeSubmit);
  if (submit.length !== 1) { left(); return; }
  await submit[0].click();
  await page.waitForTimeout(run.opts.settleMs);
  await openPage(run, URLS.checkout, PATHS.checkout); // reload: what the server saved
  if (!(await accountProven(run))) { left(); return; }
  const after = await shownAll(page, SELECTORS.poInput);
  if (after.length === 1 && (await after[0].inputValue().catch(() => null)) === '') run.evidence.poCleared = true;
  else left();
}

// Best-effort cleanup of what THIS run left behind (never on a submitted order).
async function cleanup(run) {
  if (run.submitted) return;
  // After an account mismatch the browser is signed in as someone else: touch nothing.
  if (run.accountMismatch) {
    if (run.added) leaveCart(run, 'cart_left_for_owner');
    if (run.poFilled) run.evidence.po_left_for_owner = true;
    return;
  }
  if (run.poFilled) {
    try { await clearPo(run); } catch (e) { run.evidence.po_left_for_owner = true; logger.warn(`[siteone-cdp] PO cleanup failed: ${String(e.message).slice(0, 120)}`); }
  }
  if (run.added) {
    try { await removeOwnRow(run); } catch (e) { run.evidence.cleanup = 'failed'; run.evidence.cart_left_for_owner = true; logger.warn(`[siteone-cdp] cart cleanup failed: ${String(e.message).slice(0, 120)}`); }
  }
}

// ---- stages -----------------------------------------------------------------

// The ONE account token in a reading must equal the approved account STRING:
// digits plus any "-suffix" ("12345-01" is not "12345"; "12345 - 01" and
// "12345.01" read as "12345-01"). Two tokens, or a token inside a longer run,
// refuse.
const ACCOUNT_TOKEN = /(?<![\w-])\d{4,}(?:-\w*)*(?!\w)/g;
function checkAccountText(run, text, where) {
  const joined = String(text || '').replace(/(\d)\s*[-./]\s*(?=\d)/g, '$1-');
  const tokens = [...new Set(joined.match(ACCOUNT_TOKEN) || [])];
  run.evidence.accountChecked = where;
  if (!tokens.length) throw new RefusedError('account_unreadable', `SiteOne ${where}: no account number could be read`, run.evidence);
  if (tokens.length !== 1 || tokens[0] !== run.account) {
    run.accountMismatch = true; // cleanup never runs after this: the session is not the approved account
    throw new RefusedError('account_mismatch', `SiteOne ${where}: the account is not the approved one`, run.evidence);
  }
}

// Cleanup's version: the approved account on THIS page, or unproven (never throws).
async function accountProven(run) {
  try { await verifyAccount(run); return true; } catch { return false; }
}

// Before the cart is touched: Chrome is signed in as the approved account.
async function verifyAccount(run) {
  const nodes = (await matches(run.page, SELECTORS.accountNode)).all;
  const texts = [];
  for (const node of nodes) texts.push(String((await node.getAttribute('data-account-number').catch(() => null)) || (await textOf(node))).trim());
  const readings = texts.filter(Boolean);
  if (!readings.length) throw new RefusedError('account_unreadable', 'SiteOne signed-in account could not be read', run.evidence);
  for (const text of readings) checkAccountText(run, text, 'signed-in account');
}

async function assertCartEmpty(run) {
  await openPage(run, URLS.cart, PATHS.cart);
  await verifyAccount(run);
  // Positive evidence of an empty cart, not just "no rows were found": rows
  // (refuse), or the cart's own empty state (proceed), else
  // after a bounded wait the page is not one the bot can read.
  let state = null;
  let rowCount = 0;
  await poll(run.page, async () => {
    rowCount = (await cartRows(run.page)).length;
    if (rowCount) { state = 'rows'; return true; }
    if (await cartShowsEmpty(run.page)) { state = 'empty'; return true; }
    return false;
  }, EMPTY_CART_WAIT);
  run.evidence.cartRowsBefore = rowCount;
  if (state === 'rows') throw new RefusedError('cart_not_empty', `SiteOne cart already holds ${rowCount} line(s) — never touched: empty it by hand`, run.evidence);
  if (state !== 'empty') throw new RefusedError('cart_state_unreadable', 'SiteOne cart shows no lines and no empty-cart state — not proven empty, nothing added', run.evidence);
  run.cartEmptyBefore = true;
}

// The cart's own empty state: a shown `.empty-cart` that says "Your cart is empty."
// (walked live on the owner's Chrome 11-24; the total is not shown on an empty cart).
async function cartShowsEmpty(page) {
  for (const node of await shownAll(page, SELECTORS.cartEmpty)) if (normalizeText(await textOf(node)).includes('your cart is empty')) return true;
  return false;
}

async function openProduct(run) {
  const { page, vendorSku, evidence } = run;
  await openPage(run, URLS.search(vendorSku));
  const hits = await shownAll(page, SELECTORS.searchResult);
  if (hits.length !== 1) throw new RefusedError('sku_not_found', `SiteOne search for the item number shows ${hits.length} result(s) (expected exactly one)`, evidence);
  const href = await hits[0].getAttribute('href').catch(() => null);
  if (!href) throw new RefusedError('sku_not_found', 'SiteOne search result has no link', evidence);
  const target = parseUrl(href, BASE);
  if (!target || target.origin !== BASE) throw new RefusedError('page_unrecognized', 'SiteOne search result leaves siteone.com', evidence);
  await openPage(run, target.toString());
}

async function readUom(page, evidence) {
  const rows = await shownAll(page, SELECTORS.uomRow);
  if (!rows.length) { evidence.uom = 'single_unit'; return; }
  const selected = await shownAll(page, SELECTORS.uomSelected);
  if (selected.length !== 1) throw new RefusedError('uom_mismatch', `SiteOne product shows ${selected.length} selected units of measure (expected exactly one)`, evidence);
  const mult = String((await selected[0].getAttribute('data-inventorymultiplier').catch(() => '')) || '').trim();
  evidence.uom = `multiplier_${mult || 'unreadable'}`;
  if (mult !== '1') throw new RefusedError('uom_mismatch', `SiteOne product's selected unit of measure has multiplier ${mult || 'unreadable'} (expected 1: Each / Bag)`, evidence);
}

async function checkProduct(run) {
  const { page, vendorSku, storeId, evidence } = run;
  const shownCode = await shownAll(page, SELECTORS.brandItemNumber);
  if (shownCode.length !== 1) throw new RefusedError('sku_mismatch', `SiteOne product page shows ${shownCode.length} item numbers (expected exactly one)`, evidence);
  const shownSku = itemNumberAfterColon(await textOf(shownCode[0]));
  const formSku = String(await (await oneAttached(page, SELECTORS.formBrandItemNumber, 'brandItemNumber fields', evidence)).inputValue().catch(() => '')).trim();
  evidence.shownItemNumber = shownSku;
  evidence.formItemNumber = formSku;
  if (shownSku !== vendorSku || formSku !== vendorSku) throw new RefusedError('sku_mismatch', `SiteOne product page item number (${shownSku || '?'} / ${formSku || '?'}) is not ${vendorSku}`, evidence);
  const formStore = String(await (await oneAttached(page, SELECTORS.formStoreId, 'storeId fields', evidence)).inputValue().catch(() => '')).trim();
  evidence.productStoreId = formStore;
  if (formStore !== storeId) throw new RefusedError('store_mismatch', `SiteOne product page store ${formStore || '?'} is not the approved store ${storeId}`, evidence);
  await readUom(page, evidence);
}

async function addToCart(run) {
  const { page, quantity, evidence } = run;
  const qtyBox = await oneShown(page, SELECTORS.pdpQty, 'quantity boxes', evidence);
  const button = await oneShown(page, SELECTORS.addToCart, 'Add to Cart buttons', evidence);
  await verifyAccount(run); // still the approved account on THIS page, right before the add
  await qtyBox.fill(String(quantity));
  run.added = true; // from the click on, the line may exist: cleanup looks for it
  await button.click();
  await page.waitForTimeout(run.opts.settleMs);
}

async function verifyOwnRow(run) {
  const { page, vendorSku, quantity, evidence } = run;
  let rows = [];
  await poll(page, async () => { await openPage(run, URLS.cart, PATHS.cart); rows = await cartRows(page); return rows.length > 0; }, 3 * run.opts.settleMs + 3 * WAIT_STEP, run.opts.settleMs || WAIT_STEP);
  evidence.cartRowsAfter = rows.length;
  const readings = [];
  for (const row of rows) readings.push(await rowReading(row));
  // The identity cleanup is bound to: this line's own cart entry.
  const withOurItem = readings.filter((r) => r.sku === vendorSku);
  if (withOurItem.length === 1) run.ownEntry = withOurItem[0].entry || null;
  const good = readings.length === 1 && readings[0].sku === vendorSku
    && [readings[0].requested, readings[0].inputQty].filter((q) => q != null && q !== '').length > 0
    && [readings[0].requested, readings[0].inputQty].filter((q) => q != null && q !== '').every((q) => Number(q) === quantity);
  if (!good) throw new RefusedError('cart_mismatch', `SiteOne cart after add is not exactly ${vendorSku} x ${quantity} (${readings.length} line(s))`, evidence);
}

async function verifyPickupTile(run) {
  const { page, pickupTokens, evidence } = run;
  const tile = await oneShown(page, SELECTORS.pickupTile, 'pickup tiles', evidence);
  const classes = String((await tile.getAttribute('class').catch(() => '')) || '').split(/\s+/);
  const text = await textOf(tile);
  evidence.pickupTile = normalizeText(text).slice(0, 200);
  if (!classes.includes('fullfilment-select') || !hasEveryToken(text, pickupTokens)) {
    throw new RefusedError('pickup_not_selected', 'SiteOne cart: the pickup tile is not the selected, approved branch', evidence);
  }
}

async function readTotal(scope, selector, what, evidence) {
  const el = await oneShown(scope, selector, what, evidence);
  const cents = parseMoney(await textOf(el));
  if (cents == null) throw new RefusedError(`${what.replace(/\s+/g, '_')}_unreadable`, `SiteOne ${what} is not one clear dollar amount`, evidence);
  return cents;
}

async function verifyCartAndGate(run) {
  const { page, evidence } = run;
  await verifyOwnRow(run);
  await verifyPickupTile(run);
  evidence.cartTotalCents = await readTotal(page, SELECTORS.cartTotal, 'cart total', evidence);
  await run.gate(evidence.cartTotalCents, 'cart total');
  const go = await oneShown(page, SELECTORS.continueCheckout, 'checkout buttons', evidence);
  await go.click();
  const reached = await poll(page, async () => { await assertSignedIn(run); return atSiteOne(page, PATHS.checkout); }, STEP_WAIT);
  if (!reached) { assertAt(run, PATHS.checkout, 'checkout'); throw new RefusedError('page_unrecognized', 'SiteOne did not reach the checkout page', evidence); }
  await assertSignedIn(run);
  await page.waitForTimeout(run.opts.settleMs);
}

async function fillOrderType(run) {
  const { page, pickupTokens, storeId, poNumber, evidence } = run;
  await oneAttached(page, SELECTORS.orderTypeForm, 'order type forms', evidence);
  const location = await oneShown(page, SELECTORS.pickupLocation, 'pickup location blocks', evidence);
  const locText = await textOf(location);
  evidence.pickupLocation = normalizeText(locText).slice(0, 200);
  if (!hasEveryToken(locText, pickupTokens)) throw new RefusedError('pickup_not_selected', 'SiteOne checkout: the pickup location is not the approved branch', evidence);
  const storeField = String(await (await oneAttached(page, SELECTORS.checkoutStoreId, 'checkout store fields', evidence)).inputValue().catch(() => '')).trim();
  if (storeField !== storeId) throw new RefusedError('store_mismatch', `SiteOne checkout store ${storeField || '?'} is not the approved store ${storeId}`, evidence);
  await verifyAccount(run); // and on the checkout page, before a PO is typed or the form submitted
  if (poNumber && run.dryRun) evidence.poSkipped = 'dry_run'; // a dry run never types a PO
  if (poNumber && !run.dryRun) {
    const po = await oneShown(page, SELECTORS.poInput, 'PO number boxes', evidence);
    // Never overwrite a PO this run did not type (a value is left from an earlier run or the owner).
    if (String(await po.inputValue().catch(() => 'unreadable')).trim() !== '') throw new RefusedError('po_field_occupied', 'SiteOne checkout: the PO number box already holds a value — nothing typed', evidence);
    run.poFilled = true;
    await po.fill(poNumber);
  }
  const submit = await oneShown(page, SELECTORS.orderTypeSubmit, 'order type buttons', evidence);
  await submit.click();
}

async function assertNoPaymentPrompt(page, evidence) {
  if ((await shownAll(page, SELECTORS.paymentBlockers)).length) throw new RefusedError('payment_prompt', 'SiteOne checkout shows a card, security code or verification field — the bot never fills one', evidence);
}

async function choosePayAtBranch(run) {
  const { page, evidence } = run;
  const label = await poll(page, async () => { await assertSignedIn(run); const s = await shownAll(page, SELECTORS.payAtBranchLabel); return s.length === 1 ? s[0] : null; }, STEP_WAIT);
  if (!label) throw new RefusedError('not_pay_at_branch', 'SiteOne checkout: no Pay at Branch choice appeared', evidence);
  await assertNoPaymentPrompt(page, evidence);
  await label.click();
  const radio = await oneAttached(page, SELECTORS.payAtBranchRadio, 'Pay at Branch radios', evidence);
  if (!(await radio.isChecked().catch(() => false))) throw new RefusedError('not_pay_at_branch', 'SiteOne checkout: Pay at Branch is not selected after the click', evidence);
  await assertNoPaymentPrompt(page, evidence);
  const review = await oneShown(page, SELECTORS.reviewButton, 'Review Your Order buttons', evidence);
  await review.click();
  const reached = await poll(page, async () => { await assertSignedIn(run); return atSiteOne(page, PATHS.review); }, STEP_WAIT);
  if (!reached) { assertAt(run, PATHS.review, 'order review'); throw new RefusedError('page_unrecognized', 'SiteOne did not reach the order review page', evidence); }
  await assertSignedIn(run);
  await page.waitForTimeout(run.opts.settleMs);
}

async function readReviewItem(run) {
  const { page, vendorSku, quantity, evidence } = run;
  const item = await oneShown(page, SELECTORS.reviewItemCode, 'review item codes', evidence);
  const code = itemNumberAfterColon(await textOf(item));
  evidence.reviewItem = code;
  if (code !== vendorSku) throw new RefusedError('review_item_mismatch', `SiteOne review item ${code || '?'} is not ${vendorSku}`, evidence);
  const block = item.locator(SELECTORS.reviewItemBlock);
  const qtyNodes = (await block.count().catch(() => 0)) ? await shownAll(block.nth(0), SELECTORS.reviewQty) : [];
  const figures = qtyNodes.length ? (await textOf(qtyNodes[0])).match(/\d+/g) || [] : [];
  if (qtyNodes.length !== 1 || figures.length !== 1) throw new RefusedError('review_qty_unreadable', 'SiteOne review: the item quantity could not be read in the item block', evidence);
  const qty = Number(figures[0]);
  evidence.reviewQty = qty;
  if (qty !== quantity) throw new RefusedError('review_qty_mismatch', `SiteOne review quantity ${figures[0]} is not ${quantity}`, evidence);
  return { code, qty };
}

// A review field read from its OWN node (never whole-page text): exactly one
// shown node, else the page is not one the bot can prove.
async function readReviewField(run, selector, what) {
  const nodes = await shownAll(run.page, selector);
  if (nodes.length !== 1) throw new RefusedError('review_fields_unreadable', `SiteOne review: ${nodes.length} ${what} fields shown (expected exactly one)`, run.evidence);
  return normalizeText(await textOf(nodes[0]));
}

// "Payment Method Pay At branch, Lakewood Ranch 238": after the label, the
// tender is the first comma segment and must be exactly "pay at branch".
const tenderOf = (text) => text.replace(/^payment method\s*:?\s*/, '').split(',')[0].trim();

async function readPlaceButton(run) {
  const buttons = await shownAll(run.page, SELECTORS.placeOrder);
  const enabled = [];
  for (const b of buttons) if (await b.isEnabled().catch(() => false)) enabled.push(b);
  if (buttons.length !== 1 || enabled.length !== 1) throw new RefusedError('place_button_ambiguous', `SiteOne review shows ${buttons.length} Place order button(s), ${enabled.length} enabled (expected exactly one)`, run.evidence);
  run.evidence.placeButton = normalizeText(await textOf(enabled[0])).slice(0, 60);
  return enabled[0];
}

// Everything the click is bound to, read from the review page right now.
async function readReview(run) {
  const { page, storeId, evidence } = run;
  const tender = await readReviewField(run, SELECTORS.reviewTender, 'payment method');
  const pickup = await readReviewField(run, SELECTORS.reviewPickup, 'pickup location');
  evidence.reviewTender = tender.slice(0, 80);
  evidence.reviewPickup = pickup.slice(0, 120);
  if (tenderOf(tender) !== 'pay at branch') throw new RefusedError('not_pay_at_branch', 'SiteOne review: the payment method is not exactly Pay at Branch', evidence);
  if (!hasToken(pickup, storeId)) throw new RefusedError('pickup_not_selected', `SiteOne review: the pickup location does not show store ${storeId}`, evidence);
  const accountNodes = await shownAll(page, SELECTORS.reviewAccount);
  if (accountNodes.length !== 1) throw new RefusedError('account_unreadable', `SiteOne review: ${accountNodes.length} account fields shown (expected exactly one)`, evidence);
  checkAccountText(run, await textOf(accountNodes[0]), 'review account');
  const { code, qty } = await readReviewItem(run);
  const totalCents = await readTotal(page, SELECTORS.reviewTotal, 'review total', evidence);
  evidence.reviewTotalCents = totalCents;
  return { tender, pickup, code, qty, totalCents, button: await readPlaceButton(run) };
}
const reviewKey = (r) => JSON.stringify([r.tender, r.pickup, r.code, r.qty, r.totalCents]);

// Order-number-looking strings on a page (a digit, 4-20 characters).
function numberTokens(text) {
  return new Set([...String(text || '').toUpperCase().matchAll(/[A-Z0-9][A-Z0-9-]{3,19}/g)].map((m) => m[0]).filter((t) => /\d/.test(t)));
}

// Order numbers after a confirmation label that are NOT in `exclude`
// (the review page's own strings and our PO); one distinct candidate or none.
// The whole identifier must match: an overlength number never matches by its prefix.
const CONFIRMATION_RE = /(?:order\s*(?:#|number|no\.?|id)|confirmation(?:\s*(?:#|number|no\.?|id))?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,19})(?![A-Z0-9-])/gi;
function orderNumberIn(text, exclude = []) {
  const skip = new Set([...(typeof exclude === 'string' ? [exclude] : (exclude || []))].filter(Boolean).map((x) => String(x).toUpperCase()));
  const found = new Set();
  for (const m of String(text || '').matchAll(CONFIRMATION_RE)) {
    const n = m[1].toUpperCase();
    if (/\d/.test(n) && !skip.has(n)) found.add(n);
  }
  return found.size === 1 ? [...found][0] : null;
}

function ambiguousError(message, evidence) {
  const e = new Error(message);
  e.ambiguous = true;
  e.evidence = evidence;
  return e;
}

async function afterClickEvidence(page, poNumber) {
  const heading = await shownAll(page, SELECTORS.heading).then((h) => (h.length ? textOf(h[0]) : '')).catch(() => '');
  const u = parseUrl(page.url());
  return { poNumber: poNumber || null, url: u ? u.pathname : '', h1: String(heading).slice(0, 120) };
}

// The code in /checkout/orderConfirmation/<code>: exactly one segment after the
// prefix, shaped like an order number. Any other path gives null.
function confirmationCodeOf(pathname) {
  if (!pathname.startsWith(URLS.confirmationPathPrefix)) return null;
  const rest = pathname.slice(URLS.confirmationPathPrefix.length);
  if (!rest || rest.includes('/')) return null;
  let code = '';
  try { code = decodeURIComponent(rest).toUpperCase(); } catch { return null; }
  return /^[A-Z0-9][A-Z0-9-]{3,19}$/.test(code) && /\d/.test(code) ? code : null;
}

// The confirmation: a NEW number (not on the review page before the click, not
// our PO) read ONLY on the vendor's confirmation path on siteone.com: from its
// own number node, else from the URL's <code> segment. Any other page — the
// review page still, order history, an account page — reads nothing.
async function readConfirmation(run, baseline) {
  const u = parseUrl(run.page.url());
  if (!u || u.origin !== BASE) throw ambiguousError('the page after the click left https://www.siteone.com', null);
  const urlCode = confirmationCodeOf(u.pathname);
  if (!urlCode) return null;
  const skip = new Set([...baseline, run.poNumber].filter(Boolean).map((x) => String(x).toUpperCase()));
  const nodes = await shownAll(run.page, SELECTORS.confirmationNumber);
  if (nodes.length > 1) return null;
  let fieldNumber = null;
  if (nodes.length === 1) {
    const text = await textOf(nodes[0]);
    const bare = text.trim().toUpperCase();
    fieldNumber = orderNumberIn(text, skip) || (/^[A-Z0-9][A-Z0-9-]{3,19}$/.test(bare) && /\d/.test(bare) && !skip.has(bare) ? bare : null);
    // A confirmation field that is present but unreadable or ambiguous is an unknown outcome: the URL
    // code is the fallback only when the field is absent.
    if (!fieldNumber) return null;
  }
  return fieldNumber || (skip.has(urlCode) ? null : urlCode);
}

// Bind the reservation to the click: the cap check passed on `first`, so what
// is clicked must be exactly that. Read it all again; any change → no click.
async function bindToClick(run, first) {
  const { page, evidence } = run;
  if (!run.dryRun) await run.gate(first.totalCents, 'final claim check'); // the claim is re-asserted at the click
  // A catch-all text read would turn a failed read into an empty baseline and
  // let a number already on the page pass as new: it must succeed and be non-empty.
  let baseline;
  try {
    const bodyText = String(await (await oneAttached(page, SELECTORS.body, 'page bodies', evidence)).innerText());
    if (!bodyText.trim()) throw new Error('empty');
    baseline = numberTokens(bodyText);
  } catch { throw new RefusedError('baseline_unreadable', 'SiteOne review: the page text could not be read before the click', evidence); }
  // The element that will be clicked is fixed BEFORE the final re-read, and it
  // must still be that same, attached element afterwards.
  const handle = await (await readPlaceButton(run)).elementHandle();
  if (!handle || !(await handle.isVisible().catch(() => false)) || !(await handle.isEnabled().catch(() => false))) throw new RefusedError('place_button_ambiguous', 'SiteOne review: the Place order button is not visible and enabled', evidence);
  // Every slow check first (URL, sign-out, button identity); the full review re-read LAST, so nothing
  // the cap check approved can change between the final read and the click (pre-push round 8 P0).
  assertAt(run, PATHS.review, 'order review');
  // The review URL the click step must still be on, taken at the path check (before any other await).
  const href = page.url();
  await assertSignedIn(run);
  if (!(await handle.isVisible().catch(() => false)) || !(await handle.isEnabled().catch(() => false))) throw new RefusedError('place_button_replaced', 'SiteOne review: the Place order button was replaced or detached after the checks — nothing clicked', evidence);
  const again = await readReview(run);
  if (reviewKey(again) !== reviewKey(first)) throw new RefusedError('review_changed', 'SiteOne review changed after the cap check — nothing clicked', evidence, again.totalCents);
  const current = await again.button.elementHandle();
  const same = await page.evaluate(([x, y]) => x === y && x.isConnected, [handle, current]).catch(() => false);
  if (!same || !(await handle.isEnabled().catch(() => false))) throw new RefusedError('place_button_replaced', 'SiteOne review: the Place order button was replaced or detached after the checks — nothing clicked', evidence);
  // Every field the cap check approved — tender, pickup, bill-to account, item, quantity, total — is
  // bound to its exact node and raw text here, proven equal to the approved review, and checked again
  // with the review URL inside the one browser step that clicks (clickPlaceOrder).
  const fields = await bindReviewFields(run, first);
  return { handle, baseline, totalCents: again.totalCents, fields, href };
}

// The top-level review fields (each exactly one shown node) and what each must still read.
const BOUND_FIELDS = [
  ['reviewTender', (run, raw, first) => normalizeText(raw) === first.tender],
  ['reviewPickup', (run, raw, first) => normalizeText(raw) === first.pickup],
  ['reviewAccount', (run, raw) => { checkAccountText(run, raw, 'review account at the click'); return true; }],
  ['reviewItemCode', (run, raw, first) => itemNumberAfterColon(raw) === first.code],
  ['reviewTotal', (run, raw, first) => parseMoney(raw) === first.totalCents],
];

async function bindReviewFields(run, first) {
  const { page, evidence } = run;
  const fields = [];
  const bindOne = async (node, selector, ok) => {
    const raw = String(await node.innerText()).trim();
    if (!ok(raw)) throw new RefusedError('review_changed', 'SiteOne review changed at the click — nothing clicked', evidence);
    const handle = await node.elementHandle();
    if (!handle) throw new RefusedError('review_fields_unreadable', 'SiteOne review: a review field could not be bound at the click', evidence);
    fields.push({ selector, handle, raw });
  };
  for (const [key, check] of BOUND_FIELDS) {
    const nodes = await shownAll(page, SELECTORS[key]);
    if (nodes.length !== 1) throw new RefusedError('review_fields_unreadable', `SiteOne review: ${nodes.length} ${key} fields shown at the click (expected exactly one)`, evidence);
    await bindOne(nodes[0], SELECTORS[key], (raw) => check(run, raw, first));
  }
  const block = (await shownAll(page, SELECTORS.reviewItemCode))[0].locator(SELECTORS.reviewItemBlock);
  const qtyNodes = (await block.count().catch(() => 0)) ? await shownAll(block.nth(0), SELECTORS.reviewQty) : [];
  if (qtyNodes.length !== 1) throw new RefusedError('review_qty_unreadable', 'SiteOne review: the item quantity could not be read at the click', evidence);
  await bindOne(qtyNodes[0], SELECTORS.reviewQty, (raw) => { const f = raw.match(/\d+/g) || []; return f.length === 1 && Number(f[0]) === first.qty; });
  // The quantity is matched inside its own item block, not the whole page.
  fields[fields.length - 1].scope = await block.nth(0).elementHandle();
  if (!fields[fields.length - 1].scope) throw new RefusedError('review_qty_unreadable', 'SiteOne review: the item block could not be bound at the click', evidence);
  return fields;
}

// The cart is shared with the owner's phone app, and SiteOne submits ITS server-side cart: an edit
// from the phone in the last moments before the click cannot be seen in this page. So the placed
// order's own total, on the confirmation page, must equal the approved total. A different or
// unreadable total parks the order for a person (needs_review, with its order number), never
// records it as placed at the approved amount.
async function provePlacedTotal(run, number, bound) {
  const approvedCents = bound.totalCents;
  const evidence = { ...run.evidence, confirmed: true, externalOrderNumber: number };
  const parked = (message, cents) => Object.assign(ambiguousError(message, evidence), { cents, externalOrderNumber: number });
  // The total can render after the URL changes: poll THIS confirmation page for it. Each read is
  // bound to the order whose number was read: the same URL, and the same number on it, before and
  // after the total is read. A page that changed identity parks the order.
  const href = run.page.url();
  const sameOrder = async () => run.page.url() === href && (await readConfirmation(run, bound.baseline)) === number;
  const readTotalOnce = async () => {
    if (!(await sameOrder())) throw parked(`SiteOne order ${number}: the confirmation page changed before its total was read — check the order with the vendor`, approvedCents);
    const nodes = await shownAll(run.page, SELECTORS.confirmationTotal);
    const cents = nodes.length === 1 ? parseMoney(String(await nodes[0].innerText()).trim()) : null;
    if (cents == null) return null;
    if (!(await sameOrder())) throw parked(`SiteOne order ${number}: the confirmation page changed while its total was read — check the order with the vendor`, approvedCents);
    return cents;
  };
  let placedCents;
  try { placedCents = await poll(run.page, readTotalOnce, CONFIRMATION_WAIT, run.opts.confirmStep); } catch (e) { if (e.ambiguous) throw e; placedCents = null; }
  evidence.confirmationTotalCents = placedCents;
  if (placedCents !== approvedCents) {
    // Count the purchase at what SiteOne confirmed when it is readable (higher or lower); the
    // approved total only when the confirmation total cannot be read.
    throw parked(`SiteOne order ${number} was placed, but its confirmation total ${placedCents == null ? 'could not be read' : `(${(placedCents / 100).toFixed(2)})`} is not the approved total (${(approvedCents / 100).toFixed(2)}) — check the order with the vendor`, placedCents ?? approvedCents);
  }
  return { externalOrderNumber: number, amountCents: approvedCents, evidence, dryRun: false };
}

// From the click on, every failure is ambiguous: the order may exist.
async function clickPlaceOrder(run, bound) {
  const { page, poNumber } = run;
  // ONE synchronous browser task: the same attached, enabled button, and the exact total and tender
  // text the cap check approved, then the click — nothing can change between the check and the click.
  let fired;
  try {
    fired = await page.evaluate(([btn, href, placeSel, fields]) => {
      const doc = btn && btn.ownerDocument;
      // The ONE shown match of a selector (in a scope) must be this exact node.
      const soleShownIs = (scope, sel, node) => { const shown = [...scope.querySelectorAll(sel)].filter((e) => e.offsetParent !== null); return shown.length === 1 && shown[0] === node; };
      if (!doc || !btn.isConnected || btn.disabled || !soleShownIs(doc, placeSel, btn)) return { clicked: false, why: 'button' };
      for (const f of fields) {
        if (!f.node || !f.node.isConnected || String(f.node.innerText).trim() !== f.raw) return { clicked: false, why: 'changed' };
        if (!soleShownIs(f.scope || doc, f.selector, f.node)) return { clicked: false, why: 'fields' };
      }
      if (doc.location.href !== href) return { clicked: false, why: 'url' };
      // Last, right before the click: still the one shown, enabled Place order control.
      if (!btn.isConnected || btn.disabled || !soleShownIs(doc, placeSel, btn)) return { clicked: false, why: 'button' };
      btn.click();
      return { clicked: true };
    }, [bound.handle, bound.href, SELECTORS.placeOrder, bound.fields.map((f) => ({ node: f.handle, raw: f.raw, selector: f.selector, scope: f.scope || null }))]);
  } catch (err) {
    // The task may have run the click before it failed: the order may exist.
    run.submitted = true;
    throw ambiguousError(`SiteOne Place order step failed: ${String(err.message).slice(0, 120)} — verify with the vendor`, await afterClickEvidence(page, poNumber).catch(() => ({ poNumber: poNumber || null })));
  }
  if (!fired || fired.clicked !== true) throw new RefusedError('review_changed', `SiteOne review changed at the click (${(fired && fired.why) || 'unknown'}) — nothing clicked`, run.evidence);
  run.submitted = true;
  try {
    const number = await poll(page, () => readConfirmation(run, bound.baseline), CONFIRMATION_WAIT, run.opts.confirmStep);
    if (number) return await provePlacedTotal(run, number, bound);
  } catch (err) {
    if (err.ambiguous && err.evidence) throw err; // already classified, with its own evidence (provePlacedTotal)
    throw ambiguousError(`SiteOne Place order was clicked and failed after it: ${String(err.message).slice(0, 120)} — verify with the vendor`, { ...(await afterClickEvidence(page, poNumber).catch(() => ({ poNumber: poNumber || null }))), error: String(err.message).slice(0, 120) });
  }
  throw ambiguousError('SiteOne Place order was clicked but no new order number was found on a confirmation page — verify with the vendor', await afterClickEvidence(page, poNumber).catch(() => ({ poNumber: poNumber || null })));
}

async function walk(run) {
  await assertCartEmpty(run);
  await openProduct(run);
  await checkProduct(run);
  await addToCart(run);
  await verifyCartAndGate(run);
  await fillOrderType(run);
  await choosePayAtBranch(run);
  const first = await readReview(run);
  await run.gate(first.totalCents, 'order');
  const bound = await bindToClick(run, first);
  if (run.dryRun) return { dryRun: true, amountCents: bound.totalCents, externalOrderNumber: null, evidence: run.evidence };
  return clickPlaceOrder(run, bound);
}

// ---- place() ----------------------------------------------------------------

function validateArgs({ vendorSku, quantity, poNumber }) {
  const sku = String(vendorSku || '').trim();
  if (!sku) throw new RefusedError('no_sku', 'product has no SiteOne SKU');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw new RefusedError('bad_quantity', `quantity ${quantity} is not a positive whole package count`);
  if (poNumber != null && poNumber !== '' && !PO_PATTERN.test(String(poNumber))) throw new RefusedError('bad_po_number', 'PO number must be 1-20 characters of A-Z, 0-9 and "-"');
  return { sku, qty, po: poNumber ? String(poNumber) : null };
}

async function defaultConnect(url) {
  if (!chromium) throw new Error('playwright unavailable');
  return chromium.connectOverCDP(url, { timeout: 10000 });
}

async function openPageInOwnerChrome(env, connect) {
  const url = String(env.SITEONE_CDP_URL).trim();
  if (!isLocalCdpUrl(url)) throw runLevel('siteone cdp: SITEONE_CDP_URL must be a local DevTools address');
  let browser;
  try { browser = await connect(url); } catch (e) { throw runLevel(`siteone cdp: Chrome is not reachable on ${url}: ${String(e.message).slice(0, 100)}`); }
  const context = browser.contexts()[0];
  if (!context) throw runLevel('siteone cdp: Chrome has no default browser context');
  let page;
  try { page = await context.newPage(); } catch (e) { throw runLevel(`siteone cdp: could not open a page in Chrome: ${String(e.message).slice(0, 100)}`); }
  return { browser, page };
}

// A failure that is not already classified: after the click it is ambiguous;
// before it, a dead Chrome is run-level and anything else passes through.
function classify(err, run) {
  if (err.refuse || err.runLevel || err.ambiguous) return err;
  if (run.submitted) return ambiguousError(`SiteOne order may have been placed: ${String(err.message).slice(0, 120)}`, { poNumber: run.poNumber || null });
  if (/closed|disconnected|ECONNREFUSED|ECONNRESET/i.test(String(err.message))) return runLevel(`siteone cdp: lost Chrome: ${String(err.message).slice(0, 100)}`);
  return err;
}

async function place(args, opts = {}) {
  const env = opts.env || process.env;
  const connect = opts.connect || defaultConnect;
  const { sku, qty, po } = validateArgs(args);
  if (!configured(env)) throw runLevel('siteone cdp: SITEONE_CDP_URL, SITEONE_APPROVED_STORE_ID, SITEONE_APPROVED_PICKUP and SITEONE_APPROVED_ACCOUNT must all be set');
  if (typeof args.beforeSubmit !== 'function') throw new RefusedError('no_cap_check', 'no cap check was supplied — the bot never orders without one');
  const dryRun = isDryRun(env, args.dryRun);
  // SiteOne submits (and removes from) its server-side cart, and a cart shared with the owner's phone
  // app can change where this page cannot see it. Every run — a dry run adds and removes a line too —
  // needs the robot's OWN SiteOne login (a separate web user on the account, signed in only in the
  // robot's Chrome), which the owner confirms with SITEONE_CART_ISOLATED=true.
  if (env.SITEONE_CART_ISOLATED !== 'true') throw runLevel('siteone cdp: SITEONE_CART_ISOLATED=true is required (the robot\'s own SiteOne login, not a cart shared with the phone app) — nothing was added or clicked');
  const evidence = { adapter: 'siteone-cdp', dryRun };
  // A { ok: false } verdict is an ordinary refusal. The cap check THROWING is
  // the environment's problem (run-level), never a parked order.
  const gate = async (cents, what) => {
    let verdict;
    try { verdict = await args.beforeSubmit(cents); } catch (e) { throw runLevel(`siteone cdp: cap check failed at the ${what}: ${String(e.message).slice(0, 120)}`); }
    if (!verdict || verdict.ok !== true) throw new RefusedError(verdict?.reason || 'over_cap', verdict?.message || `cap check refused the ${what}`, evidence, cents);
  };
  const { browser, page } = await openPageInOwnerChrome(env, connect);
  const run = {
    page, vendorSku: sku, quantity: qty, poNumber: po, dryRun, evidence, gate, account: String(env.SITEONE_APPROVED_ACCOUNT).trim(), cartEmptyBefore: false, ownEntry: null, accountMismatch: false, added: false, poFilled: false, submitted: false,
    storeId: String(env.SITEONE_APPROVED_STORE_ID).trim(), pickupTokens: csv(env.SITEONE_APPROVED_PICKUP),
    opts: { settleMs: opts.settleMs ?? SETTLE_MS, confirmStep: opts.confirmStep ?? 1000 },
  };
  try {
    if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(ACTION_TIMEOUT);
    // `await` is load-bearing: the finally reads run.submitted afterwards.
    return await walk(run);
  } catch (err) {
    throw classify(err, run);
  } finally {
    await cleanup(run);
    // Only our own page is closed; then our connection is dropped.
    try { await page.close(); } catch { /* noop */ }
    // On a connectOverCDP browser close() only drops our WebSocket (see the header).
    try { await browser.close(); } catch { /* noop */ }
  }
}

module.exports = {
  key: 'siteone-cdp',
  loginRequired: false,
  quotesAtPlace: true,
  packagedQuantity: true,
  acceptsPoNumber: true, // the dispatcher passes WAVES-<ledger id>: the order can be found by it after an ambiguous click
  preSubmitTotal: 'vendor', // the review total is read live, immediately before the click
  configured,
  quote: () => null,
  place,
  RefusedError,
  _internals: { SELECTORS, URLS, PATHS, confirmationCodeOf, parseMoney, itemNumberAfterColon, orderNumberIn, numberTokens, hasToken, hasEveryToken, isDryRun, isLocalCdpUrl },
};
