/**
 * 20260808070000 foam catalog rows (owner ruling 2026-08-08): foam_drill +
 * foam_recurring services rows keyed 1:1 to the pricing engine's service
 * keys, named EXACTLY as the estate labels them (engine line name /
 * reserved-slot label) so completion's exact-name fallback resolves rows
 * that carry no service_id, plus typed completion profiles
 * (service_report/termite_treatment) so a completed foam visit closes
 * under the termite report. booking_enabled stays FALSE — assessment-first.
 *
 * down() removes only what up() proved it inserted: services by recorded
 * UUID (admin-recreated same-key rows survive), profiles by key + the
 * insertion marker in notes.
 */
const migration = require('../models/migrations/20260808070000_foam_termite_catalog_rows');
const renameMigration = require('../models/migrations/20260825000010_service_name_suffix_renames');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');

const STATE_KEY = 'migration.20260808070000.state';

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      if (f.raw_null) return r[f.raw_null] === null || r[f.raw_null] === undefined;
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        // Emulates only the shapes the completion resolver and the
        // 20260825000010 rename migration use.
        if (/scheduled_date\s*>=\s*CURRENT_DATE/.test(sql)) {
          // Fake rows carry no scheduled_date; treat them all as future.
          return q;
        }
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        filters.push({ raw: { col: m[1], val: bindings[0] } });
        return q;
      },
      whereNull(col) {
        filters.push({ raw_null: col });
        return q;
      },
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
      insert: (row) => {
        // Prod assigns id via gen_random_uuid() default; mirror that, and
        // support knex's .returning('id') chain the migration relies on.
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(stored);
        const p = Promise.resolve([1]);
        p.returning = async (col) => [{ [col]: stored[col] }];
        return p;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  knex.fn = { now: () => new Date().toISOString() };
  return knex;
}

function emptyDb() {
  return {
    services: [],
    service_completion_profiles: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    service_addons: [],
    service_package_items: [],
  };
}

const svcRow = (db, key) => db.services.find((r) => r.service_key === key);
const profileRow = (db, key) => db.service_completion_profiles.find((r) => r.service_key === key);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};
const stateServiceKeys = (db) => (stateValue(db)?.services || []).map((s) => s.key).sort();

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
    expect(stateServiceKeys(db)).toEqual(['foam_drill', 'foam_recurring']);
    expect((stateValue(db).services || []).every((s) => s.id)).toBe(true);
    expect(stateValue(db).profiles.sort()).toEqual(['foam_drill', 'foam_recurring']);
  });

  test('catalog names are EXACTLY the estate labels, so name-fallback resolution works', async () => {
    const sp = require('../services/pricing-engine');
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // The 2026-08-25 rename pass carries the pair to their current names;
    // engine labels and the slot-reservation literal moved in the same PR,
    // so the exact-name contract this test pins holds through both.
    await renameMigration.up(fakeKnex(db));

    // One-time bookings schedule under the raw engine line name.
    expect(svcRow(db, 'foam_drill').name).toBe(sp.priceFoamDrill(10, {}).name);
    expect(svcRow(db, 'foam_drill').name).toBe('Termite Foam Service');
    // Reserved-slot rows schedule under slot-reservation's label for
    // foam_recurring — pinned literally because serviceTypeForKey is
    // module-private ('Recurring Termite Foam Service', slot-reservation.js).
    expect(svcRow(db, 'foam_recurring').name).toBe('Recurring Termite Foam Service');
  });

  test('END-TO-END: a reserved foam visit with NO service_id resolves the typed termite profile by name', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await renameMigration.up(fakeKnex(db));

    // Current labels AND the pre-rename legacy labels (holds created before
    // the rename can commit after it) must all resolve the typed profile.
    for (const label of [
      'Recurring Termite Foam Service', 'Termite Foam Service',
      'Recurring Foam Treatment', 'Drill-and-Foam Termite',
    ]) {
      const resolved = await resolveCompletionProfileForScheduledService(
        { service_type: label },
        fakeKnex(db),
      );
      expect(resolved).toMatchObject({
        completionMode: 'service_report',
        findingsType: 'termite_treatment',
        category: 'termite',
      });
      expect(['foam_drill', 'foam_recurring']).toContain(resolved.serviceKey);
    }
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
    // is_active: true mirrors prod — the column default fills it on any
    // real insert; the heal path requires explicit true.
    const adminRow = { id: 'admin-foam', service_key: 'foam_drill', name: 'Adam Custom Foam', category: 'termite', is_active: true };
    db.services.push({ ...adminRow });
    await migration.up(fakeKnex(db));

    expect(svcRow(db, 'foam_drill')).toMatchObject(adminRow);
    // Profile healed for the admin row, snapshotting ITS name.
    expect(profileRow(db, 'foam_drill')).toMatchObject({ service_name_snapshot: 'Adam Custom Foam' });
    // State claims only what up() actually inserted.
    expect(stateServiceKeys(db)).toEqual(['foam_recurring']);
    expect(stateValue(db).profiles.sort()).toEqual(['foam_drill', 'foam_recurring']);
  });

  test('up() never attaches a profile to a row that is not explicitly active', async () => {
    const db = emptyDb();
    db.services.push({ id: 'inactive-foam', service_key: 'foam_drill', name: 'Foam Drill', is_active: false });
    // NULL is_active reads as inactive in every catalog filter, and profile
    // resolution never re-checks active state — literal-false-only would
    // leak an auto_send profile onto a NULL-active row (codex r5 P2).
    db.services.push({ id: 'null-active-foam', service_key: 'foam_recurring', name: 'Recurring Foam', is_active: null });
    await migration.up(fakeKnex(db));

    expect(db.service_completion_profiles).toHaveLength(0);
    expect(stateValue(db)).toEqual({ services: [], profiles: [] });
  });

  test('up() never attaches a profile to an archived row even when it is active', async () => {
    const db = emptyDb();
    db.services.push({ id: 'archived-foam', service_key: 'foam_drill', name: 'Foam Drill', is_active: true, is_archived: true });
    await migration.up(fakeKnex(db));

    expect(profileRow(db, 'foam_drill')).toBeUndefined();
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
    expect(stateServiceKeys(db)).toEqual(['foam_drill', 'foam_recurring']);
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

  test('down() spares a same-key row an admin deleted and RECREATED after up() — UUID mismatch', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // Admin deletes the migration's row and creates their own replacement
    // under the same key (new UUID), and replaces the profile (no marker).
    db.services = db.services.filter((r) => r.service_key !== 'foam_drill');
    db.services.push({ id: 'admin-replacement', service_key: 'foam_drill', name: 'Adam Foam v2' });
    const profile = profileRow(db, 'foam_drill');
    profile.notes = 'admin rebuilt this profile';
    db.scheduled_services.push({ id: 'v1', service_id: 'admin-replacement' });

    await migration.down(fakeKnex(db));

    // The replacement row, its profile, and its FK link all survive.
    expect(svcRow(db, 'foam_drill')).toMatchObject({ id: 'admin-replacement' });
    expect(profileRow(db, 'foam_drill')).toBeDefined();
    expect(db.scheduled_services[0].service_id).toBe('admin-replacement');
    // The other key's recorded row still rolled back normally.
    expect(svcRow(db, 'foam_recurring')).toBeUndefined();
    expect(profileRow(db, 'foam_recurring')).toBeUndefined();
  });

  test('down() retains a service (row AND profile) that an admin wired into an add-on or package — CASCADE guard', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // Admin pairs foam_drill as an add-on and packages foam_recurring;
    // services deletion would CASCADE through both tables (codex r5 P0).
    db.service_addons.push({ id: 'pair-1', parent_service_id: 'other-svc', addon_service_id: svcRow(db, 'foam_drill').id });
    db.service_package_items.push({ id: 'pkg-1', service_id: svcRow(db, 'foam_recurring').id });

    await migration.down(fakeKnex(db));

    // Both wired services survive with their profiles and FK links intact.
    expect(svcRow(db, 'foam_drill')).toBeDefined();
    expect(svcRow(db, 'foam_recurring')).toBeDefined();
    expect(profileRow(db, 'foam_drill')).toBeDefined();
    expect(profileRow(db, 'foam_recurring')).toBeDefined();
    expect(db.service_addons).toHaveLength(1);
    expect(db.service_package_items).toHaveLength(1);
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
    expect(stateServiceKeys(db)).toEqual(['foam_drill', 'foam_recurring']);
    expect(stateValue(db).profiles).toEqual([]);
  });
});
