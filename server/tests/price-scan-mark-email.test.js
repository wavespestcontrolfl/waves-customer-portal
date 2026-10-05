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
  test('included snapshot holds ONLY the matches that made it into the email', () => {
    const noProof = { product: 'No Proof', baseline: { vendor: 'SiteOne', price: 50, quantity: '1 gal' }, competitor: { vendor: 'X', price: 40, quantity: '1 gal' } };
    const pricier = { product: 'Pricier', baseline: { price: 95, quantity: '78 oz' }, competitor: { vendor: 'X', price: 110, quantity: '78 oz', source_url: 'https://x.com/p' } };
    const out = composeMarkEmail([noProof, taurus, pricier]);
    expect(out.includedCount).toBe(1);
    expect(out.included).toHaveLength(1);
    expect(out.included[0]).toBe(taurus); // the exact kept input, not a skipped row
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
      competitor: { vendor: 'Keystone', price: 34, quantity: '10 lb', source_url: 'https://www.domyown.com/k-p' },
    }]);
    expect(out.text).toContain('$4.00/lb');
    expect(out.text).toContain('$3.40/lb');
  });

  test('fluid product renders a readable "fl oz" label, never the internal fl_oz key', () => {
    const out = composeMarkEmail([{
      product: 'Liquid Concentrate',
      baseline: { vendor: 'SiteOne', price: 50, quantity: '32 fl oz' },
      competitor: { vendor: 'V', price: 40, quantity: '32 fl oz', source_url: 'https://www.domyown.com/a-p' },
    }]);
    expect(out).not.toBeNull();
    expect(out.text).toContain('/fl oz');
    expect(out.text).not.toContain('fl_oz');
    expect(out.html).not.toContain('fl_oz');
  });

  test('biggest savings first', () => {
    const small = { product: 'Small Win', baseline: { price: 100, quantity: '10 oz' }, competitor: { vendor: 'V', price: 98, quantity: '10 oz', source_url: 'https://www.domyown.com/a-p' } };
    const big = { product: 'Big Win', baseline: { price: 100, quantity: '10 oz' }, competitor: { vendor: 'V', price: 60, quantity: '10 oz', source_url: 'https://www.domyown.com/b-p' } };
    const out = composeMarkEmail([small, big]);
    expect(out.text.indexOf('Big Win')).toBeLessThan(out.text.indexOf('Small Win'));
  });

  test('escapes HTML in product names', () => {
    const out = composeMarkEmail([{
      product: 'Bug & Weed <Pro>',
      baseline: { price: 10, quantity: '1 lb' },
      competitor: { vendor: 'V', price: 8, quantity: '1 lb', source_url: 'https://www.domyown.com/a-p' },
    }]);
    expect(out.html).toContain('Bug &amp; Weed &lt;Pro&gt;');
    expect(out.html).not.toContain('<Pro>');
  });

  // Sign-off is "Waves Pest Control" only — never "& Lawn Care" (owner
  // ruling 2026-09-28). Checks the composed sign-off line itself, not the
  // shared email-template footer/logo alt text (out of scope here).
  test('signs off as "Waves Pest Control", never "& Lawn Care"', () => {
    const out = composeMarkEmail([taurus]);
    expect(out.text).toContain('Thanks,\nWaves Pest Control');
    expect(out.text).not.toContain('Waves Pest Control & Lawn Care');
    expect(out.html).toContain('Thanks,<br>Waves Pest Control</p>');
  });
});

describe('mark-email delivered prices + shipping proof', () => {
  const FORESTRY = 'https://www.forestrydistributing.com/bifen-it-bifenthrin-insecticide-talstar-control-solution';
  const est = {
    product: 'Bifen I/T',
    baseline: { vendor: 'SiteOne', price: 95, quantity: '1 gal' },
    competitor: { vendor: 'Forestry Distributing', name: 'Bifen I/T Insecticide, 1 Gal.', price: 60, quantity: '1 gal', source_url: FORESTRY },
  };

  test('free-shipping line: delivered = sticker, firm shipping, per-unit on delivered', () => {
    const out = composeMarkEmail([taurus]);
    expect(out.text).toContain('free shipping (firm)');
    expect(out.text).toContain('delivered $89.00');
    expect(out.text).toContain('delivered $95.00'); // SiteOne side too
    expect(out.html).toContain('Delivered $89.00');
    expect(out.text).not.toContain('shipping estimated');
    expect(out.text).not.toContain('Lines marked "shipping estimated"');
  });

  test('estimated shipping is shown as delivered price AND clearly marked "shipping estimated"', () => {
    const out = composeMarkEmail([est]);
    expect(out).not.toBeNull();
    expect(out.text).toContain('$60.00 / 1 gal');
    expect(out.text).toContain('shipping estimated ~$15.00 (not a quote)');
    expect(out.text).toContain('delivered $75.00');
    expect(out.text).toContain('$75.00/gal'); // per-unit on the delivered price
    expect(out.text).toContain('Lines marked "shipping estimated"'); // explainer for the rep
    expect(out.html).toContain('shipping estimated ~$15.00 (not a quote)');
    expect(out.html).toContain('Delivered $75.00');
  });

  test('every proof item Mark needs is on the line', () => {
    const out = composeMarkEmail([est]);
    expect(out.text).toContain('Forestry Distributing'); // competitor name
    expect(out.text).toContain('listed as: Bifen I/T Insecticide, 1 Gal.'); // product as listed
    expect(out.text).toContain('1 gal'); // pack size
    expect(out.text).toContain('$60.00'); // sticker price
    expect(out.text).toContain('delivered $75.00'); // delivered price
    expect(out.text).toContain(FORESTRY); // source URL
    expect(out.html).toContain('Listed as: Bifen I/T Insecticide, 1 Gal.');
  });

  test('savings are judged on delivered prices: a cheaper sticker that loses after shipping is excluded', () => {
    const loses = { ...est, competitor: { ...est.competitor, price: 90 } }; // 90 + 15 est > 95
    expect(composeMarkEmail([loses])).toBeNull();
    expect(savingsPctOf(loses)).toBeLessThan(0);
  });

  test('a forwarded shipping object (from the scan) is used as-is and drives the line', () => {
    const published = {
      ...est,
      competitor: { ...est.competitor, source_url: 'https://gemplers.com/products/x', shipping: { amount: 10.99, basis: 'weight_table', note: '' } },
    };
    const out = composeMarkEmail([published]);
    expect(out.text).toContain('$10.99 shipping by published rule (firm)');
    expect(out.text).toContain('delivered $70.99');
    expect(out.text).not.toContain('shipping estimated');
  });

  test('min-savings default is unchanged: a tiny positive delivered saving still counts', () => {
    const tiny = {
      product: 'Tiny',
      baseline: { vendor: 'SiteOne', price: 100, quantity: '1 gal' },
      competitor: { vendor: 'DoMyOwn', price: 99.5, quantity: '1 gal', source_url: 'https://www.domyown.com/tiny-p-1.html' },
    };
    expect(composeMarkEmail([tiny])).not.toBeNull();
  });
});
