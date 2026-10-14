// Lawn protocol v13 matrix adds, Codex round 5 (20261007185000), through PostgreSQL.
// 180000 to 184000 are frozen (pushed); 185000 fixes their data. The real earlier migrations stage a v13
// protocol in an owned schema (cloned table definitions, no rows) over a prod-like catalog (a Headway
// Fungicide row prod already has, unapproved), then 185000 runs over it. Synthetic data only.
// Self-skips without DATABASE_URL.
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
const { freezeReportProductFacts } = require('../services/complete-scheduled-service');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const W = matrix.WINDOWS;
const KEYS = staged.TRACKS.map((turf) => turf.key);
const WATERING = { mode: 'hold', hold_until: 'dry', source: 'owner', label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried.', verified_at: '2026-10-07T00:00:00.000Z', verified_by: 'label-check-2026-10-07' };

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds round 5 (20261007185000)', () => {
  let schema;
  let knex;

  const catalog = (name) => knex('products_catalog').where({ name }).first();
  const sop = async (key) => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': W.JUL, 'p.product_name': matrix.SOP })
    .first('p.*');
  const frozen = async (name) => {
    const row = await catalog(name);
    return freezeReportProductFacts({ productIds: [String(row.id)], submitted: [{ productId: row.id }], catalogById: new Map([[String(row.id), row]]), plan: {} })[String(row.id)];
  };

  // Builds the schema from scratch; `edit` runs after the staging chain and before 180000 (an admin-edited July window).
  async function build({ editJulyWindowFor = [] } = {}) {
    schema = `matrix_round5_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    // The Headway row prod already has: unapproved, a rate, a stored owner watering rule (180000 fills an empty one).
    await knex('products_catalog').insert({ name: matrix.HEAD, category: 'fungicide', active: true, container_size: '1 gal', default_rate_per_1000: 1.5, rate_unit: 'fl_oz' });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
    for (const key of editJulyWindowFor) {
      await knex('lawn_protocol_windows').whereIn('lawn_protocol_id', knex('lawn_protocols').where({ protocol_key: key, version: staged.V13_VERSION }).select('id'))
        .where({ window_key: W.JUL }).update({ goal: 'Edited by the office.' });
    }
    for (const migration of [matrix, fixes, round2, round3, round4]) await migration.up(knex);
  }
  const drop = async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); knex = null; } };

  describe('the July potash is a 12-visit step and the window is atomic', () => {
    beforeAll(() => build({ editJulyWindowFor: ['swfl_zoysia_10_10'] }), 60000);
    afterAll(drop);

    test('before: every July 0-0-50 row is a default; the zoysia July window was left alone by 180000', async () => {
      for (const key of KEYS) expect((await sop(key)).default_in_plan).toBe(true);
      const window = await knex('lawn_protocol_windows as w').join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
        .where({ 'l.protocol_key': 'swfl_zoysia_10_10', 'l.version': staged.V13_VERSION, 'w.window_key': W.JUL }).first('w.*');
      expect([window.visit_type, window.production_mode]).toEqual([matrix.JULY_OLD.visit_type, matrix.JULY_OLD.production_mode]);
    });

    test('up: the 12-visit condition on every row; only the protocol whose window 180000 skipped loses the default', async () => {
      await round5.up(knex);
      for (const key of KEYS) expect((await sop(key)).gates.planVisitsPerYear).toBe(12);
      expect((await sop('swfl_zoysia_10_10')).default_in_plan).toBe(false);
      for (const key of KEYS.filter((k) => k !== 'swfl_zoysia_10_10')) expect((await sop(key)).default_in_plan).toBe(true);
      // The July 0-0-50 spot of the other tracks still carries its rate.
      expect(Number((await sop('swfl_st_augustine_10_10')).rate_per_1000)).toBe(1);
    });

    test('a second up changes nothing; down puts every gate and default back', async () => {
      const before = await knex('lawn_protocol_products').select('id', 'gates', 'default_in_plan').orderBy('id');
      await round5.up(knex);
      expect(await knex('lawn_protocol_products').select('id', 'gates', 'default_in_plan').orderBy('id')).toEqual(before);
      await round5.down(knex);
      for (const key of KEYS) {
        const row = await sop(key);
        expect(row.gates.planVisitsPerYear).toBeUndefined();
        expect(row.default_in_plan).toBe(true);
      }
      expect(await knex('lawn_protocol_audit_log').where({ action: round5.ACTION })).toHaveLength(0);
    });
  });

  describe('the production Headway row and the rollback of approvals', () => {
    beforeAll(() => build(), 60000);
    afterAll(drop);

    test('before: the production row is not ours and not approved, so a completion freezes no facts for it', async () => {
      const row = await catalog(matrix.HEAD);
      expect(row.approved_for_service_report).toBe(false);
      expect(row.epa_reg_number).toBeNull();
      expect(row.post_application_watering).toMatchObject({ mode: 'hold', hold_until: 'dry' });
      expect(await frozen(matrix.HEAD)).toBeNull();
    });

    test('up: facts filled where empty, approved because every fact the freeze reads is present, and a completion freezes them', async () => {
      await round5.up(knex);
      const row = await catalog(matrix.HEAD);
      expect([row.approved_for_service_report, row.epa_reg_number, row.manufacturer, row.product_type]).toEqual([true, '100-1216', 'Syngenta', 'pesticide']);
      // What it already had stays.
      expect([Number(row.default_rate_per_1000), row.rate_unit]).toEqual([1.5, 'fl_oz']);
      const facts = await frozen(matrix.HEAD);
      expect(facts).toMatchObject({ productType: 'pesticide', epaRegNumber: '100-1216' });
      expect(facts.wateringRule).toMatchObject({ mode: 'hold', hold_until: 'dry' });
    });

    test('a second up changes nothing; with no stored watering rule the facts are filled but the row is not approved', async () => {
      const before = await catalog(matrix.HEAD);
      await round5.up(knex);
      expect(await catalog(matrix.HEAD)).toEqual(before);
      await round5.down(knex);
      expect((await catalog(matrix.HEAD)).approved_for_service_report).toBe(false);
      await knex('products_catalog').where({ name: matrix.HEAD }).update({ post_application_watering: null });
      await round5.up(knex);
      const row = await catalog(matrix.HEAD);
      expect([row.approved_for_service_report, row.epa_reg_number]).toEqual([false, '100-1216']);
      await round5.down(knex);
      await knex('products_catalog').where({ name: matrix.HEAD }).update({ post_application_watering: JSON.stringify(WATERING) });
    });

    test('an existing value is never overwritten, and a row an admin already approved is left alone', async () => {
      await knex('products_catalog').where({ name: matrix.HEAD }).update({ epa_reg_number: '100-1216', manufacturer: 'Admin text' });
      await round5.up(knex);
      expect((await catalog(matrix.HEAD)).manufacturer).toBe('Admin text');
      await round5.down(knex);
      await knex('products_catalog').where({ name: matrix.HEAD }).update({ approved_for_service_report: true });
      const before = await catalog(matrix.HEAD);
      await round5.up(knex);
      expect(await catalog(matrix.HEAD)).toEqual(before);
      await knex('products_catalog').where({ name: matrix.HEAD }).update({ approved_for_service_report: false, manufacturer: null, epa_reg_number: null });
    });

    test('down: 184000\'s approvals revert, except for a product an admin edited since, whose approval stays', async () => {
      await knex('products_catalog').where({ name: matrix.SOP }).update({ approved_for_service_report: false });
      await round4.up(knex);
      expect((await catalog(matrix.SOP)).approved_for_service_report).toBe(true);
      // The admin rewrites the customer summary 184000 filled for the 0-0-50.
      await knex('products_catalog').where({ name: matrix.SOP }).update({ public_summary: 'Our own words about potash.' });
      await round5.down(knex);
      // Two audit rows now name the 0-0-50 (the first approval, and the one after the admin un-approved it):
      // the approval revert is gone from both, and every other product's entry is intact.
      const logs = (await knex('lawn_protocol_audit_log').where({ action: round4.ACTION })).map((log) => (typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot));
      const entries = logs.flatMap((after) => after.approved);
      const mine = entries.filter((entry) => entry.name === matrix.SOP);
      expect(mine).toHaveLength(2);
      for (const made of mine) {
        expect(made.fields.approved_for_service_report).toBeUndefined();
        expect(made.keptApproval).toBe(true);
      }
      expect(entries.filter((entry) => entry.name !== matrix.SOP).every((entry) => entry.fields.approved_for_service_report === true)).toBe(true);
      await round4.down(knex);
      expect((await catalog(matrix.SOP)).approved_for_service_report).toBe(true);
      expect((await catalog(matrix.SOP)).public_summary).toBe('Our own words about potash.');
      expect((await catalog(matrix.ADVION)).approved_for_service_report).toBe(false);
    });
  });
});
