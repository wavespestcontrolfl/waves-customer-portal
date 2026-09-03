// raiseTermiteRetrievalTask — staff hold at most ONE open retrieval
// instruction per account: every earlier UNREAD retrieval row (any class,
// any date) is retired before the new task is raised, except the raising
// event's own row (a retry dedupes against it). A failed retire throws
// rather than raising beside a stale row: the run records
// termite_retrieval_task and the latch's lost-task repair retries the whole
// raise (deferred P2 from #3666 r32).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockNotifyAdmin = jest.fn(async () => ({ id: 'n-1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));

let mockTables;
let mockFailUpdate;
const mockLog = [];
jest.mock('../models/db', () => {
  const build = (table) => {
  const conds = [];
  const b = {
    where(c) { if (typeof c === 'object') Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
    whereNull(k) { conds.push((r) => r[k] == null); return b; },
    whereNotNull(k) { conds.push((r) => r[k] != null); return b; },
    whereRaw(sql, binds = []) {
      const meta = (r) => r.metadata || {};
      if (sql.includes("'kind'")) conds.push((r) => meta(r).kind === binds[0]);
      else if (sql.includes("'customerId'")) conds.push((r) => String(meta(r).customerId) === binds[0]);
      else if (sql.includes("'dedupeKey'")) conds.push(sql.includes('<>') ? (r) => (meta(r).dedupeKey || '') !== binds[0] : (r) => meta(r).dedupeKey === binds[0]);
      return b;
    },
    whereIn(k, vals) { conds.push((r) => vals.includes(r[k])); return b; },
    select: async () => (mockTables[table] || []).filter((r) => conds.every((c) => c(r))),
    first: async () => (mockTables[table] || []).find((r) => conds.every((c) => c(r))) || null,
    update: async (patch) => {
      if (mockFailUpdate === table) throw new Error('notifications table down');
      const hit = (mockTables[table] || []).filter((r) => conds.every((c) => c(r)));
      hit.forEach((r) => Object.assign(r, patch));
      mockLog.push(`update:${table}`);
      return hit.length;
    },
  };
  return b;
  };
  const db = jest.fn(build);
  db.transaction = async (fn) => {
    const trx = (table) => build(table);
    trx.raw = async (sql, binds) => { mockLog.push(`raw:${binds && binds[0]}`); return {}; };
    return fn(trx);
  };
  return db;
});

const { raiseTermiteRetrievalTask } = require('../services/cancellation-processor');

beforeEach(() => {
  mockNotifyAdmin.mockClear();
  mockLog.length = 0;
  mockFailUpdate = null;
  mockTables = {
    customers: [{ id: 'c1', termite_stations_rented: false }],
    termite_stations: [{ id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true }],
    notifications: [{ id: 'n-dated', recipient_type: 'admin', read_at: null, metadata: { kind: 'termite_station_retrieval', customerId: 'c1', retrieveAfter: '2027-02-28', dedupeKey: 'termite_station_retrieval:c1:req-0' } }],
    // Request chronology: req-0 < req-a < req-1 < req-b.
    service_requests: [
      { id: 'req-0', created_at: '2026-08-01T00:00:00Z' },
      { id: 'req-a', created_at: '2026-08-10T00:00:00Z' },
      { id: 'req-1', created_at: '2026-08-20T00:00:00Z' },
      { id: 'req-b', created_at: '2026-08-30T00:00:00Z' },
    ],
  };
});

const datedRow = (id, overrides = {}) => ({
  id, recipient_type: 'admin', read_at: null,
  metadata: { kind: 'termite_station_retrieval', customerId: 'c1', retrieveAfter: '2027-02-28', dedupeKey: `termite_station_retrieval:c1:${id}`, ...overrides },
});

test('the immediate task retires the dated one, then raises — under the account-scoped lock', async () => {
  mockNotifyAdmin.mockImplementationOnce(async () => { mockLog.push('notifyAdmin'); return { id: 'n-1' }; });
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: null });
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  // Lock first, retire second, insert third: a concurrent raise for another
  // request waits on the lock and then sees this one's committed row.
  expect(mockLog).toEqual(['raw:admin:termite_station_retrieval:c1', 'update:notifications', 'notifyAdmin']);
  // ...and the insert rides the SAME transaction as the retire.
  expect(typeof mockNotifyAdmin.mock.calls[0][3].trx).toBe('function');
  expect(mockNotifyAdmin.mock.calls[0][3].trx.raw).toBeDefined();
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes the earlier dated retrieval task/);
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});

test('a FAILED retire throws — no immediate task is raised beside a dated one that may still stand', async () => {
  mockFailUpdate = 'notifications';
  await expect(raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: null })).rejects.toThrow(/could not be superseded/);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});

test('a DATED raise for a corrected boundary retires the earlier dated row', async () => {
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-03-31' });
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes an earlier station-retrieval task/);
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});

test('a prior episode\'s SAME-DATE unread task is retired before the fresh one is raised', async () => {
  // Cancel at term end → win-back before the retrieval date → cancel the
  // same still-current term again: a new request, the same coverage end.
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes an earlier station-retrieval task/);
  expect(mockNotifyAdmin.mock.calls[0][3].dedupeKey).toBe('termite_station_retrieval:c1:req-1');
  // A same-key re-raise with a corrected date rewrites the standing row
  // (notifyAdmin refreshOnDedupe) instead of silently keeping the old one.
  expect(mockNotifyAdmin.mock.calls[0][3].refreshOnDedupe).toBe(true);
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});

test('a retry of the SAME request leaves its own unread row alone (it dedupes against it)', async () => {
  mockTables.notifications = [datedRow('req-1')];
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[0].read_at).toBeNull();
  expect(mockNotifyAdmin.mock.calls[0][2]).not.toMatch(/supersedes/);
});

test('a retry of an OLDER request never retires a NEWER request\'s open task — it yields (GH r2 + r3 P1s)', async () => {
  // A raised, B raised (retired A), then A's lost-task repair retries: B
  // must stay the one open instruction, A inserts nothing.
  mockTables.notifications = [datedRow('req-a'), datedRow('req-b')];
  mockTables.notifications[0].read_at = new Date('2026-01-02');
  const out = await raiseTermiteRetrievalTask('c1', 'req-a', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[1].read_at).toBeNull();
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
  expect(out).toEqual(expect.objectContaining({ raised: true, deduped: true, supersededByNewer: 'req-b' }));
  // ...and when A's first insert never landed at all (no own row), the same.
  mockTables.notifications = [datedRow('req-b')];
  await raiseTermiteRetrievalTask('c1', 'req-a', { retrieveAfter: '2027-03-31' });
  expect(mockTables.notifications[0].read_at).toBeNull();
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});

test('the NEWEST request\'s raise retires older open rows and REOPENS its own read row (a reverted correction)', async () => {
  // req-1 was acted on (read); an older no-request row is still open.
  mockTables.notifications = [datedRow('req-1'), datedRow('n-portal', { dedupeKey: 'termite_station_retrieval:c1:no-request' })];
  mockTables.notifications[0].read_at = new Date('2026-01-02');
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[1].read_at).not.toBeNull();
  expect(mockTables.notifications[0].read_at).toBeNull();
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes an earlier station-retrieval task/);
});

test('legacy rows without a stamped requestId are dated by the request id inside their key', async () => {
  // req-b's row (newer) carries no metadata.requestId, only its key.
  mockTables.notifications = [datedRow('req-b')];
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(out).toEqual(expect.objectContaining({ supersededByNewer: 'req-b' }));
  expect(mockNotifyAdmin.mock.calls[0]).toBeUndefined();
});

test('rows already READ are never retired (the note still names them), and another customer\'s rows are out of scope', async () => {
  mockTables.notifications = [
    datedRow('req-0', { }), datedRow('req-x', { customerId: 'c2' }),
  ];
  mockTables.notifications[0].read_at = new Date('2026-01-01');
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  expect(mockTables.notifications[1].read_at).toBeNull();
  expect(mockLog.filter((l) => l === 'update:notifications')).toEqual([]);
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes an earlier station-retrieval task/);
});

test('the supersession note is stable across a routine retry of the same event — an acted-on task is never reopened by content drift (GH r4 P1)', async () => {
  mockTables.notifications = [datedRow('req-0')];
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  const first = mockNotifyAdmin.mock.calls[0][2];
  expect(first).toMatch(/supersedes/);
  // Staff acted on req-1's task; req-0 is history (read). A retry of req-1
  // renders the identical body: refreshOnDedupe sees no change.
  mockTables.notifications.push({ ...datedRow('req-1'), read_at: new Date('2026-02-01') });
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockNotifyAdmin.mock.calls[1][2]).toBe(first);
  expect(mockTables.notifications[1].read_at).not.toBeNull();
});

test('a READ task of a NEWER request still makes the older request\'s repair yield (GH r4 P1)', async () => {
  // Staff scheduled req-b's retrieval (read); req-a's original insert never
  // landed and its repair fires now — it must not restore the older date.
  mockTables.notifications = [{ ...datedRow('req-b'), read_at: new Date('2026-02-01') }];
  const out = await raiseTermiteRetrievalTask('c1', 'req-a', { retrieveAfter: '2027-01-31' });
  expect(out).toEqual(expect.objectContaining({ supersededByNewer: 'req-b' }));
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});

test('a FAILED retire on a DATED raise throws too', async () => {
  mockFailUpdate = 'notifications';
  await expect(raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' })).rejects.toThrow(/could not be superseded/);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});

test('with a term AND an episode the task is keyed on (term, episode, class[, date]) — the same instruction across requests dedupes, dated and immediate stay distinct', async () => {
  mockTables.notifications = [];
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: 'ep-1' });
  await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: 'ep-1' });
  await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: null, termId: 'term-1', episodeKey: 'ep-1' });
  const keys = mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
  expect(keys).toEqual([
    'termite_station_retrieval:term:term-1:ep-1:dated:2027-02-28',
    'termite_station_retrieval:term:term-1:ep-1:dated:2027-02-28',
    'termite_station_retrieval:term:term-1:ep-1:immediate',
  ]);
  expect(mockNotifyAdmin.mock.calls[0][3].metadata).toEqual(expect.objectContaining({ requestId: 'req-1', termId: 'term-1', churnEpisode: 'ep-1', retrieveAfter: '2027-02-28' }));
  // A new episode on the same term is a new key.
  await raiseTermiteRetrievalTask('c1', 'req-3', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: 'ep-2' });
  expect(mockNotifyAdmin.mock.calls[3][3].dedupeKey).toBe('termite_station_retrieval:term:term-1:ep-2:dated:2027-02-28');
});

test('a term WITHOUT an episode (or no term) keeps the per-request key', async () => {
  mockTables.notifications = [];
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1' });
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: null, episodeKey: 'ep-1' });
  await raiseTermiteRetrievalTask('c1', null, { retrieveAfter: null });
  expect(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).toEqual([
    'termite_station_retrieval:c1:req-1', 'termite_station_retrieval:c1:req-1', 'termite_station_retrieval:c1:no-request',
  ]);
  expect(mockNotifyAdmin.mock.calls[0][3].metadata).not.toHaveProperty('termId');
});
