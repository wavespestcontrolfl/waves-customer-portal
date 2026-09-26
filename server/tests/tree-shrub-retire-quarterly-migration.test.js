/**
 * 20260924020000 — tree_shrub_quarterly ("Quarterly Tree & Shrub Care
 * Service") stops being customer-visible (public MCP catalog), call-agent
 * bookable, and public-quote-menu selectable. The row stays active — the
 * one existing grandfathered quarterly customer's data is untouched. Unlike
 * the bi-monthly lawn migrations, this one ships as ONE step with a real,
 * direct down() (owner-directed; see the migration header).
 */
const migration = require('../models/migrations/20260924020000_tree_shrub_retire_quarterly');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      select() { return Promise.resolve(rows().filter(matches).map((r) => ({ ...r }))); },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async del() { const keep = rows().filter((r) => !matches(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
      async insert(row) { rows().push({ ...row }); return [row]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t === 'services', hasColumn: async () => true };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (service_key, id) => ({
  id, service_key, is_active: true, customer_visible: true, booking_enabled: true, public_quote_selectable: true,
});

describe('20260924020000 quarterly tree & shrub service is no longer offered', () => {
  test('flips customer_visible + booking_enabled + public_quote_selectable on tree_shrub_quarterly only; row stays active', async () => {
    const db = {
      services: [
        svc('tree_shrub_quarterly', 1),
        svc('tree_shrub_program', 2),
        svc('tree_shrub_6week', 3),
      ],
    };
    await migration.up(fakeKnex(db));
    const row = (k) => db.services.find((r) => r.service_key === k);
    expect(row('tree_shrub_quarterly')).toMatchObject({
      is_active: true, customer_visible: false, booking_enabled: false, public_quote_selectable: false,
    });
    for (const k of ['tree_shrub_program', 'tree_shrub_6week']) {
      expect(row(k)).toMatchObject({ customer_visible: true, booking_enabled: true, public_quote_selectable: true });
    }
  });

  test('down() restores all three flags', async () => {
    const db = { services: [svc('tree_shrub_quarterly', 1)] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(db.services[0]).toMatchObject({
      customer_visible: false, booking_enabled: false, public_quote_selectable: false,
    });
    await migration.down(knex);
    expect(db.services[0]).toMatchObject({
      is_active: true, customer_visible: true, booking_enabled: true, public_quote_selectable: true,
    });
  });

  test('a database with no services table is a no-op both ways', async () => {
    const knex = fakeKnex({});
    knex.schema.hasTable = async () => false;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });

  test('missing columns on an older schema are skipped, not thrown', async () => {
    const db = { services: [svc('tree_shrub_quarterly', 1)] };
    const knex = fakeKnex(db);
    knex.schema.hasColumn = async () => false;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    // Nothing changed — no column existed to flip.
    expect(db.services[0]).toMatchObject({
      customer_visible: true, booking_enabled: true, public_quote_selectable: true,
    });
  });
});
