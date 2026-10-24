// SpeedZone Southern is the EW (owner 2026-10-24): formulation and actives follow the EW label.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261024130000_speedzone_southern_ew_identity');

const before = () => Object.fromEntries(Object.entries(migration.SET).map(([column, [from]]) => [column, from]));

test('the EW actives replace mecoprop-p; the formulation reads EW', () => {
  expect(migration.SET.formulation[1]).toBe('EW');
  expect(migration.SET.active_ingredient[1]).toMatch(/dichlorprop-p/);
  expect(migration.SET.active_ingredient[1]).not.toMatch(/mecoprop|MCPP/i);
});

describeDb('20261024130000 SpeedZone Southern EW identity', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `speedzone_ew_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'audit_log']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  test('rewrites the row only while every field holds the value read; once, audited; an edited row stays', async () => {
    const id = randomUUID();
    await knex('products_catalog').insert({ id, name: 'SpeedZone Southern', epa_reg_number: '2217-1031', ...before() });
    await migration.up(knex);
    await migration.up(knex);
    const row = await knex('products_catalog').where({ id }).first();
    expect(row).toMatchObject({ formulation: 'EW', active_ingredient: migration.SET.active_ingredient[1], label_verified_by: 'label-check-2026-10-22', epa_reg_number: '2217-1031' });
    expect(row.label_verified_at.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(await knex('audit_log').where('action', 'like', 'migration:20261024130000_%')).toHaveLength(1);

    const edited = randomUUID();
    await knex('products_catalog').insert({ id: edited, name: 'SpeedZone Southern', ...before(), formulation: 'EW-admin' });
    await migration.up(knex);
    expect((await knex('products_catalog').where({ id: edited }).first()).active_ingredient).toBe(migration.SET.active_ingredient[0]);
  });
});
