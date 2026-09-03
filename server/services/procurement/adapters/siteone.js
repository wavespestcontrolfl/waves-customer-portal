/**
 * procurement/adapters/siteone.js — SiteOne (siteone.com) browser-bot adapter.
 *
 * SiteOne has no ordering API, so this is an in-process Playwright bot that
 * signs in with the vendor row's encrypted login, EMPTIES the cart, searches
 * the product's SKU, sets the quantity (PACKAGES — the dispatcher converts
 * the inventory-unit request through the price row's pack size), verifies
 * the cart holds exactly that one line at that count, reads the CART TOTAL
 * (cap pre-check, dry-run stop), then at checkout selects bill-to-account,
 * VERIFIES it is selected, reads the FINAL total with tax + shipping and
 * runs the dispatcher's beforeSubmit(totalCents) cap check on it immediately
 * before the place-order click — only then, and only when SITEONE_BOT_DRY_RUN
 * is not set, does it submit. Whatever it left in the cart without
 * submitting (dry run, refusal) it clears again before closing.
 *
 * Hard rules (same boundary as the backlink signup runner):
 *   - the bot NEVER types payment data; a checkout that asks for a card,
 *     an MFA code, or a terms acceptance parks the request (needs_review)
 *     with a screenshot, no submit. Bill-to-account must be CONFIRMED
 *     selected (a checked radio) before the click — a saved card that shows
 *     no card field is otherwise invisible to the card check (Codex r1 P1).
 *   - the cart is never trusted: leftovers from an earlier dry run or a
 *     refused run would ride along under the aggregate total, so the bot
 *     starts from an empty cart and refuses unless the cart is exactly
 *     [this SKU × this package count] (Codex r1 P1).
 *   - the checkout's DISPLAYED billing account and ship-to are read and
 *     compared before the click (pre-push P0): the account digits must
 *     contain the vendor row's account_number, and every CSV token of
 *     SITEONE_APPROVED_SHIP_TO (e.g. "123 Example Ave,34205") must appear in
 *     the ship-to text. Unset, unreadable, or mismatched → refused, no
 *     submit. A stale default account or address never receives an
 *     unattended order.
 *   - credentials are only written on https + a siteone.com host, inside a
 *     single page.evaluate that re-checks the host (veseris.js pattern).
 *   - egress lock: Chromium's DNS is pinned to the verified public IPs of
 *     siteone.com / www.siteone.com (+ SITEONE_BOT_ALLOWED_HOSTS, CSV — CDN
 *     hosts discovered in dry runs) and every other request is aborted
 *     before it connects (browser-form-filler.js requestAllowed model).
 *     Blocked hosts are counted into evidence so the allowlist can be tuned.
 *   - every selector lives in SELECTORS so a storefront change is a
 *     one-place fix. They are UNVERIFIED against the live site until the
 *     prod dry run (SITEONE_BOT_DRY_RUN=true) has been walked once.
 *
 * Contract with order-dispatch.js:
 *   quotesAtPlace = true → there is no static quote; the cart total is the
 *     quote and the cap check runs through beforeSubmit.
 *   packagedQuantity = true → `quantity` is a package count, not an
 *     inventory-unit amount (order-dispatch.js vendorOrderQuantity).
 *   place({ vendorSku, quantity, credentials, beforeSubmit, dryRun }) →
 *     { externalOrderNumber, amountCents, evidence, dryRun }
 *   RefusedError (err.refuse) = parked, nothing submitted.
 *   err.runLevel = true (no browser, login failed, host not public) = the
 *     run is broken, not this request: the dispatcher releases the claim.
 *   err.ambiguous = true = the submit click happened and the outcome is
 *     unknown: needs_review, never retried.
 */
/* global document, location */ // page.evaluate bodies run in the browser
const logger = require('../../logger');
const { _internals: filler } = require('../../seo/browser-form-filler');
const { uploadEvidence } = require('../../seo/signup-evidence');

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const SELECTORS = Object.freeze({
  loginUser: 'input[name="username"], input[name="email"], input[type="email"], input#username, input#j_username',
  loginPass: 'input[name="password"], input[type="password"]',
  loginSubmit: 'form:has(input[type="password"]) button[type="submit"], form:has(input[type="password"]) input[type="submit"]',
  loginError: '.alert-danger, .error-message, [role="alert"]',
  searchInput: 'input[name="text"], input[type="search"], input#js-site-search-input, input[placeholder*="Search"]',
  productLink: '.product-item a.name, .product-item-name a, a.product-name, .product-tile a',
  productSku: '[data-product-code], .product-code, .sku, [itemprop="sku"]',
  qtyInput: 'input[name="qty"], input.qty, input[name="quantity"], input[type="number"]',
  addToCart: 'button.add-to-cart, button#addToCartButton, button[data-action="add-to-cart"], button:has-text("Add to Cart")',
  unavailable: '.out-of-stock, .unavailable, :has-text("Out of Stock"), :has-text("Not available")',
  cartUrl: 'https://www.siteone.com/en/cart',
  cartLine: '.cart-item, .entry-item, .cart-entry, [data-test="cart-line"], tr.item',
  cartLineSku: '[data-product-code], .product-code, .sku, .item-code, [itemprop="sku"]',
  cartLineQty: 'input[name*="qty" i], input[name*="quantity" i], input.qty, input[type="number"], .qty-value, .quantity-value',
  cartRemove: 'button.remove, a.remove, button[data-action="remove"], .remove-item, button:has-text("Remove"), a:has-text("Remove")',
  cartTotal: '.cart-totals .total, .order-total .value, [data-test="cart-total"], .grand-total .price, .cart-total-value',
  checkoutButton: 'a.checkout-button, button.checkout-button, a:has-text("Checkout"), button:has-text("Checkout")',
  cardField: 'input[autocomplete="cc-number"], input[name*="cardNumber"], input[name*="card_number"], iframe[src*="card"]',
  mfaField: 'input[autocomplete="one-time-code"], input[name*="otp"], input[name*="verificationCode"]',
  termsCheckbox: 'input[type="checkbox"][name*="terms"], input[type="checkbox"][name*="Terms"]',
  checkoutTotal: '.checkout-totals .total, .order-summary .grand-total, [data-test="order-total"], .order-total .value, .grand-total .price',
  billToAccount: 'input[type="radio"][value*="account"], input[type="radio"][value*="ACCOUNT"], label:has-text("Bill to account")',
  billToAccountSelected: 'input[type="radio"][value*="account"]:checked, input[type="radio"][value*="ACCOUNT"]:checked, input[type="radio"][value*="Account"]:checked',
  // Identity readings are SCOPED to the checkout's own billing / shipping
  // sections — never a header account menu, a footer address, or an
  // ancestor's text — and place() requires exactly ONE match (pre-push P0).
  checkoutAccount: '.checkout [data-test="account-number"], .checkout-billing .account-number, .checkout .billing-account .account-number, .payment-method.selected .account-number, [data-test="bill-to-account"] .account-number',
  checkoutShipTo: '.checkout [data-test="ship-to"], .checkout-shipping .shipping-address, .checkout .ship-to address, .checkout .delivery-address address, [data-test="shipping-address"]',
  placeOrder: 'button#placeOrder, button.place-order, button:has-text("Place Order")',
  orderNumber: '.order-number, [data-test="order-number"], .confirmation-number, :has-text("Order #")',
});

const NAV_TIMEOUT = 45000;
const LOGIN_TIMEOUT = 45000;
const DEFAULT_LOGIN_URL = 'https://www.siteone.com/en/login';
const EVIDENCE_PREFIX = 'procurement-evidence/';

class RefusedError extends Error {
  constructor(reason, message, evidence) { super(message || reason); this.refuse = reason; if (evidence) this.evidence = evidence; }
}
function runLevel(message) { const e = new Error(message); e.runLevel = true; return e; }

function isTrustedSiteOneUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    return h === 'siteone.com' || h.endsWith('.siteone.com');
  } catch { return false; }
}

function allowedHosts(env = process.env) {
  const extra = String(env.SITEONE_BOT_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(['siteone.com', 'www.siteone.com', ...extra]));
}

// SKU text on the product page vs the catalog SKU: exact match after
// stripping labels/whitespace/case. Unreadable = refuse (never the first hit).
function normalizeSku(text) {
  return String(text || '').trim().replace(/^(?:sku|item|product\s*code|part\s*(?:no|number))\s*[:#.]?\s*/i, '').replace(/[\s\u00a0]+/g, '').toUpperCase();
}

// The ONE currency amount in a total's text: a $-prefixed figure, exactly one
// of them. Zero or several → null (fail closed): "2 items · Total $105.93"
// must never cap-check as 200 cents, and a text carrying two amounts (a
// subtotal beside a total) is not a total the bot can trust (pre-push P0).
function parseMoney(text) {
  const amounts = [...String(text || '').replace(/,/g, '').matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (amounts.length !== 1) return null;
  const n = amounts[0];
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// Digit runs (3+) in a checkout label: "Account # 12345" → ['12345'].
const digitRuns = (s) => String(s || '').match(/\d{3,}/g) || [];
// A configured ship-to token must appear as a whole token, not inside a
// longer run ("34205" does not match "342051").
const hasToken = (text, token) => new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);

const defaultLaunch = ({ hostResolverRules } = {}) => chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...(hostResolverRules ? [`--host-resolver-rules=${hostResolverRules}`] : [])],
});

async function shot(page, label, evidence, upload) {
  try {
    const buf = await page.screenshot({ fullPage: false });
    const key = await upload(buf, `siteone-${label}`, { prefix: EVIDENCE_PREFIX });
    evidence.screenshots = { ...(evidence.screenshots || {}), [label]: key || null };
  } catch (e) { logger.warn(`[siteone-bot] screenshot ${label} failed: ${e.message}`); }
}

async function visible(page, selector) {
  try { return (await page.locator(selector).first().isVisible({ timeout: 1500 })); } catch { return false; }
}

// Case- and whitespace-insensitive comparison text for checkout labels.
const normalizeText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function gotoCart(page) {
  await page.goto(SELECTORS.cartUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone bot: cart navigation left the trusted host');
  await page.waitForTimeout(1500);
}

// Every line in the cart as { sku, qty }: an unreadable SKU or quantity is
// returned as-is (empty / NaN) so the caller's exact-match check fails closed.
async function cartLines(page) {
  const lines = page.locator(SELECTORS.cartLine);
  const n = await lines.count();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const line = lines.nth(i);
    const sku = (await line.locator(SELECTORS.cartLineSku).first().textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
    const qtyEl = line.locator(SELECTORS.cartLineQty).first();
    let qtyText = await qtyEl.inputValue().catch(() => null);
    if (qtyText == null) qtyText = await qtyEl.textContent().catch(() => null);
    const qty = Number(String(qtyText ?? '').replace(/[^\d.]/g, ''));
    out.push({ sku, qty: qtyText == null || qtyText === '' ? NaN : qty });
  }
  return out;
}

// Remove every line (bounded) and return how many are left. 0 = empty.
async function clearCart(page) {
  await gotoCart(page);
  for (let i = 0; i < 25; i += 1) {
    if (!(await page.locator(SELECTORS.cartLine).count())) return 0;
    const remove = page.locator(SELECTORS.cartRemove).first();
    if (!(await remove.count())) break;
    await remove.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  return page.locator(SELECTORS.cartLine).count();
}

async function login(page, creds) {
  const loginUrl = creds.loginUrl && isTrustedSiteOneUrl(creds.loginUrl) ? creds.loginUrl : DEFAULT_LOGIN_URL;
  const attempt = async () => {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
    if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone login aborted: navigation redirected off the trusted host');
    await page.locator(SELECTORS.loginPass).first().waitFor({ state: 'visible', timeout: 30000 });
    // Host check + both writes in ONE page-context execution (veseris.js).
    const filled = await page.evaluate(({ user, pw, userSel, passSel }) => {
      const h = location.hostname.toLowerCase();
      if (location.protocol !== 'https:' || !(h === 'siteone.com' || h.endsWith('.siteone.com'))) return 'offhost';
      const u = document.querySelector(userSel);
      const p = document.querySelector(passSel);
      if (!u || !p) return 'nofields';
      for (const [el, v] of [[u, user], [p, pw]]) {
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return 'ok';
    }, { user: creds.email || creds.username, pw: creds.password, userSel: SELECTORS.loginUser, passSel: SELECTORS.loginPass });
    if (filled !== 'ok') throw runLevel(`siteone login aborted: ${filled === 'offhost' ? 'redirected off the trusted host' : 'login fields not found'}`);
    const submit = page.locator(SELECTORS.loginSubmit).first();
    await submit.click().catch(() => page.locator(SELECTORS.loginPass).first().press('Enter'));
    await page.waitForFunction((passSel) => {
      const pw = document.querySelector(passSel);
      return !pw || !pw.offsetParent;
    }, SELECTORS.loginPass, { timeout: LOGIN_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1500);
    return (await page.locator(`${SELECTORS.loginPass}:visible`).count()) === 0 && isTrustedSiteOneUrl(page.url());
  };
  let ok = false;
  for (let i = 0; i < 3 && !ok; i += 1) {
    if (i) await page.waitForTimeout(3000);
    ok = await attempt();
  }
  if (!ok) {
    const err = (await page.locator(SELECTORS.loginError).first().textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw runLevel(`siteone login failed${err ? `: ${err}` : ''}`);
  }
}

// ---- place() stages ---------------------------------------------------------
// Each stage is a real step of the purchase with its own refusals; place()
// only sequences them. Refusals (RefusedError) park; run-level errors abort
// the batch; anything thrown after the click is `ambiguous`.

// Arguments the bot can act on at all — all refusals, before any browser work.
function validatePlaceArgs({ vendorSku, quantity, credentials, approvedShipTo }) {
  if (!credentials || !credentials.password || !(credentials.email || credentials.username)) throw new RefusedError('no_credentials', 'SiteOne login is not stored on the vendor row');
  if (!credentials.accountNumber) throw new RefusedError('no_account_number', 'SiteOne account number is not on the vendor row (bill-to-account only)');
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RefusedError('bad_quantity', `quantity ${quantity} is not a positive count`);
  if (!vendorSku) throw new RefusedError('no_sku', 'product has no SiteOne SKU');
  const shipToTokens = String(approvedShipTo || '').split(',').map((t) => normalizeText(t)).filter(Boolean);
  if (!shipToTokens.length) throw new RefusedError('ship_to_unconfigured', 'SITEONE_APPROVED_SHIP_TO is not set — the bot never submits to an unverified address');
  return { qty, shipToTokens };
}

// Egress lock: DNS pinned to the verified public IPs of the allowed hosts,
// every off-host request aborted (counted into evidence), WebSockets closed.
async function openLockedBrowser({ launchBrowser, resolveHostIps, evidence }) {
  const rules = [];
  const pinned = new Set();
  for (const h of allowedHosts()) {
    const ips = await resolveHostIps(h);
    if (!ips || !ips.length) continue;
    rules.push(`MAP ${h} ${ips[0]}`);
    pinned.add(h);
  }
  if (!pinned.has('www.siteone.com')) throw runLevel('siteone bot: www.siteone.com did not resolve to a public IPv4');
  let browser;
  try { browser = await launchBrowser({ hostResolverRules: rules.join(',') }); }
  catch (e) { throw runLevel(`siteone bot: browser launch failed: ${String(e.message).slice(0, 120)}`); }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  if (typeof context.route === 'function') {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      let ok = false;
      try { ok = filler.requestAllowed({ url, allowedHosts: pinned }); } catch { ok = false; }
      if (ok) return route.continue();
      const host = filler.hostOf(url) || 'unknown';
      evidence.blockedHosts[host] = (evidence.blockedHosts[host] || 0) + 1;
      return route.abort();
    });
  }
  if (typeof context.routeWebSocket === 'function') {
    try { await context.routeWebSocket('**/*', (ws) => { try { ws.close(); } catch { /* noop */ } }); } catch { /* noop */ }
  }
  return { browser, page };
}

// Search the SKU, open the hit, confirm its code EXACTLY, set the quantity,
// add. Fail CLOSED: an unreadable SKU (selector drift) must never let the
// first search hit into the cart.
async function addProductToCart(page, { vendorSku, qty, evidence, upload }) {
  await page.locator(SELECTORS.searchInput).first().fill(String(vendorSku));
  await page.locator(SELECTORS.searchInput).first().press('Enter');
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);
  const hit = page.locator(SELECTORS.productLink).first();
  if (!(await hit.count())) { await shot(page, 'search', evidence, upload); throw new RefusedError('sku_not_found', `SiteOne search for ${vendorSku} returned no product`, evidence); }
  await hit.click();
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(1500);
  const pageSkuRaw = (await page.locator(SELECTORS.productSku).first().textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  if (!pageSkuRaw) { await shot(page, 'product', evidence, upload); throw new RefusedError('sku_unreadable', `could not read the product SKU on the page for ${vendorSku} (SELECTORS.productSku)`, evidence); }
  if (normalizeSku(pageSkuRaw) !== normalizeSku(vendorSku)) { await shot(page, 'product', evidence, upload); throw new RefusedError('sku_mismatch', `product page shows "${pageSkuRaw.slice(0, 60)}", expected ${vendorSku}`, evidence); }
  if (await visible(page, SELECTORS.unavailable)) { await shot(page, 'product', evidence, upload); throw new RefusedError('unavailable', `SiteOne lists ${vendorSku} as unavailable`, evidence); }
  await page.locator(SELECTORS.qtyInput).first().fill(String(qty));
  await page.locator(SELECTORS.addToCart).first().click();
  await page.waitForTimeout(2000);
}

// The cart must be exactly [this SKU × qty packages] — one line, the right
// code, the right count — before its total means anything. Returns the cart
// total in cents (the dry-run stop / cap screen; the checkout total binds).
async function verifyCartAndReadTotal(page, { vendorSku, qty, evidence, upload }) {
  await gotoCart(page);
  const lines = await cartLines(page);
  const exact = lines.length === 1 && normalizeSku(lines[0].sku) === normalizeSku(vendorSku) && lines[0].qty === qty;
  if (!exact) {
    await shot(page, 'cart', evidence, upload);
    evidence.cartLines = lines.map((l) => ({ sku: l.sku.slice(0, 60), qty: Number.isFinite(l.qty) ? l.qty : null }));
    throw new RefusedError('cart_mismatch', `SiteOne cart is not exactly ${vendorSku} × ${qty}: ${lines.length ? lines.map((l) => `${l.sku || '?'} × ${Number.isFinite(l.qty) ? l.qty : '?'}`).join(', ') : 'empty'}`, evidence);
  }
  const totalText = await page.locator(SELECTORS.cartTotal).first().textContent().catch(() => '');
  const amountCents = parseMoney(totalText);
  await shot(page, 'cart', evidence, upload);
  if (!amountCents) throw new RefusedError('no_cart_total', `could not read the cart total ("${String(totalText || '').trim().slice(0, 40)}")`, evidence);
  evidence.cartTotalCents = amountCents;
  return amountCents;
}

// Exactly ONE element for an identity / money reading, inside the checkout:
// zero is unreadable, more than one is ambiguous — the text the bot would
// compare might not be the order's (pre-push P0s). Returns { count, text,
// visible }; the caller names the refusal.
async function readExactlyOne(page, selector) {
  const els = page.locator(selector);
  const count = await els.count().catch(() => 0);
  if (count !== 1) return { count, text: '', visible: false };
  const text = await els.first().textContent().catch(() => '');
  const isVisible = await els.first().isVisible({ timeout: 1500 }).catch(() => false);
  return { count, text: String(text || ''), visible: isVisible };
}

// Checkout tender: no card / MFA / terms prompt (the bot never answers them),
// bill-to-account offered AND confirmed CHECKED — the click is not proof; a
// checkout defaulting to a saved card shows no card field (Codex r1 P1).
async function verifyBillToAccount(page, { evidence, upload }) {
  const refuse = async (reason, message) => { await shot(page, 'checkout', evidence, upload); throw new RefusedError(reason, message, evidence); };
  if (await visible(page, SELECTORS.mfaField)) await refuse('mfa_required', 'SiteOne checkout asks for a verification code — bot never supplies it');
  if (await visible(page, SELECTORS.cardField)) await refuse('card_required', 'SiteOne checkout asks for card entry — bot never supplies it');
  const terms = page.locator(SELECTORS.termsCheckbox).first();
  if ((await terms.count()) && !(await terms.isChecked().catch(() => true))) await refuse('terms_required', 'SiteOne checkout requires accepting terms — owner action');
  const bill = page.locator(SELECTORS.billToAccount).first();
  if (!(await bill.count())) await refuse('no_bill_to_account', 'bill-to-account option not offered at checkout');
  try { await bill.click({ timeout: 5000 }); }
  catch (e) { await refuse('bill_to_account_unselectable', `bill-to-account option could not be selected (${String(e.message).slice(0, 80)})`); }
  await page.waitForTimeout(1500);
  const selected = (await page.locator(SELECTORS.billToAccountSelected).count().catch(() => 0)) > 0 || (await bill.isChecked().catch(() => false)) === true;
  if (!selected) await refuse('bill_to_account_unverified', 'bill-to-account is not confirmed selected at checkout — the bot never submits on another tender');
  evidence.billToAccountVerified = true;
}

// WHICH account, and WHERE to: the displayed values, compared to what the
// owner configured — a saved default that drifted (another branch account,
// an old address) is exactly the unattended order this refuses. The account
// must be the ONE whole digit run equal to the vendor row's number (12345 is
// not 912345); every approved ship-to token must appear whole.
async function verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload }) {
  const refuse = async (reason, message) => { await shot(page, 'checkout', evidence, upload); throw new RefusedError(reason, message, evidence); };
  // Both readings must be VISIBLE (pre-push P0): a single hidden responsive
  // or stale node carrying the approved values is not what the checkout shows.
  const account = await readExactlyOne(page, SELECTORS.checkoutAccount);
  if (account.count > 1) await refuse('account_ambiguous', `${account.count} billing-account readings at checkout — cannot tell which the order bills`);
  const accountText = normalizeText(account.text);
  if (!accountText) await refuse('account_unverified', 'could not read the billing account shown at checkout');
  if (!account.visible) await refuse('account_hidden', 'the billing-account element at checkout is not visible — not what the order bills');
  const wantDigits = String(credentials.accountNumber).replace(/\D/g, '');
  const accountRuns = digitRuns(accountText);
  if (!wantDigits || accountRuns.length !== 1 || accountRuns[0] !== wantDigits) { evidence.checkoutAccount = accountText.slice(0, 60); await refuse('account_mismatch', `checkout bills account "${accountText.slice(0, 40)}", not the vendor row's ${credentials.accountNumber}`); }
  const shipTo = await readExactlyOne(page, SELECTORS.checkoutShipTo);
  if (shipTo.count > 1) await refuse('ship_to_ambiguous', `${shipTo.count} ship-to readings at checkout — cannot tell which the order ships to`);
  const shipToText = normalizeText(shipTo.text);
  if (!shipToText) await refuse('ship_to_unverified', 'could not read the ship-to address shown at checkout');
  if (!shipTo.visible) await refuse('ship_to_hidden', 'the ship-to element at checkout is not visible — not where the order ships');
  const missing = shipToTokens.filter((t) => !hasToken(shipToText, t));
  if (missing.length) { evidence.checkoutShipTo = shipToText.slice(0, 120); await refuse('ship_to_mismatch', `checkout ships to "${shipToText.slice(0, 80)}" — approved ship-to token(s) not found: ${missing.join(', ')}`); }
  evidence.accountVerified = true;
  evidence.shipToVerified = shipToText.slice(0, 120);
}

// The CHECKOUT total (tax + shipping applied) is the binding amount: exactly
// one VISIBLE element (responsive checkouts keep hidden desktop/mobile
// copies; a stale hidden node is not the figure the vendor charges), parsed
// as exactly one $ amount. Returns cents.
async function readCheckoutTotal(page, { evidence, upload }) {
  const refuse = async (reason, message) => { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError(reason, message, evidence); };
  const total = await readExactlyOne(page, SELECTORS.checkoutTotal);
  if (total.count !== 1) await refuse(total.count ? 'checkout_total_ambiguous' : 'no_checkout_total', total.count ? `${total.count} checkout-total elements — cannot tell which the order charges` : 'no checkout-total element at checkout');
  if (!total.visible) await refuse('checkout_total_hidden', 'the checkout-total element is not visible — not the figure the order charges');
  const finalCents = parseMoney(total.text);
  await shot(page, 'pre-submit', evidence, upload);
  if (!finalCents) throw new RefusedError('no_checkout_total', `could not read the checkout total ("${total.text.trim().slice(0, 40)}")`, evidence);
  evidence.checkoutTotalCents = finalCents;
  return finalCents;
}

// The click and its confirmation number. Anything thrown after the click is
// `ambiguous`: the order may exist — the dispatcher parks, never re-submits.
async function submitAndReadOrderNumber(page, { evidence, upload }) {
  try {
    await page.locator(SELECTORS.placeOrder).first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2500);
  } catch (e) {
    const err = new Error(`siteone submit outcome unknown: ${String(e.message).slice(0, 120)}`);
    err.ambiguous = true; err.evidence = evidence;
    throw err;
  }
  await shot(page, 'confirmation', evidence, upload);
  const numText = (await page.locator(SELECTORS.orderNumber).first().textContent().catch(() => '') || '').replace(/\s+/g, ' ');
  const m = numText.match(/([A-Z0-9-]{5,})\s*$/i);
  if (!m) {
    const err = new Error('siteone: order submitted but no confirmation number was found');
    err.ambiguous = true; err.evidence = evidence;
    throw err;
  }
  return m[1];
}

async function place(
  { vendorSku, quantity, credentials, beforeSubmit, dryRun = String(process.env.SITEONE_BOT_DRY_RUN || '').toLowerCase() === 'true', approvedShipTo = process.env.SITEONE_APPROVED_SHIP_TO },
  { launchBrowser = chromium ? defaultLaunch : null, resolveHostIps = filler.resolvePublicIps, upload = uploadEvidence } = {},
) {
  if (!launchBrowser) throw runLevel('siteone bot: playwright unavailable');
  const { qty, shipToTokens } = validatePlaceArgs({ vendorSku, quantity, credentials, approvedShipTo });
  const evidence = { blockedHosts: {}, dryRun };
  const gate = async (cents, what) => {
    const verdict = await beforeSubmit(cents);
    if (!verdict || verdict.ok !== true) throw new RefusedError(verdict?.reason || 'over_cap', verdict?.message || `cap check refused the ${what}`, evidence);
  };
  let browser = null;
  let page = null;
  let submitted = false; // the place-order click happened: the cart is the vendor's now
  try {
    ({ browser, page } = await openLockedBrowser({ launchBrowser, resolveHostIps, evidence }));
    await login(page, credentials);
    // Start from an EMPTY cart: whatever an earlier dry run or refused run
    // left behind must not ride along under this order's total.
    const leftover = await clearCart(page);
    if (leftover) { await shot(page, 'cart-leftover', evidence, upload); throw new RefusedError('cart_not_empty', `SiteOne cart still holds ${leftover} line(s) the bot could not remove — empty it by hand`, evidence); }
    await addProductToCart(page, { vendorSku, qty, evidence, upload });
    const amountCents = await verifyCartAndReadTotal(page, { vendorSku, qty, evidence, upload });
    await gate(amountCents, 'order');
    if (dryRun) return { dryRun: true, amountCents, externalOrderNumber: null, evidence };

    await page.locator(SELECTORS.checkoutButton).first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);
    if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone bot: checkout left the trusted host');
    await verifyBillToAccount(page, { evidence, upload });
    await verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload });
    const finalCents = await readCheckoutTotal(page, { evidence, upload });
    await gate(finalCents, 'checkout total');
    if (!(await page.locator(SELECTORS.placeOrder).first().count())) throw new RefusedError('no_place_order', 'place-order button not found', evidence);
    submitted = true;
    const externalOrderNumber = await submitAndReadOrderNumber(page, { evidence, upload });
    return { externalOrderNumber, amountCents: finalCents, evidence, dryRun: false };
  } finally {
    // Nothing was submitted (dry run, refusal, error): leave no cart behind
    // for the next run to find. Best effort — the next run clears it anyway.
    if (page && !submitted) {
      try { await Promise.race([clearCart(page), new Promise((resolve) => setTimeout(resolve, 20000))]); }
      catch (e) { logger.warn(`[siteone-bot] post-run cart cleanup failed: ${String(e.message).slice(0, 120)}`); }
    }
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
  }
}

module.exports = {
  key: 'siteone',
  quotesAtPlace: true,
  packagedQuantity: true, // cart quantity = packages (pack size from the price row)
  preSubmitTotal: 'vendor', // the checkout total is read live, immediately before the click
  quote: () => null,
  place,
  RefusedError,
  _internals: { SELECTORS, isTrustedSiteOneUrl, allowedHosts, parseMoney, normalizeSku, EVIDENCE_PREFIX },
};
