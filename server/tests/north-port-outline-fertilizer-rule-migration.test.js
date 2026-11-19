const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261118190000_north_port_outline_fertilizer_rule');

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describe('North Port outline fertilizer rule seed', () => {
  test('pins the city overlay, field setbacks and supplied fact sheet', () => {
    expect(migration.NORTH_PORT_RULE).toMatchObject({
      jurisdiction_id: 'north_port_fl',
      jurisdiction_name: 'City of North Port, FL',
      county: 'Sarasota',
      municipality: 'North Port',
      restricted_start_month: 4,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      nitrogen_restricted: true,
      phosphorus_restricted: true,
      phosphorus_soil_test_required: false,
      minimum_slow_release_nitrogen_percent: 50,
      source_url: 'https://www.northportfl.gov/files/assets/main/v/1/city-services-amp-safety/public-works/fertilizer-fact-sheet-updated.pdf',
      source_verified_at: '2026-11-18T00:00:00.000Z',
    });
    expect(migration.NORTH_PORT_RULE.waterway_buffer_rule).toMatch(/10 ft.*25 ft buffer.*swale flow channel/i);
    expect(migration.NORTH_PORT_RULE.public_summary).toMatch(/April 1 through September 30/);
  });
});

describeDb('20261118190000 North Port outline fertilizer rule', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `north_port_outline_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('jurisdiction_fertilizer_rules', (t) => {
      t.string('jurisdiction_id', 120).notNullable();
      t.string('jurisdiction_name', 160).notNullable();
      t.string('state', 20).notNullable();
      t.string('county', 80);
      t.string('municipality', 120);
      t.integer('restricted_start_month');
      t.integer('restricted_start_day');
      t.integer('restricted_end_month');
      t.integer('restricted_end_day');
      t.boolean('nitrogen_restricted').notNullable();
      t.boolean('phosphorus_restricted').notNullable();
      t.boolean('phosphorus_soil_test_required').notNullable();
      t.integer('minimum_slow_release_nitrogen_percent');
      t.text('waterway_buffer_rule');
      t.text('professional_certification_note');
      t.text('public_summary').notNullable();
      t.text('admin_summary');
      t.text('source_url');
      t.timestamp('source_verified_at', { useTz: true });
      t.string('status', 30).notNullable();
      t.string('version', 40).notNullable();
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      t.unique(['jurisdiction_id', 'version']);
    });
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  test('inserts once, updates idempotently and removes only its own version on down', async () => {
    await migration.up(knex);
    await migration.up(knex);
    const rows = await knex('jurisdiction_fertilizer_rules');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jurisdiction_id: 'north_port_fl',
      restricted_start_month: 4,
      restricted_end_month: 9,
      waterway_buffer_rule: expect.stringMatching(/25 ft buffer/),
    });

    await migration.down(knex);
    expect(await knex('jurisdiction_fertilizer_rules')).toEqual([]);
  });
});
