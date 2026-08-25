/**
 * 20260825000011 engine-key coverage expansion: seeds an unambiguous 1:1
 * catalog link for every engine key the 2026-08-25 audit found booking with
 * no identity, appends the legacy aliases (wasp → bee_wasp_removal,
 * pre_slab_termidor → termite_slab_pretreat), and records ownership by
 * {service_key, id} in a system_settings state row — down() reverses only
 * recorded rows (still value-guarded), so an admin who pre-stamped an
 * identical array, or recreated a deleted row under the same key, survives
 * rollback. Appends are compare-and-set on the shipped array.
 */
const migration = require('../models/migrations/20260825000011_engine_key_coverage_expansion');

const { ENGINE_KEY_SEEDS, ALIAS_APPENDS, CONDITIONAL_SEEDS } = migration;
const STATE_KEY = 'migration.20260825000011.state';

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
      // Emulates the jsonb shapes: engine_keys = ?::jsonb (CAS) and
      // engine_keys @> ?::jsonb (containment, duplicate-owner guard)
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
  return knex;
}

const svc = (db, key) => db.services.find((r) => r.service_key === key);
const keysOf = (row) => (Array.isArray(row.engine_keys) ? row.engine_keys : JSON.parse(row.engine_keys));
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

function seedDb() {
  return {
    services: [
      ...ENGINE_KEY_SEEDS.map((s, i) => ({ id: `svc-${i}`, service_key: s.service_key, engine_keys: null })),
      ...ALIAS_APPENDS.map((t, i) => ({ id: `svc-app-${i}`, service_key: t.service_key, engine_keys: [...t.shipped] })),
    ],
    system_settings: [],
  };
}

describe('20260825000011 engine-key coverage expansion', () => {
  test('up() stamps every seed exactly and appends both legacy aliases', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    for (const seed of ENGINE_KEY_SEEDS) {
      expect(keysOf(svc(db, seed.service_key))).toEqual(seed.engine_keys);
    }
    for (const target of ALIAS_APPENDS) {
      expect(keysOf(svc(db, target.service_key))).toEqual([...target.shipped, target.append]);
    }
    const state = JSON.parse(stateRow(db).value);
    expect(state.stamped.map((r) => r.service_key).sort())
      .toEqual(ENGINE_KEY_SEEDS.map((s) => s.service_key).sort());
    expect(state.appended.map((r) => r.service_key).sort())
      .toEqual(ALIAS_APPENDS.map((t) => t.service_key).sort());
  });

  test('up() never overwrites a row that already carries engine_keys', async () => {
    const db = seedDb();
    svc(db, 'foam_drill').engine_keys = JSON.stringify(['adam_custom']);
    svc(db, 'bee_wasp_removal').engine_keys = ['stinging_insect', 'adam_extra'];
    await migration.up(fakeKnex(db));
    expect(keysOf(svc(db, 'foam_drill'))).toEqual(['adam_custom']);
    // Non-shipped array → the append refuses to touch it.
    expect(svc(db, 'bee_wasp_removal').engine_keys).toEqual(['stinging_insect', 'adam_extra']);
    const state = JSON.parse(stateRow(db).value);
    expect(state.stamped.some((r) => r.service_key === 'foam_drill')).toBe(false);
    expect(state.appended.some((r) => r.service_key === 'bee_wasp_removal')).toBe(false);
  });

  test('a key already owned by a DIFFERENT active row is skipped — no duplicate owners', async () => {
    // Admin mappings are free-form: if another active row already claims a
    // seeded key, stamping the seed would give the key two active owners and
    // catalogLinkForProfile would fail closed on BOTH (pre-push P1).
    const db = seedDb();
    const seed = ENGINE_KEY_SEEDS[0];
    db.services.push({ id: 'svc-admin', service_key: 'admin_custom', is_active: true, engine_keys: [seed.engine_keys[0]] });
    const appendTarget = ALIAS_APPENDS[0];
    db.services.push({ id: 'svc-admin2', service_key: 'admin_custom2', is_active: true, engine_keys: [appendTarget.append] });
    await migration.up(fakeKnex(db));
    expect(svc(db, seed.service_key).engine_keys).toBeNull();
    expect(keysOf(svc(db, appendTarget.service_key))).toEqual([...appendTarget.shipped]);
    // Unaffected seeds still stamp.
    const other = ENGINE_KEY_SEEDS[1];
    expect(keysOf(svc(db, other.service_key))).toEqual(other.engine_keys);
    const state = JSON.parse(stateRow(db).value);
    expect(state.stamped.some((r) => r.service_key === seed.service_key)).toBe(false);
    expect(state.appended.some((r) => r.service_key === appendTarget.service_key)).toBe(false);
  });

  test('admin pre-stamp of the IDENTICAL array is never claimed nor rolled back', async () => {
    const db = seedDb();
    svc(db, 'bora_care').engine_keys = ['bora_care'];
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'bora_care').engine_keys).toEqual(['bora_care']);
  });

  test('down() reverses only recorded rows BY ID — a recreated same-key row survives', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    // Simulate delete + admin recreate of the same key with the same array.
    db.services = db.services.filter((r) => r.service_key !== 'wdo_inspection');
    db.services.push({ id: 'svc-recreated', service_key: 'wdo_inspection', engine_keys: ['wdo_inspection'] });
    await migration.down(fakeKnex(db));
    expect(svc(db, 'wdo_inspection').engine_keys).toEqual(['wdo_inspection']);
    // Rows up() stamped (and still carrying the seeded value) are cleared.
    expect(svc(db, 'bora_care').engine_keys).toBeNull();
    for (const target of ALIAS_APPENDS) {
      expect(keysOf(svc(db, target.service_key))).toEqual(target.shipped);
    }
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    svc(db, 'bora_care').engine_keys = ['bora_care'];
    await migration.down(fakeKnex(db));
    expect(svc(db, 'bora_care').engine_keys).toEqual(['bora_care']);
  });

  test('drifted values survive down() (value guard on recorded rows)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    svc(db, 'dethatching').engine_keys = ['dethatching', 'adam_added'];
    await migration.down(fakeKnex(db));
    expect(svc(db, 'dethatching').engine_keys).toEqual(['dethatching', 'adam_added']);
  });

  test('the conditional one_time_pest seed lands on whichever row the environment has', async () => {
    // Prod shape: one_time_pest_control exists → it gets the key.
    const prodDb = seedDb();
    prodDb.services.push({ id: 'svc-otp', service_key: 'one_time_pest_control', engine_keys: null });
    await migration.up(fakeKnex(prodDb));
    expect(keysOf(svc(prodDb, 'one_time_pest_control'))).toEqual(['one_time_pest']);

    // Migration-built shape: only the documented twin exists → IT gets the
    // key; no parallel row is ever created (codex #3485 r3 P1).
    const freshDb = seedDb();
    freshDb.services.push({ id: 'svc-cleanout', service_key: 'pest_initial_cleanout', engine_keys: null });
    await migration.up(fakeKnex(freshDb));
    expect(keysOf(svc(freshDb, 'pest_initial_cleanout'))).toEqual(['one_time_pest']);
    expect(svc(freshDb, 'one_time_pest_control')).toBeUndefined();

    // down() clears the conditional stamp by recorded id.
    await migration.down(fakeKnex(freshDb));
    expect(svc(freshDb, 'pest_initial_cleanout').engine_keys).toBeNull();
  });

  test('a preferred conditional row that already carries the mapping stops the fallback (no duplicate owners)', async () => {
    const db = seedDb();
    db.services.push({ id: 'svc-otp', service_key: 'one_time_pest_control', engine_keys: ['one_time_pest'] });
    db.services.push({ id: 'svc-cleanout', service_key: 'pest_initial_cleanout', engine_keys: null });
    await migration.up(fakeKnex(db));
    // The admin-authored preferred mapping is preserved; the twin is NOT
    // stamped — two active owners would make catalogLinkForProfile fail
    // closed for every one_time_pest accept.
    expect(svc(db, 'one_time_pest_control').engine_keys).toEqual(['one_time_pest']);
    expect(svc(db, 'pest_initial_cleanout').engine_keys).toBeNull();
  });

  test('up() → up() → down() still reverses everything the FIRST run stamped', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'bora_care').engine_keys).toBeNull();
    for (const target of ALIAS_APPENDS) {
      expect(keysOf(svc(db, target.service_key))).toEqual(target.shipped);
    }
  });

  test('no engine key appears in two seeds or appends', () => {
    const seen = new Set();
    const all = [
      ...ENGINE_KEY_SEEDS.flatMap((s) => s.engine_keys),
      ...ALIAS_APPENDS.map((t) => t.append),
    ];
    for (const key of all) {
      expect(seen.has(key) ? `${key} duplicated` : null).toBeNull();
      seen.add(key);
    }
  });
});
