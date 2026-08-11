/**
 * 20260811000010 semiannual palm injection catalog row (owner ruling
 * 2026-08-11: palm sells as 2 visits/year recurring or one-time). The
 * one-time palm_injection row already exists; this migration adds the
 * recurring program row + its typed completion profile
 * (service_report/palm_injection) so an accepted semiannual palm plan has
 * a catalog identity to schedule against, and the converter's seeding
 * allowlist (same PR) can seed its 2-visit series.
 *
 * down() removes only what up() proved it inserted: services by recorded
 * UUID, profiles by key + the insertion marker in notes.
 */
const migration = require('../models/migrations/20260811000010_palm_injection_semiannual_catalog');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const EstimateConverter = require('../services/estimate-converter');
const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');

const STATE_KEY = 'migration.20260811000010.state';
const KEY = 'palm_injection_semiannual';

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        // Emulates only the lower(<col>) = lower(?) shape the completion
        // resolver uses.
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        filters.push({ raw: { col: m[1], val: bindings[0] } });
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
  return knex;
}

function emptyDb() {
  return {
    services: [],
    service_completion_profiles: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    scheduled_service_addons: [],
    service_addons: [],
    service_package_items: [],
  };
}

const svcRow = (db) => db.services.find((r) => r.service_key === KEY);
const profileRow = (db) => db.service_completion_profiles.find((r) => r.service_key === KEY);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260811000010 semiannual palm injection catalog row', () => {
  test('up() inserts the recurring program row + typed palm profile, assessment-first, tier-excluded', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    expect(svcRow(db)).toMatchObject({
      category: 'tree_shrub',
      billing_type: 'recurring',
      frequency: 'semiannual',
      visits_per_year: 2,
      booking_enabled: false,
      customer_visible: true,
      is_waveguard: false,
      is_active: true,
      is_archived: false,
    });
    expect(profileRow(db)).toMatchObject({
      completion_mode: 'service_report',
      project_type: 'palm_injection',
      delivery_mode: 'auto_send',
      // Recurring portal posture (tree_shrub_program precedent), NOT the
      // one-time palm lane's token_only.
      portal_visibility: 'customer_portal',
      portal_attach_policy: 'active_portal_customer',
      active: true,
    });
    expect((stateValue(db).services || []).map((s) => s.key)).toEqual([KEY]);
    expect((stateValue(db).services || []).every((s) => s.id)).toBe(true);
    expect(stateValue(db).profiles).toEqual([KEY]);
  });

  test('END-TO-END: the catalog row feeds the converter seeding allowlist (the ruling this row exists for)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const row = svcRow(db);

    // The seeder resolves the row's name to the palm_injection family…
    expect(RecurringAppointmentSeeder.serviceKeyFor({ service_type: row.name })).toBe('palm_injection');
    // …and a line shaped like this row resolves the semiannual pattern
    // end-to-end through the allowlist, so acceptance seeds the 2-visit
    // series.
    const line = { name: row.name, frequency: row.frequency, visitsPerYear: row.visits_per_year };
    expect(EstimateConverter.converterFollowUpSeedingPattern(line, { service_type: row.name }, null)).toBe('semiannual');
  });

  test('two-visit palm remaining-units link the SEMIANNUAL catalog identity, not the one-time row (codex #3349 P1)', () => {
    // Estimator palm lines carry the label 'Palm Injection', which the
    // completion resolver's short-name fallback uniquely matches to the
    // ONE-TIME palm_injection row (token_only profile). The id link must
    // route the recurring program to its own typed recurring profile.
    expect(EstimateConverter.remainingUnitCatalogKey({ service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 2 })).toBe(KEY);
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Palm Injection Program', frequency: 'semiannual' })).toBe(KEY);
  });

  test('one-application and cadence-less palm lines do NOT link the recurring identity (codex #3349 r2 P1)', () => {
    // The builder's supported one-application palm option rides recurring
    // services with visitsPerYear 1 — its correct identity is the one-time
    // lane's name-resolved row, so the semiannual link must not claim it.
    expect(EstimateConverter.remainingUnitCatalogKey({ service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 1 })).toBe(null);
    // No cadence evidence at all → no identity claim either.
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Palm Injection Program' })).toBe(null);
  });

  test('sold lawn cadences link their catalog rows; retired quarterly and legacy lines do not (codex #3349 r2 P1)', () => {
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', frequency: 'bi_monthly', visitsPerYear: 6 })).toBe('lawn_care_recurring');
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Every 6 Weeks Lawn Care Service', service: 'lawn_care', frequency: 'every_6_weeks', visitsPerYear: 9 })).toBe('lawn_care_6week');
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Monthly Lawn Care Service', service: 'lawn_care', frequency: 'monthly', visitsPerYear: 12 })).toBe('lawn_care_monthly');
    // Retired quarterly resolves no seeding pattern → no identity claim.
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Quarterly Lawn Care Service', service: 'lawn_care', frequency: 'quarterly', visitsPerYear: 4 })).toBe(null);
    // Legacy cadence-less lawn keeps the name-only path unchanged.
    expect(EstimateConverter.remainingUnitCatalogKey({ name: 'Lawn Care', service: 'lawn_care' })).toBe(null);
  });

  test('lawn/palm identity links never copy the catalog default duration (codex P1: 45-min lawn rows vs the slot system\'s 60)', () => {
    const fs = require('fs');
    const path = require('path');
    const converterSrc = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    // The identity-only set exists and carries every new link key…
    expect(converterSrc).toContain('const IDENTITY_ONLY_CATALOG_KEYS = new Set([');
    expect(converterSrc).toContain("...Object.values(LAWN_CADENCE_CATALOG_KEYS),");
    expect(converterSrc).toContain("'palm_injection_semiannual',\n]);");
    // …and BOTH catalog-lookup duration copies honor it.
    expect((converterSrc.match(/default_duration_minutes && !IDENTITY_ONLY_CATALOG_KEYS\.has\(unit\.catalogServiceKey\)/g) || []).length).toBe(2);
    // No unconditional duration copy remains at either lookup.
    expect(converterSrc).not.toMatch(/if \(catalogRow\.default_duration_minutes\) \{?\s*\n?\s*(svc\.estimatedDurationMinutes|standaloneRow\.estimated_duration_minutes)/);
  });

  test('END-TO-END: a scheduled visit with NO service_id resolves the typed palm profile by name', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    const resolved = await resolveCompletionProfileForScheduledService(
      { service_type: 'Semiannual Palm Injection Service' },
      fakeKnex(db),
    );
    expect(resolved).toMatchObject({
      completionMode: 'service_report',
      findingsType: 'palm_injection',
      category: 'tree_shrub',
      serviceKey: KEY,
    });
  });

  test('up() never overwrites an admin-created services row, but still heals its missing profile', async () => {
    const db = emptyDb();
    const adminRow = { id: 'admin-palm', service_key: KEY, name: 'Adam Custom Palm Program', category: 'tree_shrub', billing_type: 'recurring', is_active: true };
    db.services.push({ ...adminRow });
    await migration.up(fakeKnex(db));

    expect(svcRow(db)).toMatchObject(adminRow);
    expect(profileRow(db)).toMatchObject({ service_name_snapshot: 'Adam Custom Palm Program' });
    // State claims only what up() actually inserted — nothing here.
    expect((stateValue(db).services || [])).toEqual([]);
    expect(stateValue(db).profiles).toEqual([KEY]);
  });

  test('up() skips the profile for a row an admin deactivated (posture preserved)', async () => {
    const db = emptyDb();
    db.services.push({ id: 'admin-palm', service_key: KEY, name: 'Palm Program', is_active: false });
    await migration.up(fakeKnex(db));
    expect(profileRow(db)).toBeUndefined();
  });

  test('down() with NO references removes the UUID-recorded row and marker-carrying profile', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(svcRow(db)).toBeUndefined();
    expect(profileRow(db)).toBeUndefined();
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() RETAINS+DEACTIVATES the row when live palm visits reference it; profile and links survive; provenance recorded', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = svcRow(db).id;
    db.scheduled_services.push({ id: 'v1', service_id: insertedId });
    await migration.down(fakeKnex(db));

    // A rollback after an accepted palm series keeps identity intact —
    // row (deactivated so nothing new sells it), ACTIVE typed profile
    // (existing links keep resolving), and the visit's service_id — and
    // records the retained row for roll-forward (exemplar 20260809000000).
    expect(svcRow(db)).toBeDefined();
    expect(svcRow(db).is_active).toBe(false);
    expect(profileRow(db)).toBeDefined();
    expect(profileRow(db).active).toBe(true);
    expect(db.scheduled_services[0].service_id).toBe(insertedId);
    expect((stateValue(db).retained || []).map((e) => e.key)).toEqual([KEY]);
  });

  test('roll-forward: up() after a retaining rollback REACTIVATES the row and resumes tracking row AND profile', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = svcRow(db).id;
    db.scheduled_services.push({ id: 'v1', service_id: insertedId });
    await migration.down(fakeKnex(db));
    expect(svcRow(db).is_active).toBe(false);
    // Profile provenance survives the retaining rollback (codex r4 P2).
    expect(stateValue(db).profiles).toEqual([KEY]);

    await migration.up(fakeKnex(db));
    expect(svcRow(db).is_active).toBe(true);
    expect(profileRow(db)).toBeDefined();
    // The reactivated row re-enters the removable set (a future clean
    // rollback can remove it again once nothing references it).
    expect((stateValue(db).services || []).map((e) => e.id)).toContain(insertedId);
    expect(stateValue(db).profiles).toEqual([KEY]);
  });

  test('down() leaves a row an admin REPURPOSED before the first rollback — neither deactivated nor deleted (codex r6 P2)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = db.services.find((r) => r.service_key === KEY).id;
    // Admin repurposes the migration-created row under a new key, no refs.
    db.services.find((r) => r.id === insertedId).service_key = 'admin_custom_palm';
    await migration.down(fakeKnex(db));

    const adminRow = db.services.find((r) => r.id === insertedId);
    expect(adminRow).toBeDefined();
    expect(adminRow.is_active).toBe(true);
  });

  test('roll-forward skips a retained row an admin REPURPOSED under a different key (codex r5 P2)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = svcRow(db).id;
    db.scheduled_services.push({ id: 'v1', service_id: insertedId });
    await migration.down(fakeKnex(db));
    // Admin repurposes the retained (deactivated) row under a new key.
    const repurposed = db.services.find((r) => r.id === insertedId);
    repurposed.service_key = 'admin_custom_palm';

    await migration.up(fakeKnex(db));
    // The admin's row stays untouched and untracked…
    expect(repurposed.is_active).toBe(false);
    expect((stateValue(db).services || []).map((e) => e.id)).not.toContain(insertedId);
    // …and up() inserts a fresh row under the original key.
    expect(svcRow(db)).toBeDefined();
    expect(svcRow(db).id).not.toBe(insertedId);
  });

  test('post-retention replacement row keeps its profile on the next rollback (codex r9 P2)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = db.services.find((r) => r.service_key === KEY).id;
    db.scheduled_services.push({ id: 'v1', service_id: insertedId });
    await migration.down(fakeKnex(db));
    // Admin repurposes the retained UUID AND creates a fresh replacement
    // under the original key before the next roll-forward.
    db.services.find((r) => r.id === insertedId).service_key = 'admin_custom_palm';
    db.services.push({ id: 'admin-replacement', service_key: KEY, name: 'Semiannual Palm Injection Service', is_active: true });
    await migration.up(fakeKnex(db));
    db.scheduled_services = [];
    await migration.down(fakeKnex(db));

    // The replacement and its typed profile both survive.
    expect(db.services.find((r) => r.id === 'admin-replacement')).toBeDefined();
    expect(profileRow(db)).toBeDefined();
  });

  test('retain → roll-forward → references clear → second rollback removes BOTH row and profile (no orphan marker profile)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const insertedId = svcRow(db).id;
    db.scheduled_services.push({ id: 'v1', service_id: insertedId });
    await migration.down(fakeKnex(db));
    await migration.up(fakeKnex(db));
    // The visit reference clears (visit completed and archived away).
    db.scheduled_services = [];
    await migration.down(fakeKnex(db));

    expect(svcRow(db)).toBeUndefined();
    expect(profileRow(db)).toBeUndefined();
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() RETAINS on a NAME-ONLY visit reference — no service_id, service_type matches the row name (codex P1)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'semiannual palm injection service' });
    await migration.down(fakeKnex(db));
    expect(svcRow(db)).toBeDefined();
    expect(profileRow(db)).toBeDefined();

    // Short-name references retain too (the resolver accepts them).
    const db2 = emptyDb();
    await migration.up(fakeKnex(db2));
    db2.scheduled_service_addons.push({ id: 'a1', service_id: null, service_name: 'Semiannual Palm' });
    await migration.down(fakeKnex(db2));
    expect(db2.services.find((r) => r.service_key === KEY)).toBeDefined();
  });

  test('down() leaves the profile when an admin recreated the service under a NEW UUID (codex P1)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // Admin deletes our row and recreates the key under a new UUID,
    // keeping the marker-bearing profile.
    db.services = db.services.filter((r) => r.service_key !== KEY);
    db.services.push({ id: 'admin-new-uuid', service_key: KEY, name: 'Semiannual Palm Injection Service', is_active: true });
    await migration.down(fakeKnex(db));

    // The replacement row keeps its typed completion behavior.
    expect(profileRow(db)).toBeDefined();
    expect(db.services.find((r) => r.service_key === KEY)).toBeDefined();
  });

  test('down() RETAINS on a service_key_snapshot reference — null service_id, non-alias label (codex r8 P1)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'Trunk Injection Visit', service_key_snapshot: KEY });
    await migration.down(fakeKnex(db));
    expect(svcRow(db)).toBeDefined();
    expect(profileRow(db)).toBeDefined();
  });

  test('down() retains on completed service records and add-on wiring too', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.service_records.push({ id: 'r1', service_id: svcRow(db).id });
    await migration.down(fakeKnex(db));
    expect(svcRow(db)).toBeDefined();
    expect(profileRow(db)).toBeDefined();

    const db2 = emptyDb();
    await migration.up(fakeKnex(db2));
    db2.service_addons.push({ parent_service_id: db2.services.find((r) => r.service_key === KEY).id, addon_service_id: 'other' });
    await migration.down(fakeKnex(db2));
    expect(db2.services.find((r) => r.service_key === KEY)).toBeDefined();
  });
});
