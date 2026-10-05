/* global document */ // page.evaluate callbacks below run in the browser, not Node
// Generic Shopify storefront adapter — serves ANY Shopify store (Chemical Warehouse, Seed
// World USA, SeedBarn, GCI Turf Academy, Intermountain Turf, Golf Course Lawn Store, Gemplers). The store's base URL comes
// from vendor.website, so one adapter covers them all.
//
// Shopify exposes a clean JSON endpoint per product — /products/<handle>.js — listing every
// variant's size (variant.title), price (in cents), and stock (available). That's more
// reliable than scraping the DOM, so this adapter searches (/search?q=), picks the best
// product link, then reads .js and size-matches via the shared pickVariantOffer.
const { searchQuery, selectSearchCandidates } = require('./base');
const { pickVariantOffer, extractSizeToken, quantityToOz, verifyMatch } = require('../extract');
const { isUnavailable } = require('../compare');
const { convertToOz } = require('../../product-costing');
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

// PURE: a clean pack-size string from a Shopify variant's grams (the .js endpoint reports
// variant.weight in grams), or null. Only a CLEAN weight counts — a whole/quarter pound or a
// whole/quarter ounce within 0.5% — because a shipping weight with packaging in it (a 9.4 lb
// "gallon") is not a pack size and must never be guessed into one.
function sizeFromWeightGrams(grams) {
  const g = Number(grams);
  if (!Number.isFinite(g) || g < 28) return null;
  const clean = (n, step) => {
    const r = Math.round(n / step) * step;
    return r > 0 && Math.abs(n - r) / r <= 0.005 ? r : null;
  };
  const lb = clean(g / 453.592, 0.25);
  if (lb != null && lb >= 1) return `${lb} lb`;
  if (g >= 453.592) return null; // a pound or more that is not a clean pound count: not a pack
  const oz = clean(g / 28.3495, 0.25);
  return oz != null ? `${oz} oz` : null;
}

// PURE: the pack size for one variant, or null when none can be derived (never guessed).
// Order: the variant title, the product title, the variant's option values, a labelled size in
// the tags ("Spec:Size:17 oz.") or body ("Size: 10 oz"), then the variant's clean weight.
// "Default Title" products with no size anywhere but a weight (Golf Course Lawn Store sells
// 25 lb bags this way) therefore still size-match.
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
  return sizeFromWeightGrams(v.weight);
}

// One product's variants -> the {size, price, availabilityRaw} shape pickVariantOffer wants.
// Shopify price is in cents. A variant whose title isn't a size (e.g. "Default Title" on a
// single-variant product) borrows the product title, then option/tag/body/weight (see
// packSizeOfVariant). With no derivable size it keeps the title text, which cannot size-match,
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

// Words that turn "free shipping" into a CONDITIONAL offer (a spend threshold or qualifier).
const FREE_SHIP_CONDITION = /\b(?:over|above|orders?\s+of|minimum|min\.?|qualif\w*|spend\w*|exceed\w*|at\s+least|when|if|only|select(?:ed)?|certain|excluding|except\w*)\b|\$\s*\d/i;

// PURE: does the product state "free shipping" for THIS item, unconditionally? A positive tag
// (never an `_F` false-valued tag like the vendor's `shipping_*_F` flags) or a description
// sentence saying FREE SHIPPING. ANY threshold/condition phrase in the same sentence ("free
// shipping is available on orders over $99", "applies to orders above $149", "when you spend")
// makes it conditional -> false, and one conditional sentence anywhere vetoes the flag. The
// flag zeroes freight, so doubt means false. shipping-rules acts on it for flagged-free vendors.
function freeShippingFromShopify(data) {
  if (!data) return false;
  const tags = Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',');
  const tagFree = tags.some((t) => {
    const tag = String(t).trim();
    return /free[\s_-]*shipping/i.test(tag) && !/_f(alse)?$/i.test(tag) && !FREE_SHIP_CONDITION.test(tag);
  });
  const text = String(data.description || data.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => /free\s+shipping/i.test(x));
  if (sentences.some((x) => FREE_SHIP_CONDITION.test(x))) return false;
  return tagFree || sentences.length > 0;
}

// PURE: is the item flagged hazardous / DOT for shipping? Vendors tag it ("shipping_hazardous_T",
// "shipping_full_haz_T"); a `_F` value means NOT hazardous. Used for vendors whose hazmat
// shipping is an unpublished extra (Gemplers), so their figure is labelled an estimate.
function hazmatFromShopify(data) {
  if (!data) return false;
  const tags = Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',');
  return tags.some((t) => {
    const tag = String(t).trim();
    return /haz(?:ard|mat)?|\bdot\b/i.test(tag) && !/_f(alse)?$/i.test(tag);
  });
}

async function fetchCandidate(page, vendor, product) {
  const timeout = DEFAULT_TIMEOUT;
  const origin = baseOrigin(vendor);
  if (!origin) return null;
  const targetOz = product.packSizeValue != null && product.packSizeUnit
    ? convertToOz(product.packSizeValue, product.packSizeUnit)
    : quantityToOz(product.quantity);

  // Resolve candidate product URLs: an explicit direct URL, else search by name.
  let links;
  if (vendor.url) {
    links = [vendor.url];
  } else {
    const q = searchQuery(product);
    if (!q) return null;
    // Shopify's /search?q= page is SERVER-RENDERED — the result links are in the HTML at
    // domcontentloaded — so we must NOT waitForSelector here: a vendor that doesn't carry
    // the product would otherwise burn the full timeout per product, and the serial weekly
    // scan (25-product batches) turns that into minutes. Read links straight from the DOM;
    // a real no-match returns [] instantly. (Mirrors base.js's no-block-for-server-rendered.)
    await page.goto(`${origin}/search?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout });
    let found = await page.$$eval('a[href*="/products/"]', (els) => [...new Set(els.map((e) => e.getAttribute('href')).filter(Boolean))]).catch(() => []);
    // Client-rendered search pages (Gemplers) have no product links in the DOM yet; fall back
    // to Shopify's predictive-search JSON endpoint, which is theme-independent.
    if (!found.length) {
      try {
        await page.goto(`${origin}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`, { waitUntil: 'domcontentloaded', timeout });
        const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        found = handlesFromSuggest(JSON.parse(txt)).map((h) => `/products/${h}`);
      } catch (e) { found = []; }
    }
    links = selectSearchCandidates(found, product, MAX_CANDIDATES);
  }

  const vid = vendor.vendor_id || vendor.id;
  const vname = vendor.name || vendor.vendor_id || vendor.id;
  const wantsEpa = !!(product && product.epaReg);
  // Search is fuzzy/relevance-ranked, so open the top candidates and VERIFY each (name/EPA/
  // size) before trusting it — a wrong same-size SIBLING ranked first must not block the real
  // match. Prefer EPA-confirmed + buyable; then a buyable name+size match; then a verified-
  // but-unbuyable; then the best priced+size-matched page (a precise 'unverified' skip).
  let firstBuyable = null;
  let firstUnbuyable = null;
  let fallback = null;
  let candidateError = null; // a per-candidate fetch failure, surfaced only if nothing verifies
  for (const link of links) {
    const handle = handleOf(link);
    if (!handle) continue;
    let data;
    try { data = await fetchProductJs(page, origin, handle, timeout); } catch (e) { candidateError = e; continue; }
    if (!data) continue;
    const offer = targetOz ? pickVariantOffer(variantsFromShopify(data), { targetOz }) : null;
    const productUrl = `${origin}/products/${handle}`;
    // Proof link points at the PRICED variant, not the page default — on a multi-variant
    // product the matched size is often not the default, so the review queue must open the
    // exact variant the price/availability came from. Falls back to the bare product URL.
    const proofUrl = offer && offer.variantId != null ? `${productUrl}?variant=${offer.variantId}` : productUrl;
    if (!offer) {
      if (!fallback && data.variants && data.variants.length) {
        fallback = {
          price: Number(data.variants[0].price) / 100, currency: 'USD',
          availability: data.variants[0].available === false ? 'out_of_stock' : 'unknown',
          name: data.title || null, quantity: extractSizeToken(data.title) || null,
          source_url: productUrl, price_type: 'public', vendor_id: vid, vendor: vname,
        };
      }
      continue;
    }
    // Strip the product description to text so a body EPA reg can corroborate the match
    // (distinguishing same-brand siblings, e.g. Bifen I/T vs Bifen XTS).
    const bodyText = String(data.description || data.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || null;
    const cand = {
      price: offer.price, currency: 'USD', availability: offer.availability,
      name: data.title || null, quantity: offer.quantity, source_url: proofUrl, text: bodyText,
      competing_same_size: !!offer.competingSameSize, price_type: 'public', vendor_id: vid, vendor: vname,
      free_shipping: freeShippingFromShopify(data), // per-item "ships free" flag (flagged-free vendors only)
      hazmat_shipping: hazmatFromShopify(data), // hazardous/DOT item: hazmat-extra vendors price it as an estimate
    };
    const verdict = verifyMatch({ name: cand.name, text: bodyText, quantity: cand.quantity, competingOffers: cand.competing_same_size }, product);
    if (verdict.matched) {
      const buyable = !isUnavailable(cand);
      // EPA-confirmed + buyable is ideal; a same-brand sibling that only passes name+size must
      // not win when the product has an EPA reg an EPA-confirmed candidate could match later.
      if ((!wantsEpa || verdict.signals.epa) && buyable) return cand;
      if (buyable) { if (!firstBuyable) firstBuyable = cand; }
      else if (!firstUnbuyable) firstUnbuyable = cand;
    }
    if (!fallback) fallback = cand; // priced + size-matched, unverified -> precise 'unverified' skip
  }
  // If NOTHING verified and a candidate's .js fetch threw, surface that error as a
  // precise 'fetch_error': the scan was INCOMPLETE (the candidate that errored might
  // have been the real match), so a priced-but-unverified fallback must not report a
  // clean 'unverified' (which reads as "found it, no match here, don't retry") when the
  // truth is "a fetch failed, retry". Only a verified match suppresses the error.
  const verified = firstBuyable || firstUnbuyable;
  if (!verified && candidateError) throw candidateError;
  return verified || fallback;
}

module.exports = {
  key: 'shopify',
  config: { key: 'shopify', priceType: 'public' },
  fetchCandidate,
  // exposed for unit tests
  variantsFromShopify,
  sizeFromWeightGrams,
  handlesFromSuggest,
  freeShippingFromShopify,
  hazmatFromShopify,
  handleOf,
  baseOrigin,
  isApprovedShopifyHost,
};
