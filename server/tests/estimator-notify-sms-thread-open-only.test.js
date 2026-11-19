/**
 * Text-quote bells dedupe on the phone's thread key for 7 days, OPEN bells
 * only. Before, a done bell inside the window still matched: a new ask with
 * no draft "stood" on it (both sides draft-less), so the ask raised nothing.
 * In production 3 asks between 11-10 and 11-18 got no bell this way, each
 * behind a bell the 72-hour quiet fall-off had closed.
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
const HOUR = 3600e3;

function bell(id, { hoursAgo, done = false, estimateId = null }) {
  return {
    id,
    created_at: new Date(Date.now() - hoursAgo * HOUR),
    done_at: done ? new Date(Date.now() - HOUR) : null,
    metadata: { smsThreadKey: KEY, estimator_engine: true, quote_promised: true, lane: 'red', estimateId },
  };
}

// The placeholder startSmsThreadDraft writes for every ask, before the draft runs.
const askPlaceholder = () => notify({
  call: null,
  context: null,
  lane: 'red',
  quotePromised: true,
  threadKey: KEY,
  title: 'Quote asked by text — send it',
  body: 'Texter …0123 asked for a quote by text. The estimator engine is drafting now.',
  link: '/admin/communications?message=SM-test-2',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  mockUpdates.length = 0;
});

describe('notify() text-thread dedupe matches open bells only', () => {
  test('a new ask after the number\'s bell was closed rings a fresh bell (it used to stand on the closed one)', async () => {
    mockRows.push(bell('bell-closed', { hoursAgo: 100, done: true }));

    await expect(askPlaceholder()).resolves.toBe(true);

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(title).toBe('Quote asked by text — send it');
    expect(opts.metadata.smsThreadKey).toBe(KEY);
    expect(opts.link).toBe('/admin/communications?message=SM-test-2');
    expect(mockUpdates).toHaveLength(0);
  });

  test('a draft for that ask also gets a fresh bell; the closed bell stays closed', async () => {
    mockRows.push(bell('bell-closed', { hoursAgo: 100, done: true }));

    await notify({
      call: null, context: null, lane: 'yellow', quotePromised: true, threadKey: KEY,
      estimateId: 'est-7', title: 'AI estimate draft needs review — $49/mo', body: 'Drafted from the text thread.',
    });

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.estimateId).toBe('est-7');
    expect(mockUpdates).toHaveLength(0);
  });

  test('a new ask while the bell is still open stands on it: no second ring, no rewrite', async () => {
    mockRows.push(bell('bell-open', { hoursAgo: 20 }));

    await expect(askPlaceholder()).resolves.toBe(true);

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });

  test('a draft upgrades the open placeholder in place, even when a newer closed bell exists', async () => {
    mockRows.push(bell('bell-open', { hoursAgo: 30 }));
    mockRows.push(bell('bell-closed-newer', { hoursAgo: 10, done: true }));

    await notify({
      call: null, context: null, lane: 'green', quotePromised: true, threadKey: KEY,
      estimateId: 'est-8', title: 'AI estimate draft ready — $39/mo', body: 'Drafted from the text thread.',
    });

    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].ids).toEqual(['bell-open']);
    expect(JSON.parse(mockUpdates[0].patch.metadata).estimateId).toBe('est-8');
  });

  test('a bell older than the 7-day window is not matched, open or not', async () => {
    mockRows.push(bell('bell-old-open', { hoursAgo: 8 * 24 }));

    await askPlaceholder();

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpdates).toHaveLength(0);
  });
});
