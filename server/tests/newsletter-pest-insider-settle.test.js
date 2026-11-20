/**
 * settlePlannedIssues: the one place that tells the owner a planned Waves Pest Insider issue did
 * not go out as its FYI copy said (the plan's skip rule: one admin alert). It runs every minute
 * after the dispatcher, reads each 'scheduled' issue's send, each 'failed' issue nobody was told
 * about yet, each 'sent' one whose readers' mail servers later refused it, and each told 'failed'
 * one whose send has since recovered to 'sent'. An issue's outcome is recorded in one transaction
 * (its send row locked first, then its row); its alert follows the commit, so no lock is held
 * while it is delivered. The row always records the outcome; it is marked told only when its
 * alert reached someone, so an alert that reached no one is tried again the next minute.
 */
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] })),
  parseLockedEventIds: jest.fn(() => []),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...args) => mockTrigger(...args) }));
// The archived-link repair a Resume runs first (a set-based UPDATE): settle runs it before it counts
// the readers a Resume would still mail.
jest.mock('../services/newsletter-subscribers', () => ({
  ...jest.requireActual('../services/newsletter-subscribers'),
  relinkArchivedLinkedSubscribers: jest.fn(async () => ({ relinked: 0 })),
}));

const db = require('../models/db');
const { relinkArchivedLinkedSubscribers: relink } = require('../services/newsletter-subscribers');
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
// readers a Resume would still mail (left: outstandingEligibleDeliveries, the joined query), readers
// whose mail servers refused it for good (refused: a hard bounce, which keeps its sent_at), its
// recipients (every row but a skipped one) and its last accepted batch (lastSentAt), and for a
// planned issue the rows that query lists (rows: the subscriber, its address and customers).
const CHAIN = ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereExists', 'whereNotExists', 'withMaterialized', 'join', 'joinRaw', 'select', 'forUpdate'];
// `bells`: admin notification rows by their dedupeKey (the alert a worker wrote).
function fakeDb({ issues = [ISSUE], sends = [AUTO_QUEUED], counts = { got: 85, left: 0 }, bells = [] } = {}) {
  const writes = [];
  const reads = [];
  // The order of the outcome's writes, its commit, and its alert.
  const events = [];
  const matches = (row, conds) => conds.every((cond) => Object.entries(cond).every(([k, v]) => row[k] === v));
  const told = (row) => Boolean(row.diagnostics && row.diagnostics.outcomeToldAt);
  db.mockImplementation((table) => {
    const q = { conds: [], raws: [], rawBindings: [], calls: new Set() };
    CHAIN.forEach((m) => {
      q[m] = jest.fn((...args) => {
        q.calls.add(m);
        if (m === 'where' && args[0] && typeof args[0] === 'object') q.conds.push(args[0]);
        if (m === 'whereIn') q.statusIn = args[1];
        if (m === 'whereRaw') { q.raws.push(String(args[0])); q.rawBindings.push(...(args[1] || [])); }
        return q;
      });
    });
    q.count = jest.fn(() => q);
    q.max = jest.fn(() => { q.calls.add('max'); return q; });
    q.first = jest.fn(async () => {
      reads.push({ table, locked: q.calls.has('forUpdate') });
      if (table === 'newsletter_send_deliveries') {
        // The Resume predicate joins the subscribers; the last batch is a max; the recipients leave
        // out skipped rows; a hard bounce has bounced_at; "not yet" is the no-success filter; else
        // the total, hard bounces included (they keep their sent_at).
        if (q.calls.has('join')) return { c: counts.left };
        if (q.calls.has('max')) return { at: counts.lastSentAt ?? null };
        if (q.calls.has('whereNot')) return { c: counts.recipients ?? counts.got + counts.left + (counts.refused || 0) };
        if (q.calls.has('whereNotNull')) return { c: counts.refused || 0 };
        if (q.calls.has('whereNotIn')) return { c: counts.left };
        return { c: counts.got + counts.left + (counts.refused || 0) };
      }
      if (table === 'notifications') return bells.find((bell) => q.rawBindings.includes(bell.dedupeKey));
      const rows = table === 'newsletter_sends' ? sends : issues;
      return rows.find((row) => matches(row, q.conds));
    });
    // A list: a planned send's readers left, or the planned issues its SQL picks (a status, told or
    // not, and for the recovered list a send that is now 'sent').
    q.then = (resolve, reject) => Promise.resolve(table === 'newsletter_send_deliveries' ? (counts.rows || []) : issues.filter((row) => matches(row, q.conds)
      && (!q.statusIn || q.statusIn.includes(row.status))
      && (!q.raws.some((sql) => sql.includes("outcomeToldAt' is null")) || !told(row))
      && (!q.raws.some((sql) => sql.includes("outcomeToldAt' is not null")) || told(row))
      && (!q.raws.some((sql) => sql.includes("failureToldAt' is not null")) || Boolean(row.diagnostics && row.diagnostics.failureToldAt))
      && (!q.calls.has('whereExists') || sends.some((send) => send.id === row.send_id && send.status === 'sent')))).then(resolve, reject);
    q.update = jest.fn(async (patch) => { writes.push({ table, conds: q.conds, patch }); events.push(`write ${table}`); return 1; });
    return q;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.transaction = jest.fn(async (work) => {
    const trx = (table) => db(table);
    trx.raw = (sql, bindings) => ({ sql, bindings });
    const result = await work(trx);
    events.push('commit');
    return result;
  });
  mockTrigger.mockImplementation(async () => { events.push('alert'); return { bellWritten: true }; });
  return { writes, reads, events };
}

// The told mark: written after the alert reached someone, while the row still holds that outcome.
const toldMark = (id, status, at = IN_WINDOW) => ({
  table: 'pest_insider_issues',
  conds: [{ id, status }],
  patch: expect.objectContaining({ diagnostics: { sql: "coalesce(diagnostics, '{}'::jsonb) || ?::jsonb", bindings: [JSON.stringify({ outcomeToldAt: at.toISOString() })] } }),
});

beforeEach(() => {
  jest.clearAllMocks();
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
  ['it was sent to nobody (every reader dropped out)', { status: 'sent', recipient_count: 0 }, { got: 0, left: 0 }, 'Did not go out: no planned reader was still eligible when it sent'],
  // A worker that stopped after SendGrid took its batches left recipient_count at 0; the webhooks then moved the send to sent.
  ['its count says nobody, but its ledger shows readers left to resume', { status: 'sent', recipient_count: 0 }, { got: 80, left: 5 }, 'Did not go out: its send ended after 80 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
  ['its send ended with readers left to resume (a batch SendGrid refused)', { status: 'sent', recipient_count: 85 }, { got: 80, left: 5 }, 'Did not go out: its send ended after 80 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
])('%s: the row fails at once, and one alert says so', async (_label, sendPatch, counts, text) => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, ...sendPatch }], counts });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  // Keyed per issue: a retry of an alert that already landed writes no second row and sends no second push.
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
    sendId: 'send-1', subject: 'Native termites can swarm in winter', errors: [text], outcome: true,
  }, { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes).toEqual([
    { table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'failed', reason: text.charAt(0).toLowerCase() + text.slice(1) }) },
    toldMark('issue-1', 'failed'),
  ]);
});

test('the alert follows the commit: no row lock or pooled connection is held while it is delivered', async () => {
  const { events } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed' }], counts: { got: 0, left: 85 } });

  await settlePlannedIssues(IN_WINDOW);

  expect(events).toEqual(['write pest_insider_issues', 'commit', 'alert', 'write pest_insider_issues']);
});

test('a claim that went stale part way is revoked with the outcome, so its paused worker sends no further batch', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sending', updated_at: new Date('2026-12-03T13:00:00Z') }], counts: { got: 10, left: 75 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes.map(({ table, conds, patch }) => [table, conds[0], patch.status])).toEqual([
    ['newsletter_sends', { id: 'send-1', status: 'sending' }, 'failed'],
    ['pest_insider_issues', { id: 'issue-1' }, 'failed'],
    ['pest_insider_issues', { id: 'issue-1', status: 'failed' }, undefined],
  ]);
  expect(writes[0].patch).toMatchObject({ sending_claim_token: null });
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: its send stopped part way after 10 of 85 readers got it; Resume in Newsletter → History sends it to the rest']);
});

test('a claim that went stale after its last batch, with every planned reader done, is released as sent with what its finalize would have written; the issue is sent, with no alert', async () => {
  const lastBatch = new Date('2026-12-03T12:01:30Z');
  const { writes } = fakeDb({
    sends: [{ ...AUTO_QUEUED, status: 'sending', sent_at: null, recipient_count: 0, updated_at: new Date('2026-12-03T13:00:00Z') }],
    counts: { got: 85, left: 0, recipients: 86, lastSentAt: lastBatch },
  });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes.map(({ table, conds, patch }) => [table, conds[0], patch.status])).toEqual([
    ['newsletter_sends', { id: 'send-1', status: 'sending' }, 'sent'],
    // Its calendar week, as finalize advances it.
    ['newsletter_calendar', { send_id: 'send-1' }, 'sent'],
    ['pest_insider_issues', { id: 'issue-1' }, 'sent'],
  ]);
  // Its recipients from the ledger (every row but a skipped one), and when it went out: the public
  // archive lists a send by its sent_at.
  expect(writes[0].patch).toMatchObject({ sending_claim_token: null, recipient_count: 86, sent_at: lastBatch });
  expect(mockTrigger).not.toHaveBeenCalled();
});

test('a stale claim released as sent keeps the sent_at an earlier attempt wrote', async () => {
  const firstAttempt = new Date('2026-12-03T12:00:40Z');
  const { writes } = fakeDb({
    sends: [{ ...AUTO_QUEUED, status: 'sending', sent_at: firstAttempt, updated_at: new Date('2026-12-03T13:00:00Z') }],
    counts: { got: 85, left: 0, lastSentAt: new Date('2026-12-03T12:01:30Z') },
  });

  await settlePlannedIssues(IN_WINDOW);
  expect(writes[0].patch).toMatchObject({ status: 'sent', recipient_count: 85, sent_at: firstAttempt });
});

test('a send that failed after its last batch, with every planned reader done, leaves nothing to resume: the issue is sent, with no alert', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed' }], counts: { got: 85, left: 0 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent' }) }]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test.each([
  ['some readers hard-bounced: the rest got it, and a bounce raises no alert of its own', { got: 80, left: 0, refused: 5 }, null],
  ['every reader hard-bounced: no reader got it', { got: 0, left: 0, refused: 85 }, 'Did not go out: its send ended, and no reader got it'],
  ['readers a Resume would still mail: a hard bounce is not counted as reached', { got: 70, left: 10, refused: 5 }, 'Did not go out: its send ended after 70 of 80 readers got it; Resume in Newsletter → History sends it to the rest'],
])('a hard bounce keeps its sent_at but never counts as reached: %s', async (_label, counts, text) => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes[0].patch).toEqual(expect.objectContaining({ status: text ? 'failed' : 'sent' }));
  if (text) expect(mockTrigger.mock.calls[0][1].errors).toEqual([text]);
  else expect(mockTrigger).not.toHaveBeenCalled();
});

test.each([
  ['every reader hard-bounced', { got: 0, left: 0, refused: 85 }],
  ['every reader bounced or was blocked', { got: 0, left: 5, refused: 80 }],
])('a sent issue no reader got after all (%s) becomes failed, with one alert', async (_label, counts) => {
  const sent = { ...ISSUE, status: 'sent' };
  const { writes } = fakeDb({ issues: [sent], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([
    { table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'failed', reason: 'did not go out: its send ended, and no reader got it' }) },
    toldMark('issue-1', 'failed'),
  ]);
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: its send ended, and no reader got it']);
  expect(mockTrigger.mock.calls[0][2]).toEqual({ dedupeKey: 'pest-insider-outcome:issue-1' });
});

test('a sent issue some of whose readers hard-bounced stays sent, with no alert', async () => {
  const { writes } = fakeDb({ issues: [{ ...ISSUE, status: 'sent' }], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 80, left: 0, refused: 5 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test('the archived-link repair runs in the settle transaction before it counts the readers a Resume would mail', async () => {
  fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent' }] });

  await settlePlannedIssues(IN_WINDOW);
  expect(relink).toHaveBeenCalledTimes(1);
  expect(relink.mock.calls[0][0]).not.toBe(db);
  const ledgerReads = db.mock.calls.map(([table], i) => [table, db.mock.invocationCallOrder[i]]).filter(([table]) => table === 'newsletter_send_deliveries');
  expect(relink.mock.invocationCallOrder[0]).toBeLessThan(ledgerReads[ledgerReads.length - 1][1]);
});

test('a failed archived-link repair leaves the issue to the next minute: nothing is written or told', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent' }] });
  relink.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test("a sent issue whose readers' mail servers blocked it after SendGrid accepted it gets one alert; the row stays sent", async () => {
  const sent = { ...ISSUE, status: 'sent' };
  const { writes } = fakeDb({ issues: [sent], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 3 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger.mock.calls[0][1]).toMatchObject({
    errors: ["Went out to 85 readers, but 3 readers' mail servers blocked it after SendGrid accepted it; Resume in Newsletter → History sends it to them"],
    outcome: true,
  });
  expect(writes).toEqual([
    { table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent', reason: expect.stringMatching(/^went out to 85 readers/) }) },
    toldMark('issue-1', 'sent'),
  ]);
});

test('a failed issue whose send became sent (a Resume that finished, or delivery confirmations that came late) becomes sent, with one correction for the alert it had', async () => {
  const failed = { ...ISSUE, status: 'failed', reason: 'did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest', diagnostics: { outcomeToldAt: '2026-12-03T12:30:00.000Z' } };
  const { writes } = fakeDb({ issues: [failed], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 } });
  const correction = 'went out after all: 85 readers got it, after a Resume or delivery confirmations that came late; there is nothing to resume';

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
    errors: [correction.charAt(0).toUpperCase() + correction.slice(1)], outcome: true,
  }), { dedupeKey: 'pest-insider-recovered:issue-1' });
  expect(writes).toEqual([
    {
      table: 'pest_insider_issues',
      conds: [{ id: 'issue-1' }],
      patch: expect.objectContaining({
        status: 'sent',
        reason: correction,
        // The failure stays on record as told; the correction is told next.
        diagnostics: { sql: "(coalesce(diagnostics, '{}'::jsonb) - 'outcomeToldAt') || ?::jsonb", bindings: [JSON.stringify({ failureToldAt: '2026-12-03T12:30:00.000Z' })] },
      }),
    },
    toldMark('issue-1', 'sent'),
  ]);
});

test('a send whose count says nobody, but whose ledger shows every planned reader got it, is sent, quietly', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'sent', recipient_count: 0 }], counts: { got: 85, left: 0 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).not.toHaveBeenCalled();
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent' }) }]);
});

test('a worker that delivered the failure alert but stopped before marking the row told: its keyed bell row still gets the correction', async () => {
  const failed = { ...ISSUE, status: 'failed', reason: 'did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest' };
  const bells = [{ dedupeKey: 'pest-insider-outcome:issue-1', created_at: new Date('2026-12-03T12:30:00Z') }];
  const { writes } = fakeDb({ issues: [failed], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 }, bells });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.anything(), { dedupeKey: 'pest-insider-recovered:issue-1' });
  expect(writes[0].patch.diagnostics.bindings).toEqual([JSON.stringify({ failureToldAt: '2026-12-03T12:30:00.000Z' })]);
});

test('a failed issue nobody was told about, whose send recovered to sent, becomes sent quietly', async () => {
  const failed = { ...ISSUE, status: 'failed', reason: 'did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest' };
  const { writes } = fakeDb({ issues: [failed], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([{ table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'sent', reason: null }) }]);
  expect(mockTrigger).not.toHaveBeenCalled();
});

test('a correction that reached no one is told the next minute, in the words the row recorded', async () => {
  const recovered = { ...ISSUE, status: 'sent', reason: 'went out after all: 85 readers got it', diagnostics: { failureToldAt: '2026-12-03T12:30:00.000Z' } };
  const { writes } = fakeDb({ issues: [recovered], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 } });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({ errors: ['Went out after all: 85 readers got it'] }), { dedupeKey: 'pest-insider-recovered:issue-1' });
  expect(writes).toEqual([toldMark('issue-1', 'sent')]);
});

test('a told failed issue whose send is still not sent is not read again', async () => {
  const failed = { ...ISSUE, status: 'failed', reason: 'did not go out: x', diagnostics: { outcomeToldAt: '2026-12-03T12:30:00.000Z' } };
  const { writes } = fakeDb({ issues: [failed], sends: [{ ...AUTO_QUEUED, status: 'failed' }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(db.transaction).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
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
    ['pest_insider_issues', { id: 'issue-1', status: 'failed' }, undefined],
  ]);
  expect(writes[0].patch).toMatchObject({ scheduled_for: null, proof_token: null, proof_approved_at: null });
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: it was still queued when its 7:00-10:00 AM ET window closed, so it went back to a draft']);
});

test('a draft when its window closed: the row fails, and one alert says so', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'draft' }] });

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 1 });
  expect(writes).toEqual([
    { table: 'pest_insider_issues', conds: [{ id: 'issue-1' }], patch: expect.objectContaining({ status: 'failed' }) },
    toldMark('issue-1', 'failed', AFTER_WINDOW),
  ]);
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Did not go out: it was back in drafts when its 7:00-10:00 AM ET window closed']);
});

test('a send a person scheduled by hand goes at its own time: left alone after the window', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, proof_approved_at: null }] });

  expect(await settlePlannedIssues(AFTER_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);
});

test("a failed row a send-time stop wrote gets its one alert, in the stop's words; a row already told is left alone", async () => {
  const stopped = { ...ISSUE, id: 'issue-2', status: 'failed', reason: 'stopped at send time: scheduled_for is not its issue Thursday (2026-12-03) at 7:00 AM ET' };
  const told = { ...ISSUE, id: 'issue-3', send_id: 'send-3', status: 'failed', reason: 'stopped at send time: x', diagnostics: { outcomeToldAt: '2026-12-03T12:01:00.000Z' } };
  const { writes } = fakeDb({ issues: [stopped, told], sends: [{ ...AUTO_QUEUED, status: 'draft' }] });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(mockTrigger.mock.calls[0][1].errors).toEqual(['Stopped at send time: scheduled_for is not its issue Thursday (2026-12-03) at 7:00 AM ET']);
  // The row already records the stop's outcome: only the told mark is written.
  expect(writes).toEqual([toldMark('issue-2', 'failed')]);
});

test('an alert that reached no one: the row still records the outcome, but untold', async () => {
  const { writes } = fakeDb({ sends: [{ ...AUTO_QUEUED, status: 'failed' }], counts: { got: 40, left: 45 } });
  mockTrigger.mockImplementation(async () => ({ bellWritten: false, push: null }));

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
  let { writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'failed' }] });
  mockTrigger.mockImplementationOnce(async () => ({ bellWritten: false, push: { sent: 0 } }));

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 0 });
  expect(writes).toEqual([]);

  ({ writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'failed' }] }));
  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger).toHaveBeenLastCalledWith('newsletter_proof_blocked', expect.objectContaining({
    errors: ['Did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest'],
    outcome: true,
  }), { dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes).toEqual([toldMark('issue-1', 'failed')]);
});

test('a retry whose alert was already written (a crash before the row was marked told) finds it by its key and marks the row told', async () => {
  const untold = { ...ISSUE, status: 'failed', reason: 'stopped at send time: x' };
  const { writes } = fakeDb({ issues: [untold], sends: [{ ...AUTO_QUEUED, status: 'draft' }] });
  // triggerNotification on a dedupe hit: the existing bell row counts as written, and no push goes again.
  mockTrigger.mockImplementation(async () => ({ bellWritten: true, push: null, deduped: true }));

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  expect(mockTrigger.mock.calls[0][2]).toEqual({ dedupeKey: 'pest-insider-outcome:issue-1' });
  expect(writes).toEqual([toldMark('issue-1', 'failed')]);
});

test('a failed row past the lookback is no longer listed', async () => {
  fakeDb();
  const lists = [];
  const real = db.getMockImplementation();
  db.mockImplementation((table) => { const q = real(table); lists.push(q); return q; });

  await settlePlannedIssues(IN_WINDOW);

  expect(lists[1].whereRaw).toHaveBeenCalledWith("issue_date >= (now() at time zone 'America/New_York')::date - ?::int", [14]);
  // The recovered list reads the send's own last change instead, so a Resume long after the issue counts.
  expect(lists[2].whereRaw).not.toHaveBeenCalledWith("issue_date >= (now() at time zone 'America/New_York')::date - ?::int", [14]);
  const sendQuery = { select: jest.fn(() => sendQuery), from: jest.fn(() => sendQuery), where: jest.fn(() => sendQuery), whereRaw: jest.fn(() => sendQuery) };
  lists[2].whereExists.mock.calls[0][0].call(sendQuery);
  expect(sendQuery.where).toHaveBeenCalledWith('newsletter_sends.status', 'sent');
  expect(sendQuery.whereRaw).toHaveBeenCalledWith("newsletter_sends.updated_at >= now() - ?::int * interval '1 day'", [14]);
  // A correction that reached no one is listed by the recovery's own write, not the issue date.
  expect(lists[3].where).toHaveBeenCalledWith({ status: 'sent' });
  expect(lists[3].whereRaw).toHaveBeenCalledWith("diagnostics->>'failureToldAt' is not null");
  expect(lists[3].whereRaw).toHaveBeenCalledWith("diagnostics->>'outcomeToldAt' is null");
  expect(lists[3].whereRaw).toHaveBeenCalledWith("updated_at >= now() - ?::int * interval '1 day'", [14]);
  expect(lists[3].whereRaw).not.toHaveBeenCalledWith("issue_date >= (now() at time zone 'America/New_York')::date - ?::int", [14]);
});

test('a failed issue, told or not, whose send became sent is settled once, also when it is on two lists', async () => {
  const failed = { ...ISSUE, status: 'failed', reason: 'did not go out: its send failed after 40 of 85 readers got it; Resume in Newsletter → History sends it to the rest' };
  fakeDb({ issues: [failed], sends: [{ ...AUTO_QUEUED, status: 'sent' }], counts: { got: 85, left: 0 } });
  const lists = [];
  const real = db.getMockImplementation();
  db.mockImplementation((table) => { const q = real(table); lists.push(q); return q; });

  expect(await settlePlannedIssues(IN_WINDOW)).toEqual({ settled: 1 });
  // The recovered list no longer asks whether the owner was told.
  expect(lists[2].whereRaw).not.toHaveBeenCalledWith("diagnostics->>'outcomeToldAt' is not null");
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
