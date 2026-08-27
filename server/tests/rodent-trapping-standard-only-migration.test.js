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
    const match = (r) => filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v));
    const q = {
      where(a, b) { filters.push(typeof a === 'string' ? { [a]: b } : a); return q; },
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
      data: { base: 350, standard_price: 375, unlimited_price: 450, upgrade_to_unlimited_price: 125, additional_followup_rate: 125, included_followups: 2, home_size_adjustments: [{ max_sqft: 1200, adjustment: 0 }], lot_adjustments: [{ max_lot_sqft: 10000, adjustment: 0 }], pressure_adjustments: { light: 0 } },
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
    // An admin-changed standard_price is pinned back to the $350 directive.
    expect(data.standard_price).toBe(350);
    expect(data.unlimited_price).toBeUndefined();
    // The ignored adjustment tables are retired too (codex #3521 r8 P2).
    expect(data.home_size_adjustments).toBeUndefined();
    expect(data.lot_adjustments).toBeUndefined();
    expect(data.pressure_adjustments).toBeUndefined();
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
    // Not the constant guess — the copy the row really had.
    expect(trapSvc(db).description).toBe(PRIOR_DESCRIPTION);
    expect(db.pricing_changelog).toHaveLength(0);
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
    trapCfg(db).data = { base: 350, standard_price: 350, included_followups: 'unlimited' };
    await migration.up(fakeKnex(db));
    expect(JSON.parse(trapCfg(db).data)).toEqual({ base: 350, standard_price: 350, included_followups: 'unlimited' });
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
    trapCfg(db).data = { base: 350, standard_price: 350, included_followups: 'unlimited' };
    trapSvc(db).description = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
    await migration.up(fakeKnex(db));
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });
});
