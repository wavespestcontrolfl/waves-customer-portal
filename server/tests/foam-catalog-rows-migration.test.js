/**
 * 20260808070000 foam catalog rows (owner ruling 2026-08-08): foam_drill +
 * foam_recurring services rows keyed 1:1 to the published pricing keys,
 * plus typed completion profiles (service_report/termite_treatment) so a
 * completed foam visit closes under the termite report, not the generic
 * fallback. booking_enabled stays FALSE — foam is assessment-first.
 *
 * down() must remove only what up() proved it inserted (state row), never
 * an admin-created row that happened to use the same key.
 */
const migration = require('../models/migrations/20260808070000_foam_termite_catalog_rows');
const { detectServiceCategory } = require('../utils/service-normalizer');

const STATE_KEY = 'migration.20260808070000.state';

function fakeKnex(db, { missingTables = [], missingColumns = {} } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      pluck: async (col) => rowsNow().filter(rowMatch).map((r) => r[col]),
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
        // Prod assigns id via gen_random_uuid() default; mirror that so
        // FK-pluck assertions can't pass on undefined === undefined.
        (db[table] = rowsNow()).push({ id: `${table}-${rowsNow().length + 1}`, ...row });
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => !(missingColumns[t] || []).includes(c) && t in db,
  };
  return knex;
}

function emptyDb() {
  return {
    services: [],
    service_completion_profiles: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
  };
}

const svcRow = (db, key) => db.services.find((r) => r.service_key === key);
const profileRow = (db, key) => db.service_completion_profiles.find((r) => r.service_key === key);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260808070000 foam catalog rows', () => {
  test('up() inserts both services rows keyed to the pricing keys, assessment-first and termite-typed', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    for (const key of ['foam_drill', 'foam_recurring']) {
      expect(svcRow(db, key)).toMatchObject({
        category: 'termite',
        booking_enabled: false,
        customer_visible: true,
        is_waveguard: false,
        is_active: true,
        is_archived: false,
      });
      expect(profileRow(db, key)).toMatchObject({
        completion_mode: 'service_report',
        project_type: 'termite_treatment',
        delivery_mode: 'auto_send',
        portal_visibility: 'token_only',
        portal_attach_policy: 'recurring_customer',
        active: true,
      });
    }
    expect(svcRow(db, 'foam_drill').billing_type).toBe('one_time');
    expect(svcRow(db, 'foam_recurring')).toMatchObject({
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
    });
    expect(stateValue(db)).toEqual({
      services: ['foam_drill', 'foam_recurring'],
      profiles: ['foam_drill', 'foam_recurring'],
    });
  });

  test('foam_recurring duration bounds cover every pricer tier, and NO default exists to clobber tier-accurate slots', async () => {
    const sp = require('../services/pricing-engine');
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const row = svcRow(db, 'foam_recurring');

    // The converter overwrites svc.estimatedDurationMinutes with any
    // non-null catalog default — foam slots are tier-priced (60–180 min),
    // so the catalog must not carry one.
    expect(row.default_duration_minutes).toBeNull();
    const smallest = sp.priceRecurringFoam(1, { cadence: 'quarterly' }).estimatedDurationMinutes;
    const largest = sp.priceRecurringFoam(20, { cadence: 'quarterly' }).estimatedDurationMinutes;
    expect(row.min_duration_minutes).toBeLessThanOrEqual(smallest);
    expect(row.max_duration_minutes).toBeGreaterThanOrEqual(largest);
    // The engine's key IS the catalog key — the converter resolves this row
    // by the service value the pricer returns.
    expect(sp.priceRecurringFoam(5, {}).service).toBe(row.service_key);
  });

  test('both catalog names classify as termite through the shared detector (the bug that started this lane)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    for (const key of ['foam_drill', 'foam_recurring']) {
      expect(detectServiceCategory(svcRow(db, key).name)).toBe('termite');
    }
  });

  test('up() never overwrites an admin-created services row, but still heals its missing profile', async () => {
    const db = emptyDb();
    const adminRow = { id: 'admin-foam', service_key: 'foam_drill', name: 'Adam Custom Foam', category: 'termite' };
    db.services.push({ ...adminRow });
    await migration.up(fakeKnex(db));

    expect(svcRow(db, 'foam_drill')).toMatchObject(adminRow);
    // Profile healed for the admin row, snapshotting ITS name.
    expect(profileRow(db, 'foam_drill')).toMatchObject({ service_name_snapshot: 'Adam Custom Foam' });
    // State claims only what up() actually inserted.
    expect(stateValue(db)).toEqual({
      services: ['foam_recurring'],
      profiles: ['foam_drill', 'foam_recurring'],
    });
  });

  test('up() never attaches a profile to an admin-deactivated or archived row', async () => {
    const db = emptyDb();
    db.services.push({ id: 'inactive-foam', service_key: 'foam_drill', name: 'Foam Drill', is_active: false });
    db.services.push({ id: 'archived-foam', service_key: 'foam_recurring', name: 'Recurring Foam', is_archived: true });
    await migration.up(fakeKnex(db));

    // Rows untouched, and neither gets an active auto_send profile that
    // would resurrect typed sends the admin turned off.
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(stateValue(db)).toEqual({ services: [], profiles: [] });
  });

  test('up() leaves an existing completion profile untouched', async () => {
    const db = emptyDb();
    db.service_completion_profiles.push({ service_key: 'foam_recurring', completion_mode: 'project_required', marker: 'admin' });
    await migration.up(fakeKnex(db));

    expect(profileRow(db, 'foam_recurring')).toMatchObject({ completion_mode: 'project_required', marker: 'admin' });
    expect(stateValue(db).profiles).toEqual(['foam_drill']);
  });

  test('up() is idempotent — a second run inserts nothing and preserves the first run\'s state', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(2);
    expect(db.service_completion_profiles).toHaveLength(2);
    // State unions across runs — run one's inserts stay removable by down().
    expect(stateValue(db)).toEqual({
      services: ['foam_drill', 'foam_recurring'],
      profiles: ['foam_drill', 'foam_recurring'],
    });
  });

  test('down() removes only state-recorded rows, nulls FKs, and clears the state row', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const foamId = svcRow(db, 'foam_drill').id;
    db.scheduled_services.push({ id: 'v1', service_id: foamId });
    db.service_records.push({ id: 'r1', service_id: foamId });

    await migration.down(fakeKnex(db));

    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(db.scheduled_services[0].service_id).toBe(null);
    expect(db.service_records[0].service_id).toBe(null);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() with no state row removes nothing — admin rows using the same keys survive', async () => {
    const db = emptyDb();
    db.services.push({ id: 'admin-foam', service_key: 'foam_drill', name: 'Adam Custom Foam' });
    db.service_completion_profiles.push({ service_key: 'foam_drill' });

    await migration.down(fakeKnex(db));

    expect(db.services).toHaveLength(1);
    expect(db.service_completion_profiles).toHaveLength(1);
  });

  test('up() survives an absent service_completion_profiles table and still records service inserts', async () => {
    const db = emptyDb();
    delete db.service_completion_profiles;
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(2);
    expect(stateValue(db)).toEqual({ services: ['foam_drill', 'foam_recurring'], profiles: [] });
  });
});
