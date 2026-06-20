// Base vendor adapter. A concrete adapter is just a config object (search-URL
// builder + CSS selectors); makeAdapter wraps it with the shared Playwright flow:
//
//   resolve product URL (explicit vendor.url, else search -> first result)
//     -> goto product page
//     -> scrape a snapshot (JSON-LD blocks + DOM price/title/availability/body)
//     -> hand the snapshot to the PURE extract.js parsers
//     -> return a candidate { price, currency, availability, name, quantity,
//                             source_url, text }
//
// All the messy parsing is in extract.js (unit-tested); this file is the thin
// browser I/O around it, exercised by the live proof rather than unit tests.

const {
  offerFromSnapshot,
  extractSizeToken,
  mapAvailability,
  quantityToOz,
} = require('../extract');
const { convertToOz } = require('../../product-costing');

// The oz-equivalent of the product we're scanning for, so the JSON-LD parser can
// pick the matching variant offer on a multi-size page. packSizeValue/Unit are
// STRUCTURED fields — convert them directly (canonical units like "fl_oz" don't
// survive being formatted into free text for quantityToOz). Mirrors verifyMatch.
function targetOzOf(product) {
  if (product.packSizeValue != null && product.packSizeUnit) {
    return convertToOz(product.packSizeValue, product.packSizeUnit);
  }
  return quantityToOz(product.quantity);
}

const DEFAULT_TIMEOUT = 20000;

// The keyword string a vendor search box gets. Prefer the vendor-facing product
// name, fall back to our canonical name.
function searchQuery(product) {
  return String(
    (product && (product.searchQuery || product.vendorProductName || product.productName || product.name)) || '',
  ).trim();
}

// Attributes that hold a value WITHOUT a text node: schema.org microdata
// (content/href/value) AND storefront price data-attributes — Magento exposes the
// amount as `data-price-amount`, BigCommerce (Keystone) as
// `data-product-price-without-tax`, and the generic adapter selects bare
// `[data-price]`. Those price elements are often empty `<span data-price="89.99">`,
// so a text-only read returns nothing and the DOM fallback silently drops an
// otherwise valid candidate. Read the attributes in this order, then text.
const VALUE_ATTRS = ['content', 'href', 'value', 'data-price', 'data-price-amount', 'data-product-price-without-tax'];

// Read an element's value preferring the attributes above over textContent.
// Pure + node-testable; collectSnapshot inlines the same rule for the browser
// context. `el` is anything with getAttribute / textContent.
function nodeValue(el) {
  if (!el) return '';
  if (el.getAttribute) {
    for (const a of VALUE_ATTRS) {
      const v = el.getAttribute(a);
      if (v) return String(v).trim();
    }
  }
  return el.textContent ? String(el.textContent).trim() : '';
}

// Runs IN THE BROWSER (page.evaluate). Must be self-contained — it only sees the
// `sel` argument, never Node scope. Collects every signal the parsers might use.
function collectSnapshot(sel) {
  // Prefer value-bearing attributes before textContent: schema.org microdata
  // (<meta content="...">, <link itemprop="availability" href=".../OutOfStock">)
  // AND storefront price data-attributes (Magento data-price-amount, BigCommerce
  // data-product-price-without-tax, bare data-price) are empty of text, so a
  // text-only read would miss a price or sold-out signal entirely. (Inlined —
  // collectSnapshot runs in page.evaluate and can't call the Node-side helper;
  // the attribute list MUST stay in sync with nodeValue()'s VALUE_ATTRS, which is
  // what the unit test covers.)
  const VALUE_ATTRS = ['content', 'href', 'value', 'data-price', 'data-price-amount', 'data-product-price-without-tax'];
  const textOf = (el) => {
    if (!el) return '';
    if (el.getAttribute) {
      for (const a of VALUE_ATTRS) {
        const v = el.getAttribute(a);
        if (v) return String(v).trim();
      }
    }
    return el.textContent ? el.textContent.trim() : '';
  };
  const allText = (selectors) => (selectors || [])
    .flatMap((s) => Array.from(document.querySelectorAll(s)))
    .map((el) => textOf(el))
    .filter(Boolean);

  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => s.textContent || '')
    .filter(Boolean);

  const title = textOf(document.querySelector(sel.titleSelector || 'h1'))
    || (document.title || '').trim();

  const priceTexts = allText(sel.priceSelectors && sel.priceSelectors.length
    ? sel.priceSelectors
    : ['[itemprop="price"]', '.price', '.product-price', '.our-price']);

  // Collect ALL availability-selector matches, not just the first — a grouped
  // selector (Keystone's includes a generic BigCommerce field used for SKU/brand
  // rows before the stock row) would otherwise miss an out-of-stock signal.
  // Joined with a separator so mapAvailability's out-of-stock/backorder precedence
  // catches "Out of Stock" wherever it appears, without forming a false phrase
  // across element boundaries.
  const availabilityText = sel.availabilitySelector
    ? allText([sel.availabilitySelector]).join(' | ')
    : '';

  // A bounded slice of body text so extract.js can hunt for an EPA reg number
  // without serializing the entire page back to Node.
  const body = (document.body && document.body.innerText) || '';

  return { jsonLd, title, priceTexts, availabilityText, bodyText: body.slice(0, 4000) };
}

// Find the first product link on a search-results page. Returns an absolute URL
// or null. Runs the selector in the browser, resolves relative hrefs via the
// page's own location.
async function firstProductLink(page, config) {
  const sels = config.productLinkSelectors && config.productLinkSelectors.length
    ? config.productLinkSelectors
    : ['a.product-link', '.product-item a', '.product a'];
  return page.evaluate((selectors) => {
    for (const s of selectors) {
      const a = document.querySelector(s);
      if (a && a.href) return a.href;
    }
    return null;
  }, sels);
}

function makeAdapter(config) {
  const timeout = config.timeout || DEFAULT_TIMEOUT;

  async function fetchCandidate(page, vendor, product) {
    // 1. Resolve the product page URL.
    let url = vendor.url || (config.buildProductUrl && config.buildProductUrl(product, vendor));
    if (!url) {
      const searchUrl = config.buildSearchUrl
        ? config.buildSearchUrl(product, vendor)
        : null;
      if (!searchUrl) return null;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
      url = await firstProductLink(page, config);
      if (!url) return null;
    }

    // 2. Load the product page and snapshot it. domcontentloaded (NOT
    // networkidle — ad/analytics chatter means networkidle never fires on these
    // storefronts); an optional short settle lets client-rendered prices paint.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (config.settleMs) await page.waitForTimeout(config.settleMs);
    const sel = {
      titleSelector: config.titleSelector,
      priceSelectors: config.priceSelectors,
      availabilitySelector: config.availabilitySelector,
    };
    const snapshot = await page.evaluate(collectSnapshot, sel);

    // 3. Parse with the pure helpers: size-aware JSON-LD first; DOM fallback only
    // when JSON-LD carried no offers (offerFromSnapshot enforces the size gate so
    // a default DOM variant can't be reported as the requested pack).
    const offer = offerFromSnapshot(snapshot, { targetOz: targetOzOf(product) });
    if (!offer || offer.price == null) return null;

    // When JSON-LD priced the offer but didn't state availability, fall back to
    // the DOM availability text — otherwise a sold-out page reports 'unknown'
    // (which compare does NOT exclude) and can rank as a savings opportunity.
    let availability = offer.availability || 'unknown';
    if (availability === 'unknown' && snapshot.availabilityText) {
      availability = mapAvailability(snapshot.availabilityText);
    }

    const name = offer.name || snapshot.title || null;
    const quantity = (config.quantityFrom && config.quantityFrom(name, snapshot))
      || extractSizeToken(name)
      || extractSizeToken(snapshot.title);

    return {
      price: offer.price,
      currency: offer.currency || 'USD',
      availability,
      name,
      quantity,
      source_url: page.url(), // the PROOF link — exactly where the price was read
      text: snapshot.bodyText || null,
      price_type: config.priceType || 'public',
      // The real vendors.id (UUID) the /report worker keys on — a DB vendor row
      // provides `.id`. This is NOT the adapter slug (selectAdapterKey decides
      // that from host/name/url; the two are independent).
      vendor_id: vendor.vendor_id || vendor.id,
      vendor: vendor.name || vendor.vendor_id || vendor.id,
    };
  }

  return { key: config.key, config, fetchCandidate };
}

module.exports = { makeAdapter, collectSnapshot, firstProductLink, searchQuery, targetOzOf, nodeValue, DEFAULT_TIMEOUT };
