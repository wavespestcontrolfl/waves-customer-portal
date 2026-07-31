/**
 * 20260730160000 roach catalog cleanup (owner directive 2026-07-30, follow-up
 * to #3078): rename cockroach_control to the estimate's customer-facing name,
 * archive the two never-booked pest_initial_*_knockdown rows, and backfill
 * open-visit / completion-profile label snapshots. Ownership is RECORDED in a
 * system_settings state row (codex #3108 r1) — down() restores only what
 * up() proved it changed, so pre-migration admin renames/archives and
 * pre-hidden flags survive a rollback, and history keeps its labels.
 */
const migration = require('../models/migrations/20260730160000_roach_catalog_rename_archive');

const OLD_NAME = 'Cockroach Control Service';
const NEW_NAME = 'Cockroach Treatment';
const STATE_KEY = 'migration.20260730160000.state';
const LIVE = { is_active: true, is_archived: false, booking_enabled: true, customer_visible: true };
const ARCHIVED = { is_active: false, is_archived: true, booking_enabled: false, customer_visible: false };

function seedDb() {
  return {
    services: [
      { service_key: 'cockroach_control', name: OLD_NAME, short_name: 'Cockroach Control', ...LIVE, updated_at: 'orig' },
      { service_key: 'pest_initial_palmetto_knockdown', name: 'Initial Native Roach Knockdown Service', short_name: null, ...LIVE, updated_at: 'orig' },
      { service_key: 'pest_initial_german_knockdown', name: 'Initial German Roach Knockdown Service', short_name: null, ...LIVE, updated_at: 'orig' },
      { service_key: 'general_pest', name: 'General Pest Control', short_name: 'General Pest', ...LIVE, updated_at: 'orig' },
    ],
    scheduled_services: [
      { id: 'v-open-1', service_type: OLD_NAME, status: 'pending' },
      { id: 'v-open-2', service_type: OLD_NAME, status: 'confirmed' },
      { id: 'v-done', service_type: OLD_NAME, status: 'completed' },
      { id: 'v-other', service_type: 'Lawn Care Service', status: 'pending' },
    ],
    service_completion_profiles: [
      { service_key: 'cockroach_control', service_name_snapshot: OLD_NAME },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const inClauses = [];
    const notInClauses = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => (
      inClauses.every((c) => c.vals.includes(r[c.col]))
      && notInClauses.every((c) => !c.vals.includes(r[c.col]))
      && filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v))
    );
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notInClauses.push({ col, vals }); return q; },
      select(...cols) {
        return Promise.resolve(rowsNow().filter(rowMatch).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => { out[c] = r[c]; });
          return out;
        }));
      },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: async (row) => {
        (db[table] = rowsNow()).push({ ...row });
        return [1];
      },
      then(resolve, reject) {
        return Promise.resolve(rowsNow().filter(rowMatch).map((r) => ({ ...r }))).then(resolve, reject);
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const byKey = (db, key) => db.services.find((r) => r.service_key === key);
const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260730160000 roach catalog rename + archive', () => {
  test('up() renames, archives, backfills open snapshots, and records ownership', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(byKey(db, 'cockroach_control')).toMatchObject({ name: NEW_NAME, short_name: NEW_NAME, updated_at: 'NOW' });
    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      expect(byKey(db, key)).toMatchObject(ARCHIVED);
      // Archive never renames — descriptions/history keep the original label.
      expect(byKey(db, key).name).toMatch(/Knockdown Service$/);
    }
    expect(byKey(db, 'general_pest')).toMatchObject({ name: 'General Pest Control', ...LIVE, updated_at: 'orig' });

    // Open visits renamed; completed history and other services untouched.
    expect(visit(db, 'v-open-1').service_type).toBe(NEW_NAME);
    expect(visit(db, 'v-open-2').service_type).toBe(NEW_NAME);
    expect(visit(db, 'v-done').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-other').service_type).toBe('Lawn Care Service');
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(NEW_NAME);

    const state = JSON.parse(stateRow(db).value);
    expect(state.renamedFields.sort()).toEqual(['name', 'short_name']);
    expect(Object.keys(state.archived).sort()).toEqual(['pest_initial_german_knockdown', 'pest_initial_palmetto_knockdown']);
    expect(state.archived.pest_initial_palmetto_knockdown).toEqual({ booking_enabled: true, customer_visible: true });
    expect(state.backfilledVisitIds.sort()).toEqual(['v-open-1', 'v-open-2']);
    expect(state.profileSnapshotUpdated).toBe(true);
  });

  test('up() drift guards: pre-renamed field and pre-archived row are neither touched nor claimed', async () => {
    const db = seedDb();
    // Admin already renamed the service themselves and archived one row
    // before the deploy; the other row was live but admin-hidden.
    byKey(db, 'cockroach_control').name = NEW_NAME;
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    byKey(db, 'pest_initial_palmetto_knockdown').booking_enabled = false;

    await migration.up(fakeKnex(db));

    const state = JSON.parse(stateRow(db).value);
    // Only short_name was actually changed — name is not claimed.
    expect(state.renamedFields).toEqual(['short_name']);
    // The pre-archived row is not claimed; the hidden flag is recorded as-is.
    expect(Object.keys(state.archived)).toEqual(['pest_initial_palmetto_knockdown']);
    expect(state.archived.pest_initial_palmetto_knockdown).toEqual({ booking_enabled: false, customer_visible: true });
    expect(byKey(db, 'pest_initial_german_knockdown').updated_at).toBe('orig');
  });

  test('down() restores exactly the recorded state and deletes the record', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // A visit booked AFTER the migration carries the new label organically —
    // it is not in the recorded ids and must keep it through rollback.
    db.scheduled_services.push({ id: 'v-post', service_type: NEW_NAME, status: 'pending' });

    await migration.down(knex);

    expect(byKey(db, 'cockroach_control')).toMatchObject({ name: OLD_NAME, short_name: 'Cockroach Control' });
    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      expect(byKey(db, key)).toMatchObject(LIVE);
    }
    expect(visit(db, 'v-open-1').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-open-2').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-post').service_type).toBe(NEW_NAME);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(OLD_NAME);
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() restores recorded prior flags, not blanket true (codex #3108 r1)', async () => {
    const db = seedDb();
    // Live but admin-hidden before the migration: booking_enabled=false.
    byKey(db, 'pest_initial_palmetto_knockdown').booking_enabled = false;
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject({
      is_active: true,
      is_archived: false,
      booking_enabled: false, // the recorded prior value — never blanket-restored
      customer_visible: true,
    });
  });

  test('down() leaves pre-archived rows and pre-renamed fields alone (codex #3108 r1)', async () => {
    const db = seedDb();
    // Admin renamed to the new name AND archived a row BEFORE up() ran.
    byKey(db, 'cockroach_control').name = NEW_NAME;
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    // The admin's own rename is NOT reverted to the legacy value…
    expect(byKey(db, 'cockroach_control').name).toBe(NEW_NAME);
    // …while the field up() did change rolls back.
    expect(byKey(db, 'cockroach_control').short_name).toBe('Cockroach Control');
    // The admin-archived row stays archived — up() never claimed it.
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(ARCHIVED);
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject(LIVE);
  });

  test('down() leaves post-migration admin edits alone', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // After the migration ran, the admin renamed again and re-activated a row.
    byKey(db, 'cockroach_control').name = 'Roach Rescue';
    byKey(db, 'pest_initial_palmetto_knockdown').is_active = true;

    await migration.down(knex);

    expect(byKey(db, 'cockroach_control').name).toBe('Roach Rescue');
    expect(byKey(db, 'cockroach_control').short_name).toBe('Cockroach Control');
    // Not in the archived state down() owns — left exactly as the admin set it.
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject({ is_active: true, is_archived: true });
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(LIVE);
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    // Simulate the archived-looking state WITHOUT up() having recorded it.
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    byKey(db, 'cockroach_control').name = NEW_NAME;

    await migration.down(fakeKnex(db));

    expect(byKey(db, 'cockroach_control').name).toBe(NEW_NAME);
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(ARCHIVED);
  });

  test('up() and down() no-op without the services table; up() tolerates a missing system_settings table', async () => {
    const db = seedDb();
    const noServices = fakeKnex(db, { missingTables: ['services'] });
    await migration.up(noServices);
    await migration.down(noServices);
    expect(byKey(db, 'cockroach_control').name).toBe(OLD_NAME);

    // Without system_settings the rename/archive still applies; down() then
    // has no record and correctly restores nothing.
    const db2 = seedDb();
    delete db2.system_settings;
    const knex2 = fakeKnex(db2);
    await migration.up(knex2);
    expect(byKey(db2, 'cockroach_control').name).toBe(NEW_NAME);
    await migration.down(knex2);
    expect(byKey(db2, 'cockroach_control').name).toBe(NEW_NAME);
  });
});
