const {
  mapAvailability,
  parsePriceText,
  offerPrice,
  extractJsonLdOffer,
  extractDomPrice,
  deriveNormalizedUnitPrice,
  tokenOverlap,
  verifyMatch,
} = require('../services/price-scan/extract');

describe('price-scan extract', () => {
  describe('parsePriceText', () => {
    test('parses a plain price', () => expect(parsePriceText('$95.00')).toBe(95));
    test('parses thousands separators', () => expect(parsePriceText('$1,234.50')).toBe(1234.5));
    test('parses bare number', () => expect(parsePriceText('95')).toBe(95));
    test('rejects a range', () => expect(parsePriceText('$89 - $95')).toBeNull());
    test('rejects sale+was (two prices)', () => expect(parsePriceText('$95.00 was $99.00')).toBeNull());
    test('rejects call-for-price', () => expect(parsePriceText('Call for price')).toBeNull());
    test('rejects empty / null', () => {
      expect(parsePriceText('')).toBeNull();
      expect(parsePriceText(null)).toBeNull();
    });
    test('rejects zero', () => {
      expect(parsePriceText('$0.00')).toBeNull();
      expect(parsePriceText('0')).toBeNull();
    });
  });

  describe('mapAvailability', () => {
    test('schema.org urls', () => {
      expect(mapAvailability('https://schema.org/InStock')).toBe('in_stock');
      expect(mapAvailability('http://schema.org/OutOfStock')).toBe('out_of_stock');
      expect(mapAvailability('https://schema.org/LimitedAvailability')).toBe('limited');
      expect(mapAvailability('https://schema.org/BackOrder')).toBe('backorder');
    });
    test('free text', () => {
      expect(mapAvailability('In Stock. Ships in 1 business day')).toBe('in_stock');
      expect(mapAvailability('Only 3 left')).toBe('limited');
      expect(mapAvailability('Sold out')).toBe('out_of_stock');
      expect(mapAvailability('whatever')).toBe('unknown');
      expect(mapAvailability('')).toBe('unknown');
    });
  });

  describe('offerPrice', () => {
    test('Offer.price string', () => expect(offerPrice({ price: '95.00' })).toBe(95));
    test('AggregateOffer.lowPrice', () => expect(offerPrice({ lowPrice: 88.5 })).toBe(88.5));
    test('priceSpecification.price', () => expect(offerPrice({ priceSpecification: { price: '120' } })).toBe(120));
    test('missing/zero -> null', () => {
      expect(offerPrice({})).toBeNull();
      expect(offerPrice({ price: 0 })).toBeNull();
    });
  });

  describe('extractJsonLdOffer', () => {
    test('DoMyOwn-style Product/Offer', () => {
      const ld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'Product', name: 'Taurus SC Termiticide 78 oz',
        offers: { '@type': 'Offer', price: '95.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      });
      expect(extractJsonLdOffer([ld])).toEqual({ price: 95, currency: 'USD', availability: 'in_stock', name: 'Taurus SC Termiticide 78 oz' });
    });
    test('@graph wrapper', () => {
      const ld = JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Product', name: 'X', offers: { price: 42, priceCurrency: 'USD' } }] });
      expect(extractJsonLdOffer([ld]).price).toBe(42);
    });
    test('AggregateOffer', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'Y', offers: { '@type': 'AggregateOffer', lowPrice: '79.99', priceCurrency: 'USD' } });
      expect(extractJsonLdOffer([ld]).price).toBe(79.99);
    });
    test('prefers in-stock offer over out-of-stock', () => {
      const oos = JSON.stringify({ '@type': 'Product', name: 'A', offers: { price: 80, availability: 'OutOfStock' } });
      const ins = JSON.stringify({ '@type': 'Product', name: 'A', offers: { price: 90, availability: 'InStock' } });
      const got = extractJsonLdOffer([oos, ins]);
      expect(got.price).toBe(90);
      expect(got.availability).toBe('in_stock');
    });
    test('non-USD currency is surfaced (caller rejects)', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'Z', offers: { price: 10, priceCurrency: 'CAD' } });
      expect(extractJsonLdOffer([ld]).currency).toBe('CAD');
    });
    test('no priced offer -> null', () => {
      expect(extractJsonLdOffer([JSON.stringify({ '@type': 'Product', name: 'NoPrice' })])).toBeNull();
      expect(extractJsonLdOffer(['not json'])).toBeNull();
    });
  });

  describe('extractDomPrice', () => {
    test('first parseable price + availability', () => {
      expect(extractDomPrice({ priceTexts: ['', 'Call for price', '$95.00'], title: 'Taurus SC', availabilityText: 'In Stock' }))
        .toEqual({ price: 95, currency: 'USD', availability: 'in_stock', name: 'Taurus SC' });
    });
    test('no price -> null', () => {
      expect(extractDomPrice({ priceTexts: ['Call for price'], title: 'X' })).toBeNull();
      expect(extractDomPrice({})).toBeNull();
    });
  });

  describe('deriveNormalizedUnitPrice', () => {
    test('78 oz jug', () => expect(deriveNormalizedUnitPrice(95, '78 oz')).toBeCloseTo(1.217949, 5));
    test('2.5 gal drum is cheaper per oz', () => expect(deriveNormalizedUnitPrice(300, '2.5 gal')).toBeCloseTo(0.9375, 4));
    test('null on bad price or size', () => {
      expect(deriveNormalizedUnitPrice(0, '78 oz')).toBeNull();
      expect(deriveNormalizedUnitPrice(95, '')).toBeNull();
      expect(deriveNormalizedUnitPrice(95, 'each')).toBeNull();
    });
  });

  describe('tokenOverlap', () => {
    test('high overlap', () => expect(tokenOverlap('Taurus SC Termiticide', 'Taurus SC Termiticide Insecticide 78 oz')).toBeGreaterThanOrEqual(0.9));
    test('low overlap', () => expect(tokenOverlap('Taurus SC', 'Termidor SC Foam')).toBeLessThan(0.5));
  });

  describe('verifyMatch', () => {
    const expected = { productName: 'Taurus SC', vendorProductName: 'Taurus SC Termiticide', epaReg: '53883-279', packSizeValue: 78, packSizeUnit: 'oz' };
    test('size + name -> matched', () => {
      const r = verifyMatch({ name: 'Taurus SC Termiticide Insecticide 78 oz', quantity: '78 oz' }, expected);
      expect(r.matched).toBe(true);
      expect(r.signals.packSize).toBe(true);
    });
    test('size mismatch (1 gal vs 78 oz) -> not matched', () => {
      const r = verifyMatch({ name: 'Taurus SC Termiticide', quantity: '1 gal' }, expected);
      expect(r.signals.packSize).toBe(false);
      expect(r.matched).toBe(false);
    });
    test('right size, wrong product -> not matched', () => {
      const r = verifyMatch({ name: 'Termidor SC Foam', quantity: '78 oz' }, expected);
      expect(r.matched).toBe(false);
    });
    test('epa reg in text rescues a weak name', () => {
      const r = verifyMatch({ name: 'Generic Fipronil 78oz', text: 'EPA Reg No 53883-279', quantity: '78 oz' }, expected);
      expect(r.signals.epa).toBe(true);
      expect(r.matched).toBe(true);
    });
    test('no known size -> needs both name and epa', () => {
      const noSize = { productName: 'Taurus SC', vendorProductName: 'Taurus SC Termiticide' };
      const r = verifyMatch({ name: 'Taurus SC Termiticide', quantity: 'each' }, noSize);
      expect(r.sizeKnown).toBe(false);
      expect(r.matched).toBe(false); // name only, no epa
    });
  });
});
