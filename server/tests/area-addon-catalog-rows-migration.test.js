/**
 * 20261008200000 area add-on catalog rows: the six one-time add-on treatments
 * behind GATE_AREA_ADDONS each get a services row (service_key
 * area_addon_<addOnKey>), a generic completion profile and a service_taxability
 * row. Names are the pricer's line names verbatim, so the scheduled visit, the
 * invoice line, the mapped estimate row and the tax-label lookup all read the
 * same words; the engine line carries the catalog key so nothing guesses.
 */
const migration = require('../models/migrations/20261008200000_area_addon_catalog_rows');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');
const { classifyCatalogRow } = require('../config/completion-lane-registry');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { priceAreaAddOn, generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

const STATE_KEY = migration.STATE_KEY;
const ADDONS = Object.entries(AREA_ADDONS.items);
const ALL_KEYS = ADDONS.map(([, cfg]) => cfg.serviceKey).sort();

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

const emptyDb = () => ({
  services: [],
  service_completion_profiles: [],
  service_taxability: [],
  system_settings: [],
  service_records: [],
  scheduled_services: [],
  service_addons: [],
  service_package_items: [],
  scheduled_service_addons: [],
  service_discount_rules: [],
  discounts: [],
});
const svcRow = (db, key) => db.services.find((r) => r.service_key === key);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_AREA_ADDONS;
  process.env.GATE_AREA_ADDONS = 'true';
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS;
  else process.env.GATE_AREA_ADDONS = savedGate;
});

describe('20261008200000 area add-on catalog rows', () => {
  test('up() inserts six rows keyed area_addon_<addOnKey> with names equal to the pricer line names', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.services.map((r) => r.service_key).sort()).toEqual(ALL_KEYS);
    for (const [key, cfg] of ADDONS) {
      expect(cfg.serviceKey).toBe(`area_addon_${key}`);
      expect(svcRow(db, cfg.serviceKey)).toMatchObject({
        name: cfg.name,
        category: cfg.category,
        billing_type: 'one_time',
        is_active: true,
        is_archived: false,
        is_waveguard: false,
        booking_enabled: false,
        customer_visible: true,
        requires_license: false,
      });
      // The engine line and the mapped row carry the catalog key, and the
      // priced line name IS the catalog name.
      const line = priceAreaAddOn(key, { areaSqFt: cfg.tiers ? cfg.tiers[0] : undefined, grassType: 'st_augustine' });
      expect(line).toMatchObject({ catalogServiceKey: cfg.serviceKey, name: svcRow(db, cfg.serviceKey).name });
    }
  });

  test('the mapped estimate row names the same catalog row and carries the same words', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    {
      const estimate = generateEstimate({
        homeSqFt: 2000,
        lotSqFt: 7500,
        grassType: 'st_augustine',
        services: {
          areaAddOns: ADDONS.map(([key, cfg]) => ({ key, ...(cfg.tiers ? { areaSqFt: cfg.tiers[0] } : {}) })),
        },
      });
      const items = mapV1ToLegacyShape(estimate).oneTime.items;
      expect(items).toHaveLength(6);
      for (const item of items) {
        const row = svcRow(db, item.catalogServiceKey);
        expect(row).toBeDefined();
        expect(item.name).toBe(row.name);
        expect(item.addOnCategory).toBe(row.category);
      }
    }
  });

  test('price fields are engine outputs: base is the smallest own-visit tier, range spans same-visit low to own-visit high', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    {
      for (const [key, cfg] of ADDONS) {
        const tiers = cfg.tiers || [undefined];
        const price = (areaSqFt, visitContext) => priceAreaAddOn(key, { areaSqFt, visitContext, grassType: 'st_augustine' }).price;
        const row = svcRow(db, cfg.serviceKey);
        expect(Number(row.base_price)).toBe(price(tiers[0], 'standalone'));
        expect(Number(row.price_range_min)).toBe(price(tiers[0], 'sameTripAddOn'));
        expect(Number(row.price_range_max)).toBe(price(tiers[tiers.length - 1], 'standalone'));
      }
    }
  });

  test('durations cover the engine on-site minutes at the largest tier, with a 30-minute floor', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    for (const [, cfg] of ADDONS) {
      const topK = (cfg.tiers ? cfg.tiers[cfg.tiers.length - 1] : 0) / 1000;
      const onSite = cfg.setupMin + cfg.minPer1000 * topK;
      const row = svcRow(db, cfg.serviceKey);
      expect(row.default_duration_minutes).toBeGreaterThanOrEqual(Math.max(30, Math.ceil(onSite)));
      expect(row.default_duration_minutes).toBeLessThanOrEqual(Math.max(30, Math.ceil(onSite / 5) * 5));
      expect(row.min_duration_minutes).toBe(30);
      expect(row.max_duration_minutes).toBeGreaterThan(row.default_duration_minutes);
    }
  });

  test('every row has a generic active service-report profile and resolves it by name with no service_id', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.service_completion_profiles.map((r) => r.service_key).sort()).toEqual(ALL_KEYS);
    for (const [, cfg] of ADDONS) {
      expect(db.service_completion_profiles.find((r) => r.service_key === cfg.serviceKey)).toMatchObject({
        completion_mode: 'service_report',
        project_type: null,
        delivery_mode: 'auto_send',
        billing_type: 'one_time',
        active: true,
      });
      const resolved = await resolveCompletionProfileForScheduledService({ service_type: cfg.name }, fakeKnex(db));
      expect({ name: cfg.name, key: resolved.serviceKey, findingsType: resolved.findingsType })
        .toEqual({ name: cfg.name, key: cfg.serviceKey, findingsType: null });
    }
  });

  test('the completion-lane registry classifies every row as an owner-decided generic one-time lane with no flags', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    for (const [, cfg] of ADDONS) {
      const profile = db.service_completion_profiles.find((r) => r.service_key === cfg.serviceKey);
      const verdict = classifyCatalogRow({
        service_key: cfg.serviceKey,
        billing_type: 'one_time',
        completion_mode: profile.completion_mode,
        project_type: profile.project_type,
        delivery_mode: profile.delivery_mode,
        profile_active: profile.active,
      });
      expect(verdict).toEqual({ lane: 'one_time_generic_by_design', flags: [] });
    }
  });

  test('tax follows dethatching: taxable commercial, residential not taxed, label equals the catalog name', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.service_taxability.map((r) => r.service_key).sort()).toEqual(ALL_KEYS);
    for (const [key, cfg] of ADDONS) {
      expect(db.service_taxability.find((r) => r.service_key === cfg.serviceKey)).toMatchObject({
        service_label: cfg.name,
        is_taxable: true,
        residential_taxable: false,
        tax_category: key === 'web_sweep' ? 'pest_control' : 'lawn_maintenance',
        fl_statute_ref: 'FL §212.05(1)(i)1',
      });
    }
    // The dethatching row the owner pointed at has the same posture.
    const dethatch = require('fs').readFileSync(require.resolve('../models/migrations/20260401000069_tax_intelligence'), 'utf8');
    expect(dethatch).toMatch(/service_key: 'dethatching'.*is_taxable: true, tax_category: 'lawn_maintenance'/);
  });

  test('a missing residential_taxable column skips the taxability rows instead of inserting a taxable-residential row', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    knex.schema.hasColumn = async (t, c) => !(t === 'service_taxability' && c === 'residential_taxable');
    await migration.up(knex);
    expect(db.service_taxability).toHaveLength(0);
    expect(db.services).toHaveLength(6);
  });

  test('up() is idempotent and never overwrites a pre-existing service, profile or taxability row', async () => {
    const db = emptyDb();
    const admin = { id: 'admin-web', service_key: 'area_addon_web_sweep', name: 'Adam Web Sweep', is_active: true };
    db.services.push({ ...admin });
    db.service_taxability.push({ service_key: 'area_addon_fire_ant_yard', service_label: 'admin', is_taxable: false });
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(db.services).toHaveLength(6);
    expect(svcRow(db, 'area_addon_web_sweep')).toMatchObject(admin);
    expect(db.service_taxability).toHaveLength(6);
    expect(db.service_taxability.find((r) => r.service_key === 'area_addon_fire_ant_yard')).toMatchObject({ service_label: 'admin', is_taxable: false });
    expect(stateValue(db).services.map((s) => s.key)).not.toContain('area_addon_web_sweep');
    expect(stateValue(db).taxability).not.toContain('area_addon_fire_ant_yard');
  });

  test('profile heal skips a service that is not explicitly active', async () => {
    const db = emptyDb();
    db.services.push({ id: 'inactive', service_key: 'area_addon_web_sweep', name: 'Web Sweep', is_active: false });
    await migration.up(fakeKnex(db));
    expect(db.service_completion_profiles.find((r) => r.service_key === 'area_addon_web_sweep')).toBeUndefined();
    expect(db.service_completion_profiles).toHaveLength(5);
  });

  test('down() on an unreferenced catalog removes the six rows, profiles and tax rows and clears state', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(db.service_taxability).toHaveLength(0);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() retains and deactivates a referenced service (id, name or short name) and keeps its profile and tax row', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v1', service_id: svcRow(db, 'area_addon_fire_ant_yard').id });
    db.scheduled_services.push({ id: 'v2', service_id: null, service_type: 'Web Sweep' });
    db.service_records.push({ id: 'r1', service_id: svcRow(db, 'area_addon_hardscape_weed').id });
    db.discounts.push({ id: 'd1', service_key_filter: 'area_addon_bed_pre_emergent' });

    await migration.down(fakeKnex(db));

    const kept = ['area_addon_fire_ant_yard', 'area_addon_web_sweep', 'area_addon_hardscape_weed', 'area_addon_bed_pre_emergent'];
    for (const key of kept) {
      expect(svcRow(db, key)).toMatchObject({ is_active: false });
      expect(db.service_completion_profiles.find((r) => r.service_key === key)).toMatchObject({ active: true });
      expect(db.service_taxability.find((r) => r.service_key === key)).toBeDefined();
    }
    expect(db.scheduled_services[0].service_id).toBe(svcRow(db, 'area_addon_fire_ant_yard').id);
    expect(db.services).toHaveLength(4);
  });

  test('down() leaves a profile or tax row that lost its insertion marker', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.service_completion_profiles.find((r) => r.service_key === 'area_addon_web_sweep').notes = 'admin edited';
    db.service_taxability.find((r) => r.service_key === 'area_addon_web_sweep').notes = 'admin edited';
    await migration.down(fakeKnex(db));
    expect(db.service_completion_profiles.map((r) => r.service_key)).toEqual(['area_addon_web_sweep']);
    expect(db.service_taxability.map((r) => r.service_key)).toEqual(['area_addon_web_sweep']);
  });

  test('a missing services table is a no-op', async () => {
    const db = {};
    await expect(migration.up(fakeKnex(db, { missingTables: ['services'] }))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
  });
});
