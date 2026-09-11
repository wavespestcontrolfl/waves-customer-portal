// loadDigestRows: the pinned set (unread ACT/[Review], unresolved FIX) is
// fetched WITHOUT the time window so it can never be truncated out by the
// windowed query's ORDER BY + LIMIT, and the two sets merge by id.

const mockCalls = [];
function builder(rows) {
  const q = { _rows: rows, _ops: [] };
  for (const m of ['select', 'where', 'orWhere', 'andWhere', 'whereNull', 'andWhereRaw', 'whereRaw', 'orWhereRaw', 'orderBy', 'limit']) {
    q[m] = jest.fn((...args) => {
      q._ops.push([m, ...args.map((a) => (typeof a === 'function' ? 'fn' : a))]);
      // knex grouped clauses: invoke the callback with the same builder so nested clauses are recorded too
      if (typeof args[0] === 'function') args[0](q);
      return q;
    });
  }
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}
const mockQueue = [];
jest.mock('../models/db', () => jest.fn(() => { const b = mockQueue.shift(); mockCalls.push(b); return b; }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { _private } = require('../services/agent-activity');

test('pinned rows are loaded without the window, merged with windowed rows, deduped by id', async () => {
  const old = { id: 'old-fix', title: 'FIX: ancient', created_at: '2026-06-01T00:00:00Z', read_at: '2026-06-02T00:00:00Z', metadata: { opsKey: 'k', source: 'ops-crons' } };
  const both = { id: 'both', title: 'ACT: today', created_at: '2026-09-11T00:00:00Z', read_at: null, metadata: null };
  const recent = { id: 'recent-fyi', title: 'FYI: x', created_at: '2026-09-11T01:00:00Z', read_at: null, metadata: null };
  const pinned = builder([old, both]);
  const windowed = builder([both, recent]);
  mockQueue.push(pinned, windowed);
  const db = require('../models/db');
  const rows = await _private.loadDigestRows(db, new Date('2026-09-10T00:00:00Z'));
  expect(rows.map((r) => r.id)).toEqual(['old-fix', 'both', 'recent-fyi']);
  // pinned query: no created_at window, but the resolved marker + limit
  const pinnedOps = pinned._ops.map((o) => o[0] + (o[1] === 'created_at' ? ':created_at' : ''));
  expect(pinnedOps).not.toContain('where:created_at');
  expect(pinned._ops.some((o) => o[0] === 'limit')).toBe(true);
  // windowed query: created_at >= since
  expect(windowed._ops.some((o) => o[0] === 'where' && o[1] === 'created_at' && o[2] === '>=')).toBe(true);
});

test('the pinned predicate keeps unresolved FIX rows only when something can resolve them (source ops-crons or fallOff), else the read-or-window rule', () => {
  const pinned = builder([]); const windowed = builder([]);
  mockQueue.push(pinned, windowed);
  const db = require('../models/db');
  return _private.loadDigestRows(db, new Date('2026-09-10T00:00:00Z')).then(() => {
    // The nested builders share the same mock object, so every raw clause lands in pinned._ops.
    const raws = pinned._ops.filter((o) => o[0] === 'whereRaw' || o[0] === 'andWhereRaw' || o[0] === 'orWhereRaw').map((o) => o[1]);
    expect(raws).toEqual(expect.arrayContaining([
      "COALESCE(metadata->>'resolved', '') <> 'true'",
      "metadata->>'source' = 'ops-crons'",
      "metadata->>'fallOff' = 'true'",
    ]));
    expect(pinned._ops.filter((o) => o[0] === 'whereNull' && o[1] === 'read_at').length).toBe(2); // ACT/[Review] rule + legacy FIX rule
  });
});

