/**
 * 20260924020010 — supersedes 20260924020000 for ONE flag: restores
 * customer_visible=true on tree_shrub_quarterly so the grandfathered
 * quarterly customer's tracking-page "Today's visit" summary (track-public.js
 * / tracking.js, both gated on services.customer_visible) is not blanked.
 * booking_enabled / public_quote_selectable stay false. down() is a
 * documented no-op.
 */
const migration = require('../models/migrations/20260924020010_tree_shrub_quarterly_restore_customer_visible');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t === 'services', hasColumn: async () => true };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (service_key, id) => ({
  id, service_key, is_active: true, customer_visible: false, booking_enabled: false, public_quote_selectable: false,
});

describe('20260924020010 restores tree_shrub_quarterly.customer_visible only', () => {
  test('flips customer_visible true on tree_shrub_quarterly only; booking_enabled and public_quote_selectable stay false', async () => {
    const db = { services: [svc('tree_shrub_quarterly', 1), svc('tree_shrub_program', 2)] };
    // The sibling row (tree_shrub_program) should never have been touched
    // by either migration — pin it stays false too as a sanity check the
    // update is correctly scoped by service_key.
    await migration.up(fakeKnex(db));
    const row = (k) => db.services.find((r) => r.service_key === k);
    expect(row('tree_shrub_quarterly')).toMatchObject({
      customer_visible: true, booking_enabled: false, public_quote_selectable: false, is_active: true,
    });
    expect(row('tree_shrub_program')).toMatchObject({ customer_visible: false });
  });

  test('down() is a documented no-op', async () => {
    const db = { services: [svc('tree_shrub_quarterly', 1)] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(db.services[0].customer_visible).toBe(true);
    await migration.down(knex);
    expect(db.services[0].customer_visible).toBe(true);
  });

  test('a database with no services table (or no customer_visible column) is a no-op', async () => {
    const knex = fakeKnex({});
    knex.schema.hasTable = async () => false;
    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});
