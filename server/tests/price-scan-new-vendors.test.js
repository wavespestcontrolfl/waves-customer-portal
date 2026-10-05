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
const { offerFromSnapshot, verifyMatch, pickVariantOffer } = require('../services/price-scan/extract');
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

  test('a "Default Title" product with no size in title/tags takes its pack size from the variant weight', () => {
    const data = JSON.parse(read('golfcourselawn-product.json'));
    expect(data.title).not.toMatch(/\d\s*(lb|oz)/i); // fixture really has no size in the title
    const [v] = shopify.variantsFromShopify(data);
    expect(v.size).toBe('25 lb'); // 11340 g
    expect(pickVariantOffer([v], { targetOz: 400 })).toMatchObject({ price: 155.99, quantity: '25 lb' });
    expect(pickVariantOffer([v], { targetOz: 160 })).toBeNull(); // a 10 lb catalog size does not match
  });

  test('sizeFromWeightGrams only trusts a clean weight, never a packaged shipping weight', () => {
    expect(shopify.sizeFromWeightGrams(11340)).toBe('25 lb');
    expect(shopify.sizeFromWeightGrams(2268)).toBe('5 lb');
    expect(shopify.sizeFromWeightGrams(283.5)).toBe('10 oz');
    expect(shopify.sizeFromWeightGrams(35.4)).toBe('1.25 oz');
    expect(shopify.sizeFromWeightGrams(4150)).toBeNull(); // ~9.15 lb: not a clean pack
    expect(shopify.sizeFromWeightGrams(0)).toBeNull();
    expect(shopify.sizeFromWeightGrams(null)).toBeNull();
  });

  test('size is also read from variant options, a Size tag and a labelled body line', () => {
    const base = { title: 'Some Product', variants: [{ id: 1, title: 'Default Title', price: 1000, available: true }] };
    expect(shopify.variantsFromShopify({ ...base, variants: [{ ...base.variants[0], option1: '2.5 Gallon' }] })[0].size).toBe('2.5 Gallon');
    expect(shopify.variantsFromShopify({ ...base, tags: ['Spec:Size:17 oz.'] })[0].size).toBe('17 oz.');
    expect(shopify.variantsFromShopify({ ...base, description: '<p>Net Weight: 10 oz. Mix 1 gallon of water.</p>' })[0].size).toBe('10 oz');
  });

  test('no derivable size -> the variant cannot size-match (never guessed)', () => {
    const data = { title: 'Mystery Granular', description: '<p>Mix 1 gallon of water per 1,000 sq ft.</p>', variants: [{ id: 1, title: 'Default Title', price: 1000, available: true, weight: 4150 }] };
    const [v] = shopify.variantsFromShopify(data);
    expect(pickVariantOffer([v], { targetOz: 128 })).toBeNull();
    expect(pickVariantOffer([v], { targetOz: 400 })).toBeNull();
  });

  test('end to end: fixture product -> verified scan candidate at the catalog size', async () => {
    const data = JSON.parse(read('golfcourselawn-product.json'));
    const page = {
      goto: async () => {},
      evaluate: async () => JSON.stringify(data),
      $$eval: async () => [],
    };
    const vendor = { vendor_id: 'v1', name: 'Golf Course Lawn Store', website: 'https://golfcourselawn.store', url: 'https://golfcourselawn.store/products/acelepryn-g-insecticide-grub-and-armyworm-control' };
    const product = { name: 'Acelepryn G Insecticide', productName: 'Acelepryn G Insecticide', quantity: '25 lb' };
    const cand = await shopify.fetchCandidate(page, vendor, product);
    expect(cand).toMatchObject({ price: 155.99, quantity: '25 lb', availability: 'in_stock', vendor_id: 'v1' });
    expect(cand.source_url).toContain('golfcourselawn.store/products/acelepryn-g-insecticide-grub-and-armyworm-control');
    expect(verifyMatch({ name: cand.name, text: cand.text, quantity: cand.quantity }, product).matched).toBe(true);
    // a catalog pack the product does not come in yields no sized candidate at all
    const wrong = await shopify.fetchCandidate(page, vendor, { ...product, quantity: '10 lb' });
    expect(wrong && wrong.quantity).not.toBe('10 lb');
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

  test.each([
    'Free shipping is available on orders over $99.',
    'Free shipping applies to orders above $149.',
    'Get free shipping when you spend $75 or more.',
    'Free shipping on orders of 3 or more items.',
    'Free shipping with a minimum purchase.',
    'Qualifying orders get free shipping.',
    'FREE SHIPPING on select items only.',
    'Free shipping if you join the club.',
  ])('a conditional free-shipping sentence is NOT a free flag: %s', (sentence) => {
    expect(shopify.freeShippingFromShopify({ description: `<p>${sentence}</p>` })).toBe(false);
  });

  test('one conditional sentence vetoes the flag even beside an unconditional one', () => {
    expect(shopify.freeShippingFromShopify({ description: 'FREE SHIPPING on orders. Free shipping is available on orders over $99.' })).toBe(false);
    expect(shopify.freeShippingFromShopify({ tags: ['free shipping over 99'] })).toBe(false);
  });

  test('an unconditional sentence still flags (and a $ price elsewhere does not matter)', () => {
    expect(shopify.freeShippingFromShopify({ description: 'Costs $155.99 per bag. FREE SHIPPING on orders. Learn more.' })).toBe(true);
  });

  test('hazmat tag detection: _T true, _F false', () => {
    expect(shopify.hazmatFromShopify(JSON.parse(read('gemplers-suggest.json')).resources.results.products[0])).toBe(true);
    expect(shopify.hazmatFromShopify({ tags: ['shipping_hazardous_F', 'shipping_full_haz_F'] })).toBe(false);
    expect(shopify.hazmatFromShopify({ tags: ['shipping_full_haz_T'] })).toBe(true);
    expect(shopify.hazmatFromShopify({ tags: ['Insecticide'] })).toBe(false);
    expect(shopify.hazmatFromShopify(null)).toBe(false);
  });

  test('shipping rules for the two stores', () => {
    const gem = (price, quantity) => shippingFor({ vendor: { source_url: 'https://gemplers.com/products/x' }, price, quantity });
    // plain "oz" is ambiguous (fluid vs weight ounce): the table amount stays, labelled an estimate
    expect(gem(33.99, '17 oz')).toMatchObject({ amount: 10.99, basis: 'estimated' });
    expect(gem(33.99, '17 oz').note).toMatch(/weight estimated/);
    expect(gem(274.99, '1 gal').basis).toBe('free_over');
    const golf = { vendor: { source_url: 'https://golfcourselawn.store/products/x' }, price: 155.99, quantity: '15 lb' };
    expect(shippingFor(golf).basis).toBe('estimated');
    expect(shippingFor({ ...golf, freeShipping: true }).basis).toBe('free');
  });
});

describe('search wait covers every configured link selector', () => {
  function fakePage({ waitFails = true } = {}) {
    const calls = { wait: [] };
    return {
      calls,
      goto: async () => {},
      waitForSelector: async (sel, opts) => { calls.wait.push({ sel, opts }); if (waitFails) throw new Error('timeout'); },
      evaluate: async () => [],
    };
  }
  test('DIY Pest waits on Klevu tiles OR the server-rendered listing links in one wait', async () => {
    const page = fakePage();
    await diypest.fetchCandidate(page, { vendor_id: 'v', name: 'DIY Pest Control' }, { productName: 'Bifenthrin' });
    expect(page.calls.wait).toHaveLength(1);
    const { sel, opts } = page.calls.wait[0];
    expect(opts.timeout).toBe(10000);
    for (const s of diypest.config.productLinkSelectors) expect(sel.split(', ')).toContain(s);
    expect(sel).toContain('.product-item-link'); // listing page links satisfy the wait at once
  });
  test('an adapter with no link selectors falls back to the default selector', async () => {
    const { makeAdapter } = require('../services/price-scan/adapters/base');
    const a = makeAdapter({ key: 't', buildSearchUrl: () => 'https://x.example/s', searchWaitMs: 50 });
    const page = fakePage();
    await a.fetchCandidate(page, { vendor_id: 'v' }, { productName: 'x' });
    expect(page.calls.wait[0].sel).toBe('a.product-link');
  });
});

describe('collectSnapshot variant sources (Magento config, then DOM rows)', () => {
  const magentoHtml = (extra = '') => `<html><body><h1>Prod</h1>${extra}
    <script type="text/x-magento-init">{"x":{"y":{"spConfig":{
      "optionPrices":{"11":{"finalPrice":{"amount":44.5}},"12":{"finalPrice":{"amount":30},"size":"1 Pint"},"13":{"finalPrice":{"amount":9}}},
      "attributes":{"a1":{"options":[{"id":"o1","label":"1 Gallon"},{"id":"o3","label":"  "}]}},
      "index":{"11":{"a1":"o1"},"13":{"a1":"o3"}},
      "salable":{"a1":{"o1":["11"]}}}}}}</script></body></html>`;
  const cfg = { magentoVariants: true, titleSelector: 'h1', priceSelectors: [] };

  test('Magento jsonConfig: size from the option label or optionPrices.size, stock from the salable map', () => {
    const snap = snapshotOf(magentoHtml(), cfg);
    expect(snap.variants).toEqual([
      { size: '1 Gallon', price: 44.5, availabilityRaw: 'InStock' },
      { size: '1 Pint', price: 30, availabilityRaw: null },
    ]); // child 13 has a blank label -> skipped
  });

  test('a Magento variant that is not salable is OutOfStock', () => {
    const html = magentoHtml().replace('"salable":{"a1":{"o1":["11"]}}', '"salable":{"a1":{"o1":["99"]}}');
    expect(snapshotOf(html, cfg).variants[0]).toMatchObject({ size: '1 Gallon', availabilityRaw: 'OutOfStock' });
  });

  test('the Magento source wins; DOM rows are only the fallback; neither opted in -> none', () => {
    const rows = '<div class="vl"><span class="n">Prod 1 Qt.</span><span itemprop="price" content="12.5"></span></div>';
    const both = snapshotOf(magentoHtml(rows), { ...cfg, variantRows: { line: '.vl', name: '.n', price: '[itemprop="price"]' } });
    expect(both.variants.map((v) => v.size)).toEqual(['1 Gallon', '1 Pint']);
    const rowsOnly = snapshotOf(magentoHtml(rows), { ...cfg, magentoVariants: false, variantRows: { line: '.vl', name: '.n', price: '[itemprop="price"]' } });
    expect(rowsOnly.variants).toEqual([{ size: 'Prod 1 Qt.', price: 12.5, availabilityRaw: null }]);
    expect(snapshotOf(magentoHtml(rows), { ...cfg, magentoVariants: false }).variants).toEqual([]);
  });
});

describe('shopify fetchCandidate link sources and weight', () => {
  const data = () => JSON.parse(read('golfcourselawn-product.json'));
  const vendor = { vendor_id: 'v1', name: 'Golf Course Lawn Store', website: 'https://golfcourselawn.store' };
  const product = { name: 'Acelepryn G Insecticide', productName: 'Acelepryn G Insecticide', quantity: '25 lb' };
  function pageWith({ dom = [], suggest = null }) {
    const urls = [];
    let last = '';
    return {
      urls,
      goto: async (u) => { urls.push(u); last = u; },
      $$eval: async () => dom,
      evaluate: async () => {
        if (/suggest\.json/.test(last)) return JSON.stringify(suggest);
        return JSON.stringify(data());
      },
    };
  }

  test('DOM links are used when present (suggest.json is not fetched)', async () => {
    const page = pageWith({ dom: ['/products/acelepryn-g-insecticide-grub-and-armyworm-control'] });
    const cand = await shopify.fetchCandidate(page, vendor, product);
    expect(cand.price).toBe(155.99);
    expect(page.urls.some((u) => /suggest\.json/.test(u))).toBe(false);
  });

  test('no DOM links -> falls back to the predictive-search handles', async () => {
    const suggest = { resources: { results: { products: [{ handle: 'acelepryn-g-insecticide-grub-and-armyworm-control' }] } } };
    const page = pageWith({ dom: [], suggest });
    const cand = await shopify.fetchCandidate(page, vendor, product);
    expect(cand).toMatchObject({ price: 155.99, quantity: '25 lb' });
    expect(page.urls.some((u) => /suggest\.json/.test(u))).toBe(true);
  });

  test('neither source finds anything -> null', async () => {
    const page = pageWith({ dom: [], suggest: { resources: {} } });
    expect(await shopify.fetchCandidate(page, vendor, product)).toBeNull();
  });

  test('the candidate carries the priced variant weight in pounds (25 lb from 11340 g)', async () => {
    const page = pageWith({ dom: ['/products/acelepryn-g-insecticide-grub-and-armyworm-control'] });
    const cand = await shopify.fetchCandidate(page, vendor, product);
    expect(cand.weight_lb).toBeCloseTo(25, 3);
  });

  test('a real listing weight makes a Gemplers weight-table price firm; none keeps it an estimate', () => {
    const src = { source_url: 'https://gemplers.com/products/x' };
    expect(shippingFor({ vendor: src, price: 30, quantity: '1 gal', weightLb: 4 })).toMatchObject({ amount: 10.99, basis: 'weight_table' });
    expect(shippingFor({ vendor: src, price: 30, quantity: '1 gal' }).basis).toBe('estimated');
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
