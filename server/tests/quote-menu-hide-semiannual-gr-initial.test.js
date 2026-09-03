/**
 * 20260903000020 — pest_general_semiannual and german_roach_initial leave the
 * public quote menu; admin re-selections survive reruns; down() is a no-op.
 */
const hide = require('../models/migrations/20260903000020_hide_semiannual_pest_and_gr_initial_from_quote');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond, val) {
        if (typeof cond === 'string') filters.push((r) => r[cond] === val);
        else filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      select() { return Promise.resolve(rows().filter(matches).map((r) => ({ ...r }))); },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async del() { const keep = rows().filter((r) => !matches(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
      async insert(row) { rows().push({ ...row }); return [row]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t === 'services' || t === 'system_settings',
    hasColumn: async () => true,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (key, id, selectable = true) => ({ id, service_key: key, public_quote_selectable: selectable });

describe('20260903000020 hide semiannual pest + GR initial from the quote menu', () => {
  test('flips exactly the two ruled rows and leaves every other selectable row alone', async () => {
    const db = {
      services: [
        svc('pest_general_semiannual', 1), svc('german_roach_initial', 2),
        svc('pest_general_quarterly', 3), svc('german_roach', 4), svc('cockroach_control', 5),
        svc('palm_injection_semiannual', 6),
      ],
      system_settings: [],
    };
    await hide.up(fakeKnex(db));
    const flag = (k) => db.services.find((r) => r.service_key === k).public_quote_selectable;
    expect(flag('pest_general_semiannual')).toBe(false);
    expect(flag('german_roach_initial')).toBe(false);
    for (const k of ['pest_general_quarterly', 'german_roach', 'cockroach_control', 'palm_injection_semiannual']) {
      expect({ k, selectable: flag(k) }).toEqual({ k, selectable: true });
    }
    expect(JSON.parse(db.system_settings[0].value).hiddenIds).toEqual([1, 2]);
  });

  test('a rerun never re-hides a row an admin re-selected; down() is a no-op', async () => {
    const db = { services: [svc('pest_general_semiannual', 1), svc('german_roach_initial', 2)], system_settings: [] };
    const knex = fakeKnex(db);
    await hide.up(knex);
    db.services[0].public_quote_selectable = true; // admin re-selected in the Service Library
    await hide.up(knex);
    expect(db.services[0].public_quote_selectable).toBe(true);
    expect(db.services[1].public_quote_selectable).toBe(false);
    await hide.down(knex);
    expect(db.services[1].public_quote_selectable).toBe(false);
    expect(db.system_settings).toHaveLength(1);
  });
});
