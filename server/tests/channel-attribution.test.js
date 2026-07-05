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

  test('jobs count completed costed visits credited to the channel, not attribution rows', () => {
    const completed = [
      // ONE primary row carries a repeat customer's whole realized total
      // (ad-attribution-sync) — their 5 completed visits are 5 jobs, not 1 row.
      { lead_source: 'google_ads', completed_revenue: 1000, gross_profit: 600, customer_id: 'c1', lead_date: '2026-06-01', created_at: '2026-06-01T10:00:00Z' },
      { lead_source: 'google_ads', completed_revenue: 200, gross_profit: 100, customer_id: 'c2', lead_date: '2026-06-10', created_at: '2026-06-10T09:00:00Z' },
    ];
    const out = buildChannelAttribution(completed, { google_ads: 600 }, {}, { c1: 5, c2: 1 });
    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.jobs).toBe(6); // 5 + 1 visits — repeat visits count
    expect(g.customers).toBe(2);
    expect(g.costPerJob).toBe(100); // 600 / 6 visits
    expect(g.cac).toBe(300); // 600 / 2 customers — different denominator
    expect(out.totalJobs).toBe(6);
  });

  test('a multi-row customer is credited once, on the first-touch row (sync parity)', () => {
    const completed = [
      // Later duplicate row on another source — carries no revenue, gets no
      // jobs. DATE columns arrive as JS Date objects; the first-touch pick
      // must compare chronologically, not by stringified weekday text.
      { lead_source: 'facebook', fbclid: 'x', completed_revenue: 0, gross_profit: 0, customer_id: 'c1', lead_date: new Date('2026-06-20T00:00:00Z'), created_at: new Date('2026-06-20T08:00:00Z') },
      // First-touch row — where ad-attribution-sync wrote the realized total.
      { lead_source: 'google_ads', completed_revenue: 500, gross_profit: 300, customer_id: 'c1', lead_date: new Date('2026-06-01T00:00:00Z'), created_at: new Date('2026-06-01T08:00:00Z') },
    ];
    const out = buildChannelAttribution(completed, {}, {}, { c1: 3 });
    expect(out.sources.find((s) => s.sourceKey === 'google_ads').jobs).toBe(3);
    expect(out.sources.find((s) => s.sourceKey === 'facebook').jobs).toBe(0);
    expect(out.totalJobs).toBe(3); // never double-credited across rows
  });

  test('spend that closed no jobs → costPerJob null (not 0); free channel → 0', () => {
    const out = buildChannelAttribution(
      [{ lead_source: 'organic', completed_revenue: 500, gross_profit: 300, customer_id: 'o1', lead_date: '2026-06-05' }],
      { facebook: 200 },
      {},
      { o1: 1 },
    );
    const fb = out.sources.find((s) => s.sourceKey === 'facebook');
    expect(fb.jobs).toBe(0);
    expect(fb.costPerJob).toBeNull(); // $0/job would read as free acquisition
    const o = out.sources.find((s) => s.sourceKey === 'organic');
    expect(o.jobs).toBe(1);
    expect(o.costPerJob).toBe(0); // genuinely free
  });

  test('fixed cost folds into all-in spend; ratios divide by ad + fixed', () => {
    const completed = [
      row('organic', 1000, 600, 'o1'), // no ad spend, but has an SEO retainer
      row('google_ads', 500, 300, 'g1'),
    ];
    const out = buildChannelAttribution(
      completed,
      { google_ads: 100 }, // platform ad spend
      { organic: 200, google_ads: 50 }, // fixed costs (SEO retainer, mgmt fee)
    );
    const org = out.sources.find((s) => s.sourceKey === 'organic');
    expect(org.adSpend).toBe(0);
    expect(org.fixedCost).toBe(200);
    expect(org.allInSpend).toBe(200);
    expect(org.roas).toBe(5); // 1000 / 200
    expect(org.ltvCac).toBe(3); // 600 / 200 (one-time → realized GP)
    expect(org.cac).toBe(200); // 200 / 1 customer

    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.allInSpend).toBe(150); // 100 ad + 50 fixed
    expect(g.ltvCac).toBe(2); // 300 / 150

    expect(out.totalFixedCost).toBe(250);
    expect(out.totalAllInSpend).toBe(350);
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

  test('a call-sourced row marked is_paid (no fbclid/_fbc) stays paid facebook', () => {
    const rows = [
      { lead_source: 'facebook', fbclid: 'abc', customer_id: 'c1' }, // paid (click id)
      { lead_source: 'facebook', fbclid: null, fbc: null, is_paid: true, customer_id: 'c2' }, // paid call (no cookies)
      { lead_source: 'facebook', fbclid: null, fbc: null, is_paid: null, customer_id: 'c3' }, // organic (unknown)
    ];
    const out = splitFacebookByPaid(rows);
    expect(out.map((r) => r.lead_source)).toEqual(['facebook', 'facebook', 'facebook_organic']);
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

  test('a call-sourced is_paid completion (no click id) counts against Meta spend, not organic', () => {
    const completed = splitFacebookByPaid([
      // Facebook phone call: no fbclid/_fbc, marked paid at record time.
      { lead_source: 'facebook', fbclid: null, fbc: null, is_paid: true, completed_revenue: 400, gross_profit: 240, customer_id: 'call1' },
      // Genuine organic-social completion.
      { lead_source: 'facebook', fbclid: null, fbc: null, completed_revenue: 500, gross_profit: 300, customer_id: 'o1' },
    ]);
    const out = buildChannelAttribution(completed, { facebook: 100 });
    const paid = out.sources.find((s) => s.sourceKey === 'facebook');
    const organic = out.sources.find((s) => s.sourceKey === 'facebook_organic');
    expect(paid.grossProfit).toBe(240); // the paid call is in the paid bucket
    expect(paid.adSpend).toBe(100);
    expect(organic.grossProfit).toBe(300); // organic stays separate
    expect(organic.adSpend).toBe(0);
  });
});
