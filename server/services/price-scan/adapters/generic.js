// Generic fallback adapter for vendors without a bespoke module. Relies on the
// vendor providing a direct product URL (vendor.url) plus standard schema.org
// JSON-LD / microdata, which most storefronts expose. No search-URL builder —
// the engine skips a generic vendor that has no url.
const { makeAdapter } = require('./base');

module.exports = makeAdapter({
  key: 'generic',
  priceType: 'public',
  titleSelector: 'h1[itemprop="name"], h1.product-title, h1',
  priceSelectors: ['[itemprop="price"]', '[data-price]', '.product-price', '.price', '.our-price'],
  availabilitySelector: '[itemprop="availability"], .availability, .stock-status',
});
