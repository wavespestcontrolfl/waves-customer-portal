/**
 * 20260809000000 reactivation batch (owner "turn them back on"): palm
 * injection reactivates with its label aligned; the German roach programs,
 * lawn pest knockdown, and the trap-only retainer get their own identity
 * rows — the archived rows retired by later owner rulings stay retired.
 */
const migration = require('../models/migrations/20260809000000_reactivate_estimate_service_identities');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { detectServiceCategory } = require('../utils/service-normalizer');

const STATE_KEY = 'migration.20260809000000.state';
const NEW_KEYS = ['german_roach', 'german_roach_initial', 'lawn_pest_knockdown', 'trap_only_retainer'];

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

// Prod shape: palm archived by 20260519000003 with its typed profile intact.
function seededDb() {
  return {
    services: [{
      id: 'palm-row',
      service_key: 'palm_injection',
      name: 'Palm Injection Service',
      short_name: null,
      category: 'tree_shrub',
      is_active: false,
      is_archived: true,
      customer_visible: false,
      booking_enabled: false,
    }],
    service_completion_profiles: [{
      service_key: 'palm_injection',
      completion_mode: 'service_report',
      project_type: 'palm_injection',
      delivery_mode: 'auto_send',
      active: true,
      notes: 'seeded',
    }],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    service_addons: [],
    service_package_items: [],
    scheduled_service_addons: [],
    service_discount_rules: [],
    discounts: [],
  };
}

const svcRow = (db, key) => db.services.find((r) => r.service_key === key);
const profileRow = (db, key) => db.service_completion_profiles.find((r) => r.service_key === key);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260809000000 reactivation batch', () => {
  test('palm reactivates with aligned short_name; its surviving typed profile is untouched', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));

    expect(svcRow(db, 'palm_injection')).toMatchObject({
      is_active: true,
      is_archived: false,
      customer_visible: true,
      booking_enabled: false,
      short_name: 'Palm Injection',
      name: 'Palm Injection Service',
    });
    expect(profileRow(db, 'palm_injection')).toMatchObject({ project_type: 'palm_injection', notes: 'seeded' });
    // Prior flags recorded for exact restore.
    expect(stateValue(db).palm).toEqual({
      id: 'palm-row',
      prior: { is_active: false, is_archived: true, customer_visible: false, short_name: null },
    });
  });

  test('the four new rows land with owner-directive durations and correct completion lanes', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));

    for (const key of NEW_KEYS) {
      expect(svcRow(db, key)).toMatchObject({
        is_active: true,
        booking_enabled: false,
        default_duration_minutes: 60,
      });
    }
    expect(profileRow(db, 'german_roach').project_type).toBeNull();
    expect(profileRow(db, 'german_roach_initial').project_type).toBeNull();
    expect(profileRow(db, 'lawn_pest_knockdown').project_type).toBe('one_time_lawn_treatment');
    expect(profileRow(db, 'trap_only_retainer').project_type).toBe('rodent_bait_station');
    expect(svcRow(db, 'trap_only_retainer')).toMatchObject({ billing_type: 'recurring', frequency: 'monthly' });
  });

  test('END-TO-END: every estate label resolves — palm via short_name, the rest by exact name', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));

    const expected = {
      // slot-reservation / engine label; the catalog NAME keeps its
      // historical 'Palm Injection Service' — short_name carries the match.
      'Palm Injection': { serviceKey: 'palm_injection', findingsType: 'palm_injection' },
      'German Roach Cleanout': { serviceKey: 'german_roach', findingsType: null },
      'German Roach Initial (3-Visit)': { serviceKey: 'german_roach_initial', findingsType: null },
      'Lawn Pest Knockdown': { serviceKey: 'lawn_pest_knockdown', findingsType: 'one_time_lawn_treatment' },
      'Trap-Only Rodent Monitoring Retainer': { serviceKey: 'trap_only_retainer', findingsType: 'rodent_bait_station' },
    };
    for (const [label, want] of Object.entries(expected)) {
      const resolved = await resolveCompletionProfileForScheduledService(
        { service_type: label },
        fakeKnex(db),
      );
      expect({ label, serviceKey: resolved.serviceKey, findingsType: resolved.findingsType })
        .toEqual({ label, ...want });
    }
  });

  test('names classify into their families through the shared detector', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    expect(detectServiceCategory('German Roach Cleanout')).toBe('pest');
    expect(detectServiceCategory('Lawn Pest Knockdown')).toBe('lawn');
    expect(detectServiceCategory('Trap-Only Rodent Monitoring Retainer')).toBe('rodent');
    expect(detectServiceCategory(svcRow(db, 'palm_injection').name)).toBe('tree_shrub');
  });

  test('down() restores palm to its exact archived posture and removes unreferenced new rows', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(svcRow(db, 'palm_injection')).toMatchObject({
      is_active: false,
      is_archived: true,
      customer_visible: false,
      short_name: null,
    });
    // Palm's pre-existing profile survives; the four inserted rows and
    // profiles are gone; state cleared.
    expect(profileRow(db, 'palm_injection')).toBeDefined();
    expect(db.services).toHaveLength(1);
    expect(db.service_completion_profiles).toHaveLength(1);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() retains+deactivates a referenced new row (name alias) without touching its profile', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'Standard Trap-Only Retainer' });
    // Plan-prefixed labels do NOT alias-match (they link by id) — but an
    // exact base-name visit does.
    db.scheduled_services.push({ id: 'v2', service_id: null, service_type: 'Trap-Only Rodent Monitoring Retainer' });

    await migration.down(fakeKnex(db));

    expect(svcRow(db, 'trap_only_retainer')).toMatchObject({ is_active: false });
    expect(profileRow(db, 'trap_only_retainer')).toMatchObject({ active: true });
  });

  test('up() is idempotent and a second run preserves the first run\'s palm prior-flags record', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(5);
    expect(stateValue(db).palm.prior).toEqual({ is_active: false, is_archived: true, customer_visible: false, short_name: null });
  });
});
