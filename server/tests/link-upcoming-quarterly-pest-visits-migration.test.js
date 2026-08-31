/**
 * 20260831000030 — alias "Quarterly Pest Control" → pest_general_quarterly
 * for OPEN unlinked visits, with 20260829000060's identity rules. Pins:
 * label alias (trim/case), open incl. NULL status, terminal/linked/other
 * labels (combo) untouched, snapshot conflict never linked (listed), NULL
 * snapshot stamped, existing agreeing snapshot kept, write-time catalog
 * eligibility guard, missing catalog row → no-op, idempotent up(), and
 * down() that only touches rows still open with the exact linkage.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const migration = require('../models/migrations/20260831000030_link_upcoming_quarterly_pest_visits');

const { STATE_KEY } = migration;

function seedDb() {
  return {
    services: [
      { id: 'svc-pq', service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control Service', is_active: true, is_archived: false },
      { id: 'svc-tb', service_key: 'termite_bait', name: 'Termite Bait Station Service', is_active: true, is_archived: false },
    ],
    scheduled_services: [
      { id: 'v1', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: null, status: 'confirmed' },
      { id: 'v2', service_type: '  quarterly pest control ', service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v3', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: null, status: null }, // legacy NULL = open
      { id: 'v-agree', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: 'pest_general_quarterly', status: 'pending' },
      { id: 'v-conflict', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: 'termite_bait', status: 'pending' },
      { id: 'v-done', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: null, status: 'cancelled' },
      { id: 'v-linked', service_type: 'Quarterly Pest Control', service_id: 'svc-pq', service_key_snapshot: 'pest_general_quarterly', status: 'confirmed' },
      { id: 'v-combo', service_type: 'Quarterly Pest + Termite Control Service', service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v-other', service_type: 'Quarterly Pest Control Service', service_id: null, service_key_snapshot: null, status: 'pending' },
    ],
    system_settings: [],
  };
}

const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];

function fakeKnex(db, { missingTables = [], missingColumns = [], catalogEditDuringWrite } = {}) {
  const knex = (table) => {
    const preds = [];
    const rows = () => db[table] || [];
    const q = {
      where(a) {
        if (typeof a === 'function') {
          const g = { nulls: [], orNotIns: [] };
          const b = {
            whereNull(col) { g.nulls.push(col); return b; },
            orWhereNotIn(col, vals) { g.orNotIns.push({ col, vals }); return b; },
          };
          a(b);
          preds.push((r) => g.nulls.some((c) => r[c] == null) || g.orNotIns.some((c) => !c.vals.includes(r[c.col])));
          return q;
        }
        preds.push((r) => Object.entries(a).every(([k, v]) => (r[k] ?? null) === v));
        return q;
      },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereRaw(sql, bindings) {
        if (!/^EXISTS \(SELECT 1 FROM services WHERE id = \? AND service_key = \? AND is_active = true AND is_archived = false\)$/.test(sql)) {
          throw new Error(`fake whereRaw: ${sql}`);
        }
        const [id, key] = bindings;
        preds.push(() => {
          if (catalogEditDuringWrite) catalogEditDuringWrite(db);
          return (db.services || []).some((s) => s.id === id && s.service_key === key && s.is_active === true && s.is_archived === false);
        });
        return q;
      },
      async select(...cols) {
        return rows().filter((r) => preds.every((p) => p(r))).map((r) => {
          const o = {}; (cols.length ? cols : Object.keys(r)).forEach((c) => { o[c] = r[c] ?? null; }); return o;
        });
      },
      async first(...cols) {
        const h = rows().find((r) => preds.every((p) => p(r)));
        if (!h) return undefined;
        const o = {}; (cols.length ? cols : Object.keys(h)).forEach((c) => { o[c] = h[c] ?? null; }); return o;
      },
      async update(patch) {
        const hits = rows().filter((r) => preds.every((p) => p(r)));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      async insert(row) { db[table] = db[table] || []; db[table].push({ ...row }); return [1]; },
      async del() {
        const keep = rows().filter((r) => !preds.every((p) => p(r)));
        const n = rows().length - keep.length; db[table] = keep; return n;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t),
    hasColumn: async (t, c) => !missingColumns.includes(`${t}.${c}`),
  };
  return knex;
}

const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);
const row = (db, id) => db.scheduled_services.find((r) => r.id === id);

describe('20260831000030 alias-link open quarterly pest visits', () => {
  test('links open unlinked alias-label rows, stamps a NULL snapshot, keeps an agreeing one, and touches nothing else', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    for (const id of ['v1', 'v2', 'v3']) {
      expect(row(db, id).service_id).toBe('svc-pq');
      expect(row(db, id).service_key_snapshot).toBe('pest_general_quarterly'); // stamped with the link
    }
    expect(row(db, 'v-agree').service_id).toBe('svc-pq');
    expect(row(db, 'v-conflict').service_id).toBeNull(); // snapshot names another service → never re-pointed
    expect(row(db, 'v-done').service_id).toBeNull(); // terminal = history
    expect(row(db, 'v-linked').service_id).toBe('svc-pq'); // untouched
    expect(row(db, 'v-combo').service_id).toBeNull(); // combo label → owner ruling
    expect(row(db, 'v-other').service_id).toBeNull(); // exact catalog name is 000060's job, not an alias
    const st = state(db);
    expect(st.linked.map((l) => l.id).sort()).toEqual(['v-agree', 'v1', 'v2', 'v3']);
    expect(st.linked.find((l) => l.id === 'v-agree').service_key_snapshot).toBeNull(); // not ours to clear on down()
    expect(st.conflicts).toEqual([{ id: 'v-conflict', service_type: 'Quarterly Pest Control', service_key_snapshot: 'termite_bait', target_service_key: 'pest_general_quarterly' }]);
  });

  test('the alias map deliberately holds only the plain quarterly pest label', () => {
    expect(Object.keys(migration.LABEL_TO_KEY)).toEqual(['quarterly pest control']);
  });

  test('write-time guard: a catalog archive between scan and write makes the link miss', async () => {
    const db = seedDb();
    let edited = false;
    await migration.up(fakeKnex(db, {
      catalogEditDuringWrite: (d) => { if (!edited) { edited = true; d.services[0].is_archived = true; } },
    }));
    expect(db.scheduled_services.filter((r) => r.service_id === 'svc-pq' && r.id !== 'v-linked')).toHaveLength(0);
    expect(state(db).linked).toEqual([]);
  });

  test('missing/archived catalog row → no links, listed in state', async () => {
    const db = seedDb();
    db.services[0].is_archived = true;
    await migration.up(fakeKnex(db));
    expect(row(db, 'v1').service_id).toBeNull();
    expect(state(db)).toEqual({ linked: [], conflicts: [], missing_catalog: ['pest_general_quarterly'] });
  });

  test('without the snapshot column the link still lands and no snapshot is written', async () => {
    const db = seedDb();
    db.scheduled_services.forEach((r) => { delete r.service_key_snapshot; });
    await migration.up(fakeKnex(db, { missingColumns: ['scheduled_services.service_key_snapshot'] }));
    expect(row(db, 'v1').service_id).toBe('svc-pq');
    expect(row(db, 'v1').service_key_snapshot).toBeUndefined();
  });

  test('a second up() links nothing new, KEEPS the first run\'s ledger, and down() still undoes the first run', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const before = JSON.stringify(db.scheduled_services);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify(db.scheduled_services)).toBe(before);
    expect(state(db).linked.map((l) => l.id).sort()).toEqual(['v-agree', 'v1', 'v2', 'v3']);
    await migration.down(fakeKnex(db));
    expect(row(db, 'v1').service_id).toBeNull();
    expect(row(db, 'v3').service_id).toBeNull();
  });

  test('a later up() that links a NEW row appends to the ledger without dropping earlier entries', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v-new', service_type: 'Quarterly Pest Control', service_id: null, service_key_snapshot: null, status: 'pending' });
    await migration.up(fakeKnex(db));
    expect(state(db).linked.map((l) => l.id).sort()).toEqual(['v-agree', 'v-new', 'v1', 'v2', 'v3']);
  });

  test('down() unlinks only rows still open with the exact label + linkage, clearing only snapshots it stamped', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    row(db, 'v2').status = 'completed'; // became history under the link
    row(db, 'v3').service_id = 'svc-tb'; // admin re-pointed it since
    await migration.down(fakeKnex(db));
    expect(row(db, 'v1').service_id).toBeNull();
    expect(row(db, 'v1').service_key_snapshot).toBeNull();
    expect(row(db, 'v2').service_id).toBe('svc-pq'); // history kept
    expect(row(db, 'v3').service_id).toBe('svc-tb'); // admin's value kept
    expect(row(db, 'v-agree').service_id).toBeNull();
    expect(row(db, 'v-agree').service_key_snapshot).toBe('pest_general_quarterly'); // pre-existing snapshot untouched
    expect(row(db, 'v-linked').service_id).toBe('svc-pq'); // never ours
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
  });

  test('missing tables/columns → safe no-op in both directions', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingColumns: ['scheduled_services.service_id'] }));
    expect(row(db, 'v1').service_id).toBeNull();
    expect(db.system_settings).toEqual([]);
    await migration.down(fakeKnex(db, { missingTables: ['scheduled_services'] }));
  });
});
