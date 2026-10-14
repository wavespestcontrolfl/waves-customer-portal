// Lawn protocol v13 SW Florida matrix adds (20261007180000) through PostgreSQL.
// The real earlier migrations stage a v13 protocol in an owned schema (cloned table definitions,
// no rows), then this migration runs over it. Synthetic data only. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const links = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds migration (20261007180000)', () => {
  let schema;
  let knex;
  const W = matrix.WINDOWS;

  const rowsIn = async (windowKey, protocolKey = 'swfl_st_augustine_10_10') => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': protocolKey, 'l.version': staged.V13_VERSION, 'w.window_key': windowKey })
    .orderBy('p.sort_order').select('p.*');
  const names = async (windowKey, key) => (await rowsIn(windowKey, key)).map((row) => row.product_name);
  const snapshot = async () => ({
    products: (await knex('lawn_protocol_products').select('id', 'product_id', 'product_name', 'gates', 'default_in_plan', 'rate_per_1000', 'rate_unit').orderBy('id')),
    windows: (await knex('lawn_protocol_windows').select('id', 'visit_type', 'production_mode', 'goal', 'required_tasks').orderBy('id')),
    catalog: (await knex('products_catalog').select('id', 'name', 'post_application_watering').orderBy('id')),
    aliases: (await knex('product_aliases').select('id', 'alias_name').orderBy('id')),
    audit: (await knex('lawn_protocol_audit_log').select('action').orderBy('action')).map((r) => r.action),
  });

  beforeAll(async () => {
    schema = `matrix_adds_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    // One active baseline per key, then the real staging chain.
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    // The Arena row prod has (EPA 59639-152), so 130000 leaves it alone.
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('up: catalog rows inserted only when missing, the Arena row renamed in place, aliases kept', async () => {
    const before = await snapshot();
    expect(before.catalog.find((row) => row.name === matrix.HEAD)).toBeUndefined();
    const arenaBefore = before.catalog.find((row) => row.name === matrix.ARENA_OLD);
    await matrix.up(knex);

    const catalog = await knex('products_catalog');
    const byName = Object.fromEntries(catalog.map((row) => [row.name, row]));
    expect(byName[matrix.HEAD]).toMatchObject({ category: 'fungicide', epa_reg_number: '100-1216', needs_pricing: true, siteone_sku: '26328' });
    expect(Number(byName[matrix.HEAD].default_rate_per_1000)).toBe(3);
    expect(byName[matrix.SOP]).toMatchObject({ category: 'fertilizer', formulation: 'granular' });
    expect([Number(byName[matrix.SOP].analysis_n), Number(byName[matrix.SOP].analysis_p), Number(byName[matrix.SOP].analysis_k)]).toEqual([0, 0, 50]);
    // No Advion label was read: no EPA number, no watering rule.
    expect(byName[matrix.ADVION].epa_reg_number).toBeNull();
    expect(byName[matrix.ADVION].post_application_watering).toBeNull();
    expect(byName[matrix.HEAD].post_application_watering).toMatchObject({ mode: 'hold', hold_until: 'dry' });
    expect(byName[matrix.SOP].post_application_watering).toMatchObject({ mode: 'water_in', water_in_inches: 0.25 });
    // Arena: same id, new name, old name and the SiteOne title as aliases.
    expect(byName[matrix.ARENA_OLD]).toBeUndefined();
    expect(byName[matrix.ARENA_NEW].id).toBe(arenaBefore.id);
    const aliases = (await knex('product_aliases').where({ product_id: arenaBefore.id })).map((row) => row.alias_name).sort();
    expect(aliases).toEqual([matrix.ARENA_OLD, 'Arena S.E. 50 WDG Insecticide 2.5 lb. (40 oz.) Jug (Florida Only)'].sort());
  });

  test('up: every staged protocol gets the same rows in the right months', async () => {
    for (const turf of staged.TRACKS) {
      const key = turf.key;
      expect(await names(W.MAR, key)).toEqual(expect.arrayContaining([staged.NAMES.VEL, staged.NAMES.GRA]));
      // April: the take-all Artavia row is the Headway row (same slot, new product id); no Artavia left.
      const aprilRows = await rowsIn(W.APR, key);
      const headway = aprilRows.find((row) => row.product_name === matrix.HEAD);
      expect(headway.product_id).toBe((await knex('products_catalog').where({ name: matrix.HEAD }).first('id')).id);
      expect(aprilRows.map((row) => row.product_name)).not.toContain(staged.NAMES.ART);
      expect(aprilRows.map((row) => row.product_name)).toContain(matrix.ARENA_NEW);
      expect(aprilRows.map((row) => row.product_name)).not.toContain(matrix.ARENA_OLD);
      expect(aprilRows.map((row) => row.product_name)).toContain(matrix.ADVION);
      // The Advion add-on is never a default and carries an explicit rate for the office's quantity.
      const advion = aprilRows.find((row) => row.product_name === matrix.ADVION);
      expect(advion.default_in_plan).toBe(false);
      expect(advion.gates).toMatchObject({ optionalAddOn: true, officePrices: true });
      // July: Talak trigger widened, Velista fairy ring, Artavia Pythium, and the 0-0-50 as the one default.
      const july = await rowsIn(W.JUL, key);
      expect(july.find((row) => row.product_name === staged.NAMES.TAL).gates).toMatchObject({ trigger: 'chinch_second_product_caterpillars_or_mole_cricket_nymphs', moleCricketWaterInInches: 0.5 });
      expect(july.map((row) => row.product_name)).toEqual(expect.arrayContaining([staged.NAMES.VEL, staged.NAMES.ART, matrix.SOP]));
      expect(july.filter((row) => row.default_in_plan).map((row) => row.product_name)).toEqual([matrix.SOP]);
      const sop = july.find((row) => row.product_name === matrix.SOP);
      expect([Number(sop.rate_per_1000), sop.rate_unit, sop.application_mode]).toEqual([1, 'lb', 'broadcast']);
      // August: Talak mole cricket nymphs (a new row).
      const aug = await rowsIn(W.AUG, key);
      expect(aug.find((row) => row.product_name === staged.NAMES.TAL).gates).toEqual({ trigger: 'mole_cricket_nymphs', moleCricketWaterInInches: 0.5 });
      // The Advion add-on is in October too (both spreader visits), not September (hose).
      expect(await names(W.OCT, key)).toContain(matrix.ADVION);
      expect(await names(W.SEP, key)).not.toContain(matrix.ADVION);
      // October: Artavia keeps large patch only, Headway takes the second fall take-all pass.
      const oct = await rowsIn(W.OCT, key);
      expect(oct.find((row) => row.product_name === staged.NAMES.ART).gates.trigger).toBe('mapped_large_patch_with_velista');
      expect(oct.find((row) => row.product_name === matrix.HEAD).gates.trigger).toBe('mapped_take_all_fall_2');
      expect(oct.filter((row) => row.product_name === staged.NAMES.VEL)).toHaveLength(1);
      // The July window is a spreader window now; its key and title are unchanged.
      const window = await knex('lawn_protocol_windows as w').join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
        .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': W.JUL }).first('w.*');
      expect([window.visit_type, window.production_mode]).toEqual([matrix.JULY_NEW.visit_type, matrix.JULY_NEW.production_mode]);
      expect(window.required_tasks).toEqual(matrix.JULY_NEW.required_tasks);
    }
  });

  test('one row per product per window (the plan reads rows by product id)', async () => {
    const dupes = await knex('lawn_protocol_products').select('lawn_protocol_window_id', 'product_id').count('* as n')
      .whereNotNull('product_id').groupBy('lawn_protocol_window_id', 'product_id').havingRaw('count(*) > 1');
    expect(dupes).toEqual([]);
  });

  test('a second up changes nothing', async () => {
    const before = await snapshot();
    await matrix.up(knex);
    expect(await snapshot()).toEqual(before);
  });

  test('down on an unreferenced stack restores every row, window, catalog row and alias', async () => {
    await matrix.down(knex);
    expect(await names(W.APR)).toContain(staged.NAMES.ART);
    expect(await names(W.APR)).toContain(matrix.ARENA_OLD);
    expect(await names(W.JUL)).not.toContain(matrix.SOP);
    expect((await rowsIn(W.OCT)).find((row) => row.product_name === staged.NAMES.ART).gates.trigger).toBe('mapped_large_patch_with_velista_and_take_all_fall_2');
    const julyTalak = (await rowsIn(W.JUL)).find((row) => row.product_name === staged.NAMES.TAL).gates;
    expect(julyTalak.trigger).toBe('chinch_second_product_or_caterpillars');
    expect(julyTalak.moleCricketWaterInInches).toBeUndefined();
    const window = await knex('lawn_protocol_windows').where({ window_key: W.JUL }).first();
    expect([window.visit_type, window.production_mode, window.goal]).toEqual([matrix.JULY_OLD.visit_type, matrix.JULY_OLD.production_mode, matrix.JULY_OLD.goal]);
    const catalog = (await knex('products_catalog').select('name')).map((row) => row.name);
    expect(catalog).toEqual(expect.arrayContaining([matrix.ARENA_OLD]));
    expect(catalog).not.toContain(matrix.HEAD);
    expect(catalog).not.toContain(matrix.SOP);
    expect(catalog).not.toContain(matrix.ADVION);
    expect(catalog).not.toContain(matrix.ARENA_NEW);
    expect((await knex('product_aliases').where({ alias_name: matrix.ARENA_OLD }))).toHaveLength(0);
    expect((await knex('lawn_protocol_audit_log').where({ action: matrix.ACTION }))).toHaveLength(0);
    expect((await knex('lawn_protocol_audit_log').where({ action: matrix.CATALOG_ACTION }))).toHaveLength(0);
  });

  test('up again after down matches the first up; a protocol a visit references is left alone on down', async () => {
    await matrix.up(knex);
    // Pin one key to v13: its rows stay, and so do the catalog rows.
    await knex.raw('ALTER TABLE ??.scheduled_services ALTER COLUMN customer_id DROP NOT NULL', [schema]);
    await knex('scheduled_services').insert({ lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
    await matrix.down(knex);
    expect(await names(W.JUL, 'swfl_zoysia_10_10')).toContain(matrix.SOP);
    expect(await names(W.JUL, 'swfl_st_augustine_10_10')).not.toContain(matrix.SOP);
    expect((await knex('products_catalog').where({ name: matrix.SOP }))).toHaveLength(1);
    expect((await knex('products_catalog').where({ name: matrix.ARENA_NEW }))).toHaveLength(1);
  });
});
