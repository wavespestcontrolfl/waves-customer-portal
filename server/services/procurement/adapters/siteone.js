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
  // Confirmation-number element only — never a bare :has-text() that an
  // ancestor (the body) would satisfy ahead of the real node (Codex r3 P1).
  orderNumber: '[data-test="order-number"], .order-number, .confirmation-number, .order-confirmation-number, h1:has-text("Order #"), h2:has-text("Order #"), h3:has-text("Order #"), p:has-text("Order #"), strong:has-text("Order #")',
});

const NAV_TIMEOUT = 45000;
const CONFIRMATION_TIMEOUT = 20000; // bounded wait for the confirmation number after the click
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

// SiteOne renders responsive duplicates (a hidden desktop/mobile copy ahead of
// the visible node), so no check may judge `.first()`: every match is
// resolved, and the VISIBLE ones are what the checkout shows (Codex #3853 r11
// P1, r12 P1 + P2s). Returns { all, shown } as locators.
// `strict`: a visibility read that THROWS (element detached mid-rerender)
// propagates instead of reading as hidden — the checkout blockers (MFA,
// card) must fail closed on an unreadable check (Codex #3876 r2 P1).
async function matches(page, selector, { strict = false } = {}) {
  const els = page.locator(selector);
  const n = await els.count();
  const all = [];
  const shown = [];
  for (let i = 0; i < n; i += 1) {
    const el = els.nth(i);
    all.push(el);
    const isShown = strict ? await el.isVisible({ timeout: 1500 }) : await el.isVisible({ timeout: 1500 }).catch(() => false);
    if (isShown) shown.push(el);
  }
  return { all, shown };
}

// A checkout blocker's presence, read strictly: unreadable = refused, never
// "absent" (Codex #3876 r2 P1).
async function blockerShown(page, selector, what, refuse) {
  try { return (await matches(page, selector, { strict: true })).shown.length > 0; }
  catch (e) { await refuse(`${what}_unreadable`, `SiteOne checkout: the ${what.replace(/_/g, ' ')} check could not be read (${String(e.message).slice(0, 80)}) — owner action`); }
  return true; // unreachable: refuse throws
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
    // submits it. Enter is ONLY the no-control path: a click whose promise
    // rejects (a slow or failed navigation after the click dispatched) may
    // already have posted the credential, and a second submit is exactly the
    // resubmission the one-submit-per-run rule forbids — the click's outcome
    // is inspected like any other, and an unproven session after it is
    // 'unverified', never a retry (Codex #3853 r23 P1).
    const passField = (await matches(page, SELECTORS.loginPass)).shown[0];
    const formSubmits = (await matches(passField.locator('xpath=ancestor::form[1]'), SELECTORS.loginSubmit)).shown;
    let clickUnsettled = false;
    if (formSubmits.length === 1) await formSubmits[0].click().catch(() => { clickUnsettled = true; });
    else await passField.press('Enter');
    // Signed in = EVERY password field gone or hidden (a hidden responsive
    // duplicate must not read as "still on the login page" — pre-push P1).
    await page.waitForFunction((passSel) => Array.from(document.querySelectorAll(passSel)).every((pw) => !pw.offsetParent), SELECTORS.loginPass, { timeout: LOGIN_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1500);
    // The password form is gone — but signed in means a SHOWN account marker;
    // an intermediate page (MFA step, maintenance, an error page on the same
    // host) is 'unverified', never a session (Codex #3853 r22 P1).
    if ((await matches(page, SELECTORS.accountMarker)).shown.length && isTrustedSiteOneUrl(page.url())) return 'ok';
    // An unsettled click cannot tell "not submitted" from "submitted and
    // still loading": neither a rejection nor a transient error (both would
    // resubmit the credential) — it parks unverified (r23 P1).
    if (clickUnsettled) return 'unverified';
    if ((await matches(page, SELECTORS.loginPass)).shown.length || !isTrustedSiteOneUrl(page.url())) return 'rejected';
    return 'unverified';
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

// The bill-to selector unions radio inputs and their labels, so ordinary
// markup (a visible radio + its visible "Bill to account" label) matches the
// SAME control twice. Options are counted by the radio they resolve to, not by
// locator — one labeled radio is one option (Codex #3853 r13 P1). An option
// with no associated radio counts on its own (it will refuse as unverified).
async function distinctBillToOptions(page, shown) {
  const byRadio = new Map();
  for (let i = 0; i < shown.length; i += 1) {
    const radio = await associatedRadio(page, shown[i]);
    const key = radio ? await radio.evaluate((el) => `${el.id}|${el.name}|${el.value}`).catch(() => null) : null;
    const k = key || `option-${i}`;
    if (!byRadio.has(k)) byRadio.set(k, shown[i]);
  }
  return [...byRadio.values()];
}

// The radio input a bill-to option resolves to: the element itself when it
// is an input; for a label, its `for` target or the radio it wraps. Null
// when no radio is associated (never fall back to a document-wide search).
async function associatedRadio(page, option) {
  const tag = await option.evaluate((el) => el.tagName.toLowerCase()).catch(() => null);
  if (tag === 'input') return option;
  if (tag !== 'label') return null;
  const target = await option.getAttribute('for').catch(() => null);
  const radio = target ? page.locator(`#${target.replace(/[^\w-]/g, '')}`).first() : option.locator('input[type="radio"]').first();
  return (await radio.count().catch(() => 0)) ? radio : null;
}

// Checkout tender: no MFA / terms prompt (the bot never answers them),
// bill-to-account offered AND confirmed CHECKED — the click is not proof; a
// checkout defaulting to a saved card shows no card field (Codex r1 P1).
// The card field is judged AFTER the bill-to option is selected: a checkout
// that defaults to card entry shows the field until the tender is switched,
// and only a field still demanded afterwards refuses (Codex r6 P1).
// The blockers the bot never answers: an MFA challenge, and every terms
// checkbox the checkout SHOWS must be accepted — a hidden checked copy ahead
// of a visible unchecked one is not acceptance (r12 P1); with no visible copy
// at all the hidden ones are judged (never skipped); an unreadable state fails
// CLOSED (Codex r4 P2): unknown ≠ accepted. Scanned BEFORE and AFTER the
// tender change — selecting bill-to-account can reveal an account-specific
// terms box or verification step (Codex #3853 r14 P1).
async function scanCheckoutBlockers(page, refuse) {
  if (await blockerShown(page, SELECTORS.mfaField, 'mfa', refuse)) await refuse('mfa_required', 'SiteOne checkout asks for a verification code — bot never supplies it');
  // Strict: a terms box whose visibility cannot be read is refused, never
  // dropped from the scan as "hidden" (Codex #3876 r4 P1).
  let terms;
  try { terms = await matches(page, SELECTORS.termsCheckbox, { strict: true }); }
  catch (e) { await refuse('terms_unreadable', `SiteOne checkout shows a terms checkbox whose visibility could not be read (${String(e.message).slice(0, 80)}) — owner action`); }
  for (const box of terms.shown.length ? terms.shown : terms.all) {
    let accepted = null;
    try { accepted = await box.isChecked(); } catch { await refuse('terms_unreadable', 'SiteOne checkout shows a terms checkbox whose state could not be read — owner action'); }
    if (accepted !== true) await refuse('terms_required', 'SiteOne checkout requires accepting terms — owner action');
  }
}

async function verifyBillToAccount(page, { evidence, upload }) {
  const refuse = async (reason, message) => { await shot(page, 'checkout', evidence, upload); throw new RefusedError(reason, message, evidence); };
  await scanCheckoutBlockers(page, refuse);
  // The tender is the ONE visible bill-to option; a hidden responsive copy
  // ahead of it is neither refused on nor clicked (r12 P2).
  const billOptions = await matches(page, SELECTORS.billToAccount);
  if (!billOptions.all.length) await refuse('no_bill_to_account', 'bill-to-account option not offered at checkout');
  if (!billOptions.shown.length) await refuse('bill_to_account_hidden', 'the bill-to-account option at checkout is not visible — not the tender the checkout shows');
  const options = await distinctBillToOptions(page, billOptions.shown);
  if (options.length > 1) await refuse('bill_to_account_ambiguous', `${options.length} visible bill-to-account options at checkout — cannot tell which the order bills`);
  const bill = options[0];
  try { await bill.click({ timeout: 5000 }); }
  catch (e) { await refuse('bill_to_account_unselectable', `bill-to-account option could not be selected (${String(e.message).slice(0, 80)})`); }
  await page.waitForTimeout(1500);
  await scanCheckoutBlockers(page, refuse); // the tender change may have revealed a terms box / MFA step (r14 P1)
  if (await blockerShown(page, SELECTORS.cardField, 'card', refuse)) await refuse('card_required', 'SiteOne checkout still asks for card entry with bill-to-account selected — bot never supplies it');
  // Proof is on the radio ASSOCIATED with the option just clicked (the
  // click target may be its label — Codex PR3 r1 + r3 P1): that radio's own
  // checked state, read directly, must be true and it must be visible; and
  // it must be the ONLY checked account radio on the page — a checked
  // duplicate elsewhere cannot tell which tender the order bills (Codex r7 P1).
  const radio = await associatedRadio(page, bill);
  if (!radio) await refuse('bill_to_account_unverified', 'no radio input is associated with the bill-to-account option — the bot never submits on another tender');
  let checked = null;
  try { checked = await radio.isChecked(); } catch { checked = null; }
  if (checked !== true) await refuse('bill_to_account_unverified', 'bill-to-account is not confirmed selected at checkout — the bot never submits on another tender');
  if (!(await radio.isVisible().catch(() => false))) await refuse('bill_to_account_hidden', 'the selected bill-to-account radio is not visible — not the tender the checkout shows');
  const checkedCount = await page.locator(SELECTORS.billToAccountSelected).count().catch(() => null);
  if (checkedCount !== 1) await refuse('bill_to_account_ambiguous', `${checkedCount ?? 'an unreadable number of'} account tenders read as selected at checkout — cannot tell which the order bills`);
  evidence.billToAccountVerified = true;
  return radio;
}

// The tender and the blockers, re-checked immediately before the click: a
// delayed checkout rerender during the earlier awaits (screenshot upload,
// cap reservation) can reset the verified radio to a saved card or reveal
// an MFA / terms step after the last scan (Codex #3876 r3 P1). Page reads
// only — nothing is awaited off the page between here and the click.
async function recheckTenderAtClick(page, radio, { evidence, upload }) {
  const refuse = async (reason, message) => { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError(reason, message, evidence); };
  await scanCheckoutBlockers(page, refuse);
  if (await blockerShown(page, SELECTORS.cardField, 'card', refuse)) await refuse('card_required', 'SiteOne checkout asks for card entry at the moment of submission — bot never supplies it');
  let checked = null;
  try { checked = await radio.isChecked(); } catch { checked = null; }
  if (checked !== true) await refuse('bill_to_account_unverified', 'bill-to-account is no longer selected at the moment of submission — the bot never submits on another tender');
  // Visible too (Codex #3876 r4 P1): a rerender that hides the checked
  // account radio behind a saved-card tender must not submit on the card.
  if (!(await radio.isVisible().catch(() => false))) await refuse('bill_to_account_hidden', 'the selected bill-to-account radio is no longer visible at the moment of submission — not the tender the checkout shows');
  const checkedCount = await page.locator(SELECTORS.billToAccountSelected).count().catch(() => null);
  if (checkedCount !== 1) await refuse('bill_to_account_ambiguous', `${checkedCount ?? 'an unreadable number of'} account tenders read as selected at the moment of submission`);
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
// `screenshot: false` = a pure read for the at-click check: nothing is
// awaited between the read and the click (pre-push P0 on #3876).
async function readCheckoutTotal(page, { evidence, upload, screenshot = true }) {
  const refuse = async (reason, message) => { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError(reason, message, evidence); };
  const total = await readExactlyOne(page, SELECTORS.checkoutTotal);
  if (total.count !== 1) await refuse(total.count ? 'checkout_total_ambiguous' : 'no_checkout_total', total.count ? `${total.count} checkout-total elements — cannot tell which the order charges` : 'no checkout-total element at checkout');
  if (!total.visible) await refuse('checkout_total_hidden', 'the checkout-total element is not visible — not the figure the order charges');
  const finalCents = parseMoney(total.text);
  if (screenshot) await shot(page, 'pre-submit', evidence, upload);
  if (!finalCents) throw new RefusedError('no_checkout_total', `could not read the checkout total ("${total.text.trim().slice(0, 40)}")`, evidence);
  evidence.checkoutTotalCents = finalCents;
  return finalCents;
}

// The click and its confirmation number. Anything thrown after the click is
// `ambiguous`: the order may exist — the dispatcher parks, never re-submits.
// Returns the order number; calls markSubmitted() at the click boundary — the
// caller's cart cleanup guard flips only when the click actually happened
// (a pre-click refusal here still cleans the cart — Codex #3853 r15 P2).
// The text of the ONE shown confirmation-number node, or null.
async function shownOrderText(page) {
  const nodes = (await matches(page, SELECTORS.orderNumber).catch(() => ({ shown: [] }))).shown;
  if (nodes.length !== 1) return null;
  return (await nodes[0].textContent().catch(() => '') || '').replace(/\s+/g, ' ');
}

async function submitAndReadOrderNumber(page, { evidence, upload, markSubmitted, finalCents, gate, radio, identity }) {
  const placeOrder = await visibleControl(page, SELECTORS.placeOrder, 'place_order', evidence); // a refusal, before anything is sent
  // Confirmation must be evidence created AFTER the click: a node the
  // selector already matches before submission (a reference / PO element,
  // a stale SPA confirmation) is remembered and never accepted as the
  // outcome (Codex #3876 r3 P2).
  const beforeText = await shownOrderText(page);
  // The total the click submits is the one shown NOW: an async tax /
  // shipping recalculation after the earlier read (which also spans the
  // screenshot upload and the cap reservation) would otherwise bypass the
  // cap and record the old figure (Codex #3876 r2 P1). A changed total is
  // gated again before the click.
  // The read is pure (no screenshot upload) and a changed figure is gated
  // and then READ AGAIN — the cap reservation is itself an awaited DB write
  // during which the page may recalculate once more; the click happens only
  // when the figure on screen is the one the cap approved (pre-push P0).
  // Order at the boundary (Codex #3876 r4 P1): total read → (changed: gate,
  // start over) → tender + blockers re-checked → account + ship-to
  // re-checked → Place Order proven actionable → total read AGAIN — the
  // very last await before the click is that pure read, and it must equal
  // the figure the cap approved.
  // The identity re-check (Codex #3876 r5 P1): a delayed rerender that
  // swaps the displayed billing account or ship-to while the radio stays
  // checked and the total stable would otherwise submit on a stale proof.
  // The trial click (Codex #3876 r5 P2): Playwright's actionability checks
  // without dispatching — a disabled Place Order refuses BEFORE the
  // submitted guard flips, instead of parking ambiguous with nothing sent.
  let cents = finalCents;
  const unstable = (shownCents) => new RefusedError('checkout_total_unstable', `SiteOne checkout total kept changing before the click (${cents} → ${shownCents}) — not submitted`, evidence, shownCents);
  for (let i = 0; ; i += 1) {
    let shownCents = await readCheckoutTotal(page, { evidence, upload, screenshot: false });
    if (shownCents !== cents) {
      if (i >= 3) throw unstable(shownCents);
      evidence.totalChangedBeforeClick = { from: cents, to: shownCents };
      cents = shownCents;
      await gate(cents, 'total at the click');
      continue;
    }
    await recheckTenderAtClick(page, radio, { evidence, upload });
    await identity();
    try { await placeOrder.click({ trial: true, timeout: 5000 }); }
    catch (e) { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError('place_order_unactionable', `the Place Order control cannot be clicked (${String(e.message).slice(0, 80)}) — nothing submitted`, evidence); }
    shownCents = await readCheckoutTotal(page, { evidence, upload, screenshot: false });
    if (shownCents === cents) break;
    if (i >= 3) throw unstable(shownCents);
  }
  markSubmitted();
  let number = null;
  try {
    await placeOrder.click();
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    // An SPA checkout renders the confirmation after domcontentloaded: wait
    // (bounded) for a SHOWN confirmation-number node rather than sampling
    // once after a fixed delay (Codex #3876 r2 P2). A timeout falls through
    // to the ambiguous path below.
    number = await waitForNewOrderNumber(page, beforeText, CONFIRMATION_TIMEOUT);
  } catch (e) {
    const err = new Error(`siteone submit outcome unknown: ${String(e.message).slice(0, 120)}`);
    err.ambiguous = true; err.evidence = evidence; err.cents = cents;
    throw err;
  }
  await shot(page, 'confirmation', evidence, upload);
  // The ONE visible confirmation-number node — a hidden or stale responsive
  // copy must not record the wrong number or force the ambiguous path (r15 P2).
  if (!number) {
    const err = new Error('siteone: order submitted but no confirmation number was found');
    err.ambiguous = true; err.evidence = evidence; err.cents = cents;
    throw err;
  }
  return { number, cents };
}

// Wait (bounded) for a shown confirmation-number node whose text differs
// from what was shown BEFORE the click AND whose parsed identifier is not
// the pre-click one: a reference node whose status text alone changes
// ("PO reference 55501 · Ready" → "… · Validation failed") is not a new
// confirmation (Codex #3876 r5 P2); a timeout leaves the ambiguous path to
// decide.
// Returns the confirmation number, or null at the timeout. The node's first
// render ("Processing order…", an empty element) is not the outcome: polling
// continues until the changed text yields a number (Codex #3876 r4 P2).
async function waitForNewOrderNumber(page, beforeText, timeout) {
  const deadline = Date.now() + timeout;
  const beforeNumber = beforeText != null ? orderNumberIn(beforeText) : null;
  for (;;) {
    const text = await shownOrderText(page);
    const number = text != null && text !== beforeText ? orderNumberIn(text) : null;
    if (number && number !== beforeNumber) return number;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

// The confirmation number: the token adjacent to the "Order #/number" label
// when it is an identifier, else the first identifier-shaped token. An
// identifier carries at least one DIGIT — a label word ("Confirmation",
// "order") never becomes the recorded order number (Codex PR3 r1 P2).
function orderNumberIn(text) {
  // An identifier carries a digit and is never date-shaped: digits joined
  // only by separators (2026-09-05, 09-05-2026, 05/09/26) are not ids —
  // an unlabeled all-digit run (12345678) still is (Codex #3876 r3 P2).
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  const dateShaped = (t) => /^\d+([-/.]\d+)+$/.test(t) // 2026-09-05, 09-05-2026, 05/09/26
    || /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(t) // 20260905 (compact)
    || /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:19|20)\d{2}$/.test(t) // 09052026 (compact, month first — r5 P2)
    || /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}$/.test(t) // 05092026 (compact, day first)
    || new RegExp(`^${MON}[-/.]?\\d{1,2}[-/.]\\d{2,4}$`, 'i').test(t) // Sep-05-2026
    || new RegExp(`^\\d{1,2}[-/.]?${MON}[-/.]?\\d{2,4}$`, 'i').test(t); // 05-Sep-2026
  const isId = (t) => !!t && /\d/.test(t) && !dateShaped(t);
  // EVERY labeled match is tried before any fallback: "Order date 2026-09-05
  // … Order # SO-778899" must yield the number, not the date (Codex #3876
  // r2 P2).
  for (const m of String(text).matchAll(/order(?!\s*date)\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9-]{5,})/gi)) if (isId(m[1])) return m[1];
  return (String(text).match(/[A-Z0-9/.-]{5,}/gi) || []).find(isId) || null;
}

// The checkout stage: bill-to proof, identity + final total, the cap gate on
// that total, the one click, the confirmation number. Every check refuses
// BEFORE the click; only the click flips the caller's cart-cleanup guard.
async function checkoutAndSubmit(page, { credentials, shipToTokens, gate, evidence, upload, markSubmitted, dryRun = false }) {
  await (await visibleControl(page, SELECTORS.checkoutButton, 'checkout_button', evidence)).click();
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);
  if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone bot: checkout left the trusted host');
  const radio = await verifyBillToAccount(page, { evidence, upload });
  await verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload });
  const finalCents = await readCheckoutTotal(page, { evidence, upload });
  await gate(finalCents, 'checkout total');
  // A dry run has now exercised every checkout selector and the final cap
  // check; it stops HERE, before the one click, and bells the checkout
  // total — selector drift is caught before any live purchase (Codex #3876
  // r2 P1). The caller's finally empties the cart.
  if (dryRun) { await shot(page, 'dry-run-stop', evidence, upload); return { dryRun: true, amountCents: finalCents, externalOrderNumber: null, evidence }; }
  let placed;
  const identity = () => verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload });
  try { placed = await submitAndReadOrderNumber(page, { evidence, upload, markSubmitted, finalCents, gate, radio, identity }); }
  catch (e) {
    // The click happened at THIS total: an ambiguous outcome parks with it
    // (a null amount on a placed_at row would count $0 against the
    // monthly cap — pre-push P0).
    if (e.ambiguous && e.cents == null) e.cents = finalCents;
    throw e;
  }
  return { externalOrderNumber: placed.number, amountCents: placed.cents, evidence, dryRun: false };
}

async function place(
  { vendorSku, quantity, credentials, beforeSubmit, dryRun = String(process.env.SITEONE_BOT_DRY_RUN || '').toLowerCase() === 'true', approvedShipTo = process.env.SITEONE_APPROVED_SHIP_TO },
  { launchBrowser = chromium ? defaultLaunch : null, resolveHostIps = filler.resolvePublicIps, upload = uploadEvidence } = {},
) {
  if (!launchBrowser) throw runLevel('siteone bot: playwright unavailable');
  const { qty, shipToTokens } = validatePlaceArgs({ vendorSku, quantity, credentials, approvedShipTo });
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
    // The dry run continues into the checkout verifications (r2 P1) and
    // stops inside checkoutAndSubmit, before the click.
    // `await` is load-bearing: the finally below reads `submitted`, so the
    // stage must have run before it (a bare `return promise` runs finally first).
    return await checkoutAndSubmit(page, { credentials, shipToTokens, gate, evidence, upload, dryRun, markSubmitted: () => { submitted = true; } });
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
  loginRequired: true, // place() needs the vendor row's stored login (the dispatcher's claim looks it up and passes `credentials`)
  loginConfigured,
  quotesAtPlace: true,
  packagedQuantity: true, // cart quantity = packages (pack size from the price row)
  preSubmitTotal: 'vendor', // the checkout total is read live, immediately before the click
  quote: () => null,
  place,
  RefusedError,
  _internals: { SELECTORS, isTrustedSiteOneUrl, allowedHosts, parseMoney, normalizeSku, requestPermitted, orderNumberIn, fillLoginForm, EVIDENCE_PREFIX },
};
