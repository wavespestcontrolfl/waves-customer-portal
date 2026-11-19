/**
 * Text-quote bells dedupe on the phone's thread key for 7 days, three ways
 * (notifyBell in services/estimator-engine/index.js):
 *  - A NEW ASK (the placeholder startSmsThreadDraft raises for a fresh quote
 *    text, `newAsk: true`) matches OPEN bells only. A merge into one stamps
 *    metadata.observedAt, so the 72-hour quiet fall-off counts from the ask.
 *    Before, a done bell inside the window still matched: a new ask with no
 *    draft "stood" on it, so the ask raised nothing. In production 3 asks
 *    between 11-10 and 11-18 got no bell this way, each behind a bell the
 *    72-hour quiet fall-off had closed.
 *  - A run's OUTCOME (`context.origin.bellId`) updates the row its own ask
 *    landed on, open or done. A bell a later ask MERGED into (`mergedAsk` on
 *    the row) stays the asks' task: every draft on it gets its own bell.
 *  - Anything else with the key (a clarify-reply resume) keeps the newest
 *    bell of the key, open or done, as before.
 * Every text-bell write holds one lock per number around its lookup and write.
 *
 * Drives the real notifyBell() over a fake notifications table that applies
 * the filters the query asks for (thread key or row id, the 7-day window,
 * done_at). Fixtures are fictitious; no real customer data.
 */

const mockRows = [];
const mockUpdates = [];
const mockLog = [];
let mockInserted = 0;
const mockNotifyAdmin = jest.fn(async (_category, title, _body, opts) => {
  mockInserted += 1;
  mockLog.push(`insert:${opts.trx ? 'trx' : 'db'}`);
  const row = { id: `bell-new-${mockInserted}`, created_at: new Date(), done_at: null, title, metadata: opts.metadata };
  mockRows.push(row);
  return row;
});

jest.mock('../models/db', () => {
  const handle = (name) => (table) => {
    const filters = [];
    const b = {};
    b.whereRaw = (clause, args) => {
      if (/smsThreadKey/.test(clause)) filters.push((row) => row.metadata.smsThreadKey === args[0]);
      if (clause === 'id = ?') filters.push((row) => row.id === args[0]);
      return b;
    };
    b.where = (col, op, value) => {
      if (col === 'created_at' && op === '>=') filters.push((row) => row.created_at >= value);
      if (col && typeof col === 'object' && col.id) filters.push((row) => row.id === col.id);
      return b;
    };
    b.whereNull = (col) => {
      filters.push((row) => row[col] == null);
      return b;
    };
    b.orderBy = () => b;
    const matches = () => (table === 'notifications' ? mockRows : [])
      .filter((row) => filters.every((keep) => keep(row)))
      .sort((x, y) => y.created_at - x.created_at);
    b.first = async () => {
      mockLog.push(`lookup:${name}`);
      const row = matches()[0];
      return row ? { ...row, metadata: JSON.stringify(row.metadata) } : undefined;
    };
    b.update = async (patch) => {
      if (mockBeforeUpdate) mockBeforeUpdate();
      const hit = matches();
      mockUpdates.push({ ids: hit.map((row) => row.id), patch, on: name });
      // Applied, so a later lookup in the same test sees the upgrade.
      for (const row of hit) {
        const metadata = patch.metadata && patch.metadata.mockMerge
          ? { ...row.metadata, ...patch.metadata.mockMerge }
          : JSON.parse(patch.metadata);
        Object.assign(row, { ...patch, metadata });
      }
      return hit.length;
    };
    return b;
  };
  const db = handle('db');
  const trx = handle('trx');
  trx.raw = (sql, args) => {
    // `metadata || ?::jsonb`: the patch value the fake update merges.
    if (!/pg_advisory_xact_lock/.test(sql)) return { mockMerge: JSON.parse(args[0]) };
    if (mockLockError) return Promise.reject(mockLockError);
    mockLog.push(`lock:${args[0]}`);
    return Promise.resolve();
  };
  db.transaction = async (work) => work(trx);
  return db;
});
let mockLockError = null;
let mockBeforeUpdate = null;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
  adminBodyColumns: (_category, body) => ({ body, detail: null }),
  safeErrorSummary: jest.requireActual('../services/notification-service').safeErrorSummary,
}));

const logger = require('../services/logger');
const { notifyBell, notify } = require('../services/estimator-engine/index');

const KEY = 'sms:9415550123';
const MINUTE = 60e3;

function bell(id, { minutesAgo, done = false, estimateId = null }) {
  return {
    id,
    created_at: new Date(Date.now() - minutesAgo * MINUTE),
    done_at: done ? new Date() : null,
    metadata: { smsThreadKey: KEY, estimator_engine: true, quote_promised: true, lane: 'red', estimateId },
  };
}

// The placeholder startSmsThreadDraft raises for each fresh ask, before the draft runs.
const askPlaceholder = () => notifyBell({
  call: null,
  context: null,
  lane: 'red',
  quotePromised: true,
  threadKey: KEY,
  title: 'Quote asked by text — send it',
  body: 'Texter …0123 asked for a quote by text. The estimator engine is drafting now.',
  link: '/admin/communications?message=SM-test-2',
  newAsk: true,
});

// A draft run's outcome: runDraftPipeline passes the run's context, whose
// origin carries the row the ask landed on.
const outcome = (bellId, { estimateId = null, lane = 'red' } = {}) => notifyBell({
  call: null,
  context: { origin: { channel: 'sms_thread', threadKey: KEY, bellId } },
  lane,
  quotePromised: true,
  threadKey: KEY,
  estimateId,
  title: estimateId ? 'AI estimate draft ready — $39/mo' : 'Quote asked by text — send it',
  body: estimateId ? 'Drafted from the text thread.' : 'Texter …0123: quote requested over SMS, no auto-draft (thin thread). Reply with pricing manually.',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  mockUpdates.length = 0;
  mockLog.length = 0;
  mockInserted = 0;
  mockLockError = null;
  mockBeforeUpdate = null;
});

describe('a new ask matches the number\'s OPEN bell only', () => {
  test('after the number\'s bell was closed, a new ask rings a fresh bell (it used to stand on the closed one)', async () => {
    mockRows.push(bell('bell-closed', { minutesAgo: 100 * 60, done: true }));

    await expect(askPlaceholder()).resolves.toEqual({ ok: true, bellId: 'bell-new-1' });

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(title).toBe('Quote asked by text — send it');
    expect(opts.metadata.smsThreadKey).toBe(KEY);
    expect(opts.link).toBe('/admin/communications?message=SM-test-2');
    // The closed bell is left alone.
    expect(mockUpdates).toHaveLength(0);
  });

  test('the lookup and the insert run on one transaction that first takes the number\'s lock', async () => {
    await askPlaceholder();

    expect(mockLog).toEqual([`lock:estimator-bell:${KEY}`, 'lookup:trx', 'insert:trx']);
  });

  test('a second ask after the first one\'s insert stands on that bell: one bell for both runs', async () => {
    const first = await askPlaceholder();
    const second = await askPlaceholder();

    expect(second).toEqual({ ok: true, bellId: first.bellId });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockRows.find((row) => row.id === first.bellId).metadata.mergedAsk).toBe(true);
  });

  test('a new ask merges into the open bell: no second ring, no rewrite, and the 72-hour quiet clock restarts', async () => {
    // 68 hours old: the quiet fall-off would close it within 4 hours.
    mockRows.push(bell('bell-open', { minutesAgo: 68 * 60 }));

    await expect(askPlaceholder()).resolves.toEqual({ ok: true, bellId: 'bell-open' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].on).toBe('trx');
    // Only metadata changes: no new title or body, no read or done reset.
    expect(Object.keys(mockUpdates[0].patch)).toEqual(['metadata']);
    const row = mockRows.find((r) => r.id === 'bell-open');
    expect(Date.now() - Date.parse(row.metadata.observedAt)).toBeLessThan(5000);
    expect(row.metadata.mergedAsk).toBe(true);
    expect(row.metadata.lane).toBe('red');
    expect(row.done_at).toBeNull();
  });

  test('a close that wins between the lookup and the stamp: the new ask raises its own bell', async () => {
    const open = bell('bell-open', { minutesAgo: 72 * 60 - 1 });
    mockRows.push(open);
    // The quiet fall-off closes the row after the lookup read it open.
    mockBeforeUpdate = () => { open.done_at = new Date(); };

    await expect(askPlaceholder()).resolves.toEqual({ ok: true, bellId: 'bell-new-1' });

    expect(mockUpdates[0].ids).toEqual([]);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a bell older than the 7-day window is not matched, open or not', async () => {
    mockRows.push(bell('bell-old-open', { minutesAgo: 8 * 24 * 60 }));

    await askPlaceholder();

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpdates).toHaveLength(0);
  });

  test('a failed lock is not a bell, and its log line carries a code, never the phone digits', async () => {
    // Knex puts the SQL and its bound values in err.message.
    mockLockError = Object.assign(
      new Error(`SELECT pg_advisory_xact_lock(hashtext('estimator-bell:${KEY}')) - canceling statement due to lock timeout`),
      { code: '55P03' },
    );

    await expect(askPlaceholder()).resolves.toEqual({ ok: false, bellId: null });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    const lines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('55P03'))).toBe(true);
    expect(lines.join('\n')).not.toContain('9415550123');
  });

  test('notify() keeps its boolean answer for every other caller', async () => {
    await expect(notify({
      call: null, context: null, lane: 'red', quotePromised: true, threadKey: KEY,
      title: 'Quote asked by text — send it', body: 'Texter …0123 asked for a quote by text.', newAsk: true,
    })).resolves.toBe(true);
  });
});

describe('a run\'s outcome updates the row its own ask landed on, open or done', () => {
  test('a no-draft outcome after a person closed that row stands: no second "send it" bell', async () => {
    mockRows.push(bell('bell-ask', { minutesAgo: 0.5, done: true }));

    await expect(outcome('bell-ask')).resolves.toEqual({ ok: true, bellId: 'bell-ask' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
    // The outcome's lookup and write hold the number's lock too.
    expect(mockLog).toEqual([`lock:estimator-bell:${KEY}`, 'lookup:trx']);
  });

  test('a draft outcome reopens that closed row in place, with the draft (unchanged)', async () => {
    mockRows.push(bell('bell-ask', { minutesAgo: 0.5, done: true }));

    await outcome('bell-ask', { estimateId: 'est-8', lane: 'green' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].ids).toEqual(['bell-ask']);
    expect(mockUpdates[0].on).toBe('trx');
    expect(mockUpdates[0].patch.done_at).toBeNull();
    expect(JSON.parse(mockUpdates[0].patch.metadata).estimateId).toBe('est-8');
  });

  test('two asks on one bell, two drafts: each draft gets its own bell, and the shared bell stays the task', async () => {
    const first = await askPlaceholder();
    const second = await askPlaceholder();
    expect(second.bellId).toBe(first.bellId);

    await expect(outcome(first.bellId, { estimateId: 'est-10', lane: 'green' })).resolves.toEqual({ ok: true, bellId: 'bell-new-2' });
    await expect(outcome(second.bellId, { estimateId: 'est-11', lane: 'green' })).resolves.toEqual({ ok: true, bellId: 'bell-new-3' });

    const task = mockRows.find((row) => row.id === first.bellId);
    expect(task.title).toBe('Quote asked by text — send it');
    expect(task.metadata.estimateId).toBeNull();
    expect(mockNotifyAdmin.mock.calls.map(([, , , opts]) => opts.metadata.estimateId)).toEqual([null, 'est-10', 'est-11']);
  });

  test.each([
    ['the merged ask finds no draft first', ['b', 'a']],
    ['the first ask drafts first', ['a', 'b']],
  ])('two asks on one bell, one draft and one red (%s): the draft gets its own bell, the shared bell stays the "send it" task', async (_order, order) => {
    // Ask A raised the bell; ask B merged into it.
    const a = await askPlaceholder();
    const b = await askPlaceholder();
    const runs = { a: () => outcome(a.bellId, { estimateId: 'est-14', lane: 'green' }), b: () => outcome(b.bellId) };
    for (const key of order) await runs[key]();

    const task = mockRows.find((row) => row.id === a.bellId);
    expect(task.title).toBe('Quote asked by text — send it');
    expect(task.metadata.estimateId).toBeNull();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(2);
    expect(mockNotifyAdmin.mock.calls[1][3].metadata.estimateId).toBe('est-14');
  });

  test('red first, then a merged ask\'s draft: the draft gets its own bell and the "send it" task stays', async () => {
    const first = await askPlaceholder();
    // Ask 1's run finishes with no draft: the row stays its "send it" task.
    await outcome(first.bellId);
    const second = await askPlaceholder();
    expect(second).toEqual({ ok: true, bellId: first.bellId });

    await expect(outcome(second.bellId, { estimateId: 'est-12', lane: 'green' }))
      .resolves.toEqual({ ok: true, bellId: 'bell-new-2' });

    const task = mockRows.find((row) => row.id === first.bellId);
    expect(task.title).toBe('Quote asked by text — send it');
    expect(task.metadata.estimateId).toBeNull();
    expect(mockNotifyAdmin.mock.calls[1][3].metadata.estimateId).toBe('est-12');
  });

  test('red first, then a clarify resume\'s draft: the draft upgrades the same row (one request, one bell)', async () => {
    const first = await askPlaceholder();
    await outcome(first.bellId);

    // A clarify resume binds to the same row and is no merge.
    await expect(outcome(first.bellId, { estimateId: 'est-13', lane: 'green' }))
      .resolves.toEqual({ ok: true, bellId: first.bellId });

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockRows.find((row) => row.id === first.bellId).metadata.estimateId).toBe('est-13');
  });

  test('a merged ask\'s draft gets its own bell: the older open bell keeps its task, the newer closed one stays closed', async () => {
    // A person reopened the older bell; the newer one stays closed.
    mockRows.push(bell('bell-reopened', { minutesAgo: 5 * 24 * 60 }));
    mockRows.push(bell('bell-newer-closed', { minutesAgo: 2 * 24 * 60, done: true }));
    const ask = await askPlaceholder();
    expect(ask).toEqual({ ok: true, bellId: 'bell-reopened' });

    await expect(outcome(ask.bellId, { estimateId: 'est-9', lane: 'yellow' }))
      .resolves.toEqual({ ok: true, bellId: 'bell-new-1' });

    // Only the ask's observedAt stamp touched the older bell.
    expect(mockUpdates.map((u) => u.ids)).toEqual([['bell-reopened']]);
    expect(mockRows.find((row) => row.id === 'bell-reopened').metadata.estimateId).toBeNull();
    expect(mockRows.find((row) => row.id === 'bell-newer-closed').done_at).not.toBeNull();
  });
});

describe('a clarify-reply resume keeps the newest bell of the number, open or done', () => {
  test('it stands on a closed draftless bell, as before: no ring', async () => {
    mockRows.push(bell('bell-closed', { minutesAgo: 30 * 60, done: true }));

    await expect(notifyBell({
      call: null, context: null, lane: 'red', quotePromised: true, threadKey: KEY, newAsk: false,
      title: 'Quote asked by text — send it', body: 'Texter …0123 asked for a quote by text.',
    })).resolves.toEqual({ ok: true, bellId: 'bell-closed' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockLog).toEqual([`lock:estimator-bell:${KEY}`, 'lookup:trx']);
  });
});
