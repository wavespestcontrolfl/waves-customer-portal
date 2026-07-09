/**
 * Lead-source vocabulary normalization (read/grouping layer only).
 *
 * Three vocabularies exist: canonical tracking keys (source-names.js), the
 * manual customer-form dropdown (client customerFormOptions.js), and display
 * labels. normalizeLeadSource folds the manual vocabulary into canonical
 * grouping buckets at READ time — stored rows are never mutated — and
 * buildChannelAttribution applies it so manual values stop falling out of the
 * /admin/ads ROI grouping.
 */
const { normalizeLeadSource, formatSourceName, SOURCE_NAMES } = require('../services/source-names');
const { buildChannelAttribution, splitFacebookByPaid } = require('../services/channel-attribution');

describe('normalizeLeadSource — mapping table', () => {
  test('manual "google" groups into organic (organic search; paid clicks are stored google_ads at capture)', () => {
    expect(normalizeLeadSource('google')).toBe('organic');
  });

  test('offline manual channels group into a visible other_manual bucket', () => {
    expect(normalizeLeadSource('phone_call')).toBe('other_manual');
    expect(normalizeLeadSource('door_knock')).toBe('other_manual');
    expect(normalizeLeadSource('field_tech')).toBe('other_manual');
    expect(SOURCE_NAMES.other_manual).toBe('Other (manual)');
    expect(formatSourceName('other_manual')).toBe('Other (manual)');
  });

  test('canonical keys pass through untouched', () => {
    for (const key of Object.keys(SOURCE_NAMES)) {
      expect(normalizeLeadSource(key)).toBe(key);
    }
  });

  test('manual values that already ARE canonical keys stay themselves (facebook / referral / nextdoor / website)', () => {
    expect(normalizeLeadSource('facebook')).toBe('facebook');
    expect(normalizeLeadSource('referral')).toBe('referral');
    expect(normalizeLeadSource('nextdoor')).toBe('nextdoor');
    expect(normalizeLeadSource('website')).toBe('website');
  });

  test('unknown keys pass through unchanged — a visible signal, never silently folded', () => {
    expect(normalizeLeadSource('yelp')).toBe('yelp');
    expect(normalizeLeadSource('manual_entry')).toBe('manual_entry');
    expect(normalizeLeadSource('existing_customer')).toBe('existing_customer');
  });

  test('trims + lowercases; empty/nullish becomes unknown', () => {
    expect(normalizeLeadSource('  Google ')).toBe('organic');
    expect(normalizeLeadSource('')).toBe('unknown');
    expect(normalizeLeadSource(null)).toBe('unknown');
    expect(normalizeLeadSource(undefined)).toBe('unknown');
  });
});

describe('buildChannelAttribution — normalized grouping', () => {
  const row = (lead_source, revenue, gp, customer_id) => ({
    lead_source, completed_revenue: revenue, gross_profit: gp, customer_id,
  });

  test('manual google rows merge into the organic bucket instead of a stray "google" channel', () => {
    const out = buildChannelAttribution([
      row('organic', 100, 60, 'c1'),
      row('google', 50, 30, 'c2'), // manual dropdown value
    ], {});
    const keys = out.sources.map((s) => s.sourceKey);
    expect(keys).toContain('organic');
    expect(keys).not.toContain('google');
    const organic = out.sources.find((s) => s.sourceKey === 'organic');
    expect(organic.revenue).toBe(150);
    expect(organic.customers).toBe(2);
  });

  test('phone_call / door_knock / field_tech rows group under other_manual', () => {
    const out = buildChannelAttribution([
      row('phone_call', 10, 5, 'c1'),
      row('door_knock', 20, 10, 'c2'),
      row('field_tech', 30, 15, 'c3'),
    ], {});
    expect(out.sources.map((s) => s.sourceKey)).toEqual(['other_manual']);
    expect(out.sources[0].revenue).toBe(60);
    expect(out.sources[0].customers).toBe(3);
  });

  test('stored rows are not mutated — normalization only re-keys the grouping', () => {
    const rows = [row('google', 50, 30, 'c2')];
    buildChannelAttribution(rows, {});
    expect(rows[0].lead_source).toBe('google');
  });

  test('splitFacebookByPaid then grouping: a manual unpaid facebook row lands in facebook_organic', () => {
    const completed = splitFacebookByPaid([
      { lead_source: 'facebook', completed_revenue: 40, gross_profit: 20, customer_id: 'c1', fbclid: null, fbc: null, is_paid: null },
    ]);
    const out = buildChannelAttribution(completed, {});
    expect(out.sources.map((s) => s.sourceKey)).toEqual(['facebook_organic']);
  });

  test('cost maps are re-keyed with the same normalization so spend divides into the same bucket as its rows', () => {
    const out = buildChannelAttribution(
      [row('google', 100, 60, 'c1')],
      {},
      { google: 50 }, // fixed cost configured under the manual alias
    );
    const organic = out.sources.find((s) => s.sourceKey === 'organic');
    expect(organic.fixedCost).toBe(50);
    expect(organic.allInSpend).toBe(50);
    expect(organic.roas).toBe(2);
    // and no stray zero-revenue 'google' bucket was seeded
    expect(out.sources.map((s) => s.sourceKey)).toEqual(['organic']);
  });

  test('canonical platform spend keys are unaffected', () => {
    const out = buildChannelAttribution([], { google_ads: 300 });
    expect(out.sources.map((s) => s.sourceKey)).toEqual(['google_ads']);
    expect(out.sources[0].adSpend).toBe(300);
  });
});
