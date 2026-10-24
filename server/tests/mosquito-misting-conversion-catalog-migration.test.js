/**
 * 20261023100000: the three catalog rows an accepted mosquito misting estimate converts into (misting PR 2a): the one-time
 * install, the monthly service plan and the refill add-on. Self-healing, skip-if-exists, state recorded, down() removes only what
 * up() proved it inserted. Prices pinned to constants.js MOSQUITO_MISTING (the migration inlines them: a pushed migration is frozen).
 */
const migration = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
const { MOSQUITO_MISTING } = require('../services/pricing-engine/constants');
const { classifyCatalogRow } = require('../config/completion-lane-registry');
const {
  isMistingDesignConsultation, isMistingSystemService,
} = require('../utils/mosquito-misting-system');

const KEYS = ['mosquito_misting_install', 'mosquito_misting_service', 'mosquito_misting_refill'];

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
      first: async () => { const hit = rowsNow().find(rowMatch); return hit ? { ...hit } : undefined; },
      select: async () => rowsNow().filter(rowMatch).map((r) => ({ ...r })),
      pluck: async (col) => rowsNow().filter(rowMatch).map((r) => r[col]),
      columnInfo: async () => Object.fromEntries((db.__columns?.[table] || Object.keys(rowsNow()[0] || {})).map((c) => [c, {}])),
      update: async (patch) => { const hits = rowsNow().filter(rowMatch); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(rowMatch); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(stored);
        const p = Promise.resolve([1]);
        p.returning = async (col) => [{ [col]: stored[col] }];
        p.onConflict = () => ({ ignore: async () => [1] });
        return p;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  knex.fn = { now: () => 'now()' };
  return knex;
}

const ALL_SERVICE_COLUMNS = ['id', ...new Set(migration.SERVICES.flatMap((s) => Object.keys(s)))];
function emptyDb() {
  return {
    __columns: { services: ALL_SERVICE_COLUMNS },
    services: [],
    service_completion_profiles: [],
    service_taxability: [],
    service_discount_rules: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    service_addons: [],
    service_package_items: [],
    scheduled_service_addons: [],
    discounts: [],
    leads: [],
  };
}
const svc = (db, key) => db.services.find((r) => r.service_key === key);
const state = (db) => { const row = db.system_settings.find((r) => r.key === migration.STATE_KEY); return row ? JSON.parse(row.value) : undefined; };

describe('the catalog rows', () => {
  const byKey = Object.fromEntries(migration.SERVICES.map((s) => [s.service_key, s]));

  test('three rows, all mosquito, none public-quote selectable or bookable, none a WaveGuard tier service', () => {
    expect(migration.SERVICES.map((s) => s.service_key)).toEqual(KEYS);
    for (const row of migration.SERVICES) {
      expect(row).toMatchObject({
        category: 'mosquito', is_taxable: true, tax_service_key: 'mosquito', requires_license: true, license_category: 'GHP',
        public_quote_selectable: false, booking_enabled: false, is_waveguard: false, is_active: true, is_archived: false,
      });
    }
    expect(byKey.mosquito_misting_refill.customer_visible).toBe(false);
  });

  test('install: one-time, variable, Smart list base, Essential list floor, a full day', () => {
    expect(byKey.mosquito_misting_install).toMatchObject({
      name: 'Mosquito Misting System Installation', billing_type: 'one_time', pricing_type: 'variable', default_duration_minutes: 480,
      base_price: MOSQUITO_MISTING.tiers.smart.price, price_range_min: MOSQUITO_MISTING.tiers.essential.price, price_range_max: null,
      engine_keys: ['mosquito_misting_installation'],
    });
    expect(byKey.mosquito_misting_install.internal_notes).toMatch(/priceMosquitoMisting/);
  });

  test('service plan: recurring, monthly, 12 applications, fixed at the plan price, engine key mosquito_misting', () => {
    expect(byKey.mosquito_misting_service).toMatchObject({
      name: 'Mosquito Misting Service Plan', billing_type: 'recurring', frequency: 'monthly', pricing_type: 'fixed',
      visits_per_year: MOSQUITO_MISTING.plan.visitsPerYear, base_price: MOSQUITO_MISTING.plan.monthly, default_duration_minutes: 30,
      engine_keys: ['mosquito_misting'],
    });
  });

  test('refill: one-time add-on, Standard base price, range Standard to Premium', () => {
    expect(byKey.mosquito_misting_refill).toMatchObject({
      name: 'Mosquito Misting System Refill', billing_type: 'one_time', pricing_type: 'variable', default_duration_minutes: 20,
      base_price: MOSQUITO_MISTING.refills.standard.price, price_range_min: MOSQUITO_MISTING.refills.standard.price,
      price_range_max: MOSQUITO_MISTING.refills.premium.price,
    });
    expect(byKey.mosquito_misting_refill).not.toHaveProperty('engine_keys');
  });

  test('every row is a misting-system service and NONE is the design consultation (key-first, exact design key only)', () => {
    for (const key of KEYS) {
      expect(isMistingSystemService({ serviceKey: key })).toBe(true);
      expect(isMistingDesignConsultation({ serviceKey: key })).toBe(false);
      expect(isMistingDesignConsultation({ serviceKey: key, name: byKey[key].name })).toBe(false);
    }
    expect(isMistingDesignConsultation({ serviceKey: 'mosquito_misting_system' })).toBe(true);
  });

  test('the completion registry classifies all three without a flag: install one-time generic, plan recurring generic, refill a rider', () => {
    const rowFor = (key) => ({
      service_key: key, billing_type: byKey[key].billing_type, completion_mode: migration.PROFILES[key].completion_mode,
      project_type: null, delivery_mode: migration.PROFILES[key].delivery_mode, profile_active: true,
    });
    expect(classifyCatalogRow(rowFor('mosquito_misting_install'))).toEqual({ lane: 'one_time_generic_by_design', flags: [] });
    expect(classifyCatalogRow(rowFor('mosquito_misting_service'))).toEqual({ lane: 'recurring_generic_by_design', flags: [] });
    expect(classifyCatalogRow(rowFor('mosquito_misting_refill'))).toEqual({ lane: 'billing_rider', flags: [] });
  });
});

describe('up()', () => {
  test('inserts the rows, profiles, tax rows and discount rules, creates NO add-on link, and records state', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.services).toHaveLength(3);
    expect(JSON.parse(svc(db, 'mosquito_misting_service').engine_keys)).toEqual(['mosquito_misting']);
    expect(db.service_completion_profiles.map((p) => p.service_key).sort()).toEqual([...KEYS].sort());
    expect(db.service_completion_profiles.find((p) => p.service_key === 'mosquito_misting_refill')).toMatchObject({ completion_mode: 'internal_only', delivery_mode: 'disabled' });
    expect(db.service_completion_profiles.find((p) => p.service_key === 'mosquito_misting_install')).toMatchObject({ completion_mode: 'service_report', delivery_mode: 'auto_send', project_type: null });
    expect(db.service_taxability).toHaveLength(3);
    expect(db.service_taxability[0]).toMatchObject({ tax_category: 'pest_control', residential_taxable: false });
    expect(db.service_taxability.find((t) => t.service_key === 'mosquito_misting_service').service_label).toBe('Mosquito Misting Service Plan');
    expect(db.service_discount_rules).toHaveLength(3);
    expect(db.service_discount_rules[0]).toMatchObject({ tier_qualifier: false, exclude_from_pct_discount: true });
    // refill billing ships in misting PR 2c: the refill row is dormant and no add-on picker offers it
    expect(db.service_addons).toEqual([]);
    const s = state(db);
    expect(s.services.map((e) => e.key).sort()).toEqual([...KEYS].sort());
    expect(s.addons).toBeUndefined();
  });

  test('is idempotent', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(db.services).toHaveLength(3);
    expect(db.service_completion_profiles).toHaveLength(3);
    expect(db.service_taxability).toHaveLength(3);
    expect(db.service_addons).toEqual([]);
  });

  test('leaves a pre-existing row untouched and heals only an explicitly active one', async () => {
    const db = emptyDb();
    db.services.push({ id: 'old-1', service_key: 'mosquito_misting_service', name: 'Admin Edited', base_price: 70, is_active: true, is_archived: false, category: 'mosquito', billing_type: 'recurring' });
    await migration.up(fakeKnex(db));
    expect(svc(db, 'mosquito_misting_service')).toMatchObject({ name: 'Admin Edited', base_price: 70 });
    expect(state(db).services.map((e) => e.key)).not.toContain('mosquito_misting_service');
    const inactive = emptyDb();
    inactive.services.push({ id: 'old-2', service_key: 'mosquito_misting_install', name: 'Install', is_active: false, is_archived: false, category: 'mosquito', billing_type: 'one_time' });
    await migration.up(fakeKnex(inactive));
    expect(inactive.service_completion_profiles.map((p) => p.service_key)).not.toContain('mosquito_misting_install');
  });

  test('skips cleanly when the services table is absent, and when optional tables are absent', async () => {
    const none = emptyDb();
    await migration.up(fakeKnex(none, { missingTables: ['services'] }));
    expect(none.services).toEqual([]);
    const partial = emptyDb();
    await migration.up(fakeKnex(partial, { missingTables: ['service_completion_profiles', 'service_taxability', 'service_discount_rules', 'service_addons'] }));
    expect(partial.services).toHaveLength(3);
    expect(partial.service_completion_profiles).toEqual([]);
  });
});

describe('down()', () => {
  test('removes exactly what up() inserted when nothing references it', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.services).toEqual([]);
    expect(db.service_completion_profiles).toEqual([]);
    expect(db.service_taxability).toEqual([]);
    expect(db.service_discount_rules).toEqual([]);
    expect(db.service_addons).toEqual([]);
    expect(state(db)).toBeUndefined();
  });

  test('a service referenced by a scheduled visit is retained and deactivated, with its profile, tax row and rule; the unreferenced rows are removed', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const plan = svc(db, 'mosquito_misting_service');
    db.scheduled_services.push({ id: 'v1', service_id: plan.id, service_type: 'Mosquito Misting Service Plan' });
    await migration.down(fakeKnex(db));
    expect(svc(db, 'mosquito_misting_service')).toMatchObject({ is_active: false });
    expect(db.service_completion_profiles.map((p) => p.service_key)).toContain('mosquito_misting_service');
    expect(db.service_taxability.map((t) => t.service_key)).toContain('mosquito_misting_service');
    expect(svc(db, 'mosquito_misting_install')).toBeUndefined();
    expect(svc(db, 'mosquito_misting_refill')).toBeUndefined();
  });

  test('another admin-made add-on link naming a service counts as a reference: that service is retained', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    const refill = svc(db, 'mosquito_misting_refill');
    db.service_addons.push({ id: 'link-x', parent_service_id: 'someone-else', addon_service_id: refill.id });
    await migration.down(fakeKnex(db));
    expect(svc(db, 'mosquito_misting_refill')).toMatchObject({ is_active: false });
    expect(svc(db, 'mosquito_misting_service')).toBeUndefined();
  });

  test('an admin-replaced profile (no marker) is left alone, and an unreadable state removes nothing', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.service_completion_profiles.find((p) => p.service_key === 'mosquito_misting_install').notes = 'admin note';
    await migration.down(fakeKnex(db));
    expect(db.service_completion_profiles.map((p) => p.service_key)).toEqual(['mosquito_misting_install']);
    const bad = emptyDb();
    await migration.up(fakeKnex(bad));
    bad.system_settings[0].value = '{not json';
    await migration.down(fakeKnex(bad));
    expect(bad.services).toHaveLength(3);
  });

  test('no state row (up() inserted nothing) removes nothing', async () => {
    const db = emptyDb();
    db.services.push({ id: 'x', service_key: 'mosquito_misting_refill', name: 'Mine' });
    await migration.down(fakeKnex(db));
    expect(db.services).toHaveLength(1);
  });
});
