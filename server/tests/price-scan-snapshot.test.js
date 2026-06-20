// No jsdom: collectSnapshot's DOM querying is browser I/O (exercised by the live
// proof). The unit-testable part — preferring microdata attributes over text,
// and the structured-size oz gate — is covered here with plain objects.
const { priceValue, availabilityValue, targetOzOf } = require('../services/price-scan/adapters/base');

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
