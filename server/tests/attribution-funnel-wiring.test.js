/**
 * Attribution funnel integrity — wiring guards.
 *
 * Found in the 2026-07-01 tracking audit: 4 of the 49 main_site leads missing
 * an ad_service_attribution row in 30 days came from the quote wizard —
 * public-quote.js created the lead AND the customer but never stamped a funnel
 * row, so wizard leads were invisible to /admin/ads revenue attribution even
 * after they paid. Also: no ASA insert anywhere set is_paid, so even gclid
 * rows sat at NULL and the paid views undercounted; and syncCustomerAdAttribution's
 * only live trigger was job-costing at visit completion, so a funnel row created
 * after the visits completed could never advance.
 *
 * These are source-pattern guards (house style for route wiring — see
 * public-quote-mirror-refresh.test.js): they pin the inserts/cron in place so a
 * refactor can't silently drop them.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

describe('public-quote ad_service_attribution wiring', () => {
  const src = read('../routes/public-quote.js');

  test('stamps a funnel row keyed by the shared source_type map', () => {
    expect(src).toMatch(/attributionForSourceType\(sourceMeta\.sourceType\)/);
    expect(src).toMatch(/db\('ad_service_attribution'\)\.insert\(/);
  });

  test('dedupes on lead_id against webhook/re-submit rows', () => {
    expect(src).toMatch(/\.onConflict\('lead_id'\)\.ignore\(\)/);
  });

  test('carries the paid flag from the shared map, not a local guess', () => {
    expect(src).toMatch(/is_paid:\s*channelAttr\.isPaid\s*&&\s*sourceMeta\.isPaidClick/);
  });

  test('skips the funnel row entirely when the source has no mapped channel (fail-closed)', () => {
    expect(src).toMatch(/if\s*\(channelAttr\)\s*\{/);
  });
});

describe('lead-webhook is_paid wiring', () => {
  const src = read('../routes/lead-webhook.js');

  test('stamps is_paid from the classifier channel', () => {
    expect(src).toMatch(/is_paid:\s*leadSource\.channel\s*===\s*'paid'/);
  });
});

describe('scheduler ad-attribution sweep wiring', () => {
  const src = read('../services/scheduler.js');

  test('daily sweep cron exists, serialized, before the 6:40/6:45 conversion uploads', () => {
    expect(src).toMatch(/cron\.schedule\('15 6 \* \* \*'/);
    expect(src).toMatch(/runExclusive\('ad-attribution-sweep'/);
    expect(src).toMatch(/sweepPendingAdAttribution/);
  });

  test('default-ON with an explicit opt-out (a repair job must not ship dark)', () => {
    expect(src).toMatch(/AD_ATTRIBUTION_SWEEP_DISABLED/);
  });
});
