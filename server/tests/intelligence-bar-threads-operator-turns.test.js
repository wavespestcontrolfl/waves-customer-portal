/**
 * IbThreads.recentOperatorTurns — the server-persisted-thread reader behind
 * procurement-tools.resolveInventoryWriteTarget's operator-grounding
 * fallback (see intelligence-bar-stock-tools.test.js for that fallback's own
 * tests). This file exercises the REAL query logic against a small hand-
 * rolled fake db, so the role/age/ownership filters are proven directly
 * rather than only asserted by a mocked stand-in elsewhere.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// A small fake db: enough of the knex surface for ib_threads/ib_thread_turns
// queries, with REAL where-filtering (unlike the recording mock used
// elsewhere in this repo, which ignores conditions) — the ownership and age
// bounds under test depend on that filtering actually happening.
function makeThreadsDb({ threads = [], turns = [] }) {
  function db(table) {
    if (table === 'ib_threads') {
      return {
        where(cond) {
          const match = threads.find((t) => Object.entries(cond).every(([k, v]) => t[k] === v));
          return { first: async () => match };
        },
      };
    }
    if (table === 'ib_thread_turns') {
      let rows = [...turns];
      const api = {
        where(colOrFn, op, val) {
          if (arguments.length === 2) {
            // where(col, val)
            rows = rows.filter((r) => r[colOrFn] === op);
          } else if (arguments.length === 3 && op === '>=' && val && val.__minAgeMinutes != null) {
            const cutoff = Date.now() - val.__minAgeMinutes * 60000;
            rows = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
          }
          return api;
        },
        orderBy(col, dir) {
          rows = [...rows].sort((a, b) => (dir === 'desc' ? b[col] - a[col] : a[col] - b[col]));
          return api;
        },
        limit(n) { rows = rows.slice(0, n); return api; },
        select(...cols) { return Promise.resolve(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])))); },
      };
      return api;
    }
    throw new Error(`Unhandled table in threads test db: ${table}`);
  }
  // The real module calls db.raw("NOW() - (? || ' minutes')::interval", [n])
  // — return a tagged marker the where() above recognizes instead of a real
  // SQL fragment.
  db.raw = (_sql, params) => ({ __minAgeMinutes: params[0] });
  return db;
}

function withThreadsModule(seed) {
  jest.resetModules();
  jest.doMock('../models/db', () => makeThreadsDb(seed));
  return require('../services/intelligence-bar/threads');
}

const ACTOR = 'actor-1';
const THREAD_ID = '11111111-1111-1111-1111-111111111111';
const now = new Date();
const minutesAgo = (n) => new Date(now.getTime() - n * 60000);

describe('IbThreads.recentOperatorTurns', () => {
  test('returns only role=user turns, newest first, bounded by limit', async () => {
    const IbThreads = withThreadsModule({
      threads: [{ id: THREAD_ID, admin_actor_id: ACTOR }],
      turns: [
        { thread_id: THREAD_ID, seq: 1, role: 'user', content: 'first operator turn', created_at: minutesAgo(20) },
        { thread_id: THREAD_ID, seq: 2, role: 'assistant', content: 'assistant reply — never returned', created_at: minutesAgo(19) },
        { thread_id: THREAD_ID, seq: 3, role: 'user', content: 'second operator turn', created_at: minutesAgo(10) },
        { thread_id: THREAD_ID, seq: 4, role: 'assistant', content: 'another assistant reply', created_at: minutesAgo(9) },
      ],
    });
    const result = await IbThreads.recentOperatorTurns(ACTOR, THREAD_ID, { limit: 3, maxAgeMinutes: 30 });
    expect(result).toEqual(['second operator turn', 'first operator turn']);
  });

  test('an assistant-only mention never comes back, even when it is the most recent turn', async () => {
    const IbThreads = withThreadsModule({
      threads: [{ id: THREAD_ID, admin_actor_id: ACTOR }],
      turns: [
        { thread_id: THREAD_ID, seq: 1, role: 'assistant', content: 'Alpine WSG mentioned only by the assistant', created_at: minutesAgo(1) },
      ],
    });
    const result = await IbThreads.recentOperatorTurns(ACTOR, THREAD_ID, { limit: 3, maxAgeMinutes: 30 });
    expect(result).toEqual([]);
  });

  test('excludes a turn older than maxAgeMinutes', async () => {
    const IbThreads = withThreadsModule({
      threads: [{ id: THREAD_ID, admin_actor_id: ACTOR }],
      turns: [
        { thread_id: THREAD_ID, seq: 1, role: 'user', content: 'stale operator turn', created_at: minutesAgo(45) },
        { thread_id: THREAD_ID, seq: 2, role: 'user', content: 'fresh operator turn', created_at: minutesAgo(5) },
      ],
    });
    const result = await IbThreads.recentOperatorTurns(ACTOR, THREAD_ID, { limit: 3, maxAgeMinutes: 30 });
    expect(result).toEqual(['fresh operator turn']);
  });

  test('a thread owned by a DIFFERENT actor returns nothing (ownership-bound)', async () => {
    const IbThreads = withThreadsModule({
      threads: [{ id: THREAD_ID, admin_actor_id: 'someone-else' }],
      turns: [{ thread_id: THREAD_ID, seq: 1, role: 'user', content: 'not this actor\'s thread', created_at: minutesAgo(1) }],
    });
    const result = await IbThreads.recentOperatorTurns(ACTOR, THREAD_ID, { limit: 3, maxAgeMinutes: 30 });
    expect(result).toEqual([]);
  });

  test('a nonexistent thread, missing actorId, or missing threadId all return []', async () => {
    const IbThreads = withThreadsModule({ threads: [], turns: [] });
    expect(await IbThreads.recentOperatorTurns(ACTOR, 'no-such-thread', {})).toEqual([]);
    expect(await IbThreads.recentOperatorTurns(null, THREAD_ID, {})).toEqual([]);
    expect(await IbThreads.recentOperatorTurns(ACTOR, null, {})).toEqual([]);
  });
});
