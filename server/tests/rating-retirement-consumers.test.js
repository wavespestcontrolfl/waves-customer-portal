/**
 * The 1-10 rating (rate page score/submit, portal satisfaction POST) is
 * retired (owner ruling 2026-09-29). This pins that nothing still calls the
 * removed endpoints, and that the history readers of the rows they used to
 * write keep working with no new rows (badges.js, the admin CSAT/NPS reads,
 * the customer sentiment map) — those tables/columns stay; they just stop
 * growing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tests', 'models', '__tests__', 'dev-preview'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|cjs|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
}
const sources = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'client', 'src'))]
  // Comment lines are skipped: review-request.js (off-limits until #5246 merges)
  // still mentions /rate/:token/score in comments about historical draft scores.
  .map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')]);

describe('nothing calls the retired rating endpoints', () => {
  test.each([
    ['rate score', /rate\/\$\{[^}]+\}\/score|\/rate\/[^'"` ]*\/score/],
    ['rate submit', /rate\/\$\{[^}]+\}\/submit|\/rate\/[^'"` ]*\/submit/],
    ['generate-review', /generate-review/],
    ['portal rating client calls', /submitSatisfaction|getPendingSatisfaction/],
    ['portal pending / rating routes', /satisfaction\/pending|['"`]\/satisfaction['"`]/],
  ])('%s', (_name, re) => {
    const hits = sources.filter(([, src]) => re.test(src)).map(([f]) => f);
    expect(hits).toEqual([]);
  });
});

describe('history readers survive with no new rating rows', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('badges.js: review_rockstar is a plain .some() over whatever rows exist — an empty history is simply not earned', () => {
    expect(read('server/routes/badges.js')).toMatch(/earned\.review_rockstar = satisfaction\.some\(s => s\.directed_to_review\)/);
    expect([].some((s) => s.directed_to_review)).toBe(false);
  });

  test('admin CSAT/NPS reads wrap their queries and treat zero responses as null, not an error', () => {
    const dash = read('server/routes/admin-dashboard.js');
    expect(dash).toMatch(/csatResponses > 0\s*\n?\s*\? Math\.round/);
    expect(dash).toMatch(/CSAT query failed/);
    const rev = read('server/routes/admin-reviews.js');
    expect(rev).toMatch(/if \(npsCounts\.total > 0\)/);
    expect(rev).toMatch(/sentiment: sentimentMap\[c\.id\] \|\| 'unknown'/);
  });

  test('customer health never read the rating rows (service_records.rating + interactions only)', () => {
    const health = read('server/services/customer-health.js');
    expect(health).not.toMatch(/satisfaction_responses|review_requests/);
  });
});
