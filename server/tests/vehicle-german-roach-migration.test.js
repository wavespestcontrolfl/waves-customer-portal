/**
 * 20261008190000 vehicle German roach catalog rows (owner ruling 2026-10-06;
 * split 2026-10-08: catalog and office handling only, no call-agent booking).
 * Earlier rounds of the same work (codex #6082 round 1):
 *  - P2: neither row may reach the anonymous public catalog, which lists every
 *    active customer_visible row and never reads booking_enabled;
 *  - P0/P2 (rounds 1-2): rollback must not lose rows or admin edits, so down()
 *    deactivates and never deletes;
 *  - the add-on takes a billing-rider completion profile and the car job a
 *    typed cockroach profile, so the completion-lane contract stays green.
 * Synthetic data only.
 */
const migration = require('../models/migrations/20261008190000_vehicle_roach_catalog_rows');
const { classifyCatalogRow } = require('../config/completion-lane-registry');

const { SERVICES } = migration._test;

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
      async update(patch) { const hit = (db[table] || []).filter(match); hit.forEach((r) => Object.assign(r, patch)); return hit.length; },
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
      // /api/public/services/menu selects by this flag alone.
      expect(s.public_quote_selectable).toBe(false);
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
    expect(knex.db.services.every((s) => s.customer_visible === false && s.booking_enabled === false && s.public_quote_selectable === false)).toBe(true);
  });
});

describe('no call, voice or SMS pipeline can load either row', () => {
  // Every pipeline reads the one shared loader. It filters on booking_enabled=true,
  // so a row that ships booking_enabled=false never reaches a prompt or a draft.
  test('loadBookableCallServices excludes both rows because booking_enabled is false', async () => {
    const { loadBookableCallServices } = require('../services/call-booking-catalog');
    const bookable = { service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control', is_active: true, booking_enabled: true };
    const rows = [...SERVICES.map((s) => ({ ...s })), bookable];
    let filter = null;
    const conn = () => {
      const q = {
        where(f) { filter = f; return q; },
        whereNotIn() { return q; },
        orderBy() { return q; },
        select() { return Promise.resolve(rows.filter((r) => Object.entries(filter).every(([c, v]) => r[c] === v))); },
      };
      return q;
    };
    const loaded = await loadBookableCallServices(conn);
    expect(filter).toMatchObject({ is_active: true, booking_enabled: true });
    expect(loaded.map((r) => r.service_key)).toEqual(['pest_control_quarterly']);
  });

  test('the voice and SMS pipelines read that same loader', () => {
    const fs = require('fs');
    for (const file of ['../services/voice-agent/relay-context.js', '../services/sms-shadow-drafter.js']) {
      expect(fs.readFileSync(require.resolve(file), 'utf8')).toContain('loadBookableCallServices');
    }
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

const CAR = 'vehicle_german_roach';
const ADDON = 'vehicle_roach_addon';
const svc = (knex, key) => knex.db.services.find((s) => s.service_key === key);
const stateOf = (knex) => JSON.parse(knex.db.system_settings[0].value);

describe('state row key follows the repository convention', () => {
  test('migration.<stamp>.state, stamp equal to the filename stamp', () => {
    expect(migration._test.STATE_KEY).toBe('migration.20261008190000.state');
  });

  test('up() records the inserted rows under that key', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    expect(knex.db.system_settings[0].key).toBe('migration.20261008190000.state');
    expect(stateOf(knex)).toEqual({
      inserted: [{ key: CAR, id: idOf(knex, CAR) }, { key: ADDON, id: idOf(knex, ADDON) }],
      deactivated: [],
    });
  });
});

describe('up() never edits a row it does not own (codex #6173 r1)', () => {
  const adminRow = (key, extra = {}) => ({ id: `admin-${key}`, service_key: key, name: 'Admin made', base_price: 150, is_active: true, customer_visible: true, public_quote_selectable: true, booking_enabled: true, ...extra });

  test.each([[CAR], [ADDON]])('a pre-existing %s row makes up() throw and change nothing', async (key) => {
    const row = adminRow(key);
    const knex = fakeKnex({ ...BASE, services: [row] });
    await expect(migration.up(knex)).rejects.toThrow(`service_key ${key} already exists and was not created by this migration; resolve by hand`);
    expect(knex.db.services).toEqual([row]);
    expect(knex.db.service_discount_rules).toEqual([]);
    expect(knex.db.service_completion_profiles).toEqual([]);
    expect(knex.db.system_settings).toEqual([]);
  });

  test('the add-on pre-existing: the car row is not inserted either (checks run before any insert)', async () => {
    const knex = fakeKnex({ ...BASE, services: [adminRow(ADDON)] });
    await expect(migration.up(knex)).rejects.toThrow(ADDON);
    expect(knex.db.services).toHaveLength(1);
    expect(svc(knex, CAR)).toBeUndefined();
  });

  test('a row with the right key but another id than the recorded one is not ours', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    knex.db.services.find((s) => s.service_key === CAR).id = 'replaced-by-hand';
    await expect(migration.up(knex)).rejects.toThrow(CAR);
  });
});

describe('down() deactivates and writes the minimum; it never deletes', () => {
  test('both inserted rows stay, inactive, booking flag untouched, with their rule and profile', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const ids = { [CAR]: idOf(knex, CAR), [ADDON]: idOf(knex, ADDON) };
    await migration.down(knex);
    expect(knex.db.services).toHaveLength(2);
    for (const key of [CAR, ADDON]) {
      expect(svc(knex, key)).toMatchObject({ id: ids[key], is_active: false, booking_enabled: false });
      expect(knex.db.service_discount_rules.some((r) => r.service_key === key)).toBe(true);
      expect(knex.db.service_completion_profiles.some((p) => p.service_key === key)).toBe(true);
    }
    expect(stateOf(knex).deactivated).toEqual([{ key: CAR, id: ids[CAR] }, { key: ADDON, id: ids[ADDON] }]);
  });

  test('down() writes only is_active', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const before = knex.db.services.map((s) => ({ ...s }));
    await migration.down(knex);
    const changed = knex.db.services.flatMap((s, i) => Object.keys(s).filter((c) => s[c] !== before[i][c]));
    expect(new Set(changed)).toEqual(new Set(['is_active']));
  });

  test('an admin edit made before down() survives it', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    Object.assign(svc(knex, CAR), { base_price: 225, name: 'Car Roach Job', internal_notes: 'admin note' });
    knex.db.service_discount_rules.find((r) => r.service_key === CAR).exclude_from_pct_discount = false;
    knex.db.service_completion_profiles.find((p) => p.service_key === CAR).delivery_mode = 'manual';
    await migration.down(knex);
    expect(svc(knex, CAR)).toMatchObject({ base_price: 225, name: 'Car Roach Job', internal_notes: 'admin note' });
    expect(knex.db.service_discount_rules.find((r) => r.service_key === CAR).exclude_from_pct_discount).toBe(false);
    expect(knex.db.service_completion_profiles.find((p) => p.service_key === CAR).delivery_mode).toBe('manual');
  });

  test('down() deletes nothing even when other tables point at the row', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    knex.db.service_addons = [{ parent_service_id: idOf(knex, CAR) }];
    knex.db.leads = [{ service_key: ADDON }];
    await migration.down(knex);
    expect(knex.db.services).toHaveLength(2);
    expect(knex.db.service_addons).toHaveLength(1);
    expect(knex.db.leads).toHaveLength(1);
  });

  test('down() with no recorded state does nothing', async () => {
    const knex = fakeKnex({ ...BASE, services: [{ id: 'a', service_key: CAR, is_active: true }] });
    await migration.down(knex);
    expect(knex.db.services).toEqual([{ id: 'a', service_key: CAR, is_active: true }]);
  });
});

describe('down then up round trips', () => {
  test('a normal down/up reactivates only what down() deactivated, same ids, edits kept', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const id = idOf(knex, CAR);
    svc(knex, CAR).base_price = 225;
    await migration.down(knex);
    await migration.up(knex);
    expect(knex.db.services).toHaveLength(2);
    expect(svc(knex, CAR)).toMatchObject({ id, is_active: true, booking_enabled: false, customer_visible: false, public_quote_selectable: false, base_price: 225 });
    expect(svc(knex, ADDON)).toMatchObject({ is_active: true, booking_enabled: false });
    expect(knex.db.service_discount_rules).toHaveLength(2);
    expect(knex.db.service_completion_profiles).toHaveLength(2);
    expect(stateOf(knex).deactivated).toEqual([]);
    // Ownership is still recorded, so a second rollback deactivates again.
    await migration.down(knex);
    expect(knex.db.services).toHaveLength(2);
    expect(svc(knex, CAR).is_active).toBe(false);
  });

  test('double up changes nothing and adds no rows', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    const snap = () => JSON.stringify([knex.db.services, knex.db.service_discount_rules, knex.db.service_completion_profiles, knex.db.system_settings.map((r) => r.value)]);
    const after = snap();
    await migration.up(knex);
    expect(snap()).toBe(after);
  });

  test('up(), up(), down() leaves two inactive rows, one rule and one profile each', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.db.services.map((s) => s.is_active)).toEqual([false, false]);
    expect(knex.db.service_discount_rules).toHaveLength(2);
    expect(knex.db.service_completion_profiles).toHaveLength(2);
  });

  test('double down keeps the deactivated record, and up still reactivates', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    await migration.down(knex);
    await migration.down(knex);
    expect(stateOf(knex).deactivated).toHaveLength(2);
    await migration.up(knex);
    expect(knex.db.services.every((s) => s.is_active)).toBe(true);
  });
});

describe('admin changes survive down and up (codex #6173 r1 P2)', () => {
  test('a row an admin deactivated before down() is not recorded and not reactivated by up()', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    svc(knex, CAR).is_active = false;
    await migration.down(knex);
    expect(stateOf(knex).deactivated).toEqual([{ key: ADDON, id: idOf(knex, ADDON) }]);
    expect(svc(knex, CAR)).toMatchObject({ is_active: false, booking_enabled: false });
    await migration.up(knex);
    expect(svc(knex, CAR).is_active).toBe(false);
    expect(svc(knex, ADDON).is_active).toBe(true);
  });

  test('an admin who enabled booking keeps it through down and up', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    svc(knex, CAR).booking_enabled = true;
    await migration.down(knex);
    expect(svc(knex, CAR)).toMatchObject({ is_active: false, booking_enabled: true });
    await migration.up(knex);
    expect(svc(knex, CAR)).toMatchObject({ is_active: true, booking_enabled: true });
  });

  test('an admin who edits a row after down() keeps them through up()', async () => {
    const knex = fakeKnex(BASE);
    await migration.up(knex);
    await migration.down(knex);
    Object.assign(svc(knex, ADDON), { booking_enabled: true, base_price: 120, customer_visible: true });
    await migration.up(knex);
    expect(svc(knex, ADDON)).toMatchObject({ is_active: true, booking_enabled: true, base_price: 120, customer_visible: true });
  });

  test('a rule or profile an admin created first is not changed', async () => {
    const knex = fakeKnex({
      ...BASE,
      service_discount_rules: [{ service_key: ADDON, exclude_from_pct_discount: false }],
      service_completion_profiles: [{ service_key: ADDON, notes: 'admin profile' }],
    });
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.db.service_discount_rules.filter((r) => r.service_key === ADDON)).toEqual([{ service_key: ADDON, exclude_from_pct_discount: false }]);
    expect(knex.db.service_completion_profiles.filter((p) => p.service_key === ADDON)).toEqual([{ service_key: ADDON, notes: 'admin profile' }]);
  });
});

describe('products match the household German roach protocol (owner 2026-10-08)', () => {
  test('the car job declares Alpine WSG, Advion Gel and Gentrol IGR, as cockroach_control does', () => {
    const car = SERVICES.find((s) => s.service_key === 'vehicle_german_roach');
    expect(JSON.parse(car.default_products)).toEqual(['Alpine WSG', 'Advion Gel', 'Gentrol IGR']);
  });
});
