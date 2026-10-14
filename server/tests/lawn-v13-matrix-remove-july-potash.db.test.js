// Lawn protocol v13 matrix adds: the July 0-0-50 potash step is removed (20261007189000), through PostgreSQL.
// The real earlier migrations stage a v13 protocol in an owned schema (cloned table definitions, no rows), then
// 180000 to 188000 run (the chain as it already ran), then 189000. Synthetic data only. Self-skips without DATABASE_URL.
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

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const CHAIN = [matrix, fixes, round2, round3, round4, round5, round6, round7, round11, remove];
const W = matrix.WINDOWS;
const KEYS = staged.TRACKS.map((turf) => turf.key);
const SOP = matrix.SOP;
const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];
jest.spyOn(console, 'log').mockImplementation(() => {});

describeDb('v13 matrix: the July potash is removed (20261007189000)', () => {
  let schema;
  let knex;

  async function build() {
    schema = `matrix_nopotash_${randomUUID().replace(/-/g, '')}`;
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
  }
  const drop = async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); knex = null; } };
  const upTo = async (last) => { for (const migration of CHAIN.slice(0, CHAIN.indexOf(last) + 1)) await migration.up(knex); };

  const julyRows = async (key) => (await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': W.JUL })
    .select('p.id', 'p.product_name', 'p.default_in_plan', 'p.gates').orderBy('p.product_name'));
  const julyWindow = (key) => knex('lawn_protocol_windows as w').join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': W.JUL }).first('w.*');
  const catalogSop = () => knex('products_catalog').where({ name: SOP }).first();
  const everything = async () => ({
    products: (await knex('lawn_protocol_products').orderBy('id')).map(({ updated_at, ...row }) => row),
    windows: (await knex('lawn_protocol_windows').orderBy('id')).map(({ updated_at, ...row }) => row),
    catalog: (await knex('products_catalog').orderBy('name')).map(({ id, created_at, updated_at, ...row }) => row),
    audit: (await knex('lawn_protocol_audit_log').select('action', 'after_snapshot').orderBy(['action', 'entity_id'])).length,
  });

  describe('a chain that already ran 180000 to 188000', () => {
    beforeAll(async () => { await build(); await upTo(round11); }, 90000);
    afterAll(drop);

    test('before: every July window has the potash row and the spreader window shape', async () => {
      for (const key of KEYS) {
        expect((await julyRows(key)).map((row) => row.product_name)).toContain(SOP);
        expect((await julyWindow(key)).production_mode).toBe(matrix.JULY_NEW.production_mode);
      }
      expect((await catalogSop()).post_application_watering).toMatchObject({ mode: 'water_in' });
    });

    test('up: the potash row is gone from every protocol, the window is the scout window again, the Talak, Pythium and fairy ring rows stay', async () => {
      await remove.up(knex);
      for (const key of KEYS) {
        const names = (await julyRows(key)).map((row) => row.product_name);
        expect(names).not.toContain(SOP);
        expect(names).toEqual(expect.arrayContaining(['Atticus Talak 7.9 F', 'Artavia 2 SC (Azoxy)', 'Velista', 'Gravex 20 EW']));
        const window = await julyWindow(key);
        expect([window.visit_type, window.production_mode, window.goal]).toEqual([matrix.JULY_OLD.visit_type, matrix.JULY_OLD.production_mode, matrix.JULY_OLD.goal]);
        expect(window.required_tasks).toEqual(matrix.JULY_OLD.required_tasks);
        // The Talak row keeps its rate and trigger (the earlier rounds), and no row carries a potash gate.
        const talak = (await julyRows(key)).find((row) => row.product_name === 'Atticus Talak 7.9 F');
        expect(talak.gates.trigger).toMatch(/mole_cricket_nymphs/);
        for (const row of await julyRows(key)) expect(row.gates.fertilizerSafety).toBeUndefined();
      }
    });

    test('the catalog row stays as an unused product (pricing and approval untouched); only the watering rule the matrix wrote is cleared', async () => {
      const row = await catalogSop();
      expect(row).toBeDefined();
      expect(row.post_application_watering).toBeNull();
      expect(row.approved_for_service_report).toBe(true);
      expect(Number(row.default_rate_per_1000)).toBe(1);
      expect(row.siteone_sku).toBe('009842');
    });

    test('the earlier migrations July entries are neutralized: rolling the matrix back never brings the potash back', async () => {
      const [log] = await knex('lawn_protocol_audit_log').where({ action: matrix.ACTION }).limit(1);
      const after = typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot;
      expect(after.inserted.map((entry) => entry.product_name)).not.toContain(SOP);
      expect(after.windows).toEqual([]);
      for (const migration of [...CHAIN].reverse()) await migration.down(knex);
      for (const key of KEYS) {
        expect((await julyRows(key)).map((row) => row.product_name)).not.toContain(SOP);
        expect((await julyWindow(key)).production_mode).toBe(matrix.JULY_OLD.production_mode);
      }
    });
  });

  describe('up is idempotent and down restores', () => {
    beforeAll(async () => { await build(); await upTo(round11); }, 90000);
    afterAll(drop);

    test('a second up changes nothing', async () => {
      await remove.up(knex);
      const once = await everything();
      await remove.up(knex);
      expect(await everything()).toEqual(once);
    });

    test('down (nothing live) puts back the rows with their ids, the window, the catalog rule and the earlier entries; up again matches', async () => {
      const removed = await everything();
      await remove.down(knex);
      for (const key of KEYS) {
        const row = (await julyRows(key)).find((made) => made.product_name === SOP);
        expect(row).toBeDefined();
        expect(row.gates).toMatchObject({ fertilizerSafety: true, planVisitsPerYear: 12 });
        expect((await julyWindow(key)).production_mode).toBe(matrix.JULY_NEW.production_mode);
      }
      expect((await catalogSop()).post_application_watering).toMatchObject({ mode: 'water_in' });
      expect(await knex('lawn_protocol_audit_log').whereIn('action', [remove.ACTION, remove.CATALOG_ACTION])).toHaveLength(0);
      await remove.up(knex);
      expect(await everything()).toEqual(removed);
    });
  });

  describe('guards', () => {
    beforeEach(async () => { await build(); await upTo(round11); });
    afterEach(drop);

    test('a row that is not the row the matrix left (an admin edit), or that a completion actual references, is kept; the window an admin edited is left', async () => {
      const key = KEYS[0];
      const [edited] = await julyRows(key);
      const sopRow = (await julyRows(key)).find((row) => row.product_name === SOP);
      await knex('lawn_protocol_products').where({ id: sopRow.id }).update({ rate_per_1000: 2 });
      const referenced = (await julyRows(KEYS[1])).find((row) => row.product_name === SOP);
      await knex('lawn_protocol_product_actuals').insert({ lawn_protocol_service_completion_id: randomUUID(), protocol_product_id: referenced.id, product_name: SOP });
      await knex('lawn_protocol_windows').where({ id: (await julyWindow(KEYS[2])).id }).update({ goal: 'Edited by the office.' });
      await remove.up(knex);
      expect((await julyRows(key)).map((row) => row.product_name)).toContain(SOP);
      expect((await julyRows(KEYS[1])).map((row) => row.product_name)).toContain(SOP);
      expect((await julyRows(KEYS[2])).map((row) => row.product_name)).not.toContain(SOP);
      expect((await julyWindow(KEYS[2])).goal).toBe('Edited by the office.');
      expect(edited).toBeDefined();
    });

    test('an admin-edited catalog watering rule is left; with a visit referencing a v13 protocol, down is a no-op', async () => {
      await knex('products_catalog').where({ name: SOP }).update({ post_application_watering: JSON.stringify({ mode: 'none', source: 'owner' }) });
      await remove.up(knex);
      expect((await catalogSop()).post_application_watering).toMatchObject({ mode: 'none' });
      await knex('scheduled_services').insert({ lawn_protocol_key: KEYS[0], lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
      const removed = await everything();
      await remove.down(knex);
      expect(await everything()).toEqual(removed);
      for (const key of KEYS) expect((await julyRows(key)).map((row) => row.product_name)).not.toContain(SOP);
    });
  });

  describe('a fresh chain (180000 to 189000 in order on an empty database)', () => {
    beforeAll(async () => { await build(); await upTo(remove); }, 90000);
    afterAll(drop);
    test('ends with no potash row on any track, the scout window, and the catalog row in place', async () => {
      for (const key of KEYS) {
        expect((await julyRows(key)).map((row) => row.product_name)).not.toContain(SOP);
        expect((await julyWindow(key)).visit_type).toBe(matrix.JULY_OLD.visit_type);
      }
      expect(await catalogSop()).toBeDefined();
    });
  });
});
