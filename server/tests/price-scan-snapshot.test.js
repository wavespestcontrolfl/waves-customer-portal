// No jsdom: collectSnapshot's DOM querying is browser I/O (exercised by the live
// proof). The unit-testable part — preferring microdata attributes over text,
// and the structured-size oz gate — is covered here with plain objects.
const { priceValue, availabilityValue, targetOzOf, bestMatchingLink, searchTokens } = require('../services/price-scan/adapters/base');

// Minimal element stub: attributes + textContent, like a DOM node.
const el = (attrs = {}, text = '') => ({
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  textContent: text,
});

describe('priceValue (price attribute precedence)', () => {
  test('reads <meta content> / value before textContent', () => {
    expect(priceValue(el({ content: '89.00' }))).toBe('89.00'); // <meta itemprop="price" content="89.00">
    expect(priceValue(el({ value: '95.00' }))).toBe('95.00');
  });
  test('reads storefront price data-attributes before falling back to text', () => {
    // <span data-price="89.99"> — the generic adapter's [data-price] selector, no text
    expect(priceValue(el({ 'data-price': '89.99' }))).toBe('89.99');
    // Magento <span data-price-amount="40.00">
    expect(priceValue(el({ 'data-price-amount': '40.00' }))).toBe('40.00');
    // BigCommerce / Keystone [data-product-price-without-tax]
    expect(priceValue(el({ 'data-product-price-without-tax': '36.77' }))).toBe('36.77');
  });
  test('NEVER reads href as a price — a price anchor URL must not parse as a price', () => {
    // <a class="price" href="/product/p-89.html">$89.00</a> — href digits would be a bogus price
    expect(priceValue(el({ href: '/product/p-89.html' }, '$89.00'))).toBe('$89.00');
    expect(priceValue(el({ href: '/product/p-89.html' }))).toBe(''); // no text -> empty, not the URL
  });
  test('schema.org microdata still wins over a data-price attribute', () => {
    expect(priceValue(el({ content: '89.00', 'data-price': '12.00' }))).toBe('89.00');
  });
  test('falls back to textContent when no attribute', () => {
    expect(priceValue(el({}, '  $95.00  '))).toBe('$95.00');
  });
  test('empty / null node -> empty string', () => {
    expect(priceValue(null)).toBe('');
    expect(priceValue(el({}, ''))).toBe('');
  });
});

describe('availabilityValue (reads href for the schema.org stock link)', () => {
  test('reads <link itemprop="availability" href=".../OutOfStock"> (no text)', () => {
    expect(availabilityValue(el({ href: 'https://schema.org/OutOfStock' }))).toBe('https://schema.org/OutOfStock');
    expect(availabilityValue(el({ content: 'InStock' }))).toBe('InStock');
  });
  test('falls back to textContent ("In Stock") when no attribute', () => {
    expect(availabilityValue(el({}, 'In Stock'))).toBe('In Stock');
  });
});

describe('targetOzOf (structured pack size -> oz gate)', () => {
  test('canonical units (fl_oz) resolve via convertToOz', () => {
    expect(targetOzOf({ packSizeValue: 30, packSizeUnit: 'fl_oz' })).toBe(30);
    expect(targetOzOf({ packSizeValue: 2.5, packSizeUnit: 'gal' })).toBe(320);
    expect(targetOzOf({ packSizeValue: 10, packSizeUnit: 'lb' })).toBe(160);
  });
  test('falls back to a free-text quantity string', () => {
    expect(targetOzOf({ quantity: '78 oz' })).toBe(78);
  });
});

describe('searchTokens', () => {
  test('keeps >=2-char tokens incl. formulation codes', () => {
    expect(searchTokens({ vendorProductName: 'Taurus SC Termiticide' })).toEqual(['taurus', 'sc', 'termiticide']);
  });
  test('merges a slashed single-letter formulation code: I/T -> it', () => {
    expect(searchTokens({ searchQuery: 'Bifen I/T Insecticide', name: 'X' })).toEqual(['bifen', 'it', 'insecticide']);
  });
});

describe('bestMatchingLink (scored result selection)', () => {
  const product = { vendorProductName: 'Taurus SC Termiticide', quantity: '78 oz' };
  const links = [
    'https://www.domyown.com/talstar-professional-insecticide-p-97.html',
    'https://www.domyown.com/termidor-sc-p-184.html',
    'https://www.domyown.com/taurus-sc-termiticide-p-1816.html',
    'https://www.domyown.com/taurus-sc-termiticide-78-oz-p-1817.html',
  ];
  test('picks the matching product even when it is NOT first (relevance-ranked widget)', () => {
    const got = bestMatchingLink(links, product);
    expect(got).toMatch(/taurus-sc-termiticide/);
  });
  test('size tokens break the tie toward the size-specific page', () => {
    expect(bestMatchingLink(links, product)).toBe('https://www.domyown.com/taurus-sc-termiticide-78-oz-p-1817.html');
  });
  test('returns null when the product is not in the results (no false grab)', () => {
    expect(bestMatchingLink([
      'https://www.domyown.com/talstar-professional-insecticide-p-97.html',
      'https://www.domyown.com/termidor-sc-p-184.html',
    ], product)).toBeNull();
  });
  test('a shared generic formulation token (sc) does NOT cross-match another brand', () => {
    // "Taurus SC" shares "sc" with "termidor-sc"; brand (taurus) is mandatory, so no grab.
    expect(bestMatchingLink(['https://www.domyown.com/termidor-sc-p-184.html'], product)).toBeNull();
  });
  test('a single-digit pack size still steers to the right size variant (5 lb, not 25 lb)', () => {
    const prod = { vendorProductName: 'Prodiamine 65 WDG', quantity: '5 lb' };
    const got = bestMatchingLink([
      'https://www.domyown.com/prodiamine-65-wdg-25-lb-p-1.html', // ties on name+lb without the digit
      'https://www.domyown.com/prodiamine-65-wdg-5-lb-p-2.html',
    ], prod);
    expect(got).toBe('https://www.domyown.com/prodiamine-65-wdg-5-lb-p-2.html');
  });
  test('terse slug that omits the category word still matches (Bifen I/T -> bifen-it, beats bifen-xts)', () => {
    const bifen = { vendorProductName: 'Bifen I/T Insecticide', quantity: '96 oz' };
    const got = bestMatchingLink([
      'https://www.domyown.com/bifen-xts-insecticide-p-999.html', // also carries "insecticide" but not "it"
      'https://www.domyown.com/bifen-it-p-226.html',
    ], bifen);
    expect(got).toBe('https://www.domyown.com/bifen-it-p-226.html');
  });
  test('no product context -> legacy first link', () => {
    expect(bestMatchingLink(links, {})).toBe(links[0]);
  });
  test('empty list -> null', () => {
    expect(bestMatchingLink([], product)).toBeNull();
  });
});
