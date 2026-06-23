// Generic Shopify storefront adapter — serves ANY Shopify store (Chemical Warehouse, Seed
// World USA, SeedBarn, GCI Turf Academy, Intermountain Turf, ...). The store's base URL comes
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

// One product's variants -> the {size, price, availabilityRaw} shape pickVariantOffer wants.
// Shopify price is in cents. A variant whose title isn't a size (e.g. "Default Title" on a
// single-variant product) borrows the product title, which carries the size for those.
function variantsFromShopify(data) {
  if (!data || !Array.isArray(data.variants)) return [];
  return data.variants.map((v) => ({
    size: extractSizeToken(v.title) ? v.title : (data.title || v.title),
    price: Number(v.price) / 100,
    availabilityRaw: v.available === false ? 'OutOfStock' : (v.available === true ? 'InStock' : null),
  }));
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
    const found = await page.$$eval('a[href*="/products/"]', (els) => [...new Set(els.map((e) => e.getAttribute('href')).filter(Boolean))]).catch(() => []);
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
      name: data.title || null, quantity: offer.quantity, source_url: productUrl, text: bodyText,
      competing_same_size: !!offer.competingSameSize, price_type: 'public', vendor_id: vid, vendor: vname,
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
  handleOf,
  baseOrigin,
  isApprovedShopifyHost,
};
