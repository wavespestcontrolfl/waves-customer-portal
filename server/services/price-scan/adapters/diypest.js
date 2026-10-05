// DIY Pest Control (diypestcontrol.com) — Magento 2 storefront (free shipping on all orders,
// see shipping-rules.js). Two quirks, both checked against the live site 2026-10-05:
//   1. Search (/search/?q=<term>) is rendered CLIENT-SIDE by Klevu: the server HTML has no
//      result rows, the browser paints `.klevuProduct` tiles a moment later, so searchWaitMs
//      waits for the first tile. (A query may also redirect to an /active-ingredients/...
//      listing page, which uses the plain Magento `.product-item-link` tiles — both are listed.)
//   2. Product pages are Magento GROUPED products: the title carries no pack size
//      ("QP Bifenthrin I/T 7.9% F Insecticide") but the spec table does
//      ("Packaging: 1 Gallon , Quali-Pro (Mfg. Number: ...)"), so sizeHintSelector feeds that
//      cell to the size gate. JSON-LD Offer + [data-price-amount] are the price sources;
//      magentoVariants covers the configurable products that do list sizes in jsonConfig.
const { makeAdapter, searchQuery } = require('./base');

module.exports = makeAdapter({
  key: 'diypest',
  priceType: 'public',
  buildSearchUrl: (p) => {
    const q = searchQuery(p);
    return q ? `https://diypestcontrol.com/search/?q=${encodeURIComponent(q)}` : null;
  },
  productLinkSelectors: [
    '.klevuProduct .kuName a',
    '.klevuProduct a.klevuProductClick',
    '.product-item-link',
  ],
  searchWaitMs: 10000, // Klevu paints the result tiles client-side
  titleSelector: 'h1.page-title .base, h1.page-title, h1[itemprop="name"], h1',
  priceSelectors: ['[data-price-type="finalPrice"]', '[itemprop="price"]', '.special-price .price', '.price'],
  availabilitySelector: '[itemprop="availability"], .stock.available, .stock.unavailable',
  sizeHintSelector: 'td.col.data[data-th="Packaging"]',
  magentoVariants: true,
});
