/**
 * procurement/adapters/siteone.js — SiteOne (siteone.com) browser-bot adapter.
 *
 * SiteOne has no ordering API, so this is an in-process Playwright bot that
 * signs in with the vendor row's encrypted login, EMPTIES the cart, searches
 * the product's SKU, sets the quantity (PACKAGES — the dispatcher converts
 * the inventory-unit request through the price row's pack size), verifies
 * the cart holds exactly that one line at that count, reads the CART TOTAL
 * (cap pre-check, dry-run stop). PR 3a ENDS HERE: the checkout-verification
 * and submit stages (bill-to-account proof, displayed account + ship-to,
 * the FINAL total cap check, the place-order click, the confirmation
 * number) ship in PR 3b — until then a non-dry-run call refuses
 * `checkout_not_shipped` and nothing is ever submitted. Whatever the bot
 * left in the cart (dry run, refusal) it clears again before closing.
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
 *   err.runLevel = true (no browser or browser setup, login failed, host
 *     not public) = the run is broken, not this request: the dispatcher
 *     releases the claim.
 *   err.ambiguous = true = the submit click happened and the outcome is
 *     unknown: needs_review, never retried.
 */
/* global document, location, Event */ // page.evaluate bodies run in the browser
const logger = require('../../logger');
const { _internals: filler } = require('../../seo/browser-form-filler');
const { uploadEvidence } = require('../../seo/signup-evidence');

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const SELECTORS = Object.freeze({
  loginUser: 'input[name="username"], input[name="email"], input[type="email"], input#username, input#j_username',
  loginPass: 'input[name="password"], input[type="password"]',
  // Relative to the resolved login form (login() scopes it to the visible
  // password field's form) — a form-prefixed selector applied inside that
  // form would look for a NESTED form and never find the button (r18 P1).
  loginSubmit: 'button[type="submit"], input[type="submit"]',
  // A signed-in account page: the sign-out link or the account menu. Login
  // success needs one of these SHOWN — a same-host MFA / maintenance / error
  // page with no password field is not a login (Codex #3853 r22 P1).
  accountMarker: 'a[href*="logout"], a[href*="sign-out"], a[href*="signout"], [data-account-menu], .account-menu, .my-account, a[href*="/my-account"]',
  loginError: '.alert-danger, .error-message, [role="alert"]',
  searchInput: 'input[name="text"], input[type="search"], input#js-site-search-input, input[placeholder*="Search"]',
  productLink: '.product-item a.name, .product-item-name a, a.product-name, .product-tile a',
  productSku: '[data-product-code], .product-code, .sku, [itemprop="sku"]',
  qtyInput: 'input[name="qty"], input.qty, input[name="quantity"], input[type="number"]',
  addToCart: 'button.add-to-cart, button#addToCartButton, button[data-action="add-to-cart"], button:has-text("Add to Cart")',
  // Scoped to the product's own availability / stock element — a bare
  // :has-text() would match an ancestor (the body) via any footer or
  // recommendation panel and park a valid order (Codex PR3 r1 P2).
  unavailable: '.out-of-stock, .unavailable, [class*="availab" i]:has-text("Out of Stock"), [class*="availab" i]:has-text("Not available"), [class*="stock" i]:has-text("Out of Stock"), [class*="stock" i]:has-text("Not available")',
  cartUrl: 'https://www.siteone.com/en/cart',
  cartLine: '.cart-item, .entry-item, .cart-entry, [data-test="cart-line"], tr.item',
  cartLineSku: '[data-product-code], .product-code, .sku, .item-code, [itemprop="sku"]',
  cartLineQty: 'input[name*="qty" i], input[name*="quantity" i], input.qty, input[type="number"], .qty-value, .quantity-value',
  cartRemove: 'button.remove, a.remove, button[data-action="remove"], .remove-item, button:has-text("Remove"), a:has-text("Remove")',
  cartTotal: '.cart-totals .total, .order-total .value, [data-test="cart-total"], .grand-total .price, .cart-total-value',
});

const NAV_TIMEOUT = 45000;
const LOGIN_TIMEOUT = 45000;
const DEFAULT_LOGIN_URL = 'https://www.siteone.com/en/login';
const EVIDENCE_PREFIX = 'procurement-evidence/';

class RefusedError extends Error {
  // cents: the vendor total the refusal was decided on (a cap refusal) —
  // the dispatcher parks the ledger row with THIS amount, not an earlier
  // cart or history quote (Codex r4 P2).
  constructor(reason, message, evidence, cents = null) { super(message || reason); this.refuse = reason; if (evidence) this.evidence = evidence; if (cents != null) this.cents = cents; }
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

// SiteOne renders responsive duplicates (a hidden desktop/mobile copy ahead of
// the visible node), so no check may judge `.first()`: every match is
// resolved, and the VISIBLE ones are what the checkout shows (Codex #3853 r11
// P1, r12 P1 + P2s). Returns { all, shown } as locators.
async function matches(page, selector) {
  const els = page.locator(selector);
  const n = await els.count();
  const all = [];
  const shown = [];
  for (let i = 0; i < n; i += 1) {
    const el = els.nth(i);
    all.push(el);
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) shown.push(el);
  }
  return { all, shown };
}

// Wait (bounded) until at least one match is SHOWN — the login form's
// password field behind a hidden responsive duplicate (pre-push P1).
async function waitForAnyShown(page, selector, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await matches(page, selector)).shown.length) return;
    if (Date.now() >= deadline) throw new Error(`no visible match for ${selector.slice(0, 40)} within ${timeout} ms`);
    await page.waitForTimeout(500);
  }
}

// The ONE visible control for a fill / click: a hidden responsive copy ahead
// of the visible control would time out and park the one-shot claim as
// failed (Codex #3853 r14 P2, r16 P1 + P2). Refuses BEFORE acting.
async function visibleControl(page, selector, what, evidence) {
  const { shown } = await matches(page, selector);
  if (shown.length !== 1) throw new RefusedError(shown.length ? `${what}_ambiguous` : `no_${what}`, `${shown.length} visible ${what.replace(/_/g, ' ')} controls — expected exactly one`, evidence);
  return shown[0];
}

// Any visible match (the MFA / card / unavailable blockers fail closed).
async function visible(page, selector) {
  try { return (await matches(page, selector)).shown.length > 0; } catch { return false; }
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
// Only SHOWN lines count: SiteOne renders each item again in a hidden
// desktop / mobile container, and the one-line proof must not refuse a
// valid single-item cart on its responsive copy (Codex #3853 r16 P2).
async function cartLines(page) {
  const { shown } = await matches(page, SELECTORS.cartLine);
  const out = [];
  for (const line of shown) {
    // Inside the row too, only the SHOWN SKU / quantity node is read: a
    // hidden responsive child or a stale copy must not feed the exact-cart
    // proof (Codex #3853 r20 P2). None shown = unreadable = fails closed.
    const skuEl = (await matches(line, SELECTORS.cartLineSku)).shown[0];
    // Attribute-first, like the product page: a row that exposes its code
    // only through data-product-code shows unrelated text (Codex #3853 r21 P2).
    const skuAttr = skuEl ? await skuEl.getAttribute('data-product-code').catch(() => null) : null;
    const sku = (skuAttr || (skuEl ? (await skuEl.textContent().catch(() => '') || '') : '')).replace(/\s+/g, ' ').trim();
    const qtyEl = (await matches(line, SELECTORS.cartLineQty)).shown[0];
    let qtyText = qtyEl ? await qtyEl.inputValue().catch(() => null) : null;
    if (qtyText == null && qtyEl) qtyText = await qtyEl.textContent().catch(() => null);
    const qty = Number(String(qtyText ?? '').replace(/[^\d.]/g, ''));
    out.push({ sku, qty: qtyText == null || qtyText === '' ? NaN : qty });
  }
  return out;
}

// Remove every SHOWN line (bounded) and return how many are left. 0 = empty.
// Hidden responsive copies are neither counted nor clicked: a hidden Remove
// ahead of the visible one would swallow every click and refuse a valid
// request as cart_not_empty (Codex #3853 r17 P2).
async function clearCart(page) {
  await gotoCart(page);
  for (let i = 0; i < 25; i += 1) {
    if (!(await matches(page, SELECTORS.cartLine)).shown.length) return 0;
    const remove = (await matches(page, SELECTORS.cartRemove)).shown[0];
    if (!remove) break;
    await remove.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  return (await matches(page, SELECTORS.cartLine)).shown.length;
}

// Runs INSIDE the page (page.evaluate serializes it — no closures, browser
// globals only). The login form is the ONE visible password field's form, and
// the username field is resolved inside THAT form: a document-wide first
// match would take an unrelated `input[name="email"]` (a newsletter field
// ahead of the form) and park a valid login as login_rejected (Codex #3853
// r15 P1). Returns a verdict string; the caller maps it.
function fillLoginForm({ user, pw, userSel, passSel }) {
  const h = location.hostname.toLowerCase();
  if (location.protocol !== 'https:' || !(h === 'siteone.com' || h.endsWith('.siteone.com'))) return 'offhost';
  const visiblePw = Array.from(document.querySelectorAll(passSel)).filter((el) => !!el.offsetParent);
  if (visiblePw.length > 1) return 'ambiguousform';
  const p = visiblePw[0];
  if (!p) return 'nofields';
  // Where the credentials would POST: the password field's owning form,
  // its action resolved against the page — HTTPS on siteone.com or a
  // subdomain, or nothing is typed. SITEONE_BOT_ALLOWED_HOSTS widens the
  // egress lock for assets, never for a credential post (pre-push P0).
  const form = p.form;
  if (!form) return 'badform';
  let action;
  try { action = new URL(form.getAttribute('action') || '', location.href); } catch { return 'badform'; }
  const ah = action.hostname.toLowerCase();
  if (action.protocol !== 'https:' || !(ah === 'siteone.com' || ah.endsWith('.siteone.com'))) return 'badform';
  // The ONE visible username field inside THAT form: a hidden honeypot or
  // responsive copy ahead of it would take the fill and park a valid login
  // as login_rejected (Codex #3853 r19 P1); two visible = ambiguous.
  const visibleUser = Array.from(form.querySelectorAll(userSel)).filter((el) => !!el.offsetParent);
  if (visibleUser.length > 1) return 'ambiguousform';
  const u = visibleUser[0];
  if (!u) return 'nofields';
  for (const [el, v] of [[u, user], [p, pw]]) {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return 'ok';
}

async function login(page, creds) {
  const loginUrl = creds.loginUrl && isTrustedSiteOneUrl(creds.loginUrl) ? creds.loginUrl : DEFAULT_LOGIN_URL;
  const attempt = async () => {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
    if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone login aborted: navigation redirected off the trusted host');
    await waitForAnyShown(page, SELECTORS.loginPass, 30000);
    // Host check + both writes in ONE page-context execution (veseris.js).
    const filled = await page.evaluate(fillLoginForm, { user: creds.email || creds.username, pw: creds.password, userSel: SELECTORS.loginUser, passSel: SELECTORS.loginPass });
    const FILL_ABORT = { offhost: 'redirected off the trusted host', nofields: 'login fields not found', ambiguousform: 'more than one visible login form — nothing typed', badform: 'the login form would post credentials off the trusted host — nothing typed' };
    if (filled !== 'ok') throw runLevel(`siteone login aborted: ${FILL_ABORT[filled] || filled}`);
    // Submit the form the fill wrote into: the ONE visible password field's
    // own form, never a document-wide first match (a hidden responsive login
    // form ahead of the visible one would take the click and the valid login
    // would park login_rejected — Codex #3853 r16 P1). Without exactly one
    // visible submit control in that form, Enter on the password field
    // submits it.
    const passField = (await matches(page, SELECTORS.loginPass)).shown[0];
    const formSubmits = (await matches(passField.locator('xpath=ancestor::form[1]'), SELECTORS.loginSubmit)).shown;
    if (formSubmits.length === 1) await formSubmits[0].click().catch(() => passField.press('Enter'));
    else await passField.press('Enter');
    // Signed in = EVERY password field gone or hidden (a hidden responsive
    // duplicate must not read as "still on the login page" — pre-push P1).
    await page.waitForFunction((passSel) => Array.from(document.querySelectorAll(passSel)).every((pw) => !pw.offsetParent), SELECTORS.loginPass, { timeout: LOGIN_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1500);
    if ((await matches(page, SELECTORS.loginPass)).shown.length || !isTrustedSiteOneUrl(page.url())) return 'rejected';
    // The password form is gone — but signed in means a SHOWN account marker;
    // an intermediate page (MFA step, maintenance, an error page on the same
    // host) is 'unverified', never a session (Codex #3853 r22 P1).
    return (await matches(page, SELECTORS.accountMarker)).shown.length ? 'ok' : 'unverified';
  };
  let outcome = null; // 'ok' | 'rejected' | 'unverified' — the last attempt that RETURNED
  let lastError = null;
  for (let i = 0; i < 3 && outcome !== 'ok'; i += 1) {
    if (i) await page.waitForTimeout(3000);
    // A transient navigation / wait failure is one failed attempt of three;
    // an off-host redirect or missing fields is run-level at once (Codex r4
    // P2).
    // An attempt that RETURNS (SiteOne answered, login form still up)
    // clears an earlier attempt's transient error: the exhaustion verdict
    // below must read the LAST outcome — a rejected login parks, only three
    // network failures are run-level (Codex r4 P1). And a rejection is
    // DEFINITIVE: the same credential is never submitted again in this run —
    // retries are for transient exceptions only, so one bad password cannot
    // trip the vendor's failed-login lockout (Codex #3853 r20 P1).
    try { outcome = await attempt(); lastError = null; if (outcome !== 'ok') break; }
    catch (e) { if (e.runLevel) throw e; lastError = e; logger.warn(`[siteone-bot] login attempt ${i + 1} failed: ${String(e.message).slice(0, 120)}`); }
  }
  if (outcome === 'ok') return;
  if (outcome === 'unverified') {
    // Not a credential rejection, not a network failure: SiteOne answered
    // with a page that is neither the login form nor a signed-in account
    // page. Parks with a bell; the adapter is done for this run so the
    // remaining requests do not repeat the flow (Codex #3853 r22 P1).
    const unverified = new RefusedError('login_unverified', 'SiteOne answered the sign-in with a page that is neither the login form nor a signed-in account page (a verification step, maintenance, or an error page) — check by hand');
    unverified.adapterDown = true;
    throw unverified;
  }
  // Exhaustion: three NETWORK failures are the environment's problem —
  // run-level, retry tomorrow. SiteOne answering and keeping us on the login
  // page (wrong password, locked account) is THIS vendor's configuration —
  // it parks with a bell so the rest of the batch (other vendors) still runs
  // and the same request cannot abort every daily run (Codex PR3 r1 P1).
  const err = (await page.locator(SELECTORS.loginError).first().textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (lastError && !err) throw runLevel(`siteone login failed: ${String(lastError.message).slice(0, 120)}`);
  // Batch-wide: the same rejected credential must not be submitted once per
  // request in the run (vendor lockout) — this request parks with its bell
  // and the dispatcher claims no more SiteOne requests this run (Codex
  // #3853 r21 P1). The next run retries (the password may be fixed by then).
  const rejected = new RefusedError('login_rejected', `SiteOne rejected the stored login${err ? `: ${err}` : ''} — check the vendor row's credentials`);
  rejected.adapterDown = true;
  throw rejected;
}

// ---- place() stages ---------------------------------------------------------
// Each stage is a real step of the purchase with its own refusals; place()
// only sequences them. Refusals (RefusedError) park; run-level errors abort
// the batch; anything thrown after the click is `ambiguous`.

// What "configured" means for a login-driven vendor: a stored login AND the
// bill-to account number. The dispatcher checks this BEFORE claiming (and
// canAutoOrder before the sweep stands down its bell), so an unconfigured
// SiteOne row hands the request to the office instead of burning its one-shot
// claim as a non-reclaimable park (Codex #3853 r12 P2).
const hasLogin = (c) => !!(c && c.password && (c.email || c.username));
function loginConfigured(credentials) { return hasLogin(credentials) && !!credentials.accountNumber; }

// Arguments the bot can act on at all — all refusals, before any browser work.
function validatePlaceArgs({ vendorSku, quantity, credentials, approvedShipTo }) {
  if (!hasLogin(credentials)) throw new RefusedError('no_credentials', 'SiteOne login is not stored on the vendor row');
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
  try {
    return await lockContext(browser, evidence, pinned);
  } catch (e) {
    // The launch succeeded but the context / page / route setup did not:
    // close Chromium here, since place() never received the handle (Codex r5
    // P2), and classify it run-level like a launch failure — nothing reached
    // the vendor, so the claim is released for the next run instead of the
    // request parking as failed / "order manually" (Codex r6 P2).
    try { await browser.close(); } catch { /* noop */ }
    throw e.runLevel ? e : runLevel(`siteone bot: browser setup failed: ${String(e.message).slice(0, 120)}`);
  }
}

// https on a pinned host, nothing else: a form post or redirect to
// http://www.siteone.com would carry the credentials in the clear before the
// page-URL check could notice (Codex PR3 r1 P1). Any evaluation error = deny.
function requestPermitted(url, pinned) {
  try { return /^https:\/\//i.test(String(url)) && filler.requestAllowed({ url, allowedHosts: pinned }) === true; } catch { return false; }
}

async function lockContext(browser, evidence, pinned) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // Fail CLOSED (Codex r7 P1): a context that cannot intercept HTTP or
  // WebSocket traffic cannot be locked, so the bot must not sign in on it —
  // a missing API or a failing registration propagates to openLockedBrowser,
  // which closes Chromium and classifies it run-level (claim released).
  if (typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function') {
    throw runLevel('siteone bot: this Playwright cannot intercept HTTP/WebSocket traffic — egress lock unavailable');
  }
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (requestPermitted(url, pinned)) return route.continue();
    const host = filler.hostOf(url) || 'unknown';
    evidence.blockedHosts[host] = (evidence.blockedHosts[host] || 0) + 1;
    return route.abort();
  });
  await context.routeWebSocket('**/*', (ws) => { try { ws.close(); } catch { /* noop */ } });
  const page = await context.newPage();
  return { browser, page };
}

// Search the SKU, open the hit, confirm its code EXACTLY, set the quantity,
// add. Fail CLOSED: an unreadable SKU (selector drift) must never let the
// first search hit into the cart.
async function addProductToCart(page, { vendorSku, qty, evidence, upload }) {
  const search = await visibleControl(page, SELECTORS.searchInput, 'search_input', evidence);
  await search.fill(String(vendorSku));
  await search.press('Enter');
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);
  // The first SHOWN result (the product page's exact-SKU check decides
  // whether it is the right one); a hidden copy ahead of it would time out
  // into a failed order (Codex #3853 r17 P2).
  const hit = (await matches(page, SELECTORS.productLink)).shown[0];
  if (!hit) { await shot(page, 'search', evidence, upload); throw new RefusedError('sku_not_found', `SiteOne search for ${vendorSku} returned no product`, evidence); }
  await hit.click();
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(1500);
  const skuNode = (await matches(page, SELECTORS.productSku)).shown[0]; // the SKU the page SHOWS, never a hidden copy's
  // A node matched by its data-product-code attribute carries the code in
  // the attribute, not necessarily in its text (Codex #3853 r20 P2).
  const skuAttr = skuNode ? await skuNode.getAttribute('data-product-code').catch(() => null) : null;
  const pageSkuRaw = (skuAttr || (skuNode ? (await skuNode.textContent().catch(() => '') || '') : '')).replace(/\s+/g, ' ').trim();
  if (!pageSkuRaw) { await shot(page, 'product', evidence, upload); throw new RefusedError('sku_unreadable', `could not read the product SKU on the page for ${vendorSku} (SELECTORS.productSku)`, evidence); }
  if (normalizeSku(pageSkuRaw) !== normalizeSku(vendorSku)) { await shot(page, 'product', evidence, upload); throw new RefusedError('sku_mismatch', `product page shows "${pageSkuRaw.slice(0, 60)}", expected ${vendorSku}`, evidence); }
  if (await visible(page, SELECTORS.unavailable)) { await shot(page, 'product', evidence, upload); throw new RefusedError('unavailable', `SiteOne lists ${vendorSku} as unavailable`, evidence); }
  await (await visibleControl(page, SELECTORS.qtyInput, 'qty_input', evidence)).fill(String(qty));
  await (await visibleControl(page, SELECTORS.addToCart, 'add_to_cart', evidence)).click();
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
  // The ONE visible total (a hidden responsive copy can carry a stale figure
  // that would park a valid order at the cap gate or misreport a dry run — r12 P2).
  const totals = (await matches(page, SELECTORS.cartTotal)).shown;
  const totalText = totals.length === 1 ? await totals[0].textContent().catch(() => '') : '';
  const amountCents = parseMoney(totalText);
  await shot(page, 'cart', evidence, upload);
  if (totals.length !== 1) throw new RefusedError('no_cart_total', `${totals.length} visible cart totals — expected exactly one (SELECTORS.cartTotal)`, evidence);
  if (!amountCents) throw new RefusedError('no_cart_total', `could not read the cart total ("${String(totalText || '').trim().slice(0, 40)}")`, evidence);
  evidence.cartTotalCents = amountCents;
  return amountCents;
}

async function place(
  { vendorSku, quantity, credentials, beforeSubmit, dryRun = String(process.env.SITEONE_BOT_DRY_RUN || '').toLowerCase() === 'true', approvedShipTo = process.env.SITEONE_APPROVED_SHIP_TO },
  { launchBrowser = chromium ? defaultLaunch : null, resolveHostIps = filler.resolvePublicIps, upload = uploadEvidence } = {},
) {
  if (!launchBrowser) throw runLevel('siteone bot: playwright unavailable');
  const { qty } = validatePlaceArgs({ vendorSku, quantity, credentials, approvedShipTo });
  const evidence = { blockedHosts: {}, dryRun };
  // A cap verdict of { ok: false } is an ordinary refusal (parks). The cap
  // check THROWING (the reservation transaction hit a transient DB error) is
  // the environment's problem, not this request's: run-level, so the claim
  // is released and retried, never parked failed / "order manually" for a
  // click that never happened (Codex PR3 r3 P2).
  const gate = async (cents, what) => {
    let verdict;
    try { verdict = await beforeSubmit(cents); }
    catch (e) { throw runLevel(`siteone bot: cap check failed before the ${what}: ${String(e.message).slice(0, 120)}`); }
    if (!verdict || verdict.ok !== true) throw new RefusedError(verdict?.reason || 'over_cap', verdict?.message || `cap check refused the ${what}`, evidence, cents);
  };
  let browser = null;
  let page = null;
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
    // PR 3a ends at the cart: the checkout-verification + submit stages
    // (bill-to-account proof, identity + final-total readings, the
    // Place Order click, the confirmation number) ship in PR 3b. Until then a
    // real placement is refused — parked with a bell, nothing submitted.
    throw new RefusedError('checkout_not_shipped', 'SiteOne checkout + submit are not shipped yet (PR 3b) — run with SITEONE_BOT_DRY_RUN=true or order by hand', evidence, amountCents);
  } finally {
    // Nothing was submitted (dry run, refusal, error): leave no cart behind
    // for the next run to find. Best effort — the next run clears it anyway.
    if (page) {
      try { await Promise.race([clearCart(page), new Promise((resolve) => setTimeout(resolve, 20000))]); }
      catch (e) { logger.warn(`[siteone-bot] post-run cart cleanup failed: ${String(e.message).slice(0, 120)}`); }
    }
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
  }
}

module.exports = {
  key: 'siteone',
  loginRequired: true, // place() needs the vendor row's stored login (the dispatcher's claim looks it up and passes `credentials`)
  loginConfigured,
  quotesAtPlace: true,
  packagedQuantity: true, // cart quantity = packages (pack size from the price row)
  preSubmitTotal: 'vendor', // the vendor's own total is read live (the cart total here; the checkout total from PR 3b)
  quote: () => null,
  place,
  RefusedError,
  _internals: { SELECTORS, isTrustedSiteOneUrl, allowedHosts, parseMoney, normalizeSku, requestPermitted, fillLoginForm, EVIDENCE_PREFIX },
};
