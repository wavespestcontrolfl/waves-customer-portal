// Solutions Pest & Lawn (solutionsstores.com) — Magento storefront. Catalog
// search returns product tiles linking to the detail page; Magento emits
// JSON-LD Offer plus [data-price-amount] DOM hooks.
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
});
