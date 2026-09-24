/**
 * 20260924000020 mosquito misting catalog row — lead-only quote-on-request
 * product for the new mosquito misting system pages. No engine pricer yet;
 * public_quote_selectable=true with no PUBLIC_QUOTE_REQUESTS entry is the
 * existing quote-on-request mechanism (see public-services-menu.test.js).
 */
const migration = require('../models/migrations/20260924000020_mosquito_misting_catalog_row');
const { SELECTABLE_KEYS } = require('../models/migrations/20260829000020_services_public_quote_selectable');
const { PUBLIC_QUOTE_REQUESTS } = require('../services/public-services-menu');

const STATE_KEY = 'migration.20260924000020.state';
const SERVICE_KEY = 'mosquito_misting_system';

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

function emptyDb() {
  return {
    services: [],
    service_completion_profiles: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    service_addons: [],
    service_package_items: [],
    scheduled_service_addons: [],
    service_discount_rules: [],
    discounts: [],
    leads: [],
  };
}

const svcRow = (db) => db.services.find((r) => r.service_key === SERVICE_KEY);
const profileRow = (db) => db.service_completion_profiles.find((r) => r.service_key === SERVICE_KEY);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260924000020 mosquito misting catalog row', () => {
  test('the key is NOT in the 20260829000020 seed list and NOT wired to an engine request — it must stay quote-on-request by construction', () => {
    expect(SELECTABLE_KEYS).not.toContain(SERVICE_KEY);
    expect(PUBLIC_QUOTE_REQUESTS).not.toHaveProperty(SERVICE_KEY);
  });

  test('up() inserts a lead-only, unpriced, non-bookable row set directly public_quote_selectable', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    expect(svcRow(db)).toMatchObject({
      service_key: SERVICE_KEY,
      name: 'Mosquito Misting System Service',
      category: 'mosquito',
      billing_type: 'one_time',
      pricing_type: 'variable',
      base_price: null,
      price_range_min: null,
      price_range_max: null,
      booking_enabled: false,
      public_quote_selectable: true,
      customer_visible: true,
      is_active: true,
      is_archived: false,
    });
    expect(profileRow(db)).toMatchObject({
      completion_mode: 'service_report',
      delivery_mode: 'auto_send',
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      active: true,
    });
    const state = stateValue(db);
    expect(state.services).toEqual([{ key: SERVICE_KEY, id: svcRow(db).id }]);
    expect(state.profiles).toEqual([SERVICE_KEY]);
  });

  test('up() is idempotent and never overwrites a pre-existing row or an admin-edited public_quote_selectable value', async () => {
    const db = emptyDb();
    const adminRow = { id: 'admin-misting', service_key: SERVICE_KEY, name: 'Admin Renamed Misting', is_active: true, public_quote_selectable: false };
    db.services.push({ ...adminRow });
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(1);
    expect(svcRow(db)).toMatchObject(adminRow);
    // The profile heals onto the admin's row (name snapshot follows it), but
    // the service row itself — including its public_quote_selectable choice
    // — is never touched.
    expect(profileRow(db)).toMatchObject({ service_name_snapshot: 'Admin Renamed Misting' });
    expect(stateValue(db).services).toEqual([]);
  });

  test('down() on an unreferenced row deletes the service, the profile, and clears state', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() retains and deactivates a row referenced by a lead — never orphans a captured lead', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.leads.push({ id: 'lead-1', service_key: SERVICE_KEY });

    await migration.down(fakeKnex(db));

    expect(svcRow(db)).toMatchObject({ is_active: false });
    expect(profileRow(db)).toMatchObject({ active: true });
    expect(db.services).toHaveLength(1);
  });

  test('down() retains a row referenced by a scheduled visit (post-design-visit booking)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v1', service_id: svcRow(db).id });

    await migration.down(fakeKnex(db));

    expect(svcRow(db)).toMatchObject({ is_active: false });
    expect(db.services).toHaveLength(1);
  });

  test('down() is a documented no-op when up() never ran (no state row)', async () => {
    const db = emptyDb();
    await migration.down(fakeKnex(db));
    expect(db.services).toHaveLength(0);
  });
});
