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
 *                            are all set
 *   place({ vendorSku, quantity, beforeSubmit, dryRun, poNumber }) →
 *     { externalOrderNumber, amountCents, evidence, dryRun }
 *   RefusedError (err.refuse) = parked, nothing submitted.
 *   err.runLevel = Chrome not reachable / not signed in: the claim is released.
 *   err.ambiguous = Place order was clicked and the outcome is unknown. The
 *     bot never clicks it again.
 *
 * Hard rules:
 *   - Dry run unless SITEONE_BOT_DRY_RUN is exactly 'false' (fail closed).
 *   - The bot never types a credential. The Okta sign-in form is prefilled by
 *     Chrome; the bot clicks Sign in once per page load and nothing else.
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
 *   - Sign-in: the page origin AND the browser-resolved submission URL
 *     (button.formAction, else form.action) must be an approved
 *     identity-provider origin, and the identifier box and the button must
 *     share one form (el.form identity, read in one page.evaluate) (https siteone.com hosts, plus any exact https
 *     origin in SITEONE_SIGN_IN_ORIGINS — set it to the Okta host the first
 *     dry run shows). Otherwise run-level and nothing is clicked.
 *   - After the click an order number is read only on the vendor's confirmation
 *     path (URLS.confirmationPathPrefix + one segment, UNVERIFIED) and must be
 *     NEW against the review page's strings. Any other destination is ambiguous.
 *   - A PO box that already holds a value refuses (po_field_occupied); cleanup
 *     clears it only while it still equals the PO this run typed.
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
  oktaSubmit: 'input[type="submit"][value="Sign in"]',
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
  // UNVERIFIED: the confirmation page's own order-number node. Without it the
  // number comes from the confirmation URL's <code> segment.
  confirmationNumber: '[data-test="order-number"], .order-confirmation__number, .confirmation-number',
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
// Identity-provider origins the bot may press Sign in on: https siteone.com
// hosts, plus the exact https origins in SITEONE_SIGN_IN_ORIGINS (CSV; set it
// to the Okta host the first dry run shows). Nothing else is ever clicked.
const SIGN_IN_HOST_SUFFIX = '.siteone.com';
const NAV_TIMEOUT = 45000;
const ACTION_TIMEOUT = 15000;
const WAIT_STEP = 500;
const STEP_WAIT = 20000; // bounded wait for the next checkout step
const CONFIRMATION_WAIT = 30000; // bounded wait for the order number after the click
const SETTLE_MS = 2500;
const MAX_SIGN_INS = 3;
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
    && csv(env.SITEONE_APPROVED_PICKUP).length > 0;
}
// Fail closed: only the exact string 'false' turns the dry run off.
const isDryRun = (env, dryRun) => dryRun === true || env.SITEONE_BOT_DRY_RUN !== 'false';

// ---- small readers ----------------------------------------------------------

const normalizeText = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim().toLowerCase();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, token) => new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizeText(token))}($|[^a-z0-9])`).test(normalizeText(text));
const hasEveryToken = (text, tokens) => tokens.length > 0 && tokens.every((t) => hasToken(text, t));

// The ONE currency amount in a total's text; zero or several → null.
function parseMoney(text) {
  const amounts = [...String(text || '').replace(/,/g, '').matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (amounts.length !== 1) return null;
  const n = amounts[0];
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

function isApprovedSignInOrigin(u, env) {
  const url = parseUrl(u);
  if (!url || url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'siteone.com' || host.endsWith(SIGN_IN_HOST_SUFFIX)) return true;
  return csv(env.SITEONE_SIGN_IN_ORIGINS).some((o) => parseUrl(o)?.origin === url.origin && o.startsWith('https://'));
}

// ---- navigation + sign-in ---------------------------------------------------

async function signInFormShown(page) { return (await shownAll(page, SELECTORS.oktaIdentifier)).length > 0; }

// One page.evaluate over both elements: same form owner (el.form identity) and
// the browser-resolved submission URL.
async function readSignInSubmission(page, identifier, button) {
  const handles = [await identifier.elementHandle(), await button.elementHandle()];
  try {
    return await page.evaluate(([idEl, btn]) => ({
      sameForm: !!idEl.form && idEl.form === btn.form,
      submitUrl: btn.formAction || (btn.form && btn.form.action) || '',
    }), handles);
  } catch { throw runLevel('siteone cdp: the sign-in form could not be proven'); }
  finally { for (const h of handles) await h?.dispose?.().catch(() => {}); }
}

// The Okta form is Chrome-prefilled: the bot checks the identifier is already
// there, then clicks the one Sign in button. It never types.
async function clickPrefilledSignIn(run) {
  const { page, evidence, env } = run;
  // The page's own origin first: nothing is read or clicked on an unapproved one.
  if (!isApprovedSignInOrigin(page.url(), env)) throw runLevel('siteone cdp: the sign-in page is not on an approved identity-provider origin');
  run.signIns += 1;
  if (run.signIns > MAX_SIGN_INS) throw runLevel('siteone cdp: signed out again and again — the profile is not signed in');
  const identifier = await oneShown(page, SELECTORS.oktaIdentifier, 'sign-in identifier boxes', evidence).catch(() => { throw runLevel('siteone cdp: the sign-in form is not readable'); });
  const button = await oneShown(page, SELECTORS.oktaSubmit, 'Sign in buttons', evidence).catch(() => { throw runLevel('siteone cdp: the Sign in button is not readable'); });
  // The identifier and the button must belong to the SAME form, and the URL the
  // browser would submit to (button.formAction, else form.action — both already
  // resolved against document.baseURI) must be an approved origin.
  const submission = await readSignInSubmission(page, identifier, button);
  if (!submission.sameForm) throw runLevel('siteone cdp: the identifier box and the Sign in button are not in the same form');
  if (!isApprovedSignInOrigin(parseUrl(submission.submitUrl)?.href, env)) throw runLevel('siteone cdp: the sign-in form would submit to an unapproved origin');
  if (!String(await identifier.inputValue().catch(() => '')).trim()) throw runLevel('siteone cdp: the sign-in form is not prefilled — sign in on the Mac by hand');
  await button.click();
  evidence.signIns = run.signIns;
  await page.waitForTimeout(run.opts.settleMs);
}


// `pathname`: when given, the page must end exactly there (the cart, checkout).
async function openPage(run, url, pathname = null) {
  const { page } = run;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (await signInFormShown(page)) {
    await clickPrefilledSignIn(run);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (await signInFormShown(page)) throw runLevel('siteone cdp: still not signed in after the prefilled sign-in');
  }
  assertAt(run, pathname, 'navigation');
  await page.waitForTimeout(run.opts.settleMs);
}

// ---- cart helpers -----------------------------------------------------------

async function cartRows(page) { return (await matches(page, SELECTORS.cartRow)).all; }
async function rowReading(row) {
  return {
    sku: String((await row.getAttribute('data-itemnumber').catch(() => '')) || '').trim(),
    requested: String((await row.getAttribute('data-requestedqty').catch(() => '')) || '').trim(),
    inputQty: await row.locator(SELECTORS.cartQtyInput).count().then(async (n) => {
      if (!n) return null;
      const el = row.locator(SELECTORS.cartQtyInput).nth(0);
      return (await el.isVisible().catch(() => false)) ? String(await el.inputValue().catch(() => '')).trim() : null;
    }),
  };
}

// Remove ONLY the line this run added: its row, matched by item number.
async function removeOwnRow(run) {
  const { page, vendorSku } = run;
  await openPage(run, URLS.cart, PATHS.cart);
  const ours = [];
  for (const row of await cartRows(page)) {
    const reading = await rowReading(row);
    if (reading.sku === vendorSku) ours.push({ row, reading });
  }
  if (!ours.length) { run.evidence.cleanup = 'row_absent'; return; }
  // Only a row that is exactly what this run added (one line, the quantity we
  // set, the cart empty before) is removed. Anything else — a changed or merged
  // quantity, a second line — belongs to the owner now: leave it.
  const readings = ours.length === 1 ? [ours[0].reading.requested, ours[0].reading.inputQty].filter((q) => q != null && q !== '') : [];
  const exact = run.cartEmptyBefore && readings.length > 0 && readings.every((q) => Number(q) === run.quantity);
  if (!exact) { run.evidence.cleanup = 'cart_left_for_owner'; run.evidence.cart_left_for_owner = true; return; }
  const link = await shownAll(ours[0].row, SELECTORS.cartRemoveLine);
  if (link.length !== 1) { run.evidence.cleanup = 'remove_link_unreadable'; run.evidence.cart_left_for_owner = true; return; }
  await link[0].click();
  await page.waitForTimeout(run.opts.settleMs);
  run.evidence.cleanup = 'row_removed';
}

async function clearPo(run) {
  const { page } = run;
  await openPage(run, URLS.checkout, PATHS.checkout);
  const po = await shownAll(page, SELECTORS.poInput);
  // Clear it only while it still holds exactly the PO we typed; any other value is not ours.
  const ours = po.length === 1 && (await po[0].inputValue().catch(() => null)) === run.poNumber;
  if (ours) await po[0].fill('');
  run.evidence.poCleared = ours;
  if (!ours) run.evidence.po_left_for_owner = true;
}

// Best-effort cleanup of what THIS run left behind (never on a submitted order).
async function cleanup(run) {
  if (run.submitted) return;
  if (run.poFilled) {
    try { await clearPo(run); } catch (e) { run.evidence.poCleared = false; logger.warn(`[siteone-cdp] PO cleanup failed: ${String(e.message).slice(0, 120)}`); }
  }
  if (run.added) {
    try { await removeOwnRow(run); } catch (e) { run.evidence.cleanup = 'failed'; logger.warn(`[siteone-cdp] cart cleanup failed: ${String(e.message).slice(0, 120)}`); }
  }
}

// ---- stages -----------------------------------------------------------------

async function assertCartEmpty(run) {
  await openPage(run, URLS.cart, PATHS.cart);
  const rows = await cartRows(run.page);
  run.evidence.cartRowsBefore = rows.length;
  run.cartEmptyBefore = rows.length === 0;
  if (rows.length) throw new RefusedError('cart_not_empty', `SiteOne cart already holds ${rows.length} line(s) — never touched: empty it by hand`, run.evidence);
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
  const reached = await poll(page, async () => atSiteOne(page, PATHS.checkout), STEP_WAIT);
  if (!reached) { assertAt(run, PATHS.checkout, 'checkout'); throw new RefusedError('page_unrecognized', 'SiteOne did not reach the checkout page', evidence); }
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
  if (poNumber) {
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
  const label = await poll(page, async () => { const s = await shownAll(page, SELECTORS.payAtBranchLabel); return s.length === 1 ? s[0] : null; }, STEP_WAIT);
  if (!label) throw new RefusedError('not_pay_at_branch', 'SiteOne checkout: no Pay at Branch choice appeared', evidence);
  await assertNoPaymentPrompt(page, evidence);
  await label.click();
  const radio = await oneAttached(page, SELECTORS.payAtBranchRadio, 'Pay at Branch radios', evidence);
  if (!(await radio.isChecked().catch(() => false))) throw new RefusedError('not_pay_at_branch', 'SiteOne checkout: Pay at Branch is not selected after the click', evidence);
  await assertNoPaymentPrompt(page, evidence);
  const review = await oneShown(page, SELECTORS.reviewButton, 'Review Your Order buttons', evidence);
  await review.click();
  const reached = await poll(page, async () => atSiteOne(page, PATHS.review), STEP_WAIT);
  if (!reached) { assertAt(run, PATHS.review, 'order review'); throw new RefusedError('page_unrecognized', 'SiteOne did not reach the order review page', evidence); }
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
const CONFIRMATION_RE = /(?:order\s*(?:#|number|no\.?|id)|confirmation(?:\s*(?:#|number|no\.?|id))?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,19})/gi;
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
  }
  return fieldNumber || (skip.has(urlCode) ? null : urlCode);
}

// Bind the reservation to the click: the cap check passed on `first`, so what
// is clicked must be exactly that. Read it all again; any change → no click.
async function bindToClick(run, first) {
  const { page, evidence } = run;
  if (!run.dryRun) await run.gate(first.totalCents, 'final claim check'); // the claim is re-asserted at the click
  let baseline;
  try { baseline = numberTokens(await textOf(await oneAttached(page, SELECTORS.body, 'page bodies', evidence))); } catch { throw new RefusedError('review_fields_unreadable', 'SiteOne review: the page text could not be read before the click', evidence); }
  const again = await readReview(run);
  if (reviewKey(again) !== reviewKey(first)) throw new RefusedError('review_changed', 'SiteOne review changed after the cap check — nothing clicked', evidence, again.totalCents);
  assertAt(run, PATHS.review, 'order review');
  return { button: again.button, baseline, totalCents: again.totalCents };
}

// From the click on, every failure is ambiguous: the order may exist.
async function clickPlaceOrder(run, bound) {
  const { page, poNumber } = run;
  run.submitted = true;
  try {
    await bound.button.click();
    const number = await poll(page, () => readConfirmation(run, bound.baseline), CONFIRMATION_WAIT, run.opts.confirmStep);
    if (number) return { externalOrderNumber: number, amountCents: bound.totalCents, evidence: { ...run.evidence, confirmed: true }, dryRun: false };
  } catch (err) {
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
  if (!configured(env)) throw runLevel('siteone cdp: SITEONE_CDP_URL, SITEONE_APPROVED_STORE_ID and SITEONE_APPROVED_PICKUP must all be set');
  if (typeof args.beforeSubmit !== 'function') throw new RefusedError('no_cap_check', 'no cap check was supplied — the bot never orders without one');
  const dryRun = isDryRun(env, args.dryRun);
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
    page, vendorSku: sku, quantity: qty, poNumber: po, dryRun, evidence, gate, signIns: 0, env, cartEmptyBefore: false, added: false, poFilled: false, submitted: false,
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
  _internals: { SELECTORS, URLS, PATHS, confirmationCodeOf, parseMoney, itemNumberAfterColon, orderNumberIn, numberTokens, hasToken, hasEveryToken, isDryRun, isLocalCdpUrl, isApprovedSignInOrigin },
};
