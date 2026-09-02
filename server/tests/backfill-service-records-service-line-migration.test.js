/**
 * 20260902000020 — stamp service_records.service_line where NULL with the
 * SAME detection every reader falls back to. Pins: only NULL rows, per-label
 * grouping, blank labels skipped, ledger + idempotent re-run, down() clears
 * only rows still carrying the stamped value.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const migration = require('../models/migrations/20260902000020_backfill_service_records_service_line');
const { detectServiceLine } = require('../services/service-report/service-line-configs');

const { STATE_KEY } = migration;

function seedDb() {
  return {
    service_records: [
      { id: 'r1', service_type: 'Quarterly Pest Control Service', service_line: null },
      { id: 'r2', service_type: 'Quarterly Pest Control Service', service_line: null },
      { id: 'r3', service_type: 'Lawn Care Visit #2', service_line: null },
      { id: 'r4', service_type: 'Termite', service_line: null },
      { id: 'r5', service_type: 'Rodent Trapping Service', service_line: null },
      { id: 'r-set', service_type: 'Lawn Care Visit', service_line: 'lawn' },
      { id: 'r-blank', service_type: '   ', service_line: null },
      { id: 'r-null', service_type: null, service_line: null },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [], missingColumns = [] } = {}) {
  const knex = (table) => {
    const preds = [];
    const rows = () => db[table] || [];
    const q = {
      where(a) { preds.push((r) => Object.entries(a).every(([k, v]) => (r[k] ?? null) === v)); return q; },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { preds.push((r) => r[col] != null); return q; },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return q; },
      async select(...cols) {
        return rows().filter((r) => preds.every((p) => p(r))).map((r) => {
          const o = {}; (cols.length ? cols : Object.keys(r)).forEach((c) => { o[c] = r[c] ?? null; }); return o;
        });
      },
      async first() { return rows().find((r) => preds.every((p) => p(r))); },
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
const row = (db, id) => db.service_records.find((r) => r.id === id);

describe('20260902000020 backfill service_records.service_line', () => {
  test('stamps exactly the runtime fallback verdict on NULL rows and nothing else', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      expect(row(db, id).service_line).toBe(detectServiceLine(row(db, id).service_type));
    }
    expect(row(db, 'r1').service_line).toBe('pest');
    expect(row(db, 'r3').service_line).toBe('lawn');
    expect(row(db, 'r4').service_line).toBe('termite');
    expect(row(db, 'r5').service_line).toBe('rodent');
    expect(row(db, 'r-set').service_line).toBe('lawn'); // untouched
    expect(row(db, 'r-blank').service_line).toBeNull();
    expect(row(db, 'r-null').service_line).toBeNull();
    const st = state(db);
    expect(st.stamped.find((s) => s.service_type === 'Quarterly Pest Control Service')).toEqual({
      service_type: 'Quarterly Pest Control Service', service_line: 'pest', ids: ['r1', 'r2'],
    });
    expect(st.stamped).toHaveLength(4);
  });

  test('idempotent: a re-run stamps nothing new and keeps the ledger', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    const first = state(db).stamped;
    await migration.up(fakeKnex(db));
    expect(state(db).stamped).toEqual(first);
  });

  test('down() clears only rows still carrying the stamped value', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    row(db, 'r2').service_line = 'lawn'; // edited since → not ours
    await migration.down(fakeKnex(db));
    expect(row(db, 'r1').service_line).toBeNull();
    expect(row(db, 'r2').service_line).toBe('lawn');
    expect(row(db, 'r-set').service_line).toBe('lawn');
    expect(db.system_settings).toEqual([]);
  });

  test('guards: missing column is a no-op; down() without a ledger leaves data alone', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingColumns: ['service_records.service_line'] }));
    expect(row(db, 'r1').service_line).toBeNull();
    expect(db.system_settings).toEqual([]);
    row(db, 'r1').service_line = 'pest';
    await migration.down(fakeKnex(db));
    expect(row(db, 'r1').service_line).toBe('pest');
  });
});
