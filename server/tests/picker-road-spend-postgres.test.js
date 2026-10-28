/**
 * Real migrated PostgreSQL: the pickers' Google spend counter
 * (picker-road-spend.js). The unit suite mocks the transaction; this one
 * proves the upsert, the per-bucket rows and the rollback of a refused
 * reservation against the real table.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('picker_road_spend against migrated PostgreSQL', () => {
  let database;
  let reserveRoadSpend;
  const ENV = { ...process.env };
  const NOW = new Date('2031-05-14T15:00:00Z'); // a day no other suite writes
  const staff = `t-${randomUUID()}`;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    ({ reserveRoadSpend } = require('../services/scheduling/picker-road-spend'));
  });

  afterEach(async () => {
    process.env = { ...ENV };
    await database('picker_road_spend').where('day', '2031-05-14').del();
  });
  afterAll(async () => { await database?.destroy(); });

  const rows = () => database('picker_road_spend').where('day', '2031-05-14').orderBy('bucket')
    .select('bucket', 'pro_elements', 'plain_elements');

  test('two reservations add up in the account and the staff rows', async () => {
    await expect(reserveRoadSpend({ spender: staff, pro: 30, plain: 40, now: NOW, conn: database })).resolves.toEqual({ allowed: true });
    await expect(reserveRoadSpend({ spender: staff, pro: 5, plain: 0, now: NOW, conn: database })).resolves.toEqual({ allowed: true });
    expect(await rows()).toEqual([
      { bucket: 'all', pro_elements: 35, plain_elements: 40 },
      { bucket: `staff:${staff}`, pro_elements: 35, plain_elements: 40 },
    ]);
  });

  test('a refused reservation counts nothing', async () => {
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '50'; // 50 traffic-aware lookups
    await expect(reserveRoadSpend({ spender: staff, pro: 40, now: NOW, conn: database })).resolves.toEqual({ allowed: true });
    await expect(reserveRoadSpend({ spender: staff, pro: 20, now: NOW, conn: database }))
      .resolves.toEqual({ allowed: false, reason: 'daily_cap' });
    expect(await rows()).toEqual([
      { bucket: 'all', pro_elements: 40, plain_elements: 0 },
      { bucket: `staff:${staff}`, pro_elements: 40, plain_elements: 0 },
    ]);
  });
});
