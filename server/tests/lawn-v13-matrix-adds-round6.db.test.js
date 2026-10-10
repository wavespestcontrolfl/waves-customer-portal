// Lawn protocol v13 matrix adds, Codex round 6 (20261007186000), through PostgreSQL: the Advion label rate.
// 180000 to 185000 are frozen (pushed); 186000 fixes their data. Synthetic data only. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const links = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const fixes = require('../models/migrations/20261007181000_lawn_v13_matrix_adds_fixes');
const round6 = require('../models/migrations/20261007186000_lawn_v13_matrix_adds_round6');
const v13 = require('../config/lawn-protocol-v13.json');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describe('the Advion rate: the staged rows and the catalog carry the verified label figure (the recipe no longer names Advion)', () => {
  test('0.0344 lb per 1,000 sq ft (1.5 lb per acre / 43,560 sq ft x 1,000), and the recipe holds no Advion line since 20261009100000', () => {
    expect(Math.round((1.5 / 43.56) * 10000) / 10000).toBe(0.0344);
    expect(round6.NEW_RATE).toBe(0.0344);
    expect(JSON.stringify(v13)).not.toMatch(/Advion|0\.034 lb/);
  });
});

describeDb('v13 matrix adds round 6 (20261007186000)', () => {
  let schema;
  let knex;
  const rates = async () => (await knex('lawn_protocol_products').where({ product_name: matrix.ADVION }).select('rate_per_1000')).map((row) => Number(row.rate_per_1000));

  beforeAll(async () => {
    schema = `matrix_round6_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
    await matrix.up(knex);
    await fixes.up(knex);
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('before: both staged Advion rows on every track and the catalog default hold 0.034', async () => {
    expect(await rates()).toEqual(Array(staged.TRACKS.length * 2).fill(0.034));
    expect(Number((await knex('products_catalog').where({ name: matrix.ADVION }).first()).default_rate_per_1000)).toBe(0.034);
  });

  test('up: the rows and the catalog default carry 0.0344; a rate an admin set is never overwritten; a second up changes nothing', async () => {
    const [first] = await knex('lawn_protocol_products').where({ product_name: matrix.ADVION }).select('id').limit(1);
    await knex('lawn_protocol_products').where({ id: first.id }).update({ rate_per_1000: 0.05 });
    await round6.up(knex);
    const after = await rates();
    expect(after.filter((rate) => rate === 0.0344)).toHaveLength(staged.TRACKS.length * 2 - 1);
    expect(after).toContain(0.05);
    expect(Number((await knex('products_catalog').where({ name: matrix.ADVION }).first()).default_rate_per_1000)).toBe(0.0344);
    const snapshot = await knex('lawn_protocol_products').select('id', 'rate_per_1000').orderBy('id');
    await round6.up(knex);
    expect(await knex('lawn_protocol_products').select('id', 'rate_per_1000').orderBy('id')).toEqual(snapshot);
  });

  test('down puts back only what it wrote', async () => {
    await round6.down(knex);
    const after = await rates();
    expect(after.filter((rate) => rate === 0.034)).toHaveLength(staged.TRACKS.length * 2 - 1);
    expect(after).toContain(0.05);
    expect(Number((await knex('products_catalog').where({ name: matrix.ADVION }).first()).default_rate_per_1000)).toBe(0.034);
    expect(await knex('lawn_protocol_audit_log').whereIn('action', [round6.ACTION, round6.CATALOG_ACTION])).toHaveLength(0);
  });
});
