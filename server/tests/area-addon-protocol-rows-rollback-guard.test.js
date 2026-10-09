/**
 * 20261010140000: rolling back the area add-on protocol rows keeps a row an
 * operator edited. The frozen seed migration's down() deletes by role only;
 * this later migration's down() runs first and re-marks an edited row so the
 * older down() leaves it, its window and the protocol.
 */
const guard = require('../models/migrations/20261010140000_area_addon_protocol_rows_rollback_guard');
const seed = require('../models/migrations/20261010120000_area_addon_protocol_rows');
const fieldGuard = require('../models/migrations/20261010190000_area_addon_protocol_rows_field_guard');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const rows = () => db[table] || [];
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      first: async () => { const hit = rows().find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { rows().filter(match).forEach((r) => Object.assign(r, patch)); },
      del: async () => { db[table] = rows().filter((r) => !match(r)); },
      then: (resolve) => resolve(rows().filter(match).map((r) => ({ ...r }))),
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

// The rows 20261010120000 writes, as Postgres returns them (jsonb as objects, key order not guaranteed).
function seeded() {
  const db = { lawn_protocols: [{ id: 'proto', protocol_key: seed.PROTOCOL_KEY }], lawn_protocol_windows: [], lawn_protocol_products: [], lawn_protocol_audit_log: [], products_catalog: [] };
  const written = { protocol: 'proto', windows: [], products: [] };
  for (const a of seed.ADDONS) {
    db.lawn_protocol_windows.push({ id: `w-${a.visit}`, lawn_protocol_id: 'proto', window_key: a.serviceKey, visit_type: 'area_addon' });
    const counter = seed.counterOf(a);
    db.lawn_protocol_products.push({
      id: `p-${a.visit}`, lawn_protocol_window_id: `w-${a.visit}`, product_name: a.product, role: 'area_addon', default_in_plan: false,
      product_id: `cat-${a.visit}`, application_mode: 'area', carrier_gal_per_1000: null, mixing: {}, sort_order: 1,
      report_copy: { serviceKey: a.serviceKey, role: 'area_addon' },
      rate_per_1000: String(a.ratePer1000.toFixed(4)), rate_unit: a.rateUnit,
      gates: seed.gatesOf(a), annual_counter: Object.fromEntries(Object.entries(counter).reverse()),
    });
    db.products_catalog.push({ id: `cat-${a.visit}`, name: a.product });
    written.windows.push(`w-${a.visit}`);
    written.products.push(`p-${a.visit}`);
  }
  db.lawn_protocol_audit_log.push({ id: 'audit', action: 'area_addon_protocol_rows', after_snapshot: JSON.stringify(written) });
  return db;
}
// A rollback runs the latest migration's down() first.
const rollBack = async (db) => { const knex = fakeKnex(db); await fieldGuard.down(knex); await guard.down(knex); await seed.down(knex); };

describe('area add-on protocol rows rollback guard', () => {
  test('up changes nothing, and an unedited seed rolls back completely', async () => {
    const db = seeded();
    await guard.up(fakeKnex(db));
    expect(db.lawn_protocol_products.every((r) => r.role === 'area_addon')).toBe(true);
    await rollBack(db);
    expect(db.lawn_protocol_products).toEqual([]);
    expect(db.lawn_protocol_windows).toEqual([]);
    expect(db.lawn_protocols).toEqual([]);
  });

  test.each([
    ['rate', { rate_per_1000: '0.2000' }],
    ['unit', { rate_unit: 'g' }],
    ['product', { product_name: 'Another Product' }],
    ['gates', { gates: { trigger: 'area_addon_sold', addOnServiceKey: 'area_addon_lawn_insect_spot' } }],
    ['yearly counter', { annual_counter: { maxApplications: 1, windowMonths: 12, minDaysApart: 56 } }],
    ['default in plan', { default_in_plan: true }],
    // Codex round 24: the fields the first guard does not read (20261010190000).
    ['product id', { product_id: 'cat-1' }],
    ['application mode', { application_mode: 'spot' }],
    ['carrier', { carrier_gal_per_1000: '1.0000' }],
    ['mixing', { mixing: { order: 2 } }],
    ['report copy', { report_copy: { role: 'area_addon', serviceKey: 'area_addon_lawn_insect_spot', note: 'x' } }],
    ['sort order', { sort_order: 2 }],
  ])('a row whose %s an operator edited survives the rollback, with its window and the protocol', async (_field, edit) => {
    const db = seeded();
    Object.assign(db.lawn_protocol_products.find((r) => r.id === 'p-2'), edit);
    await rollBack(db);
    expect(db.lawn_protocol_products.map((r) => r.id)).toEqual(['p-2']);
    expect(db.lawn_protocol_products[0]).toMatchObject(edit);
    expect(db.lawn_protocol_windows.map((r) => r.id)).toEqual(['w-2']);
    expect(db.lawn_protocols).toHaveLength(1);
  });

  test('a product found by an alias, or a row written with no product id, still rolls back; an unreadable catalog keeps the row', async () => {
    const aliased = seeded();
    aliased.products_catalog.find((r) => r.id === 'cat-2').name = 'Arena Renamed';
    aliased.product_aliases = [{ product_id: 'cat-2', alias_name: 'Arena 50 WDG' }];
    aliased.lawn_protocol_products.find((r) => r.id === 'p-3').product_id = null;
    await rollBack(aliased);
    expect(aliased.lawn_protocol_products).toEqual([]);
    const unreadable = seeded();
    delete unreadable.products_catalog;
    const knex = fakeKnex(unreadable);
    await fieldGuard.down(knex);
    expect(unreadable.lawn_protocol_products.every((r) => r.role === guard.KEPT_ROLE)).toBe(true);
  });

  test('missing tables skip without error', async () => {
    await expect(fieldGuard.down(fakeKnex({}))).resolves.toBeUndefined();
    await expect(guard.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
