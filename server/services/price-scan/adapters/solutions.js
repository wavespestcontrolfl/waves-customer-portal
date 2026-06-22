// Solutions Pest & Lawn (solutionsstores.com) — Magento storefront. Catalog
// search returns product tiles linking to the detail page. Most products are
// CONFIGURABLE (one URL, many size variants): the page-level JSON-LD Offer/title
// carry no size, but Magento's jsonConfig lists each variant's size label + price —
// so magentoVariants:true lets the scanner size-match the right variant instead of
// abandoning the page. JSON-LD Offer + [data-price-amount] remain DOM fallbacks.
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'solutions',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://www.solutionsstores.com/catalogsearch/result/?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: ['.product-item-link', '.product-item-info a.product', '.products a.product-item-link'],
  titleSelector: 'h1.page-title .base, h1.page-title, h1[itemprop="name"], h1',
  priceSelectors: ['[data-price-type="finalPrice"] .price', '[itemprop="price"]', '.price-wrapper .price', '.price'],
  availabilitySelector: '[itemprop="availability"], .stock.available, .stock.unavailable, .availability',
  magentoVariants: true, // size+price live in Magento jsonConfig, not JSON-LD/title
});
