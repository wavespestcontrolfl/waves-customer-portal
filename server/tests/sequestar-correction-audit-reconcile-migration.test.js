/**
 * 20261023160000 reconciles the audit trail of the Sequestar per-1,000 correction. Run in filename order on a fresh database,
 * 010000 corrects the row with no audit row and 120000/140000 then exit as already corrected; 160000 adds the one missing
 * critical audit row. It never changes the catalog row, is idempotent, skips an already-audited or edited row, and has no rollback.
 */
const m010000 = require('../models/migrations/20261023010000_sequestar_clear_wrong_per_1000_default');
const m120000 = require('../models/migrations/20261023120000_sequestar_per_1000_default_correction');
const m140000 = require('../models/migrations/20261023140000_sequestar_per_1000_default_correction_v2');
const m160000 = require('../models/migrations/20261023160000_sequestar_correction_audit_reconcile');

const COLUMNS = { id: {}, name: {}, active: {}, default_rate_per_1000: {}, rate_unit: {}, label_source_note: {}, updated_at: {} };

// Fake knex covering every query the four migrations make (catalog select/update with FOR UPDATE, audit insert and lookup).
function fakeKnex(rows, { audit = [], columns = COLUMNS, tables = ['products_catalog', 'audit_log'] } = {}) {
  const knex = (table) => {
    if (table === 'audit_log') {
      const preds = [];
      const q = {
        insert: (row) => { audit.push({ ...row }); return { returning: async () => [{ id: audit.length }] }; },
        where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
        whereIn(col, values) { preds.push((r) => values.includes(r[col])); return q; },
        async first() { return audit.find((r) => preds.every((p) => p(r))); },
      };
      return q;
    }
    const preds = [];
    const q = {
      columnInfo: async () => columns,
      forUpdate() { knex.locked.push(table); return q; },
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereRaw(_sql, [value]) { preds.push((r) => Number(r.default_rate_per_1000) === value); return q; },
      select() { return Promise.resolve(rows.filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r }))); },
      async update(patch) {
        const hit = rows.filter((x) => preds.every((p) => p(x)));
        for (const r of hit) Object.assign(r, patch);
        return hit.length;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => tables.includes(t) };
  knex.fn = { now: () => 'now' };
  knex.audit = audit;
  knex.locked = [];
  return knex;
}

const seeded = (extra = {}) => ({ id: 's1', name: m160000.NAME, active: true, default_rate_per_1000: '1.5', rate_unit: 'oz', label_source_note: null, ...extra });
const corrected = (extra = {}) => seeded({ default_rate_per_1000: null, label_source_note: m160000.NOTE, ...extra });
const ACTIONS = m160000.AUDIT_ACTIONS;

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

describe('fresh database, migrations in filename order', () => {
  test('010000, 120000, 140000, 160000 leave a corrected row and exactly one audit row; a second pass adds none', async () => {
    const rows = [seeded({ label_source_note: 'Earlier note.' })];
    const knex = fakeKnex(rows);
    await m010000.up(knex);
    expect(knex.audit).toHaveLength(0);
    await m120000.up(knex);
    await m140000.up(knex);
    // The gap: corrected, and still no audit row, because 120000 and 140000 both exited as already corrected.
    expect(rows[0].default_rate_per_1000).toBeNull();
    expect(knex.audit).toHaveLength(0);
    await m160000.up(knex);
    expect(knex.audit).toHaveLength(1);
    expect(knex.audit[0]).toMatchObject({ actor_type: 'system', action: m160000.ACTION, resource_type: 'products_catalog', resource_id: 's1' });
    expect(knex.audit[0].metadata.before).toEqual({ default_rate_per_1000: 1.5, rate_unit: 'oz', label_source_note: 'Earlier note.' });
    expect(knex.audit[0].metadata.after).toEqual({ default_rate_per_1000: null, rate_unit: 'oz', label_source_note: `Earlier note. | ${m160000.NOTE}` });
    // Re-running every migration adds nothing.
    const snapshot = JSON.stringify(rows);
    for (const migration of [m010000, m120000, m140000, m160000]) await migration.up(knex);
    expect(knex.audit).toHaveLength(1);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  test('a note-less row reports a null note before', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    for (const migration of [m010000, m120000, m140000, m160000]) await migration.up(knex);
    expect(knex.audit).toHaveLength(1);
    expect(knex.audit[0].metadata.before.label_source_note).toBeNull();
  });
});

describe('up', () => {
  test('a database where 120000 or 140000 already audited the change adds no second audit row', async () => {
    for (const action of ACTIONS.slice(0, 2)) {
      const rows = [corrected()];
      const knex = fakeKnex(rows, { audit: [{ action, resource_type: 'products_catalog', resource_id: 's1' }] });
      await m160000.up(knex);
      expect(knex.audit).toHaveLength(1);
    }
  });

  test('a database that ran 120000 as the first corrector (audited by it) gets nothing from 160000', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    await m120000.up(knex);
    expect(knex.audit).toHaveLength(1);
    await m160000.up(knex);
    expect(knex.audit).toHaveLength(1);
  });

  test('an audit row for a different resource does not count', async () => {
    const knex = fakeKnex([corrected()], { audit: [{ action: ACTIONS[0], resource_type: 'products_catalog', resource_id: 'other' }] });
    await m160000.up(knex);
    expect(knex.audit).toHaveLength(2);
  });

  test.each([
    ['a staff-edited rate', seeded({ default_rate_per_1000: 6 })],
    ['the seeded 1.5 oz (never corrected)', seeded()],
    ['a cleared rate without our note', seeded({ default_rate_per_1000: null, label_source_note: 'Staff note.' })],
    ['a corrected row whose rate was edited back to a number', corrected({ default_rate_per_1000: 3 })],
  ])('writes nothing for %s', async (_label, row) => {
    const rows = [row];
    const before = JSON.stringify(rows);
    const knex = fakeKnex(rows);
    await m160000.up(knex);
    expect(knex.audit).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
  });

  test('writes nothing when the name matches no row or two rows, or a table or column is missing', async () => {
    for (const [rows, options] of [
      [[corrected({ name: 'Something else' })], {}],
      [[corrected(), corrected({ id: 's2' })], {}],
      [[corrected()], { columns: { id: {}, name: {} } }],
      [[corrected()], { tables: ['products_catalog'] }],
      [[corrected()], { tables: ['audit_log'] }],
    ]) {
      const knex = fakeKnex(rows, options);
      await m160000.up(knex);
      expect(knex.audit).toEqual([]);
    }
    await expect(m160000.up(fakeKnex([], { tables: [] }))).resolves.toBeUndefined();
  });

  test('reads the row FOR UPDATE and never changes the catalog row', async () => {
    const rows = [corrected()];
    const before = JSON.stringify(rows);
    const knex = fakeKnex(rows);
    await m160000.up(knex);
    expect(knex.locked).toEqual(['products_catalog']);
    expect(JSON.stringify(rows)).toBe(before);
  });

  test('a failed audit write fails the migration (same transaction)', async () => {
    const knex = fakeKnex([corrected()]);
    const inner = knex.schema;
    const failing = (table) => (table === 'audit_log'
      ? { where: () => ({ whereIn: () => ({ first: async () => undefined }) }), insert: () => ({ returning: () => Promise.reject(new Error('audit down')) }) }
      : knex(table));
    failing.schema = inner; failing.fn = knex.fn;
    await expect(m160000.up(failing)).rejects.toThrow('audit down');
  });
});

describe('down', () => {
  test('is a documented no-op', async () => {
    const rows = [corrected()];
    const knex = fakeKnex(rows);
    await m160000.up(knex);
    const after = JSON.stringify({ rows, audit: knex.audit });
    await m160000.down(knex);
    expect(JSON.stringify({ rows, audit: knex.audit })).toBe(after);
  });
});
