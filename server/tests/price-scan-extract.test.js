const {
  mapAvailability,
  parsePriceText,
  offerPrice,
  extractJsonLdOffer,
  extractDomPrice,
  pickVariantOffer,
  variantsFromOptionCards,
  normalizeSizeLabel,
  offerFromSnapshot,
  extractSizeToken,
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
    test('rejects per-unit / unit prices', () => {
      expect(parsePriceText('$1.22 / oz')).toBeNull();
      expect(parsePriceText('$1.22/oz')).toBeNull();
      expect(parsePriceText('$0.94 per lb')).toBeNull();
      expect(parsePriceText('$50 each')).toBeNull();
      expect(parsePriceText('$95.00')).toBe(95); // package price still fine
    });
    test('rejects dollar promo / reference / starting-at badges', () => {
      expect(parsePriceText('Save $20')).toBeNull();
      expect(parsePriceText('$20 off')).toBeNull();
      expect(parsePriceText('Free shipping over $50')).toBeNull();
      expect(parsePriceText('Was $99')).toBeNull();
      expect(parsePriceText('Starting at $48.48')).toBeNull();
      expect(parsePriceText('From $48.48')).toBeNull();
      expect(parsePriceText('$95.00')).toBe(95);
    });
    test('rejects bare pack-size labels (singular, plural, multipack)', () => {
      expect(parsePriceText('78 oz')).toBeNull();
      expect(parsePriceText('2.5 gal')).toBeNull();
      expect(parsePriceText('18 lb')).toBeNull();
      // plurals + multipack the old regex missed
      expect(parsePriceText('78 ounces')).toBeNull();
      expect(parsePriceText('18 lbs')).toBeNull();
      expect(parsePriceText('2 gallons')).toBeNull();
      expect(parsePriceText('1,000 mL')).toBeNull();
      expect(parsePriceText('4 x 30 g')).toBeNull();
      expect(parsePriceText('30 fl. oz.')).toBeNull(); // dotted abbreviation
      expect(parsePriceText('$95.00')).toBe(95); // a real price has no size unit
      expect(parsePriceText('95')).toBe(95);
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
      expect(mapAvailability('No stock')).toBe('out_of_stock');
      expect(mapAvailability('No stock available')).toBe('out_of_stock');
      expect(mapAvailability('whatever')).toBe('unknown');
      expect(mapAvailability('')).toBe('unknown');
    });
    test('negated in-stock / availability phrases are out of stock', () => {
      // The positive "in stock" regex would otherwise match inside these.
      expect(mapAvailability('Not in stock')).toBe('out_of_stock');
      expect(mapAvailability('Not currently in stock')).toBe('out_of_stock');
      expect(mapAvailability('Not available')).toBe('out_of_stock');
      expect(mapAvailability('No longer available')).toBe('out_of_stock');
      expect(mapAvailability('No longer in stock')).toBe('out_of_stock');
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
    test('non-USD string prices are rejected (no priceCurrency to flag them)', () => {
      expect(offerPrice({ price: 'CA$95' })).toBeNull();
      expect(offerPrice({ price: '€95' })).toBeNull();
      expect(offerPrice({ price: 'EUR 95' })).toBeNull();
      expect(offerPrice({ price: '95.00' })).toBe(95); // plain string price ok
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
    test('AggregateOffer wrapping nested concrete variant offers is expanded', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'Taurus SC',
        offers: {
          '@type': 'AggregateOffer',
          offers: [
            { '@type': 'Offer', name: 'Taurus SC 78 oz.', price: '95', priceCurrency: 'USD', availability: 'InStock' },
            { '@type': 'Offer', name: 'Taurus SC 20 oz.', price: '48.48', priceCurrency: 'USD' },
          ],
        },
      });
      expect(extractJsonLdOffer([ld], { targetOz: 78 }).price).toBe(95); // matches the nested 78 oz variant
    });
    test('competingSameSize flagged when TWO distinct same-size products are on the page', () => {
      const main = JSON.stringify({ '@type': 'Product', name: 'Taurus SC Termiticide 78 oz', offers: { '@type': 'Offer', name: 'Taurus SC Termiticide 78 oz', price: '95', priceCurrency: 'USD', availability: 'InStock' } });
      const related = JSON.stringify({ '@type': 'Product', name: 'Related Termiticide 78 oz', offers: { '@type': 'Offer', name: 'Related Termiticide 78 oz', price: '70', priceCurrency: 'USD', availability: 'InStock' } });
      const got = extractJsonLdOffer([main, related], { targetOz: 78 });
      expect(got.price).toBe(70); // cheapest same-size wins...
      expect(got.competingSameSize).toBe(true); // ...so the body-EPA gate must tighten
    });
    test('competingSameSize is false for a single same-size offer', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'Taurus SC 78 oz', offers: { '@type': 'Offer', name: 'Taurus SC 78 oz', price: '95', priceCurrency: 'USD', availability: 'InStock' } });
      expect(extractJsonLdOffer([ld], { targetOz: 78 }).competingSameSize).toBe(false);
    });
    test('nested AggregateOffer children inherit the parent currency (not USD)', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'X',
        offers: { '@type': 'AggregateOffer', priceCurrency: 'CAD', offers: [{ '@type': 'Offer', name: 'X 78 oz', price: '95' }] },
      });
      expect(extractJsonLdOffer([ld], { targetOz: 78 }).currency).toBe('CAD');
    });
    test('nested AggregateOffer children inherit the parent availability', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'X 78 oz',
        offers: { '@type': 'AggregateOffer', availability: 'OutOfStock', offers: [{ '@type': 'Offer', name: 'X 78 oz', price: '95', priceCurrency: 'USD' }] },
      });
      expect(extractJsonLdOffer([ld], { targetOz: 78 }).availability).toBe('out_of_stock');
    });
    test('prefers in-stock offer over out-of-stock', () => {
      const oos = JSON.stringify({ '@type': 'Product', name: 'A', offers: { price: 80, availability: 'OutOfStock' } });
      const ins = JSON.stringify({ '@type': 'Product', name: 'A', offers: { price: 90, availability: 'InStock' } });
      const got = extractJsonLdOffer([oos, ins]);
      expect(got.price).toBe(90);
      expect(got.availability).toBe('in_stock');
    });
    test('among same-rank in-stock offers, picks the cheapest (sale over MSRP)', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'A',
        offers: [
          { '@type': 'Offer', price: 99, availability: 'InStock' },
          { '@type': 'Offer', price: 89, availability: 'InStock' },
        ],
      });
      expect(extractJsonLdOffer([ld]).price).toBe(89);
    });
    test('a buyable unknown beats an unbuyable backorder', () => {
      const ld = JSON.stringify({
        '@type': 'Product', name: 'A',
        offers: [
          { '@type': 'Offer', price: 50, availability: 'BackOrder' },
          { '@type': 'Offer', price: 90 }, // no availability -> unknown
        ],
      });
      const got = extractJsonLdOffer([ld]);
      expect(got.price).toBe(90);
      expect(got.availability).toBe('unknown');
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
    test('a single offer with no size token is NOT accepted for a size-specific scan', () => {
      // Only a default/starting-variant price, no size to tie to 78 oz.
      const ld = JSON.stringify({ '@type': 'Product', name: 'Taurus SC Termiticide', offers: { price: 48.48, priceCurrency: 'USD', availability: 'InStock' } });
      expect(extractJsonLdOffer([ld], { targetOz: 78 })).toBeNull();
      expect(extractJsonLdOffer([ld]).price).toBe(48.48); // without a target it's fine
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
    test('DOM fallback used only when the title substantiates the target size', () => {
      // title carries the matching size -> trust the DOM price
      const ok = { jsonLd: [], priceTexts: ['$89.00'], title: 'Taurus SC 78 oz', availabilityText: 'In Stock' };
      expect(offerFromSnapshot(ok, { targetOz: 78 }).price).toBe(89);
      // title has NO size -> can't tie the DOM price to 78 oz -> null
      expect(offerFromSnapshot({ jsonLd: [], priceTexts: ['$48.48'], title: 'Taurus SC Termiticide' }, { targetOz: 78 })).toBeNull();
      // title is a DIFFERENT size -> null (don't report a 20 oz price as 78 oz)
      expect(offerFromSnapshot({ jsonLd: [], priceTexts: ['$48.48'], title: 'Taurus SC 20 oz' }, { targetOz: 78 })).toBeNull();
      // no targetOz -> size gate doesn't apply
      expect(offerFromSnapshot({ jsonLd: [], priceTexts: ['$48.48'], title: 'Taurus SC' }).price).toBe(48.48);
    });
    test('no JSON-LD and no DOM price -> null', () => {
      expect(offerFromSnapshot({ jsonLd: [], priceTexts: ['Call for price'] }, { targetOz: 78 })).toBeNull();
    });
    test('DOM out-of-stock overrides a JSON-LD offer with unknown availability', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'Taurus SC 78 oz', offers: { price: 95, priceCurrency: 'USD' } });
      const got = offerFromSnapshot({ jsonLd: [ld], title: 'Taurus SC 78 oz', availabilityText: 'Out of stock' }, { targetOz: 78 });
      expect(got.availability).toBe('out_of_stock');
    });
    test('explicit JSON-LD availability is not overridden by the DOM', () => {
      const ld = JSON.stringify({ '@type': 'Product', name: 'X', offers: { price: 95, availability: 'InStock' } });
      expect(offerFromSnapshot({ jsonLd: [ld], availabilityText: 'Out of stock' }, {}).availability).toBe('in_stock');
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
    test('skips non-USD DOM prices (assumed USD otherwise)', () => {
      expect(extractDomPrice({ priceTexts: ['CA$95', '$89.00'], title: 'X', availabilityText: 'In Stock' }).price).toBe(89);
      expect(extractDomPrice({ priceTexts: ['€95', 'EUR 95'], title: 'X' })).toBeNull();
      expect(extractDomPrice({ priceTexts: ['£95'], title: 'X' })).toBeNull();
    });
    test('skips a unit-price snippet to find the package price', () => {
      expect(extractDomPrice({ priceTexts: ['$1.22 / oz', '$95.00'], title: 'X', availabilityText: 'In Stock' }).price).toBe(95);
    });
    test('skips a discount badge to find the real price', () => {
      expect(extractDomPrice({ priceTexts: ['Save 20%', '$95.00'], title: 'X', availabilityText: 'In Stock' }).price).toBe(95);
    });
  });

  describe('extractSizeToken comma sizes', () => {
    test('thousands separator ("1,000 mL") is parsed, not split at the comma', () => {
      expect(extractSizeToken('Concentrate 1,000 mL')).toBe('1000 mL');
      expect(quantityToOz(extractSizeToken('Concentrate 1,000 mL'))).toBeCloseTo(33.814, 2);
    });
    test('container multipack ("4 tubes / 30 grams") keeps the count', () => {
      expect(extractSizeToken('Advion Cockroach Gel Bait 4 tubes / 30 grams')).toBe('120 gram'); // 4 x 30 g
      expect(quantityToOz(extractSizeToken('Advion Cockroach Gel Bait 4 tubes / 30 grams'))).toBeCloseTo(4.23, 2);
    });
    test('container multipack with a fractional unit size ("2 bottles / 1/2 gal")', () => {
      expect(extractSizeToken('Concentrate 2 bottles / 1/2 gal')).toBe('1 gal'); // 2 x 0.5 gal, NOT 0.5 or 4 gal
      expect(quantityToOz(extractSizeToken('Concentrate 2 bottles / 1/2 gal'))).toBe(128);
      // parsePackSize handles the raw form directly too (1 gal, not 4 gal)
      expect(quantityToOz('2 bottles / 1/2 gal')).toBe(128);
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
    test('a plural unit abbreviation ("25 lbs" vs "25 lb") is not a formulation mismatch', () => {
      const exp = { vendorProductName: 'Talstar Granules 25 lbs', epaReg: '279-3206', packSizeValue: 25, packSizeUnit: 'lb' };
      const r = verifyMatch({ name: 'Talstar Granules 25 lb', quantity: '25 lb' }, exp);
      expect(r.signals.name).toBe(true);
      expect(r.matched).toBe(true);
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
    test('body-only EPA does NOT verify a weak name when the page had competing same-size offers', () => {
      // Multi-offer page: a cheaper RELATED 78 oz product was selected, but the
      // body EPA belongs to the main product. competingOffers makes the body-only
      // EPA untrustworthy on its own, so the name must corroborate (it doesn't).
      const r = verifyMatch(
        { name: 'Generic Fipronil 78oz', text: 'EPA Reg No 53883-279', quantity: '78 oz', competingOffers: true },
        expected,
      );
      expect(r.signals.epa).toBe(true); // the EPA token IS present on the page
      expect(r.matched).toBe(false); // ...but not trusted to verify a different-named offer
    });
    test('competingOffers still matches when the EPA is in the offer OWN name', () => {
      // EPA tied to the selected offer's own name is strong even amid competing offers.
      const r = verifyMatch(
        { name: 'Fipronil 9.1% 53883-279 78oz', quantity: '78 oz', competingOffers: true },
        expected,
      );
      expect(r.matched).toBe(true);
    });
    test('competingOffers still matches when the name independently corroborates', () => {
      const r = verifyMatch(
        { name: 'Taurus SC Termiticide 78 oz', text: 'EPA Reg No 53883-279', quantity: '78 oz', competingOffers: true },
        expected,
      );
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

  describe('normalizeSizeLabel', () => {
    test('normalizes the gram abbreviation "gm"/"gms" to "gram" (NOT bare "g")', () => {
      // Must be "gram": extractSizeToken rejects a lone "g" on a single-size label, so
      // "30g" would be dropped — "30 gram" parses. Both single and multipack forms covered.
      expect(normalizeSizeLabel('Pack (4x30gm)')).toBe('Pack (4x30 gram)');
      expect(normalizeSizeLabel('30 gm')).toBe('30 gram');
      expect(normalizeSizeLabel('30gms')).toBe('30 gram');
      // and the normalized forms actually parse:
      expect(quantityToOz(extractSizeToken(normalizeSizeLabel('30 gm')))).toBeCloseTo(1.06, 2); // single 30 g
      expect(quantityToOz(extractSizeToken(normalizeSizeLabel('Pack (4x30gm)')))).toBeCloseTo(4.23, 2); // 4 x 30 g
    });
    test('leaves a label with no gram abbreviation untouched', () => {
      expect(normalizeSizeLabel('1 Gallon')).toBe('1 Gallon');
      expect(normalizeSizeLabel('32 Ounce')).toBe('32 Ounce');
    });
  });

  describe('pickVariantOffer (Magento-style size-explicit variants)', () => {
    const variants = [
      { size: '8 Ounce', price: 33.34 },
      { size: '64 Ounce', price: 98.99 },
      { size: '1 Gallon', price: 318.9 },
    ];
    test('matches the requested pack among multiple variants', () => {
      const got = pickVariantOffer(variants, { targetOz: 128 }); // 1 gallon
      expect(got).toMatchObject({ price: 318.9, quantity: '1 Gallon' });
    });
    test('returns a CANONICAL size token so downstream quantityToOz agrees with the match', () => {
      // "Pack (4x30gm)" must become "4 x 30 g" — quantityToOz drops the 4x on the raw label.
      const got = pickVariantOffer([{ size: 'Pack (4x30gm)', price: 20.36 }], { targetOz: quantityToOz('4 x 30g tubes') });
      expect(got.price).toBe(20.36);
      expect(quantityToOz(got.quantity)).toBeCloseTo(quantityToOz('4 x 30g tubes'), 2);
    });
    test('size not offered -> null (never substitutes a different variant)', () => {
      expect(pickVariantOffer(variants, { targetOz: 16 })).toBeNull(); // no 16 oz variant
    });
    test('a SINGLE-gram variant label ("30 gm") still matches (codex P1 regression)', () => {
      const got = pickVariantOffer([{ size: '30 gm', price: 9.5 }], { targetOz: quantityToOz('30 gram') });
      expect(got).toMatchObject({ price: 9.5 });
      expect(quantityToOz(got.quantity)).toBeCloseTo(1.06, 2);
    });
    test('among same-size variants, prefers in-stock then cheapest, flags competingSameSize', () => {
      const same = [
        { size: '32 oz', price: 50, availabilityRaw: 'InStock' },
        { size: '32 oz', price: 40, availabilityRaw: 'Out of stock' },
      ];
      const got = pickVariantOffer(same, { targetOz: 32 });
      expect(got).toMatchObject({ price: 50, availability: 'in_stock', competingSameSize: true });
    });
    test('no targetOz -> null (cannot pick a variant without a target size)', () => {
      expect(pickVariantOffer(variants, {})).toBeNull();
    });
    test('per-child stock (jsonConfig salable) flows through: an OOS variant reports out_of_stock', () => {
      // collectSnapshot sets availabilityRaw to the schema enum forms from the salable map.
      const got = pickVariantOffer([{ size: '32 oz', price: 40, availabilityRaw: 'OutOfStock' }], { targetOz: 32 });
      expect(got).toMatchObject({ price: 40, availability: 'out_of_stock' }); // compare will exclude it
      const ok = pickVariantOffer([{ size: '32 oz', price: 45, availabilityRaw: 'InStock' }], { targetOz: 32 });
      expect(ok).toMatchObject({ price: 45, availability: 'in_stock' });
    });
  });

  describe('variantsFromOptionCards (DoMyOwn-style "<label> (<size>) $<price>")', () => {
    test('parses the parenthesized size + price from card text', () => {
      expect(variantsFromOptionCards(['jug (2.5 gal) $299.98', 'gallon (128 oz) $135.40'])).toEqual([
        { size: '2.5 gal', price: 299.98, availabilityRaw: null },
        { size: '128 oz', price: 135.40, availabilityRaw: null },
      ]);
    });
    test('handles a thousands comma and a sold-out card', () => {
      expect(variantsFromOptionCards(['drum (30 gal) $1,234.56'])[0]).toMatchObject({ size: '30 gal', price: 1234.56 });
      expect(variantsFromOptionCards(['quart (32 oz) $99.00 Out of Stock'])[0].availabilityRaw).toBe('OutOfStock');
    });
    test('skips cards with no size or no price', () => {
      expect(variantsFromOptionCards(['Add to cart', 'Free shipping', '(no price here)'])).toEqual([]);
    });
    test('feeds pickVariantOffer end-to-end (DoMyOwn quart 32 oz)', () => {
      const v = variantsFromOptionCards(['bottle (1.33 oz) $19.98', 'bottle (20 oz) $131.01', 'quart (32 oz) $164.53']);
      expect(pickVariantOffer(v, { targetOz: 32 })).toMatchObject({ price: 164.53, quantity: '32 oz' });
    });
  });

  describe('offerFromSnapshot (size-explicit variants)', () => {
    const variants = [{ size: '8 Ounce', price: 33.34 }, { size: '1 Gallon', price: 318.9 }];
    test('derives variants from optionCardTexts when there is no structured variants array', () => {
      const snap = { jsonLd: [], title: 'SpeedZone Southern Herbicide EW', optionCardTexts: ['jug (2.5 gal) $299.98', 'gallon (128 oz) $135.40'] };
      expect(offerFromSnapshot(snap, { targetOz: 320 })).toMatchObject({ price: 299.98, quantity: '2.5 gal' });
    });
    test('a matching variant wins and carries its size as the quantity', () => {
      const snap = { jsonLd: [], title: 'Primo Maxx', variants };
      const got = offerFromSnapshot(snap, { targetOz: 128 });
      expect(got).toMatchObject({ price: 318.9, name: 'Primo Maxx', quantity: '1 Gallon' });
    });
    test('no variant matches -> FALLS THROUGH to the conservative JSON-LD/DOM path (not a hard null)', () => {
      // 78 oz isn't a variant, but the DOM title substantiates it -> DOM fallback still applies.
      const snap = { jsonLd: [], priceTexts: ['$89.00'], title: 'Taurus SC 78 oz', variants };
      expect(offerFromSnapshot(snap, { targetOz: 78 }).price).toBe(89);
    });
    test('a variant offer is flagged fromVariant and does NOT inherit page-level stock text', () => {
      // availabilityText is the default selection's stock, not the matched child's — the
      // variant must keep its per-child availability (here unknown), never the page text.
      const snap = { jsonLd: [], title: 'Primo Maxx', availabilityText: 'Out of stock', variants };
      const got = offerFromSnapshot(snap, { targetOz: 128 });
      expect(got).toMatchObject({ price: 318.9, availability: 'unknown', fromVariant: true });
    });
  });
});
