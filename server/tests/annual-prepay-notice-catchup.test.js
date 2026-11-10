// GATE_MONEY_NOTICE_CATCHUP, annual-prepay 30/15/7 notices (owner 2026-11-06, "jobs 1-6"):
// the shared ladder matched `term_end = today + N` (or the last-visit anchor) exactly, so a
// lost 10:12 tick dropped that day's notice. Gate on, each rung matches an anchor whose
// notice day passed at most NOTICE_CATCHUP_DAYS ago, still only when that rung's sent
// column is empty and its claim is free, and never once a LATER rung was already sent.
// Gate off, every rung keeps the exact-day match (BETWEEN d AND d).
//
// The db here is a real knex query builder (pg dialect, no connection): each candidate
// query is compiled to SQL and its bindings read back. Real-SQL behavior (a sent rung is
// not matched again on the next day) is in annual-prepay-notice-catchup-postgres.test.js.
const knex = require('knex')({ client: 'pg' });

const mockBuilt = [];
jest.mock('../models/db', () => {
  const real = require('knex')({ client: 'pg' });
  return jest.fn((table) => {
    const qb = real(table);
    mockBuilt.push(qb);
    qb.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return qb;
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _private } = require('../services/annual-prepay-renewals');

const TODAY = '2026-11-10';
const plus = (n) => _private.addDaysYmd(TODAY, n);

const savedGate = process.env.GATE_MONEY_NOTICE_CATCHUP;
beforeEach(() => {
  mockBuilt.length = 0;
  delete process.env.GATE_MONEY_NOTICE_CATCHUP;
});
afterAll(async () => {
  if (savedGate === undefined) delete process.env.GATE_MONEY_NOTICE_CATCHUP;
  else process.env.GATE_MONEY_NOTICE_CATCHUP = savedGate;
  await knex.destroy();
});

// One compiled candidate query per rung, in ladder order (30, 15, 7).
async function ladderQueries() {
  await expect(_private.runGenericNoticeLadder(TODAY, true)).resolves.toBe(0);
  expect(mockBuilt).toHaveLength(3);
  return mockBuilt.map((qb) => qb.toSQL());
}

// The [from, to] each BETWEEN in the anchor clause binds, read from the compiled SQL.
function anchorRanges({ sql, bindings }) {
  const ranges = [];
  const re = /"(term_end|last_scheduled_service_date)" between \? and \?/g;
  let match;
  while ((match = re.exec(sql))) {
    const index = sql.slice(0, match.index).split('?').length - 1;
    ranges.push({ column: match[1], from: bindings[index], to: bindings[index + 1] });
  }
  return ranges;
}

test('gate off: every rung matches its exact day only, with no later-rung condition', async () => {
  const queries = await ladderQueries();
  [30, 15, 7].forEach((days, i) => {
    expect(anchorRanges(queries[i])).toEqual([
      { column: 'term_end', from: plus(days), to: plus(days) },
      { column: 'last_scheduled_service_date', from: plus(days), to: plus(days) },
    ]);
  });
  expect(queries[0].sql).not.toMatch(/"notice_15_sent_at" is null/);
  expect(queries[1].sql).not.toMatch(/"notice_7_sent_at" is null/);
});

test('gate on: each rung reaches NOTICE_CATCHUP_DAYS back, and no window reaches the next rung\'s', async () => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  expect(_private.NOTICE_CATCHUP_DAYS).toBe(3);
  const windows = (await ladderQueries()).map((q) => anchorRanges(q)[0]);
  expect(windows.map(({ from, to }) => [from, to])).toEqual([
    [plus(27), plus(30)], [plus(12), plus(15)], [plus(4), plus(7)],
  ]);
  for (let i = 0; i + 1 < windows.length; i++) expect(windows[i + 1].to < windows[i].from).toBe(true);
});

test('gate on: the rung\'s own sent column and claim still gate it, and a later rung already sent blocks it', async () => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  const [q30, q15, q7] = (await ladderQueries()).map((q) => q.sql);
  expect(q30).toMatch(/"notice_30_sent_at" is null/);
  expect(q30).toMatch(/"notice_30_claimed_at" is null or "notice_30_claimed_at" < \?/);
  expect(q30).toMatch(/"notice_15_sent_at" is null/);
  expect(q30).toMatch(/"notice_7_sent_at" is null/);
  expect(q15).toMatch(/"notice_15_sent_at" is null/);
  expect(q15).toMatch(/"notice_7_sent_at" is null/);
  expect(q15).not.toMatch(/"notice_30_sent_at" is null/);
  expect(q7).toMatch(/"notice_7_sent_at" is null/);
  expect(q7).not.toMatch(/"notice_15_sent_at" is null/);
});

// Codex #7715: a late notice's email states the days actually left to the anchor it
// matched; the rung (30/15/7) still keys the claim, the stamp and the idempotency key.
test('days left to the matched anchor: the rung on time, fewer when late, the last visit when term_end is outside', () => {
  const window30 = { from: plus(27), to: plus(30) };
  expect(_private.daysLeftToNoticeAnchor({ term_end: plus(30) }, window30, TODAY)).toBe(30);
  expect(_private.daysLeftToNoticeAnchor({ term_end: plus(27) }, window30, TODAY)).toBe(27);
  expect(_private.daysLeftToNoticeAnchor(
    { term_end: plus(40), last_scheduled_service_date: plus(28) }, window30, TODAY,
  )).toBe(28);
  expect(_private.daysLeftToNoticeAnchor({ term_end: null, last_scheduled_service_date: null }, window30, TODAY)).toBeNull();
});
