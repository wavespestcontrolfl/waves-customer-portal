// DB-backed (self-skips without DATABASE_URL, like the other Postgres suites).
// Runs the real migration against an owned clone of products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261001000001_products_catalog_mow_hold_days');

describeDb('products_catalog.mow_hold_days migration', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `mow_hold_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
    // CI may already have run the real migration: start the owned copy before it.
    await knex.raw('ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS products_catalog_mow_hold_days_check');
    await knex.raw('ALTER TABLE products_catalog DROP COLUMN IF EXISTS mow_hold_days');
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (row) => {
    const [created] = await knex('products_catalog').insert({ id: randomUUID(), ...row }).returning('id');
    return created.id;
  };

  test('adds a nullable smallint column, writes no data, and CHECKs 1..14', async () => {
    const before = await insert({ name: 'Plain Product', category: 'fertilizer' });
    await migration.up(knex);
    expect(await knex.schema.hasColumn('products_catalog', 'mow_hold_days')).toBe(true);
    const column = await knex.raw(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = 'products_catalog' AND column_name = 'mow_hold_days'",
      [schema],
    );
    expect(column.rows[0]).toEqual({ data_type: 'smallint', is_nullable: 'YES' });
    // No seed: the pre-existing row, and every other row, stays empty.
    expect((await knex('products_catalog').where({ id: before }).first()).mow_hold_days).toBeNull();
    expect((await knex('products_catalog').whereNotNull('mow_hold_days').count('* as n').first()).n).toBe('0');

    const set = (value) => knex('products_catalog').where({ id: before }).update({ mow_hold_days: value });
    await expect(set(1)).resolves.toBe(1);
    await expect(set(14)).resolves.toBe(1);
    await expect(set(null)).resolves.toBe(1);
    await expect(set(0)).rejects.toThrow(/products_catalog_mow_hold_days_check/);
    await expect(set(15)).rejects.toThrow(/products_catalog_mow_hold_days_check/);
    await expect(set(-3)).rejects.toThrow(/products_catalog_mow_hold_days_check/);
  });

  test('is idempotent: a second run keeps one column, one constraint and the values', async () => {
    await migration.up(knex);
    const id = await insert({ name: 'Plain Product', category: 'fertilizer', mow_hold_days: 2 });
    await migration.up(knex);
    expect((await knex('products_catalog').where({ id }).first()).mow_hold_days).toBe(2);
    const constraints = await knex.raw(
      "SELECT 1 FROM pg_constraint WHERE conname = 'products_catalog_mow_hold_days_check' AND conrelid = 'products_catalog'::regclass",
    );
    expect(constraints.rows).toHaveLength(1);
  });

  test('down drops the constraint and the column, and is safe to repeat', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(await knex.schema.hasColumn('products_catalog', 'mow_hold_days')).toBe(false);
    await expect(migration.down(knex)).resolves.not.toThrow();
  });
});
