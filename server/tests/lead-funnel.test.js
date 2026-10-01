const { buildLeadFunnel, buildFunnelBreakdown } = require('../services/lead-funnel');

const row = (lead_source, funnel_stage, n, is_paid = false) => ({ lead_source, funnel_stage, n, is_paid });

describe('buildLeadFunnel', () => {
  test('counts reached-at-least stages cumulatively from current-state rows', () => {
    const out = buildLeadFunnel([
      row('google_ads', 'lead', 4, true),
      row('google_ads', 'contacted', 2, true),
      row('google_ads', 'estimate_viewed', 1, true),
      row('google_ads', 'booked', 2, true),
      row('google_ads', 'completed', 3, true),
    ]);
    const g = out.sources.find((s) => s.sourceKey === 'google_ads');
    expect(g.leads).toBe(12);
    expect(g.contacted).toBe(8); // everything at contacted or beyond
    expect(g.estimate).toBe(6); // estimate_viewed implies estimate reached
    expect(g.booked).toBe(5);
    expect(g.completed).toBe(3);
    expect(g.rates.bookRate).toBe(42); // 5/12
    expect(g.source).toBe('Google Ads');
  });

  test('lost rows count in the lead total and lost only — collapsed history stays honest', () => {
    const out = buildLeadFunnel([
      row('organic', 'lead', 3),
      row('organic', 'lost', 2),
    ]);
    const o = out.sources[0];
    expect(o.leads).toBe(5);
    expect(o.lost).toBe(2);
    expect(o.contacted).toBe(0); // we don't know how far a lost row got — claim nothing
  });

  test('paid/organic topline split classifies by platform key, not the flaky is_paid flag', () => {
    const out = buildLeadFunnel([
      // prod reality: is_paid is NULL on most historical rows — google_ads
      // must still classify as paid.
      row('google_ads', 'completed', 2, null),
      row('google_lsa', 'booked', 1, null),
      row('organic', 'lead', 4, false),
      row('referral', 'completed', 1, false),
    ]);
    expect(out.paid.leads).toBe(3);
    expect(out.paid.completed).toBe(2);
    expect(out.organic.leads).toBe(5);
    expect(out.totals.leads).toBe(8);
    expect(out.sources.find((x) => x.sourceKey === 'google_ads').isPaid).toBe(true);
  });

  test('sources rank by lead volume; unknown key falls back to a readable name', () => {
    const out = buildLeadFunnel([
      row('nextdoor', 'lead', 1),
      row('some_new_channel', 'lead', 5),
    ]);
    expect(out.sources[0].sourceKey).toBe('some_new_channel');
    expect(out.sources[0].source).toBe('Some New Channel');
  });

  test('empty input yields empty sources and zeroed totals, never NaN rates', () => {
    const out = buildLeadFunnel([]);
    expect(out.sources).toEqual([]);
    expect(out.totals).toEqual({ leads: 0, contacted: 0, estimate: 0, booked: 0, completed: 0, lost: 0, revenue: 0, bookRate: 0, completeRate: 0 });
    expect(out.stagesPresent).toEqual({ contacted: false, estimate: false, booked: false });
  });

  test('stagesPresent reflects only rungs that actually carry rows (lead→completed reality)', () => {
    // Today's pipeline writes only lead + completed — the card must not
    // render fictional 0% middle rungs.
    const flat = buildLeadFunnel([
      row('google_ads', 'lead', 5, null),
      row('google_ads', 'completed', 2, null),
    ]);
    expect(flat.stagesPresent).toEqual({ contacted: false, estimate: false, booked: false });
    // A row actually sitting mid-funnel lights its rung up.
    const mid = buildLeadFunnel([
      row('google_ads', 'estimate_viewed', 1, null),
      row('google_ads', 'booked', 1, null),
    ]);
    expect(mid.stagesPresent).toEqual({ contacted: false, estimate: true, booked: true });
  });

  test('string counts from pg are coerced', () => {
    const out = buildLeadFunnel([{ lead_source: 'organic', funnel_stage: 'completed', n: '7', is_paid: false }]);
    expect(out.sources[0].completed).toBe(7);
    expect(out.sources[0].rates.completeRate).toBe(100);
  });
});

describe('facebook organic split', () => {
  test('unpaid facebook rows report as facebook_organic, matching the capital card', () => {
    const out = buildLeadFunnel([
      row('facebook', 'completed', 2, true),
      row('facebook', 'lead', 3, false),
    ]);
    const keys = out.sources.map((s) => s.sourceKey).sort();
    expect(keys).toEqual(['facebook', 'facebook_organic']);
    expect(out.sources.find((s) => s.sourceKey === 'facebook_organic').source).toBe('Facebook (organic)');
    expect(out.paid.leads).toBe(2);
    expect(out.organic.leads).toBe(3);
  });
});

describe('revenue and the other funnel views', () => {
  test('sources and totals carry the completed revenue credited to their rows', () => {
    const out = buildLeadFunnel([
      { lead_source: 'organic', funnel_stage: 'completed', n: 2, revenue: '450.50' },
      { lead_source: 'organic', funnel_stage: 'lead', n: 3, revenue: '0' },
      { lead_source: 'google_ads', funnel_stage: 'completed', n: 1, revenue: 199.99, is_paid: true },
    ]);
    expect(out.sources.find((s) => s.sourceKey === 'organic').revenue).toBe(450.5);
    expect(out.totals.revenue).toBe(650.49);
    expect(out.paid.revenue).toBe(199.99);
  });

  test('a landing-page view funnels exactly like the source view, and an unknown page stays unknown', () => {
    const ants = 'wavespestcontrol.com/pest-control/ants';
    const page = buildFunnelBreakdown([
      { group_key: ants, funnel_stage: 'lead', n: '3', revenue: '0' },
      { group_key: ants, funnel_stage: 'booked', n: 1, revenue: 0 },
      { group_key: ants, funnel_stage: 'completed', n: 1, revenue: '300' },
      { group_key: ants, funnel_stage: 'lost', n: 1, revenue: 0 },
      { group_key: '(unknown)', funnel_stage: 'lead', n: 2, revenue: 0 },
    ], 'page');
    expect(page[0]).toMatchObject({ key: ants, label: ants, leads: 6, booked: 2, completed: 1, lost: 1, revenue: 300 });
    expect(page[0].rates.bookRate).toBe(33);
    expect(page[1]).toMatchObject({ key: '(unknown)', label: '(unknown)', leads: 2 });
    expect(page[0].isPaid).toBeUndefined(); // paid vs organic belongs to the source view only
  });

  test('service and heard-about views read as plain labels; a missing answer is shown as no answer', () => {
    expect(buildFunnelBreakdown([{ group_key: 'tree_shrub', funnel_stage: 'lead', n: 1 }], 'service')[0].label).toBe('Tree & shrub');
    const heard = buildFunnelBreakdown([
      { group_key: 'chatgpt', funnel_stage: 'lead', n: 1 },
      { group_key: '(unknown)', funnel_stage: 'lead', n: 4 },
    ], 'heard');
    expect(heard.map((g) => g.label)).toEqual(['No answer (not asked or skipped)', 'ChatGPT']);
  });
});
