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

  test('zero-conversion spend is the biggest leak (leak path ignores the small-N guard)', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('google_ads', 'Google Ads', 0, 800, 0, 0), // spent $800, ZERO customers → clearest waste
        src('facebook', 'Facebook', 0.5, 300, 9, 150), // losing but returned something
      ],
    });
    // the 0-customer channel has 0 customers (low confidence) but is still flagged
    expect(out.headline.biggestLeak.sourceKey).toBe('google_ads');
    expect(out.channels.find((c) => c.sourceKey === 'google_ads').band).toBe('losing');
  });

  test('bands off the EXACT ratio, not the display-rounded value', () => {
    // displayed ltvCac rounds to 3.0, but the true ratio (296/100) is 2.96 → below 3:1
    const out = rankCapitalAllocation({ sources: [src('google_ads', 'Google Ads', 3.0, 100, 10, 296)] });
    expect(out.channels[0].band).toBe('below_target'); // not 'healthy'
  });

  test('uses all-in spend (ad + fixed) for the band — a retainer-only channel still ranks', () => {
    const out = rankCapitalAllocation({
      sources: [
        // organic: $0 ad spend but a $200 SEO retainer (allInSpend), LV 600 → 3:1
        { sourceKey: 'organic', source: 'Organic', ltvCac: 3, adSpend: 0, fixedCost: 200, allInSpend: 200, lifetimeValue: 600, customers: 9 },
      ],
    });
    const o = out.channels[0];
    expect(o.band).toBe('healthy'); // 600/200 = 3 → healthy (would be 'no_spend' off adSpend alone)
    expect(out.headline.blendedBand).toBe('healthy');
  });

  test('headline carries the paid-customer count + a small-N confidence flag', () => {
    const out = rankCapitalAllocation({
      sources: [src('google_ads', 'Google Ads', 22.5, 400, 1, 9000)], // 22.5:1 off ONE customer
    });
    expect(out.headline.blendedLtvCac).toBe(22.5);
    expect(out.headline.blendedCustomers).toBe(1);
    expect(out.headline.blendedConfidence).toBe('low'); // 1 < 5 → don't present it as confident
  });

  test('headline is confident once enough paid customers back the blend', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('google_ads', 'Google Ads', 12, 500, 4, 6000),
        src('google_lsa', 'Google LSA', 6, 200, 3, 1200),
      ],
    });
    expect(out.headline.blendedCustomers).toBe(7); // 4 + 3 paid customers
    expect(out.headline.blendedConfidence).toBe('ok'); // 7 >= 5
  });

  test('blended confidence ignores no-spend channels (only paid customers count)', () => {
    const out = rankCapitalAllocation({
      sources: [
        src('google_ads', 'Google Ads', 22.5, 400, 1, 9000), // 1 paid customer
        src('organic', 'Organic', null, 0, 40, 20000), // 40 free customers — must NOT lend confidence
      ],
    });
    expect(out.headline.blendedCustomers).toBe(1); // organic's 40 excluded
    expect(out.headline.blendedConfidence).toBe('low');
  });

  test('empty attribution → no channels, null headline calls', () => {
    const out = rankCapitalAllocation({ sources: [] });
    expect(out.channels).toEqual([]);
    expect(out.headline.topOpportunity).toBeNull();
    expect(out.headline.biggestLeak).toBeNull();
    expect(out.headline.blendedBand).toBe('no_spend');
  });
});
