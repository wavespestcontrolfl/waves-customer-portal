// Adapter parsing for the vendors added with the delivered-price work, run against small
// trimmed copies of the real pages (fixtures/price-scan, fetched 2026-10-05). collectSnapshot
// is the in-browser scraper; jsdom stands in for the page so its selectors are exercised for real.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { collectSnapshot, applySizeHint, freeShippingFromJsonLd } = require('../services/price-scan/adapters/base');
const diypest = require('../services/price-scan/adapters/diypest');
const forestry = require('../services/price-scan/adapters/forestry');
const shopify = require('../services/price-scan/adapters/shopify');
const { offerFromSnapshot, verifyMatch } = require('../services/price-scan/extract');
const { shippingFor } = require('../services/price-scan/shipping-rules');
const { SHOPIFY_HOSTS } = require('../services/price-scan/adapters/shopify-hosts');

const FIX = path.join(__dirname, 'fixtures', 'price-scan');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

function snapshotOf(html, config) {
  const dom = new JSDOM(html);
  const prev = global.document;
  global.document = dom.window.document;
  try {
    return collectSnapshot({
      titleSelector: config.titleSelector,
      priceSelectors: config.priceSelectors,
      availabilitySelector: config.availabilitySelector,
      magentoVariants: !!config.magentoVariants,
      optionCardSelector: config.optionCardSelector || null,
      variantRows: config.variantRows || null,
      sizeHintSelector: config.sizeHintSelector || null,
    });
  } finally { global.document = prev; }
}

function linksOf(html, config) {
  const doc = new JSDOM(html).window.document;
  const seen = [];
  for (const s of config.productLinkSelectors) {
    for (const a of doc.querySelectorAll(s)) {
      const href = a.getAttribute('href');
      if (href && !seen.includes(href)) seen.push(href);
    }
  }
  return seen;
}

const GAL = 128; // oz-equivalents
const PT = 16;
const GAL30 = 30 * 128;

describe('DIY Pest Control adapter (Magento + Klevu)', () => {
  test('builds the /search/?q= URL', () => {
    expect(diypest.config.buildSearchUrl({ productName: 'Bifen I/T' })).toBe('https://diypestcontrol.com/search/?q=Bifen%20I%2FT');
    expect(diypest.config.buildSearchUrl({})).toBeNull();
  });

  test('reads product links from the Klevu-rendered result tiles', () => {
    const links = linksOf(read('diypest-search.html'), diypest.config);
    expect(links[0]).toBe('https://diypestcontrol.com/qp-bifenthrin-it-7-9-f');
    expect(links).toContain('https://diypestcontrol.com/agrisel-bifenthrin-pro-7-9');
    expect(links.length).toBe(4);
  });

  test('product page: size comes from the Packaging spec row, price from JSON-LD, free shipping flagged', () => {
    const snap = snapshotOf(read('diypest-product.html'), diypest.config);
    expect(snap.sizeHint).toMatch(/^1 Gallon/);
    expect(snap.title).toBe('QP Bifenthrin I/T 7.9% F Insecticide');
    applySizeHint(snap);
    expect(snap.title).toMatch(/1 Gallon/);
    const offer = offerFromSnapshot(snap, { targetOz: GAL });
    expect(offer).toMatchObject({ price: 48.55, availability: 'in_stock' });
    expect(freeShippingFromJsonLd(snap.jsonLd)).toBe(true);
    // the other pack size is NOT guessed from this page
    expect(offerFromSnapshot(snap, { targetOz: PT })).toBeNull();
  });

  test('applySizeHint leaves a title that already states a size alone', () => {
    const snap = applySizeHint({ title: 'Bifen 1 Gallon', sizeHint: '2.5 Gallon' });
    expect(snap.title).toBe('Bifen 1 Gallon');
  });

  test('verifies as the scanned product at the right size', () => {
    const snap = applySizeHint(snapshotOf(read('diypest-product.html'), diypest.config));
    const verdict = verifyMatch({ name: snap.title, text: snap.bodyText, quantity: '1 Gallon' }, { name: 'QP Bifenthrin I/T 7.9% F Insecticide', quantity: '1 gal' });
    expect(verdict.matched).toBe(true);
  });

  test('free shipping is the vendor rule (also true in the markup)', () => {
    expect(shippingFor({ vendor: { source_url: 'https://diypestcontrol.com/qp-bifenthrin-it-7-9-f' } })).toMatchObject({ amount: 0, basis: 'free' });
  });
});

describe('Forestry Distributing adapter (nopCommerce)', () => {
  test('builds the /search?q= URL', () => {
    expect(forestry.config.buildSearchUrl({ productName: 'bifenthrin' })).toBe('https://www.forestrydistributing.com/search?q=bifenthrin');
  });

  test('reads product links from the server-rendered results', () => {
    const links = linksOf(read('forestry-search.html'), forestry.config);
    expect(links[0]).toBe('/bifen-it-bifenthrin-insecticide-talstar-control-solution');
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  test('product page: one variant per size, matched by size', () => {
    const snap = snapshotOf(read('forestry-product.html'), forestry.config);
    expect(snap.variants.map((v) => v.price)).toEqual([23.95, 34.95, 44.95, 1154.95]);
    const gal = offerFromSnapshot(snap, { targetOz: GAL });
    expect(gal).toMatchObject({ price: 44.95, fromVariant: true });
    expect(gal.quantity).toMatch(/gal/i);
    expect(offerFromSnapshot(snap, { targetOz: PT })).toMatchObject({ price: 23.95 });
    expect(offerFromSnapshot(snap, { targetOz: GAL30 })).toMatchObject({ price: 1154.95 });
  });

  test('a size the page does not list is not guessed (no DOM-price fallback)', () => {
    const snap = snapshotOf(read('forestry-product.html'), forestry.config);
    expect(offerFromSnapshot(snap, { targetOz: 2.5 * 128 })).toBeNull();
  });

  test('shipping is an estimate, with the bulk surcharge at 40 lb+', () => {
    const src = 'https://www.forestrydistributing.com/x';
    expect(shippingFor({ vendor: { source_url: src }, price: 44.95, quantity: '1 gal' })).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(shippingFor({ vendor: { source_url: src }, price: 90, quantity: '50 lb' }).amount).toBe(40);
  });
});

describe('Shopify additions: Golf Course Lawn Store + Gemplers', () => {
  test('both hosts are on the Shopify allowlist; spoofs fail closed', () => {
    expect(SHOPIFY_HOSTS).toEqual(expect.arrayContaining(['golfcourselawn.store', 'gemplers.com']));
    expect(shopify.baseOrigin({ website: 'https://gemplers.com' })).toBe('https://gemplers.com');
    expect(shopify.baseOrigin({ website: 'golfcourselawn.store' })).toBe('https://golfcourselawn.store');
    expect(shopify.baseOrigin({ website: 'https://gemplers.com.evil.com' })).toBeNull();
    expect(shopify.baseOrigin({ website: 'https://gemplers.com@attacker.example' })).toBeNull();
    expect(shopify.baseOrigin({ website: 'https://golfcourselawn.store.evil.com' })).toBeNull();
  });

  test('Gemplers search is client-rendered: handles come from the predictive-search JSON', () => {
    const json = JSON.parse(read('gemplers-suggest.json'));
    expect(shopify.handlesFromSuggest(json)).toEqual([
      'shockwave-1-flushing-killing-and-residual-aerosol-17oz', 'rampage-soft-bait-8-lbs', 'garlon-4-ultra-triclopyr-herbicide',
    ]);
    expect(shopify.handlesFromSuggest(null)).toEqual([]);
    expect(shopify.handlesFromSuggest({ resources: {} })).toEqual([]);
  });

  test('product .js maps to size-matched variants (Golf Course Lawn Store)', () => {
    const data = JSON.parse(read('golfcourselawn-product.json'));
    const variants = shopify.variantsFromShopify(data);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ price: 155.99, availabilityRaw: 'InStock' });
  });

  test('free-shipping flag: tags or a threshold-free description only', () => {
    const data = JSON.parse(read('golfcourselawn-product.json'));
    expect(shopify.freeShippingFromShopify(data)).toBe(false); // this item's .js carries no flag
    expect(shopify.freeShippingFromShopify({ tags: ['Free Shipping'] })).toBe(true);
    expect(shopify.freeShippingFromShopify({ tags: ['free_shipping_F'] })).toBe(false);
    expect(shopify.freeShippingFromShopify({ description: '<p><b>FREE SHIPPING</b> on orders. Learn more</p>' })).toBe(true);
    expect(shopify.freeShippingFromShopify({ description: 'Free shipping over $99 only' })).toBe(false);
    expect(shopify.freeShippingFromShopify(null)).toBe(false);
  });

  test('shipping rules for the two stores', () => {
    const gem = (price, quantity) => shippingFor({ vendor: { source_url: 'https://gemplers.com/products/x' }, price, quantity });
    expect(gem(33.99, '17 oz')).toMatchObject({ amount: 10.99, basis: 'weight_table' }); // aerosol ~1 lb... under 5 lb
    expect(gem(274.99, '1 gal').basis).toBe('free_over');
    const golf = { vendor: { source_url: 'https://golfcourselawn.store/products/x' }, price: 155.99, quantity: '15 lb' };
    expect(shippingFor(golf).basis).toBe('estimated');
    expect(shippingFor({ ...golf, freeShipping: true }).basis).toBe('free');
  });
});

describe('freeShippingFromJsonLd', () => {
  test('true only on an explicit $0 shipping rate', () => {
    const ld = (v) => JSON.stringify({ '@type': 'Product', offers: [{ '@type': 'Offer', shippingDetails: { shippingRate: { value: v } } }] });
    expect(freeShippingFromJsonLd([ld(0)])).toBe(true);
    expect(freeShippingFromJsonLd([ld('0.00')])).toBe(true);
    expect(freeShippingFromJsonLd([ld(9.99)])).toBe(false);
    expect(freeShippingFromJsonLd(['{"@type":"Product"}', 'not json'])).toBe(false);
    expect(freeShippingFromJsonLd([])).toBe(false);
  });
});
