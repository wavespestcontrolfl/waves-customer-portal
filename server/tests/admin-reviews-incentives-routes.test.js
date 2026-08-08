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
