// Lawn protocol v13 matrix adds, Codex round 7 (20261007187000): one general rollback guard, through PostgreSQL.
// The real earlier migrations stage a v13 protocol in an owned schema (cloned table definitions, no rows) over a
// prod-like catalog (a Headway Fungicide row prod already has, unapproved), then 180000 to 187000 run up, and the
// matrix is rolled back in reverse order (187000 to 180000), the way a rollback runs them.
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
const round4 = require('../models/migrations/20261007184000_lawn_v13_matrix_adds_round4');
const round5 = require('../models/migrations/20261007185000_lawn_v13_matrix_adds_round5');
const round6 = require('../models/migrations/20261007186000_lawn_v13_matrix_adds_round6');
const round7 = require('../models/migrations/20261007187000_lawn_v13_matrix_adds_round7');
const round11 = require('../models/migrations/20261007188000_lawn_v13_matrix_adds_round11');
const removePotash = require('../models/migrations/20261007189000_lawn_v13_matrix_remove_july_potash');
const guard = require('../services/lawn-v13-rollback-guard');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const UPS = [matrix, fixes, round2, round3, round4, round5, round6, round7, round11, removePotash];
const DOWNS = [...UPS].reverse();
const LIVE_KEY = 'swfl_zoysia_10_10';
const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];
const WATERING = { mode: 'hold', hold_until: 'dry', source: 'owner', label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried.', verified_at: '2026-10-07T00:00:00.000Z', verified_by: 'label-check-2026-10-07' };
jest.spyOn(console, 'log').mockImplementation(() => {});

describe('the shared rollback guard', () => {
  test('neutralizeAuditRows keeps the original under keptLive and leaves a neutralized row alone', async () => {
    const rows = [{ id: 1, action: 'a', after_snapshot: JSON.stringify({ x: 1 }) }, { id: 2, action: 'a', after_snapshot: { keptLive: { y: 2 } } }];
    const updates = [];
    const knex = (table) => ({
      where: ({ action }) => ({ select: async () => rows.filter((row) => row.action === action) }),
      update: undefined,
      ...(table === 'lawn_protocol_audit_log' ? {} : {}),
    });
    knex.schema = { hasTable: async () => true };
    const patched = (table) => {
      const base = knex(table);
      return { ...base, where: (cond) => (cond.id ? { update: async (patch) => { updates.push([cond.id, JSON.parse(patch.after_snapshot)]); } } : base.where(cond)) };
    };
    patched.schema = knex.schema;
    expect(await guard.neutralizeAuditRows(patched, { a: { list: [] } })).toBe(1);
    expect(updates).toEqual([[1, { list: [], keptLive: { x: 1 } }]]);
  });

  test('the neutral shapes cover every earlier matrix migration that reverts protocol or catalog facts', () => {
    expect(Object.keys(round7.EMPTY_BY_ACTION).sort()).toEqual([
      fixes.ACTION, round2.ACTION, round2.CATALOG_ACTION, round3.ACTION, round3.CATALOG_ACTION,
      round4.ACTION, round5.ACTION, round5.CATALOG_ACTION, round6.ACTION, round6.CATALOG_ACTION,
    ].sort());
  });
});

describeDb('v13 matrix rollback on a live and an idle protocol (20261007187000)', () => {
  let schema;
  let knex;

  async function build() {
    schema = `matrix_round7_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    await knex.raw('ALTER TABLE ??.scheduled_services ALTER COLUMN customer_id DROP NOT NULL', [schema]);
    for (const turf of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: turf.key, version: '2026.06', name: `base ${turf.key}`, status: 'active', grass_track: turf.track, region: 'swfl' });
    }
    await knex('products_catalog').insert({ name: matrix.ARENA_OLD, category: 'insecticide', epa_reg_number: matrix.ARENA_EPA, active: true });
    // The Headway row prod already has: unapproved, a rate, a stored owner watering rule.
    await knex('products_catalog').insert({ name: matrix.HEAD, category: 'fungicide', active: true, container_size: '1 gal', default_rate_per_1000: 1.5, rate_unit: 'fl_oz', post_application_watering: JSON.stringify(WATERING) });
    await staged.up(knex);
    await links.up(knex);
    await april.up(knex);
    await october.up(knex);
  }
  const drop = async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); knex = null; } };

  // Everything the matrix writes or rolls back, without timestamps and generated ids that differ per run.
  const facts = async () => ({
    catalog: (await knex('products_catalog').orderBy('name')).map(({ id, created_at, updated_at, ...row }) => row),
    aliases: (await knex('product_aliases').orderBy('alias_name')).map((row) => row.alias_name),
    limits: (await knex('product_limits').orderBy(['limit_type', 'description'])).map(({ id, product_id, created_at, updated_at, ...row }) => row),
  });
  const protocolRows = async (key) => (await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION })
    .select('w.window_key', 'p.product_name', 'p.rate_per_1000', 'p.rate_unit', 'p.default_in_plan', 'p.gates', 'p.sort_order')
    .orderBy(['w.window_key', 'p.product_name', 'p.sort_order'])).map((row) => ({ ...row, rate_per_1000: row.rate_per_1000 == null ? null : Number(row.rate_per_1000) }));
  const sub = (rows, windowKey, name) => rows.find((row) => row.window_key === windowKey && row.product_name === name);

  describe('a v13 protocol is referenced by a scheduled visit', () => {
    let upFacts;
    let upRows;
    let upAllRows;
    beforeAll(async () => {
      await build();
      for (const migration of UPS) await migration.up(knex);
      await knex('scheduled_services').insert({ lawn_protocol_key: LIVE_KEY, lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
      upFacts = await facts();
      upRows = await protocolRows(LIVE_KEY);
      upAllRows = Object.fromEntries(await Promise.all(staged.TRACKS.map(async (turf) => [turf.key, await protocolRows(turf.key)])));
    }, 90000);
    afterAll(drop);

    test('the September take-all Artavia row is exclusive again (188000), on every track', async () => {
      for (const turf of staged.TRACKS) {
        const row = (await protocolRows(turf.key)).find((made) => made.window_key === 'sep_v13_hose_blackout' && made.product_name === 'Artavia 2 SC (Azoxy)');
        expect(row.gates.trigger).toBe(round11.NEW_TRIGGER);
      }
    });

    test('the live check sees the visit', async () => {
      expect(await guard.anyV13ProtocolReferenced(knex)).toBe(true);
    });

    test('rolling back 187000 to 180000 leaves the Headway facts and approval, the Advion rate and catalog default, the Talak rates and the July rows (no potash row: 189000 removed it) as they were', async () => {
      for (const migration of DOWNS) await migration.down(knex);
      const after = await facts();
      const headway = after.catalog.find((row) => row.name === matrix.HEAD);
      expect([headway.approved_for_service_report, headway.epa_reg_number, headway.frac_group, headway.manufacturer]).toEqual([true, '100-1216', '3 + 11', 'Syngenta']);
      const advion = after.catalog.find((row) => row.name === matrix.ADVION);
      expect(Number(advion.default_rate_per_1000)).toBe(0.0344);
      expect(advion.approved_for_service_report).toBe(true);
      expect(after.catalog.find((row) => row.name === matrix.ARENA_OLD)).toBeDefined();
      // The whole catalog, alias and limit state is exactly what the full set of ups left.
      expect(after.catalog).toEqual(upFacts.catalog);
      expect(after.aliases).toEqual(upFacts.aliases);
      expect(after.limits).toEqual(upFacts.limits);
      // The referenced protocol's rows: Advion 0.0344, Talak 1.0 fl oz without the gate, and no July 0-0-50 row (removed by 189000, which a rollback on a live protocol does not bring back).
      const rows = await protocolRows(LIVE_KEY);
      expect(rows).toEqual(upRows);
      // The idle tracks stay synchronized with the live one and the catalog: nothing of theirs is reverted either.
      for (const turf of staged.TRACKS) expect({ key: turf.key, rows: await protocolRows(turf.key) }).toEqual({ key: turf.key, rows: upAllRows[turf.key] });
      expect(Number(sub(rows, 'apr_v13_spreader_feeding', matrix.ADVION).rate_per_1000)).toBe(0.0344);
      expect([sub(rows, 'aug_v13_hose_blackout', 'Atticus Talak 7.9 F').rate_per_1000, sub(rows, 'aug_v13_hose_blackout', 'Atticus Talak 7.9 F').rate_unit]).toEqual([1, 'fl oz']);
      expect(sub(rows, 'jul_v13_inspect_spot', matrix.SOP)).toBeUndefined();
    });
  });

  describe('one track is referenced and the others are idle', () => {
    let upAllRows;
    beforeAll(async () => {
      await build();
      for (const migration of UPS) await migration.up(knex);
      await knex('scheduled_services').insert({ lawn_protocol_key: LIVE_KEY, lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
      upAllRows = Object.fromEntries(await Promise.all(staged.TRACKS.map(async (turf) => [turf.key, await protocolRows(turf.key)])));
    }, 90000);
    afterAll(drop);

    test('the full down, 188000 to 180000, changes no track (referenced or idle), no config row and no catalog row', async () => {
      const upFacts = await facts();
      for (const migration of [...UPS].reverse()) await migration.down(knex);
      for (const turf of staged.TRACKS) expect({ key: turf.key, rows: await protocolRows(turf.key) }).toEqual({ key: turf.key, rows: upAllRows[turf.key] });
      expect(await facts()).toEqual(upFacts);
      // The idle tracks still have the rows 180000 inserted (it deleted them from an idle track before).
      const idle = await protocolRows('swfl_st_augustine_10_10');
      expect(idle.map((row) => row.product_name)).toEqual(expect.arrayContaining([matrix.ADVION, matrix.HEAD]));
      expect(idle.map((row) => row.product_name)).not.toContain(matrix.SOP);
    });
  });

  describe('nothing references a v13 protocol', () => {
    let before;
    beforeAll(async () => {
      await build();
      before = await facts();
      for (const migration of UPS) await migration.up(knex);
    }, 90000);
    afterAll(drop);

    test('the live check sees nothing, and 187000 rewrites no audit row', async () => {
      expect(await guard.anyV13ProtocolReferenced(knex)).toBe(false);
      await round7.down(knex);
      const kept = (await knex('lawn_protocol_audit_log').select('after_snapshot')).filter((row) => JSON.stringify(row.after_snapshot).includes('keptLive'));
      expect(kept).toEqual([]);
    });

    test('the full rollback still reverts: facts and approvals go back, Arena is where it started, staged rows are gone (inserted catalog rows stay by design)', async () => {
      for (const migration of DOWNS) await migration.down(knex);
      const after = await facts();
      const byName = (name) => after.catalog.find((row) => row.name === name);
      // The production Headway row is exactly what it was before the matrix.
      expect(byName(matrix.HEAD)).toEqual(before.catalog.find((row) => row.name === matrix.HEAD));
      // Rollback never deletes a catalog row (181000): the rows the matrix inserted stay, unapproved.
      for (const name of [matrix.ADVION, matrix.SOP]) expect(byName(name).approved_for_service_report).toBe(false);
      expect(Number(byName(matrix.ADVION).default_rate_per_1000)).toBe(0.034);
      expect(byName(matrix.ARENA_OLD)).toEqual(before.catalog.find((row) => row.name === matrix.ARENA_OLD));
      expect(after.catalog.map((row) => row.name)).not.toContain(matrix.ARENA_NEW);
      // The Advion limits 182000 inserted are removed.
      expect(after.limits).toEqual(before.limits);
      for (const turf of staged.TRACKS) {
        const rows = await protocolRows(turf.key);
        expect(rows.map((row) => row.product_name)).not.toContain(matrix.SOP);
        expect(rows.map((row) => row.product_name)).not.toContain(matrix.ADVION);
      }
    });
  });
});
