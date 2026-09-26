/**
 * 20260927000001: $350 trapping covers setup + 1 trap check; visit 3+ is the
 * new $95 rodent_trap_check_additional row (owner ruling 2026-09-26).
 * Value-guarded both ways; down() reverts only what up() recorded.
 */
const migration = require('../models/migrations/20260927000001_rodent_trap_check_additional');

const STATE_KEY = 'migration.20260927000001.state';
const PRIOR_ROW_NAME = 'Rodent Trapping (Standard — flat $350, unlimited callbacks)';
const PRIOR_TRAPPING_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
const PRIOR_FOLLOWUP_DESCRIPTION = 'Included callback/check for the same active trapping job — no charge. The Standard trapping plan includes unlimited callbacks; this row exists so the visit can be scheduled and reported, never billed.';
const PRIOR_FOLLOWUP_NOTES = 'Included callback under the Standard trapping plan (unlimited callbacks for the active job). Never billed; no packs.';

function fakeKnex(db) {
  let seq = 0;
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((f) => f(r));
    const q = {
      where(cond, val) {
        if (typeof cond === 'string') filters.push((r) => r[cond] === val);
        else filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      first: async () => { const hit = rowsNow().find(match); return hit ? { ...hit } : undefined; },
      pluck: async (col) => rowsNow().filter(match).map((r) => r[col]),
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert(row) {
        const created = { id: `${table}-${++seq}`, ...row };
        (db[table] = rowsNow()).push(created);
        const p = Promise.resolve([1]);
        p.returning = async () => [{ id: created.id }];
        return p;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async (t, c) => t in db && c !== 'not_a_column',
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seedDb = () => ({
  pricing_config: [{
    config_key: 'rodent_trapping',
    name: PRIOR_ROW_NAME,
    data: JSON.stringify({ included_followups: 'unlimited', emergency_multiplier: 1.2, emergency_minimum_surcharge: 75 }),
  }],
  pricing_config_audit: [],
  services: [
    { id: 'svc-trap', service_key: 'rodent_trapping', description: PRIOR_TRAPPING_DESCRIPTION },
    { id: 'svc-fu', service_key: 'rodent_trapping_followup', base_price: 0, description: PRIOR_FOLLOWUP_DESCRIPTION, internal_notes: PRIOR_FOLLOWUP_NOTES },
  ],
  service_completion_profiles: [{
    id: 'p-fu', service_key: 'rodent_trapping_followup', service_name_snapshot: 'Rodent Trapping Follow-Up Visit',
    billing_type: 'one_time', completion_mode: 'service_report', project_type: 'rodent_trapping', delivery_mode: 'auto_send',
    active: true, notes: '[rodent_graduation_action=graduated]',
  }],
  scheduled_services: [],
  service_records: [],
  system_settings: [],
});
const svc = (db, key) => db.services.find((r) => r.service_key === key);
const cfg = (db) => JSON.parse(db.pricing_config[0].data);

describe('20260927000001 rodent trap check additional', () => {
  test('up() sets 1 included check, rewrites copy, adds the $95 row + cloned profile; down() reverts all of it', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(cfg(db)).toMatchObject({ included_followups: 1, emergency_multiplier: 1.2 });
    expect(db.pricing_config[0].name).not.toMatch(/unlimited/);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(svc(db, 'rodent_trapping').description).toMatch(/setup visit plus 1 trap check/);
    expect(svc(db, 'rodent_trapping_followup')).toMatchObject({ base_price: 0 });
    expect(svc(db, 'rodent_trapping_followup').description).not.toMatch(/unlimited/);

    const added = svc(db, 'rodent_trap_check_additional');
    expect(added).toMatchObject({ name: 'Rodent Trap Check - Additional', base_price: 95, pricing_type: 'fixed', billing_type: 'one_time' });
    const profile = db.service_completion_profiles.find((r) => r.service_key === 'rodent_trap_check_additional');
    expect(profile).toMatchObject({ project_type: 'rodent_trapping', delivery_mode: 'auto_send', billing_type: 'one_time' });
    expect(profile.notes).not.toMatch(/rodent_graduation_action/);

    await migration.down(fakeKnex(db));
    expect(cfg(db).included_followups).toBe('unlimited');
    expect(db.pricing_config[0].name).toBe(PRIOR_ROW_NAME);
    expect(svc(db, 'rodent_trapping').description).toBe(PRIOR_TRAPPING_DESCRIPTION);
    expect(svc(db, 'rodent_trapping_followup')).toMatchObject({ description: PRIOR_FOLLOWUP_DESCRIPTION, internal_notes: PRIOR_FOLLOWUP_NOTES });
    expect(svc(db, 'rodent_trap_check_additional')).toBeUndefined();
    expect(db.service_completion_profiles.map((r) => r.service_key)).toEqual(['rodent_trapping_followup']);
    expect(db.system_settings).toHaveLength(0);
  });

  test('admin-edited copy and an already-numeric included count are left alone', async () => {
    const db = seedDb();
    db.pricing_config[0].data = JSON.stringify({ included_followups: 3 });
    svc(db, 'rodent_trapping').description = 'Custom trapping copy';
    await migration.up(fakeKnex(db));
    expect(cfg(db).included_followups).toBe(3);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(svc(db, 'rodent_trapping').description).toBe('Custom trapping copy');
    await migration.down(fakeKnex(db));
    expect(cfg(db).included_followups).toBe(3);
    expect(svc(db, 'rodent_trapping').description).toBe('Custom trapping copy');
  });

  test('a re-run does not duplicate the row or clobber the recorded state', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const state = db.system_settings.find((r) => r.key === STATE_KEY).value;
    await migration.up(fakeKnex(db));
    expect(db.services.filter((r) => r.service_key === 'rodent_trap_check_additional')).toHaveLength(1);
    expect(db.system_settings.find((r) => r.key === STATE_KEY).value).toBe(state);
  });

  test('an existing row (admin-created) is never replaced or deleted on rollback', async () => {
    const db = seedDb();
    db.services.push({ id: 'svc-admin', service_key: 'rodent_trap_check_additional', base_price: 110 });
    await migration.up(fakeKnex(db));
    expect(svc(db, 'rodent_trap_check_additional').base_price).toBe(110);
    await migration.down(fakeKnex(db));
    expect(svc(db, 'rodent_trap_check_additional')).toMatchObject({ id: 'svc-admin', base_price: 110 });
  });

  test('missing tables are a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
