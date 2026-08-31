/**
 * search_ib_history (W-RECALL) — unit invariants:
 *  1. Fail closed: no actor in the action context → error, no query.
 *  2. Every query is scoped to the actor's own threads.
 *  3. Full-text first; substring fallback only when FTS finds nothing.
 *  4. Results carry the paired turn and the thread's receipts, receipts
 *     scoped to the same actor.
 *  5. attachThread stamps only the actor's own unstamped rows.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Chainable knex stub: every builder method returns the builder; awaiting
// it yields the next queued result. Calls are recorded for assertions.
const queue = [];
const calls = [];
function builder(table) {
  const rec = { table, where: [], whereRaw: [], whereIn: [], whereNull: [], update: null, ilike: null };
  calls.push(rec);
  const b = {};
  const chain = (name, fn) => { b[name] = (...args) => { if (fn) fn(...args); return b; }; };
  chain('join');
  chain('where', (...args) => {
    if (typeof args[0] === 'function') { args[0](b); return; }
    if (args[1] === 'ilike') rec.ilike = args[2];
    rec.where.push(args);
  });
  chain('orWhere', (fn) => fn(b));
  chain('whereRaw', (sql, bindings) => rec.whereRaw.push([sql, bindings]));
  chain('whereIn', (col, vals) => rec.whereIn.push([col, vals]));
  chain('whereNull', (col) => rec.whereNull.push(col));
  chain('orderBy'); chain('orderByRaw'); chain('limit'); chain('select');
  b.update = (patch) => { rec.update = patch; return b; };
  b.then = (resolve, reject) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql) => ({ sql }));
mockDb.fn = { now: () => 'NOW()' };
jest.mock('../models/db', () => mockDb);

const { executeHistoryTool, HISTORY_TOOLS } = require('../services/intelligence-bar/history-tools');
const { attachThread } = require('../services/intelligence-bar/pending-actions');

const T1 = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queue.length = 0; calls.length = 0; jest.clearAllMocks();
  process.env.GATE_IB_THREADS = 'true';
});
afterAll(() => { delete process.env.GATE_IB_THREADS; });

test('gate off: refuses before any query (same kill switch as threads)', async () => {
  delete process.env.GATE_IB_THREADS;
  const r = await executeHistoryTool('search_ib_history', { query: 'acct-1042' }, { actorId: 'admin-1' });
  expect(r.error).toMatch(/not enabled/i);
  expect(r.results).toEqual([]);
  expect(mockDb).not.toHaveBeenCalled();
});

test('tool is declared with a required query and an inline contract', () => {
  const t = HISTORY_TOOLS.find((x) => x.name === 'search_ib_history');
  expect(t.input_schema.required).toEqual(['query']);
  expect(t._contracts.tables).toEqual(expect.arrayContaining(['ib_thread_turns', 'ib_threads', 'ib_pending_actions']));
});

test('fails closed without an actor — no query runs', async () => {
  const r = await executeHistoryTool('search_ib_history', { query: 'acct-1042' }, {});
  expect(r.error).toMatch(/identity required/i);
  expect(r.results).toEqual([]);
  expect(mockDb).not.toHaveBeenCalled();
});

test('empty query is rejected before querying', async () => {
  const r = await executeHistoryTool('search_ib_history', { query: '   ' }, { actorId: 'admin-1' });
  expect(r.error).toMatch(/query is required/);
  expect(mockDb).not.toHaveBeenCalled();
});

test('full-text hit: actor-scoped, paired turn + receipts attached', async () => {
  queue.push(
    [{ id: 'turn-2', thread_id: T1, seq: 2, role: 'assistant', created_at: '2026-08-30T01:00:00Z', title: 'acct-1042 reschedule', context: 'schedule', last_active_at: '2026-08-30T01:01:00Z', snippet: '…moved <b>acct-1042</b> to Thursday…' }],
    [{ thread_id: T1, seq: 1, role: 'user', content: 'move acct-1042 to thursday' }],
    [
      // This exchange (assistant seq 2): confirmed + success → executed
      { id: 'pa-1', thread_id: T1, thread_turn_seq: 2, tool_name: 'reschedule_appointment', summary: 'Move → Thu', status: 'confirmed', result: JSON.stringify({ success: true }), created_at: '2026-08-30T01:00:30Z', consumed_at: '2026-08-30T01:02:00Z' },
      // Same exchange: confirmed but the run recorded an error → failed
      { id: 'pa-2', thread_id: T1, thread_turn_seq: 2, tool_name: 'send_sms', summary: 'Notify', status: 'confirmed', result: JSON.stringify({ error: 'Twilio 21610' }), created_at: '2026-08-30T01:00:31Z', consumed_at: '2026-08-30T01:02:01Z' },
      // Same exchange: still `pending` in the table but past its TTL → reported expired, never_ran
      { id: 'pa-3', thread_id: T1, thread_turn_seq: 2, tool_name: 'send_sms', summary: 'Notify again', status: 'pending', result: null, created_at: '2026-08-30T01:00:32Z', consumed_at: null, expires_at: '2026-08-30T01:10:32Z' },
      // Same exchange: confirmed but the tool BLOCKED without an error key → failed (never executed)
      { id: 'pa-4', thread_id: T1, thread_turn_seq: 2, tool_name: 'create_pending_estimate', summary: 'Draft', status: 'confirmed', result: JSON.stringify({ success: false, blocked: true, reason: 'duplicate' }), created_at: '2026-08-30T01:00:33Z', consumed_at: '2026-08-30T01:02:03Z' },
      // Same exchange: confirmed, result recorded but empty object → unknown (not claimed executed)
      { id: 'pa-5', thread_id: T1, thread_turn_seq: 2, tool_name: 'send_sms', summary: 'x', status: 'confirmed', result: 'not-json', created_at: '2026-08-30T01:00:34Z', consumed_at: '2026-08-30T01:02:04Z' },
      // A LATER exchange in the same thread (assistant seq 4) → must NOT be attributed
      { id: 'pa-9', thread_id: T1, thread_turn_seq: 4, tool_name: 'create_customer', summary: 'Unrelated', status: 'confirmed', result: JSON.stringify({ success: true }), created_at: '2026-08-30T01:10:00Z', consumed_at: '2026-08-30T01:10:05Z' },
    ],
  );
  const r = await executeHistoryTool('search_ib_history', { query: 'acct-1042', days: 30 }, { actorId: 'admin-1' });

  expect(r.mode).toBe('full_text');
  expect(r.total).toBe(1);
  const hit = r.results[0];
  expect(hit.thread_title).toBe('acct-1042 reschedule');
  expect(hit.paired_turn).toEqual({ role: 'user', content: 'move acct-1042 to thursday', truncated: false });
  expect(hit.receipts.map((x) => [x.id, x.status, x.outcome])).toEqual([
    ['pa-1', 'confirmed', 'executed'], ['pa-2', 'confirmed', 'failed'], ['pa-3', 'expired', 'never_ran'],
    ['pa-4', 'confirmed', 'failed'], ['pa-5', 'confirmed', 'unknown'],
  ]);
  expect(hit.receipts.find((x) => x.id === 'pa-9')).toBeUndefined();

  // Query 1 (FTS) is scoped to the actor and uses websearch_to_tsquery.
  const fts = calls[0];
  expect(fts.table).toBe('ib_thread_turns as tt');
  expect(fts.where).toEqual(expect.arrayContaining([['t.admin_actor_id', 'admin-1']]));
  expect(fts.whereRaw[0][0]).toMatch(/websearch_to_tsquery/);
  expect(fts.whereRaw[0][1]).toEqual(['acct-1042']);
  // Receipts query is scoped to the same actor and the matched threads.
  const receipts = calls.find((c) => c.table === 'ib_pending_actions');
  expect(receipts.whereIn).toEqual([['thread_id', [T1]]]);
  expect(receipts.where).toEqual(expect.arrayContaining([['requested_by', 'admin-1']]));
});

test('substring fallback runs only when full-text finds nothing, with LIKE metachars escaped', async () => {
  queue.push([], [{ id: 'turn-9', thread_id: T1, seq: 3, role: 'user', created_at: '2026-08-30T02:00:00Z', title: 'x', context: 'customers', last_active_at: null, snippet: 'the 5pm one' }], [], []);
  const r = await executeHistoryTool('search_ib_history', { query: '5pm_one%' }, { actorId: 'admin-1' });
  expect(r.mode).toBe('substring');
  expect(r.total).toBe(1);
  const fallback = calls[1];
  expect(fallback.ilike).toBe('%5pm\\_one\\%%');
  expect(fallback.where).toEqual(expect.arrayContaining([['t.admin_actor_id', 'admin-1']]));
});

test('a term matching both halves of an exchange yields ONE result, and the limit counts exchanges', async () => {
  // Two exchanges, both halves of each match (4 turn rows); limit 1 must
  // return exactly one exchange, not one duplicate-eaten half.
  queue.push(
    [
      { id: 'u1', thread_id: T1, seq: 1, role: 'user', created_at: '2026-08-30T01:00:00Z', title: 't', context: 'schedule', last_active_at: null, snippet: 'acct-1042?' },
      { id: 'a1', thread_id: T1, seq: 2, role: 'assistant', created_at: '2026-08-30T01:00:01Z', title: 't', context: 'schedule', last_active_at: null, snippet: 'acct-1042 moved' },
      { id: 'u2', thread_id: T1, seq: 3, role: 'user', created_at: '2026-08-30T01:05:00Z', title: 't', context: 'schedule', last_active_at: null, snippet: 'acct-1042 again?' },
      { id: 'a2', thread_id: T1, seq: 4, role: 'assistant', created_at: '2026-08-30T01:05:01Z', title: 't', context: 'schedule', last_active_at: null, snippet: 'acct-1042 done' },
    ],
    [{ thread_id: T1, seq: 2, role: 'assistant', content: 'acct-1042 moved' }],
    [],
  );
  const r = await executeHistoryTool('search_ib_history', { query: 'acct-1042', limit: 1 }, { actorId: 'admin-1' });
  expect(r.total).toBe(1);
  expect(r.results[0].turn_seq).toBe(1);
  expect(r.results[0].paired_turn.role).toBe('assistant');
});

test('no matches either way returns an empty, well-formed result', async () => {
  queue.push([], []);
  const r = await executeHistoryTool('search_ib_history', { query: 'zzz' }, { actorId: 'admin-1' });
  expect(r).toMatchObject({ total: 0, results: [], receipts: [] });
});

test('attachThread stamps thread + exchange seq on only the actor\'s own unstamped proposals', async () => {
  queue.push(2);
  const n = await attachThread(['pa-1', 'pa-2'], T1, 6, 'admin-1');
  expect(n).toBe(2);
  const upd = calls.find((c) => c.table === 'ib_pending_actions');
  expect(upd.whereIn).toEqual([['id', ['pa-1', 'pa-2']]]);
  expect(upd.where).toEqual(expect.arrayContaining([['requested_by', 'admin-1']]));
  expect(upd.whereNull).toEqual(['thread_id']);
  expect(upd.update).toMatchObject({ thread_id: T1, thread_turn_seq: 6 });

  expect(await attachThread([], T1, 6, 'admin-1')).toBe(0);
  expect(await attachThread(['pa-1'], null, 6, 'admin-1')).toBe(0);
  expect(await attachThread(['pa-1'], T1, null, 'admin-1')).toBe(0);
});
