/**
 * Text-quote bells dedupe on the phone's thread key for 7 days, three ways
 * (notifyBell in services/estimator-engine/index.js):
 *  - A NEW ASK (the placeholder startSmsThreadDraft raises for a fresh quote
 *    text, `newAsk: true`) matches OPEN bells only, under one lock per number.
 *    Before, a done bell inside the window still matched: a new ask with no
 *    draft "stood" on it, so the ask raised nothing. In production 3 asks
 *    between 11-10 and 11-18 got no bell this way, each behind a bell the
 *    72-hour quiet fall-off had closed.
 *  - A run's OUTCOME (`context.origin.bellId`) updates the row its own ask
 *    landed on, open or done.
 *  - Anything else with the key (a clarify-reply resume) keeps the newest
 *    bell of the key, open or done, as before.
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
      const hit = matches();
      mockUpdates.push({ ids: hit.map((row) => row.id), patch, on: name });
      // Applied, so a later lookup in the same test sees the upgrade.
      for (const row of hit) Object.assign(row, { ...patch, metadata: JSON.parse(patch.metadata) });
      return hit.length;
    };
    return b;
  };
  const db = handle('db');
  const trx = handle('trx');
  trx.raw = async (sql, args) => {
    if (mockLockError) throw mockLockError;
    mockLog.push(`lock:${args[0]}`);
  };
  db.transaction = async (work) => work(trx);
  return db;
});
let mockLockError = null;
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

    expect(mockLog).toEqual([`lock:estimator-ask:${KEY}`, 'lookup:trx', 'insert:trx']);
  });

  test('a second ask after the first one\'s insert stands on that bell: one bell for both runs', async () => {
    const first = await askPlaceholder();
    const second = await askPlaceholder();

    expect(second).toEqual({ ok: true, bellId: first.bellId });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('while the bell is still open, a new ask stands on it: no second ring, no rewrite', async () => {
    mockRows.push(bell('bell-open', { minutesAgo: 20 * 60 }));

    await expect(askPlaceholder()).resolves.toEqual({ ok: true, bellId: 'bell-open' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
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
      new Error(`SELECT pg_advisory_xact_lock(hashtext('estimator-ask:${KEY}')) - canceling statement due to lock timeout`),
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
    // An outcome takes no lock: it writes only its own ask's row.
    expect(mockLog).toEqual(['lookup:db']);
  });

  test('a draft outcome reopens that closed row in place, with the draft (unchanged)', async () => {
    mockRows.push(bell('bell-ask', { minutesAgo: 0.5, done: true }));

    await outcome('bell-ask', { estimateId: 'est-8', lane: 'green' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].ids).toEqual(['bell-ask']);
    expect(mockUpdates[0].patch.done_at).toBeNull();
    expect(JSON.parse(mockUpdates[0].patch.metadata).estimateId).toBe('est-8');
  });

  test('two texts on one bell: a late no-draft outcome keeps the first run\'s draft there and raises no second bell', async () => {
    const first = await askPlaceholder();
    const second = await askPlaceholder();
    expect(second.bellId).toBe(first.bellId);
    // Run 1 puts its draft on the shared bell.
    await outcome(first.bellId, { estimateId: 'est-10', lane: 'green' });

    // Run 2 finishes red on the same row.
    await expect(outcome(second.bellId)).resolves.toEqual({ ok: true, bellId: first.bellId });

    // One insert (the first ask) and one rewrite (the draft): no new "send it" bell.
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpdates).toHaveLength(1);
    expect(mockRows.find((row) => row.id === first.bellId).metadata.estimateId).toBe('est-10');
  });

  test('an ask that merged into an older open bell gets its draft there, not on a newer closed bell', async () => {
    // A person reopened the older bell; the newer one stays closed.
    mockRows.push(bell('bell-reopened', { minutesAgo: 5 * 24 * 60 }));
    mockRows.push(bell('bell-newer-closed', { minutesAgo: 2 * 24 * 60, done: true }));
    const ask = await askPlaceholder();
    expect(ask.bellId).toBe('bell-reopened');

    await outcome(ask.bellId, { estimateId: 'est-9', lane: 'yellow' });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates.map((u) => u.ids)).toEqual([['bell-reopened']]);
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
    expect(mockLog).toEqual(['lookup:db']);
  });
});
