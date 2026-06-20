// No jsdom: collectSnapshot's DOM querying is browser I/O (exercised by the live
// proof). The unit-testable part — preferring microdata attributes over text,
// and the structured-size oz gate — is covered here with plain objects.
const { nodeValue, targetOzOf } = require('../services/price-scan/adapters/base');

// Minimal element stub: attributes + textContent, like a DOM node.
const el = (attrs = {}, text = '') => ({
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  textContent: text,
});

describe('nodeValue (microdata attribute precedence)', () => {
  test('reads <link href> / <meta content> before textContent', () => {
    // <link itemprop="availability" href="https://schema.org/OutOfStock"> — no text
    expect(nodeValue(el({ href: 'https://schema.org/OutOfStock' }))).toBe('https://schema.org/OutOfStock');
    expect(nodeValue(el({ content: '89.00' }))).toBe('89.00'); // <meta itemprop="price" content="89.00">
    expect(nodeValue(el({ value: '95.00' }))).toBe('95.00');
  });
  test('falls back to textContent when no attribute', () => {
    expect(nodeValue(el({}, '  $95.00  '))).toBe('$95.00');
    expect(nodeValue(el({}, 'In Stock'))).toBe('In Stock');
  });
  test('empty / null node -> empty string', () => {
    expect(nodeValue(null)).toBe('');
    expect(nodeValue(el({}, ''))).toBe('');
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
