/**
 * Codex round: the taint from a general admin read must survive follow-up
 * turns of the same conversation. The client resubmits plain-string history
 * (no tool blocks), so the taint is read from the SERVER's own record of the
 * thread: the marker the route appends to the assistant turn of an exchange
 * that read data. Synthetic ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDb = jest.fn();
jest.mock('../models/db', () => (...args) => mockDb(...args));

const IbThreads = require('../services/intelligence-bar/threads');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');

const ACTOR = 'admin-1';
const THREAD = '10000000-0000-4000-8000-0000000000a1';
const OTHER_THREAD = '10000000-0000-4000-8000-0000000000a2';
const FOREIGN_THREAD = '10000000-0000-4000-8000-0000000000a3';
const MARKER = IbThreads.UNTRUSTED_READ_MARKER;

// A small fake db with real where-filtering for the two thread tables.
function fakeDb({ threads, turns, failOn = null }) {
  return (table) => {
    if (failOn === table) throw new Error('connection reset');
    if (table === 'ib_threads') {
      return { where: cond => ({ first: async () => threads.find(t => Object.entries(cond).every(([k, v]) => t[k] === v)) }) };
    }
    let rows = [...turns];
    const api = {
      where(column, op, value) {
        if (op === undefined) return api;
        if (value === undefined) rows = rows.filter(r => r[column] === op);
        else if (op === 'like') {
          const needle = value.replace(/^%|%$/g, '');
          rows = rows.filter(r => String(r[column]).includes(needle));
        }
        return api;
      },
      andWhere(...args) { return api.where(...args); },
      first: async () => rows[0],
    };
    return api;
  };
}

const seed = {
  threads: [{ id: THREAD, admin_actor_id: ACTOR }, { id: OTHER_THREAD, admin_actor_id: ACTOR }, { id: FOREIGN_THREAD, admin_actor_id: 'admin-2' }],
  turns: [
    { thread_id: THREAD, seq: 1, role: 'user', content: 'Check the payers screen' },
    { thread_id: THREAD, seq: 2, role: 'assistant', content: `Two payers are open.\n${MARKER}` },
    { thread_id: OTHER_THREAD, seq: 1, role: 'user', content: 'Hello' },
    { thread_id: OTHER_THREAD, seq: 2, role: 'assistant', content: 'Hi.' },
    { thread_id: FOREIGN_THREAD, seq: 2, role: 'assistant', content: `x\n${MARKER}` },
  ],
};
beforeEach(() => mockDb.mockReset().mockImplementation(fakeDb(seed)));

describe('hasUntrustedRead (the thread record)', () => {
  test('a thread with a marked exchange is tainted; another thread of the same actor is not', async () => {
    expect(await IbThreads.hasUntrustedRead(ACTOR, THREAD)).toBe(true);
    expect(await IbThreads.hasUntrustedRead(ACTOR, OTHER_THREAD)).toBe(false);
  });
  test('a thread the actor does not own cannot be read (throws, so the caller fails closed)', async () => {
    await expect(IbThreads.hasUntrustedRead(ACTOR, FOREIGN_THREAD)).rejects.toThrow('thread not readable');
    await expect(IbThreads.hasUntrustedRead(ACTOR, '10000000-0000-4000-8000-0000000000ff')).rejects.toThrow();
  });
  test('the marker has no LIKE wildcard and the model never sees it in history', () => {
    expect(MARKER).not.toMatch(/[%_]/);
  });
});

describe('loadRequestTaint (once per request)', () => {
  const plainHistory = [{ role: 'user', content: 'Check the payers screen' }, { role: 'assistant', content: 'Two payers are open.' }];

  test('read with data in request 1, plain-string history in request 2 on the same thread: tainted', async () => {
    const taint = await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: THREAD, actorId: ACTOR });
    expect(taint.untrustedRead).toBe(true);
    expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id: 'c', updates: { city: 'Bradenton' } }, {}, taint)).toBe(false);
  });
  test('a different thread of the same actor is not tainted', async () => {
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: OTHER_THREAD, actorId: ACTOR })).untrustedRead).toBe(false);
  });
  test('no thread id (a fresh conversation) is not tainted, and the thread table is not touched', async () => {
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: undefined, actorId: ACTOR })).untrustedRead).toBe(false);
    expect(mockDb).not.toHaveBeenCalled();
  });
  test('records that cannot be read taint (fail closed): a database error, an unknown or foreign thread', async () => {
    mockDb.mockImplementation(fakeDb({ ...seed, failOn: 'ib_threads' }));
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: THREAD, actorId: ACTOR })).untrustedRead).toBe(true);
    mockDb.mockImplementation(fakeDb({ ...seed, failOn: 'ib_thread_turns' }));
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: OTHER_THREAD, actorId: ACTOR })).untrustedRead).toBe(true);
    mockDb.mockImplementation(fakeDb(seed));
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: FOREIGN_THREAD, actorId: ACTOR })).untrustedRead).toBe(true);
  });
  test('a read that errored left no marker: the thread is not tainted', async () => {
    const erroredTurns = seed.turns.filter(t => t.thread_id !== THREAD).concat([{ thread_id: THREAD, seq: 2, role: 'assistant', content: 'The screen could not be read.' }]);
    mockDb.mockImplementation(fakeDb({ ...seed, turns: erroredTurns }));
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: THREAD, actorId: ACTOR })).untrustedRead).toBe(false);
  });
  test('saved tool blocks in the history taint without any thread lookup', async () => {
    const blocks = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_admin_data', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ status: 200, endpoint: '/x', data: { a: 1 } }) }] },
    ];
    expect((await OwnerDirect.loadRequestTaint({ history: blocks, threadId: OTHER_THREAD, actorId: ACTOR })).untrustedRead).toBe(true);
    expect(mockDb).not.toHaveBeenCalled();
  });
  test('owner-direct off: the flag decides nothing, so no lookup is made', async () => {
    expect((await OwnerDirect.loadRequestTaint({ history: plainHistory, threadId: THREAD, actorId: ACTOR, needed: false })).untrustedRead).toBe(false);
    expect(mockDb).not.toHaveBeenCalled();
  });
});
