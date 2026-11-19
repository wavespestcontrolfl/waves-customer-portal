/**
 * Text-quote bells dedupe on the phone's thread key for 7 days. A NEW ASK
 * (the placeholder startSmsThreadDraft raises, `newAsk: true`) matches OPEN
 * bells only. Before, a done bell inside the window still matched: a new ask
 * with no draft "stood" on it (both sides draft-less), so the ask raised
 * nothing. In production 3 asks between 11-10 and 11-18 got no bell this way,
 * each behind a bell the 72-hour quiet fall-off had closed.
 *
 * A run's OUTCOME (no `newAsk`) still matches its own placeholder, open or
 * done: a person who closed the placeholder while the composer ran must not
 * get a second "send it" bell for the same ask, and a real draft still
 * reopens it in place, as before.
 *
 * Drives the real notify() over a fake notifications table that applies the
 * same filters the query asks for (thread key, the 7-day window, done_at).
 * Fixtures are fictitious; no real customer data.
 */

const mockRows = [];
const mockUpdates = [];
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-new' }));

jest.mock('../models/db', () => {
  const db = (table) => {
    const filters = [];
    const b = {};
    b.whereRaw = (clause, args) => {
      if (/smsThreadKey/.test(clause)) filters.push((row) => row.metadata.smsThreadKey === args[0]);
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
      const row = matches()[0];
      return row ? { ...row, metadata: JSON.stringify(row.metadata) } : undefined;
    };
    b.update = async (patch) => {
      const hit = matches();
      mockUpdates.push({ ids: hit.map((row) => row.id), patch });
      return hit.length;
    };
    return b;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
  adminBodyColumns: (_category, body) => ({ body, detail: null }),
}));

const { notify } = require('../services/estimator-engine/index');

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
const askPlaceholder = () => notify({
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

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  mockUpdates.length = 0;
});

describe('a new ask matches the number\'s OPEN bell only', () => {
  test('after the number\'s bell was closed, a new ask rings a fresh bell (it used to stand on the closed one)', async () => {
    mockRows.push(bell('bell-closed', { minutesAgo: 100 * 60, done: true }));

    await expect(askPlaceholder()).resolves.toBe(true);

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(title).toBe('Quote asked by text — send it');
    expect(opts.metadata.smsThreadKey).toBe(KEY);
    expect(opts.link).toBe('/admin/communications?message=SM-test-2');
    // The closed bell is left alone.
    expect(mockUpdates).toHaveLength(0);
  });

  test('while the bell is still open, a new ask stands on it: no second ring, no rewrite', async () => {
    mockRows.push(bell('bell-open', { minutesAgo: 20 * 60 }));

    await expect(askPlaceholder()).resolves.toBe(true);

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });

  test('a bell older than the 7-day window is not matched, open or not', async () => {
    mockRows.push(bell('bell-old-open', { minutesAgo: 8 * 24 * 60 }));

    await askPlaceholder();

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpdates).toHaveLength(0);
  });
});

describe('a run\'s outcome still finds its own placeholder, open or done', () => {
  test('a no-draft outcome after a person closed the placeholder stands: no second "send it" bell', async () => {
    mockRows.push(bell('bell-placeholder', { minutesAgo: 0.5, done: true }));

    await expect(notify({
      call: null, context: null, lane: 'red', quotePromised: true, threadKey: KEY,
      title: 'Quote asked by text — send it', body: 'Texter …0123: quote requested over SMS, no auto-draft (thin thread). Reply with pricing manually.',
    })).resolves.toBe(true);

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });

  test('a draft outcome reopens its closed placeholder in place, with the draft (unchanged)', async () => {
    mockRows.push(bell('bell-placeholder', { minutesAgo: 0.5, done: true }));

    await notify({
      call: null, context: null, lane: 'green', quotePromised: true, threadKey: KEY,
      estimateId: 'est-8', title: 'AI estimate draft ready — $39/mo', body: 'Drafted from the text thread.',
    });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].ids).toEqual(['bell-placeholder']);
    expect(mockUpdates[0].patch.done_at).toBeNull();
    expect(JSON.parse(mockUpdates[0].patch.metadata).estimateId).toBe('est-8');
  });

  test('an outcome for an open placeholder upgrades it in place', async () => {
    mockRows.push(bell('bell-placeholder', { minutesAgo: 0.5 }));

    await notify({
      call: null, context: null, lane: 'yellow', quotePromised: true, threadKey: KEY,
      estimateId: 'est-9', title: 'AI estimate draft needs review — $49/mo', body: 'Drafted from the text thread.',
    });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates.map((u) => u.ids)).toEqual([['bell-placeholder']]);
  });
});
