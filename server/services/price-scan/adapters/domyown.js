// DoMyOwn — public storefront, rich JSON-LD Product/Offer markup on product pages
// (the parser wins on JSON-LD; DOM selectors are a fallback). Search is a
// client-side Reflektion widget at /search?q= (the old /searchresults.html is dead),
// so results render after load and are relevance-ranked + mixed with recommendations
// — the base adapter waits for the links then picks the best slug match. Product
// URLs are slug-p-<id>.html; category links are -c-, so the product filter is safe.
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
});
