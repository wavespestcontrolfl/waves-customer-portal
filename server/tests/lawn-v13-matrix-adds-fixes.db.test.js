// Lawn protocol v13 matrix adds, Codex round 1 corrections (20261007181000), through PostgreSQL.
// 180000 is frozen (pushed); 181000 fixes its data. The real earlier migrations stage a v13 protocol in
// an owned schema (cloned table definitions, no rows), then 180000 and 181000 run over it.
// Synthetic data only. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const links = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const fixes = require('../models/migrations/20261007181000_lawn_v13_matrix_adds_fixes');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds fixes (20261007181000)', () => {
  let schema;
  let knex;
  let arenaId;
  const W = matrix.WINDOWS;

  const rowsIn = async (windowKey, protocolKey = 'swfl_st_augustine_10_10') => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': protocolKey, 'l.version': staged.V13_VERSION, 'w.window_key': windowKey })
    .orderBy('p.sort_order').select('p.*');
  const catalog = async (name) => knex('products_catalog').where({ name }).first();
  const aliases = async (productId) => (await knex('product_aliases').where({ product_id: productId })).map((row) => row.alias_name).sort();
  const everything = async () => ({
    products: await knex('lawn_protocol_products').select('id', 'product_id', 'product_name', 'rate_per_1000', 'rate_unit', 'gates').orderBy('id'),
    catalog: await knex('products_catalog').select('id', 'name', 'epa_reg_number', 'max_label_rate_per_1000', 'max_annual_per_1000', 'label_source_note', 'post_application_watering').orderBy('id'),
    aliases: await knex('product_aliases').select('product_id', 'alias_name').orderBy('alias_name'),
    audit: (await knex('lawn_protocol_audit_log').select('action', 'after_snapshot').orderBy('action')).map((r) => r.action),
  });

  beforeAll(async () => {
    schema = `matrix_fixes_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    // The Arena row prod has (EPA 59639-152).
    [{ id: arenaId }] = await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true }).returning('id');
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
    await matrix.up(knex);
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('before the fixes 180000 left the S.E. name, rate-less Headway rows and an Advion row without an EPA number', async () => {
    expect((await catalog(matrix.ARENA_NEW)).id).toBe(arenaId);
    expect(await catalog(matrix.ARENA_OLD)).toBeUndefined();
    const headway = (await rowsIn(W.APR)).find((row) => row.product_name === matrix.HEAD);
    expect([headway.rate_per_1000, headway.rate_unit]).toEqual([null, 'label_rate']);
    expect((await catalog(matrix.ADVION)).epa_reg_number).toBeNull();
  });

  test('up: Arena is "Arena 50 WDG" again (same id), the S.E. name is an alias, the staged rows follow', async () => {
    await fixes.up(knex);
    const arena = await catalog(matrix.ARENA_OLD);
    expect(arena.id).toBe(arenaId);
    expect(await catalog(matrix.ARENA_NEW)).toBeUndefined();
    const names = await aliases(arenaId);
    expect(names).toContain(matrix.ARENA_NEW);
    expect(names).toContain('Arena S.E. 50 WDG Insecticide 2.5 lb. (40 oz.) Jug (Florida Only)');
    expect(names).not.toContain(matrix.ARENA_OLD);
    for (const turf of staged.TRACKS) {
      for (const windowKey of [W.APR, W.MAY, W.JUN]) {
        const arenaRows = (await rowsIn(windowKey, turf.key)).filter((row) => String(row.product_id) === String(arenaId));
        expect(arenaRows.map((row) => row.product_name)).toEqual([matrix.ARENA_OLD]);
      }
    }
    // Name-keyed history (the rotation join service_products.product_name = products_catalog.name) sees "Arena 50 WDG" again.
    const joined = await knex('products_catalog as pc').whereRaw('pc.name = ?', [matrix.ARENA_OLD]).select('pc.id');
    expect(joined.map((row) => row.id)).toEqual([arenaId]);
    // The alias path also resolves the new name to the same product.
    const viaAlias = await knex('product_aliases').where({ alias_name: matrix.ARENA_NEW }).first('product_id');
    expect(viaAlias.product_id).toBe(arenaId);
  });

  test('up: the April and October Headway rows carry the label rate, as reference only', async () => {
    for (const turf of staged.TRACKS) {
      for (const windowKey of [W.APR, W.OCT]) {
        const row = (await rowsIn(windowKey, turf.key)).find((made) => made.product_name === matrix.HEAD);
        expect([Number(row.rate_per_1000), row.rate_unit, row.application_mode, row.default_in_plan]).toEqual([3, 'fl oz', 'spot', false]);
      }
    }
  });

  test('up: Advion is verified from the label (EPA 100-1481): EPA number, label rates, note and a watering rule', async () => {
    const advion = await catalog(matrix.ADVION);
    expect(advion.epa_reg_number).toBe('100-1481');
    expect(Number(advion.max_label_rate_per_1000)).toBe(0.0344);
    expect(Number(advion.max_annual_per_1000)).toBe(0.1377);
    expect(advion.label_source_note).toMatch(/EPA Reg\. No\. 100-1481, accepted 2018-12-19/);
    expect(advion.post_application_watering).toMatchObject({ mode: 'hold', hold_hours: 3, source: 'label' });
    // 1.5 lb per acre and 6 lb per acre a year, per 1,000 sq ft.
    expect(Math.round((1.5 / 43.56) * 10000) / 10000).toBe(0.0344);
    expect(Math.round((6 / 43.56) * 10000) / 10000).toBe(0.1377);
  });

  test('up: 180000\'s catalog audit no longer lists a row for deletion on rollback', async () => {
    const [log] = await knex('lawn_protocol_audit_log').where({ action: matrix.CATALOG_ACTION });
    const after = typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot;
    expect(after.products).toEqual([]);
    expect(after.keptProducts.map((row) => row.name).sort()).toEqual([matrix.ADVION, matrix.HEAD, matrix.SOP].sort());
  });

  test('a second up changes nothing', async () => {
    const before = await everything();
    await fixes.up(knex);
    expect(await everything()).toEqual(before);
  });

  test('down puts back what 180000 left, and rolling back past 180000 keeps the catalog rows', async () => {
    await fixes.down(knex);
    expect((await catalog(matrix.ARENA_NEW)).id).toBe(arenaId);
    expect(await catalog(matrix.ARENA_OLD)).toBeUndefined();
    expect(await aliases(arenaId)).toContain(matrix.ARENA_OLD);
    expect(await aliases(arenaId)).not.toContain(matrix.ARENA_NEW);
    const headway = (await rowsIn(W.OCT)).find((row) => row.product_name === matrix.HEAD);
    expect([headway.rate_per_1000, headway.rate_unit]).toEqual([null, 'label_rate']);
    expect((await catalog(matrix.ADVION)).epa_reg_number).toBeNull();
    expect((await catalog(matrix.ADVION)).post_application_watering).toBeNull();
    expect(await knex('lawn_protocol_audit_log').where({ action: fixes.ACTION })).toHaveLength(0);

    // Up never overwrites what an admin set: an existing EPA number, a stored watering rule and an edited note stay.
    await knex('products_catalog').where({ name: matrix.ADVION }).update({ epa_reg_number: '100-9999', label_source_note: 'admin text', post_application_watering: JSON.stringify({ mode: 'none', source: 'owner' }) });
    await fixes.up(knex);
    const edited = await catalog(matrix.ADVION);
    expect([edited.epa_reg_number, edited.label_source_note, edited.post_application_watering.mode]).toEqual(['100-9999', 'admin text', 'none']);
    expect(Number(edited.max_label_rate_per_1000)).toBe(0.0344);
    await fixes.down(knex);
    const editedBack = await catalog(matrix.ADVION);
    expect([editedBack.epa_reg_number, editedBack.label_source_note, editedBack.post_application_watering.mode]).toEqual(['100-9999', 'admin text', 'none']);
    expect(editedBack.max_label_rate_per_1000).toBeNull();

    // An admin edits an inserted catalog row, then 180000 is rolled back: the rows stay (181000's neutralize).
    await knex('products_catalog').where({ name: matrix.SOP }).update({ best_price: 39.5, needs_pricing: false });
    await fixes.up(knex);
    await fixes.down(knex);
    await matrix.down(knex);
    const sop = await catalog(matrix.SOP);
    expect(sop).toBeDefined();
    expect(Number(sop.best_price)).toBe(39.5);
    expect(await catalog(matrix.HEAD)).toBeDefined();
    expect(await catalog(matrix.ADVION)).toBeDefined();
    // The staged rows 180000 wrote are gone, and the Arena catalog row went back to its first name.
    expect((await rowsIn(W.JUL)).map((row) => row.product_name)).not.toContain(matrix.SOP);
    expect((await catalog(matrix.ARENA_OLD)).id).toBe(arenaId);
  });
});
