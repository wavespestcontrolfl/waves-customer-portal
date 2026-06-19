const {
  mapAvailability,
  parsePriceText,
  offerPrice,
  extractJsonLdOffer,
  extractDomPrice,
  offerFromSnapshot,
  quantityToOz,
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
    test('rejects discount percentages', () => {
      expect(parsePriceText('Save 20%')).toBeNull();
      expect(parsePriceText('20% off')).toBeNull();
      expect(parsePriceText('$95.00')).toBe(95);
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
    test('negated in-stock / availability phrases are out of stock', () => {
      // The positive "in stock" regex would otherwise match inside these.
      expect(mapAvailability('Not in stock')).toBe('out_of_stock');
      expect(mapAvailability('Not currently in stock')).toBe('out_of_stock');
      expect(mapAvailability('Not available')).toBe('out_of_stock');
      expect(mapAvailability('No longer available')).toBe('out_of_stock');
      expect(mapAvailability('Temporarily out of stock')).toBe('out_of_stock');
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
    test('ambiguous string ranges are rejected, not mashed', () => {
      expect(offerPrice({ price: '$95.00-99' })).toBeNull();
      expect(offerPrice({ price: '89-95' })).toBeNull();
      expect(offerPrice({ lowPrice: '1,099.99' })).toBe(1099.99);
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
    test('within one offers array, prefers in-stock over an earlier sold-out offer', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'A',
        offers: [
          { '@type': 'Offer', price: 80, availability: 'OutOfStock' },
          { '@type': 'Offer', price: 90, availability: 'InStock' },
        ],
      });
      const got = extractJsonLdOffer([ld]);
      expect(got.price).toBe(90);
      expect(got.availability).toBe('in_stock');
    });
    test('non-USD currency is surfaced (caller rejects)', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'Z', offers: { price: 10, priceCurrency: 'CAD' } });
      expect(extractJsonLdOffer([ld]).currency).toBe('CAD');
    });
    test('top-level Offer node (itemOffered name) is read', () => {
      const ld = JSON.stringify({
        '@type': 'Offer', price: '95', priceCurrency: 'USD', availability: 'InStock',
        itemOffered: { '@type': 'Product', name: 'Taurus SC Termiticide 78 oz' },
      });
      const got = extractJsonLdOffer([ld], { targetOz: 78 });
      expect(got.price).toBe(95);
      expect(got.name).toMatch(/78 oz/);
    });
    test('Product nested under WebPage.mainEntity is traversed', () => {
      const ld = JSON.stringify({
        '@type': 'WebPage',
        mainEntity: { '@type': 'Product', name: 'Y', offers: { price: 42, priceCurrency: 'USD' } },
      });
      expect(extractJsonLdOffer([ld]).price).toBe(42);
    });
    test('prefers a limited-stock offer over an earlier sold-out one', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'A',
        offers: [
          { '@type': 'Offer', price: 80, availability: 'OutOfStock' },
          { '@type': 'Offer', price: 90, availability: 'LimitedAvailability' },
        ],
      });
      const got = extractJsonLdOffer([ld]);
      expect(got.price).toBe(90);
      expect(got.availability).toBe('limited');
    });
    test('no priced offer -> null', () => {
      expect(extractJsonLdOffer([JSON.stringify({ '@type': 'Product', name: 'NoPrice' })])).toBeNull();
      expect(extractJsonLdOffer(['not json'])).toBeNull();
    });

    // Real DoMyOwn shape: one Product, an offers[] of every size variant.
    const multiSize = JSON.stringify({
      '@type': 'Product', name: 'Taurus SC Termiticide',
      offers: [
        { '@type': 'Offer', name: 'Taurus SC Termiticide', price: '48.48', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', name: 'Taurus SC Termiticide 78 oz.', price: '95', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', name: 'Taurus SC Termiticide 2.5 Gallons', price: '380.5', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      ],
    });
    test('targetOz selects the matching variant offer', () => {
      const got = extractJsonLdOffer([multiSize], { targetOz: 78 });
      expect(got.price).toBe(95);
      expect(got.name).toMatch(/78 oz/);
    });
    test('targetOz for the drum picks the 2.5 gal offer', () => {
      expect(extractJsonLdOffer([multiSize], { targetOz: 320 }).price).toBe(380.5);
    });
    test('without targetOz, first priced offer wins (back-compat)', () => {
      expect(extractJsonLdOffer([multiSize]).price).toBe(48.48);
    });
    test('a single AggregateOffer lowPrice is rejected for a size-specific scan', () => {
      const agg = JSON.stringify({
        '@type': 'Product', name: 'Taurus SC Termiticide',
        offers: { '@type': 'AggregateOffer', lowPrice: '48.48', priceCurrency: 'USD', availability: 'InStock' },
      });
      expect(extractJsonLdOffer([agg], { targetOz: 78 })).toBeNull();
      expect(extractJsonLdOffer([agg]).price).toBe(48.48); // usable without a target
    });
    test('targetOz with no matching variant -> null (never guess a size)', () => {
      // 12 oz isn't offered; returning the 20 oz price as the 12 oz would be a lie.
      expect(extractJsonLdOffer([multiSize], { targetOz: 12 })).toBeNull();
    });
    test('a CASE/multipack offer does not match a single-size scan', () => {
      const withCase = JSON.stringify({
        '@type': 'Product', name: 'Taurus SC Termiticide',
        offers: [
          { '@type': 'Offer', name: 'Taurus SC Termiticide 78 oz.', price: '95', priceCurrency: 'USD', availability: 'InStock' },
          { '@type': 'Offer', name: 'Taurus SC Termiticide 78 oz. CASE (4 x 78 oz. bottles)', price: '380', priceCurrency: 'USD', availability: 'InStock' },
        ],
      });
      // single 78 oz wins; the 4 x 78 oz (312 oz) case is excluded
      expect(extractJsonLdOffer([withCase], { targetOz: 78 }).price).toBe(95);
      // …and is itself matchable as a 312 oz case scan
      expect(extractJsonLdOffer([withCase], { targetOz: 312 }).price).toBe(380);
    });
    test('nameless multi-offers do not inherit the product size for matching', () => {
      // Product node carries "78 oz", offers are nameless with different prices.
      // No offer has its OWN size evidence, so a size-specific scan must NOT
      // pair any of them with 78 oz.
      const ld = JSON.stringify({
        '@type': 'Product', name: 'Taurus SC Termiticide 78 oz',
        offers: [
          { '@type': 'Offer', price: '48.48', priceCurrency: 'USD', availability: 'InStock' },
          { '@type': 'Offer', price: '95', priceCurrency: 'USD', availability: 'InStock' },
        ],
      });
      expect(extractJsonLdOffer([ld], { targetOz: 78 })).toBeNull();
      // …but a SINGLE nameless offer is the product itself — size from the node ok.
      const single = JSON.stringify({
        '@type': 'Product', name: 'Taurus SC Termiticide 78 oz',
        offers: { '@type': 'Offer', price: '95', priceCurrency: 'USD', availability: 'InStock' },
      });
      expect(extractJsonLdOffer([single], { targetOz: 78 }).price).toBe(95);
    });
    test('tolerates raw control characters in the JSON-LD (real vendor markup)', () => {
      // Unescaped newline/tab inside a description string — strict JSON.parse
      // throws on this; the parser must strip-and-retry, not drop the block.
      const dirty = '{"@type":"Product","name":"Taurus SC","description":"line1\n\tline2",'
        + '"offers":{"@type":"Offer","price":"95","priceCurrency":"USD","availability":"InStock"}}';
      expect(() => JSON.parse(dirty)).toThrow(); // precondition: genuinely invalid
      expect(extractJsonLdOffer([dirty]).price).toBe(95);
    });
  });

  describe('offerFromSnapshot (size-gated DOM fallback)', () => {
    const variantLd = JSON.stringify({
      '@type': 'Product', name: 'Taurus SC Termiticide',
      offers: [
        { '@type': 'Offer', name: 'Taurus SC Termiticide', price: '48.48', priceCurrency: 'USD', availability: 'InStock' },
        { '@type': 'Offer', name: 'Taurus SC Termiticide 78 oz.', price: '95', priceCurrency: 'USD', availability: 'InStock' },
      ],
    });
    test('JSON-LD variant match wins', () => {
      const snap = { jsonLd: [variantLd], priceTexts: ['$48.48'], title: 'Taurus SC Termiticide' };
      expect(offerFromSnapshot(snap, { targetOz: 78 }).price).toBe(95);
    });
    test('JSON-LD has offers but none match target -> null, NOT the DOM default', () => {
      // Without the gate this would return the $48.48 DOM price as the 78 oz.
      const snap = { jsonLd: [variantLd], priceTexts: ['$48.48'], title: 'Taurus SC Termiticide' };
      expect(offerFromSnapshot(snap, { targetOz: 12 })).toBeNull();
    });
    test('no JSON-LD offers -> DOM fallback is used', () => {
      const snap = { jsonLd: [], priceTexts: ['$89.00'], title: 'Taurus SC 78 oz', availabilityText: 'In Stock' };
      const got = offerFromSnapshot(snap, { targetOz: 78 });
      expect(got.price).toBe(89);
      expect(got.availability).toBe('in_stock');
    });
    test('no JSON-LD and no DOM price -> null', () => {
      expect(offerFromSnapshot({ jsonLd: [], priceTexts: ['Call for price'] }, { targetOz: 78 })).toBeNull();
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
    test('skips a discount badge to find the real price', () => {
      expect(extractDomPrice({ priceTexts: ['Save 20%', '$95.00'], title: 'X', availabilityText: 'In Stock' }).price).toBe(95);
    });
  });

  describe('quantityToOz', () => {
    test('bare + descriptor-laden + fractional pack sizes', () => {
      expect(quantityToOz('78 oz')).toBe(78);
      expect(quantityToOz('21 oz can')).toBe(21);
      expect(quantityToOz('18 lb pail')).toBe(288); // 18 * 16
      expect(quantityToOz('1/2 gal')).toBe(64); // 0.5 * 128
    });
    test('count-based / unparseable -> null', () => {
      expect(quantityToOz('each')).toBeNull();
      expect(quantityToOz('6 bait stations')).toBeNull();
      expect(quantityToOz('')).toBeNull();
    });
    test('multipack totals apply the count', () => {
      expect(quantityToOz('4 x 78 oz')).toBe(312); // a case of four 78 oz bottles
      expect(quantityToOz('2 x 2.5 gal')).toBe(640);
    });
    test('mixed number ("2 1/2 gal") is the whole amount, not the fraction', () => {
      expect(quantityToOz('2 1/2 gal')).toBe(320); // 2.5 gal, NOT 0.5 gal (64)
    });
    test('fractional multipack ("2 x 1/2 gal") applies count AND fraction', () => {
      expect(quantityToOz('2 x 1/2 gal')).toBe(128); // 2 * 0.5 gal, NOT 512 or 64
    });
    test('fl oz normalizes (extractSizeToken strips the dot upstream)', () => {
      expect(quantityToOz('30 fl oz')).toBe(30);
    });
  });

  describe('deriveNormalizedUnitPrice', () => {
    test('78 oz jug', () => expect(deriveNormalizedUnitPrice(95, '78 oz')).toBeCloseTo(1.217949, 5));
    test('2.5 gal drum is cheaper per oz', () => expect(deriveNormalizedUnitPrice(300, '2.5 gal')).toBeCloseTo(0.9375, 4));
    test('tolerates packaging descriptors / fractions', () => {
      expect(deriveNormalizedUnitPrice(40, '18 lb pail')).toBeCloseTo(40 / 288, 6);
      expect(deriveNormalizedUnitPrice(120, '1/2 gal')).toBeCloseTo(120 / 64, 6);
    });
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
    test('same brand, different formulation (SC vs CS) -> not matched without EPA', () => {
      // "Taurus CS" shares the brand token but is a different formulation; the
      // short SC/CS codes the tokenizer drops must still block a name match.
      const r = verifyMatch({ name: 'Taurus CS Termiticide 78 oz', quantity: '78 oz' }, expected);
      expect(r.signals.name).toBe(false);
      expect(r.matched).toBe(false);
    });
    test('same brand same formulation still matches', () => {
      const r = verifyMatch({ name: 'Taurus SC Termiticide 78 oz', quantity: '78 oz' }, expected);
      expect(r.signals.name).toBe(true);
      expect(r.matched).toBe(true);
    });
    test('single-char formulation marker (Demand CS vs Demand G) blocks name-only match', () => {
      const demand = { vendorProductName: 'Demand CS', epaReg: '100-1066', packSizeValue: 8, packSizeUnit: 'oz' };
      const r = verifyMatch({ name: 'Demand G 8 oz', quantity: '8 oz' }, demand);
      expect(r.signals.name).toBe(false);
      expect(r.matched).toBe(false);
      const ok = verifyMatch({ name: 'Demand CS 8 oz', quantity: '8 oz', text: 'EPA Reg. No. 100-1066' }, demand);
      expect(ok.matched).toBe(true);
    });
    test('different formulation marker (Bifen I/T vs XTS) needs EPA, not name+size', () => {
      // Brand + "Insecticide" overlap + same size would otherwise pass; the I/T
      // vs XTS formulation marker (a slashed / 3-char code) must block it.
      const bifen = { vendorProductName: 'Bifen I/T Insecticide', epaReg: '279-3206', packSizeValue: 96, packSizeUnit: 'oz' };
      const r = verifyMatch({ name: 'Bifen XTS Insecticide 96 oz', quantity: '96 oz' }, bifen);
      expect(r.signals.name).toBe(false);
      expect(r.matched).toBe(false);
      // the correct formulation at the same size still matches
      const ok = verifyMatch({ name: 'Bifen I/T Insecticide 96 oz', quantity: '96 oz' }, bifen);
      expect(ok.signals.name).toBe(true);
      expect(ok.matched).toBe(true);
    });
    test('generic subset name (brand missing) -> not matched even at right size', () => {
      // "Termiticide 78 oz" shares only the category word with the expected
      // "Taurus SC Termiticide". Without an EPA hit the trust gate must reject it,
      // even though the pack size lines up.
      const r = verifyMatch({ name: 'Termiticide 78 oz', quantity: '78 oz' }, expected);
      expect(r.signals.name).toBe(false);
      expect(r.matched).toBe(false);
    });
    test('matches across a packaging descriptor in the scraped size', () => {
      const r = verifyMatch({ name: 'Taurus SC Termiticide 78 oz jug', quantity: '78 oz jug' }, expected);
      expect(r.signals.packSize).toBe(true);
      expect(r.matched).toBe(true);
    });
    test('epa reg in text rescues a weak name', () => {
      const r = verifyMatch({ name: 'Generic Fipronil 78oz', text: 'EPA Reg No 53883-279', quantity: '78 oz' }, expected);
      expect(r.signals.epa).toBe(true);
      expect(r.matched).toBe(true);
    });
    test('epa matches the distributor-suffixed reg by company-product key', () => {
      const r = verifyMatch({ name: 'X', text: 'EPA Reg. No. 53883-279-83979', quantity: '78 oz' }, expected);
      expect(r.signals.epa).toBe(true);
    });
    test('epa does NOT match across unrelated adjacent numbers', () => {
      // Whole-page digit concat would have spuriously matched 53883279 here; the
      // tokenized check must not. Wrong product, right size -> rejected.
      const r = verifyMatch(
        { name: 'Termidor SC 20 oz $538.83 SKU 2790011', text: 'Order 53,883 units. Call 279-0000.', quantity: '78 oz' },
        expected,
      );
      expect(r.signals.epa).toBe(false);
      expect(r.matched).toBe(false);
    });
    test('no known size -> needs both name and epa', () => {
      const noSize = { productName: 'Taurus SC', vendorProductName: 'Taurus SC Termiticide' };
      const r = verifyMatch({ name: 'Taurus SC Termiticide', quantity: 'each' }, noSize);
      expect(r.sizeKnown).toBe(false);
      expect(r.matched).toBe(false); // name only, no epa
    });
  });
});
