// Lawn protocol v13 matrix adds, Codex round 3 (20261007183000), through PostgreSQL.
// 180000, 181000 and 182000 are frozen (pushed); 183000 fixes their data. The real earlier migrations stage
// a v13 protocol in an owned schema (cloned table definitions, no rows) over a prod-like catalog (a Headway
// Fungicide row that already exists with a rate and no group), then 183000 runs over it.
// Synthetic data only. Self-skips without DATABASE_URL.
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
const { productGroups } = require('../services/waveguard-approval-engine');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const W = matrix.WINDOWS;
const TAL = staged.NAMES.TAL;

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds round 3 (20261007183000)', () => {
  let schema;
  let knex;

  const rowOf = async (windowKey, name, key = 'swfl_st_augustine_10_10') => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': windowKey, 'p.product_name': name })
    .first('p.*');
  const headway = () => knex('products_catalog').where({ name: matrix.HEAD }).first();
  const advionLimits = () => knex('product_limits').whereIn('product_id', knex('products_catalog').where({ name: matrix.ADVION }).select('id')).orderBy('limit_type');
  const snapshot = async () => ({
    products: await knex('lawn_protocol_products').select('id', 'rate_per_1000', 'rate_unit', 'gates').orderBy('id'),
    headway: await headway(),
    audit: (await knex('lawn_protocol_audit_log').select('action').orderBy('action')).map((row) => row.action),
  });

  beforeAll(async () => {
    schema = `matrix_round3_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    // The Headway row prod already has: a rate and a unit, no group.
    await knex('products_catalog').insert({ name: matrix.HEAD, category: 'fungicide', active: true, container_size: '1 gal', default_rate_per_1000: 1.5, rate_unit: 'fl_oz' });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
    await matrix.up(knex);
    await fixes.up(knex);
    await round2.up(knex);
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('before: the Talak rows carry the water-in gate and no rate; Headway has no group', async () => {
    for (const windowKey of [W.JUL, W.AUG]) {
      const row = await rowOf(windowKey, TAL);
      expect(row.gates.moleCricketWaterInInches).toBe(0.5);
      expect([row.rate_per_1000, row.rate_unit, row.application_mode]).toEqual([null, 'label_rate', 'spot']);
    }
    expect((await headway()).frac_group).toBeNull();
    expect(productGroups(await headway())).toEqual([]);
  });

  test('up: the gate is gone, the 1.0 fl oz reference rate is stored, the rows stay spot rows with their triggers', async () => {
    await round3.up(knex);
    for (const turf of staged.TRACKS) {
      for (const windowKey of [W.JUL, W.AUG]) {
        const row = await rowOf(windowKey, TAL, turf.key);
        expect(row.gates.moleCricketWaterInInches).toBeUndefined();
        expect(row.gates.trigger).toMatch(/mole_cricket_nymphs/);
        expect([Number(row.rate_per_1000), row.rate_unit, row.application_mode, row.default_in_plan]).toEqual([1, 'fl oz', 'spot', false]);
      }
    }
  });

  test('up: the Headway catalog row gets the group and keeps the rate and unit it already had', async () => {
    const row = await headway();
    expect(row.frac_group).toBe('3 + 11');
    expect([Number(row.default_rate_per_1000), row.rate_unit]).toEqual([1.5, 'fl_oz']);
    // The rotation reader sees groups 3 and 11 for this row.
    // (The composite reading is the v13 program's: GATE_LAWN_V13 on, read at call time.)
    const saved = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    try {
      expect(productGroups(row)).toEqual([['frac', '3'], ['frac', '11']]);
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });

  test('a second up changes nothing', async () => {
    const before = await snapshot();
    await round3.up(knex);
    expect(await snapshot()).toEqual(before);
  });

  test('a Talak rate an admin set is never overwritten; down keeps it and puts the gate back', async () => {
    await knex('lawn_protocol_products').where({ id: (await rowOf(W.AUG, TAL)).id }).update({ rate_per_1000: 0.75 });
    await round3.down(knex);
    const aug = await rowOf(W.AUG, TAL);
    expect(Number(aug.rate_per_1000)).toBe(0.75);
    expect(aug.gates.moleCricketWaterInInches).toBe(0.5);
    const july = await rowOf(W.JUL, TAL);
    expect([july.rate_per_1000, july.rate_unit]).toEqual([null, 'label_rate']);
    expect(july.gates.moleCricketWaterInInches).toBe(0.5);
    expect((await headway()).frac_group).toBeNull();
    expect(await knex('lawn_protocol_audit_log').where({ action: round3.ACTION })).toHaveLength(0);
    await knex('lawn_protocol_products').where({ id: aug.id }).update({ rate_per_1000: null });
  });

  test('a Headway row with no rate and no unit gets the take-all rate; a stored value is never overwritten', async () => {
    await knex('products_catalog').where({ name: matrix.HEAD }).update({ default_rate_per_1000: null, rate_unit: null });
    await round3.up(knex);
    const row = await headway();
    expect([row.frac_group, Number(row.default_rate_per_1000), row.rate_unit]).toEqual(['3 + 11', 3, 'fl oz']);
    // A row with a group already (an admin\'s) keeps it.
    await round3.down(knex);
    await knex('products_catalog').where({ name: matrix.HEAD }).update({ frac_group: '11', default_rate_per_1000: 2, rate_unit: 'fl oz' });
    await round3.up(knex);
    const kept = await headway();
    expect([kept.frac_group, Number(kept.default_rate_per_1000), kept.rate_unit]).toEqual(['11', 2, 'fl oz']);
    await round3.down(knex);
    expect((await headway()).frac_group).toBe('11');
  });

  test('down with a missing Advion limit row: 182000\'s audit entry for it is dropped, and 182000\'s down skips it without error', async () => {
    await knex('products_catalog').where({ name: matrix.HEAD }).update({ frac_group: null });
    await round3.up(knex);
    const [first] = await advionLimits();
    await knex('product_limits').where({ id: first.id }).del();
    await round3.down(knex);
    const [log] = await knex('lawn_protocol_audit_log').where({ action: round2.CATALOG_ACTION });
    const after = typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot;
    expect(after.limits.map((row) => row.id)).not.toContain(first.id);
    expect(after.absent.map((row) => row.id)).toEqual([first.id]);
    await expect(round2.down(knex)).resolves.toBeUndefined();
    expect(await advionLimits()).toEqual([]);
  });
});
