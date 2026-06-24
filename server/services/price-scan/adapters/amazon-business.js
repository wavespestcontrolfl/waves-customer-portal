// Amazon Business Product Search API adapter.
//
// UNLIKE the Playwright adapters, this calls the Amazon Business API directly (no
// browser): it refreshes an LWA access token, keyword-searches the product, verifies
// each result, and hands the best business-priced offer to the same compare pipeline
// via the shared fetchCandidate(page, vendor, product) contract — the `page` arg is
// accepted for signature compatibility and ignored. The adapter is marked `apiOnly`
// so runScanMany never launches Chromium on its behalf (and a missing browser binary
// can't abort an Amazon-only run).
//
// ACCESS IS APPROVAL-GATED. Amazon Business API access is not self-serve: you request
// it from the Amazon Business team (ab-api-access-approvals@amazon.com), and after
// approval you register an app (SPP account + developer profile) and receive LWA
// credentials. See docs.business.amazon.com → "Onboarding overview". Until the four
// env vars below are set this adapter is INERT — isConfigured() is false and
// scrapableVendors() skips Amazon, so nothing is called.
//
// ⚠️ NOT LIVE-TESTED: built against the published docs while access approval was
// pending. The request params, auth header shape, and response field paths are
// isolated and MUST be confirmed on the first authorized call. They follow the docs:
// productRegion + locale are REQUIRED query params; offers/account-pricing come back
// under includedDataTypes=OFFERS with the amount at price.value.amount; the usage plan
// is 0.5 req/s burst 10 (we throttle below). Each is a one-line fix if live differs.

const { searchQuery } = require('./base');
const { extractSizeToken, quantityToOz, mapAvailability, verifyMatch } = require('../extract');
const { isUnavailable } = require('../compare');
const { convertToOz } = require('../../product-costing');
const logger = require('../../logger');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const API_HOST = process.env.AMAZON_BUSINESS_API_HOST || 'https://api.business.amazon.com';
const API_VERSION = '2020-08-26';
const PRODUCT_REGION = process.env.AMAZON_BUSINESS_PRODUCT_REGION || 'US'; // REQUIRED by the API (US or DE)
const LOCALE = process.env.AMAZON_BUSINESS_LOCALE || 'en_US'; // REQUIRED by the API
const INCLUDED_DATA_TYPES = process.env.AMAZON_BUSINESS_INCLUDED_DATA_TYPES || 'OFFERS'; // include account pricing
const MAX_CANDIDATES = 5; // top relevance-ranked results to verify
const TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before expiry
// Stay under the published 0.5 req/s usage plan (≈2.1s spacing) so a 25-product run
// can't burn the burst and turn the tail into 429s. Override via env if Amazon raises it.
const MIN_INTERVAL_MS = Number(process.env.AMAZON_BUSINESS_MIN_INTERVAL_MS) || 2100;

function creds() {
  return {
    clientId: process.env.AMAZON_LWA_CLIENT_ID,
    clientSecret: process.env.AMAZON_LWA_CLIENT_SECRET,
    refreshToken: process.env.AMAZON_BUSINESS_REFRESH_TOKEN,
    userEmail: process.env.AMAZON_BUSINESS_USER_EMAIL,
  };
}

// Inert unless ALL four credentials are present. scrapableVendors() checks this so an
// unconfigured Amazon vendor is skipped (no wasted no-op fetch every run before access).
function isConfigured() {
  const c = creds();
  return !!(c.clientId && c.clientSecret && c.refreshToken && c.userEmail);
}

// Per-process state. Exported reset for tests.
let cachedToken = null; // { value, expiresAt }
let nextAllowedAt = 0; // throttle gate (epoch ms)
function resetState() { cachedToken = null; nextAllowedAt = 0; }

// Space calls to the published usage plan. now/sleep injectable for tests (a no-op
// sleep makes tests instant).
async function throttle(deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const wait = nextAllowedAt - now();
  if (wait > 0) await sleep(wait);
  nextAllowedAt = (deps.now || Date.now)() + MIN_INTERVAL_MS;
}

// Exchange the refresh token for an access token (cached until ~1 min before expiry).
// Throws on a non-OK response WITHOUT logging the body — LWA error bodies can echo the
// client_id. deps.fetch / deps.now injectable for tests.
async function getAccessToken(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || Date.now;
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > now()) return cachedToken.value;
  const c = creds();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetchImpl(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`LWA token ${res.status}`);
  const json = await res.json();
  if (!json || !json.access_token) throw new Error('LWA token: no access_token in response');
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  cachedToken = { value: json.access_token, expiresAt: now() + ttlMs };
  return cachedToken.value;
}

// ── Response field accessors (ISOLATED — verify against the live API) ──────────────
function productsFromResponse(json) {
  if (!json) return [];
  return json.products || json.items
    || (json.searchResult && json.searchResult.products)
    || (json.data && json.data.products)
    || [];
}
// Buyable OFFERS for a product (where account pricing + restrictions live per the docs).
function offersOf(product) {
  if (!product) return [];
  const o = product.offers || (product.offerData && product.offerData.offers) || product.buyingOptions;
  return Array.isArray(o) ? o : [];
}
// True when this product/offer carries buying restrictions for the account (can't buy).
function hasBuyingRestriction(node) {
  if (!node) return false;
  const r = node.buyingRestrictions || node.restrictions;
  if (Array.isArray(r) && r.length) return true;
  if (r && typeof r === 'object' && Object.keys(r).length) return true;
  return node.purchasable === false || node.buyable === false;
}
// Price object -> { amount, currency }. Documented shape nests the amount at
// price.value.amount (currency at price.value.currencyCode); flatter fallbacks cover a
// doc/live mismatch rather than crash. Rejects non-positive.
function priceOf(node) {
  const p = node && (node.price || node.buyingPrice || node.listingPrice || node.offerPrice);
  if (!p || typeof p !== 'object') return null;
  const v = (p.value && typeof p.value === 'object') ? p.value : p;
  const amount = Number(v.amount != null ? v.amount : v.value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: v.currencyCode || v.currency || p.currencyCode || 'USD' };
}
function titleOf(product) {
  return (product && (product.title || product.name || product.productTitle)) || null;
}
function asinOf(product) {
  return (product && (product.asin || product.productId || product.id)) || null;
}
function detailUrlOf(product, asin) {
  return (product && (product.detailPageUrl || product.detailPageURL || product.url))
    || (asin ? `https://www.amazon.com/dp/${asin}` : null);
}
function availabilityOf(node) {
  if (!node) return 'unknown';
  if (node.inStock === true) return 'in_stock';
  if (node.inStock === false) return 'out_of_stock';
  const raw = node.availability || node.availabilityStatus || node.availabilityMessage;
  return raw ? mapAvailability(raw) : 'unknown';
}

// One product node -> a candidate in the shared shape, or null. Prefers a concrete
// buyable OFFER (account pricing + restrictions live there per the docs), skipping
// offers the account can't purchase so a restricted product is never staged as an
// opportunity; falls back to a product-level price.
function candidateFromProduct(product, vendor) {
  const offers = offersOf(product);
  let chosen = null;
  for (const o of offers) {
    if (hasBuyingRestriction(o)) continue;
    if (priceOf(o)) { chosen = o; break; }
  }
  // No buyable offer: only fall back to a product-level price if the PRODUCT itself
  // isn't restricted (else the account can't buy it — don't surface it).
  if (!chosen && (offers.length || hasBuyingRestriction(product))) {
    if (hasBuyingRestriction(product) || offers.length) return null;
  }
  const priceNode = chosen || product;
  const priced = priceOf(priceNode);
  if (!priced) return null;
  const asin = asinOf(product);
  const name = titleOf(product);
  const sourceUrl = detailUrlOf(product, asin);
  if (!sourceUrl) return null; // a candidate must carry a proof link
  return {
    price: priced.amount,
    currency: priced.currency,
    availability: availabilityOf(chosen || product),
    name,
    quantity: extractSizeToken(name),
    // Amazon search nodes carry no body text; the title is the only corroboration the
    // EPA/name check has (Amazon titles include the brand + pack size).
    text: name,
    source_url: sourceUrl,
    price_type: 'account', // business-account pricing, not public list price
    vendor_id: vendor.vendor_id || vendor.id,
    vendor: vendor.name || 'Amazon',
  };
}

// GET the keyword search, returning the parsed JSON. Sends the REQUIRED productRegion +
// locale params and requests the OFFERS facet. Throttled to the usage plan. Throws on a
// non-OK response so the scanner records a retryable fetch_error (never logs the body —
// it can carry the account email).
async function searchProducts(keywords, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const token = await getAccessToken(deps);
  const c = creds();
  const qs = new URLSearchParams({
    keywords,
    productRegion: PRODUCT_REGION,
    locale: LOCALE,
    includedDataTypes: INCLUDED_DATA_TYPES,
  });
  const url = `${API_HOST}/products/${API_VERSION}/products?${qs.toString()}`;
  await throttle(deps);
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-amz-user-email': c.userEmail,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`amazon products ${res.status}`);
  return res.json();
}

// Search Amazon Business for `product` and return the best verified business-priced
// offer (or null). Mirrors the search-then-verify-each flow of the browser adapters:
// prefer an EPA-confirmed buyable match, then a buyable name+size match, then a
// verified-but-unbuyable one, then the best priced page as a precise 'unverified' skip.
async function fetchCandidate(page, vendor, product, opts = {}) {
  if (!isConfigured()) return null; // belt-and-suspenders; scrapableVendors also gates this
  const deps = opts.amazonDeps || {};
  const q = searchQuery(product);
  if (!q) return null;

  const targetOz = product.packSizeValue != null && product.packSizeUnit
    ? convertToOz(product.packSizeValue, product.packSizeUnit)
    : quantityToOz(product.quantity);

  let json;
  try {
    json = await searchProducts(q, deps);
  } catch (err) {
    // Token/HTTP failure — surface as a retryable fetch_error, not a clean miss.
    logger.warn(`[price-scan] amazon search failed: ${err.message}`);
    throw err;
  }

  const products = productsFromResponse(json).slice(0, MAX_CANDIDATES);
  const wantsEpa = !!(product && product.epaReg);
  let firstBuyable = null;
  let firstUnbuyable = null;
  let fallback = null;
  for (const p of products) {
    const cand = candidateFromProduct(p, vendor);
    if (!cand) continue;
    if (!fallback) fallback = cand;
    const verdict = verifyMatch(
      { name: cand.name, text: cand.text, quantity: cand.quantity },
      { ...product, targetOz },
    );
    if (!verdict.matched) continue;
    const buyable = !isUnavailable(cand);
    if ((!wantsEpa || verdict.signals.epa) && buyable) return cand;
    if (buyable) { if (!firstBuyable) firstBuyable = cand; }
    else if (!firstUnbuyable) firstUnbuyable = cand;
  }
  return firstBuyable || firstUnbuyable || fallback;
}

module.exports = {
  key: 'amazon',
  config: { key: 'amazon', priceType: 'account' },
  apiOnly: true, // HTTP adapter — runScanMany must not launch a browser for it
  fetchCandidate,
  isConfigured,
  // exposed for unit tests
  getAccessToken,
  searchProducts,
  candidateFromProduct,
  priceOf,
  titleOf,
  productsFromResponse,
  offersOf,
  hasBuyingRestriction,
  availabilityOf,
  resetState,
};
