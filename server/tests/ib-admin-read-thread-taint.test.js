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
// The rule applies where the general read is live (its gate AND the platform
// gate) for a full-access login with owner-direct on; threads must be on to
// have a record.
const GATES = ['GATE_IB_GENERAL_READ', 'GATE_IB_PLATFORM', 'GATE_IB_THREADS'];
let gatesBefore;
beforeEach(() => {
  gatesBefore = Object.fromEntries(GATES.map(name => [name, process.env[name]]));
  for (const name of GATES) process.env[name] = 'true';
  mockDb.mockReset().mockImplementation(fakeDb(seed));
});
afterEach(() => {
  for (const name of GATES) { if (gatesBefore[name] === undefined) delete process.env[name]; else process.env[name] = gatesBefore[name]; }
});
const load = (extra = {}) => OwnerDirect.loadRequestTaint({ history: [], actorId: ACTOR, fullAccess: true, conversationHistory: [], ...extra });

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
    const taint = await load({ threadId: THREAD, conversationHistory: plainHistory });
    expect(taint.untrustedRead).toBe(true);
    expect(OwnerDirect.executesWithoutCard('update_customer', { customer_id: 'c', updates: { city: 'Bradenton' } }, {}, taint)).toBe(false);
  });
  test('a verified thread without the marker, with history, is not tainted: the record decides', async () => {
    expect((await load({ threadId: OTHER_THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(false);
  });
  test('records that cannot be read taint (fail closed): a database error, an unknown or foreign thread', async () => {
    mockDb.mockImplementation(fakeDb({ ...seed, failOn: 'ib_threads' }));
    expect((await load({ threadId: THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(true);
    mockDb.mockImplementation(fakeDb({ ...seed, failOn: 'ib_thread_turns' }));
    expect((await load({ threadId: OTHER_THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(true);
    mockDb.mockImplementation(fakeDb(seed));
    expect((await load({ threadId: FOREIGN_THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(true);
    // Even a first-looking message with a thread id the server cannot verify.
    expect((await load({ threadId: '10000000-0000-4000-8000-0000000000ff' })).untrustedRead).toBe(true);
  });
  test('a read that errored left no marker: the verified thread is not tainted', async () => {
    const erroredTurns = seed.turns.filter(t => t.thread_id !== THREAD).concat([{ thread_id: THREAD, seq: 2, role: 'assistant', content: 'The screen could not be read.' }]);
    mockDb.mockImplementation(fakeDb({ ...seed, turns: erroredTurns }));
    expect((await load({ threadId: THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(false);
  });

  describe('no server record to consult', () => {
    test('a follow-up turn (history, no thread id) is tainted: gate on, full access', async () => {
      expect((await load({ conversationHistory: plainHistory })).untrustedRead).toBe(true);
      expect(mockDb).not.toHaveBeenCalled();
    });
    test('the first message of a conversation (no history, no thread id) is not tainted', async () => {
      expect((await load({ conversationHistory: [] })).untrustedRead).toBe(false);
      expect((await load({ conversationHistory: undefined })).untrustedRead).toBe(false);
    });
    test('with the threads gate off there is no record: a follow-up is tainted, a first message is not, a thread id counts as a follow-up', async () => {
      process.env.GATE_IB_THREADS = 'false';
      expect((await load({ conversationHistory: plainHistory })).untrustedRead).toBe(true);
      expect((await load({ threadId: OTHER_THREAD })).untrustedRead).toBe(true);
      expect((await load({})).untrustedRead).toBe(false);
      expect(mockDb).not.toHaveBeenCalled();
    });
    test('a failed thread append after a read leaves the next turn a follow-up with no thread: tainted', async () => {
      // Request 1 read data and its append returned null, so the client holds history and no thread id.
      expect((await load({ threadId: undefined, conversationHistory: plainHistory })).untrustedRead).toBe(true);
    });
    test('the general read off (its gate, or the platform gate it needs): today\'s owner-direct behavior, never tainted', async () => {
      for (const off of ['GATE_IB_GENERAL_READ', 'GATE_IB_PLATFORM']) {
        process.env[off] = 'false';
        expect((await load({ conversationHistory: plainHistory })).untrustedRead).toBe(false);
        expect((await load({ threadId: THREAD, conversationHistory: plainHistory })).untrustedRead).toBe(false);
        process.env[off] = 'true';
      }
      expect(mockDb).not.toHaveBeenCalled();
    });
    test('a login without full access is never tainted by this rule', async () => {
      expect((await load({ fullAccess: false, conversationHistory: plainHistory })).untrustedRead).toBe(false);
    });
  });

  test('saved tool blocks in the history taint without any thread lookup', async () => {
    const blocks = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_admin_data', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ status: 200, endpoint: '/x', data: { a: 1 } }) }] },
    ];
    expect((await load({ history: blocks, threadId: OTHER_THREAD })).untrustedRead).toBe(true);
    expect(mockDb).not.toHaveBeenCalled();
  });
  test('owner-direct off: the flag decides nothing, so no lookup is made', async () => {
    expect((await load({ threadId: THREAD, conversationHistory: plainHistory, needed: false })).untrustedRead).toBe(false);
    expect(mockDb).not.toHaveBeenCalled();
  });
});
