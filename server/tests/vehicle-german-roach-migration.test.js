/**
 * 20261008140000 vehicle German roach services (owner ruling 2026-10-06),
 * re-cut of the pushed 20261007000200 after codex #6082 round 1:
 *  - P2: neither row may reach the anonymous public catalog, which lists every
 *    active customer_visible row and never reads booking_enabled;
 *  - P0: down() must not delete a row that service_addons, package items,
 *    visit add-ons, service records or any other catalog reference points at;
 *  - the add-on takes a billing-rider completion profile and the car job a
 *    typed cockroach profile, so the completion-lane contract stays green.
 * Synthetic data only.
 */
const migration = require('../models/migrations/20261008140000_vehicle_german_roach_service');
const { classifyCatalogRow } = require('../config/completion-lane-registry');

const { SERVICES, ID_REFERENCES, KEY_REFERENCES } = migration._test;

// Minimal in-memory knex: just the calls the migration makes.
function fakeKnex(initial = {}) {
  const db = {};
  for (const [t, rows] of Object.entries(initial)) db[t] = rows.map((r) => ({ ...r }));
  const columns = {
    services: Object.keys(SERVICES[0]).concat(['id']),
    service_completion_profiles: [
      'service_key', 'service_name_snapshot', 'category', 'billing_type', 'completion_mode', 'project_type',
      'delivery_mode', 'creates_service_record', 'portal_visibility', 'portal_attach_policy', 'followup_policy',
      'default_followup_days', 'active', 'notes',
    ],
  };
  let seq = 0;
  const knex = (table) => {
    let conds = [];
    const match = (r) => conds.every(([c, v]) => r[c] === v);
    const q = {
      where(a, b) {
        if (typeof a === 'object') Object.entries(a).forEach(([c, v]) => conds.push([c, v]));
        else conds.push([a, b]);
        return q;
      },
      async first() { return (db[table] || []).find(match); },
      async columnInfo() { return Object.fromEntries((columns[table] || []).map((c) => [c, {}])); },
      insert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        const apply = (ignoreConflict) => {
          db[table] = db[table] || [];
          const out = [];
          for (const r of list) {
            if (ignoreConflict && db[table].some((e) => e.service_key === r.service_key)) continue;
            const row = { ...r };
            if (table === 'services') row.id = `svc-${++seq}`;
            db[table].push(row);
            out.push(row.id);
          }
          return out;
        };
        const p = {
          returning() { return Promise.resolve(apply(false).map((id) => ({ id }))); },
          onConflict() { return { ignore: () => Promise.resolve(apply(true)) }; },
          then(res, rej) { return Promise.resolve(apply(false)).then(res, rej); },
        };
        return p;
      },
      async update(patch) { (db[table] || []).filter(match).forEach((r) => Object.assign(r, patch)); },
      async del() { db[table] = (db[table] || []).filter((r) => !match(r)); },
    };
    return q;
  };
  knex.fn = { now: () => 'now' };
  knex.schema = {
    hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t),
    hasColumn: async () => true,
  };
  knex.db = db;
  return knex;
}

const BASE = {
  services: [],
  service_discount_rules: [],
  service_completion_profiles: [],
  system_settings: [],
  scheduled_services: [],
  scheduled_service_addons: [],
  service_records: [],
  service_addons: [],
  service_package_items: [],
  estimate_line_items: [],
  invoice_line_items: [],
  discounts: [],
  leads: [],
};

const idOf = (knex, key) => knex.db.services.find((s) => s.service_key === key)?.id;

describe('catalog rows', () => {
  test('both rows are staff-only: hidden from public catalogs, not bookable', () => {
    expect(SERVICES.map((s) => s.service_key)).toEqual(['vehicle_german_roach', 'vehicle_roach_addon']);
    for (const s of SERVICES) {
      // routes/public-mcp.js lists every active, non-archived customer_visible row.
      expect(s.customer_visible).toBe(false);
      expect(s.booking_enabled).toBe(false);
    }
  });

  test('the public MCP catalog query filters on customer_visible and never on booking_enabled', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/public-mcp.js'), 'utf8');
    expect(src).toContain('customer_visible: true');
    expect(src).not.toContain('booking_enabled');
  });

  test('up() inserts the rows with those flags and is idempotent', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.db.services).toHaveLength(2);
    expect(knex.db.services.every((s) => s.customer_visible === false && s.booking_enabled === false)).toBe(true);
  });
});

describe('completion lane (completion-lane-coverage-contract)', () => {
  test('both new keys resolve to an explicit lane with no defect', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    for (const service of knex.db.services) {
      const profile = knex.db.service_completion_profiles.find((p) => p.service_key === service.service_key);
      expect(profile).toBeTruthy();
      const { flags } = classifyCatalogRow({
        service_key: service.service_key,
        billing_type: service.billing_type,
        completion_mode: profile.completion_mode,
        project_type: profile.project_type,
        delivery_mode: profile.delivery_mode,
        profile_active: profile.active,
      });
      expect(flags).toEqual([]);
    }
  });

  test('the car job is a typed cockroach report and the add-on is a billing rider', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const byKey = Object.fromEntries(knex.db.service_completion_profiles.map((p) => [p.service_key, p]));
    expect(byKey.vehicle_german_roach).toMatchObject({ completion_mode: 'service_report', project_type: 'cockroach', followup_policy: 'alert' });
    expect(byKey.vehicle_roach_addon).toMatchObject({ completion_mode: 'internal_only', project_type: null, delivery_mode: 'disabled' });
  });
});

describe('trace eligibility', () => {
  test('a car job never gets a perimeter trace, even on the typed cockroach form', () => {
    const { resolveTraceEligibility } = require('../services/service-report/trace-eligibility');
    expect(resolveTraceEligibility({ serviceKey: 'vehicle_german_roach', findingsType: 'cockroach' }))
      .toMatchObject({ eligible: false, reason: 'interior_only_lane' });
    expect(resolveTraceEligibility({ serviceKey: 'vehicle_roach_addon' }))
      .toMatchObject({ eligible: false, reason: 'billing_rider' });
  });
});

describe('down() rollback safety (codex #6082 r1 P0)', () => {
  test('an unreferenced row is deleted with its discount rule and profile', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.db.services).toEqual([]);
    expect(knex.db.service_discount_rules).toEqual([]);
    expect(knex.db.service_completion_profiles).toEqual([]);
    expect(knex.db.system_settings).toEqual([]);
  });

  // One case per catalog-reference table: each must keep the row (deactivate, not delete).
  const CASES = [
    ...ID_REFERENCES.map(([table, column]) => ({ table, column, by: 'id' })),
    ...KEY_REFERENCES.map(([table, column]) => ({ table, column, by: 'key' })),
  ];
  test.each(CASES)('a reference in $table.$column keeps the row, deactivated', async ({ table, column, by }) => {
    for (const key of ['vehicle_german_roach', 'vehicle_roach_addon']) {
      const knex = fakeKnex(BASE);
      await migration.up(knex);
      const id = idOf(knex, key);
      knex.db[table] = [{ [column]: by === 'id' ? id : key }];
      await migration.down(knex);
      const row = knex.db.services.find((s) => s.service_key === key);
      expect(row).toBeTruthy();
      expect(row.is_active).toBe(false);
      expect(row.booking_enabled).toBe(false);
      // The other, unreferenced row is removed.
      expect(knex.db.services).toHaveLength(1);
      // The retained row keeps its rule and profile, and the state row records it.
      expect(knex.db.service_discount_rules.some((r) => r.service_key === key)).toBe(true);
      expect(knex.db.service_completion_profiles.some((p) => p.service_key === key)).toBe(true);
      const state = JSON.parse(knex.db.system_settings[0].value);
      expect(state.retained).toEqual([{ key, id }]);
    }
  });

  test('the reference list covers every table with a foreign key to services', () => {
    // FKs to services: 20260401000105 (service_addons x2, service_package_items,
    // service_records, scheduled_services) and 20260401000106
    // (scheduled_services, scheduled_service_addons).
    const tables = new Set(ID_REFERENCES.map(([t]) => t));
    for (const t of ['service_addons', 'service_package_items', 'service_records', 'scheduled_services', 'scheduled_service_addons']) {
      expect(tables.has(t)).toBe(true);
    }
    const addonCols = ID_REFERENCES.filter(([t]) => t === 'service_addons').map(([, c]) => c).sort();
    expect(addonCols).toEqual(['addon_service_id', 'parent_service_id']);
  });

  test('a later up() reactivates a retained row instead of leaving the key dead', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const id = idOf(knex, 'vehicle_german_roach');
    knex.db.service_addons = [{ parent_service_id: id }];
    await migration.down(knex);
    expect(knex.db.services.find((s) => s.service_key === 'vehicle_german_roach').is_active).toBe(false);
    await migration.up(knex);
    expect(knex.db.services.find((s) => s.service_key === 'vehicle_german_roach').is_active).toBe(true);
  });
});
