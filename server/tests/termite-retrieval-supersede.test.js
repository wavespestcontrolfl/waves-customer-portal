// raiseTermiteRetrievalTask — an IMMEDIATE task must retire the earlier
// DATED "retrieve after coverage ends" task first. A failed retire used to
// be logged and swallowed while the immediate task was still raised, so
// staff could hold two contradictory instructions with no review error
// naming the stale one. It now throws: the run records
// termite_retrieval_task and the latch's lost-task repair retries the whole
// raise (deferred P2 from #3666 r32).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockNotifyAdmin = jest.fn(async () => ({ id: 'n-1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));

let mockTables;
let mockFailUpdate;
jest.mock('../models/db', () => jest.fn((table) => {
  const conds = [];
  const b = {
    where(c) { if (typeof c === 'object') Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
    whereNull(k) { conds.push((r) => r[k] == null); return b; },
    whereRaw() { return b; },
    whereIn(k, vals) { conds.push((r) => vals.includes(r[k])); return b; },
    select: async () => (mockTables[table] || []).filter((r) => conds.every((c) => c(r))),
    first: async () => (mockTables[table] || []).find((r) => conds.every((c) => c(r))) || null,
    update: async (patch) => {
      if (mockFailUpdate === table) throw new Error('notifications table down');
      const hit = (mockTables[table] || []).filter((r) => conds.every((c) => c(r)));
      hit.forEach((r) => Object.assign(r, patch));
      return hit.length;
    },
  };
  return b;
}));

const { raiseTermiteRetrievalTask } = require('../services/cancellation-processor');

beforeEach(() => {
  mockNotifyAdmin.mockClear();
  mockFailUpdate = null;
  mockTables = {
    customers: [{ id: 'c1', termite_stations_rented: false }],
    termite_stations: [{ id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true }],
    notifications: [{ id: 'n-dated', recipient_type: 'admin', read_at: null, metadata: { kind: 'termite_station_retrieval', customerId: 'c1', retrieveAfter: '2027-02-28' } }],
  };
});

test('the immediate task retires the dated one, then raises', async () => {
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: null });
  expect(mockTables.notifications[0].read_at).not.toBeNull();
  expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes the earlier dated retrieval task/);
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});

test('a FAILED retire throws — no immediate task is raised beside a dated one that may still stand', async () => {
  mockFailUpdate = 'notifications';
  await expect(raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: null })).rejects.toThrow(/could not be superseded/);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
});

test('a DATED task never touches the retire step', async () => {
  mockFailUpdate = 'notifications';
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(out).toEqual(expect.objectContaining({ raised: true }));
});
