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
    whereRaw(sql, binds = []) {
      const meta = (r) => r.metadata || {};
      if (sql.includes("'kind'")) conds.push((r) => meta(r).kind === binds[0]);
      else if (sql.includes("'customerId'")) conds.push((r) => String(meta(r).customerId) === binds[0]);
      else if (sql.includes("'dedupeKey'")) conds.push((r) => (meta(r).dedupeKey || '') !== binds[0]);
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
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});

test('a retry of the SAME request leaves its own unread row alone (it dedupes against it)', async () => {
  mockTables.notifications = [datedRow('req-1')];
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[0].read_at).toBeNull();
  expect(mockNotifyAdmin.mock.calls[0][2]).not.toMatch(/supersedes/);
});

test('rows already READ are never touched, and another customer\'s rows are out of scope', async () => {
  mockTables.notifications = [
    datedRow('req-0', { }), datedRow('req-x', { customerId: 'c2' }),
  ];
  mockTables.notifications[0].read_at = new Date('2026-01-01');
  await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(mockTables.notifications[1].read_at).toBeNull();
  expect(mockNotifyAdmin.mock.calls[0][2]).not.toMatch(/supersedes/);
});

test('a FAILED retire on a DATED raise throws too', async () => {
  mockFailUpdate = 'notifications';
  await expect(raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' })).rejects.toThrow(/could not be superseded/);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});
