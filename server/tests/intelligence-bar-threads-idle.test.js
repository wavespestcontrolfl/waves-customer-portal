/**
 * IbThreads idle limit (owner 2026-10-12): the palette resumes "the latest
 * thread" only while it is fresh. Past IB_THREAD_IDLE_HOURS (default 4) the
 * lookup returns nothing and a new conversation starts, but a thread named by
 * id (History, or an explicit thread_id on /query) still loads and appends.
 *
 * Uses a small fake db with REAL filtering for the one whereRaw the module
 * adds, so the limit, the actor binding and the env override are proven
 * against the module's own query, not a mocked stand-in.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GATE_IB_THREADS = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const HOUR = 3600000;
const ACTOR = 'actor-idle';
let threads;
let turns;

function makeDb() {
  function table(name) {
    if (name === 'ib_threads') {
      let rows = [...threads];
      const api = {
        where(cond, val) {
          const c = typeof cond === 'string' ? { [cond]: val } : cond;
          rows = rows.filter((t) => Object.entries(c).every(([k, v]) => t[k] === v));
          return api;
        },
        whereRaw(sql, bindings) {
          // The raw condition: last_active_at within (>=) or past (<) the last N hours.
          const match = /last_active_at (>=|<) NOW\(\) - \(\? \|\| ' hours'\)::interval/.exec(sql);
          expect(match).not.toBeNull();
          const cutoff = Date.now() - Number(bindings[0]) * HOUR;
          rows = rows.filter((t) => (match[1] === '>='
            ? new Date(t.last_active_at).getTime() >= cutoff : new Date(t.last_active_at).getTime() < cutoff));
          return api;
        },
        orderBy(col, dir) {
          rows = [...rows].sort((a, b) => (dir === 'desc'
            ? new Date(b[col]) - new Date(a[col]) : new Date(a[col]) - new Date(b[col])));
          return api;
        },
        first: async () => rows[0],
      };
      return api;
    }
    let rows = [...turns];
    const api = {
      where(col, val) { rows = rows.filter((t) => t[col] === val); return api; },
      orderBy(col, dir) { rows = [...rows].sort((a, b) => (dir === 'desc' ? b[col] - a[col] : a[col] - b[col])); return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      select() { return Promise.resolve(rows); },
    };
    return api;
  }
  return table;
}

jest.mock('../models/db', () => {
  const fn = (name) => global.__idleTestDb(name);
  fn.raw = jest.fn();
  return fn;
});

let IbThreads;
beforeEach(() => {
  jest.resetModules();
  delete process.env.IB_THREAD_IDLE_HOURS;
  threads = [];
  turns = [];
  global.__idleTestDb = makeDb();
  IbThreads = require('../services/intelligence-bar/threads');
});
afterAll(() => { delete global.__idleTestDb; delete process.env.IB_THREAD_IDLE_HOURS; });

const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
function seed(id, hoursAgo, actor = ACTOR) {
  threads.push({ id, admin_actor_id: actor, title: `Synthetic ${id}`, context: 'customers', last_active_at: ago(hoursAgo) });
  turns.push({ thread_id: id, seq: 1, role: 'user', content: 'Synthetic ask' }, { thread_id: id, seq: 2, role: 'assistant', content: 'Synthetic answer' });
}

describe('IbThreads idle limit', () => {
  test('the default limit is 4 hours', () => {
    expect(IbThreads.idleHours()).toBe(4);
  });

  test('a latest thread inside the limit resumes with its history', async () => {
    seed('t-fresh', 3.5);
    const thread = await IbThreads.latestThread(ACTOR);
    expect(thread.id).toBe('t-fresh');
    expect(thread.lastSeq).toBe(2);
    expect(thread.conversationHistory).toHaveLength(2);
  });

  test('a latest thread past the limit returns none, so a new conversation starts', async () => {
    seed('t-idle', 4.5);
    expect(await IbThreads.latestThread(ACTOR)).toBeNull();
  });

  test('an older thread never stands in when the newest is idle', async () => {
    seed('t-older', 30);
    seed('t-newest', 5);
    expect(await IbThreads.latestThread(ACTOR)).toBeNull();
  });

  test('the freshest thread wins over an older one inside the limit', async () => {
    seed('t-older', 3.9);
    seed('t-newest', 0.5);
    expect((await IbThreads.latestThread(ACTOR)).id).toBe('t-newest');
  });

  test('another actor\'s fresh thread is never offered', async () => {
    seed('t-theirs', 0.1, 'someone-else');
    expect(await IbThreads.latestThread(ACTOR)).toBeNull();
  });

  test('an explicit thread id still loads a thread that is far past the limit', async () => {
    seed('t-old', 24 * 40);
    const thread = await IbThreads.getThread(ACTOR, 't-old');
    expect(thread.id).toBe('t-old');
    expect(thread.conversationHistory).toHaveLength(2);
    expect(await IbThreads.getThread('someone-else', 't-old')).toBeNull();
  });

  test('IB_THREAD_IDLE_HOURS overrides the limit', async () => {
    process.env.IB_THREAD_IDLE_HOURS = '12';
    expect(IbThreads.idleHours()).toBe(12);
    seed('t-half-day', 8);
    expect((await IbThreads.latestThread(ACTOR)).id).toBe('t-half-day');
    process.env.IB_THREAD_IDLE_HOURS = '1';
    expect(await IbThreads.latestThread(ACTOR)).toBeNull();
  });

  test('a huge value is capped at a year', () => {
    process.env.IB_THREAD_IDLE_HOURS = '1e21';
    expect(IbThreads.idleHours()).toBe(24 * 365);
  });

  test.each(['0', '-3', 'abc', '', 'NaN', 'Infinity'])('IB_THREAD_IDLE_HOURS=%p falls back to 4 hours', (value) => {
    process.env.IB_THREAD_IDLE_HOURS = value;
    expect(IbThreads.idleHours()).toBe(4);
  });
});

describe('IbThreads.isThreadIdle (the server-side limit behind /query)', () => {
  const ID = '5a1c2f7a-aaaa-4bbb-8ccc-deadbeef0001';
  test('an owned thread past the limit is idle; inside the limit is not', async () => {
    seed(ID, 5);
    expect(await IbThreads.isThreadIdle(ACTOR, ID)).toBe(true);
    threads = []; turns = [];
    seed(ID, 3);
    expect(await IbThreads.isThreadIdle(ACTOR, ID)).toBe(false);
  });

  test('another actor\'s, a missing and a malformed id are never idle', async () => {
    seed(ID, 50, 'someone-else');
    expect(await IbThreads.isThreadIdle(ACTOR, ID)).toBe(false);
    expect(await IbThreads.isThreadIdle(ACTOR, '5a1c2f7a-aaaa-4bbb-8ccc-deadbeef0009')).toBe(false);
    expect(await IbThreads.isThreadIdle(ACTOR, 'not-a-uuid')).toBe(false);
    expect(await IbThreads.isThreadIdle(null, ID)).toBe(false);
  });

  test('IB_THREAD_IDLE_HOURS moves the line', async () => {
    seed(ID, 5);
    process.env.IB_THREAD_IDLE_HOURS = '8';
    expect(await IbThreads.isThreadIdle(ACTOR, ID)).toBe(false);
  });
});
