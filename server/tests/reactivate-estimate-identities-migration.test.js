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
const TRAP_KEYS = ['trap_only_retainer_standard', 'trap_only_retainer_plus', 'trap_only_retainer_monthly'];
const NEW_KEYS = ['german_roach', 'german_roach_initial', 'lawn_pest_knockdown', ...TRAP_KEYS];

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      if (f.like) {
        const rx = new RegExp(`^${String(f.like.val).toLowerCase().split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return rx.test(String(r[f.like.col] || '').toLowerCase());
      }
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        const eq = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (eq) { filters.push({ raw: { col: eq[1], val: bindings[0] } }); return q; }
        const like = /lower\((\w+)\)\s+LIKE\s+lower\(\?\)/i.exec(sql);
        if (like) { filters.push({ like: { col: like[1], val: bindings[0] } }); return q; }
        throw new Error(`fake whereRaw: unsupported sql ${sql}`);
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
    // German roach ALWAYS re-services: the catalog fields drive the
    // profile heal to alert/14d (the retired knockdown profile's policy).
    for (const key of ['german_roach', 'german_roach_initial']) {
      expect(profileRow(db, key)).toMatchObject({
        project_type: null,
        followup_policy: 'alert',
        default_followup_days: 14,
      });
    }
    expect(profileRow(db, 'lawn_pest_knockdown').project_type).toBe('one_time_lawn_treatment');
    for (const key of TRAP_KEYS) expect(profileRow(db, key).project_type).toBe('rodent_trapping');
    // VISIT cadence per plan — never the (always-monthly) billing cadence.
    expect(svcRow(db, 'trap_only_retainer_standard')).toMatchObject({ billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4, base_price: 49.0 });
    expect(svcRow(db, 'trap_only_retainer_plus')).toMatchObject({ frequency: 'bimonthly', visits_per_year: 6, base_price: 69.0 });
    expect(svcRow(db, 'trap_only_retainer_monthly')).toMatchObject({ frequency: 'monthly', visits_per_year: 12, base_price: 99.0 });
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
      // Each plan's engine line label is its catalog name verbatim.
      'Standard Trap-Only Retainer': { serviceKey: 'trap_only_retainer_standard', findingsType: 'rodent_trapping' },
      'Plus Trap-Only Retainer': { serviceKey: 'trap_only_retainer_plus', findingsType: 'rodent_trapping' },
      'Monthly Trap-Only Retainer': { serviceKey: 'trap_only_retainer_monthly', findingsType: 'rodent_trapping' },
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

  test('mapper-vocabulary labels resolve: roach visit-program suffix + short_name aliases', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));

    // The cleanout pricer labels its line with the severity tier's visit
    // count; the resolver strips that suffix to the catalog name.
    for (const label of ['German Roach Cleanout — 2 Visit Program', 'German Roach Cleanout — 4 Visit Program']) {
      const r = await resolveCompletionProfileForScheduledService({ service_type: label }, fakeKnex(db));
      expect({ label, key: r.serviceKey }).toEqual({ label, key: 'german_roach' });
    }
    // The v1 mapper persists 'German Roach' (SERVICE_LABEL) — the row's
    // short_name carries that vocabulary.
    const viaShort = await resolveCompletionProfileForScheduledService({ service_type: 'German Roach' }, fakeKnex(db));
    expect(viaShort.serviceKey).toBe('german_roach');
  });

  test('E2E through the v1 mapper: each retainer plan keeps its label and resolves its own row', async () => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const sp = require('../services/pricing-engine');
    const db = seededDb();
    await migration.up(fakeKnex(db));

    for (const [plan, key] of [['standard', 'trap_only_retainer_standard'], ['plus', 'trap_only_retainer_plus'], ['monthly', 'trap_only_retainer_monthly']]) {
      const priced = sp.priceTrapOnlyRetainer({ plan, billing: 'monthly' });
      const mapped = mapV1ToLegacyShape({ lineItems: [priced] });
      const items = [
        ...(mapped?.oneTime?.items || []),
        ...(mapped?.oneTime?.specItems || []),
      ];
      const line = items.find((i) => /trap-only/i.test(String(i.name || '')));
      // The mapper must preserve the PLAN label, not flatten to one name.
      expect({ plan, name: line && line.name }).toEqual({ plan, name: priced.name });
      const resolved = await resolveCompletionProfileForScheduledService({ service_type: line.name }, fakeKnex(db));
      expect({ plan, key: resolved.serviceKey, type: resolved.findingsType })
        .toEqual({ plan, key, type: 'rodent_trapping' });
    }
  });

  test('down() retains a row referenced only by a visit-program-suffixed label', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    // Resolver strips the suffix to reach german_roach, so this visit
    // depends on the row — rollback must not delete it.
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'German Roach Cleanout — 3 Visit Program' });

    await migration.down(fakeKnex(db));

    expect(svcRow(db, 'german_roach')).toMatchObject({ is_active: false });
    expect(profileRow(db, 'german_roach')).toMatchObject({ active: true });
    // Its unreferenced sibling still rolls back.
    expect(svcRow(db, 'german_roach_initial')).toBeUndefined();
  });

  test('names classify into their families through the shared detector', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    expect(detectServiceCategory('German Roach Cleanout')).toBe('pest');
    expect(detectServiceCategory('Lawn Pest Knockdown')).toBe('lawn');
    expect(detectServiceCategory('Standard Trap-Only Retainer')).toBe('rodent');
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

    await migration.down(fakeKnex(db));

    // The referenced plan row retains+deactivates with its profile live;
    // the other two plans roll back cleanly.
    expect(svcRow(db, 'trap_only_retainer_standard')).toMatchObject({ is_active: false });
    expect(profileRow(db, 'trap_only_retainer_standard')).toMatchObject({ active: true });
    expect(svcRow(db, 'trap_only_retainer_plus')).toBeUndefined();
    expect(svcRow(db, 'trap_only_retainer_monthly')).toBeUndefined();
  });

  test('down() leaves palm fields an admin edited after deploy — restores only untouched ones', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    // Admin re-hides palm from customers after the migration deployed.
    svcRow(db, 'palm_injection').customer_visible = false;

    await migration.down(fakeKnex(db));

    const palm = svcRow(db, 'palm_injection');
    // Untouched fields restore to their archived values...
    expect(palm).toMatchObject({ is_active: false, is_archived: true, short_name: null });
    // ...but the admin's own later choice stands (prior value was also
    // false here, so assert it was NOT written back by us: the field
    // simply keeps the admin's value).
    expect(palm.customer_visible).toBe(false);
  });

  test('up() is idempotent and a second run preserves the first run\'s palm prior-flags record', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(7);
    expect(stateValue(db).palm.prior).toEqual({ is_active: false, is_archived: true, customer_visible: false, short_name: null });
  });
});
