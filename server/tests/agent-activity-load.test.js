// Agent Activity loader error contract (gate ON): a ledger table that is
// missing on this deployment (Postgres 42P01) degrades to an empty,
// reported-unavailable source; any other database error propagates so the
// endpoint fails loudly instead of rendering an empty feed.
process.env.GATE_AGENT_ACTIVITY = 'true';

const mockTableErrors = {};
const mockOps = {};

// Minimal chainable knex stand-in: every builder method returns the builder,
// awaiting it resolves [] or rejects with the error registered for the table.
function mockMakeBuilder(table) {
  const name = String(table).split(' ')[0];
  const builder = {};
  for (const m of ['select', 'where', 'orWhere', 'whereIn', 'whereNull', 'andWhere', 'whereRaw', 'andWhereRaw', 'orWhereRaw', 'leftJoin', 'orderBy', 'orderByRaw', 'limit']) {
    builder[m] = (...args) => {
      (mockOps[name] ||= []).push([m, ...args.map((a) => (typeof a === 'function' ? 'fn' : a))]);
      // Grouped clauses run against the same builder so nested ones are recorded too.
      if (typeof args[0] === 'function') args[0](builder);
      return builder;
    };
  }
  builder.then = (resolve, reject) => {
    const err = mockTableErrors[name];
    return err ? Promise.reject(err).then(resolve, reject) : Promise.resolve([]).then(resolve, reject);
  };
  return builder;
}

jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockMakeBuilder(table));
  fn.raw = jest.fn((sql) => sql);
  return fn;
});

const { getActivity, MISSING_TABLE_SQLSTATE } = require('../services/agent-activity');

afterEach(() => {
  for (const k of Object.keys(mockTableErrors)) delete mockTableErrors[k];
  for (const k of Object.keys(mockOps)) delete mockOps[k];
});

describe('getActivity loader', () => {
  it('reads the gate at call time — unsetting the env after load turns the feed off without a restart', async () => {
    const before = process.env.GATE_AGENT_ACTIVITY;
    process.env.GATE_AGENT_ACTIVITY = '';
    try {
      const feed = await getActivity({ windowHours: 24 });
      expect(feed.available).toBe(false);
    } finally {
      process.env.GATE_AGENT_ACTIVITY = before;
    }
    const feed = await getActivity({ windowHours: 24 });
    expect(feed.available).toBe(true);
  });

  it('reports a missing table as unavailable and keeps the rest of the feed', async () => {
    mockTableErrors.message_drafts = Object.assign(new Error('relation "message_drafts" does not exist'), { code: MISSING_TABLE_SQLSTATE });
    const feed = await getActivity({ windowHours: 24 });
    expect(feed.available).toBe(true);
    expect(feed.unavailableSources).toEqual(['message_drafts']);
    expect(feed.items).toEqual([]);
  });

  it('propagates any other database error instead of returning an empty feed', async () => {
    mockTableErrors.job_health = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await expect(getActivity({ windowHours: 24 })).rejects.toThrow('connection refused');
  });

  it('digest history: a row marked done inside the window qualifies and orders by done_at; a done row is never pinned', async () => {
    await getActivity({ windowHours: 24 });
    const ops = mockOps.notifications || [];
    // Pinned query (first): done rows are history, never pinned.
    expect(ops).toContainEqual(['whereNull', 'done_at']);
    // Windowed query: created_at, resolvedAt OR done_at inside the window, newest of the three first.
    expect(ops.some((o) => o[0] === 'orWhere' && o[1] === 'done_at' && o[2] === '>=')).toBe(true);
    expect(ops.some((o) => o[0] === 'orderByRaw' && /GREATEST\(created_at,.*done_at\) DESC/.test(o[1]))).toBe(true);
  });
});
