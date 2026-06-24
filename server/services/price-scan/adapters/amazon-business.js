// Amazon Business Product Search API adapter.
//
// UNLIKE the Playwright adapters, this calls the Amazon Business API directly (no
// browser): it refreshes an LWA access token, keyword-searches the product, verifies
// each result, and hands the best business-priced offer to the same compare pipeline
// via the shared fetchCandidate(page, vendor, product) contract — the `page` arg is
// accepted for signature compatibility and ignored.
//
// ACCESS IS APPROVAL-GATED. Amazon Business API access is not self-serve: you request
// it from the Amazon Business team (ab-api-access-approvals@amazon.com), and after
// approval you register an app (SPP account + developer profile) and receive LWA
// credentials. See docs.business.amazon.com → "Onboarding overview". Until the four
// env vars below are set this adapter is INERT — isConfigured() is false and
// scrapableVendors() skips Amazon, so nothing is called.
//
// ⚠️ NOT LIVE-TESTED: built against the published docs while access approval was
// pending, so the auth header shape and the response field paths (priceOf/titleOf/…)
// are isolated here and MUST be confirmed on the first authorized call. Each is a
// one-line fix if Amazon's live shape differs from the docs.

const { searchQuery } = require('./base');
const { extractSizeToken, quantityToOz, mapAvailability, verifyMatch } = require('../extract');
const { isUnavailable } = require('../compare');
const { convertToOz } = require('../../product-costing');
const logger = require('../../logger');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const API_HOST = process.env.AMAZON_BUSINESS_API_HOST || 'https://api.business.amazon.com';
const API_VERSION = '2020-08-26';
const MAX_CANDIDATES = 5; // top relevance-ranked results to verify
const TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before expiry

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

// Per-process LWA access-token cache. Exported reset for tests.
let cachedToken = null; // { value, expiresAt }
function resetTokenCache() { cachedToken = null; }

// Exchange the refresh token for an access token (cached until ~1 min before expiry).
// `deps.fetch` / `deps.now` are injectable for tests. Throws on a non-OK response WITHOUT
// logging the body — LWA error bodies can echo the client_id.
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
// The Product Search response shape per the docs: products[] each with a price object
// { amount, currencyCode }, a title, an ASIN, and an availability flag. The fallbacks
// cover plausible alternative key names so a minor doc/live mismatch degrades to a skip
// rather than a crash.
function productsFromResponse(json) {
  if (!json) return [];
  return json.products || json.items
    || (json.searchResult && json.searchResult.products)
    || (json.data && json.data.products)
    || [];
}
function priceOf(product) {
  const p = product && (product.price || product.buyingPrice || product.listingPrice || product.offerPrice);
  if (!p || typeof p !== 'object') return null;
  const amount = Number(p.amount != null ? p.amount : p.value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: p.currencyCode || p.currency || 'USD' };
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
// Map Amazon's availability signal to our enum. Unknown stays 'unknown' (compare keeps
// it eligible) — Amazon search results are generally buyable, but we never invent stock.
function availabilityOf(product) {
  if (!product) return 'unknown';
  if (product.inStock === true) return 'in_stock';
  if (product.inStock === false) return 'out_of_stock';
  const raw = product.availability || product.availabilityStatus || product.availabilityMessage;
  return raw ? mapAvailability(raw) : 'unknown';
}

// One product node -> a candidate in the shared shape, or null if it isn't priced.
function candidateFromProduct(product, vendor) {
  const priced = priceOf(product);
  if (!priced) return null;
  const asin = asinOf(product);
  const name = titleOf(product);
  const sourceUrl = detailUrlOf(product, asin);
  if (!sourceUrl) return null; // a candidate must carry a proof link
  return {
    price: priced.amount,
    currency: priced.currency,
    availability: availabilityOf(product),
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

// GET the keyword search, returning the parsed JSON. Throws on a non-OK response so the
// scanner records a retryable fetch_error (never logs the body — it can carry the email).
async function searchProducts(keywords, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const token = await getAccessToken(deps);
  const c = creds();
  const url = `${API_HOST}/products/${API_VERSION}/products?keywords=${encodeURIComponent(keywords)}`;
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
  fetchCandidate,
  isConfigured,
  // exposed for unit tests
  getAccessToken,
  searchProducts,
  candidateFromProduct,
  priceOf,
  titleOf,
  productsFromResponse,
  availabilityOf,
  resetTokenCache,
};
