// Agent Activity loader error contract (gate ON): a ledger table that is
// missing on this deployment (Postgres 42P01) degrades to an empty,
// reported-unavailable source; any other database error propagates so the
// endpoint fails loudly instead of rendering an empty feed.
process.env.GATE_AGENT_ACTIVITY = 'true';

const mockTableErrors = {};

// Minimal chainable knex stand-in: every builder method returns the builder,
// awaiting it resolves [] or rejects with the error registered for the table.
function mockMakeBuilder(table) {
  const name = String(table).split(' ')[0];
  const builder = {};
  for (const m of ['select', 'where', 'whereIn', 'leftJoin', 'orderBy', 'limit']) {
    builder[m] = () => builder;
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
});
