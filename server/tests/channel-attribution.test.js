const { buildChannelAttribution, splitFacebookByPaid } = require('../services/channel-attribution');

const row = (lead_source, completed_revenue, gross_profit, customer_id) => ({
  lead_source, completed_revenue, gross_profit, customer_id,
});

describe('buildChannelAttribution', () => {
  test('computes CAC/ROAS/LTV:CAC per channel from completed leads + platform spend', () => {
    const completed = [
      row('google_ads', 400, 240, 'c1'),
      row('google_ads', 600, 360, 'c2'),
    ];
    const out = buildChannelAttribution(completed, { google_ads: 500 });
    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.revenue).toBe(1000);
    expect(g.grossProfit).toBe(600);
    expect(g.adSpend).toBe(500);
    expect(g.customers).toBe(2);
    expect(g.cac).toBe(250); // 500 / 2
    expect(g.roas).toBe(2); // 1000 / 500
    expect(g.lifetimeValue).toBe(600); // one-time rows → realized GP
    expect(g.ltvCac).toBe(1.2); // 600 / 500
    expect(out.blendedLtvCac).toBe(1.2);
  });

  test('recurring channels use projected 12-mo LTV (not just realized GP) for LTV:CAC', () => {
    const completed = [
      { lead_source: 'google_ads', completed_revenue: 100, gross_profit: 60, projected_ltv_12mo: 720, is_recurring: true, customer_id: 'c1' },
    ];
    const out = buildChannelAttribution(completed, { google_ads: 200 });
    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.grossProfit).toBe(60); // realized still reported separately
    expect(g.lifetimeValue).toBe(720); // projected drives LTV
    expect(g.ltvCac).toBe(3.6); // 720 / 200, not 60/200
  });

  test('recurring row with no projection falls back to realized GP', () => {
    const completed = [
      { lead_source: 'facebook', completed_revenue: 100, gross_profit: 60, projected_ltv_12mo: null, is_recurring: true, customer_id: 'c1' },
    ];
    const out = buildChannelAttribution(completed, { facebook: 60 });
    const fb = out.sources.find((s) => s.sourceKey === 'facebook');
    expect(fb.lifetimeValue).toBe(60);
    expect(fb.ltvCac).toBe(1); // 60 / 60
  });

  test('spend with no completed customers surfaces with cac=null (not 0)', () => {
    // money-losing channel: spend, zero acquisitions — must not read as free ($0 CAC)
    const out = buildChannelAttribution([], { facebook: 300 });
    const fb = out.sources.find((s) => s.sourceKey === 'facebook');
    expect(fb).toBeTruthy(); // seeded from spend even with no leads
    expect(fb.adSpend).toBe(300);
    expect(fb.customers).toBe(0);
    expect(fb.cac).toBeNull();
    expect(fb.roas).toBe(0); // 0 revenue / 300 spend
    expect(fb.ltvCac).toBe(0);
  });

  test('free channel (customers, no spend) → cac 0, null ratios', () => {
    const out = buildChannelAttribution([row('organic', 800, 500, 'c9')], {});
    const o = out.sources.find((s) => s.sourceKey === 'organic');
    expect(o.adSpend).toBe(0);
    expect(o.cac).toBe(0); // free acquisition
    expect(o.roas).toBeNull();
    expect(o.ltvCac).toBeNull();
  });

  test('dedupes customers per channel and totals roll up', () => {
    const completed = [
      row('google_ads', 100, 60, 'c1'),
      row('google_ads', 150, 90, 'c1'), // same customer, two visits
      row('facebook', 200, 120, 'c2'),
    ];
    const out = buildChannelAttribution(completed, { google_ads: 50, facebook: 80 });
    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.customers).toBe(1); // c1 counted once
    expect(g.revenue).toBe(250);
    expect(out.totalAdSpend).toBe(130);
    expect(out.totalGrossProfit).toBe(270);
  });
});

describe('splitFacebookByPaid', () => {
  test('re-maps organic Facebook (no click id) to facebook_organic; keeps paid', () => {
    const rows = [
      { lead_source: 'facebook', fbclid: 'abc', customer_id: 'c1' }, // paid (fbclid)
      { lead_source: 'facebook', fbc: 'fb.1.x', customer_id: 'c2' }, // paid (_fbc)
      { lead_source: 'facebook', fbclid: null, fbc: null, customer_id: 'c3' }, // organic
      { lead_source: 'google_ads', fbclid: null, customer_id: 'c4' }, // untouched
    ];
    const out = splitFacebookByPaid(rows);
    expect(out.map((r) => r.lead_source)).toEqual(['facebook', 'facebook', 'facebook_organic', 'google_ads']);
  });

  test('organic Facebook completions land in their own no-spend bucket, not paid', () => {
    const completed = splitFacebookByPaid([
      { lead_source: 'facebook', fbclid: 'x', completed_revenue: 200, gross_profit: 120, customer_id: 'p1' },
      { lead_source: 'facebook', fbclid: null, fbc: null, completed_revenue: 500, gross_profit: 300, customer_id: 'o1' },
    ]);
    const out = buildChannelAttribution(completed, { facebook: 100 }); // Meta spend only
    const paid = out.sources.find((s) => s.sourceKey === 'facebook');
    const organic = out.sources.find((s) => s.sourceKey === 'facebook_organic');
    expect(paid.grossProfit).toBe(120); // only the paid click counts against Meta spend
    expect(paid.adSpend).toBe(100);
    expect(organic.grossProfit).toBe(300);
    expect(organic.adSpend).toBe(0); // organic has no ad spend → not in paid ratio
    expect(organic.ltvCac).toBeNull();
  });
});
