/**
 * 20260826000003: seeds engine_keys ['rodent_trapping'] onto the
 * rodent_trapping catalog row — unambiguous since the owner retired the
 * Standard plan (2026-08-25). Same guard pattern as 20260825000011:
 * unstamped-only, duplicate-owner skip, recorded ownership, value-guarded
 * down().
 */
const migration = require('../models/migrations/20260826000003_rodent_trapping_engine_key');

const { SEED } = migration;
const STATE_KEY = 'migration.20260826000003.state';

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const notFilters = [];
    const rawWheres = [];
    const rowsNow = () => db[table] || [];
    const condMatch = (r, cond) => Object.entries(cond).every(([k, v]) => {
      if (v === null) return r[k] === null || r[k] === undefined;
      return r[k] === v;
    });
    const parsedKeys = (r) => (Array.isArray(r.engine_keys) ? r.engine_keys
      : (() => { try { return JSON.parse(r.engine_keys); } catch { return null; } })());
    const rowMatch = (r) => (
      filters.every((cond) => condMatch(r, cond))
      && notFilters.every((cond) => !condMatch(r, cond))
      && rawWheres.every((rw) => {
        const keys = parsedKeys(r);
        if (rw.op === 'contains') {
          return Array.isArray(keys) && JSON.parse(rw.bindings[0]).every((k) => keys.includes(k));
        }
        return JSON.stringify(keys) === rw.bindings[0];
      })
    );
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereNot(cond) { notFilters.push(cond); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereRaw(sql, bindings) {
        if (/engine_keys\s*@>\s*\?::jsonb/.test(sql)) { rawWheres.push({ op: 'contains', bindings }); return q; }
        if (!/engine_keys\s*=\s*\?::jsonb/.test(sql)) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        rawWheres.push({ op: 'eq', bindings });
        return q;
      },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
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
      insert: async (row) => {
        (db[table] = rowsNow()).push({ id: `${table}-${rowsNow().length + 1}`, ...row });
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async (t, c) => t in db && c === 'engine_keys',
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => {
    if (!/^LOCK TABLE services/i.test(String(sql))) throw new Error(`fake raw: unsupported sql ${sql}`);
  };
  return knex;
}

const svc = (db) => db.services.find((r) => r.service_key === SEED.service_key);
const keysOf = (row) => (Array.isArray(row.engine_keys) ? row.engine_keys : JSON.parse(row.engine_keys));
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

function seedDb() {
  return {
    services: [{ id: 'svc-trap', service_key: 'rodent_trapping', is_active: true, engine_keys: null }],
    system_settings: [],
  };
}

describe('20260826000003 rodent_trapping engine key', () => {
  test('up() stamps the row and records ownership; down() reverses it', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(keysOf(svc(db))).toEqual(['rodent_trapping']);
    expect(JSON.parse(stateRow(db).value).stamped).toEqual([{ service_key: 'rodent_trapping', id: 'svc-trap' }]);
    await migration.down(fakeKnex(db));
    expect(svc(db).engine_keys).toBeNull();
    expect(stateRow(db)).toBeUndefined();
  });

  test('an admin-stamped row is never overwritten nor claimed', async () => {
    const db = seedDb();
    svc(db).engine_keys = ['adam_custom'];
    await migration.up(fakeKnex(db));
    expect(svc(db).engine_keys).toEqual(['adam_custom']);
    expect(JSON.parse(stateRow(db).value).stamped).toEqual([]);
  });

  test('a key already owned by a DIFFERENT active row is skipped — no duplicate owners', async () => {
    const db = seedDb();
    db.services.push({ id: 'svc-admin', service_key: 'admin_custom', is_active: true, engine_keys: ['rodent_trapping'] });
    await migration.up(fakeKnex(db));
    expect(svc(db).engine_keys).toBeNull();
    expect(JSON.parse(stateRow(db).value).stamped).toEqual([]);
  });

  test('down() ignores a drifted value (admin edit survives rollback)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    svc(db).engine_keys = JSON.stringify(['rodent_trapping', 'adam_extra']);
    await migration.down(fakeKnex(db));
    expect(JSON.parse(svc(db).engine_keys)).toEqual(['rodent_trapping', 'adam_extra']);
  });

  test('missing table/column is a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
