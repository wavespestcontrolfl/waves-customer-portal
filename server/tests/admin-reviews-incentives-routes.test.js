const fs = require('fs');
const path = require('path');

describe('admin review incentive routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-reviews.js'), 'utf8');

  test.each([
    ['get', '/incentives'],
    ['get', '/incentives/attribution-queue'],
    ['get', '/incentives/attribution-candidates'],
    ['post', '/incentives/attribute'],
    ['post', '/incentives/sync'],
    ['patch', '/incentives/policy'],
    ['post', '/incentives/mark-paid'],
    ['get', '/incentives/export'],
  ])('%s %s is admin-only', (method, route) => {
    const pattern = new RegExp(`router\\.${method}\\('${route.replace(/\//g, '\\/')}',\\s*requireAdmin,`);
    expect(source).toMatch(pattern);
  });
});

describe('GET /api/admin/reviews/stats — removed reviews excluded everywhere', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-reviews.js'), 'utf8');

  test('every google_reviews aggregate in the stats endpoint carries the live-row predicate', () => {
    // The endpoint returns one JSON object — a stamped (Google-removed) review
    // leaking into ANY of its aggregates makes the response internally
    // inconsistent (codex r22). Contract: within the stats handler, every
    // google_reviews query filters missing_since.
    const start = source.indexOf('// GET /api/admin/reviews/stats');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('router.', source.indexOf('ratingBreakdown', start));
    const section = source.slice(start, end === -1 ? undefined : end);
    const aggregates = section.split("db('google_reviews')").length - 1;
    const filtered = section.split("whereNull('missing_since')").length - 1;
    expect(aggregates).toBeGreaterThanOrEqual(4); // response times, unanswered, monthly, breakdown
    expect(filtered).toBe(aggregates);
  });
});

describe('GET /api/admin/reviews/send-time-preview — staff-scoped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-reviews.js'), 'utf8');

  test('mounted ahead of the router-wide admin guard with its own auth + tech-or-admin check (codex #4140 r1)', () => {
    // The shared CompletionPanel is used by technicians; a route after
    // router.use(adminAuthenticate, requireAdmin) can never widen access.
    const route = source.indexOf("router.get('/send-time-preview', adminAuthenticate, requireTechOrAdmin,");
    const guard = source.indexOf('router.use(adminAuthenticate, requireAdmin);');
    expect(route).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(route);
  });

  test('previews the plan bucket, the send-window gate, and the bundling verdict — not just an instant (codex #4140 r4)', () => {
    const start = source.indexOf("router.get('/send-time-preview'");
    const end = source.indexOf('router.use(adminAuthenticate, requireAdmin);');
    const handler = source.slice(start, end);
    // The panel compares `bucket`; the instant alone can never match twice for a relative rule.
    expect(handler).toContain('calculateReviewSendPlan(new Date(), serviceType, { jitter: false })');
    expect(handler).toMatch(/bucket: plan \? plan\.bucket : `legacy:\+\$\{ReviewService\.LEGACY_REVIEW_DELAY_MINUTES\}m`/);
    // The hold copy is conditional on the gate the server actually consults.
    expect(handler).toContain("smsSendWindowEnabled: isEnabled('smsSendWindow')");
    // Bundling is the server's verdict (legacy path AND no report-v1 delivery); unknown never claims a bundle.
    // "Legacy path" is the RAW cadence gate, the same predicate completion's
    // shouldBundleReview reads — not the cron-ANDed effective state, which
    // would claim a bundle completion refuses when cadences are on and the
    // cron is dark (codex #4140 r17 P2).
    expect(handler).toContain("const reviewCadenceGate = isEnabled('reviewSequences');");
    expect(handler).toContain('bundlesImmediateAsk: !reviewCadenceGate && serviceReportV1Delivery === false');
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toContain("const reviewCadenceEnabled = require('../config/feature-gates').isEnabled('reviewSequences');");
    expect(completion).toMatch(/const shouldBundleReview =[\s\S]*?!reviewCadenceEnabled;/);
    // The panel rounds a custom time to the worker tick the server names (r5 P2).
    expect(handler).toContain('cadenceTickMinutesOfHour: ReviewService.__private.REVIEW_CADENCE_TICK_MINUTES');
    // Cadence mode is the EFFECTIVE worker state — both gates (codex #4140 r15 P1).
    expect(handler).toContain("const schedulerEnabled = isEnabled('cronJobs');");
    expect(handler).toContain('const reviewSequencesEnabled = reviewCadenceGate && schedulerEnabled;');
    expect(handler).toContain('schedulerEnabled,');
  });
});
