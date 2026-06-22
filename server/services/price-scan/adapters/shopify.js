// Generic Shopify storefront adapter — serves ANY Shopify store (Chemical Warehouse, Seed
// World USA, SeedBarn, GCI Turf Academy, Intermountain Turf, ...). The store's base URL comes
// from vendor.website, so one adapter covers them all.
//
// Shopify exposes a clean JSON endpoint per product — /products/<handle>.js — listing every
// variant's size (variant.title), price (in cents), and stock (available). That's more
// reliable than scraping the DOM, so this adapter searches (/search?q=), picks the best
// product link, then reads .js and size-matches via the shared pickVariantOffer.
const { searchQuery, selectSearchCandidates } = require('./base');
const { pickVariantOffer, extractSizeToken, quantityToOz } = require('../extract');
const { convertToOz } = require('../../product-costing');

const DEFAULT_TIMEOUT = 20000;
const MAX_CANDIDATES = 4;

// The storefront base origin for this vendor (e.g. https://chemicalwarehouse.com).
function baseOrigin(vendor) {
  const src = vendor.website || vendor.url || '';
  try { return new URL(src).origin; } catch (e) { return null; }
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
    await page.goto(`${origin}/search?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('a[href*="/products/"]', { timeout: 8000 }).catch(() => {});
    const found = await page.$$eval('a[href*="/products/"]', (els) => [...new Set(els.map((e) => e.getAttribute('href')).filter(Boolean))]);
    links = selectSearchCandidates(found, product, MAX_CANDIDATES);
  }

  let fallback = null;
  for (const link of links) {
    const handle = handleOf(link);
    if (!handle) continue;
    let data;
    try { data = await fetchProductJs(page, origin, handle, timeout); } catch (e) { continue; }
    if (!data) continue;
    const offer = targetOz ? pickVariantOffer(variantsFromShopify(data), { targetOz }) : null;
    const productUrl = `${origin}/products/${handle}`;
    if (offer) {
      return {
        price: offer.price,
        currency: 'USD',
        availability: offer.availability,
        name: data.title || null,
        quantity: offer.quantity,
        source_url: productUrl,
        competing_same_size: !!offer.competingSameSize,
        price_type: 'public',
        vendor_id: vendor.vendor_id || vendor.id,
        vendor: vendor.name || vendor.vendor_id || vendor.id,
      };
    }
    // Remember a priced product page even if no size matched, for a precise 'unverified' skip.
    if (!fallback && data.variants && data.variants.length) {
      fallback = {
        price: Number(data.variants[0].price) / 100,
        currency: 'USD',
        availability: data.variants[0].available === false ? 'out_of_stock' : 'unknown',
        name: data.title || null,
        quantity: extractSizeToken(data.title) || null,
        source_url: productUrl,
        price_type: 'public',
        vendor_id: vendor.vendor_id || vendor.id,
        vendor: vendor.name || vendor.vendor_id || vendor.id,
      };
    }
  }
  return fallback;
}

module.exports = {
  key: 'shopify',
  config: { key: 'shopify', priceType: 'public' },
  fetchCandidate,
  // exposed for unit tests
  variantsFromShopify,
  handleOf,
  baseOrigin,
};
