/**
 * 20260902000010 — link OPEN unlinked visits through the SHARED label
 * bridge (legacyCatalogName cadence map + serviceNameCandidates), with
 * 000060/000030's identity rules. Pins: cadence pair beats suffix
 * expansion (a quarterly "Pest Control" series lands on the quarterly
 * plan, never the one-time job), suffix alias, ambiguity across the whole
 * catalog never links, inactive-only match never links, terminal/linked/
 * combo rows untouched, snapshot conflict listed not linked, NULL snapshot
 * stamped, write-time catalog guard, idempotent re-run keeps the ledger,
 * down() only touches rows still open with the exact linkage.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const migration = require('../models/migrations/20260902000010_link_open_legacy_label_visits');

const { STATE_KEY } = migration;

function seedDb() {
  return {
    services: [
      { id: 'svc-pq', service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control Service', is_active: true, is_archived: false },
      { id: 'svc-pm', service_key: 'pest_general_monthly', name: 'Monthly Pest Control Service', is_active: true, is_archived: false },
      { id: 'svc-ot', service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service', is_active: true, is_archived: false },
      { id: 'svc-l6', service_key: 'lawn_care_6week', name: 'Every 6 Weeks Lawn Care Service', is_active: true, is_archived: false },
      { id: 'svc-tb', service_key: 'termite_bait', name: 'Termite Bait Station Service', is_active: true, is_archived: false },
      // "Rodent Control" is carried by TWO rows (one retired) → ambiguous
      { id: 'svc-rc', service_key: 'rodent_control', name: 'Rodent Control Service', is_active: true, is_archived: false },
      { id: 'svc-rc-old', service_key: 'rodent_control_legacy', name: 'Rodent Control', is_active: false, is_archived: true },
      // A name only a retired row carries → never links
      { id: 'svc-mos-old', service_key: 'mosquito_legacy', name: 'Mosquito Control', is_active: false, is_archived: true },
    ],
    scheduled_services: [
      { id: 'v-cad', service_type: 'Pest Control', recurring_pattern: 'quarterly', service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v-cad-m', service_type: 'pest control', recurring_pattern: 'monthly', service_id: null, service_key_snapshot: null, status: null },
      { id: 'v-suffix', service_type: 'Every 6 Weeks Lawn Care', recurring_pattern: 'every_6_weeks', service_id: null, service_key_snapshot: null, status: 'confirmed' },
      { id: 'v-bare', service_type: 'Pest Control', recurring_pattern: 'custom', service_id: null, service_key_snapshot: null, status: 'on_site' },
      { id: 'v-ambig', service_type: 'Rodent Control', recurring_pattern: null, service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v-retired', service_type: 'Mosquito Control', recurring_pattern: null, service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v-agree', service_type: 'Pest Control', recurring_pattern: 'quarterly', service_id: null, service_key_snapshot: 'pest_general_quarterly', status: 'pending' },
      { id: 'v-conflict', service_type: 'Pest Control', recurring_pattern: 'quarterly', service_id: null, service_key_snapshot: 'termite_bait', status: 'pending' },
      { id: 'v-done', service_type: 'Pest Control', recurring_pattern: 'quarterly', service_id: null, service_key_snapshot: null, status: 'completed' },
      { id: 'v-linked', service_type: 'Pest Control', recurring_pattern: 'quarterly', service_id: 'svc-pq', service_key_snapshot: 'pest_general_quarterly', status: 'confirmed' },
      { id: 'v-combo', service_type: 'Quarterly Pest + Termite Control Service', recurring_pattern: 'quarterly', service_id: null, service_key_snapshot: null, status: 'pending' },
    ],
    system_settings: [],
  };
}

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
        const m = /^EXISTS \(SELECT 1 FROM services WHERE id = \? AND service_key = \? AND is_active = true AND is_archived IS NOT TRUE AND LOWER\(name\) IN \(((?:\?, )*\?)\)\) AND NOT EXISTS \(SELECT 1 FROM services WHERE id <> \? AND LOWER\(name\) IN \(((?:\?, )*\?)\)\)$/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: ${sql}`);
        const n = m[1].split(', ').length;
        const [id, key, ...rest] = bindings;
        const names = rest.slice(0, n);
        const otherId = rest[n];
        const names2 = rest.slice(n + 1);
        if (otherId !== id || names2.join('|') !== names.join('|')) throw new Error('fake whereRaw: binding mismatch');
        const lower = (s) => String(s || '').trim().toLowerCase();
        preds.push(() => {
          if (catalogEditDuringWrite) catalogEditDuringWrite(db);
          const svcs = db.services || [];
          const target = svcs.some((s) => s.id === id && s.service_key === key && s.is_active === true && s.is_archived !== true && names.includes(lower(s.name)));
          const other = svcs.some((s) => s.id !== id && names.includes(lower(s.name)));
          return target && !other;
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

describe('20260902000010 link open legacy-label visits through the shared bridge', () => {
  test('cadence pair and suffix alias link; ambiguity, retired-only, bare custom, terminal, linked and combo rows do not', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(row(db, 'v-cad').service_id).toBe('svc-pq'); // (Pest Control, quarterly) → quarterly plan, not the one-time job
    expect(row(db, 'v-cad').service_key_snapshot).toBe('pest_general_quarterly');
    expect(row(db, 'v-cad-m').service_id).toBe('svc-pm'); // trim/case + NULL status is open
    expect(row(db, 'v-suffix').service_id).toBe('svc-l6'); // " Service" suffix alias
    expect(row(db, 'v-bare').service_id).toBeNull(); // no cadence evidence: "Pest Control" alone is ambiguous by design
    expect(row(db, 'v-ambig').service_id).toBeNull(); // two catalog rows carry the name
    expect(row(db, 'v-retired').service_id).toBeNull(); // only a retired row carries the name
    expect(row(db, 'v-agree').service_id).toBe('svc-pq');
    expect(row(db, 'v-conflict').service_id).toBeNull();
    expect(row(db, 'v-done').service_id).toBeNull(); // terminal = history
    expect(row(db, 'v-linked').service_id).toBe('svc-pq');
    expect(row(db, 'v-combo').service_id).toBeNull();
    const st = state(db);
    expect(st.linked.map((l) => l.id).sort()).toEqual(['v-agree', 'v-cad', 'v-cad-m', 'v-suffix']);
    expect(st.linked.find((l) => l.id === 'v-agree').service_key_snapshot).toBeNull();
    expect(st.ambiguous).toEqual([{ id: 'v-ambig', service_type: 'Rodent Control' }]);
    expect(st.conflicts).toEqual([{ id: 'v-conflict', service_type: 'Pest Control', service_key_snapshot: 'termite_bait', target_service_key: 'pest_general_quarterly' }]);
  });

  test('resolveCatalogRow: the bare one-time suffix expansion never claims a recurring row when the cadence map has an answer', () => {
    const catalog = seedDb().services;
    expect(migration.resolveCatalogRow({ service_type: 'Pest Control', recurring_pattern: 'quarterly' }, catalog).row.id).toBe('svc-pq');
    expect(migration.resolveCatalogRow({ service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly' }, catalog).row.id).toBe('svc-pq');
    expect(migration.resolveCatalogRow({ service_type: 'One-Time Pest Control', recurring_pattern: null }, catalog).row.id).toBe('svc-ot');
    expect(migration.resolveCatalogRow({ service_type: 'Pest Control', recurring_pattern: null }, catalog)).toEqual({ row: null, reason: 'no_match' });
    expect(migration.resolveCatalogRow({ service_type: '', recurring_pattern: 'quarterly' }, catalog)).toEqual({ row: null, reason: 'no_label' });
  });

  test('write-time guard: a catalog archive between scan and write makes the link miss', async () => {
    const db = seedDb();
    let edited = false;
    await migration.up(fakeKnex(db, {
      catalogEditDuringWrite: (d) => { if (!edited) { edited = true; d.services.forEach((s) => { s.is_archived = true; }); } },
    }));
    expect(db.scheduled_services.filter((r) => r.service_id && r.id !== 'v-linked')).toHaveLength(0);
    expect(state(db).linked).toEqual([]);
  });

  test('write-time guard: a rename of the target, or another row acquiring a candidate name, makes the link miss', async () => {
    let db = seedDb();
    let edited = false;
    await migration.up(fakeKnex(db, {
      catalogEditDuringWrite: (d) => { if (!edited) { edited = true; d.services.find((s) => s.id === 'svc-pq').name = 'Quarterly WaveGuard Service'; } },
    }));
    expect(row(db, 'v-cad').service_id).toBeNull(); // first write hit the rename
    expect(row(db, 'v-cad-m').service_id).toBe('svc-pm'); // untouched target still links
    db = seedDb();
    edited = false;
    await migration.up(fakeKnex(db, {
      catalogEditDuringWrite: (d) => { if (!edited) { edited = true; d.services.push({ id: 'svc-dup', service_key: 'pest_dup', name: 'Quarterly Pest Control', is_active: false, is_archived: true }); } },
    }));
    expect(row(db, 'v-cad').service_id).toBeNull(); // a second row now carries a candidate name → ambiguous at write
  });

  test('down() on an agreeing-snapshot row requires that snapshot unchanged and never clears it', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(state(db).linked.find((l) => l.id === 'v-agree').prior_service_key_snapshot).toBe('pest_general_quarterly');
    row(db, 'v-agree').service_key_snapshot = 'pest_general_monthly'; // another writer moved it
    await migration.down(fakeKnex(db));
    expect(row(db, 'v-agree').service_id).toBe('svc-pq'); // not ours any more
    expect(row(db, 'v-agree').service_key_snapshot).toBe('pest_general_monthly');
  });

  test('idempotent: a re-run keeps the ledger and links nothing twice', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const first = state(db).linked;
    await migration.up(fakeKnex(db));
    expect(state(db).linked).toEqual(first);
  });

  test('down() unlinks only rows still open with the exact linkage/snapshot this migration set', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    row(db, 'v-cad-m').status = 'completed'; // completed under the link = history
    row(db, 'v-suffix').service_key_snapshot = 'lawn_care_monthly'; // snapshot edited since → not ours
    await migration.down(fakeKnex(db));
    expect(row(db, 'v-cad').service_id).toBeNull();
    expect(row(db, 'v-cad').service_key_snapshot).toBeNull();
    expect(row(db, 'v-agree').service_id).toBeNull();
    expect(row(db, 'v-agree').service_key_snapshot).toBe('pest_general_quarterly'); // pre-existing snapshot kept
    expect(row(db, 'v-cad-m').service_id).toBe('svc-pm');
    expect(row(db, 'v-suffix').service_id).toBe('svc-l6');
    expect(row(db, 'v-linked').service_id).toBe('svc-pq');
    expect(db.system_settings).toEqual([]);
  });

  test('missing table/column guards are no-ops', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingColumns: ['scheduled_services.service_id'] }));
    expect(db.scheduled_services.every((r) => r.id === 'v-linked' || r.service_id == null)).toBe(true);
    await migration.up(fakeKnex(db, { missingColumns: ['scheduled_services.service_key_snapshot', 'scheduled_services.recurring_pattern'] }));
    // without the cadence column the (label, cadence) map has no evidence; suffix alias still links
    expect(row(db, 'v-cad').service_id).toBeNull();
    expect(row(db, 'v-suffix').service_id).toBe('svc-l6');
    expect(row(db, 'v-suffix')).not.toHaveProperty('service_key_snapshot', 'lawn_care_6week');
  });
});
