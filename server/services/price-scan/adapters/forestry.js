// Forestry Distributing (forestrydistributing.com) — nopCommerce storefront. Search
// (/search?q=<term>) redirects to /filterSearch?q=<term> and is SERVER-rendered: each hit is
// `.product-item` with an `h2.product-title a` link (list prices there are "From $x", never
// used). Multi-size products are GROUPED: the product page lists one `.product-variant-line`
// per size, the name carries the size ("Bifen I/T Insecticide, 1 Pt.") and the price sits in
// `[itemprop="price"]` (content="23.95"). variantRows hands those rows to the size matcher.
// A single-size product has no variant list; its price is the page-level `.product-price`.
// There is no JSON-LD on these pages (checked 2026-10-05).
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'forestry',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://www.forestrydistributing.com/search?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: ['.product-item .product-title a', 'h2.product-title a'],
  titleSelector: '.product-name h1, h1[itemprop="name"], h1',
  priceSelectors: ['.overview .product-price [itemprop="price"]', '.product-price [itemprop="price"]'],
  availabilitySelector: '.stock .value, .availability .value, [itemprop="availability"]',
  variantRows: {
    line: '.product-variant-line',
    name: '.variant-name',
    price: '[itemprop="price"]',
  },
});
