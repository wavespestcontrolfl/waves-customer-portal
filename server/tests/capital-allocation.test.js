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

const src = (sourceKey, source, ltvCac, adSpend, customers, cac = null) => ({
  sourceKey, source, ltvCac, adSpend, customers, cac,
});

describe('rankCapitalAllocation', () => {
  test('bands, ranks (paid desc, no-spend last), and picks headline opportunity + leak', () => {
    const attribution = {
      blendedLtvCac: 5,
      sources: [
        src('facebook', 'Facebook', 0.5, 300, 7),
        src('organic', 'Organic', null, 0, 20),
        src('google_ads', 'Google Ads', 34, 500, 12),
        src('google_lsa', 'Google LSA', 6, 200, 8),
      ],
    };
    const out = rankCapitalAllocation(attribution);

    // ranked: paid channels by LTV:CAC desc, free/no-spend last
    expect(out.channels.map((c) => c.sourceKey)).toEqual(['google_ads', 'google_lsa', 'facebook', 'organic']);

    const g = out.channels.find((c) => c.sourceKey === 'google_ads');
    expect(g.band).toBe('pour_in');
    expect(g.tone).toBe('great');
    expect(g.confidence).toBe('ok');

    expect(out.channels.find((c) => c.sourceKey === 'facebook').band).toBe('losing');
    expect(out.channels.find((c) => c.sourceKey === 'organic').band).toBe('no_spend');

    expect(out.headline.blendedBand).toBe('healthy');
    expect(out.headline.topOpportunity.sourceKey).toBe('google_ads');
    expect(out.headline.biggestLeak.sourceKey).toBe('facebook');
  });

  test('small-N guard: a sky-high ratio off too few customers is flagged + not headlined', () => {
    const out = rankCapitalAllocation({
      blendedLtvCac: 200,
      sources: [src('facebook', 'Facebook', 200, 50, 2)], // only 2 customers
    });
    const fb = out.channels[0];
    expect(fb.band).toBe('pour_in'); // band still reflects the ratio
    expect(fb.confidence).toBe('low'); // but flagged low-confidence
    expect(out.headline.topOpportunity).toBeNull(); // not eligible to be "pour cash in"
  });

  test('biggest leak requires a confident, money-spending losing channel', () => {
    // losing but low-N → not headlined as a leak
    const lowN = rankCapitalAllocation({ blendedLtvCac: 0.4, sources: [src('facebook', 'Facebook', 0.4, 200, 2)] });
    expect(lowN.headline.biggestLeak).toBeNull();
    // losing, confident, real spend → headlined
    const real = rankCapitalAllocation({ blendedLtvCac: 0.4, sources: [src('facebook', 'Facebook', 0.4, 200, 9)] });
    expect(real.headline.biggestLeak.sourceKey).toBe('facebook');
  });

  test('empty attribution → no channels, null headline calls', () => {
    const out = rankCapitalAllocation({ blendedLtvCac: null, sources: [] });
    expect(out.channels).toEqual([]);
    expect(out.headline.topOpportunity).toBeNull();
    expect(out.headline.biggestLeak).toBeNull();
    expect(out.headline.blendedBand).toBe('no_spend');
  });
});
