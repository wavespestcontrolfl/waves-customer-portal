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
    // The retire predicates the raise uses on metadata: equality, inequality
    // and IS NOT NULL — honoured so a boundary-scoped retire is testable.
    whereRaw(sql, bindings = []) {
      const cmp = /metadata->>'(\w+)' (=|<>) \?/.exec(sql);
      if (cmp) conds.push((r) => ((cmp[2] === '=') === (String((r.metadata || {})[cmp[1]]) === String(bindings[0]))));
      const nn = /metadata->>'(\w+)' IS NOT NULL/.exec(sql);
      if (nn) conds.push((r) => (r.metadata || {})[nn[1]] != null);
      return b;
    },
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

test('a DATED task runs the retire step too (for an earlier dated row naming a DIFFERENT date) — a failing retire throws as well', async () => {
  mockFailUpdate = 'notifications';
  await expect(raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' })).rejects.toThrow(/could not be superseded/);
  expect(mockNotifyAdmin).not.toHaveBeenCalled();
  mockFailUpdate = null;
  const out = await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
  expect(out).toEqual(expect.objectContaining({ raised: true }));
  // Same date as the existing dated row → it is left alone.
  expect(mockTables.notifications[0].read_at).toBeNull();
});

describe('dedupe key: per (TERM, churn episode, class) when a prepaid term governs the cancel, per request otherwise', () => {
  const keyOf = (i = 0) => mockNotifyAdmin.mock.calls[i][3].dedupeKey;
  const EP = '2026-09-01T12:00:00.000Z';

  test('a dated task keys on term + episode, class "dated"; term, episode and request ride in metadata', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    expect(keyOf()).toBe(`termite_station_retrieval:term:term-1:${EP}:dated`);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata).toEqual(expect.objectContaining({ termId: 'term-1', churnEpisode: EP, requestId: 'req-1', retrieveAfter: '2027-02-28' }));
  });

  test('two requests on the same term in the same episode produce the SAME dated key — the repeat commit after the 24h latch raises nothing new', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    expect(keyOf(0)).toBe(keyOf(1));
  });

  test('a won-back customer churning again on the same term is a NEW episode — a fresh key, never silenced by the first episode', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    await raiseTermiteRetrievalTask('c1', 'req-9', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: '2026-11-01T12:00:00.000Z' });
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  test('the immediate task keys on the term under its OWN class — the end_at_term → end_now transition still retires the dated row and raises "pull now"', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: null, termId: 'term-1', episodeKey: EP });
    expect(keyOf()).toBe(`termite_station_retrieval:term:term-1:${EP}:immediate`);
    expect(mockTables.notifications[0].read_at).not.toBeNull();
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/supersedes the earlier dated retrieval task/);
  });

  test('no term, or a term without an episode (unanchored churn), keeps the per-request key byte for byte', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28' });
    expect(keyOf(0)).toBe('termite_station_retrieval:c1:req-1');
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.termId).toBeUndefined();
    await raiseTermiteRetrievalTask('c1', 'req-1', { retrieveAfter: '2027-02-28', termId: 'term-1' });
    expect(keyOf(1)).toBe('termite_station_retrieval:c1:req-1');
  });

  test('compat: a same-episode prior request already raised this class under its REQUEST key (pre-deploy row) — nothing new is raised', async () => {
    mockTables.notifications.push({
      id: 'n-old', recipient_type: 'admin', read_at: null,
      metadata: { kind: 'termite_station_retrieval', customerId: 'c1', dedupeKey: 'termite_station_retrieval:c1:req-old', retrieveAfter: '2027-02-28' },
    });
    const out = await raiseTermiteRetrievalTask('c1', 'req-new', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP, priorRequestIds: ['req-old'] });
    expect(out).toEqual(expect.objectContaining({ raised: true, deduped: true, priorRequest: true }));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    // A different class (immediate) is NOT covered by the dated row — and it
    // still retires the dated rows first.
    const imm = await raiseTermiteRetrievalTask('c1', 'req-new', { retrieveAfter: null, termId: 'term-1', episodeKey: EP, priorRequestIds: ['req-old'] });
    expect(imm).toEqual(expect.objectContaining({ raised: true }));
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(keyOf()).toBe(`termite_station_retrieval:term:term-1:${EP}:immediate`);
  });
});

describe('boundary correction and current-request compat', () => {
  const EP = '2026-09-01:2027-03-31';

  test('a DATED raise for a corrected boundary retires the earlier dated row naming the old date', async () => {
    const out = await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: '2027-03-31', termId: 'term-1', episodeKey: EP });
    expect(out).toEqual(expect.objectContaining({ raised: true }));
    expect(mockTables.notifications[0].read_at).not.toBeNull();
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/coverage end date was corrected/);
  });

  test('a DATED raise for the SAME boundary leaves the existing dated row alone', async () => {
    await raiseTermiteRetrievalTask('c1', 'req-2', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    expect(mockTables.notifications[0].read_at).toBeNull();
    expect(mockNotifyAdmin.mock.calls[0][2]).not.toMatch(/supersedes/);
  });

  test('compat: the CURRENT request already raised this class under its request key (repair of a pre-deploy acceptance) — nothing new', async () => {
    mockTables.notifications.push({
      id: 'n-cur', recipient_type: 'admin', read_at: null,
      metadata: { kind: 'termite_station_retrieval', customerId: 'c1', dedupeKey: 'termite_station_retrieval:c1:req-cur', retrieveAfter: '2027-02-28' },
    });
    const out = await raiseTermiteRetrievalTask('c1', 'req-cur', { retrieveAfter: '2027-02-28', termId: 'term-1', episodeKey: EP });
    expect(out).toEqual(expect.objectContaining({ raised: true, deduped: true, priorRequest: true }));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});
