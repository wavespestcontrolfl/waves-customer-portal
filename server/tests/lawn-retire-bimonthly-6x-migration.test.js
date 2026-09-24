/**
 * 20260924000010 — retire the 6x/bi-monthly residential lawn tier for NEW
 * sales (owner directive 2026-09-24).
 *
 * Half 1: pricing_config lawn_pricing_v2.tiers.standard → hidden (reversible,
 * mirrors 20260709000050's tiers.basic shape).
 * Half 2: services.public_quote_selectable=false for lawn_care_recurring only
 * (mirrors 20260903000020's seed-once / state-tracked / no-op-down contract —
 * see public-quote-menu-tier-c-hide.test.js, whose fake-knex pattern this
 * extends with the pricing_config upsert).
 */
const migration = require('../models/migrations/20260924000010_lawn_retire_bimonthly_6x');

function fakeKnex(db) {
  const rows = (table) => (db[table] = db[table] || []);
  const knex = (table) => {
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond, val) {
        if (typeof cond === 'string') filters.push((r) => r[cond] === val);
        else filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      select() { return Promise.resolve(rows(table).filter(matches).map((r) => ({ ...r }))); },
      async first() { const r = rows(table).find(matches); return r ? { ...r } : null; },
      async update(patch) {
        let n = 0;
        for (const r of rows(table)) if (matches(r)) { Object.assign(r, patch); n++; }
        return n;
      },
      async del() {
        const keep = rows(table).filter((r) => !matches(r));
        const n = rows(table).length - keep.length;
        db[table] = keep;
        return n;
      },
      // Plain `await insert(row)` appends; `insert(row).onConflict(col).merge(fields)`
      // upserts on that column (the pricing_config write path).
      insert(row) {
        let settled = false;
        const append = () => { if (!settled) { settled = true; rows(table).push({ ...row }); } return [row]; };
        return {
          then(resolve, reject) { return Promise.resolve().then(append).then(resolve, reject); },
          onConflict(col) {
            return {
              async merge(fields) {
                settled = true;
                const existing = rows(table).find((r) => r[col] === row[col]);
                if (!existing) { rows(table).push({ ...row }); return; }
                for (const f of fields) existing[f] = row[f];
              },
            };
          },
        };
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => ['pricing_config', 'pricing_config_audit', 'pricing_changelog', 'services', 'system_settings'].includes(t),
    hasColumn: async () => true,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (key, id, selectable = true) => ({ id, service_key: key, public_quote_selectable: selectable });

function seededDb() {
  return {
    pricing_config: [{
      config_key: 'lawn_pricing_v2',
      name: 'Lawn Pricing V2 Dense 35% Floor',
      data: JSON.stringify({
        pricingVersion: 'LAWN_PRICING_V2_EDGE_PARITY',
        programMinimumMonthly: 0,
        tiers: {
          basic: { label: '4x applications/yr', hidden: true, customerFacing: false },
          standard: { label: '6x applications/yr', applicationsPerYear: 6, customerFacing: true },
          enhanced: { label: '9x applications/yr', applicationsPerYear: 9, customerFacing: true },
          premium: { label: '12x applications/yr', applicationsPerYear: 12, customerFacing: true },
        },
      }),
    }],
    pricing_config_audit: [],
    pricing_changelog: [],
    services: [
      svc('lawn_care_recurring', 1),
      svc('lawn_care_6week', 2),
      svc('lawn_care_monthly', 3),
      svc('lawn_care_one_time', 4),
      svc('pest_general_bimonthly', 5),
    ],
    system_settings: [],
  };
}

const lawnData = (db) => JSON.parse(db.pricing_config.find((r) => r.config_key === 'lawn_pricing_v2').data);
const selectableFlag = (db, key) => db.services.find((r) => r.service_key === key).public_quote_selectable;

describe('20260924000010 retire the 6x/bi-monthly lawn tier for new sales', () => {
  test('up hides tiers.standard only — every other lawn_pricing_v2 key and tier survives untouched', async () => {
    const db = seededDb();
    const before = lawnData(db);
    await migration.up(fakeKnex(db));
    const after = lawnData(db);

    expect(after.tiers.standard).toEqual({
      label: '6x applications/yr', applicationsPerYear: 6, customerFacing: false, hidden: true,
    });
    expect(after.tiers.basic).toEqual(before.tiers.basic);
    expect(after.tiers.enhanced).toEqual(before.tiers.enhanced);
    expect(after.tiers.premium).toEqual(before.tiers.premium);
    expect(after.pricingVersion).toBe(before.pricingVersion);
    expect(after.programMinimumMonthly).toBe(0);

    expect(db.pricing_config_audit).toHaveLength(1);
    expect(JSON.parse(db.pricing_config_audit[0].new_value))
      .toEqual({ tiers: { standard: { customerFacing: false, hidden: true } } });
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('up leaves the bi-monthly lawn catalog row off the public quote menu; sold lawn cadences and bi-monthly PEST stay', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    expect(migration.SERVICE_KEY).toBe('lawn_care_recurring');
    expect(selectableFlag(db, 'lawn_care_recurring')).toBe(false);
    for (const key of ['lawn_care_6week', 'lawn_care_monthly', 'lawn_care_one_time', 'pest_general_bimonthly']) {
      expect({ key, selectable: selectableFlag(db, key) }).toEqual({ key, selectable: true });
    }
    const state = db.system_settings.find((r) => r.key === 'migration.20260924000010.state');
    expect(JSON.parse(state.value).hiddenIds).toEqual([1]);
  });

  test('a rerun is idempotent and never re-hides a row an admin re-selected', async () => {
    const db = seededDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.services[0].public_quote_selectable = true; // admin re-selected in the Service Library
    await migration.up(knex);
    expect(selectableFlag(db, 'lawn_care_recurring')).toBe(true);
    expect(lawnData(db).tiers.standard.hidden).toBe(true);
    expect(db.pricing_changelog).toHaveLength(1); // changelog identity dedupes
    expect(db.system_settings).toHaveLength(1);
  });

  test('down re-enables the 6x tier explicitly (in-code default is hidden too) and leaves the catalog flag alone', async () => {
    const db = seededDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    const after = lawnData(db);
    expect(after.tiers.standard).toEqual(expect.objectContaining({ customerFacing: true, hidden: false }));
    expect(after.tiers.enhanced).toEqual(lawnData(seededDb()).tiers.enhanced);
    expect(db.pricing_changelog).toHaveLength(0);
    expect(db.pricing_config_audit).toHaveLength(2);
    // Documented no-op: a still-false row can't be told apart from an admin
    // deselection; the state row is kept so a later up() stays idempotent.
    expect(selectableFlag(db, 'lawn_care_recurring')).toBe(false);
    expect(db.system_settings).toHaveLength(1);
  });

  test('up on a DB with no lawn_pricing_v2 row still writes the hidden flag (fresh env)', async () => {
    const db = { ...seededDb(), pricing_config: [] };
    await migration.up(fakeKnex(db));
    expect(lawnData(db).tiers.standard).toEqual(expect.objectContaining({ hidden: true, customerFacing: false }));
  });
});
