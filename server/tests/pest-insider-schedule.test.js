/**
 * Pest Insider schedule + shadow planner (services/pest-insider/schedule.js): the issue
 * dates (1st and 3rd Thursday), build-day detection at ET edges, and runShadowIssue's
 * recording of a built or refused issue. The database, the builder and the live-post check
 * are mocked: no network, nothing sent. The table's CHECKs are in
 * pest-insider-issues-migration-postgres.test.js (CI).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pest-insider/index', () => ({ buildIssue: jest.fn() }));
jest.mock('../services/pest-insider/posts', () => ({ checkLivePosts: jest.fn() }));

const { buildIssue } = require('../services/pest-insider/index');
const { checkLivePosts } = require('../services/pest-insider/posts');
const logger = require('../services/logger');
const {
  issueDatesInMonth, isIssueDate, nextIssueDate, todayET, nextDay, recentHistory, runShadowIssue, USED_STATUSES,
} = require('../services/pest-insider/schedule');

describe('issueDatesInMonth', () => {
  // One month starting on each weekday (Sun..Sat), then the DST months.
  test.each([
    [2026, 2, ['2026-02-05', '2026-02-19']], // Feb 1 2026 is a Sunday
    [2026, 6, ['2026-06-04', '2026-06-18']], // Mon
    [2026, 9, ['2026-09-03', '2026-09-17']], // Tue
    [2026, 7, ['2026-07-02', '2026-07-16']], // Wed
    [2026, 10, ['2026-10-01', '2026-10-15']], // Thu: the 1st itself
    [2026, 5, ['2026-05-07', '2026-05-21']], // Fri
    [2026, 8, ['2026-08-06', '2026-08-20']], // Sat
    [2026, 12, ['2026-12-03', '2026-12-17']],
    [2026, 3, ['2026-03-05', '2026-03-19']], // DST starts Mar 8 2026
    [2026, 11, ['2026-11-05', '2026-11-19']], // DST ends Nov 1 2026
    [2027, 1, ['2027-01-07', '2027-01-21']],
  ])('%i-%i', (year, month, expected) => {
    expect(issueDatesInMonth(year, month)).toEqual(expected);
  });

  test('every issue date is a Thursday on day 1-7 or 15-21, for five years', () => {
    for (let year = 2026; year <= 2030; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const [first, third] = issueDatesInMonth(year, month);
        for (const [d, lo, hi] of [[first, 1, 7], [third, 15, 21]]) {
          const day = Number(d.slice(8));
          expect(new Date(`${d}T12:00:00Z`).getUTCDay()).toBe(4);
          expect(day >= lo && day <= hi).toBe(true);
        }
      }
    }
  });
});

describe('isIssueDate and nextIssueDate', () => {
  test('isIssueDate', () => {
    expect(isIssueDate('2026-12-03')).toBe(true);
    expect(isIssueDate('2026-12-17')).toBe(true);
    expect(isIssueDate('2026-12-10')).toBe(false); // 2nd Thursday
    expect(isIssueDate('2026-12-24')).toBe(false); // 4th Thursday
    expect(isIssueDate('2026-12-31')).toBe(false); // 5th Thursday
    expect(isIssueDate('2026-12-04')).toBe(false); // Friday
    expect(isIssueDate('2026-10-01')).toBe(true); // Thursday the 1st
  });

  test('isIssueDate refuses text that is not a real date', () => {
    expect(() => isIssueDate('2026-02-30')).toThrow(/real calendar date/);
    expect(() => isIssueDate('12/03/2026')).toThrow(/YYYY-MM-DD/);
  });

  test('nextIssueDate is on or after the given date', () => {
    expect(nextIssueDate('2026-12-03')).toBe('2026-12-03');
    expect(nextIssueDate('2026-12-04')).toBe('2026-12-17');
    expect(nextIssueDate('2026-12-17')).toBe('2026-12-17');
    expect(nextIssueDate('2026-12-18')).toBe('2027-01-07');
    expect(nextIssueDate('2026-11-20')).toBe('2026-12-03');
    expect(nextIssueDate('2026-12-31')).toBe('2027-01-07');
  });
});

describe('build day detection', () => {
  test('todayET and nextDay follow the ET calendar date', () => {
    expect(todayET(new Date('2026-12-02T12:00:00Z'))).toBe('2026-12-02'); // 7:00 AM EST
    expect(todayET(new Date('2026-12-03T04:59:00Z'))).toBe('2026-12-02'); // 11:59 PM EST
    expect(todayET(new Date('2026-12-03T05:00:00Z'))).toBe('2026-12-03'); // midnight EST
    expect(todayET(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30'); // 11:59 PM EDT
    expect(todayET(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01'); // midnight EDT
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

// A small fake knex: records inserts and updates, answers the "already built" lookup and the history query.
function fakeDb({ existing = null, history = [], inserted = true, updated = 1 } = {}) {
  const calls = { inserts: [], updates: [], history: null, onConflict: null };
  const db = jest.fn((table) => {
    expect(table).toBe('pest_insider_issues');
    const q = {
      where: jest.fn((cond) => { q.cond = cond; return q; }),
      whereIn: jest.fn((col, vals) => { calls.history = { col, vals }; return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn((n) => { calls.limit = n; return q; }),
      select: jest.fn(async () => history),
      first: jest.fn(async () => existing),
      update: jest.fn(async (row) => { calls.updates.push({ where: q.cond, row }); return updated; }),
      insert: jest.fn((row) => {
        calls.inserts.push(row);
        const ins = {
          onConflict: jest.fn((col) => { calls.onConflict = col; return ins; }),
          ignore: jest.fn(() => ins),
          returning: jest.fn(async () => (inserted ? [{ id: 'row-1' }] : [])),
        };
        return ins;
      }),
    };
    return q;
  });
  db.calls = calls;
  return db;
}

// Wednesday 7:00 AM ET before the Thursday Dec 3 2026 issue.
const WED_BUILD_DAY = new Date('2026-12-02T12:00:00Z');
// The same Wednesday, 1:00 PM ET (the catch-up tick).
const CATCH_UP = new Date('2026-12-02T18:00:00Z');
const GOOD_BUILD = {
  ok: true,
  reason: null,
  issue: { subject: 'Subject line', preview: 'Preview line', html_body: '<p>big</p>', text_body: 'big' },
  tool: null,
  diagnostics: { sendDate: '2026-12-03', factId: 'fact-9', speciesSlug: 'species-9', toolId: null, problems: [] },
};

describe('recentHistory', () => {
  test('returns the last rows oldest first, with null kept for an issue without a tool', async () => {
    const database = fakeDb({
      history: [ // the query orders newest first; pg returns DATE as a JS Date
        { issue_date: new Date('2026-11-19T00:00:00Z'), fact_id: 'f3', species_slug: 's3', tool_id: null },
        { issue_date: new Date('2026-11-05T00:00:00Z'), fact_id: 'f2', species_slug: 's2', tool_id: 'tool-b' },
        { issue_date: '2026-10-15', fact_id: 'f1', species_slug: 's1', tool_id: 'tool-a' },
      ],
    });
    const result = await recentHistory('2026-12-03', { database });
    expect(result).toEqual({ factIds: ['f1', 'f2', 'f3'], speciesSlugs: ['s1', 's2', 's3'], toolIds: ['tool-a', 'tool-b', null] });
    expect(database.calls.history.vals).toEqual(USED_STATUSES);
    expect(USED_STATUSES).not.toContain('skipped');
    expect(USED_STATUSES).not.toContain('held');
    expect(database.calls.limit).toBe(6);
  });

  test('an empty table gives empty lists', async () => {
    expect(await recentHistory('2026-12-03', { database: fakeDb() })).toEqual({ factIds: [], speciesSlugs: [], toolIds: [] });
  });
});

describe('runShadowIssue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkLivePosts.mockResolvedValue(['fact-live-1', 'fact-live-2']);
  });

  test('does nothing when tomorrow is not an issue date', async () => {
    const database = fakeDb();
    // Tuesday Dec 1 7:00 AM ET (tomorrow = Wednesday), and Wednesday Dec 9 (tomorrow = 2nd Thursday)
    for (const now of ['2026-12-01T12:00:00Z', '2026-12-09T12:00:00Z', '2026-12-03T12:00:00Z']) {
      expect(await runShadowIssue({ now: new Date(now), database })).toEqual({ skipped: true, reason: 'not_build_day' });
    }
    expect(database).not.toHaveBeenCalled();
    expect(buildIssue).not.toHaveBeenCalled();
    expect(checkLivePosts).not.toHaveBeenCalled();
  });

  test('uses the ET date at the midnight edge: 11:30 PM ET Wednesday still builds, 12:30 AM Thursday does not', async () => {
    const lateWed = new Date('2026-12-03T04:30:00Z'); // 11:30 PM EST Dec 2
    const earlyThu = new Date('2026-12-03T05:30:00Z'); // 12:30 AM EST Dec 3
    buildIssue.mockReturnValue({ ok: false, reason: 'x', issue: null, diagnostics: {} });
    expect((await runShadowIssue({ now: lateWed, database: fakeDb() })).issueDate).toBe('2026-12-03');
    expect(await runShadowIssue({ now: earlyThu, database: fakeDb() })).toEqual({ skipped: true, reason: 'not_build_day' });
  });

  test('does nothing when the issue already has a built row (a catch-up tick)', async () => {
    const database = fakeDb({ existing: { id: 'row-0', status: 'shadow' } });
    expect(await runShadowIssue({ now: WED_BUILD_DAY, database })).toEqual({ skipped: true, reason: 'already_built' });
    expect(buildIssue).not.toHaveBeenCalled();
    expect(checkLivePosts).not.toHaveBeenCalled();
    expect(database.calls.inserts).toHaveLength(0);
  });

  test('a good build is recorded as shadow with its ids, subject and no bodies', async () => {
    buildIssue.mockReturnValue({
      ok: true,
      reason: null,
      issue: { subject: 'Subject line', preview: 'Preview line', html_body: '<p>big</p>', text_body: 'big' },
      tool: null,
      diagnostics: { sendDate: '2026-12-03', factId: 'fact-9', speciesSlug: 'species-9', toolId: null, problems: [] },
    });
    const database = fakeDb({
      history: [
        { issue_date: '2026-11-19', fact_id: 'f2', species_slug: 's2', tool_id: null },
        { issue_date: '2026-11-05', fact_id: 'f1', species_slug: 's1', tool_id: 'tool-a' },
      ],
    });
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    const result = await runShadowIssue({ now: WED_BUILD_DAY, database, fetchImpl });

    expect(result).toEqual({ skipped: false, issueDate: '2026-12-03', status: 'shadow', reason: null, written: true, retried: false });
    // The post check gets a wrapper that calls the given fetch.
    expect(checkLivePosts).toHaveBeenCalledWith({ fetchImpl: expect.any(Function) });
    await checkLivePosts.mock.calls[0][0].fetchImpl('https://example.test/post', { method: 'GET' });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/post', { method: 'GET' });
    expect(buildIssue).toHaveBeenCalledWith({
      sendDate: '2026-12-03',
      recent: { factIds: ['f1', 'f2'], speciesSlugs: ['s1', 's2'], toolIds: ['tool-a', null] },
      recheckedFactIds: [],
      livePostFactIds: ['fact-live-1', 'fact-live-2'],
      liveToolUrls: [],
    });
    expect(database.calls.inserts).toHaveLength(1);
    const row = database.calls.inserts[0];
    expect(row).toMatchObject({
      issue_date: '2026-12-03', status: 'shadow', fact_id: 'fact-9', species_slug: 'species-9', tool_id: null,
      subject: 'Subject line', preview: 'Preview line', reason: null, built_at: WED_BUILD_DAY,
    });
    expect(JSON.parse(row.diagnostics)).toEqual({ sendDate: '2026-12-03', factId: 'fact-9', speciesSlug: 'species-9', toolId: null, problems: [] });
    expect(row.diagnostics).not.toMatch(/html_body|text_body|<p>/);
    expect(row).not.toHaveProperty('html_body');
    expect(database.calls.onConflict).toBe('issue_date');
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('a refused build is recorded as skipped with the reason and no subject', async () => {
    buildIssue.mockReturnValue({
      ok: false,
      reason: 'no_live_post: fact-9',
      issue: null,
      diagnostics: { sendDate: '2026-12-03', factId: 'fact-9', speciesSlug: 'species-9', toolId: null, problems: [{ part: 'lead', reason: 'r' }] },
    });
    const database = fakeDb();
    const result = await runShadowIssue({ now: WED_BUILD_DAY, database });
    expect(result).toMatchObject({ skipped: false, status: 'skipped', reason: 'no_live_post: fact-9' });
    const row = database.calls.inserts[0];
    expect(row).toMatchObject({ status: 'skipped', reason: 'no_live_post: fact-9', fact_id: 'fact-9', subject: null, preview: null });
    expect(JSON.parse(row.diagnostics).problems).toEqual([{ part: 'lead', reason: 'r' }]);
  });

  test('a row written by a racing tick is left alone and reported as not written', async () => {
    buildIssue.mockReturnValue({ ok: false, reason: 'x', issue: null, diagnostics: {} });
    const result = await runShadowIssue({ now: WED_BUILD_DAY, database: fakeDb({ inserted: false }) });
    expect(result.written).toBe(false);
  });

  test('a skipped row is built again by a later tick and replaced only while it is still skipped', async () => {
    buildIssue.mockReturnValue(GOOD_BUILD);
    const database = fakeDb({ existing: { id: 'row-0', status: 'skipped' } });
    const result = await runShadowIssue({ now: CATCH_UP, database });

    expect(result).toEqual({ skipped: false, issueDate: '2026-12-03', status: 'shadow', reason: null, written: true, retried: true });
    expect(database.calls.inserts).toHaveLength(0);
    expect(database.calls.updates).toHaveLength(1);
    expect(database.calls.updates[0].where).toEqual({ id: 'row-0', status: 'skipped' });
    expect(database.calls.updates[0].row).toMatchObject({ status: 'shadow', fact_id: 'fact-9', subject: 'Subject line', updated_at: CATCH_UP });

    // The send path moved the row on between the read and the write: nothing is replaced.
    const moved = await runShadowIssue({ now: CATCH_UP, database: fakeDb({ existing: { id: 'row-0', status: 'skipped' }, updated: 0 }) });
    expect(moved.written).toBe(false);
  });

  test('a website outage at 7:00 AM, through the real post check, is retried at 1:00 PM', async () => {
    const { checkLivePosts: realCheck } = jest.requireActual('../services/pest-insider/posts');
    checkLivePosts.mockImplementation(realCheck);
    // The builder refuses when no post answered, as the real planner does.
    buildIssue.mockImplementation(({ livePostFactIds }) => (livePostFactIds.length
      ? GOOD_BUILD
      : { ok: false, reason: 'no_lead_fact', issue: null, diagnostics: { sendDate: '2026-12-03', factId: null, speciesSlug: null, toolId: null, problems: [] } }));

    const down = jest.fn(async () => { throw new TypeError('fetch failed'); });
    const morning = fakeDb();
    expect(await runShadowIssue({ now: WED_BUILD_DAY, database: morning, fetchImpl: down }))
      .toMatchObject({ status: 'skipped', reason: 'no_lead_fact', written: true, retried: false });
    expect(down).toHaveBeenCalled();
    const skippedRow = morning.calls.inserts[0];
    expect(skippedRow.status).toBe('skipped');
    const recorded = JSON.parse(skippedRow.diagnostics);
    expect(recorded.postCheckFailureCount).toBe(down.mock.calls.length);
    expect(recorded.postCheckFailures[0]).toMatch(/^https:\/\/\S+ TypeError$/);

    const up = jest.fn(async () => ({ status: 200 }));
    const afternoon = fakeDb({ existing: { id: 'row-1', status: 'skipped' } });
    expect(await runShadowIssue({ now: CATCH_UP, database: afternoon, fetchImpl: up }))
      .toMatchObject({ status: 'shadow', written: true, retried: true });
    expect(afternoon.calls.updates[0].row).toMatchObject({ status: 'shadow', fact_id: 'fact-9' });
    expect(JSON.parse(afternoon.calls.updates[0].row.diagnostics)).not.toHaveProperty('postCheckFailures');
  });

  test('a 5xx answer is noted as a failed probe', async () => {
    const { checkLivePosts: realCheck } = jest.requireActual('../services/pest-insider/posts');
    checkLivePosts.mockImplementation(realCheck);
    buildIssue.mockReturnValue({ ok: false, reason: 'no_lead_fact', issue: null, diagnostics: {} });
    const database = fakeDb();
    await runShadowIssue({ now: WED_BUILD_DAY, database, fetchImpl: jest.fn(async () => ({ status: 503 })) });
    expect(JSON.parse(database.calls.inserts[0].diagnostics).postCheckFailures[0]).toMatch(/ 503$/);
  });

  test('an unexpected throw from the post check writes nothing, so the catch-up retries', async () => {
    checkLivePosts.mockRejectedValue(new Error('network down'));
    const database = fakeDb();
    await expect(runShadowIssue({ now: WED_BUILD_DAY, database })).rejects.toThrow('network down');
    expect(database.calls.inserts).toHaveLength(0);
  });
});
