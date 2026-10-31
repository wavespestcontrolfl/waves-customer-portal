jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/indexnow-submit', () => ({ submit: jest.fn() }));

const db = require('../models/db');
const IndexNow = require('../services/seo/indexnow-submit');
const generator = require('../services/seo/seo-action-generator');

const action = {
  id: 'act-1',
  url: 'https://wavespestcontrol.com/bradenton-pest-control',
  action_type: 'submit_indexnow',
  city: 'Bradenton',
  service: 'pest control',
};

// A connection (db or trx) that serves the three tables createExperiment
// touches. `insertResult` is what the experiment insert resolves or rejects with.
function makeConn(writes, insertResult) {
  const conn = jest.fn((table) => {
    if (table === 'gsc_pages') {
      const q = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => ({ clicks: '12', impressions: '340', ctr: '0.035', position: '8.4' })),
      };
      return q;
    }
    if (table === 'seo_url_experiments') {
      return {
        insert: jest.fn((row) => ({
          returning: jest.fn(async () => {
            if (insertResult instanceof Error) throw insertResult;
            writes.push(['seo_url_experiments', row]);
            return insertResult;
          }),
        })),
      };
    }
    if (table === 'seo_actions') {
      const q = {
        where: jest.fn(() => q),
        update: jest.fn(async (patch) => {
          writes.push(['seo_actions', patch]);
          return 1;
        }),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  conn.raw = jest.fn((sql) => sql);
  conn.fn = { now: () => 'now()' };
  return conn;
}

afterEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  delete db.raw;
  delete db.transaction;
});

describe('SeoActionGenerator.createExperiment — runs on the caller\'s connection', () => {
  test('a passed transaction carries the GSC read, the insert and the experiment link; db is untouched', async () => {
    const writes = [];
    const trx = makeConn(writes, [{ id: 'exp-1' }]);

    const experiment = await generator.createExperiment(action, trx);

    expect(experiment).toEqual({ id: 'exp-1' });
    expect(writes).toEqual([
      ['seo_url_experiments', expect.objectContaining({
        url: action.url,
        action_type: 'submit_indexnow',
        target_query_cluster: 'pest control Bradenton',
        pre_28d_clicks: 12,
        pre_28d_impressions: 340,
        status: 'running',
      })],
      ['seo_actions', { experiment_id: 'exp-1' }],
    ]);
    expect(db).not.toHaveBeenCalled();
  });

  test('without a connection it still uses db', async () => {
    const writes = [];
    const conn = makeConn(writes, [{ id: 'exp-2' }]);
    db.mockImplementation(conn);
    db.raw = conn.raw;

    await expect(generator.createExperiment(action)).resolves.toEqual({ id: 'exp-2' });
    expect(writes.map(([table]) => table)).toEqual(['seo_url_experiments', 'seo_actions']);
  });
});

describe('SeoActionGenerator.autoExecute — done commits only with its experiment', () => {
  // db.transaction fake: writes through `trx` reach `committed` only when the
  // callback resolves; a rejected callback discards them, like a rollback.
  function wireDb(insertResult) {
    const committed = [];
    const outside = [];
    const listQuery = {
      where: jest.fn(() => listQuery),
      then: (resolve, reject) => Promise.resolve([action]).then(resolve, reject),
    };
    let listed = false;
    db.mockImplementation((table) => {
      if (table !== 'seo_actions') throw new Error(`unexpected table ${table}`);
      // The first call lists the actions; later calls are the catch's update.
      if (!listed) {
        listed = true;
        return listQuery;
      }
      const q = {
        where: jest.fn(() => q),
        update: jest.fn(async (patch) => {
          outside.push(patch);
          return 1;
        }),
      };
      return q;
    });
    db.transaction = jest.fn(async (cb) => {
      const staged = [];
      const result = await cb(makeConn(staged, insertResult));
      committed.push(...staged);
      return result;
    });
    return { committed, outside };
  }

  beforeEach(() => {
    IndexNow.submit.mockResolvedValue({ ok: true });
  });

  test('a failed experiment insert rolls back done and marks the action failed', async () => {
    const { committed, outside } = wireDb(new Error('insert into seo_url_experiments failed'));

    const result = await generator.autoExecute('wavespestcontrol.com');

    expect(result).toEqual({ domain: 'wavespestcontrol.com', auto_executed: 0, manual_required: 0, failed: 1 });
    expect(committed).toEqual([]);
    expect(outside).toEqual([{ execution_status: 'failed', execution_notes: 'insert into seo_url_experiments failed' }]);
  });

  test('a successful run commits done and the experiment link together', async () => {
    const { committed, outside } = wireDb([{ id: 'exp-9' }]);

    const result = await generator.autoExecute('wavespestcontrol.com');

    expect(result).toEqual({ domain: 'wavespestcontrol.com', auto_executed: 1, manual_required: 0, failed: 0 });
    expect(committed).toEqual([
      ['seo_actions', expect.objectContaining({ execution_status: 'done', execution_notes: 'IndexNow submission sent' })],
      ['seo_url_experiments', expect.objectContaining({ url: action.url })],
      ['seo_actions', { experiment_id: 'exp-9' }],
    ]);
    expect(outside).toEqual([]);
  });
});
