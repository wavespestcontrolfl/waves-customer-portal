const {
  composeMarkEmail,
  perPackUnit,
  perOzEquiv,
  hasProof,
  savingsPctOf,
} = require('../services/price-scan/mark-email');

const PROOF = 'https://www.domyown.com/taurus-sc-termiticide-78-oz-p-1817.html';

const taurus = {
  product: 'Taurus SC Termiticide',
  epaReg: '53883-279',
  baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
  competitor: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: PROOF },
  savingsPct: 0.0632,
};

describe('mark-email per-unit math', () => {
  test('perPackUnit uses the pack\'s own unit', () => {
    expect(perPackUnit(95, '78 oz')).toEqual({ value: 95 / 78, unit: 'oz' });
    expect(perPackUnit(40, '10 lb')).toEqual({ value: 4, unit: 'lb' });
    expect(perPackUnit(300, '2.5 gal')).toEqual({ value: 120, unit: 'gal' });
    expect(perPackUnit(380, '4 x 78 oz')).toEqual({ value: 380 / 312, unit: 'oz' }); // case rolls up
  });
  test('perPackUnit null on unparseable / bad price', () => {
    expect(perPackUnit(95, 'each')).toBeNull();
    expect(perPackUnit(0, '78 oz')).toBeNull();
  });
  test('perOzEquiv normalizes for cross-unit savings', () => {
    expect(perOzEquiv(300, '2.5 gal')).toBeCloseTo(0.9375, 4); // 300 / 320 oz
  });
  test('savingsPctOf always derives from the displayed $/oz prices', () => {
    expect(savingsPctOf(taurus)).toBeCloseTo(0.0632, 4);
    const derived = savingsPctOf({
      baseline: { price: 95, quantity: '78 oz' },
      competitor: { price: 300, quantity: '2.5 gal', source_url: PROOF },
    });
    expect(derived).toBeCloseTo(0.23, 2); // 1.2179 -> 0.9375 per oz
    // a supplied savingsPct does NOT override the prices
    expect(savingsPctOf({ baseline: { price: 95, quantity: '78 oz' }, competitor: { price: 120, quantity: '78 oz' }, savingsPct: 0.5 }))
      .toBeLessThan(0);
  });
});

describe('mark-email proof gate', () => {
  test('hasProof requires an http(s) URL', () => {
    expect(hasProof({ source_url: PROOF })).toBe(true);
    expect(hasProof({ source_url: 'ftp://x' })).toBe(false);
    expect(hasProof({})).toBe(false);
  });
  test('an opportunity with no proof URL is excluded from the email', () => {
    const out = composeMarkEmail([
      taurus,
      { product: 'No Proof', baseline: { vendor: 'SiteOne', price: 50, quantity: '1 gal' }, competitor: { vendor: 'X', price: 40, quantity: '1 gal' } },
    ]);
    expect(out.includedCount).toBe(1);
    expect(out.skipped).toEqual([{ product: 'No Proof', reason: 'no_proof_url' }]);
    expect(out.html).not.toContain('No Proof');
    expect(out.text).not.toContain('No Proof');
  });
  test('returns null when nothing has proof (no email to send)', () => {
    expect(composeMarkEmail([
      { product: 'A', baseline: { price: 1, quantity: '1 oz' }, competitor: { price: 0.5, quantity: '1 oz' } },
    ])).toBeNull();
    expect(composeMarkEmail([])).toBeNull();
  });
  test('a competitor that is NOT cheaper is excluded (no negative-savings ask)', () => {
    const moreExpensive = {
      product: 'Pricier Elsewhere',
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
      competitor: { vendor: 'X', price: 110, quantity: '78 oz', source_url: 'https://x.com/p' }, // higher
    };
    expect(composeMarkEmail([moreExpensive])).toBeNull(); // nothing worth asking
    const out = composeMarkEmail([taurus, moreExpensive]);
    expect(out.includedCount).toBe(1);
    expect(out.skipped).toContainEqual({ product: 'Pricier Elsewhere', reason: 'no_savings' });
    expect(out.html).not.toContain('Pricier Elsewhere');
  });
  test('a supplied (stale) savingsPct cannot override the real prices', () => {
    // Claims 50% savings but the prices show the competitor is dearer -> excluded.
    const lying = {
      product: 'Stale Pct',
      baseline: { price: 95, quantity: '78 oz' },
      competitor: { price: 120, quantity: '78 oz', source_url: 'https://x.com/p' },
      savingsPct: 0.5,
    };
    expect(composeMarkEmail([lying])).toBeNull();
  });
});

describe('mark-email content', () => {
  test('shows per-unit prices (not just total) + proof link, in html and text', () => {
    const out = composeMarkEmail([taurus]);
    // per-unit appears
    expect(out.html).toContain('$1.22/oz');
    expect(out.html).toContain('$1.14/oz');
    expect(out.text).toContain('$1.22/oz');
    expect(out.text).toContain('$1.14/oz');
    // totals + pack sizes present too
    expect(out.text).toContain('$95.00 / 78 oz');
    // proof link present
    expect(out.html).toContain(PROOF);
    expect(out.text).toContain(PROOF);
    // subject summarizes
    expect(out.subject).toMatch(/Price-match request: 1 item/);
    expect(out.subject).toMatch(/6% per unit/);
  });

  test('dry/weight product reads in $/lb', () => {
    const out = composeMarkEmail([{
      product: 'Granular Bait',
      baseline: { vendor: 'SiteOne', price: 40, quantity: '10 lb' },
      competitor: { vendor: 'Keystone', price: 34, quantity: '10 lb', source_url: 'https://k.com/p' },
    }]);
    expect(out.text).toContain('$4.00/lb');
    expect(out.text).toContain('$3.40/lb');
  });

  test('biggest savings first', () => {
    const small = { product: 'Small Win', baseline: { price: 100, quantity: '10 oz' }, competitor: { vendor: 'V', price: 98, quantity: '10 oz', source_url: 'https://a.com/p' } };
    const big = { product: 'Big Win', baseline: { price: 100, quantity: '10 oz' }, competitor: { vendor: 'V', price: 60, quantity: '10 oz', source_url: 'https://b.com/p' } };
    const out = composeMarkEmail([small, big]);
    expect(out.text.indexOf('Big Win')).toBeLessThan(out.text.indexOf('Small Win'));
  });

  test('escapes HTML in product names', () => {
    const out = composeMarkEmail([{
      product: 'Bug & Weed <Pro>',
      baseline: { price: 10, quantity: '1 lb' },
      competitor: { vendor: 'V', price: 8, quantity: '1 lb', source_url: 'https://a.com/p' },
    }]);
    expect(out.html).toContain('Bug &amp; Weed &lt;Pro&gt;');
    expect(out.html).not.toContain('<Pro>');
  });
});
