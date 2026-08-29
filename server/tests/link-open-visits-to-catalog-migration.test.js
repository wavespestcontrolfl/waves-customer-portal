/**
 * Migration 20260829000060 — link OPEN unlinked visits to their catalog row
 * by exact (case-insensitive) name. Asserts: exactly-one-active-row
 * matching (ambiguous names listed, never linked), Invariant 1 (terminal
 * rows untouched), snapshot stamped only where NULL, the write-time catalog
 * re-check, and the CAS-recorded down().
 */
const migration = require('../models/migrations/20260829000060_link_open_visits_to_catalog');

const STATE_KEY = 'migration.20260829000060.state';
const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];

function fakeKnex(db, { missingTables = [], missingColumns = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const nulls = [];
    let openOnly = false;
    const raws = [];
    const rows = () => db[table] || [];
    const isOpen = (r) => r.status == null || !TERMINAL.includes(r.status);
    const match = (r) => {
      if (openOnly && !isOpen(r)) return false;
      if (!nulls.every((c) => r[c] == null)) return false;
      if (!raws.every((fn) => fn())) return false;
      return filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v));
    };
    const q = {
      where(cond) { if (typeof cond === 'function') openOnly = true; else filters.push(cond); return q; },
      whereNull(col) { nulls.push(col); return q; },
      whereRaw(sql, b) {
        if (!/^EXISTS \(SELECT 1 FROM services WHERE id = \? AND lower\(name\) = lower\(\?\) AND is_active = true\)$/.test(sql)) throw new Error(`unsupported ${sql}`);
        raws.push(() => (db.services || []).some((s) => s.id === b[0] && String(s.name).toLowerCase() === String(b[1]).toLowerCase() && s.is_active === true));
        return q;
      },
      async select(...cols) { return rows().filter(match).map((r) => (cols.length ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r })); },
      async first() { return rows().filter(match)[0] || null; },
      async update(payload) { const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, payload)); return hit.length; },
      async insert(payload) { rows().push({ ...payload }); return [1]; },
      async del() { const keep = rows().filter((r) => !match(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && !!db[t],
    hasColumn: async (t, c) => !missingColumns.includes(`${t}.${c}`) && (db[t] || []).some((r) => c in r),
  };
  return knex;
}

function seedDb() {
  return {
    services: [
      { id: 'svc-q', name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', is_active: true },
      { id: 'svc-m', name: 'Monthly Pest Control Service', service_key: 'pest_monthly', is_active: true },
      { id: 'svc-old', name: 'Retired Plan', service_key: 'retired', is_active: false },
      { id: 'svc-dup-a', name: 'Palm Care', service_key: 'palm_a', is_active: true },
      { id: 'svc-dup-b', name: 'Palm Care', service_key: 'palm_b', is_active: true },
    ],
    scheduled_services: [
      // links, snapshot stamped (was NULL)
      { id: 'v1', service_id: null, service_type: 'Quarterly Pest Control Service', status: 'pending', service_key_snapshot: null },
      // links, case-insensitive; snapshot already set → left alone
      { id: 'v2', service_id: null, service_type: 'monthly pest control service', status: null, service_key_snapshot: 'keep_me' },
      // terminal — Invariant 1
      { id: 'v3', service_id: null, service_type: 'Quarterly Pest Control Service', status: 'completed', service_key_snapshot: null },
      // already linked — untouched
      { id: 'v4', service_id: 'svc-q', service_type: 'Quarterly Pest Control Service', status: 'pending', service_key_snapshot: 'pest_quarterly' },
      // only an INACTIVE row carries the name — no link
      { id: 'v5', service_id: null, service_type: 'Retired Plan', status: 'pending', service_key_snapshot: null },
      // two active rows share the name — ambiguous, listed, no link
      { id: 'v6', service_id: null, service_type: 'Palm Care', status: 'confirmed', service_key_snapshot: null },
      // no catalog row at all
      { id: 'v7', service_id: null, service_type: 'Owner Custom Label', status: 'pending', service_key_snapshot: null },
    ],
    system_settings: [],
  };
}
const byId = (db, id) => db.scheduled_services.find((r) => r.id === id);
const readState = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260829000060 up()', () => {
  test('links open unlinked visits to the one active row by name; stamps snapshot only where NULL; lists ambiguous', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(byId(db, 'v1')).toMatchObject({ service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' });
    expect(byId(db, 'v2')).toMatchObject({ service_id: 'svc-m', service_key_snapshot: 'keep_me' });
    expect(byId(db, 'v3')).toMatchObject({ service_id: null, service_key_snapshot: null });
    expect(byId(db, 'v4')).toMatchObject({ service_id: 'svc-q' });
    expect(byId(db, 'v5').service_id).toBeNull();
    expect(byId(db, 'v6').service_id).toBeNull();
    expect(byId(db, 'v7').service_id).toBeNull();
    const state = readState(db);
    expect(state.linked).toEqual([
      { id: 'v1', service_type: 'Quarterly Pest Control Service', service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' },
      { id: 'v2', service_type: 'monthly pest control service', service_id: 'svc-m', service_key_snapshot: null },
    ]);
    expect(state.ambiguous).toEqual([{ id: 'v6', service_type: 'Palm Care' }]);
  });

  test('a catalog rename/deactivation between read and write makes the CAS miss', async () => {
    const db = seedDb();
    const orig = fakeKnex(db);
    let flipped = false;
    const wrapped = (t) => {
      const q = orig(t);
      const update = q.update;
      q.update = async (payload) => {
        if (!flipped && t === 'scheduled_services' && payload.service_id === 'svc-q') {
          flipped = true;
          db.services.find((s) => s.id === 'svc-q').is_active = false;
        }
        return update(payload);
      };
      return q;
    };
    wrapped.schema = orig.schema;
    await migration.up(wrapped);
    expect(byId(db, 'v1').service_id).toBeNull();
    expect(byId(db, 'v2').service_id).toBe('svc-m');
    expect(readState(db).linked.map((r) => r.id)).toEqual(['v2']);
  });

  test('works without the service_key_snapshot column', async () => {
    const db = seedDb();
    db.scheduled_services.forEach((r) => { delete r.service_key_snapshot; });
    await migration.up(fakeKnex(db));
    expect(byId(db, 'v1').service_id).toBe('svc-q');
    expect('service_key_snapshot' in byId(db, 'v1')).toBe(false);
    expect(readState(db).linked[0].service_key_snapshot).toBeNull();
  });

  test('no-ops without scheduled_services', async () => {
    const db = seedDb();
    await expect(migration.up(fakeKnex(db, { missingTables: ['scheduled_services'] }))).resolves.toBeUndefined();
    expect(db.system_settings).toHaveLength(0);
  });
});

describe('20260829000060 down()', () => {
  test('unlinks only rows still open, same label, same linkage; restores only the snapshot it stamped; clears state', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    const v1After = { ...byId(db, 'v1') };
    expect(v1After.service_id).toBe('svc-q');
    // v2 completed under the link → history, kept.
    byId(db, 'v2').status = 'completed';
    await migration.down(knex);
    expect(byId(db, 'v1')).toMatchObject({ service_id: null, service_key_snapshot: null });
    expect(byId(db, 'v2')).toMatchObject({ service_id: 'svc-m', service_key_snapshot: 'keep_me' });
    expect(byId(db, 'v4')).toMatchObject({ service_id: 'svc-q', service_key_snapshot: 'pest_quarterly' }); // never ours
    expect(db.system_settings).toHaveLength(0);
  });

  test('a row the owner relinked or relabeled since is left alone', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'v1').service_id = 'svc-m'; // relinked since
    byId(db, 'v2').service_type = 'Owner Custom'; // relabeled since
    await migration.down(knex);
    expect(byId(db, 'v1').service_id).toBe('svc-m');
    expect(byId(db, 'v2').service_id).toBe('svc-m');
  });

  test('no-op without a state row', async () => {
    const db = seedDb();
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
  });
});
