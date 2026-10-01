// DB-backed (self-skips without DATABASE_URL, like the other Postgres suites).
// Runs the column migration and then the label seed against an owned clone of
// products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const column = require('../models/migrations/20261001000001_products_catalog_mow_hold_days');
const seed = require('../models/migrations/20261001000002_mow_hold_days_label_seed');

describeDb('mow_hold_days label seed migration', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `mow_seed_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
    await knex.raw('ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS products_catalog_mow_hold_days_check');
    await knex.raw('ALTER TABLE products_catalog DROP COLUMN IF EXISTS mow_hold_days');
    await column.up(knex);
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (row) => {
    const [created] = await knex('products_catalog').insert({ id: randomUUID(), ...row }).returning('id');
    return created.id;
  };
  const daysOf = async (id) => (await knex('products_catalog').where({ id }).first('mow_hold_days')).mow_hold_days;

  test('seeds SedgeHammer 2 and Talak 1 by EPA number, else by name; nothing else changes', async () => {
    const sedge = await insert({ name: 'Sedge Hammer Plus Herbicide', category: 'herbicide', epa_reg_number: ' 81880-24 ' });
    const talak = await insert({ name: 'Talak 7.9 F', category: 'insecticide' });
    const other = await insert({ name: 'Celsius WG', category: 'herbicide', epa_reg_number: '432-1507' });
    await seed.up(knex);
    expect(await daysOf(sedge)).toBe(2);
    expect(await daysOf(talak)).toBe(1);
    expect(await daysOf(other)).toBeNull();
  });

  test('never overwrites a value an admin already set, and a re-run is a no-op', async () => {
    const talak = await insert({ name: 'Talak 7.9 F', category: 'insecticide', epa_reg_number: '91234-145', mow_hold_days: 3 });
    await seed.up(knex);
    await seed.up(knex);
    expect(await daysOf(talak)).toBe(3);
  });

  test('an EPA match wins over a name-only match', async () => {
    const byEpa = await insert({ name: 'Talak (EPA row)', category: 'insecticide', epa_reg_number: '91234-145' });
    const nameOnly = await insert({ name: 'Talak bulk', category: 'insecticide' });
    await seed.up(knex);
    expect(await daysOf(byEpa)).toBe(1);
    expect(await daysOf(nameOnly)).toBeNull();
  });
});
