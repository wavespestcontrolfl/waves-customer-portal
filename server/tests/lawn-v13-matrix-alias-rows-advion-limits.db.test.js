// Lawn protocol v13 matrix adds: alias-resolved catalog rows and the Advion limits (20261007189500), through PostgreSQL.
// The real earlier migrations stage a v13 protocol in an owned schema (cloned table definitions, no rows), then
// 180000 to 189000 run, then 189500 (and its rollback guard, 189600). Synthetic data only. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const links = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const fixes = require('../models/migrations/20261007181000_lawn_v13_matrix_adds_fixes');
const round2 = require('../models/migrations/20261007182000_lawn_v13_matrix_adds_round2');
const round3 = require('../models/migrations/20261007183000_lawn_v13_matrix_adds_round3');
const round4 = require('../models/migrations/20261007184000_lawn_v13_matrix_adds_round4');
const round5 = require('../models/migrations/20261007185000_lawn_v13_matrix_adds_round5');
const round6 = require('../models/migrations/20261007186000_lawn_v13_matrix_adds_round6');
const round7 = require('../models/migrations/20261007187000_lawn_v13_matrix_adds_round7');
const round11 = require('../models/migrations/20261007188000_lawn_v13_matrix_adds_round11');
const remove = require('../models/migrations/20261007189000_lawn_v13_matrix_remove_july_potash');
const aliasRows = require('../models/migrations/20261007189500_lawn_v13_matrix_alias_rows_and_advion_limits');
const aliasGuard = require('../models/migrations/20261007189600_lawn_v13_matrix_alias_rows_rollback_guard');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const CHAIN = [matrix, fixes, round2, round3, round4, round5, round6, round7, round11, remove];
const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];
// Catalog rows that carry the canonical name only as an alias (the names are synthetic).
const HEADWAY_ROW = 'Headway Broad Spectrum 1 gal';
const ADVION_ROW = 'Advion Fire Ant 25 lb';
jest.spyOn(console, 'log').mockImplementation(() => {});

describeDb('v13 matrix: alias-resolved catalog rows and Advion limits (20261007189500)', () => {
  let schema;
  let knex;

  async function build({ aliasOnly = false, legacyLimits = [] } = {}) {
    schema = `matrix_alias_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    await knex.raw('ALTER TABLE ??.scheduled_services ALTER COLUMN customer_id DROP NOT NULL', [schema]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
    if (aliasOnly) {
      for (const [name, alias, category] of [[HEADWAY_ROW, matrix.HEAD, 'fungicide'], [ADVION_ROW, matrix.ADVION, 'insecticide']]) {
        const [row] = await knex('products_catalog').insert({ name, category, active: true }).returning('id');
        await knex('product_aliases').insert({ product_id: row.id, alias_name: alias });
      }
    }
    for (const limit of legacyLimits) {
      const product = await knex('products_catalog').where({ name: ADVION_ROW }).first('id');
      await knex('product_limits').insert({ product_id: product.id, ...limit });
    }
    for (const migration of CHAIN) await migration.up(knex);
  }
  const drop = async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); knex = null; } };
  const catalog = (name) => knex('products_catalog').where({ name }).first();
  const limits = async (name) => {
    const product = await catalog(name);
    return (await knex('product_limits').where({ product_id: product.id }).orderBy('limit_type'))
      .map((row) => ({ type: row.limit_type, value: Number(row.limit_value), unit: row.limit_unit, severity: row.severity, match: row.match_type }));
  };
  const everything = async () => ({
    catalog: (await knex('products_catalog').orderBy('name')).map(({ id, created_at, updated_at, ...row }) => row),
    limits: (await knex('product_limits').orderBy(['product_id', 'limit_type'])).map(({ created_at, updated_at, ...row }) => row),
    products: (await knex('lawn_protocol_products').orderBy('id')).map(({ updated_at, ...row }) => row),
  });
  const LABEL_LIMITS = [
    { type: 'annual_max_apps', value: 4, unit: 'applications', severity: 'hard_block', match: 'product' },
    { type: 'min_interval_days', value: 84, unit: 'days', severity: 'hard_block', match: 'product' },
  ];

  describe('catalog rows that carry the canonical name only as an alias, with weaker legacy Advion limits', () => {
    let before;
    beforeAll(async () => {
      await build({
        aliasOnly: true,
        legacyLimits: [
          { match_type: 'product', limit_type: 'min_interval_days', limit_value: 30, limit_unit: 'days', severity: 'warning', description: 'legacy' },
          { match_type: 'product', limit_type: 'annual_max_apps', limit_value: 6, limit_unit: 'applications', severity: 'hard_block', description: 'legacy' },
        ],
      });
      before = await everything();
    }, 120000);
    afterAll(drop);

    test('before: the chain made no canonical rows, left the alias rows without their facts and kept the weaker limits', async () => {
      expect(await catalog(matrix.HEAD)).toBeUndefined();
      expect(await catalog(matrix.ADVION)).toBeUndefined();
      expect((await catalog(HEADWAY_ROW)).frac_group).toBeNull();
      expect((await catalog(ADVION_ROW)).epa_reg_number).toBeNull();
      expect(await limits(ADVION_ROW)).toEqual([
        { type: 'annual_max_apps', value: 6, unit: 'applications', severity: 'hard_block', match: 'product' },
        { type: 'min_interval_days', value: 30, unit: 'days', severity: 'warning', match: 'product' },
      ]);
    });

    test('up: the Headway row gets its FRAC group, rate, EPA number, watering rule and report text, and is approved', async () => {
      await aliasRows.up(knex);
      const row = await catalog(HEADWAY_ROW);
      expect(row).toMatchObject({ frac_group: '3 + 11', rate_unit: 'fl oz', epa_reg_number: '100-1216', product_type: 'pesticide', approved_for_service_report: true });
      expect(Number(row.default_rate_per_1000)).toBe(3);
      expect(row.post_application_watering).toMatchObject({ mode: 'hold', hold_until: 'dry' });
      expect(row.service_report_summary).toMatch(/Headway was applied/);
    });

    test('up: the Advion row gets its EPA number, label rates, watering rule and report text, and is approved', async () => {
      const row = await catalog(ADVION_ROW);
      expect(row).toMatchObject({ epa_reg_number: '100-1481', product_type: 'pesticide', approved_for_service_report: true });
      expect(Number(row.max_label_rate_per_1000)).toBeCloseTo(0.0344, 4);
      expect(Number(row.max_annual_per_1000)).toBeCloseTo(0.1377, 4);
      expect(row.post_application_watering).toMatchObject({ mode: 'hold', hold_hours: 3 });
      expect(row.service_report_summary).toMatch(/Advion Fire Ant Bait was applied/);
    });

    test('up: the weaker Advion limits become the label limits, with no second row of a type', async () => {
      expect(await limits(ADVION_ROW)).toEqual(LABEL_LIMITS);
    });

    test('a second up changes nothing', async () => {
      const once = await everything();
      await aliasRows.up(knex);
      expect(await everything()).toEqual(once);
      expect(await knex('lawn_protocol_audit_log').where({ action: aliasRows.ACTION })).toHaveLength(1);
    });

    test('down restores the rows and the legacy limits; a field edited after up is kept', async () => {
      await knex('products_catalog').where({ name: HEADWAY_ROW }).update({ frac_group: '11' });
      await aliasRows.down(knex);
      const after = await everything();
      const headway = (rows) => rows.find((row) => row.name === HEADWAY_ROW);
      expect(headway(after.catalog).frac_group).toBe('11');
      headway(after.catalog).frac_group = null;
      expect(after).toEqual(before);
      expect(await knex('lawn_protocol_audit_log').where({ action: aliasRows.ACTION })).toHaveLength(0);
    });
  });

  describe('a rollback while a visit references v13', () => {
    const LEGACY = [
      { match_type: 'product', limit_type: 'min_interval_days', limit_value: 30, limit_unit: 'days', severity: 'warning', description: 'legacy' },
      { match_type: 'product', limit_type: 'annual_max_apps', limit_value: 6, limit_unit: 'applications', severity: 'hard_block', description: 'legacy' },
    ];
    beforeAll(async () => {
      await build({ aliasOnly: true, legacyLimits: LEGACY });
      await aliasRows.up(knex);
      await aliasGuard.up(knex);
      await knex('scheduled_services').insert({ lawn_protocol_key: staged.TRACKS[0].key, lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
    }, 120000);
    afterAll(drop);

    test('the whole chain rolled back keeps the alias rows facts, their approval and the label limits', async () => {
      const live = await everything();
      for (const migration of [aliasGuard, aliasRows, ...[...CHAIN].reverse()]) await migration.down(knex);
      const after = await everything();
      expect(after.limits).toEqual(live.limits);
      expect(await limits(ADVION_ROW)).toEqual(LABEL_LIMITS);
      for (const name of [HEADWAY_ROW, ADVION_ROW]) {
        expect(after.catalog.find((row) => row.name === name)).toEqual(live.catalog.find((row) => row.name === name));
      }
      expect((await catalog(HEADWAY_ROW)).approved_for_service_report).toBe(true);
    });
  });

  describe('a row with stricter values is left alone', () => {
    beforeAll(async () => {
      await build({
        aliasOnly: true,
        legacyLimits: [
          { match_type: 'product', limit_type: 'min_interval_days', limit_value: 120, limit_unit: 'days', severity: 'hard_block', description: 'stricter' },
        ],
      });
    }, 120000);
    afterAll(drop);

    test('up keeps the 120-day interval and adds the missing yearly count', async () => {
      await aliasRows.up(knex);
      expect(await limits(ADVION_ROW)).toEqual([LABEL_LIMITS[0], { ...LABEL_LIMITS[1], value: 120 }]);
    });
  });

  describe('the chain that inserted its own canonical rows', () => {
    beforeAll(async () => { await build(); }, 120000);
    afterAll(drop);

    test('up changes no limit and takes no fact away; the rows stay approved with the label limits', async () => {
      const before = await everything();
      await aliasRows.up(knex);
      const after = await everything();
      expect(after.limits).toEqual(before.limits);
      expect(after.products).toEqual(before.products);
      expect(await limits(matrix.ADVION)).toEqual(LABEL_LIMITS);
      for (const name of [matrix.HEAD, matrix.ADVION]) {
        const was = before.catalog.find((row) => row.name === name);
        const now = after.catalog.find((row) => row.name === name);
        for (const [column, value] of Object.entries(was)) if (value != null) expect(now[column]).toEqual(value);
        expect(now.approved_for_service_report).toBe(true);
      }
    });
  });
});
