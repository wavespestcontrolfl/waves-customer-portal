// DoMyOwn — public storefront, rich JSON-LD Product/Offer markup (the parser
// usually wins on JSON-LD; the DOM selectors are a fallback). Search-results
// page links straight to the product detail page.
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'domyown',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://www.domyown.com/searchresults.html?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: [
    '.product_listing_container a.product_name',
    '.product_listing .product_name a',
    'a.product_name',
  ],
  titleSelector: 'h1.product_name, h1[itemprop="name"], h1',
  priceSelectors: ['[itemprop="price"]', '.product_price .price', '.our_price', '.price'],
  availabilitySelector: '[itemprop="availability"], .availability, .stock_status',
});
