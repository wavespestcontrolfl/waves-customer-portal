// 20261102030000_social_engagement_reach (GATE_SOCIAL_REACH_INGEST, owner 2026-11-01): social_post_engagement gets
// nullable integer reach and views. Runs against the migrated PostgreSQL database inside a transaction that is
// rolled back. Skips without DATABASE_URL (CI runs it). Synthetic data only.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

const knexLib = require('knex');
const migration = require('../models/migrations/20261102030000_social_engagement_reach');

describeDb('social engagement reach migration (PostgreSQL, rolled back)', () => {
  let database; let trx;
  beforeAll(() => {
    database = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  const columns = async () => {
    const { rows } = await trx.raw(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'social_post_engagement' AND column_name IN ('reach', 'views') ORDER BY column_name",
    );
    return rows;
  };

  test('up adds nullable integer reach and views with no default (existing rows read NULL = not measured); up twice is a no-op', async () => {
    await migration.down(trx);
    expect(await columns()).toEqual([]);
    await migration.up(trx);
    expect(await columns()).toEqual([
      { column_name: 'reach', data_type: 'integer', is_nullable: 'YES', column_default: null },
      { column_name: 'views', data_type: 'integer', is_nullable: 'YES', column_default: null },
    ]);
    await migration.up(trx);
    expect((await columns())).toHaveLength(2);
  });

  test('down drops both columns and a second down is a no-op', async () => {
    await migration.up(trx);
    await migration.down(trx);
    expect(await columns()).toEqual([]);
    await migration.down(trx);
    expect(await columns()).toEqual([]);
  });
});
