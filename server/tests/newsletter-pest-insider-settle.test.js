/**
 * settlePlannedIssues: the one place that tells the owner a planned Waves Pest Insider issue did
 * not go out as its FYI copy said (the plan's skip rule: one admin alert). It runs every minute
 * after the dispatcher, reads each 'scheduled' issue's send, each 'failed' issue nobody was told
 * about yet, and each 'sent' one whose readers' mail servers later refused it. An issue settles in
 * one transaction (its send row locked first, then its row).
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

// An in-memory stand-in for the tables. `counts`: the delivery ledger's readers who got it (got),
// readers a Resume would still mail (left: outstandingEligibleDeliveries, the joined query), and
// for a planned issue the rows that query lists (rows: the subscriber, its address and customers).
const CHAIN = ['where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNotExists', 'withMaterialized', 'join', 'joinRaw', 'select', 'forUpdate'];
function fakeDb({ issues = [ISSUE], sends = [AUTO_QUEUED], counts = { got: 85, left: 0 } } = {}) {
  const writes = [];
  const reads = [];
  const matches = (row, conds) => conds.every((cond) => Object.entries(cond).every(([k, v]) => row[k] === v));
  db.mockImplementation((table) => {
    const q = { conds: [], calls: new Set() };
    CHAIN.forEach((m) => { q[m] = jest.fn((...args) => { q.calls.add(m); if (m === 'where' && args[0] && typeof args[0] === 'object') q.conds.push(args[0]); if (m === 'whereIn') q.statusIn = args[1]; return q; }); });
    q.count = jest.fn(() => q);
    q.first = jest.fn(async () => {
      reads.push({ table, locked: q.calls.has('forUpdate') });
      if (table === 'newsletter_send_deliveries') {
        // The Resume predicate joins the subscribers; "not yet" is the no-success filter; else the total.
        if (q.calls.has('join')) return { c: counts.left };
        if (q.calls.has('whereNotIn')) return { c: counts.left };
        return { c: counts.got + counts.left };
      }
      const rows = table === 'newsletter_sends' ? sends : issues;
      return rows.find((row) => matches(row, q.conds));
    });
    // A list: a planned send's readers left, or the planned issues in a status (an untold list leaves out a row already told).
    q.then = (resolve, reject) => Promise.resolve(table === 'newsletter_send_deliveries' ? (counts.rows || []) : issues.filter((row) => matches(row, q.conds)
      && (!q.statusIn || (q.statusIn.includes(row.status) && !(row.diagnostics && row.diagnostics.outcomeToldAt))))).then(resolve, reject);
    q.update = jest.fn(async (patch) => { writes.push({ table, conds: q.conds, patch }); return 1; });
    return q;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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
  ['its send failed and no reader got it', { status: 'failed' }, { got: 0, left: 85 }, 'Did not go out: its send failed, and no reader got it'],
  ['its send failed part way', { status: 'failed' }, { got: 40, left: 45 }, 'Did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
  ['it was sent to nobody (every reader dropped out)', { status: 'sent', recipient_count: 0 }, undefined, 'Did not go out: no planned reader was still eligible when it sent'],
  ['its send ended with readers left to resume (a batch SendGrid refused)', { status: 'sent', recipient_count: 85 }, { got: 80, left: 5 }, 'Did not go out: its send ended after 80 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
])('%s: the row fails at once, and one alert says so', async (_label, sendPatch, counts, text) => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, ...sendPatch }], counts });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  // Keyed per issue: a retry of an alert that already landed writes no second row and sends no second push.
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
    sendId: 'send-1', subject: 'Native termites can swarm in winter', errors: [text], outcome: true,
  }, { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes).toEqual([{
    table: 'pest_insider_issues',
    conds: [{ id: 'issue-1' }],
    patch: expect.objectContaining({
      status: 'failed',
      reason: text.charAt(0).toLowerCase() + text.slice(1),
      diagnostics: {
        sql: "coalesce(diagnostics, '{}'::jsonb) || ?::jsonb",
        bindings: [JSON.stringify({ outcomeToldAt: IN_WINDOW.toISOString() })],
      },
    }),
  }]);
});

test('a claim that went stale part way is revoked with the outcome, so its paused worker sends no further batch', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sending', updated_at: new Date('2026-12-03T13:00:00Z') }], counts: { got: 10, left: 75 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes.map(({ table, conds, patch }) => [table, conds[0], patch.status])).toEqual([
    ['newsletter_sends', { id: 'send-1', status: 'sending' }, 'failed'],
    ['pest_insider_issues', { id: 'issue-1' }, 'failed'],
  ]);
  expect(writes[0].patch).toMatchObject({ sending_claim_token: null });
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: its send stopped part way after 10 of 85 readers got it; Resume in Newsletter → History sends it to the rest']);
});

test("a sent issue whose readers' mail servers refused it after SendGrid accepted it gets one alert; the row stays sent", async () => {
  const sent = { ...ISSUE, status: 'sent' };
  const { writes } = fakeDb({ issues: [sent], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 3 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger.mock.calls[0][1]).toMatchObject({
    errors: ["Went out to 85 readers, but 3 readers' mail servers refused it after SendGrid accepted it; Resume in Newsletter → History sends it to them"],
    outcome: true,
  });
  expect(writes).toEqual([{
    table: 'pest_insider_issues',
    conds: [{ id: 'issue-1' }],
    patch: expect.objectContaining({ status: 'sent', diagnostics: expect.objectContaining({ bindings: [JSON.stringify({ outcomeToldAt: IN_WINDOW.toISOString() })] }) }),
  }]);
});

test("a sent issue whose send a person resumed is left to that send: no alert while it is not 'sent'", async () => {
  const { writes } = fakeDb({ issues: [{ ...ISSUE, status: 'sent' }], sends: [{ ...AUTO_QUEUED, status: 'sending', updated_at: IN_WINDOW }], counts: { got: 85, left: 3 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test('a sent issue with no reader left to resume needs nothing', async () => {
  const { writes } = fakeDb({ issues: [{ ...ISSUE, status: 'sent' }], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

// A planned issue's audience, as the planner fixes it: readers 1 and 2, each at the address it qualified on.
const { addressKey } = require('../services/pest-insider/audience');
const PLANNED_FILTER = { holdout: 'pest-insider', subscriber_ids: [1, 2], address_keys: { 1: addressKey('a@example.com'), 2: addressKey('b@example.com') } };
const STILL_PLANNED = { id: 1, customer_id: null, email: 'a@example.com', mailbox_customer_ids: [] };
const ADDRESS_CHANGED = { id: 2, customer_id: null, email: 'new-b@example.com', mailbox_customer_ids: [] };

test("a planned issue's readers left are only those its plan still holds, as each batch re-checks them", async () => {
  fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed', segment_filter: PLANNED_FILTER }], counts: { got: 40, left: 2, rows: [STILL_PLANNED, ADDRESS_CHANGED] } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  // Reader 2's address changed since the plan, so a Resume would skip it: one reader left, not two.
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: its send failed after 40 of 41 readers got it; Resume in Newsletter → History sends it to the rest']);
});

test('a planned send whose only readers left are ones its plan no longer holds reached every reader it can: sent, with no alert', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent', recipient_count: 85, segment_filter: PLANNED_FILTER }], counts: { got: 85, left: 1, rows: [ADDRESS_CHANGED] } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent' }) }]);
  expect(mockTrigger).not.toHaveBeenCalled();
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

test('an alert that reached no one: the row still records the outcome, but untold', async () => {
  mockTrigger.mockImplementation(async () => ({ bellWritten: false, push: null }));
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed' }], counts: { got: 40, left: 45 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(writes).toEqual([{
    table: 'pest_insider_issues',
    conds: [{ id: 'issue-1' }],
    patch: expect.objectContaining({ status: 'failed', reason: expect.stringMatching(/after 40 of 85 readers got it/) }),
  }]);
  expect(writes[0].patch).not.toHaveProperty('diagnostics');
});

test('the next minute tries an untold row again: nothing changes until its alert reaches someone, in the words the row recorded', async () => {
  const untold = {
    ...ISSUE, status: 'failed',
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
    outcome: true,
  }), { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes[0].patch.diagnostics.bindings).toEqual([JSON.stringify({ outcomeToldAt: IN_WINDOW.toISOString() })]);
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
