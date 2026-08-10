/**
 * 20260809000001 short-name alignment: two 20260808080000 rows carry
 * short_names that miss the v1 mapper's SERVICE_LABEL vocabulary, so a
 * visit persisted under the mapper label resolves no catalog row.
 */
const migration = require('../models/migrations/20260809000001_align_gap_row_short_names_to_mapper');

const STATE_KEY = 'migration.20260809000001.state';

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
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
      insert: async (row) => { (db[table] = rowsNow()).push({ ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db, hasColumn: async () => true };
  return knex;
}

// Prod shape after 20260808080000.
const seededDb = () => ({
  services: [
    { id: 'dethatch-row', service_key: 'dethatching', name: 'Lawn Dethatching', short_name: 'Dethatch' },
    { id: 'topdress-row', service_key: 'top_dressing', name: 'Lawn Top Dressing', short_name: 'Top Dress' },
  ],
  system_settings: [],
  scheduled_services: [],
  scheduled_service_addons: [],
});

const shortName = (db, key) => db.services.find((r) => r.service_key === key).short_name;

describe('20260809000001 short-name alignment', () => {
  test('up() aligns both short_names to the mapper labels and records the change', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));

    expect(shortName(db, 'dethatching')).toBe('Dethatching');
    expect(shortName(db, 'top_dressing')).toBe('Top Dressing');
    const state = JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);
    expect(state.changed.map((c) => c.key).sort()).toEqual(['dethatching', 'top_dressing']);
  });

  test('up() never touches a short_name an admin already changed', async () => {
    const db = seededDb();
    db.services[0].short_name = 'Admin Choice';
    await migration.up(fakeKnex(db));

    expect(shortName(db, 'dethatching')).toBe('Admin Choice');
    const state = JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);
    expect(state.changed.map((c) => c.key)).toEqual(['top_dressing']);
  });

  test('down() reverts cleanly when nothing depends on the new alias', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(shortName(db, 'dethatching')).toBe('Dethatch');
    expect(shortName(db, 'top_dressing')).toBe('Top Dress');
    expect(db.system_settings).toHaveLength(0);
  });

  test('down() KEEPS an alias an in-flight name-only visit resolves through', async () => {
    const db = seededDb();
    await migration.up(fakeKnex(db));
    // Visit persisted under the mapper label; the row's only match is the
    // new short_name (catalog name is 'Lawn Dethatching').
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'Dethatching' });
    // Same for an add-on line on the other row.
    db.scheduled_service_addons.push({ id: 'ssa-1', service_id: null, service_name: 'Top Dressing' });

    await migration.down(fakeKnex(db));

    expect(shortName(db, 'dethatching')).toBe('Dethatching');
    expect(shortName(db, 'top_dressing')).toBe('Top Dressing');
  });
});
