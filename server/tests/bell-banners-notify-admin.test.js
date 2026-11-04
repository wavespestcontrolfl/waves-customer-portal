/**
 * notifyAdmin and the phone banner (GATE_BELL_BANNERS): the one hook in notifyAdmin covers a write on its own
 * transaction and a write on the caller's. The db is a small in-memory stand-in (as in
 * notification-admin-dedupe-refresh.test.js); the banner itself is the mocked triggerNotification.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })),
  TRIGGER_REGISTRY: {},
}));

let mockRows;
jest.mock('../models/db', () => {
  const builder = (table) => {
    const conds = [];
    let order = null;
    const b = {
      where(c) { Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
      whereRaw(_sql, [key]) { conds.push((r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {}).dedupeKey === key); return b; },
      orderBy(col, dir) { order = { col, dir }; return b; },
      first: async () => {
        const hits = (mockRows[table] || []).filter((r) => conds.every((c) => c(r)));
        if (order) hits.sort((x, y) => (new Date(y[order.col] || 0) - new Date(x[order.col] || 0)) * (order.dir === 'desc' ? 1 : -1));
        return hits[0] || null;
      },
      update: async (patch) => { const hit = (mockRows[table] || []).filter((r) => conds.every((c) => c(r))); hit.forEach((r) => Object.assign(r, patch)); return hit.length; },
      insert: (row) => ({ returning: async () => { const created = { id: `n-${(mockRows[table] ||= []).length + 1}`, read_at: null, ...row }; mockRows[table].push(created); return [created]; } }),
    };
    return b;
  };
  const makeTrx = () => {
    const trx = jest.fn((table) => builder(table));
    trx.raw = jest.fn(async () => {});
    trx.fn = { now: () => new Date('2026-11-03T15:00:00Z') };
    return trx;
  };
  const fn = jest.fn((table) => builder(table));
  // A real knex transaction: the callback's resolve commits, its throw rolls back; executionPromise settles after.
  fn.transaction = async (cb) => {
    const trx = makeTrx();
    trx.executionPromise = Promise.resolve();
    return cb(trx);
  };
  fn.__makeTrx = makeTrx;
  return fn;
});

const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const NotificationService = require('../services/notification-service');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A caller's transaction whose commit the test controls.
function callerTrx(parent = null) {
  const trx = db.__makeTrx();
  trx.executionPromise = new Promise((resolve, reject) => { trx.commit = resolve; trx.rollback = reject; });
  if (parent) trx.parentTransaction = parent;
  return trx;
}

const bell = (opts = {}, body = 'Facebook: can you call me?') => NotificationService.notifyAdmin('alert', 'Reply to Pat S. on Facebook', body, {
  dedupeKey: 'messenger-thread:t-1', refreshOnDedupe: true, bumpOnRefresh: true, bell: true, link: '/admin/communications#tab=messenger&thread=t-1',
  metadata: { conversationId: 't-1', triggerKey: 'messenger_reply' }, ...opts,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = { notifications: [] };
  process.env.GATE_BELL_BANNERS = 'true';
});
afterEach(() => { delete process.env.GATE_BELL_BANNERS; });

test('a fresh keyed row sends one pushOnly banner with the row\'s own words, and the caller still gets the row', async () => {
  const result = await bell();
  expect(result).toMatchObject({ id: 'n-1', deduped: false, title: 'Reply to Pat S. on Facebook' });
  await flush();
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  const [key, payload, opts] = triggerNotification.mock.calls[0];
  expect(key).toBe('messenger_reply');
  expect(payload).toEqual({
    alertRowId: 'n-1', alertTitle: 'Reply to Pat S. on Facebook', alertBody: 'Facebook: can you call me?', alertLink: '/admin/communications#tab=messenger&thread=t-1',
  });
  expect(opts.pushOnly).toBe(true);
});

test('an identical repeat sends nothing', async () => {
  await bell();
  await flush();
  triggerNotification.mockClear();
  const again = await bell();
  expect(again.deduped).toBe(true);
  await flush();
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('a refresh that rang again sends one; a refresh that stayed quiet sends none', async () => {
  await bell();
  await flush();
  triggerNotification.mockClear();
  mockRows.notifications[0].read_at = new Date('2026-11-03T12:00:00Z');
  const rang = await bell({ dedupeVersion: 'm2' }, 'Facebook: are you still coming?');
  expect(rang).toMatchObject({ deduped: true, refreshed: true, rung: true });
  await flush();
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  expect(triggerNotification.mock.calls[0][1]).toMatchObject({ alertRowId: 'n-1', alertBody: 'Facebook: are you still coming?' });

  triggerNotification.mockClear();
  const quiet = await bell({ dedupeVersion: 'm3', ringOnRefresh: () => false }, 'Facebook: never mind');
  expect(quiet).toMatchObject({ deduped: true, refreshed: true, rung: false });
  await flush();
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('a plain row with no dedupe key sends one too', async () => {
  await NotificationService.notifyAdmin('alert', 'A promise to a caller is overdue', 'Call Pat S. back.', {
    link: '/admin/communications#tab=owed', bell: true, metadata: { triggerKey: 'call_commitment_overdue', commitment_id: 'c-1' },
  });
  await flush();
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  expect(triggerNotification.mock.calls[0][0]).toBe('call_commitment_overdue');
});

test('the call-commitment backlog summary (Activity-only) never sends', async () => {
  await NotificationService.notifyAdmin('alert', '12 promises to callers are overdue', '12 things Waves told callers it would do have not happened.', {
    link: '/admin/communications#tab=owed', dedupeKey: 'call-commitments-overdue:2026-11-03', refreshOnDedupe: true, bell: true,
    metadata: { triggerKey: 'call_commitment_overdue', overdue_count: 12, feed: 'activity' },
  });
  await flush();
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('gate off: nothing is sent and the row is written exactly as before', async () => {
  delete process.env.GATE_BELL_BANNERS;
  const result = await bell();
  await flush();
  expect(result).toMatchObject({ id: 'n-1', deduped: false });
  expect(mockRows.notifications).toHaveLength(1);
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('a write for a trigger that is not a banner kind sends nothing', async () => {
  await bell({ metadata: { conversationId: 't-1', triggerKey: 'sms_reply' } });
  await flush();
  expect(triggerNotification).not.toHaveBeenCalled();
});

describe('on the caller\'s transaction', () => {
  test('waits for the commit, then sends once', async () => {
    const trx = callerTrx();
    const result = await bell({ trx });
    expect(result).toMatchObject({ id: 'n-1', deduped: false });
    await flush();
    expect(triggerNotification).not.toHaveBeenCalled();
    trx.commit();
    await flush();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a rollback sends nothing', async () => {
    const trx = callerTrx();
    await bell({ trx });
    trx.rollback(new Error('the caller\'s work failed'));
    await flush();
    await flush();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a write inside a savepoint waits for the outermost commit', async () => {
    const outer = callerTrx();
    const savepoint = callerTrx(outer);
    await bell({ trx: savepoint });
    savepoint.commit();
    await flush();
    expect(triggerNotification).not.toHaveBeenCalled();
    outer.commit();
    await flush();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a repeat on the same transaction sends nothing at commit', async () => {
    const trx = callerTrx();
    await bell({ trx });
    await bell({ trx });
    trx.commit();
    await flush();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });
});
