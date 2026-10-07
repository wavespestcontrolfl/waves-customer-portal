// Lawn protocol v13 matrix adds, Codex round 4 (20261007184000), through PostgreSQL.
// 180000 to 183000 are frozen (pushed); 184000 fixes their data. The real earlier migrations stage a v13
// protocol in an owned schema (cloned table definitions, no rows), then 184000 runs over it.
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
const { freezeReportProductFacts } = require('../services/complete-scheduled-service');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const W = matrix.WINDOWS;
const TAL = staged.NAMES.TAL;

const TABLES = [
  'products_catalog', 'product_aliases', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_gates', 'lawn_protocol_audit_log', 'scheduled_services', 'lawn_protocol_service_completions',
  'lawn_protocol_product_actuals', 'property_application_history', 'service_products',
];

describeDb('v13 matrix adds round 4 (20261007184000)', () => {
  let schema;
  let knex;

  const catalog = (name) => knex('products_catalog').where({ name }).first();
  const rowOf = async (windowKey, name, key = 'swfl_st_augustine_10_10') => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.protocol_key': key, 'l.version': staged.V13_VERSION, 'w.window_key': windowKey, 'p.product_name': name })
    .first('p.*');
  // What a completion freezes for one applied product (the closeout's own freeze).
  const frozen = async (name, targets) => {
    const row = await catalog(name);
    return freezeReportProductFacts({ productIds: [String(row.id)], submitted: [{ productId: row.id, targets }], catalogById: new Map([[String(row.id), row]]), plan: {} })[String(row.id)];
  };
  const snapshot = async () => ({
    catalog: await knex('products_catalog').select('id', 'name', 'approved_for_service_report', 'manufacturer', 'public_summary', 'product_type').orderBy('name'),
    audit: (await knex('lawn_protocol_audit_log').select('action').orderBy('action')).map((row) => row.action),
  });

  beforeAll(async () => {
    schema = `matrix_round4_${randomUUID().replace(/-/g, '')}`;
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
    for (const migration of [matrix, fixes, round2, round3]) await migration.up(knex);
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('before: the inserted rows are not approved, so a completion freezes no facts for them', async () => {
    for (const name of [matrix.SOP, matrix.ADVION, matrix.HEAD]) {
      expect({ name, approved: (await catalog(name)).approved_for_service_report }).toEqual({ name, approved: false });
      expect({ name, facts: await frozen(name, []) }).toEqual({ name, facts: null });
    }
  });

  test('up: each inserted row is approved and a completion freezes its facts and its watering rule', async () => {
    await round4.up(knex);
    const sop = await frozen(matrix.SOP, []);
    expect(sop).toMatchObject({ productType: 'fertilizer', name: matrix.SOP, manufacturer: 'LESCO / SiteOne' });
    expect(sop.serviceReportSummary).toMatch(/potassium feeding/);
    expect(sop.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25 });

    const advion = await frozen(matrix.ADVION, ['Fire ants']);
    expect(advion).toMatchObject({ productType: 'pesticide', epaRegNumber: '100-1481', manufacturer: 'Syngenta' });
    expect(advion.serviceReportSummary).toMatch(/fire ant management/);
    expect(advion.wateringRule).toMatchObject({ mode: 'hold', hold_hours: 3, source: 'label' });

    const headway = await frozen(matrix.HEAD, ['Take-all']);
    expect(headway).toMatchObject({ productType: 'pesticide', epaRegNumber: '100-1216' });
    expect(headway.wateringRule).toMatchObject({ mode: 'hold', hold_until: 'dry' });
    // Nothing else about the rows changed.
    expect((await catalog(matrix.ADVION)).customer_visibility).toBe('internal_only');
  });

  test('a second up changes nothing', async () => {
    const before = await snapshot();
    await round4.up(knex);
    expect(await snapshot()).toEqual(before);
  });

  test('a row that is not exactly as we left it is never approved; a prod row has none of our note', async () => {
    const hw = round4.FACTS.find((fact) => fact.name === matrix.HEAD);
    expect(hw.owned({ label_source_note: 'prod text' })).toBe(false);
    expect(hw.owned({ label_source_note: null })).toBe(false);
    await round4.down(knex);
    await knex('products_catalog').where({ name: matrix.SOP }).update({ label_source_note: 'admin text' });
    await knex('products_catalog').where({ name: matrix.ADVION }).update({ content_status: 'approved_for_portal' });
    await round4.up(knex);
    expect((await catalog(matrix.SOP)).approved_for_service_report).toBe(false);
    expect((await catalog(matrix.ADVION)).approved_for_service_report).toBe(false);
    expect((await catalog(matrix.HEAD)).approved_for_service_report).toBe(true);
    await knex('products_catalog').where({ name: matrix.SOP }).update({ label_source_note: matrix.CATALOG.find((p) => p.name === matrix.SOP).label_source_note });
    await knex('products_catalog').where({ name: matrix.ADVION }).update({ content_status: 'draft' });
    await round4.up(knex);
    expect((await catalog(matrix.SOP)).approved_for_service_report).toBe(true);
  });

  test('down (nothing live) takes the approvals and facts back, and only those it wrote', async () => {
    await knex('products_catalog').where({ name: matrix.HEAD }).update({ manufacturer: 'Edited by admin' });
    await round4.down(knex);
    for (const name of [matrix.SOP, matrix.ADVION, matrix.HEAD]) expect((await catalog(name)).approved_for_service_report).toBe(false);
    expect((await catalog(matrix.SOP)).public_summary).toBeNull();
    expect((await catalog(matrix.HEAD)).manufacturer).toBe('Edited by admin');
    expect(await knex('lawn_protocol_audit_log').where({ action: round4.ACTION })).toHaveLength(0);
  });

  test('down with a live protocol: 183000 reverts nothing (Talak rate and gates, Headway fields stay) and the approvals stay', async () => {
    await round4.up(knex);
    await knex.raw('ALTER TABLE ??.scheduled_services ALTER COLUMN customer_id DROP NOT NULL', [schema]);
    await knex('scheduled_services').insert({ lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: staged.V13_VERSION, service_type: 'Lawn fixture', scheduled_date: '2026-10-07' });
    await round4.down(knex);
    const july = await rowOf(W.JUL, TAL);
    expect([Number(july.rate_per_1000), july.rate_unit]).toEqual([1, 'fl oz']);
    expect((await catalog(matrix.SOP)).approved_for_service_report).toBe(true);
    const logs = await knex('lawn_protocol_audit_log').whereIn('action', [round3.ACTION, round3.CATALOG_ACTION]);
    // One protocol audit row per track (the repo-built Headway row already carries its group: no catalog backfill row).
    expect(logs).toHaveLength(4);
    for (const log of logs) expect((typeof log.after_snapshot === 'string' ? JSON.parse(log.after_snapshot) : log.after_snapshot).keptLive).toBeDefined();
    // 183000's down now has nothing to revert.
    const frac = (await catalog(matrix.HEAD)).frac_group;
    await round3.down(knex);
    expect((await rowOf(W.JUL, TAL)).rate_unit).toBe('fl oz');
    expect((await rowOf(W.AUG, TAL)).rate_unit).toBe('fl oz');
    expect((await catalog(matrix.HEAD)).frac_group).toBe(frac);
  });
});
