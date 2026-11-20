/**
 * settlePlannedIssues: the one place that tells the owner a planned Waves Pest Insider issue did
 * not go out as its FYI copy said (the plan's skip rule: one admin alert). It runs every minute
 * after the dispatcher, reads each 'scheduled' issue's send, and each 'failed' issue nobody was
 * told about yet. An issue settles in one transaction (its send row locked first, then its row).
 * The row always records the outcome; it is marked told only when its alert reached someone, so
 * an alert that reached no one is tried again the next minute.
 */
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] })),
  parseLockedEventIds: jest.fn(() => []),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...args) => mockTrigger(...args) }));

const db = require('../models/db');
const { settlePlannedIssues } = require('../services/newsletter-sender');

// Thursday, December 3, 2026: 7:00 AM EST send time; the window ends at 10:00 AM EST (15:00Z).
const IN_WINDOW = new Date('2026-12-03T14:00:00Z');
const AFTER_WINDOW = new Date('2026-12-03T15:05:00Z');

const ISSUE = { id: 'issue-1', issue_date: '2026-12-03', status: 'scheduled', send_id: 'send-1', subject: 'Native termites can swarm in winter', reason: null, diagnostics: {} };
const AUTO_QUEUED = {
  id: 'send-1', status: 'scheduled', subject: 'Native termites can swarm in winter', recipient_count: 85,
  scheduled_for: new Date('2026-12-03T12:00:00Z'), proof_approved_at: new Date('2026-12-02T12:05:00Z'), proof_approval_email_id: null,
  updated_at: new Date('2026-12-02T12:05:00Z'),
};

// An in-memory stand-in for the tables. `counts`: the delivery ledger's readers who got it (sent)
// and readers a Resume would still send it to (left: the retryable rows).
function fakeDb({ issues = [ISSUE], sends = [AUTO_QUEUED], counts = { sent: 85, left: 0 } } = {}) {
  const writes = [];
  const reads = [];
  const matches = (row, conds) => conds.every((cond) => Object.entries(cond).every(([k, v]) => row[k] === v));
  db.mockImplementation((table) => {
    const q = { conds: [], raws: [] };
    q.where = jest.fn((cond) => { if (cond && typeof cond === 'object') q.conds.push(cond); return q; });
    q.whereRaw = jest.fn((sql, bindings) => { q.raws.push([sql, bindings]); return q; });
    q.forUpdate = jest.fn(() => { q.locked = true; return q; });
    q.select = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.whereIn = jest.fn(() => { q.retryable = true; return q; });
    q.count = jest.fn((what) => { q.counted = what; return q; });
    q.first = jest.fn(async () => {
      reads.push({ table, locked: Boolean(q.locked) });
      if (table === 'newsletter_send_deliveries') return { c: q.retryable ? counts.left : counts.sent };
      const rows = table === 'newsletter_sends' ? sends : issues;
      return rows.find((row) => matches(row, q.conds));
    });
    // A list: the planned issues in a status (a 'failed' one only while nobody was told).
    q.then = (resolve, reject) => Promise.resolve(issues.filter((row) => matches(row, q.conds)
      && (row.status !== 'failed' || !(row.diagnostics && row.diagnostics.outcomeToldAt)))).then(resolve, reject);
    q.update = jest.fn(async (patch) => { writes.push({ table, conds: q.conds, patch }); return 1; });
    return q;
  });
  db.transaction = jest.fn(async (work) => {
    const trx = (table) => db(table);
    trx.raw = (sql, bindings) => ({ sql, bindings });
    return work(trx);
  });
  return { writes, reads };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTrigger.mockImplementation(async () => ({ bellWritten: true }));
});

test('a scheduled issue whose send reached readers becomes sent, with no alert', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent', recipient_count: 85 }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent' }) }]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test('it locks the send row first, then the issue row, as every writer of both does', async () => {
  const { reads } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent' }] });

  await settlePlannedIssues(IN_WINDOW);

  expect(reads.slice(0, 2)).toEqual([{ table: 'newsletter_sends', locked: true }, { table: 'pest_insider_issues', locked: true }]);
});

test.each([
  ['its send failed and no reader got it', { status: 'failed' }, { sent: 0, left: 85 }, 'Did not go out: its send failed, and no reader got it', undefined],
  ['its send failed part way', { status: 'failed' }, { sent: 40, left: 45 }, 'Did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest', 40],
  ['it was sent to nobody (every reader dropped out)', { status: 'sent', recipient_count: 0 }, undefined, 'Did not go out: no planned reader was still eligible when it sent', undefined],
  ['its send ended with readers left to resume (a batch SendGrid refused)', { status: 'sent', recipient_count: 85 }, { sent: 80, left: 5 }, 'Did not go out: its send ended after 80 of 85 readers got it; Resume in Newsletter → History sends it to the rest', 80],
  ['its claim went stale part way', { status: 'sending', updated_at: new Date('2026-12-03T13:00:00Z') }, { sent: 10, left: 75 }, 'Did not go out: its send stopped part way after 10 of 85 readers got it; Resume in Newsletter → History sends it to the rest', 10],
])('%s: the row fails at once, and one alert says so', async (_label, sendPatch, counts, text, sentCount) => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, ...sendPatch }], counts });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  // Keyed per issue: a retry of an alert that already landed writes no second row and sends no second push.
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
    sendId: 'send-1', subject: 'Native termites can swarm in winter', errors: [text], ...(sentCount ? { sentCount } : {}),
  }, { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes).toEqual([{
    table: 'pest_insider_issues',
    conds: [{ id: 'issue-1' }],
    patch: expect.objectContaining({
      status: 'failed',
      reason: text.charAt(0).toLowerCase() + text.slice(1),
      diagnostics: {
        sql: "coalesce(diagnostics, '{}'::jsonb) || ?::jsonb",
        bindings: [JSON.stringify({ ...(sentCount ? { sentCount } : {}), outcomeToldAt: IN_WINDOW.toISOString() })],
      },
    }),
  }]);
});

test('a send in progress is left to finish, also after the window closed (its deadline stops it)', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sending', updated_at: new Date('2026-12-03T15:00:00Z') }] });

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test.each([
  ['still queued', { status: 'scheduled' }],
  ['back in drafts (a person may still send it by hand)', { status: 'draft' }],
])('before its window closes, a send %s is left alone', async (_label, sendPatch) => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, ...sendPatch }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
});

test('still queued when its window closed: back to a draft so it never goes out late, its week drafted, the row failed, one alert', async () => {
  const { writes } = fakeDb();

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 1 });
  expect(writes.map(({ table, conds, patch }) => [table, conds[0], patch.status])).toEqual([
    ['newsletter_sends', { id: 'send-1', status: 'scheduled' }, 'draft'],
    ['newsletter_calendar', { send_id: 'send-1' }, 'drafted'],
    ['pest_insider_issues', { id: 'issue-1' }, 'failed'],
  ]);
  expect(writes[0].patch).toMatchObject({ scheduled_for: null, proof_token: null, proof_approved_at: null });
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: it was still queued when its 7:00-10:00 AM ET window closed, so it went back to a draft']);
});

test('a draft when its window closed: the row fails, and one alert says so', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'draft' }] });

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 1 });
  expect(writes.map(({ table }) => table)).toEqual(['pest_insider_issues']);
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: it was back in drafts when its 7:00-10:00 AM ET window closed']);
});

test('a send a person scheduled by hand goes at its own time: left alone after the window', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, proof_approved_at: null }] });

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
});

test("a failed row a send-time stop wrote gets its one alert, in the stop's words; a row already told is left alone", async () => {
  const stopped = { ...ISSUE, id: 'issue-2', status: 'failed', reason: 'stopped at send time: a HOLD reply to its FYI copy is in the inbox' };
  const told = { ...ISSUE, id: 'issue-3', send_id: 'send-3', status: 'failed', reason: 'stopped at send time: x', diagnostics: { outcomeToldAt: '2026-12-03T12:01:00.000Z' } };
  const { writes } = fakeDb({ issues: [stopped, told], sends: [{ ...AUTO_QUEUED, status: 'draft' }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Stopped at send time: a HOLD reply to its FYI copy is in the inbox']);
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-2' }], patch: expect.objectContaining({ status: 'failed', reason: stopped.reason }) }]);
});

test('an alert that reached no one: the row still records the outcome, but untold, with the readers who got it', async () => {
  mockTrigger.mockImplementation(async () => ({ bellWritten: false, push: null }));
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed' }], counts: { sent: 40, left: 45 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(writes).toEqual([{
    table: 'pest_insider_issues',
    conds: [{ id: 'issue-1' }],
    patch: expect.objectContaining({
      status: 'failed',
      diagnostics: expect.objectContaining({ bindings: [JSON.stringify({ sentCount: 40 })] }),
    }),
  }]);
});

test('the next minute tries an untold row again: nothing changes until its alert reaches someone, which then says how many readers got it', async () => {
  const untold = {
    ...ISSUE, status: 'failed', diagnostics: { sentCount: 40 },
    reason: 'did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest',
  };
  mockTrigger.mockImplementationOnce(async () => ({ bellWritten: false, push: { sent: 0 } }));
  let { writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'failed' }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);

  ({ writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'failed' }] }));
  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenLastCalledWith('newsletter_proof_blocked', expect.objectContaining({
    errors: ['Did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
    sentCount: 40,
  }), { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes[0].patch.diagnostics.bindings).toEqual([JSON.stringify({ sentCount: 40, outcomeToldAt: IN_WINDOW.toISOString() })]);
});

test('a retry whose alert was already written (a crash before the row was marked told) finds it by its key and marks the row told', async () => {
  // triggerNotification on a dedupe hit: the existing bell row counts as written, and no push goes again.
  mockTrigger.mockImplementation(async () => ({ bellWritten: true, push: null, deduped: true }));
  const untold = { ...ISSUE, status: 'failed', reason: 'stopped at send time: x' };
  const { writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'draft' }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger.mock.calls[0][2]).toEqual({ dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes[0].patch.diagnostics.bindings).toEqual([JSON.stringify({ outcomeToldAt: IN_WINDOW.toISOString() })]);
});

test('a failed row past the lookback is no longer listed', async () => {
  fakeDb();
  const lists = [];
  const real = db.getMockImplementation();
  db.mockImplementation((table) => { const q = real(table); lists.push(q); return q; });

  await settlePlannedIssues(IN_WINDOW);

  expect(lists[1].whereRaw).toHaveBeenCalledWith("issue_date >= (now() at time zone 'America/New_York')::date - ?::int", [14]);
});

test('an issue whose send link changed since the list was read is left for the next minute', async () => {
  fakeDb({ issues: [{ ...ISSUE, send_id: 'send-9' }] });
  // The list said send-1; the locked re-read says send-9.
  db.mockImplementationOnce((table) => {
    const q = {};
    ['where', 'whereRaw', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.then = (resolve) => Promise.resolve([{ id: 'issue-1', send_id: 'send-1' }]).then(resolve);
    expect(table).toBe('pest_insider_issues');
    return q;
  });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(mockTrigger).not.toHaveBeenCalled();
});
