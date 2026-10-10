/**
 * 20261009150000 — seed lawn_pricing_v2.costPlusList (GATE_LAWN_COST_PLUS_LIST knobs).
 * Fake-knex pattern from lawn-retire-bimonthly-6x-migration.test.js. The real
 * SQL is plain knex read-modify-write on pricing_config (jsonb), the same calls
 * 20260808000002 (bermuda adder knobs) makes; Postgres only runs it in CI.
 */
const migration = require('../models/migrations/20261009150000_lawn_cost_plus_list_knobs');
const { LAWN_COST_PLUS_LIST_DEFAULTS } = require('../services/pricing-engine/constants');

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

const baseData = { programMinimumMonthly: 0, useLawnCostFloor: false, targetCollectedMarginFloor: 0.31, bermudaSuppression: { perAppBase: 20, perAppPer1000Sqft: 3 } };
const seeded = (data = baseData) => ({ pricing_config: [{ config_key: 'lawn_pricing_v2', data: JSON.stringify(data) }] });
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('lawn cost-plus list knobs migration', () => {
  test('up adds the knobs, keeps every existing key and edit, and audits', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    expect(stored(db)).toEqual({ ...baseData, costPlusList: LAWN_COST_PLUS_LIST_DEFAULTS });
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({ config_key: 'lawn_pricing_v2', changed_by: 'migration:20261009150000' });
    expect(JSON.parse(db.pricing_config_audit[0].old_value)).toEqual(baseData);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('up leaves an existing costPlusList (admin edit) alone and writes no audit', async () => {
    const edited = { ...baseData, costPlusList: { ...LAWN_COST_PLUS_LIST_DEFAULTS, listMargin: 0.5 } };
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

  test('up twice writes one audit row', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(db.pricing_config_audit).toHaveLength(1);
  });

  test('down removes only the untouched seeded key, keeps the rest, and audits', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(stored(db)).toEqual(baseData);
    expect(db.pricing_config_audit).toHaveLength(2);
    expect(db.pricing_config_audit[1].reason).toMatch(/Rollback/);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('down keeps an admin-edited costPlusList', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    const edited = { ...stored(db), costPlusList: { ...LAWN_COST_PLUS_LIST_DEFAULTS, minimumPerVisit: 60 } };
    db.pricing_config[0].data = JSON.stringify(edited);
    await migration.down(fakeKnex(db));
    expect(stored(db)).toEqual(edited);
  });

  test('down does nothing when up never wrote the key', async () => {
    const edited = { ...baseData, costPlusList: { ...LAWN_COST_PLUS_LIST_DEFAULTS } };
    const db = seeded(edited);
    await migration.down(fakeKnex(db));
    expect(stored(db)).toEqual(edited);
  });
});
