/**
 * Durable spend ceilings for the staff pickers' Google road times
 * (picker-road-spend.js, GATE_PICKER_ROAD_CHECK; owner 2026-10-27: "we just
 * have to make sure costs are appropriate").
 *
 * What this locks down:
 *  1. A reservation counts the account AND the staff user in one transaction,
 *     priced as Google bills: traffic-aware 1 cent, plain road time 0.5 cent.
 *  2. Any ceiling crossed (user day, account day, account month) rolls the
 *     transaction back, so a refused search counts nothing.
 *  3. No counter (DB error) or no staff user = no Google (fail closed).
 *  4. The migration creates the (bucket, day) table and drops it on down.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { reserveRoadSpend, caps, costMills } = require('../services/scheduling/picker-road-spend');

const NOW = new Date('2026-11-12T15:00:00Z'); // 10:00 ET, Nov 12

// A transaction double: `earlier` = the account's earlier days this month,
// `rows` = what the upsert returns. Records the SQL and whether it committed.
function fakeConn({ earlier = { pro: 0, plain: 0 }, rows, fail } = {}) {
  const seen = { raw: [], committed: false, rolledBack: false, where: [] };
  const trx = (table) => {
    const q = {
      where: (...args) => { seen.where.push([table, ...args]); return q; },
      sum: () => q,
      first: async () => earlier,
    };
    return q;
  };
  trx.raw = async (sql, bindings) => {
    if (fail) throw new Error(fail);
    seen.raw.push({ sql, bindings });
    return { rows };
  };
  const conn = {
    transaction: async (work) => {
      try {
        const out = await work(trx);
        seen.committed = true;
        return out;
      } catch (err) {
        seen.rolledBack = true;
        throw err;
      }
    },
  };
  return { conn, seen };
}

const counted = (accountPro, accountPlain, userPro, userPlain) => [
  { bucket: 'all', pro_elements: accountPro, plain_elements: accountPlain },
  { bucket: 'staff:s1', pro_elements: userPro, plain_elements: userPlain },
];

describe('reserveRoadSpend', () => {
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });

  test('nothing to buy asks nothing', async () => {
    const { conn, seen } = fakeConn();
    await expect(reserveRoadSpend({ spender: 's1', pro: 0, plain: 0, conn, now: NOW })).resolves.toEqual({ allowed: true });
    expect(seen.raw).toHaveLength(0);
  });

  test('counts the account and the staff user in one upsert, on the Eastern day', async () => {
    const { conn, seen } = fakeConn({ rows: counted(30, 60, 30, 60) });
    await expect(reserveRoadSpend({ spender: 's1', pro: 30, plain: 60, conn, now: NOW })).resolves.toEqual({ allowed: true });
    expect(seen.committed).toBe(true);
    const [{ sql, bindings }] = seen.raw;
    expect(sql).toMatch(/INSERT INTO picker_road_spend \(bucket, day, pro_elements, plain_elements\)/);
    expect(sql).toMatch(/ON CONFLICT \(bucket, day\) DO UPDATE SET/);
    expect(bindings).toEqual(['all', '2026-11-12', 30, 60, 'staff:s1', '2026-11-12', 30, 60]);
    // The month so far reads the account's EARLIER days only (today is the upsert).
    expect(seen.where).toEqual(expect.arrayContaining([
      ['picker_road_spend', { bucket: 'all' }],
      ['picker_road_spend', 'day', '>=', '2026-11-01'],
      ['picker_road_spend', 'day', '<', '2026-11-12'],
    ]));
  });

  test('prices lookups as Google bills them: traffic-aware 1 cent, plain 0.5 cent', () => {
    expect(costMills(100, 0)).toBe(1000); // $1.00
    expect(costMills(0, 100)).toBe(500); // $0.50
  });

  test.each([
    ['the staff user\'s day', { PICKER_ROAD_USER_DAILY_CAP_CENTS: '100' }, counted(80, 0, 101, 0), {}, 'user_daily_cap'],
    ['the account\'s day', { PICKER_ROAD_DAILY_CAP_CENTS: '200' }, counted(201, 0, 50, 0), {}, 'daily_cap'],
    ['the account\'s month', { PICKER_ROAD_MONTHLY_CAP_CENTS: '1000' }, counted(100, 0, 100, 0), { pro: 850, plain: 120 }, 'monthly_cap'],
  ])('%s over its ceiling: refused and rolled back (nothing counted)', async (_name, env, rows, earlier, reason) => {
    Object.assign(process.env, env);
    const { conn, seen } = fakeConn({ rows, earlier });
    await expect(reserveRoadSpend({ spender: 's1', pro: 10, conn, now: NOW })).resolves.toEqual({ allowed: false, reason });
    expect(seen.rolledBack).toBe(true);
    expect(seen.committed).toBe(false);
  });

  test('exactly at a ceiling is still allowed', async () => {
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '200';
    const { conn } = fakeConn({ rows: counted(200, 0, 200, 0) });
    await expect(reserveRoadSpend({ spender: 's1', pro: 10, conn, now: NOW })).resolves.toEqual({ allowed: true });
  });

  test('no counter: no Google (fail closed)', async () => {
    const { conn } = fakeConn({ fail: 'connection refused' });
    await expect(reserveRoadSpend({ spender: 's1', pro: 10, conn, now: NOW }))
      .resolves.toEqual({ allowed: false, reason: 'counter_unavailable' });
  });

  test('no staff user: no Google', async () => {
    const { conn, seen } = fakeConn({ rows: counted(1, 0, 1, 0) });
    await expect(reserveRoadSpend({ spender: null, pro: 10, conn, now: NOW }))
      .resolves.toEqual({ allowed: false, reason: 'no_staff_user' });
    expect(seen.raw).toHaveLength(0);
  });

  test('ceilings come from the env in cents; a bad value keeps the default', () => {
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '350';
    process.env.PICKER_ROAD_USER_DAILY_CAP_CENTS = 'lots';
    delete process.env.PICKER_ROAD_MONTHLY_CAP_CENTS;
    const c = caps();
    expect(c.dayMills).toBe(3500);
    expect(c.userDayMills).toBe(caps.DEFAULTS.userDailyCents * 10);
    expect(c.monthMills).toBe(caps.DEFAULTS.monthlyCents * 10);
  });
});

describe('picker_road_spend migration', () => {
  test('creates the (bucket, day) table and drops it on down', async () => {
    const m = require('../models/migrations/20261028000000_picker_road_spend');
    const columns = [];
    const t = new Proxy({}, {
      get: (_target, name) => (...args) => {
        columns.push([name, ...args]);
        const chain = { notNullable: () => chain, defaultTo: () => chain };
        return chain;
      },
    });
    const knex = {
      fn: { now: () => 'NOW' },
      schema: {
        hasTable: jest.fn(async () => false),
        createTable: jest.fn(async (_name, build) => build(t)),
        dropTableIfExists: jest.fn(async () => {}),
      },
    };
    await m.up(knex);
    expect(knex.schema.createTable).toHaveBeenCalledWith('picker_road_spend', expect.any(Function));
    expect(columns).toEqual(expect.arrayContaining([
      ['text', 'bucket'], ['date', 'day'], ['integer', 'pro_elements'], ['integer', 'plain_elements'], ['primary', ['bucket', 'day']],
    ]));
    await m.down(knex);
    expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith('picker_road_spend');
  });

  test('an existing table is left alone', async () => {
    const m = require('../models/migrations/20261028000000_picker_road_spend');
    const knex = { schema: { hasTable: jest.fn(async () => true), createTable: jest.fn() } };
    await m.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
  });
});
