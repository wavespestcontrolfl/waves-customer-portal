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

// Every label + qualifier the confirmation parser (`orderNumbersIn`) reads a
// number after; `:has-text()` is case-insensitive, and "ref" covers
// "reference". Mirrored by the selector test.
const CONFIRMATION_LABELS = Object.freeze(['Order #', 'Order number', 'Order no', 'Order ID', 'Order ref', 'Order confirmation', 'Order:', 'Order is', 'Confirmation #', 'Confirmation number', 'Confirmation no', 'Confirmation ID', 'Confirmation ref', 'Confirmation:', 'Confirmation is']);

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
  // The live storefront (checked anonymously 2026-09-05) shows the item
  // number in `div.brand-itemnumber` (text = the bare number; hidden `.hide`
  // responsive copies beside it) and in `[data-itemnumber]` attributes —
  // none of the generic Hybris SKU selectors match it.
  productSku: '[data-product-code], [data-itemnumber], .brand-itemnumber, .product-code, .sku, [itemprop="sku"]',
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
  // Every checkout reading is scoped beneath a checkout / order-summary
  // container: an unscoped fallback could match a header mini-cart total or
  // an account widget elsewhere on the page and pass as the checkout's own
  // reading after selector drift (Codex #3876 r21 P2) — drift fails closed.
  checkoutTotal: '.checkout-totals .total, .order-summary .grand-total, .checkout [data-test="order-total"], .order-summary [data-test="order-total"], .checkout .order-total .value, .order-summary .order-total .value, .checkout .grand-total .price, .order-summary .grand-total .price',
  // The checkout's order-summary lines: proven exactly [SKU × packages] again
  // at the click (Codex #3876 r7 P1); their SKU / quantity nodes reuse the
  // cart-line child selectors.
  checkoutLine: '.checkout .cart-item, .checkout .entry-item, .checkout .cart-entry, .order-summary .cart-item, .order-summary .entry-item, .order-summary .item, .checkout-order-summary .item, [data-test="checkout-line"]',
  billToAccount: 'input[type="radio"][value*="account" i], label:has-text("Bill to account")', // case-insensitive: value="billToAccount" is the account tender too (Codex #3876 r24 P2)
  // Only the fallback for an UNNAMED radio: a named one is counted in its own
  // group (Codex #3876 r16 P2 — an opaque value="12345" is a valid tender).
  // Identity readings are SCOPED to the checkout's own billing / shipping
  // sections — never a header account menu, a footer address, or an
  // ancestor's text — and place() requires exactly ONE match (pre-push P0).
  checkoutAccount: '.checkout [data-test="account-number"], .checkout-billing .account-number, .checkout .billing-account .account-number, .checkout .payment-method.selected .account-number, .checkout [data-test="bill-to-account"] .account-number',
  checkoutShipTo: '.checkout [data-test="ship-to"], .checkout-shipping .shipping-address, .checkout .ship-to address, .checkout .delivery-address address, .checkout [data-test="shipping-address"]',
  // The confirmation node: dedicated number elements, plus every textual
  // label `orderNumbersIn` accepts (order / confirmation + #, number, no,
  // ID, ref[erence], confirmation) in ordinary headings / paragraphs — one
  // list drives both, so the selector never lags the parser (Codex #3900
  // P2, r5 P2, r6 P2).
  orderNumber: ['[data-test="order-number"]', '.order-number', '.confirmation-number', '.order-confirmation-number', ...CONFIRMATION_LABELS.map((label) => `:is(h1, h2, h3, p, strong):has-text("${label}")`)].join(', '),
  placeOrder: 'button#placeOrder, button.place-order, button:has-text("Place Order")',
  // Confirmation-number element only — never a bare :has-text() that an
  // ancestor (the body) would satisfy ahead of the real node (Codex r3 P1).
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

// EVERY digit run in a checkout label: "Account # 12345" → ['12345'];
// "Account # 12345 Branch 01" → ['12345', '01'] — a short subaccount
// component is part of the account, never ignored (Codex #3876 r21 P2).
const digitRuns = (s) => String(s || '').match(/\d+/g) || [];
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
// The first SHOWN child of a row HANDLE (not a re-resolving locator): SKU
// and quantity must come from the same DOM row — a summary SiteOne rerenders
// mid-check would otherwise pair the old row's SKU with its replacement's
// quantity and approve a line that never existed (Codex #3876 r11 P1). A
// replaced row leaves a detached handle: no children, not visible → the
// line reads unreadable and the proof fails closed.
// The ONE shown child, or several that READ the same (a quantity input
// beside a quantity label carrying the same figure). Shown children that
// read differently — the input still showing the requested quantity beside
// the label showing SiteOne's adjustment — are not a reading: null, which
// the row proof fails closed on (Codex #3876 r21 P2).
async function shownChild(rowHandle, selector) {
  const shown = [];
  for (const h of await rowHandle.$$(selector).catch(() => [])) if (await h.isVisible().catch(() => false)) shown.push(h);
  if (shown.length <= 1) return shown[0] || null;
  // The VALUE is compared, not its DOM form: an input carrying "2" beside
  // a label reading "2" is one reading (pre-push hook P1 on def020079).
  // Every SKU reading — attribute AND text — is normalized the same way, so
  // `data-product-code="S1-77"` beside `SKU: S1-77` is one reading, never
  // two that refuse a valid row (Codex #3876 r25 P2).
  const isSku = selector === SELECTORS.cartLineSku;
  const reading = async (h) => {
    const attr = await h.getAttribute('data-product-code').catch(() => null);
    if (attr) return normalizeSku(attr);
    const value = await h.inputValue().catch(() => null);
    const raw = value != null ? value : await h.textContent().catch(() => '');
    return isSku ? normalizeSku(raw) : String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
  };
  const readings = new Set(await Promise.all(shown.map(reading)));
  return readings.size === 1 ? shown[0] : null;
}

// Returns null when the rows CHURNED while being read: a row whose
// visibility cannot be read (detached mid-scan), or a row count that differs
// after the scan from before it. A summary that briefly held the expected
// line plus one that vanished during the scan would otherwise read as
// exactly [SKU × qty] (Codex #3876 r13 P1) — null fails every proof closed.
async function cartLines(page, lineSelector = SELECTORS.cartLine) {
  let all;
  let shown;
  try { ({ all, shown } = await matches(page, lineSelector, { strict: true })); }
  catch { return null; }
  const readRows = async (rows) => {
  const out = [];
  for (const line of rows) {
    const row = await line.elementHandle({ timeout: 1500 }).catch(() => null);
    if (!row) { out.push({ sku: '', qty: NaN }); continue; }
    // Inside the row too, only the SHOWN SKU / quantity node is read: a
    // hidden responsive child or a stale copy must not feed the exact-cart
    // proof (Codex #3853 r20 P2). None shown = unreadable = fails closed.
    const skuEl = await shownChild(row, SELECTORS.cartLineSku);
    // Attribute-first, like the product page: a row that exposes its code
    // only through data-product-code shows unrelated text (Codex #3853 r21 P2).
    const skuAttr = skuEl ? await skuEl.getAttribute('data-product-code').catch(() => null) : null;
    const sku = (skuAttr || (skuEl ? (await skuEl.textContent().catch(() => '') || '') : '')).replace(/\s+/g, ' ').trim();
    const qtyEl = await shownChild(row, SELECTORS.cartLineQty);
    let qtyText = qtyEl ? await qtyEl.inputValue().catch(() => null) : null;
    if (qtyText == null && qtyEl) qtyText = await qtyEl.textContent().catch(() => null);
    // The row read must still be the row shown: replaced after both reads =
    // the values belong to a node that is gone (r11 P1).
    const stillShown = await row.isVisible().catch(() => false);
    const qty = Number(String(qtyText ?? '').replace(/[^\d.]/g, ''));
    out.push({ sku, qty: !stillShown || qtyText == null || qtyText === '' ? NaN : qty });
  }
  return out;
  };
  const out = await readRows(shown);
  // The rows read must still be the rows shown: the count AND the
  // visibility of every match are re-read after the scan — a row that was
  // hidden at the scan and is visible now (or the reverse) is churn the
  // snapshot missed, not a proof; the count alone would pass it (Codex #3876
  // r18 P1, extending the r13 count check). Then the shown rows are READ
  // AGAIN: a row replaced after its own stillShown check by a different
  // visible row keeps the count and the mask — only a second reading that
  // matches the first, SKU and quantity, is a proof (r20 P2). Unreadable =
  // fails closed.
  const mask = (m) => m.all.map((el) => m.shown.includes(el)).join('');
  let again;
  try { again = await matches(page, lineSelector, { strict: true }); }
  catch { return null; }
  if (again.all.length !== all.length || mask(again) !== mask({ all, shown })) return null;
  const reread = await readRows(again.shown);
  const key = (rows) => JSON.stringify(rows.map((r) => [r.sku, Number.isNaN(r.qty) ? 'NaN' : r.qty]));
  if (key(reread) !== key(out)) return null;
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
    // 'unverified', never a retry (Codex #3853 r23 P1). The Enter path is
    // the same submission and gets the same treatment: a rejected press is
    // not an exception the retry loop may answer with the credential again
    // (Codex #3853 r24 P1).
    const passField = (await matches(page, SELECTORS.loginPass)).shown[0];
    const formSubmits = (await matches(passField.locator('xpath=ancestor::form[1]'), SELECTORS.loginSubmit)).shown;
    let submitUnsettled = false;
    if (formSubmits.length === 1) await formSubmits[0].click().catch(() => { submitUnsettled = true; });
    else await passField.press('Enter').catch(() => { submitUnsettled = true; });
    // The credential is OUT. From here nothing may throw into the retry
    // loop — a locator count failing mid-navigation would otherwise restart
    // the attempt and submit the same credential again (pre-push hook P1 on
    // 0f3febfec): an inspection that fails is an unproven session, parked
    // 'unverified' with the adapter down.
    try {
      // Signed in = EVERY password field gone or hidden (a hidden responsive
      // duplicate must not read as "still on the login page" — pre-push P1).
      await page.waitForFunction((passSel) => Array.from(document.querySelectorAll(passSel)).every((pw) => !pw.offsetParent), SELECTORS.loginPass, { timeout: LOGIN_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(1500);
      // Signed in = the password form GONE and a SHOWN account marker, on the
      // trusted host. Both: an intermediate page (MFA step, maintenance, an
      // error page on the same host) is 'unverified', never a session (Codex
      // #3853 r22 P1); and a login page that keeps its password field up while
      // its header carries a generic account link (.my-account, /my-account)
      // is a REJECTED login, never a session (Codex #3853 r24 P1).
      const passShown = (await matches(page, SELECTORS.loginPass)).shown.length > 0;
      if (!passShown && (await matches(page, SELECTORS.accountMarker)).shown.length && isTrustedSiteOneUrl(page.url())) return 'ok';
      // An unsettled submit cannot tell "not submitted" from "submitted and
      // still loading": neither a rejection nor a transient error (both would
      // resubmit the credential) — it parks unverified (r23 P1).
      if (submitUnsettled) return 'unverified';
      if (passShown || !isTrustedSiteOneUrl(page.url())) return 'rejected';
      return 'unverified';
    } catch (e) {
      logger.warn(`[siteone-bot] post-submit login inspection failed: ${String(e.message).slice(0, 120)}`);
      return 'unverified';
    }
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
  const skuAttr = skuNode ? (await skuNode.getAttribute('data-product-code').catch(() => null)) || (await skuNode.getAttribute('data-itemnumber').catch(() => null)) : null;
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
const linesExact = (lines, vendorSku, qty) => !!lines && lines.length === 1 && normalizeSku(lines[0].sku) === normalizeSku(vendorSku) && lines[0].qty === qty;
const describeLines = (lines) => (!lines ? 'rows changed while being read' : lines.length ? lines.map((l) => `${l.sku || '?'} × ${Number.isFinite(l.qty) ? l.qty : '?'}`).join(', ') : 'empty');
const linesEvidence = (lines) => (lines || []).map((l) => ({ sku: l.sku.slice(0, 60), qty: Number.isFinite(l.qty) ? l.qty : null }));

async function verifyCartAndReadTotal(page, { vendorSku, qty, evidence, upload }) {
  await gotoCart(page);
  const lines = await cartLines(page);
  if (!linesExact(lines, vendorSku, qty)) {
    await shot(page, 'cart', evidence, upload);
    evidence.cartLines = linesEvidence(lines);
    throw new RefusedError('cart_mismatch', `SiteOne cart is not exactly ${vendorSku} × ${qty}: ${describeLines(lines)}`, evidence);
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

// The checkout's order summary must STILL be exactly [this SKU × qty
// packages] (Codex #3876 r7 P1): SiteOne can adjust a quantity for
// availability during checkout, and another session on the account can change
// the cart — the tender, identity and total checks all pass for the altered
// order. Checked at the stage and again inside the click loop.
async function verifyCheckoutLines(page, { vendorSku, qty, evidence, upload }) {
  const lines = await cartLines(page, SELECTORS.checkoutLine);
  if (linesExact(lines, vendorSku, qty)) return;
  await shot(page, 'checkout', evidence, upload);
  evidence.checkoutLines = linesEvidence(lines);
  throw new RefusedError('checkout_lines_mismatch', `SiteOne checkout order is not exactly ${vendorSku} × ${qty}: ${describeLines(lines)} — not submitted`, evidence);
}

// Exactly ONE element for an identity / money reading, inside the checkout:
// zero is unreadable, more than one is ambiguous — the text the bot would
// compare might not be the order's (pre-push P0s). Returns { count, text,
// visible }; the caller names the refusal.
// Text and visibility come from ONE element handle, not two locator
// resolutions: a node SiteOne replaces mid-recalculation would otherwise
// yield the old node's text and the new node's visibility, approving a
// figure that is not the one charged (Codex #3876 r10 P1). A replaced node
// leaves a detached handle, which reads as not visible → refused.
// Counted among SHOWN matches: a hidden responsive copy beside the one
// visible reading is not ambiguity (Codex #3876 r12 P2) — the lone hidden
// match still reports as hidden, and two visible readings stay ambiguous.
// `same(text)`: nested markup (`.order-summary .grand-total` wrapping the
// `.price` it contains) matches the ONE figure twice — shown matches that
// all parse to the SAME value are one reading (the innermost text is
// returned); different values stay ambiguous (Codex #3876 r17 P2).
// Read STRICTLY (Codex #3876 r19 P2): a candidate whose visibility cannot
// be read (it detached mid-enumeration) is not "hidden" — the reading is
// unresolved, `count: null`, and every caller refuses on it.
// `nested: true`: the identity readings have no parsed value — shown matches
// are one reading when every text is CONTAINED in the longest (a wrapper
// around its child); the LONGEST text is the reading, never the innermost —
// a wrapper "Account # 12345 Branch 01" around a "12345" child carries the
// subaccount the child drops (pre-push hook P1 on 85f4bd1ae); unrelated
// texts stay ambiguous (Codex #3876 r24 P2).
const NESTED = (texts) => {
  const norm = texts.map((t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase());
  const longest = norm.reduce((a, b) => (b.length > a.length ? b : a), '');
  return norm.every((t) => t && longest.includes(t)) ? longest : null;
};
async function readExactlyOne(page, selector, { same, nested = false } = {}) {
  let all;
  let shown;
  try { ({ all, shown } = await matches(page, selector, { strict: true })); }
  catch { return { count: null, text: '', visible: false }; }
  // The target among the matches: the one shown match, else the lone
  // hidden match; several shown matches only when `same` proves them one
  // reading (the innermost text wins).
  const pick = async ({ all, shown }) => {
    if (shown.length <= 1) return { target: shown[0] || (all.length === 1 ? all[0] : null) };
    const texts = same || nested ? await Promise.all(shown.map((el) => el.textContent().then((t) => String(t || ''), () => null))) : [];
    if (texts.some((t) => t == null)) return { ambiguous: shown.length };
    const values = new Set(nested ? [NESTED(texts)] : texts.map(same));
    if (values.size !== 1 || values.has(null)) return { ambiguous: shown.length };
    const better = nested ? (a, b) => a.length > b.length : (a, b) => a.length < b.length; // identity: the longest (complete) text; totals: the innermost figure
    return { target: shown[texts.reduce((best, t, i) => (better(t, texts[best]) ? i : best), 0)] };
  };
  const first = await pick({ all, shown });
  if (first.ambiguous) return { count: first.ambiguous, text: '', visible: false };
  if (!first.target) return { count: 0, text: '', visible: false };
  const handle = await first.target.elementHandle({ timeout: 1500 }).catch(() => null);
  if (!handle) return { count: 1, text: '', visible: false };
  const text = await handle.textContent().catch(() => '');
  const isVisible = await handle.isVisible().catch(() => false);
  // Re-enumerated AND re-read after the reads: a replacement node appended
  // during them (the old one not yet removed) would otherwise validate the
  // old value while a second, conflicting reading is on the page (Codex
  // #3876 r21 P2); a node replaced in place — same count, same visibility
  // pattern — would otherwise return the old handle's text while the page
  // shows another figure (r22 P2), so the re-enumerated target's text must
  // equal the first reading, as `cartLines` requires of the rows.
  const mask = (m) => m.all.map((el) => m.shown.includes(el)).join('');
  let again;
  try { again = await matches(page, selector, { strict: true }); }
  catch { return { count: null, text: '', visible: false }; }
  if (again.all.length !== all.length || mask(again) !== mask({ all, shown })) return { count: null, text: '', visible: false };
  // The re-read is ONE element snapshot: text and visibility both from the
  // second target's handle, so a node swapped after the re-enumeration for a
  // hidden one carrying the same text reads as hidden, never as the
  // displayed reading (Codex #3876 r23 P2).
  const second = await pick(again);
  const handle2 = second.target ? await second.target.elementHandle({ timeout: 1500 }).catch(() => null) : null;
  if (!handle2) return { count: null, text: '', visible: false };
  const reread = await handle2.textContent().catch(() => null);
  const visible2 = await handle2.isVisible().catch(() => false);
  if (reread == null || String(reread).replace(/\s+/g, ' ').trim() !== String(text || '').replace(/\s+/g, ' ').trim()) return { count: null, text: '', visible: false };
  return { count: 1, text: String(text || ''), visible: isVisible && visible2 };
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

// How many radios read as selected in the verified radio's OWN group
// (`name`), so a label-associated radio with an opaque value counts (Codex
// #3876 r16 P2); an unnamed radio falls back to the account-value selector.
// Null = unreadable (the caller refuses).
// The count of checked radios in the verified radio's OWN group (its
// `name`). An UNNAMED radio has no group: unnamed radios are not mutually
// exclusive, so a checked saved-card radio beside it would go uncounted and
// the tender would be ambiguous — null, which the callers refuse (Codex
// #3876 r18 P1; replaces the r16 account-value fallback).
async function selectedTenderCount(page, radio) {
  const name = await radio.getAttribute('name').catch(() => null);
  if (!name) return null;
  return page.locator(`input[type="radio"][name="${name.replace(/["\\]/g, '\\$&')}"]:checked`).count().catch(() => null);
}

// The radio input a bill-to option resolves to: the element itself when it
// is an input; for a label, its `for` target or the radio it wraps. Null
// when no radio is associated (never fall back to a document-wide search).
async function associatedRadio(page, option) {
  const tag = await option.evaluate((el) => el.tagName.toLowerCase()).catch(() => null);
  if (tag === 'input') return option;
  if (tag !== 'label') return null;
  const target = await option.getAttribute('for').catch(() => null);
  // The exact id, attribute-matched: a legal id with punctuation
  // (`for="payment:account"`) must resolve to that element, not to a
  // rewritten one (Codex #3876 r12 P2).
  const radio = target ? page.locator(`[id="${target.replace(/["\\]/g, '\\$&')}"]`).first() : option.locator('input[type="radio"]').first();
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
  const checkedCount = await selectedTenderCount(page, radio);
  if (checkedCount == null) await refuse('bill_to_account_unverified', 'the selected radio\'s tender group cannot be counted (unnamed radio, or an unreadable count) — the bot never submits on an unverifiable tender');
  if (checkedCount !== 1) await refuse('bill_to_account_ambiguous', `${checkedCount} tenders read as selected in the bill-to-account radio's group at checkout — cannot tell which the order bills`);
  evidence.billToAccountVerified = true;
  return radio;
}

// The tender and the blockers, re-checked immediately before the click: a
// delayed checkout rerender during the earlier awaits (screenshot upload,
// cap reservation, the identity / line / baseline reads) can reset the
// verified radio to a saved card or reveal an MFA / terms step after the
// last scan (Codex #3876 r3 P1, #3900 r8 P1). Page reads only — nothing is
// awaited off the page between here and the click but the pure total read.
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
  const checkedCount = await selectedTenderCount(page, radio);
  if (checkedCount == null) await refuse('bill_to_account_unverified', 'the selected radio\'s tender group cannot be counted at the moment of submission — the bot never submits on an unverifiable tender');
  if (checkedCount !== 1) await refuse('bill_to_account_ambiguous', `${checkedCount} tenders read as selected in the bill-to-account radio's group at the moment of submission`);
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
  const account = await readExactlyOne(page, SELECTORS.checkoutAccount, { nested: true });
  if (account.count == null) await refuse('account_unverified', 'the billing-account readings at checkout could not be enumerated, or changed while being read — not verified');
  if (account.count > 1) await refuse('account_ambiguous', `${account.count} billing-account readings at checkout — cannot tell which the order bills`);
  const accountText = normalizeText(account.text);
  if (!accountText) await refuse('account_unverified', 'could not read the billing account shown at checkout');
  if (!account.visible) await refuse('account_hidden', 'the billing-account element at checkout is not visible — not what the order bills');
  const wantDigits = String(credentials.accountNumber).replace(/\D/g, '');
  // A separator-formatted display ("12345-01", "12345.01", "12345 - 01")
  // compares digit for digit: separators BETWEEN digits collapse, spaces
  // around them included (Codex #3876 r7 P2, r19 P2), the one-whole-run
  // rule still holds — "12345 - 01" is subaccount 1234501, never 12345.
  const accountRuns = digitRuns(accountText.replace(/(\d)\s*[-./]\s*(?=\d)/g, '$1'));
  if (!wantDigits || accountRuns.length !== 1 || accountRuns[0] !== wantDigits) { evidence.checkoutAccount = accountText.slice(0, 60); await refuse('account_mismatch', `checkout bills account "${accountText.slice(0, 40)}", not the vendor row's ${credentials.accountNumber}`); }
  const shipTo = await readExactlyOne(page, SELECTORS.checkoutShipTo, { nested: true });
  if (shipTo.count == null) await refuse('ship_to_unverified', 'the ship-to readings at checkout could not be enumerated, or changed while being read — not verified');
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
  const total = await readExactlyOne(page, SELECTORS.checkoutTotal, { same: parseMoney });
  if (total.count == null) await refuse('checkout_total_unreadable', 'the checkout-total readings could not be enumerated, or changed while being read — not the figure the order charges');
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
// The whitespace-normalized text of every shown confirmation-number node.
// Unreadable = unresolved (null): a node whose visibility or text cannot be
// read mid-rerender may carry a different order number, so the poll must
// not settle the readable one (Codex #3900 r5 P2). TWO identical snapshots
// (the cart-line pattern, Codex #3900 r10 + r11 P2): the count, the
// visibility mask AND every text are read again after the first pass — a
// node appended, hidden, or rewritten to another identifier between the
// two is churn the scan must not settle on; null, and the next poll judges
// what the page shows then.
async function shownOrderTexts(page) {
  const snapshot = async () => {
    let found;
    try { found = await matches(page, SELECTORS.orderNumber, { strict: true }); } catch { return null; }
    const texts = [];
    for (const n of found.shown) {
      const t = await n.textContent().catch(() => null);
      if (t == null) return null;
      texts.push(String(t).replace(/\s+/g, ' '));
    }
    return { mask: found.all.map((el) => found.shown.includes(el)).join(''), count: found.all.length, texts };
  };
  const first = await snapshot();
  const second = first && await snapshot();
  if (!first || !second) return null;
  if (second.count !== first.count || second.mask !== first.mask || JSON.stringify(second.texts) !== JSON.stringify(first.texts)) return null;
  return first.texts;
}

// EVERY shown confirmation-selector node before the click — each text and
// each parsed identifier — read strictly: two shown reference nodes, or a
// visibility that cannot be read, must not collapse to "no baseline" that a
// stale node left after a rejected click would then satisfy; unreadable
// refuses, before the click (Codex #3876 r7 P2).
async function preClickOrderBaseline(page, refuse) {
  const texts = new Set();
  const ids = new Set();
  try {
    // EVERY match, hidden ones included (Codex #3900 r2 P2): a hidden
    // pre-click node the responsive rerender around the click reveals must
    // not read as a fresh confirmation.
    for (const node of (await matches(page, SELECTORS.orderNumber, { strict: true })).all) {
      const text = String(await node.textContent() || '').replace(/\s+/g, ' ');
      texts.add(text);
      for (const id of orderNumbersIn(text)) ids.add(id.toUpperCase()); // case-insensitive: a rerender that only recases so-12345 → SO-12345 is the same node (r8 P2)
    }
  } catch (e) { await refuse('confirmation_baseline_unreadable', `the confirmation-number nodes could not be read before the click (${String(e.message).slice(0, 80)}) — nothing submitted`); }
  return { texts, ids };
}

// The Place Order control, proven actionable WITHOUT dispatching: the one
// visible control, resolved to an element handle, trial-clicked (Playwright's
// actionability checks — a disabled / covered control refuses here). Runs
// on every pass of the pre-click loop and at a dry run's stop, so a green
// dry run has exercised the control the first live order will click (Codex
// #3876 r17 P2). Returns the handle.
async function trialPlaceOrder(page, placeOrder, refuse) {
  const handle = await placeOrder.elementHandle({ timeout: 1500 }).catch(() => null);
  if (!handle) await refuse('place_order_unactionable', 'the Place Order control could not be resolved — nothing submitted');
  try { await handle.click({ trial: true, timeout: 5000 }); }
  catch (e) { await refuse('place_order_unactionable', `the Place Order control cannot be clicked (${String(e.message).slice(0, 80)}) — nothing submitted`); }
  return handle;
}

async function submitAndReadOrderNumber(page, { evidence, upload, markSubmitted, finalCents, gate, radio, identity, lines, confirmationTimeoutMs = CONFIRMATION_TIMEOUT }) {
  await visibleControl(page, SELECTORS.placeOrder, 'place_order', evidence); // a refusal, before anything is sent
  const refuse = async (reason, message) => { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError(reason, message, evidence); };
  // Confirmation must be evidence created AFTER the click: a node the
  // selector already matches before submission (a reference / PO element,
  // a stale SPA confirmation) is remembered and never accepted as the
  // outcome (Codex #3876 r3 P2).
  // Sampled inside the final stable iteration, not here: the loop below
  // awaits cap reservations and re-checks during which a reference / stale
  // confirmation node can appear or change — a baseline taken before those
  // awaits would let that node pass as post-click evidence (Codex #3876 r6 P2).
  let baseline = null;
  // The ELEMENT the click goes to: an ElementHandle taken at the trial
  // click, so the dispatch is bound to the control the checks validated. A
  // locator (even forced) re-resolves and retries a detached target for up
  // to its timeout, and would click a REPLACEMENT button after a rerender
  // that changed the page (pre-push hook P1 on a0ffa12fd). A replaced
  // control is refused before the submitted guard flips.
  let placeHandle = null;
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
  // start over) → claim re-asserted → Place Order proven actionable →
  // account + ship-to re-checked → order lines re-checked → the validated
  // control still shown → confirmation baseline → tender + blockers
  // re-checked → total read AGAIN — the very last await before the click is
  // that pure read, and it must equal the figure the cap approved.
  // The tender proof is the LAST proof but the total (Codex #3900 r8 P1): a
  // saved-card tender can keep the same account, ship-to, lines and total,
  // so none of the longer reads detects a reset that lands during them —
  // read first, the tender proof was stale by the click. After it only the
  // pure total read stands before the dispatch.
  // The identity re-check (Codex #3876 r5 P1): a delayed rerender that
  // swaps the displayed billing account or ship-to while the radio stays
  // checked and the total stable would otherwise submit on a stale proof.
  // The trial click (Codex #3876 r5 P2): Playwright's actionability checks
  // without dispatching — a disabled Place Order refuses BEFORE the
  // submitted guard flips, instead of parking ambiguous with nothing sent.
  // It runs FIRST (Codex #3876 r6 P1): it is itself an awaited wait of up
  // to 5 s, so a rerender during it that resets the tender or swaps the
  // account would otherwise go unrevalidated; after it only pure page
  // reads stand between the proofs and the click.
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
    // The ONE visible control is resolved again on every pass: a rerender
    // during the awaits above can expose a second visible Place Order, and
    // an `nth()` locator saved earlier would re-resolve to one of them
    // without the ambiguity refusal (Codex #3900 r1 P2).
    // The claim is re-asserted on EVERY pass, changed figure or not: the
    // page checks can outlive the claim (stale recovery parks it after
    // prolonged heartbeat failures), and only the reservation — conditional
    // on `status = 'placing'` — refuses `claim_lost`; without it the click
    // would spend after the claim was settled (Codex #3900 r5 P1). It is an
    // awaited DB write, so it runs FIRST, like the trial click: everything
    // the page must still prove — tender, blockers, identity, lines, the
    // control, the baseline, the total — is read AFTER it (pre-push hook P1
    // on c30aa1cee), and a checkout that switched tender, ship-to, or SKU
    // during the wait is caught by those re-checks.
    await gate(cents, 'final claim check');
    placeHandle = await trialPlaceOrder(page, await visibleControl(page, SELECTORS.placeOrder, 'place_order', evidence), refuse);
    await identity();
    await lines();
    // Still the validated element, still shown: a detached handle is a
    // replaced control — refused, nothing submitted (hook P1). Read BEFORE
    // the baseline and the final total read; a control replaced during
    // those is a detached handle the forced click cannot dispatch → ambiguous.
    if (!(await placeHandle.isVisible().catch(() => false))) await refuse('place_order_replaced', 'the Place Order control was replaced after the final checks — nothing submitted');
    // The baseline precedes only the tender proof and the final pure total
    // read, so a reference node that appears during the longer awaits is in
    // the baseline (Codex #3900 r5 P1); the total read stays last (Codex
    // #3876 r4 P1) — a node appearing inside the tender re-check or that
    // single read is the residual window, and it still has to survive two
    // settle polls to be recorded.
    baseline = await preClickOrderBaseline(page, refuse);
    // Tender + blockers LAST but the total (Codex #3900 r8 P1): page reads
    // only from here to the click.
    await recheckTenderAtClick(page, radio, { evidence, upload });
    shownCents = await readCheckoutTotal(page, { evidence, upload, screenshot: false });
    if (shownCents === cents) break;
    if (i >= 3) throw unstable(shownCents);
  }
  markSubmitted();
  let number = null;
  try {
    // The dispatch must not WAIT past the validated state: an ordinary
    // click re-runs Playwright's actionability checks and can sit through a
    // SiteOne rerender (button briefly disabled, covered, moving) that
    // changes the total, tender, identity or lines, then dispatch on the
    // unvalidated page. `force` dispatches at once on the control the trial
    // click proved actionable a few reads ago; a control the browser will
    // not act on submits nothing and falls to the ambiguous path (Codex
    // #3876 r8 P1).
    // `noWaitAfter`: the click is the dispatch — a slow post-submit
    // navigation must not reject the click and skip the confirmation poll
    // (which would park a placed order without its number); the bounded
    // load-state wait and the poll below handle the response (Codex #3900 P2).
    await placeHandle.click({ force: true, noWaitAfter: true, timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    // The confirmation must be read ON SiteOne: SITEONE_BOT_ALLOWED_HOSTS can
    // admit an asset host, and a numeric error id on a page there is not an
    // order number — an off-host landing is ambiguous, never green (Codex
    // #3876 r10 P2). Re-checked on every confirmation poll.
    // An SPA checkout renders the confirmation after domcontentloaded: wait
    // (bounded) for a SHOWN confirmation-number node rather than sampling
    // once after a fixed delay (Codex #3876 r2 P2). A timeout falls through
    // to the ambiguous path below.
    number = await waitForNewOrderNumber(page, baseline, confirmationTimeoutMs); // injectable: the fake-page tests wait milliseconds, not the 20 s production deadline (Codex #3900 P1)
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

// Wait (bounded) for exactly ONE new identifier among the shown
// confirmation-number nodes. Each shown node is judged on its own against
// the pre-click baseline: a node whose text was shown before the click, or
// whose identifier was, is not evidence — a reference node whose status text
// alone changes ("PO reference 55501 · Ready" → "… · Validation failed") is
// not a new confirmation (Codex #3876 r5 P2), nor is one of two pre-click
// nodes left standing alone after a rejected click (r7 P2), nor a retained
// reference node beside the confirmation the SPA appended (r17 P2). Nested
// matches (an h1 wrapping the strong that carries the number) are one
// identifier (r12 P2); two DIFFERENT new identifiers are ambiguous at once. A node's
// first render ("Processing order…", an empty element) is not the outcome:
// polling continues until a text yields a number (Codex #3876 r4 P2); a
// timeout returns null and leaves the ambiguous path to decide.
// The sole candidate must SETTLE: the same single new identifier on two
// consecutive polls. A reference / PO value that renders a tick before the
// order number would otherwise be recorded at once and the real number never
// observed (Codex #3900 r1 P2); a candidate that changes starts over.
async function waitForNewOrderNumber(page, baseline, timeout) {
  const deadline = Date.now() + timeout;
  let candidate = null;
  for (;;) {
    if (!isTrustedSiteOneUrl(page.url())) throw new Error(`confirmation page left the trusted host (${String(page.url()).slice(0, 80)})`);
    const fresh = new Map();
    const texts = await shownOrderTexts(page);
    if (texts == null) { candidate = null; if (Date.now() >= deadline) return null; await page.waitForTimeout(500); continue; } // unreadable scan: nothing settles on it
    for (const text of texts) {
      if (baseline.texts.has(text)) continue;
      // EVERY labeled identifier in the node is judged: a wrapper that grew
      // from the pre-click reference to reference + confirmation carries the
      // baseline id first and the new one after it (Codex #3876 r18 P2).
      for (const number of orderNumbersIn(text)) if (!baseline.ids.has(number.toUpperCase())) fresh.set(number.toUpperCase(), number);
    }
    // Two different NEW identifiers on one poll is ambiguity that waiting
    // cannot resolve — one of them disappearing later would let the other
    // settle and be recorded (Codex #3900 r2 P2): null at once, the
    // ambiguous path decides.
    if (fresh.size > 1) return null;
    const sole = fresh.size === 1 ? fresh.values().next().value : null;
    if (sole && candidate && sole.toUpperCase() === candidate.toUpperCase()) return sole;
    candidate = sole;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

// The confirmation number: the first of `orderNumbersIn`.
function orderNumberIn(text) { return orderNumbersIn(text)[0] || null; }

// EVERY distinct identifier a confirmation node carries, in order: each
// token adjacent to an "Order #/number" label that is an identifier, else
// (a dedicated number element) the whole text when it is one identifier. An
// identifier carries at least one DIGIT — a label word ("Confirmation",
// "order") never becomes the recorded order number (Codex PR3 r1 P2).
function orderNumbersIn(text) {
  // An identifier carries a digit and is never date-shaped: digits joined
  // only by separators (2026-09-05, 09-05-2026, 05/09/26) are not ids —
  // an unlabeled all-digit run (12345678) still is (Codex #3876 r3 P2).
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  // Separator-joined digit groups are a date only when the groups CAN be one
  // (year-month-day, month-day-year, day-month-year, month-year, with real
  // month / day ranges): "12345-67890" is a labeled confirmation number, not
  // a date (Codex #3876 r8 P2).
  const md = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const yr = (g) => g.length === 2 || (g.length === 4 && /^(?:19|20)/.test(g));
  const sepDate = (t) => {
    const g = t.split(/[-/.]/);
    if (!g.every((x) => /^\d{1,4}$/.test(x))) return false;
    const n = g.map(Number);
    if (g.length === 2) return n[0] >= 1 && n[0] <= 12 && yr(g[1]); // 09/26, 09-2026
    if (g.length !== 3) return false;
    return (g[0].length === 4 && yr(g[0]) && md(n[1], n[2])) // 2026-09-05
      || (yr(g[2]) && (md(n[0], n[1]) || md(n[1], n[0]))); // 09-05-2026, 05/09/26
  };
  const dateShaped = (t) => sepDate(t)
    || /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(t) // 20260905 (compact)
    || /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:19|20)\d{2}$/.test(t) // 09052026 (compact, month first — r5 P2)
    || /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}$/.test(t) // 05092026 (compact, day first)
    || new RegExp(`^${MON}[-/.]?\\d{1,2}[-/.]\\d{2,4}$`, 'i').test(t) // Sep-05-2026
    || new RegExp(`^\\d{1,2}[-/.]?${MON}[-/.]?\\d{2,4}$`, 'i').test(t); // 05-Sep-2026
  // Nor money-shaped: "Order # pending · Total $105.93" must keep polling
  // for the number, not record the price as the order id (Codex #3876 r10 P2).
  const moneyShaped = (t) => /^\d+\.\d{2}$/.test(t) || /^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(t);
  const isId = (t) => !!t && /\d/.test(t) && !dateShaped(t) && !moneyShaped(t);
  // A STRONG qualifier (#, number, no, ID, ref) positively identifies the
  // value: "Order # 20260905" is that order's number even though the digits
  // form a date — excluded, a placed order would park ambiguous on every
  // date-shaped id (Codex #3900 r9 P2). The date exclusion stays for the
  // weak forms ("Order confirmation 09/05/2026", "Order: 2026-09-05") and
  // for the unlabeled dedicated-element text.
  const strongLabel = (q) => /#|number|no\b|\bid\b|ref/i.test(q);
  const isLabeledId = (q, t) => (strongLabel(q) ? !!t && /\d/.test(t) && !moneyShaped(t) : isId(t));
  // EVERY labeled match is tried: "Order date 2026-09-05 … Order # SO-778899"
  // must yield the number, not the date (Codex #3876 r2 P2). Labeled ONLY —
  // no unlabeled fallback: "Order # pending · Ships to 34205" must keep
  // polling, not record the ZIP (Codex #3876 r16 P2). Labels: order /
  // confirmation, optionally followed by confirmation / number / no. / id /
  // ref / #. An identifier ends in a letter or digit: the sentence's own
  // period ("Your order number is 55501234.") is prose, not part of the id —
  // recorded with it, the same number rerendered without it would read as a
  // new one, and the date / money exclusions would miss (Codex #3876 r17 P2).
  const ids = [];
  // A word boundary before the label, and no known prefix concept before
  // it: "Reorder # 12345", "Backorder # 12345", "Purchase Order # PO-12345",
  // "Back Order # BO-12345", "Sales order 778", "Work order 42" are other
  // concepts, never the confirmation (Codex #3900 P2 ×2). A bare label needs
  // a colon or "is" ("Order: SO-1", "Order is SO-1"): "Order SO-1" alone is
  // not read, so every accepted form has a selector label (Codex #3900 r7 P2).
  for (const m of String(text).matchAll(/(?<!\b(?:purchase|back|sales|work|change|pre|re)[\s-]*)\b(?:order|confirmation)(?!\s*date)((?:(?:\s*(?:confirmation|number|no\.?|id|ref(?:erence)?|#))+(?:\s+is)?\s*:?|\s+is\s*:?|\s*:))\s*([A-Z0-9][A-Z0-9/.-]{3,}[A-Z0-9])/gi)) if (isLabeledId(m[1], m[2]) && !ids.some((x) => x.toUpperCase() === m[2].toUpperCase())) ids.push(m[2]);
  if (ids.length) return ids;
  // A dedicated number element (`[data-test="order-number"]`, `.order-number`)
  // carries the bare identifier and no label: the WHOLE text, when it is one
  // identifier token, is the number (pre-push hook P1 on de3e4a993). Prose
  // still needs the label — a ZIP or price inside a sentence never qualifies.
  const whole = String(text).trim();
  return /^[A-Z0-9][A-Z0-9/.-]{3,}[A-Z0-9]$/i.test(whole) && isId(whole) ? [whole] : [];
}

// The checkout stage: bill-to proof, identity + final total, the cap gate on
// that total, the one click, the confirmation number. Every check refuses
// BEFORE the click; only the click flips the caller's cart-cleanup guard.
async function checkoutAndSubmit(page, { vendorSku, qty, credentials, shipToTokens, gate, evidence, upload, markSubmitted, confirmationTimeoutMs, dryRun = false }) {
  await (await visibleControl(page, SELECTORS.checkoutButton, 'checkout_button', evidence)).click();
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);
  if (!isTrustedSiteOneUrl(page.url())) throw runLevel('siteone bot: checkout left the trusted host');
  const radio = await verifyBillToAccount(page, { evidence, upload });
  await verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload });
  await verifyCheckoutLines(page, { vendorSku, qty, evidence, upload });
  const finalCents = await readCheckoutTotal(page, { evidence, upload });
  await gate(finalCents, 'checkout total');
  // A dry run has now exercised every checkout selector and the final cap
  // check; it stops HERE, before the one click, and bells the checkout
  // total — selector drift is caught before any live purchase (Codex #3876
  // r2 P1). The Place Order control is resolved and trial-clicked too, so a
  // missing / ambiguous / disabled control is a dry-run refusal, not the
  // first live order's park (r17 P2). The caller's finally empties the cart.
  if (dryRun) {
    const placeOrder = await visibleControl(page, SELECTORS.placeOrder, 'place_order', evidence);
    await trialPlaceOrder(page, placeOrder, async (reason, message) => { await shot(page, 'pre-submit', evidence, upload); throw new RefusedError(reason, message, evidence); });
    evidence.placeOrderValidated = true;
    await shot(page, 'dry-run-stop', evidence, upload);
    return { dryRun: true, amountCents: finalCents, externalOrderNumber: null, evidence };
  }
  let placed;
  const identity = () => verifyCheckoutIdentity(page, { credentials, shipToTokens, evidence, upload });
  const lines = () => verifyCheckoutLines(page, { vendorSku, qty, evidence, upload });
  try { placed = await submitAndReadOrderNumber(page, { evidence, upload, markSubmitted, finalCents, gate, radio, identity, lines, confirmationTimeoutMs }); }
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
  { launchBrowser = chromium ? defaultLaunch : null, resolveHostIps = filler.resolvePublicIps, upload = uploadEvidence, confirmationTimeoutMs = CONFIRMATION_TIMEOUT } = {},
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
    return await checkoutAndSubmit(page, { vendorSku, qty, credentials, shipToTokens, gate, evidence, upload, dryRun, confirmationTimeoutMs, markSubmitted: () => { submitted = true; } });
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
  _internals: { SELECTORS, isTrustedSiteOneUrl, allowedHosts, parseMoney, normalizeSku, requestPermitted, orderNumberIn, orderNumbersIn, fillLoginForm, EVIDENCE_PREFIX },
};
