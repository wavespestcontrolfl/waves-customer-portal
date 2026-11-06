/**
 * 20261106150000 — lawn $55 minimum per visit after discounts (owner 2026-11-06)
 * plus the retirement of the cost-plus list-side $55 minimum. Fake-knex pattern
 * from lawn-cost-plus-list-migration.test.js; Postgres only runs it in CI.
 */
const migration = require('../models/migrations/20261106150000_lawn_minimum_per_visit_after_discount');

function fakeKnex(db) {
  const rows = (table) => (db[table] = db[table] || []);
  const knex = (table) => {
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate() { return q; },
      async first() { const r = rows(table).find(matches); return r ? { ...r } : null; },
      async update(patch) { for (const r of rows(table)) if (matches(r)) Object.assign(r, patch); },
      async del() { db[table] = rows(table).filter((r) => !matches(r)); },
      async insert(row) { rows(table).push({ ...row }); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => ['pricing_config', 'pricing_config_audit', 'pricing_changelog'].includes(t) };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const costPlusList = (minimumPerVisit) => ({ listMargin: 0.45, minimumPerVisit, spotMinutesPerVisit: 10, materialPer1000SqftPerYear: { 6: 16.33, 9: 24.5, 12: 29.84 } });
const baseData = { programMinimumMonthly: 0, useLawnCostFloor: false, costPlusList: costPlusList(55) };
const seeded = (data = baseData) => ({ pricing_config: [{ config_key: 'lawn_pricing_v2', data: JSON.stringify(data) }] });
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('lawn minimum per visit after discounts migration', () => {
  test('up adds the $55 minimum, retires the seeded cost-plus $55, keeps other keys, and audits once', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(stored(db)).toEqual({ ...baseData, minimumPerVisitAfterDiscount: 55, costPlusList: costPlusList(0) });
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({ config_key: 'lawn_pricing_v2', changed_by: 'migration:20261106150000' });
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('up leaves admin edits alone: a set minimum and a re-tuned cost-plus minimum', async () => {
    const edited = { ...baseData, minimumPerVisitAfterDiscount: 60, costPlusList: costPlusList(58) };
    const db = seeded(edited);
    await migration.up(fakeKnex(db));
    expect(stored(db)).toEqual(edited);
    expect(db.pricing_config_audit).toBeUndefined();
  });

  test('up is a no-op without the row', async () => {
    const db = { pricing_config: [] };
    await migration.up(fakeKnex(db));
    expect(db.pricing_config).toEqual([]);
  });

  test('down restores exactly what up changed', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(stored(db)).toEqual(baseData);
    expect(db.pricing_config_audit).toHaveLength(2);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('down keeps a minimum the admin changed after up', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    db.pricing_config[0].data = JSON.stringify({ ...stored(db), minimumPerVisitAfterDiscount: 60 });
    await migration.down(fakeKnex(db));
    expect(stored(db).minimumPerVisitAfterDiscount).toBe(60);
    expect(stored(db).costPlusList.minimumPerVisit).toBe(55);
  });
});
