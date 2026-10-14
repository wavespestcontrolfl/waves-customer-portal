// Lawn protocol v13 matrix adds, Codex round 2 (20261007182000), through PostgreSQL.
// 180000 and 181000 are frozen (pushed); 182000 fixes their data. The real earlier migrations stage a v13
// protocol in an owned schema (cloned table definitions, no rows), then 180000, 181000 and 182000 run
// over it. Synthetic data only. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const links = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const fixes = require('../models/migrations/20261007181000_lawn_v13_matrix_adds_fixes');
const round2 = require('../models/migrations/20261007182000_lawn_v13_matrix_adds_round2');
const { fertilizerSafetyRules, FERTILIZER_SAFETY_RULES } = require('../services/lawn-fertilizer-safety');
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const W = matrix.WINDOWS;
const N = staged.NAMES;

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds round 2 (20261007182000): staged rows, limits and rollback', () => {
  let schema;
  let knex;

  const rowsIn = async (windowKey, protocolKey = 'swfl_st_augustine_10_10') => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': protocolKey, 'l.version': staged.V13_VERSION, 'w.window_key': windowKey })
    .orderBy('p.sort_order').select('p.*');
  const rowOf = async (windowKey, name, key) => (await rowsIn(windowKey, key)).find((row) => row.product_name === name);
  const limitRows = async () => knex('product_limits').whereIn('product_id', knex('products_catalog').where({ name: matrix.ADVION }).select('id')).orderBy('limit_type');
  const everything = async () => ({
    products: await knex('lawn_protocol_products').select('id', 'product_id', 'product_name', 'rate_per_1000', 'rate_unit', 'gates').orderBy('id'),
    limits: await knex('product_limits').select('product_id', 'limit_type', 'limit_value', 'severity').orderBy('limit_type'),
    audit: (await knex('lawn_protocol_audit_log').select('action').orderBy('action')).map((r) => r.action),
  });

  beforeAll(async () => {
    schema = `matrix_round2_${randomUUID().replace(/-/g, '')}`;
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

  test('before: the folded uses are missing from the old triggers, the July potash row has no safety gate, Advion has no limits', async () => {
    for (const [windowKey, product, oldTrigger] of round2.TRIGGERS) {
      expect({ windowKey, trigger: (await rowOf(windowKey, product)).gates.trigger }).toEqual({ windowKey, trigger: oldTrigger });
    }
    expect((await rowOf(W.JUL, matrix.SOP)).gates.fertilizerSafety).toBeUndefined();
    expect(await limitRows()).toEqual([]);
  });

  test('up: the triggers list every use the recipe line now names, on every track', async () => {
    await round2.up(knex);
    for (const turf of staged.TRACKS) {
      for (const [windowKey, product, , newTrigger] of round2.TRIGGERS) {
        expect({ windowKey, trigger: (await rowOf(windowKey, product, turf.key)).gates.trigger }).toEqual({ windowKey, trigger: newTrigger });
        expect(newTrigger.length).toBeLessThanOrEqual(120);
      }
    }
    // The October Velista and the Sep/Jun/Aug Artavia names read the new uses.
    expect((await rowOf(W.OCT, N.VEL)).gates.trigger).toMatch(/fairy_ring.*dollar_spot.*rust.*leaf_spot/);
    for (const windowKey of [W.JUN, W.AUG, W.SEP]) expect((await rowOf(windowKey, N.ART)).gates.trigger).toMatch(/pythium_root_rot$/);
    // Nothing else on the rows changed.
    expect((await rowOf(W.OCT, N.VEL)).application_mode).toBe('spot');
  });

  test('up: the July 0-0-50 rows carry fertilizerSafety, so the job card and the SOP print the safety block for July', async () => {
    for (const turf of staged.TRACKS) {
      const july = await rowsIn(W.JUL, turf.key);
      expect((await rowOf(W.JUL, matrix.SOP, turf.key)).gates).toMatchObject({ fertilizerSafety: true, targetK2O: '0.5 lb K2O/1000' });
      expect(fertilizerSafetyRules(july)).toEqual(FERTILIZER_SAFETY_RULES);
      // A hose window with no gated row prints nothing.
      expect(fertilizerSafetyRules(await rowsIn(W.AUG, turf.key))).toEqual([]);
    }
  });

  test('up: Advion has the two label limits as hard blocks, written once', async () => {
    const advion = await knex('products_catalog').where({ name: matrix.ADVION }).first('id');
    const limits = await limitRows();
    expect(limits.map((row) => [row.product_id, row.limit_type, Number(row.limit_value), row.limit_unit, row.severity])).toEqual([
      [advion.id, 'annual_max_apps', 4, 'applications', 'hard_block'],
      [advion.id, 'min_interval_days', 84, 'days', 'hard_block'],
    ]);
  });

  test('a second up changes nothing', async () => {
    const before = await everything();
    await round2.up(knex);
    expect(await everything()).toEqual(before);
  });

  test('an Advion limit an admin already set is never changed', async () => {
    const advion = await knex('products_catalog').where({ name: matrix.ADVION }).first('id');
    await knex('product_limits').where({ product_id: advion.id, limit_type: 'annual_max_apps' }).update({ limit_value: 3, severity: 'warning' });
    await round2.down(knex);
    // The admin's edited row no longer equals what was written: it stays; the untouched one goes.
    expect((await limitRows()).map((row) => [row.limit_type, Number(row.limit_value), row.severity])).toEqual([['annual_max_apps', 3, 'warning']]);
    await knex('product_limits').where({ product_id: advion.id }).del();
    await round2.up(knex);
    expect(await limitRows()).toHaveLength(2);
  });

  test('down puts every gate and limit back; a referenced protocol keeps its rows and 181000 will not revert it', async () => {
    // A visit pins one key: its rows stay, the others revert, and 181000's down has nothing to do.
    await knex.raw('ALTER TABLE ??.scheduled_services ALTER COLUMN customer_id DROP NOT NULL', [schema]);
    await knex('scheduled_services').insert({ lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
    await round2.down(knex);
    expect((await rowOf(W.JUL, matrix.SOP, 'swfl_zoysia_10_10')).gates.fertilizerSafety).toBe(true);
    expect((await rowOf(W.OCT, N.VEL, 'swfl_zoysia_10_10')).gates.trigger).toBe(round2.TRIGGERS[0][3]);
    expect((await rowOf(W.OCT, N.VEL, 'swfl_st_augustine_10_10')).gates.trigger).toBe(round2.TRIGGERS[0][2]);
    expect((await rowOf(W.JUL, matrix.SOP, 'swfl_st_augustine_10_10')).gates.fertilizerSafety).toBeUndefined();
    expect(await limitRows()).toHaveLength(2);
    // 181000's audit rows are neutralized: its down reverts nothing.
    const log = await knex('lawn_protocol_audit_log').where({ action: fixes.ACTION }).first();
    const after = typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot;
    expect([after.arena, after.headway, after.advion]).toEqual([null, [], null]);
    expect(after.keptLive.arena.before).toBe(matrix.ARENA_NEW);
    await fixes.down(knex);
    expect((await knex('products_catalog').where({ name: matrix.ARENA_OLD }).first('id'))).toBeDefined();
    expect((await rowOf(W.APR, matrix.HEAD, 'swfl_zoysia_10_10')).rate_per_1000).not.toBeNull();
    expect((await knex('products_catalog').where({ name: matrix.ADVION }).first('epa_reg_number')).epa_reg_number).toBe('100-1481');
  });

  test('with no live protocol, down reverts everything it wrote', async () => {
    await knex('scheduled_services').del();
    await round2.up(knex);
    await round2.down(knex);
    for (const turf of staged.TRACKS) {
      expect((await rowOf(W.OCT, N.VEL, turf.key)).gates.trigger).toBe(round2.TRIGGERS[0][2]);
      expect((await rowOf(W.JUL, matrix.SOP, turf.key)).gates.fertilizerSafety).toBeUndefined();
    }
    expect(await limitRows()).toEqual([]);
    expect(await knex('lawn_protocol_audit_log').where({ action: round2.ACTION })).toHaveLength(0);
  });
});

describeDb('Advion limits through the plan\'s limit reader (20261007182000)', () => {
  const GATE = process.env.GATE_LAWN_V13;
  let owned;
  let knex;
  let advion;
  let customerId;

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of ['products_catalog', 'product_limits', 'property_application_history']) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
      const columns = await knex(table).columnInfo();
      if (String(columns.id?.defaultValue || '').includes('nextval(')) {
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id DROP DEFAULT', [owned.schema, table]);
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY', [owned.schema, table]);
      }
    }
    [advion] = await knex('products_catalog').insert({ name: matrix.ADVION, category: 'insecticide', active: true, rate_unit: 'lb', default_rate_per_1000: 0.034 }).returning('*');
    for (const spec of round2.ADVION_LIMITS) await knex('product_limits').insert({ product_id: advion.id, match_type: 'product', ...spec });
    ({ customerId } = await fixture(knex));
    process.env.GATE_LAWN_V13 = 'true';
  }, 60000);
  afterAll(async () => {
    if (GATE === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = GATE;
    if (owned) await owned.dispose();
  });

  const applied = (date) => knex('property_application_history').insert({
    customer_id: customerId, product_id: advion.id, application_date: date, application_rate: 0.034, rate_unit: 'lb', active_ingredient: 'Indoxacarb',
  });
  // The plan's own limit reader for one selected line of a booked visit.
  const planBlocks = async (date) => {
    const service = { id: randomUUID(), customer_id: customerId, property_id: null, scheduled_date: date };
    const found = await engine.v13VisitLimits(knex, service, [{ selected: true, product: { id: advion.id, name: matrix.ADVION } }], new Map());
    return found.capped.get(String(advion.id)) || [];
  };

  test('no earlier application: no block', async () => {
    expect(await planBlocks('2026-04-15')).toEqual([]);
  });

  test('a second application inside 84 days is blocked, on day 84 it is not', async () => {
    await applied('2026-04-15');
    const blocks = await planBlocks('2026-07-01'); // 77 days
    expect(blocks.map((block) => block.type)).toEqual(['min_interval_days']);
    expect(blocks[0].productName).toBe(matrix.ADVION);
    expect(await planBlocks('2026-07-08')).toEqual([]); // 84 days
  });

  test('a fifth application in a year is blocked', async () => {
    await applied('2026-07-08');
    await applied('2026-10-01');
    await applied('2026-12-30');
    // Four this year (04-15, 07-08, 10-01, 12-30); a fifth is the annual block, past the interval too.
    const fifth = await planBlocks('2026-12-31');
    expect(fifth.map((block) => block.type).sort()).toEqual(['annual_max_apps', 'min_interval_days']);
    // Three applications earlier in the year and a fourth that respects the interval: allowed.
    await knex('property_application_history').where({ application_date: '2026-12-30' }).del();
    expect(await planBlocks('2026-12-31')).toEqual([]);
  });
});
