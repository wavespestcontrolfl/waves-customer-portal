/**
 * 20260924000020 — lawn_care_recurring ("Bi-Monthly Lawn Care Service") stops
 * being customer-visible (public MCP catalog) and call-agent bookable; the
 * row stays active; admin re-enables survive reruns; down() is a no-op.
 */
const migration = require('../models/migrations/20260924000020_bimonthly_lawn_service_not_offered');

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
  knex.schema = { hasTable: async (t) => t === 'services' || t === 'system_settings', hasColumn: async () => true };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (service_key, id) => ({ id, service_key, is_active: true, customer_visible: true, booking_enabled: true, public_quote_selectable: false });

describe('20260924000020 bi-monthly lawn service is no longer offered', () => {
  test('flips customer_visible + booking_enabled on lawn_care_recurring only; row stays active', async () => {
    const db = { services: [svc('lawn_care_recurring', 1), svc('lawn_care_6week', 2), svc('lawn_care_monthly', 3)], system_settings: [] };
    await migration.up(fakeKnex(db));
    const row = (k) => db.services.find((r) => r.service_key === k);
    expect(row('lawn_care_recurring')).toMatchObject({ is_active: true, customer_visible: false, booking_enabled: false });
    for (const k of ['lawn_care_6week', 'lawn_care_monthly']) {
      expect(row(k)).toMatchObject({ customer_visible: true, booking_enabled: true });
    }
  });

  test('a rerun never re-flips a flag an admin turned back on; down() is a no-op', async () => {
    const db = { services: [svc('lawn_care_recurring', 1)], system_settings: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.services[0].booking_enabled = true; // admin re-enabled in the Service Library
    await migration.up(knex);
    expect(db.services[0]).toMatchObject({ customer_visible: false, booking_enabled: true });
    await migration.down(knex);
    expect(db.services[0]).toMatchObject({ customer_visible: false, booking_enabled: true });
  });
});
