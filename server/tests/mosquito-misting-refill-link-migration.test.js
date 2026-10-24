/**
 * 20261024100000: the service_addons row that makes the misting refill attachable to the misting service plan (misting PR 2c).
 * Idempotent and self-healing: skip-if-exists, state recorded, down() removes only the row up() proved it inserted.
 */
const catalog = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
const migration = require('../models/migrations/20261024100000_mosquito_misting_refill_addon_link');

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

const ALL_SERVICE_COLUMNS = ['id', ...new Set(catalog.SERVICES.flatMap((s) => Object.keys(s)))];
function emptyDb() {
  return {
    __columns: { services: ALL_SERVICE_COLUMNS },
    services: [], service_completion_profiles: [], service_taxability: [], service_discount_rules: [], system_settings: [],
    service_records: [], scheduled_services: [], service_addons: [], service_package_items: [], scheduled_service_addons: [],
    discounts: [], leads: [],
  };
}
const svc = (db, key) => db.services.find((r) => r.service_key === key);
const state = (db) => { const row = db.system_settings.find((r) => r.key === migration.STATE_KEY); return row ? JSON.parse(row.value) : undefined; };
const withCatalog = async () => { const db = emptyDb(); await catalog.up(fakeKnex(db)); return db; };
const link = (db) => db.service_addons.filter((r) => r.parent_service_id === svc(db, 'mosquito_misting_service').id && r.addon_service_id === svc(db, 'mosquito_misting_refill').id);

describe('up()', () => {
  test('adds ONE link from the service plan to the refill, with no fixed add-on price, and records it', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    expect(link(db)).toHaveLength(1);
    expect(link(db)[0]).toMatchObject({ is_default: false, addon_price: null, sort_order: 0 });
    expect(state(db).links).toEqual([{ id: link(db)[0].id, parent_service_id: svc(db, 'mosquito_misting_service').id, addon_service_id: svc(db, 'mosquito_misting_refill').id }]);
  });

  test('changes no service row, profile, tax row or discount rule', async () => {
    const db = await withCatalog();
    const before = JSON.stringify({ s: db.services, p: db.service_completion_profiles, t: db.service_taxability, r: db.service_discount_rules });
    await migration.up(fakeKnex(db));
    expect(JSON.stringify({ s: db.services, p: db.service_completion_profiles, t: db.service_taxability, r: db.service_discount_rules })).toBe(before);
  });

  test('is idempotent: a second run adds nothing', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(link(db)).toHaveLength(1);
    expect(state(db).links).toHaveLength(1);
  });

  test('a link that already exists (an operator\'s) is left untouched and is NOT recorded, so down() keeps it', async () => {
    const db = await withCatalog();
    db.service_addons.push({ id: 'ops-link', parent_service_id: svc(db, 'mosquito_misting_service').id, addon_service_id: svc(db, 'mosquito_misting_refill').id, is_default: true, addon_price: 100, sort_order: 3 });
    await migration.up(fakeKnex(db));
    expect(db.service_addons).toHaveLength(1);
    expect(db.service_addons[0]).toMatchObject({ id: 'ops-link', is_default: true, addon_price: 100 });
    expect(state(db)).toBeUndefined();
    await migration.down(fakeKnex(db));
    expect(db.service_addons).toHaveLength(1);
  });

  test('self-heals: with the catalog rows missing it adds nothing, and a later run adds the link once they exist', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    expect(db.service_addons).toEqual([]);
    expect(state(db)).toBeUndefined();
    await catalog.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(link(db)).toHaveLength(1);
  });

  test('skips quietly when the tables are absent', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db, { missingTables: ['service_addons'] }));
    expect(db.service_addons).toEqual([]);
    await migration.up(fakeKnex(db, { missingTables: ['services'] }));
    expect(db.service_addons).toEqual([]);
  });

  test('without a system_settings table the link is still added (it just is not recorded)', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db, { missingTables: ['system_settings'] }));
    expect(link(db)).toHaveLength(1);
  });
});

describe('down()', () => {
  test('removes exactly the recorded link and the state row, nothing else', async () => {
    const db = await withCatalog();
    db.service_addons.push({ id: 'other', parent_service_id: 'x', addon_service_id: 'y' });
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(link(db)).toHaveLength(0);
    expect(db.service_addons.map((r) => r.id)).toEqual(['other']);
    expect(state(db)).toBeUndefined();
    expect(db.services).toHaveLength(3);
  });

  test('a recorded row an operator re-pointed is left alone', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    link(db)[0].addon_service_id = 'something-else';
    await migration.down(fakeKnex(db));
    expect(db.service_addons).toHaveLength(1);
  });

  test('with no readable state it removes nothing', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    db.system_settings.find((r) => r.key === migration.STATE_KEY).value = '{not json';
    await migration.down(fakeKnex(db));
    expect(link(db)).toHaveLength(1);
    db.system_settings = [];
    await migration.down(fakeKnex(db));
    expect(link(db)).toHaveLength(1);
  });

  test('a second down() is harmless', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.service_addons).toEqual([]);
  });

  test('rolled back in reverse order, the catalog down() finds no link of ours and removes the three rows it inserted', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    await catalog.down(fakeKnex(db));
    expect(db.services).toEqual([]);
  });

  test('rolled back OUT of order, the catalog down() keeps the referenced rows (deactivated) instead of cascading our link away', async () => {
    const db = await withCatalog();
    await migration.up(fakeKnex(db));
    await catalog.down(fakeKnex(db));
    expect(svc(db, 'mosquito_misting_refill')).toMatchObject({ is_active: false });
    expect(svc(db, 'mosquito_misting_service')).toMatchObject({ is_active: false });
    expect(link(db)).toHaveLength(1);
  });
});
