// DoMyOwn — public storefront. Product pages are MULTI-SIZE: the JSON-LD/title carry only
// the default (smallest) variant, but each purchasable size renders as a `.product-option-card`
// ("jug (2.5 gal) $299.98", "box (4 x 30g tubes) $26.98") via product-cards.js after load —
// so optionCardSelector lets the scanner size-match the right variant (parsed by
// extract.variantsFromOptionCards). Direct product URLs are required: DoMyOwn's search is a
// client-side Reflektion widget that serves a headless browser only its "Trending Items"
// recommendations carousel (no real results), so search-by-name is unreliable — curate the
// product URL in vendor_pricing. URLs are slug-p-<id>.html (category links are -c-).
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'domyown',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://www.domyown.com/search?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: [
    '.rfk_product a[href*="-p-"]',
    'a[href*="-p-"]',
  ],
  searchWaitMs: 9000, // the search widget injects results a few seconds after load
  titleSelector: 'h1.product_name, h1[itemprop="name"], h1',
  priceSelectors: ['[itemprop="price"]', '.product_price .price', '.our_price', '.price'],
  availabilitySelector: '[itemprop="availability"], .availability, .stock_status',
  optionCardSelector: '.product-option-card', // per-size cards (size+price) rendered client-side
});
