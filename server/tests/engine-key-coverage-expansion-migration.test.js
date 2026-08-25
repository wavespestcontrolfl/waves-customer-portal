/**
 * 20260825000011 engine-key coverage expansion: seeds an unambiguous 1:1
 * catalog link for every engine key the 2026-08-25 audit found booking with
 * no identity, appends the legacy 'wasp' alias to bee_wasp_removal, and
 * keeps the parent migration's contract — rows already carrying engine_keys
 * are never overwritten, and down() removes only values it proved it wrote.
 */
const migration = require('../models/migrations/20260825000011_engine_key_coverage_expansion');

const { ENGINE_KEY_SEEDS, WASP_ALIAS_TARGET } = migration;

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((cond) => Object.entries(cond).every(([k, v]) => {
      if (v === null) return r[k] === null || r[k] === undefined;
      return r[k] === v;
    }));
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
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
        (db[table] = rowsNow()).push({ ...row });
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
const keysOf = (row) => JSON.parse(row.engine_keys);

function seedDb() {
  return {
    services: [
      ...ENGINE_KEY_SEEDS.map((s, i) => ({ id: `svc-${i}`, service_key: s.service_key, engine_keys: null })),
      // Admin already stamped this row — must never be overwritten.
      { id: 'svc-admin', service_key: 'foam_drill', engine_keys: null },
      { id: 'svc-wasp', service_key: 'bee_wasp_removal', engine_keys: [...WASP_ALIAS_TARGET.shipped] },
    ].filter((r, i, all) => all.findIndex((x) => x.service_key === r.service_key) === i),
    system_settings: [],
  };
}

describe('20260825000011 engine-key coverage expansion', () => {
  test('up() stamps every seed exactly, and appends the wasp alias', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    for (const seed of ENGINE_KEY_SEEDS) {
      expect(keysOf(svc(db, seed.service_key))).toEqual(seed.engine_keys);
    }
    expect(keysOf(svc(db, 'bee_wasp_removal')))
      .toEqual([...WASP_ALIAS_TARGET.shipped, WASP_ALIAS_TARGET.append]);
  });

  test('up() never overwrites a row that already carries engine_keys', async () => {
    const db = seedDb();
    svc(db, 'foam_drill').engine_keys = JSON.stringify(['adam_custom']);
    svc(db, 'bee_wasp_removal').engine_keys = ['stinging_insect', 'adam_extra'];
    await migration.up(fakeKnex(db));
    expect(keysOf(svc(db, 'foam_drill'))).toEqual(['adam_custom']);
    // Non-shipped array → the wasp append refuses to touch it.
    expect(svc(db, 'bee_wasp_removal').engine_keys).toEqual(['stinging_insect', 'adam_extra']);
  });

  test('up() skips a row an admin pre-stamped with the IDENTICAL array, and down() leaves it (ownership is recorded, not inferred)', async () => {
    const db = seedDb();
    // Admin already stamped foam_drill with exactly the seed value before
    // the deploy — value equality must NOT read as migration ownership.
    svc(db, 'foam_drill').engine_keys = ['foam_drill'];
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(svc(db, 'foam_drill').engine_keys).toEqual(['foam_drill']);
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    svc(db, 'bora_care').engine_keys = ['bora_care'];
    await migration.down(fakeKnex(db));
    expect(svc(db, 'bora_care').engine_keys).toEqual(['bora_care']);
  });

  test('down() clears only exactly-seeded values and reverts the wasp append', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    // Convert stored JSON strings to arrays the way pg jsonb returns them.
    for (const r of db.services) {
      if (typeof r.engine_keys === 'string') r.engine_keys = JSON.parse(r.engine_keys);
    }
    // One row drifted post-up (admin added an alias) — down must keep it.
    svc(db, 'bora_care').engine_keys = ['bora_care', 'adam_added'];
    await migration.down(fakeKnex(db));
    for (const seed of ENGINE_KEY_SEEDS) {
      if (seed.service_key === 'bora_care') continue;
      expect(svc(db, seed.service_key).engine_keys).toBeNull();
    }
    expect(svc(db, 'bora_care').engine_keys).toEqual(['bora_care', 'adam_added']);
    expect(keysOf(svc(db, 'bee_wasp_removal'))).toEqual(WASP_ALIAS_TARGET.shipped);
  });

  test('no engine key appears in two seeds', () => {
    const seen = new Set();
    for (const seed of ENGINE_KEY_SEEDS) {
      for (const key of seed.engine_keys) {
        expect(seen.has(key) ? `${key} duplicated` : null).toBeNull();
        seen.add(key);
      }
    }
  });
});
