/**
 * 20260829000012 — archive rodent_monitoring (owner ruling 2026-08-29).
 * Mirrors deactivateService: skip while open visits reference the row,
 * ownership-recorded, down() restores only what up() archived.
 */
const migration = require('../models/migrations/20260829000012_archive_rodent_monitoring');
const STATE_KEY = 'migration.20260829000012.state';

function fakeKnex(db) {
  const knex = (table) => {
    let rows = db[table] || (db[table] = []);
    let filters = [];
    const matches = (r) => filters.every((f) => (typeof f === 'function' ? f(r) : Object.entries(f).every(([k, v]) => r[k] === v)));
    const q = {
      where(cond) {
        if (typeof cond === 'function') {
          let nullCol = null; let notIn = null;
          const sub = { whereNull(c) { nullCol = c; return sub; }, orWhereNotIn(c, vals) { notIn = { c, vals }; return sub; } };
          cond.call(sub);
          filters.push((r) => r[nullCol] == null || !notIn.vals.includes(r[notIn.c]));
        } else filters.push(cond);
        return q;
      },
      async first() { const r = rows.find(matches); return r ? { ...r } : null; },
      count() { return { async first() { return { n: rows.filter(matches).length }; } }; },
      async update(patch) { let n = 0; for (const r of rows) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async del() { const keep = rows.filter((r) => !matches(r)); n = rows.length - keep.length; db[table] = keep; return n; },
      async insert(row) { db[table].push({ ...row }); return [row]; },
    };
    let n = 0;
    return q;
  };
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seed = (over = {}) => ({
  services: [{ id: 'svc-rm', service_key: 'rodent_monitoring', name: 'Quarterly Rodent Monitoring Service', is_active: false, is_archived: false, ...over }],
  scheduled_services: [],
  audit_log: [],
  system_settings: [],
});

describe('20260829000012 archive rodent_monitoring', () => {
  test('archives the inactive row, writes an audit row, records ownership', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(db.services[0]).toMatchObject({ is_active: false, is_archived: true, updated_at: 'NOW' });
    expect(db.audit_log[0]).toMatchObject({ action: 'service_catalog.archive', resource_id: 'svc-rm' });
    expect(JSON.parse(db.system_settings[0].value)).toMatchObject({ archived: true, priorIsActive: false });
  });
  test('skips while an OPEN visit still references the row (NULL status counts as open)', async () => {
    const db = seed();
    db.scheduled_services.push({ id: 'v1', service_id: 'svc-rm', status: null });
    await migration.up(fakeKnex(db));
    expect(db.services[0].is_archived).toBe(false);
    expect(JSON.parse(db.system_settings[0].value)).toMatchObject({ archived: false, reason: 'open_visits', openVisits: 1 });
  });
  test('terminal visits do not block', async () => {
    const db = seed();
    db.scheduled_services.push({ id: 'v1', service_id: 'svc-rm', status: 'completed' });
    await migration.up(fakeKnex(db));
    expect(db.services[0].is_archived).toBe(true);
  });
  test('a row an admin already archived is untouched and down() leaves it archived', async () => {
    const db = seed({ is_archived: true });
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.services[0].is_archived).toBe(true);
    expect(db.audit_log).toHaveLength(0);
  });
  test('down() restores only what up() archived, preserving the prior active flag', async () => {
    const db = seed({ is_active: true });
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.services[0]).toMatchObject({ is_archived: false, is_active: true });
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
  });
  test('down() never re-exposes a row re-activated by an admin after up()', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    db.services[0].is_active = true; db.services[0].is_archived = false;
    await migration.down(fakeKnex(db));
    expect(db.services[0]).toMatchObject({ is_active: true, is_archived: false });
  });
});
