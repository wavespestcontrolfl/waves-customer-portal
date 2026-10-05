/* global document */ // page.evaluate callbacks below run in the browser, not Node
// Generic Shopify storefront adapter — serves ANY Shopify store (Chemical Warehouse, Seed
// World USA, SeedBarn, GCI Turf Academy, Intermountain Turf, Golf Course Lawn Store, Gemplers). The store's base URL comes
// from vendor.website, so one adapter covers them all.
//
// Shopify exposes a clean JSON endpoint per product — /products/<handle>.js — listing every
// variant's size (variant.title), price (in cents), and stock (available). That's more
// reliable than scraping the DOM, so this adapter searches (/search?q=), picks the best
// product link, then reads .js and size-matches via the shared pickVariantOffer.
const { searchQuery, selectSearchCandidates, targetOzOf } = require('./base');
const { pickVariantOffer, extractSizeToken, verifyMatch } = require('../extract');
const { isUnavailable } = require('../compare');
// Approved storefront hosts — the weekly scan navigates the server browser to this origin,
// so the adapter MUST anchor the actual hostname to the allowlist before navigating. Shared
// with the registry (the vendor-routing layer) so the two allowlists can't drift.
const { isApprovedShopifyHost } = require('./shopify-hosts');

const DEFAULT_TIMEOUT = 20000;
const MAX_CANDIDATES = 4;

// The storefront base origin for this vendor (e.g. https://chemicalwarehouse.com). Accepts a
// bare host (operator-editable website may omit the scheme) by assuming https. Returns null —
// FAIL CLOSED — unless the parsed hostname is on the approved allowlist, so a tampered URL
// can never point the scan's browser at an arbitrary host.
function baseOrigin(vendor) {
  const src = String((vendor && (vendor.website || vendor.url)) || '').trim();
  if (!src) return null;
  let u = null;
  try { u = new URL(src); } catch (e) { /* maybe a scheme-less host */ }
  if (!u) { try { u = new URL(`https://${src}`); } catch (e) { return null; } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isApprovedShopifyHost(u.hostname)) return null;
  return u.origin;
}

// Pull the product handle out of a /products/<handle> URL (absolute or relative).
function handleOf(href) {
  const m = String(href || '').split('?')[0].match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Read /products/<handle>.js (Shopify product JSON) via the page.
async function fetchProductJs(page, origin, handle, timeout) {
  await page.goto(`${origin}/products/${handle}.js`, { waitUntil: 'domcontentloaded', timeout });
  const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
  try { return JSON.parse(txt); } catch (e) { return null; }
}

// PURE: the pack size for one variant, or null when none is STATED (never guessed). Only
// explicit size text or metadata counts, in order: the variant title, the product title, the
// variant's option values, a labelled size in the tags ("Spec:Size:17 oz.") or body ("Size:
// 10 oz"). A shipping weight (variant grams) is NOT a pack size — it includes packaging and
// says nothing about fluid vs weight ounces — so a product with no stated size stays unmatched.
function packSizeOfVariant(data, v) {
  if (extractSizeToken(v.title)) return v.title;
  if (extractSizeToken(data.title)) return data.title;
  const opts = [v.option1, v.option2, v.option3].filter((o) => o && !/default title/i.test(o));
  const opt = opts.find((o) => extractSizeToken(o));
  if (opt) return opt;
  const tags = Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',');
  const tagSize = tags.map((t) => String(t).match(/\bsize\s*:\s*(.+)$/i)).find((m) => m && extractSizeToken(m[1]));
  if (tagSize) return tagSize[1];
  const text = String(data.description || data.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const labelled = text.match(/\b(?:size|net\s*(?:wt|weight)|package\s*size|pack\s*size|contents?)\s*[:\-]\s*([^.;|]{1,40})/i);
  if (labelled && extractSizeToken(labelled[1])) return labelled[1];
  return null;
}

// One product's variants -> the {size, price, availabilityRaw} shape pickVariantOffer wants.
// Shopify price is in cents. A variant whose title isn't a size (e.g. "Default Title" on a
// single-variant product) borrows the product title, then option/tag/body (see
// packSizeOfVariant). With no stated size it keeps the title text, which cannot size-match,
// so pickVariantOffer returns null rather than guessing.
function variantsFromShopify(data) {
  if (!data || !Array.isArray(data.variants)) return [];
  return data.variants.map((v) => ({
    size: packSizeOfVariant(data, v) || data.title || v.title,
    price: Number(v.price) / 100,
    availabilityRaw: v.available === false ? 'OutOfStock' : (v.available === true ? 'InStock' : null),
    id: v.id != null ? v.id : null, // Shopify variant id -> variant-specific proof URL
  }));
}

// PURE: product handles from Shopify's Predictive Search JSON (/search/suggest.json), in
// rank order. Needed for storefronts whose /search page is painted client-side by a search
// app (Gemplers: Boost/Searchspring leave empty skeleton cards in the server HTML), where
// the DOM has no product links at domcontentloaded. Returns [] for anything unexpected.
function handlesFromSuggest(json) {
  const list = json && json.resources && json.resources.results && json.resources.results.products;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((p) => (p && (p.handle || handleOf(p.url))) || null).filter(Boolean))];
}

// PURE: does the listing carry a SPECIAL-FREIGHT tag? Gemplers tags every product with
// true/false shipping flags ("shipping_hazardous_T", "shipping_full_haz_F", "shipping_oversize_T",
// "shipping_oversize2_T", "shipping_truck_T"): a `_T` value means the vendor charges extra it
// does not publish (hazardous, oversize, truck/LTL freight), so shipping-rules prices the item
// as an estimate. Any tag naming hazard/hazmat/DOT/oversize/truck/freight/LTL counts unless it
// ends `_F` / `_false`, so an unfamiliar tag of that kind fails safe (-> estimate).
const SPECIAL_FREIGHT_TAG = /haz(?:ard|mat)?|\bdot\b|oversiz|truck|freight|\bltl\b/i;
function specialFreightFromShopify(data) {
  if (!data) return false;
  const tags = Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',');
  return tags.some((t) => {
    const tag = String(t).trim();
    return SPECIAL_FREIGHT_TAG.test(tag) && !/_f(alse)?$/i.test(tag);
  });
}

// PURE: is the item restricted from sale in Florida? Vendors tag state restrictions as
// "RESTR:AK" / "RESTR:AK,FL,HI" (one tag per state or a comma list). Case-insensitive, any
// RESTR: list containing the FL token. We ship to Lakewood Ranch, FL, so such an item is not
// buyable for us and must never be ranked as a price to match.
function restrictedInFlorida(data) {
  if (!data) return false;
  const tags = Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',');
  return tags.some((t) => {
    const m = String(t).trim().match(/^restr\s*:\s*(.+)$/i);
    return !!m && m[1].split(/[\s,;/|]+/).some((st) => st.toUpperCase() === 'FL');
  });
}

// ORDERED sources of product links for a search term; the first that returns any wins.
// Shopify's /search?q= page is SERVER-RENDERED for most themes — the result links are in the
// HTML at domcontentloaded — so we must NOT waitForSelector: a vendor that doesn't carry the
// product would otherwise burn the full timeout per product, and the serial weekly scan
// (25-product batches) turns that into minutes. A real no-match returns [] instantly.
// Client-rendered search pages (Gemplers) have no product links in the DOM yet, so the
// theme-independent predictive-search JSON is the second source.
const LINK_SOURCES = [
  (page) => page.$$eval('a[href*="/products/"]', (els) => [...new Set(els.map((e) => e.getAttribute('href')).filter(Boolean))]),
  async (page, origin, q, timeout) => {
    const res = await page.goto(`${origin}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`, { waitUntil: 'domcontentloaded', timeout });
    if (res && typeof res.status === 'function' && res.status() >= 400) throw new Error(`suggest.json HTTP ${res.status()}`);
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return handlesFromSuggest(JSON.parse(txt)).map((h) => `/products/${h}`);
  },
];

async function findProductLinks(page, origin, q, timeout) {
  await page.goto(`${origin}/search?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout });
  // A source that FAILS (timeout, HTTP error, bad JSON) is not "no results": if nothing found
  // links, the last source error is thrown so the scan records fetch_error (retry), and only a
  // search that worked and found zero products returns [] (-> no_candidate).
  let lastError = null;
  for (const source of LINK_SOURCES) {
    try {
      const found = await source(page, origin, q, timeout);
      if (found.length) return found;
    } catch (e) { lastError = e; }
  }
  if (lastError) throw lastError;
  return [];
}

const descriptionText = (data) => String(data.description || data.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || null;

// The scan candidate for a size-matched offer. weight_lb is the PRICED variant's real listing
// weight (grams -> lb), the only weight a weight-table vendor may treat as firm.
function buildCandidate(data, offer, proofUrl, ctx) {
  const variant = (data.variants || []).find((v) => v.id === offer.variantId);
  const grams = Number(variant && variant.weight);
  return {
    price: offer.price, currency: 'USD',
    availability: restrictedInFlorida(data) ? 'restricted' : offer.availability, // 'restricted' is unbuyable (compare.UNAVAILABLE)
    name: data.title || null, quantity: offer.quantity, source_url: proofUrl,
    // The description as text, so a body EPA reg can corroborate the match (distinguishing
    // same-brand siblings, e.g. Bifen I/T vs Bifen XTS).
    text: descriptionText(data),
    competing_same_size: !!offer.competingSameSize, price_type: 'public', vendor_id: ctx.vid, vendor: ctx.vname,
    special_freight: specialFreightFromShopify(data), // hazardous/oversize/truck tag: priced as an estimate
    weight_lb: grams > 0 ? grams / 453.592 : null,
  };
}

// A priced page with no size-matched variant: the first variant as an unverified fallback
// (-> a precise 'unverified' skip), or null when the product lists no variants.
function fallbackCandidate(data, productUrl, ctx) {
  const first = data.variants && data.variants[0];
  if (!first) return null;
  return {
    price: Number(first.price) / 100, currency: 'USD',
    availability: first.available === false ? 'out_of_stock' : 'unknown',
    name: data.title || null, quantity: extractSizeToken(data.title) || null,
    source_url: productUrl, price_type: 'public', vendor_id: ctx.vid, vendor: ctx.vname,
  };
}

// Tier of a size-matched candidate: 0 = failed verification, 1 = verified but unbuyable,
// 2 = buyable name+size match lacking EPA confirmation, 3 = EPA-confirmed (or no EPA needed)
// and buyable. A same-brand sibling that only passes name+size must not win when the product
// has an EPA reg an EPA-confirmed candidate could match later.
function verifyTier(cand, product) {
  const verdict = verifyMatch({ name: cand.name, text: cand.text, quantity: cand.quantity, competingOffers: cand.competing_same_size }, product);
  if (!verdict.matched) return 0;
  if (isUnavailable(cand)) return 1;
  return (!product.epaReg || verdict.signals.epa) ? 3 : 2;
}

const vendorIds = (vendor) => ({ vid: vendor.vendor_id || vendor.id, vname: vendor.name || vendor.vendor_id || vendor.id });

// Proof link points at the PRICED variant, not the page default — on a multi-variant product
// the matched size is often not the default, so the review queue must open the exact variant
// the price/availability came from.
const proofUrlOf = (productUrl, offer) => (offer.variantId != null ? `${productUrl}?variant=${offer.variantId}` : productUrl);

async function fetchCandidate(page, vendor, product) {
  const timeout = DEFAULT_TIMEOUT;
  const origin = baseOrigin(vendor);
  if (!origin) return null;
  const targetOz = targetOzOf(product);
  const q = searchQuery(product);
  if (!vendor.url && !q) return null;

  // Candidate product URLs: an explicit direct URL, else search by name.
  const links = vendor.url ? [vendor.url]
    : selectSearchCandidates(await findProductLinks(page, origin, q, timeout), product, MAX_CANDIDATES);

  const ctx = vendorIds(vendor);
  // Search is fuzzy/relevance-ranked, so open the top candidates and VERIFY each (name/EPA/
  // size) before trusting it — a wrong same-size SIBLING ranked first must not block the real
  // match. Prefer tier 3 (returned at once), then a buyable name+size match, then a verified-
  // but-unbuyable one, then the best priced+size-matched page (a precise 'unverified' skip).
  const picks = {};
  let fallback = null;
  let candidateError = null; // a per-candidate fetch failure, surfaced only if nothing verifies
  for (const link of links) {
    const handle = handleOf(link);
    let data = null;
    try { data = handle ? await fetchProductJs(page, origin, handle, timeout) : null; } catch (e) { candidateError = e; }
    if (!data) continue;
    const productUrl = `${origin}/products/${handle}`;
    const offer = targetOz ? pickVariantOffer(variantsFromShopify(data), { targetOz }) : null;
    if (!offer) { fallback = fallback || fallbackCandidate(data, productUrl, ctx); continue; }
    const cand = buildCandidate(data, offer, proofUrlOf(productUrl, offer), ctx);
    const tier = verifyTier(cand, product);
    if (tier === 3) return cand;
    if (tier && !picks[tier]) picks[tier] = cand;
    fallback = fallback || cand; // priced + size-matched, unverified -> precise 'unverified' skip
  }
  // If NOTHING verified and a candidate's .js fetch threw, surface that error as a precise
  // 'fetch_error': the scan was INCOMPLETE (the candidate that errored might have been the
  // real match), so a priced-but-unverified fallback must not report a clean 'unverified'.
  // Only a verified match suppresses the error.
  const verified = picks[2] || picks[1];
  if (!verified && candidateError) throw candidateError;
  return verified || fallback;
}

module.exports = {
  key: 'shopify',
  config: { key: 'shopify', priceType: 'public' },
  fetchCandidate,
  // exposed for unit tests
  variantsFromShopify,
  handlesFromSuggest,
  specialFreightFromShopify,
  restrictedInFlorida,
  handleOf,
  baseOrigin,
  isApprovedShopifyHost,
};
