/**
 * 20260826000001: Standard-only trapping. Rollback must restore the catalog
 * description the row ACTUALLY carried before up() (captured in the audit
 * row), value-guarded so a later admin edit survives (codex #3521 r2 P2).
 */
const migration = require('../models/migrations/20260826000001_rodent_trapping_standard_only');

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((cond) => {
      if (cond.__op) { const [col, op, val] = cond.__op; return op === '>' ? Number(r[col]) > Number(val) : r[col] === val; }
      if (cond.__like) { const [col, pat] = cond.__like; return String(r[col] || '').startsWith(String(pat).replace(/%$/, '')); }
      return Object.entries(cond).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(a, b, c) {
        if (typeof a === 'string' && c !== undefined) { filters.push({ __op: [a, b, c] }); return q; }
        filters.push(typeof a === 'string' ? { [a]: b } : a); return q;
      },
      whereLike(col, pattern) { filters.push({ __like: [col, pattern] }); return q; },
      orderBy() { return q; },
      first: async () => { const rows = rowsNow().filter(match); const hit = rows[rows.length - 1]; return hit ? { ...hit } : undefined; },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: async (row) => { (db[table] = rowsNow()).push({ id: rowsNow().length + 1, ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const PRIOR_DESCRIPTION = 'Admin-authored trapping copy that predates the Standard-only change.';

function seedDb() {
  return {
    pricing_config: [{
      id: 'pc-trap',
      config_key: 'rodent_trapping',
      name: 'Adam Trapping (custom name)',
      data: { base: 350, floor: 350, ceiling_before_custom: 795, active_window_days: null, standard_price: 375, unlimited_price: 450, upgrade_to_unlimited_price: 125, additional_followup_rate: 125, included_followups: 2, home_size_adjustments: [{ max_sqft: 1200, adjustment: 0 }], lot_adjustments: [{ max_lot_sqft: 10000, adjustment: 0 }], pressure_adjustments: { light: 0 } },
    }],
    pricing_config_audit: [],
    pricing_changelog: [],
    services: [{ id: 'svc-trap', service_key: 'rodent_trapping', description: PRIOR_DESCRIPTION }],
  };
}
const trapSvc = (db) => db.services[0];
const trapCfg = (db) => db.pricing_config[0];

describe('20260826000001 rodent trapping Standard-only', () => {
  test('up() retires the plan keys and rewrites the catalog copy; down() restores the ACTUAL prior copy', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const data = JSON.parse(trapCfg(db).data);
    expect(data.included_followups).toBe('unlimited');
    // standard_price is retired: the $350 plan is fixed in code (one dollar authority).
    expect(data.standard_price).toBeUndefined();
    expect(data.unlimited_price).toBeUndefined();
    // The ignored adjustment tables are retired too (codex #3521 r8 P2).
    expect(data.home_size_adjustments).toBeUndefined();
    expect(data.lot_adjustments).toBeUndefined();
    expect(data.pressure_adjustments).toBeUndefined();
    expect(data.base).toBeUndefined();
    expect(data.floor).toBeUndefined();
    expect(data.ceiling_before_custom).toBeUndefined();
    expect(trapSvc(db).description).toMatch(/unlimited callbacks\/checks for the same active trapping job/);
    expect(db.pricing_config_audit).toHaveLength(1);

    await migration.down(fakeKnex(db));
    const restored = JSON.parse(trapCfg(db).data);
    expect(restored.unlimited_price).toBe(450);
    expect(restored.included_followups).toBe(2);
    expect(restored.standard_price).toBe(375);
    // The pricing-row name goes back to its actual predecessor, not a constant.
    expect(trapCfg(db).name).toBe('Adam Trapping (custom name)');
    expect(restored.home_size_adjustments).toEqual([{ max_sqft: 1200, adjustment: 0 }]);
    expect(restored.pressure_adjustments).toEqual({ light: 0 });
    expect(restored.base).toBe(350);
    expect(restored.ceiling_before_custom).toBe(795);
    // Not the constant guess — the copy the row really had.
    expect(trapSvc(db).description).toBe(PRIOR_DESCRIPTION);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('admin pricing edits made AFTER up() survive rollback (value-guarded restores)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const edited = JSON.parse(trapCfg(db).data);
    edited.included_followups = 3;        // admin re-limited callbacks after the migration
    edited.unlimited_price = 500;         // and re-added a retired key on purpose
    trapCfg(db).data = edited;
    await migration.down(fakeKnex(db));
    const after = JSON.parse(trapCfg(db).data);
    expect(after.included_followups).toBe(3);
    expect(after.unlimited_price).toBe(500);
    // Untouched retired keys still come back from the audit row.
    expect(after.upgrade_to_unlimited_price).toBe(125);
  });

  test('down() leaves a catalog description an admin edited after up()', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    trapSvc(db).description = 'Edited after the migration ran.';
    await migration.down(fakeKnex(db));
    expect(trapSvc(db).description).toBe('Edited after the migration ran.');
  });

  test('a pricing row already at target STILL aligns the catalog copy, and down() restores it', async () => {
    const db = seedDb();
    trapCfg(db).data = { included_followups: 'unlimited', emergency_multiplier: 1.2 };
    await migration.up(fakeKnex(db));
    expect(JSON.parse(trapCfg(db).data)).toEqual({ included_followups: 'unlimited', emergency_multiplier: 1.2 });
    expect(trapSvc(db).description).toMatch(/unlimited callbacks\/checks for the same active trapping job/);
    expect(db.pricing_config_audit).toHaveLength(1);
    // Description-only up() never renamed the pricing row …
    expect(trapCfg(db).name).toBe('Adam Trapping (custom name)');
    await migration.down(fakeKnex(db));
    expect(trapSvc(db).description).toBe(PRIOR_DESCRIPTION);
    // … and rollback leaves the name alone too.
    expect(trapCfg(db).name).toBe('Adam Trapping (custom name)');
  });

  test('everything already at target is a true no-op', async () => {
    const db = seedDb();
    trapCfg(db).data = { included_followups: 'unlimited', emergency_multiplier: 1.2 };
    trapSvc(db).description = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
    await migration.up(fakeKnex(db));
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('a no-op reapplication after a rollback never consumes the earlier cycle\'s audit row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(JSON.parse(trapCfg(db).data).unlimited_price).toBe(450);
    // Everything now made current by hand; the re-run is a no-op.
    trapCfg(db).data = { included_followups: 'unlimited', emergency_multiplier: 1.2 };
    trapSvc(db).description = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    // Cycle 1's retired keys must NOT come back onto a row this cycle never
    // touched (the no-op cycle never rewrote the row, so data is still the
    // object the test set).
    const after = typeof trapCfg(db).data === 'string' ? JSON.parse(trapCfg(db).data) : trapCfg(db).data;
    expect(after.unlimited_price).toBeUndefined();
    expect(after.included_followups).toBe('unlimited');
  });
});
