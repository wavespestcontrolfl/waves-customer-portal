const { variantsFromShopify, handleOf, baseOrigin } = require('../services/price-scan/adapters/shopify');
const { pickVariantOffer } = require('../services/price-scan/extract');
const { selectAdapterKey, getAdapter } = require('../services/price-scan/adapters/registry');

describe('shopify variantsFromShopify', () => {
  test('maps cents->dollars, size from variant title, stock from available', () => {
    const data = { title: 'Bifen 7.9F Select', variants: [
      { title: '1 Gallon', price: 4450, available: true },
      { title: '1 Pint', price: 3500, available: false },
    ] };
    expect(variantsFromShopify(data)).toEqual([
      { size: '1 Gallon', price: 44.5, availabilityRaw: 'InStock' },
      { size: '1 Pint', price: 35.0, availabilityRaw: 'OutOfStock' },
    ]);
  });
  test('single "Default Title" variant borrows the size from the product title', () => {
    const data = { title: 'Dominion 2L - 27.5 oz', variants: [{ title: 'Default Title', price: 5999, available: true }] };
    expect(variantsFromShopify(data)[0]).toMatchObject({ size: 'Dominion 2L - 27.5 oz', price: 59.99 });
  });
  test('feeds pickVariantOffer end-to-end (Bifen 1 gallon)', () => {
    const v = variantsFromShopify({ title: 'Bifen 7.9F', variants: [{ title: '1 Gallon', price: 4450, available: true }, { title: '1 Pint', price: 3500, available: true }] });
    expect(pickVariantOffer(v, { targetOz: 128 })).toMatchObject({ price: 44.5, quantity: '1 Gallon' });
  });
});

describe('shopify handleOf / baseOrigin', () => {
  test('handleOf pulls the product handle from absolute or relative URLs', () => {
    expect(handleOf('/products/bifen-i-t')).toBe('bifen-i-t');
    expect(handleOf('https://chemicalwarehouse.com/products/bifen-i-t?variant=1')).toBe('bifen-i-t');
    expect(handleOf('/collections/x')).toBeNull();
  });
  test('baseOrigin derives the storefront origin from website or url', () => {
    expect(baseOrigin({ website: 'https://chemicalwarehouse.com/' })).toBe('https://chemicalwarehouse.com');
    expect(baseOrigin({ url: 'https://seedbarn.com/products/x' })).toBe('https://seedbarn.com');
    expect(baseOrigin({})).toBeNull();
  });
  test('baseOrigin assumes https for a bare host (operator-editable website)', () => {
    expect(baseOrigin({ website: 'chemicalwarehouse.com' })).toBe('https://chemicalwarehouse.com');
    expect(baseOrigin({ website: 'www.seedbarn.com/' })).toBe('https://www.seedbarn.com');
  });
});

describe('registry resolves Shopify stores to the shopify adapter', () => {
  test('by website host', () => {
    expect(selectAdapterKey({ name: 'Chemical Warehouse', website: 'https://chemicalwarehouse.com' })).toBe('shopify');
    expect(selectAdapterKey({ name: 'Seed World USA', website: 'https://www.seedworldusa.com' })).toBe('shopify');
    expect(getAdapter('shopify').key).toBe('shopify');
  });
  test('unknown store still falls back to generic', () => {
    expect(selectAdapterKey({ name: 'Some Co', website: 'https://example.com' })).toBe('generic');
  });
});
