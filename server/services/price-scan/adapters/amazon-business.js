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
// Production Amazon Business API hosts are REGIONAL — North America is na.business-api,
// EU/JP are eu./jp.business-api (api.business.amazon.com is only the docs/explorer host).
// Default NA (Waves); override via env for another region.
const API_HOST = process.env.AMAZON_BUSINESS_API_HOST || 'https://na.business-api.amazon.com';
const API_VERSION = '2020-08-26';
const PRODUCT_REGION = process.env.AMAZON_BUSINESS_PRODUCT_REGION || 'US'; // REQUIRED by the API (US or DE)
const LOCALE = process.env.AMAZON_BUSINESS_LOCALE || 'en_US'; // REQUIRED by the API
const FACETS = process.env.AMAZON_BUSINESS_FACETS || 'OFFERS'; // data facets to include (account pricing lives in OFFERS)
// Delivery ZIP — Amazon uses shippingPostalCode to pick the shipping region, so without it
// the scan could surface an offer not deliverable to Waves' SW-FL service area. Default to
// Waves' ZIP; override via env. Set empty to omit.
const SHIPPING_POSTAL_CODE = process.env.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE != null
  ? process.env.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE : '34211';
// Fail CLOSED on a missing/ambiguous offer condition: only an explicit NEW is compared
// against SiteOne's new pricing. Flip this env true only if first-live testing shows the
// OFFERS facet legitimately omits condition for new items.
const ALLOW_UNSPECIFIED_CONDITION = process.env.AMAZON_BUSINESS_ALLOW_UNSPECIFIED_CONDITION === 'true';
const USER_AGENT = process.env.AMAZON_BUSINESS_USER_AGENT || 'WavesPriceScan/1.0 (Language=Node.js)';
const MAX_CANDIDATES = 5; // top relevance-ranked results to verify
const TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before expiry
// Stay under the published 0.5 req/s usage plan (≈2.1s spacing) so a 25-product run
// can't burn the burst and turn the tail into 429s. Override via env if Amazon raises it.
const MIN_INTERVAL_MS = Number(process.env.AMAZON_BUSINESS_MIN_INTERVAL_MS) || 2100;
// Cap each HTTP call so a stalled endpoint can't wedge the weekly scan under its lock
// (the browser adapters cap navigations at ~20s — match that).
const HTTP_TIMEOUT_MS = Number(process.env.AMAZON_BUSINESS_HTTP_TIMEOUT_MS) || 20000;

// fetch with an abort timeout. Clears the timer on completion so no handle dangles.
// deps.fetch injectable for tests.
async function timedFetch(url, init, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`amazon http timeout after ${HTTP_TIMEOUT_MS}ms`)), HTTP_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  const now = deps.now || Date.now;
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > now()) return cachedToken.value;
  const c = creds();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await timedFetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  }, deps);
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
// Buyable OFFERS for a product. Documented shape: facets=OFFERS returns them under
// product.includedDataTypes.OFFERS; fall back to a few plausible keys so a doc/live
// mismatch degrades to "no offers" rather than crashing.
function offersOf(product) {
  if (!product) return [];
  const idt = product.includedDataTypes && product.includedDataTypes.OFFERS;
  const o = idt || product.offers || (product.offerData && product.offerData.offers) || product.buyingOptions;
  return Array.isArray(o) ? o : [];
}
// True when this product/offer can't be purchased by the account: explicit restrictions,
// a non-purchasable flag, OR guided-buying buyingGuidance === 'BLOCKED'.
function hasBuyingRestriction(node) {
  if (!node) return false;
  const r = node.buyingRestrictions || node.restrictions;
  if (Array.isArray(r) && r.length) return true;
  if (r && typeof r === 'object' && Object.keys(r).length) return true;
  if (String(node.buyingGuidance || '').toUpperCase() === 'BLOCKED') return true;
  // Current guided-buying shape: buyingGuidanceV2.buyingGuidance[].type === 'BLOCKED'.
  const v2 = node.buyingGuidanceV2 && node.buyingGuidanceV2.buyingGuidance;
  if (Array.isArray(v2) && v2.some((g) => String(g && g.type).toUpperCase() === 'BLOCKED')) return true;
  return node.purchasable === false || node.buyable === false;
}
// True unless the offer/product is explicitly a NON-new condition (used, refurbished,
// collectible, open-box). The rest of the price-scan lane compares NEW inventory, so a
// non-new Amazon offer must not be staged against SiteOne's new pricing. Unspecified
// condition is treated as new (Amazon search defaults to new).
function isNewCondition(node) {
  if (!node) return ALLOW_UNSPECIFIED_CONDITION;
  const c = node.productCondition
    || (node.condition && (node.condition.conditionValue || node.condition.value)) || node.condition
    || node.conditionValue;
  if (!c) return ALLOW_UNSPECIFIED_CONDITION; // missing condition -> fail closed (only explicit NEW)
  const s = String(c).trim().toLowerCase();
  // Reject every non-new value — used/refurbished/renewed/collectible/open-box AND the
  // ambiguous OTHER/UNKNOWN enums — so ONLY explicit new inventory is compared against
  // SiteOne's new pricing. "Used - Like New" is correctly rejected by the used marker.
  if (/used|refurb|renew|collectible|open[\s-]?box|pre[\s-]?owned|other|unknown/i.test(s)) return false;
  return s === 'new' || s.startsWith('new');
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
// Extract a 10-char ASIN from a curated Amazon product URL (/dp/<ASIN>, /gp/product/<ASIN>,
// ?ASIN=...). Used as the PRECISE lookup before falling back to keyword search, mirroring
// the direct-URL-first contract of the browser adapters.
function asinFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i)
    || s.match(/[?&]asin=([A-Z0-9]{10})\b/i);
  return m ? m[1].toUpperCase() : null;
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
    if (hasBuyingRestriction(o) || !isNewCondition(o)) continue; // can't buy / not new
    if (priceOf(o)) { chosen = o; break; }
  }
  // No buyable+new offer: fall back to a product-level price ONLY when the product
  // carries NO offers at all AND isn't itself restricted/non-new — otherwise we'd surface
  // something the account can't buy (or a used price) as a savings opportunity.
  if (!chosen) {
    if (offers.length) return null;
    if (hasBuyingRestriction(product) || !isNewCondition(product)) return null;
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

// ISO 8601 basic UTC timestamp (e.g. 20260624T060000Z) for the required x-amz-date header.
function amzDate(deps = {}) {
  const now = deps.now ? new Date(deps.now()) : new Date();
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
// Headers for Amazon Business API calls (NOT the LWA token exchange). Per the request-header
// docs: x-amz-access-token is THE auth header (no Authorization — the docs don't use one and
// an unexpected Authorization can 401), plus the required x-amz-date and a user-agent.
// x-amz-user-email is required by the Product Search API specifically.
function businessHeaders(token, deps = {}) {
  return {
    'x-amz-access-token': token,
    'x-amz-date': amzDate(deps),
    'x-amz-user-email': creds().userEmail,
    'user-agent': USER_AGENT,
    Accept: 'application/json',
  };
}
// Shared query params for product calls (region/locale/facets/ship-to are REQUIRED or
// strongly-recommended on both the keyword search and the by-ASIN retrieval).
function baseProductQuery(extra = {}) {
  const qs = new URLSearchParams({ productRegion: PRODUCT_REGION, locale: LOCALE, facets: FACETS, ...extra });
  if (SHIPPING_POSTAL_CODE) qs.set('shippingPostalCode', SHIPPING_POSTAL_CODE);
  return qs;
}

// GET the keyword search, returning parsed JSON. Throttled to the usage plan. Throws on a
// non-OK response so the scanner records a retryable fetch_error (never logs the body —
// it can carry the account email).
async function searchProducts(keywords, deps = {}) {
  const token = await getAccessToken(deps);
  const url = `${API_HOST}/products/${API_VERSION}/products?${baseProductQuery({ keywords }).toString()}`;
  await throttle(deps);
  const res = await timedFetch(url, { method: 'GET', headers: businessHeaders(token, deps) }, deps);
  if (!res.ok) throw new Error(`amazon products ${res.status}`);
  return res.json();
}

// EXACT retrieval of one product by ASIN (the precise lookup for a curated vendor URL).
// Throws on a non-OK response (retryable fetch_error); a 404 means the ASIN isn't found.
async function getProductByAsin(asin, deps = {}) {
  const token = await getAccessToken(deps);
  const url = `${API_HOST}/products/${API_VERSION}/products/${encodeURIComponent(asin)}?${baseProductQuery().toString()}`;
  await throttle(deps);
  const res = await timedFetch(url, { method: 'GET', headers: businessHeaders(token, deps) }, deps);
  if (res.status === 404) return null; // ASIN not found -> caller falls back to keyword search
  if (!res.ok) throw new Error(`amazon product ${res.status}`);
  return res.json();
}

// Resolve the candidate product list: a curated ASIN (from the vendor's approved product
// URL) via the EXACT by-ASIN endpoint first, then keyword search — either as the fallback
// when there's no curated URL, or after an exact-ASIN miss.
async function resolveProducts(vendor, product, deps = {}) {
  const asin = asinFromUrl(vendor && vendor.url);
  if (asin) {
    const j = await getProductByAsin(asin, deps);
    let arr = productsFromResponse(j);
    if (!arr.length && j && (j.asin || j.title || j.includedDataTypes)) arr = [j]; // single-product response
    if (arr.length) return arr;
  }
  const q = searchQuery(product);
  if (!q) return [];
  return productsFromResponse(await searchProducts(q, deps));
}

// Search Amazon Business for `product` and return the best verified business-priced
// offer (or null). Mirrors the search-then-verify-each flow of the browser adapters:
// prefer an EPA-confirmed buyable match, then a buyable name+size match, then a
// verified-but-unbuyable one, then the best priced page as a precise 'unverified' skip.
async function fetchCandidate(page, vendor, product, opts = {}) {
  if (!isConfigured()) return null; // belt-and-suspenders; scrapableVendors also gates this
  const deps = opts.amazonDeps || {};

  const targetOz = product.packSizeValue != null && product.packSizeUnit
    ? convertToOz(product.packSizeValue, product.packSizeUnit)
    : quantityToOz(product.quantity);

  let products;
  try {
    products = await resolveProducts(vendor, product, deps); // by-ASIN (curated URL) then keyword
  } catch (err) {
    // Token/HTTP failure — surface as a retryable fetch_error, not a clean miss.
    logger.warn(`[price-scan] amazon lookup failed: ${err.message}`);
    throw err;
  }
  if (!products.length) return null;
  products = products.slice(0, MAX_CANDIDATES);
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
  getProductByAsin,
  resolveProducts,
  asinFromUrl,
  candidateFromProduct,
  priceOf,
  titleOf,
  productsFromResponse,
  offersOf,
  hasBuyingRestriction,
  availabilityOf,
  resetState,
};
