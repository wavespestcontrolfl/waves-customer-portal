const { rankCapitalAllocation, bandFor } = require('../services/capital-allocation');

describe('bandFor', () => {
  test('maps LTV:CAC to bands at the rule-of-thumb thresholds', () => {
    expect(bandFor(null)).toBe('no_spend');
    expect(bandFor(0.5)).toBe('losing');
    expect(bandFor(1)).toBe('below_target');
    expect(bandFor(2.9)).toBe('below_target');
    expect(bandFor(3)).toBe('healthy');
    expect(bandFor(9.9)).toBe('healthy');
    expect(bandFor(10)).toBe('scale');
    expect(bandFor(29.9)).toBe('scale');
    expect(bandFor(30)).toBe('pour_in');
    expect(bandFor(200)).toBe('pour_in');
  });
});

const src = (sourceKey, source, ltvCac, adSpend, customers, lifetimeValue, cac = null) => ({
  sourceKey, source, ltvCac, adSpend, customers, lifetimeValue, cac,
});

describe('rankCapitalAllocation', () => {
  test('bands, ranks (paid desc, no-spend last), picks opportunity + leak, blends paid-only', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('facebook', 'Facebook', 0.5, 300, 7, 150),
        src('organic', 'Organic', null, 0, 20, 8000),
        src('google_ads', 'Google Ads', 34, 500, 12, 17000),
        src('google_lsa', 'Google LSA', 6, 200, 8, 1200),
      ],
    });

    expect(out.channels.map((c) => c.sourceKey)).toEqual(['google_ads', 'google_lsa', 'facebook', 'organic']);
    const g = out.channels.find((c) => c.sourceKey === 'google_ads');
    expect(g.band).toBe('pour_in');
    expect(g.tone).toBe('great');
    expect(g.confidence).toBe('ok');
    expect(out.channels.find((c) => c.sourceKey === 'facebook').band).toBe('losing');
    expect(out.channels.find((c) => c.sourceKey === 'organic').band).toBe('no_spend');

    // blended = paid lifetime (17000+1200+150) / paid spend (1000) = 18.35 → 18.4
    expect(out.headline.blendedLtvCac).toBe(18.4);
    expect(out.headline.blendedBand).toBe('scale');
    expect(out.headline.topOpportunity.sourceKey).toBe('google_ads');
    expect(out.headline.biggestLeak.sourceKey).toBe('facebook');
  });

  test('blended ratio is paid-only — strong organic cannot mask losing paid spend', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('facebook', 'Facebook', 0.5, 1000, 9, 500), // paid, losing
        src('organic', 'Organic', null, 0, 50, 50000), // free, huge value, no spend
      ],
    });
    // organic's 50k lifetime value must NOT enter the numerator over paid spend
    expect(out.headline.blendedLtvCac).toBe(0.5);
    expect(out.headline.blendedBand).toBe('losing');
  });

  test('biggest leak = most cash wasted, not the worst ratio', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('google_ads', 'Google Ads', 0.9, 5000, 20, 4500), // mild ratio, $500 wasted
        src('facebook', 'Facebook', 0.1, 200, 9, 20), // worst ratio, only $180 wasted
      ],
    });
    // google_ads wastes more absolute cash → it's the bigger leak to cut first
    expect(out.headline.biggestLeak.sourceKey).toBe('google_ads');
  });

  test('small-N guard: a sky-high ratio off too few customers is flagged + not headlined', () => {
    const out = rankCapitalAllocation({
      sources: [src('facebook', 'Facebook', 200, 50, 2, 10000)], // only 2 customers
    });
    const fb = out.channels[0];
    expect(fb.band).toBe('pour_in'); // band still reflects the ratio
    expect(fb.confidence).toBe('low'); // but flagged low-confidence
    expect(out.headline.topOpportunity).toBeNull(); // not eligible to be "pour cash in"
  });

  test('biggest leak requires a confident, money-spending losing channel', () => {
    const lowN = rankCapitalAllocation({ sources: [src('facebook', 'Facebook', 0.4, 200, 2, 80)] });
    expect(lowN.headline.biggestLeak).toBeNull(); // low-N → not headlined
    const real = rankCapitalAllocation({ sources: [src('facebook', 'Facebook', 0.4, 200, 9, 80)] });
    expect(real.headline.biggestLeak.sourceKey).toBe('facebook');
  });

  test('empty attribution → no channels, null headline calls', () => {
    const out = rankCapitalAllocation({ sources: [] });
    expect(out.channels).toEqual([]);
    expect(out.headline.topOpportunity).toBeNull();
    expect(out.headline.biggestLeak).toBeNull();
    expect(out.headline.blendedBand).toBe('no_spend');
  });
});
