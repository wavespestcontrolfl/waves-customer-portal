// Keystone Pest Solutions (keystonepestsolutions.com) — BigCommerce storefront.
// Stencil search links to the product page; BigCommerce emits JSON-LD Product
// plus .price--withoutTax / .price--main DOM hooks.
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'keystone',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://www.keystonepestsolutions.com/search.php?search_query=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: ['.card-figure a.card-figure__link', '.productGrid .card a', '.card-title a'],
  titleSelector: 'h1.productView-title, h1[itemprop="name"], h1',
  priceSelectors: ['[data-product-price-without-tax]', '.price--withoutTax', '.price--main', '.price', '[itemprop="price"]'],
  availabilitySelector: '[itemprop="availability"], .productView-info-value, .stock',
});
