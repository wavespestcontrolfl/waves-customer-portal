/**
 * Waves Pest Insider schedule + issue planner (services/pest-insider/schedule.js): the issue
 * dates (1st and 3rd Thursday), build-day detection at ET edges, runIssuePlanner's recording
 * of a built or refused issue, and, with GATE_PEST_INSIDER_AUTO_SEND on, the draft for its
 * readers, the proof step and the last tick's notice. The database, the builder, the
 * live-post check, the audience query, the proof step and the notification are mocked: no
 * network, nothing sent. The table's CHECKs are in pest-insider-issues-migration-postgres.test.js (CI).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pest-insider/index', () => ({ buildIssue: jest.fn() }));
jest.mock('../services/pest-insider/posts', () => ({ checkLivePosts: jest.fn() }));
jest.mock('../services/pest-insider/audience', () => ({
  ...jest.requireActual('../services/pest-insider/audience'),
  selectIssueAudience: jest.fn(),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));

const { buildIssue } = require('../services/pest-insider/index');
const { checkLivePosts } = require('../services/pest-insider/posts');
const { selectIssueAudience } = require('../services/pest-insider/audience');
const { triggerNotification } = require('../services/notification-triggers');
const logger = require('../services/logger');
const {
  issueDatesInMonth, isIssueDate, nextIssueDate, todayET, nextDay, recentHistory, runIssuePlanner, USED_STATUSES,
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

// A small fake knex: records inserts and updates, answers the "already built" lookup (and, as
// `after`, the last tick's re-read) and the history query. A transaction runs on the same fake and
// records a rollback; newsletter_sends takes the draft insert.
function fakeDb({ existing = null, after, history = [], inserted = true, updated = 1, sendId = 'send-1' } = {}) {
  const calls = { inserts: [], updates: [], sends: [], history: null, onConflict: null, rolledBack: false, reads: 0 };
  const table = (name) => {
    if (name === 'newsletter_sends') {
      return { insert: jest.fn((row) => { calls.sends.push(row); return { returning: jest.fn(async () => [{ id: sendId }]) }; }) };
    }
    expect(name).toBe('pest_insider_issues');
    const q = {
      where: jest.fn((cond) => { q.cond = cond; return q; }),
      whereIn: jest.fn((col, vals) => { q.in = { col, vals }; return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn((n) => { calls.limit = n; return q; }),
      select: jest.fn(async () => { calls.history = q.in; return history; }),
      first: jest.fn(async () => { calls.reads += 1; return calls.reads > 1 && after !== undefined ? after : existing; }),
      update: jest.fn(async (row) => { calls.updates.push({ where: q.cond, statusIn: q.in && q.in.vals, row }); return updated; }),
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
  };
  const db = jest.fn(table);
  db.transaction = jest.fn(async (work) => {
    try {
      return await work(jest.fn(table));
    } catch (err) {
      calls.rolledBack = true;
      throw err;
    }
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

describe('runIssuePlanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkLivePosts.mockResolvedValue(['fact-live-1', 'fact-live-2']);
  });

  test('does nothing when tomorrow is not an issue date', async () => {
    const database = fakeDb();
    // Tuesday Dec 1 7:00 AM ET (tomorrow = Wednesday), and Wednesday Dec 9 (tomorrow = 2nd Thursday)
    for (const now of ['2026-12-01T12:00:00Z', '2026-12-09T12:00:00Z', '2026-12-03T12:00:00Z']) {
      expect(await runIssuePlanner({ now: new Date(now), database })).toEqual({ skipped: true, reason: 'not_build_day' });
    }
    expect(database).not.toHaveBeenCalled();
    expect(buildIssue).not.toHaveBeenCalled();
    expect(checkLivePosts).not.toHaveBeenCalled();
  });

  test('uses the ET date at the midnight edge: 11:30 PM ET Wednesday still builds, 12:30 AM Thursday does not', async () => {
    const lateWed = new Date('2026-12-03T04:30:00Z'); // 11:30 PM EST Dec 2
    const earlyThu = new Date('2026-12-03T05:30:00Z'); // 12:30 AM EST Dec 3
    buildIssue.mockReturnValue({ ok: false, reason: 'x', issue: null, diagnostics: {} });
    expect((await runIssuePlanner({ now: lateWed, database: fakeDb() })).issueDate).toBe('2026-12-03');
    expect(await runIssuePlanner({ now: earlyThu, database: fakeDb() })).toEqual({ skipped: true, reason: 'not_build_day' });
  });

  test('does nothing when the issue already has a built row (a catch-up tick)', async () => {
    const database = fakeDb({ existing: { id: 'row-0', status: 'shadow' } });
    expect(await runIssuePlanner({ now: WED_BUILD_DAY, database })).toEqual({ skipped: true, reason: 'already_built' });
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
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database, fetchImpl });

    expect(result).toEqual({ skipped: false, issueDate: '2026-12-03', status: 'shadow', reason: null, written: true, retried: false, sendId: null, proof: null });
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
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database });
    expect(result).toMatchObject({ skipped: false, status: 'skipped', reason: 'no_live_post: fact-9' });
    const row = database.calls.inserts[0];
    expect(row).toMatchObject({ status: 'skipped', reason: 'no_live_post: fact-9', fact_id: 'fact-9', subject: null, preview: null });
    expect(JSON.parse(row.diagnostics).problems).toEqual([{ part: 'lead', reason: 'r' }]);
  });

  test('a row written by a racing tick is left alone and reported as not written', async () => {
    buildIssue.mockReturnValue({ ok: false, reason: 'x', issue: null, diagnostics: {} });
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database: fakeDb({ inserted: false }) });
    expect(result.written).toBe(false);
  });

  test('a skipped row is built again by a later tick and replaced only while it is still skipped', async () => {
    buildIssue.mockReturnValue(GOOD_BUILD);
    const database = fakeDb({ existing: { id: 'row-0', status: 'skipped' } });
    const result = await runIssuePlanner({ now: CATCH_UP, database });

    expect(result).toEqual({ skipped: false, issueDate: '2026-12-03', status: 'shadow', reason: null, written: true, retried: true, sendId: null, proof: null });
    expect(database.calls.inserts).toHaveLength(0);
    expect(database.calls.updates).toHaveLength(1);
    expect(database.calls.updates[0].where).toEqual({ id: 'row-0' });
    expect(database.calls.updates[0].statusIn).toEqual(['skipped']);
    expect(database.calls.updates[0].row).toMatchObject({ status: 'shadow', fact_id: 'fact-9', subject: 'Subject line', updated_at: CATCH_UP });

    // The send path moved the row on between the read and the write: nothing is replaced.
    const moved = await runIssuePlanner({ now: CATCH_UP, database: fakeDb({ existing: { id: 'row-0', status: 'skipped' }, updated: 0 }) });
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
    expect(await runIssuePlanner({ now: WED_BUILD_DAY, database: morning, fetchImpl: down }))
      .toMatchObject({ status: 'skipped', reason: 'no_lead_fact', written: true, retried: false });
    expect(down).toHaveBeenCalled();
    const skippedRow = morning.calls.inserts[0];
    expect(skippedRow.status).toBe('skipped');
    const recorded = JSON.parse(skippedRow.diagnostics);
    expect(recorded.postCheckFailureCount).toBe(down.mock.calls.length);
    expect(recorded.postCheckFailures[0]).toMatch(/^https:\/\/\S+ TypeError$/);

    const up = jest.fn(async () => ({ status: 200 }));
    const afternoon = fakeDb({ existing: { id: 'row-1', status: 'skipped' } });
    expect(await runIssuePlanner({ now: CATCH_UP, database: afternoon, fetchImpl: up }))
      .toMatchObject({ status: 'shadow', written: true, retried: true });
    expect(afternoon.calls.updates[0].row).toMatchObject({ status: 'shadow', fact_id: 'fact-9' });
    expect(JSON.parse(afternoon.calls.updates[0].row.diagnostics)).not.toHaveProperty('postCheckFailures');
  });

  test('a 5xx answer is noted as a failed probe', async () => {
    const { checkLivePosts: realCheck } = jest.requireActual('../services/pest-insider/posts');
    checkLivePosts.mockImplementation(realCheck);
    buildIssue.mockReturnValue({ ok: false, reason: 'no_lead_fact', issue: null, diagnostics: {} });
    const database = fakeDb();
    await runIssuePlanner({ now: WED_BUILD_DAY, database, fetchImpl: jest.fn(async () => ({ status: 503 })) });
    expect(JSON.parse(database.calls.inserts[0].diagnostics).postCheckFailures[0]).toMatch(/ 503$/);
  });

  test('an unexpected throw from the post check writes nothing, so the catch-up retries', async () => {
    checkLivePosts.mockRejectedValue(new Error('network down'));
    const database = fakeDb();
    await expect(runIssuePlanner({ now: WED_BUILD_DAY, database })).rejects.toThrow('network down');
    expect(database.calls.inserts).toHaveLength(0);
  });
});

describe('runIssuePlanner with GATE_PEST_INSIDER_AUTO_SEND on', () => {
  const AUDIENCE = { subscriberIds: [4, 9], addressKeys: { 4: 'key-4', 9: 'key-9' }, counts: { warm: 3, heldOut: 1, recipients: 2 } };
  const QUEUED = { sent: true, token: 'tok', queued: true };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_PEST_INSIDER_AUTO_SEND = 'true';
    checkLivePosts.mockResolvedValue(['fact-live-1']);
    buildIssue.mockReturnValue(GOOD_BUILD);
    selectIssueAudience.mockResolvedValue(AUDIENCE);
  });

  afterAll(() => {
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
  });

  test('a good build becomes a draft for its readers, linked from a drafted row, then goes to the proof step', async () => {
    const database = fakeDb();
    const sendProof = jest.fn(async () => QUEUED);
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database, sendProof });

    expect(result).toEqual({ skipped: false, issueDate: '2026-12-03', status: 'drafted', reason: null, written: true, retried: false, sendId: 'send-1', proof: 'queued' });
    expect(selectIssueAudience).toHaveBeenCalledWith({ asOf: WED_BUILD_DAY });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.calls.sends).toHaveLength(1);
    const send = database.calls.sends[0];
    expect(send).toMatchObject({
      subject: 'Subject line', preview_text: 'Preview line', html_body: '<p>big</p>', text_body: 'big',
      status: 'draft', newsletter_type: 'pest-insider-monthly',
      segment_filter: { subscriber_ids: [4, 9], holdout: 'pest-insider', address_keys: { 4: 'key-4', 9: 'key-9' } },
      from_name: 'Waves Pest Control', from_email: 'newsletter@news.wavespestcontrol.com', reply_to: 'contact@wavespestcontrol.com',
      auto_share_social: false, created_by: null,
    });
    // Exactly the plan: the readers, the holdout the sender re-checks, and each reader's qualifying address key.
    expect(send.segment_filter).toEqual({ subscriber_ids: [4, 9], holdout: 'pest-insider', address_keys: { 4: 'key-4', 9: 'key-9' } });
    expect(send.slug).toMatch(/^waves-pest-insider-2026-12-03-[0-9a-f]{6}$/);
    const row = database.calls.inserts[0];
    expect(row).toMatchObject({ status: 'drafted', send_id: 'send-1', subject: 'Subject line' });
    expect(JSON.parse(row.diagnostics).audience).toEqual(AUDIENCE.counts);
    expect(sendProof).toHaveBeenCalledWith('send-1');
  });

  test('no reader: the issue is skipped with empty_audience, no draft, no proof', async () => {
    selectIssueAudience.mockResolvedValue({ subscriberIds: [], addressKeys: {}, counts: { warm: 0, heldOut: 0, recipients: 0 } });
    const database = fakeDb();
    const sendProof = jest.fn();
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database, sendProof });

    expect(result).toMatchObject({ status: 'skipped', reason: 'empty_audience', sendId: null, proof: null });
    expect(database.calls.sends).toHaveLength(0);
    expect(database.calls.inserts[0]).toMatchObject({ status: 'skipped', reason: 'empty_audience', subject: null, preview: null });
    expect(sendProof).not.toHaveBeenCalled();
  });

  test('a refused build makes no draft and asks for no audience', async () => {
    buildIssue.mockReturnValue({ ok: false, reason: 'no_live_post: fact-9', issue: null, diagnostics: {} });
    const database = fakeDb();
    const sendProof = jest.fn();
    expect(await runIssuePlanner({ now: WED_BUILD_DAY, database, sendProof })).toMatchObject({ status: 'skipped', sendId: null });
    expect(selectIssueAudience).not.toHaveBeenCalled();
    expect(database.calls.sends).toHaveLength(0);
    expect(sendProof).not.toHaveBeenCalled();
  });

  test('a racing tick that wrote the row first rolls the draft back, and nothing is proofed', async () => {
    const database = fakeDb({ inserted: false });
    const sendProof = jest.fn();
    const result = await runIssuePlanner({ now: WED_BUILD_DAY, database, sendProof });

    expect(result).toMatchObject({ written: false, sendId: null, proof: null });
    expect(database.calls.rolledBack).toBe(true);
    expect(sendProof).not.toHaveBeenCalled();
  });

  test('a row built in shadow while the switch was off is built again as a draft', async () => {
    const database = fakeDb({ existing: { id: 'row-0', status: 'shadow', send_id: null } });
    const result = await runIssuePlanner({ now: CATCH_UP, database, sendProof: jest.fn(async () => QUEUED) });

    expect(result).toMatchObject({ status: 'drafted', retried: true, sendId: 'send-1', proof: 'queued' });
    expect(database.calls.updates[0].where).toEqual({ id: 'row-0' });
    expect(database.calls.updates[0].statusIn).toEqual(['skipped', 'shadow']);
    expect(database.calls.updates[0].row).toMatchObject({ status: 'drafted', send_id: 'send-1' });
  });

  test('a drafted row whose FYI copy did not go out gets the proof step again, with no rebuild', async () => {
    const database = fakeDb({ existing: { id: 'row-0', status: 'drafted', send_id: 'send-7' } });
    const sendProof = jest.fn(async () => QUEUED);
    const result = await runIssuePlanner({ now: CATCH_UP, database, sendProof });

    expect(result).toMatchObject({ status: 'drafted', retried: true, sendId: 'send-7', proof: 'queued' });
    expect(sendProof).toHaveBeenCalledWith('send-7');
    expect(buildIssue).not.toHaveBeenCalled();
    expect(database.calls.sends).toHaveLength(0);
  });

  test.each(['scheduled', 'sent', 'held', 'failed'])('a %s row is left alone', async (status) => {
    const database = fakeDb({ existing: { id: 'row-0', status, send_id: 'send-7' } });
    const sendProof = jest.fn();
    expect(await runIssuePlanner({ now: CATCH_UP, database, sendProof, finalTick: true })).toEqual({ skipped: true, reason: 'already_built' });
    expect(sendProof).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('with the switch off, a drafted row is left alone too', async () => {
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
    const database = fakeDb({ existing: { id: 'row-0', status: 'drafted', send_id: 'send-7' } });
    const sendProof = jest.fn();
    expect(await runIssuePlanner({ now: CATCH_UP, database, sendProof })).toEqual({ skipped: true, reason: 'already_built' });
    expect(sendProof).not.toHaveBeenCalled();
  });

  describe('the last tick (1:00 PM)', () => {
    test('an issue still skipped raises one notice that says why, in plain words', async () => {
      buildIssue.mockReturnValue({ ok: false, reason: 'no_live_post: fact-9', issue: null, diagnostics: {} });
      const database = fakeDb({ after: { status: 'skipped', reason: 'no_live_post: fact-9' } });
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn() });

      expect(result.noticeRaised).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      expect(triggerNotification).toHaveBeenCalledWith('newsletter_proof_blocked', {
        sendId: null,
        subject: 'Waves Pest Insider for Thursday, December 3',
        errors: ["It will not send this time: its lead fact's post on the Waves blog did not answer (no_live_post: fact-9)"],
      });
    });

    test('a draft whose FYI copy SendGrid refused raises the notice', async () => {
      const database = fakeDb({ after: { status: 'drafted', reason: null } });
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn(async () => ({ skipped: true, reason: 'proof_send_failed' })) });

      expect(result).toMatchObject({ status: 'drafted', proof: 'proof_send_failed', noticeRaised: true });
      expect(triggerNotification.mock.calls[0][1].errors).toEqual(['It will not send this time: SendGrid did not accept the FYI copy (proof_send_failed)']);
    });

    test('a draft whose FYI copy an earlier run claimed but never queued raises the notice', async () => {
      // The 7:00 AM run stopped after its claim (a restart): the proof step now only sees the claim.
      const database = fakeDb({ existing: { id: 'row-1', status: 'drafted', send_id: 'send-1' }, after: { status: 'drafted', reason: null } });
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn(async () => ({ skipped: true, reason: 'proof_already_sent' })) });

      expect(result).toMatchObject({ status: 'drafted', proof: 'proof_already_sent', noticeRaised: true });
      expect(triggerNotification.mock.calls[0][1].errors).toEqual(['It will not send this time: an earlier run started its FYI copy but never queued it (proof_already_sent)']);
    });

    test('a last run that stops with an error raises the notice with the error, then fails as before', async () => {
      buildIssue.mockImplementationOnce(() => { throw new Error('fact bank unreadable'); });
      const database = fakeDb();

      await expect(runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn() })).rejects.toThrow('fact bank unreadable');
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      expect(triggerNotification.mock.calls[0][1].errors).toEqual(["It will not send this time: the planner's last run stopped with an error: fact bank unreadable"]);
    });

    test('a 7:00 AM run that stops with an error raises nothing: the 1:00 PM run tries again', async () => {
      buildIssue.mockImplementationOnce(() => { throw new Error('fact bank unreadable'); });

      await expect(runIssuePlanner({ now: WED_BUILD_DAY, database: fakeDb(), sendProof: jest.fn() })).rejects.toThrow('fact bank unreadable');
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test.each([
      ['did not reach the owner: the notice is raised', false, true],
      ['reached the owner: no second notice', true, false],
    ])('an FYI copy that could not queue the issue, whose alert %s', async (_label, notified, raised) => {
      const database = fakeDb({ existing: { id: 'row-1', status: 'drafted', send_id: 'send-1' }, after: { status: 'drafted', reason: null } });
      const sendProof = jest.fn(async () => ({ sent: true, token: 'tok', queued: false, notified }));
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof });

      expect(result).toMatchObject({ proof: 'fyi_sent_not_queued', noticeRaised: raised });
      if (raised) {
        expect(triggerNotification.mock.calls[0][1].errors).toEqual(['It will not send this time: its FYI copy went out, but the issue could not be queued (not_queued)']);
      } else {
        expect(triggerNotification).not.toHaveBeenCalled();
      }
    });

    test('no second notice when the proof step already told the owner why', async () => {
      const database = fakeDb({ after: { status: 'drafted', reason: null } });
      const sendProof = jest.fn(async () => ({ skipped: true, reason: 'validation_failed', errors: ['x'], notified: true }));
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof });

      expect(result.noticeRaised).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('no notice once the issue is queued', async () => {
      const database = fakeDb({ after: { status: 'scheduled', reason: null } });
      const result = await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn(async () => QUEUED) });

      expect(result.noticeRaised).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('the 7:00 AM tick never raises it: the 1:00 PM tick may still fix the issue', async () => {
      buildIssue.mockReturnValue({ ok: false, reason: 'no_live_post: fact-9', issue: null, diagnostics: {} });
      const result = await runIssuePlanner({ now: WED_BUILD_DAY, database: fakeDb(), sendProof: jest.fn() });

      expect(result).not.toHaveProperty('noticeRaised');
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('with the switch off nothing was meant to send, so no notice', async () => {
      delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
      buildIssue.mockReturnValue({ ok: false, reason: 'no_live_post: fact-9', issue: null, diagnostics: {} });
      const database = fakeDb({ after: { status: 'skipped', reason: 'no_live_post: fact-9' } });
      await runIssuePlanner({ now: CATCH_UP, database, finalTick: true, sendProof: jest.fn() });

      expect(triggerNotification).not.toHaveBeenCalled();
    });
  });
});
