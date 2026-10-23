/**
 * 20261023140000 clears the wrong 1.5 oz per 1,000 sq ft prefill on the Sequestar catalog row. It acts only on one active row
 * that still reads as seeded, records the before/after in audit_log in the same transaction, is idempotent, and has no rollback. The row is read FOR UPDATE and the update is conditional on what was read (exactly one row).
 */
const migration = require('../models/migrations/20261023140000_sequestar_per_1000_default_correction_v2');

const COLUMNS = { id: {}, name: {}, active: {}, default_rate_per_1000: {}, rate_unit: {}, label_source_note: {}, updated_at: {} };

function fakeKnex(rows, { columns = COLUMNS, tables = ['products_catalog', 'audit_log'], failAudit = false } = {}) {
  const audit = [];
  const knex = (table) => {
    if (table === 'audit_log') return { insert: (row) => { if (failAudit) return { returning: () => Promise.reject(new Error('audit down')) }; audit.push(row); return { returning: async () => [{ id: audit.length }] }; } };
    const preds = [];
    const q = {
      columnInfo: async () => columns,
      forUpdate() { knex.locked.push(table); return q; },
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereRaw(_sql, [value]) { preds.push((r) => Number(r.default_rate_per_1000) === value); return q; },
      select() { return Promise.resolve(rows.filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r }))); },
      async update(patch) {
        if (knex.beforeUpdate) knex.beforeUpdate();
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

const seeded = (extra = {}) => ({ id: 's1', name: migration.NAME, active: true, default_rate_per_1000: '1.5', rate_unit: 'oz', label_source_note: null, ...extra });

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

describe('up', () => {
  test('clears the prefill, appends the note and records one critical before/after audit row', async () => {
    const rows = [seeded({ label_source_note: 'Earlier note.' }), { id: 'other', name: 'Snapshot 2.5TG', active: true, default_rate_per_1000: 2.3, rate_unit: 'lb', label_source_note: null }];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    expect(rows[0].default_rate_per_1000).toBeNull();
    expect(rows[0].label_source_note).toBe(`Earlier note. | ${migration.NOTE}`);
    expect(rows[1].default_rate_per_1000).toBe(2.3);
    expect(knex.audit).toHaveLength(1);
    expect(knex.audit[0]).toMatchObject({ actor_type: 'system', action: migration.ACTION, resource_type: 'products_catalog', resource_id: 's1' });
    expect(knex.audit[0].metadata.before).toMatchObject({ default_rate_per_1000: 1.5, rate_unit: 'oz', label_source_note: 'Earlier note.' });
    expect(knex.audit[0].metadata.after).toMatchObject({ default_rate_per_1000: null, label_source_note: `Earlier note. | ${migration.NOTE}` });
  });

  test('a note-less row gets just the new note', async () => {
    const rows = [seeded()];
    await migration.up(fakeKnex(rows));
    expect(rows[0].label_source_note).toBe(migration.NOTE);
  });

  test('a failed audit write fails the migration (same transaction, nothing half-done)', async () => {
    await expect(migration.up(fakeKnex([seeded()], { failAudit: true }))).rejects.toThrow('audit down');
  });

  test('the row is read FOR UPDATE before it is checked', async () => {
    const knex = fakeKnex([seeded()]);
    await migration.up(knex);
    expect(knex.locked).toEqual(['products_catalog']);
  });

  test('an edit that lands between the read and the update changes nothing and audits nothing', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    knex.beforeUpdate = () => { rows[0].label_source_note = 'Staff wrote this first.'; };
    await migration.up(knex);
    expect(rows[0]).toMatchObject({ default_rate_per_1000: '1.5', label_source_note: 'Staff wrote this first.' });
    expect(knex.audit).toEqual([]);
  });

  test.each([
    ['a staff-edited rate', { default_rate_per_1000: 6 }],
    ['a staff-edited unit', { rate_unit: 'lb' }],
    ['an inactive row', { active: false }],
  ])('writes nothing for %s', async (_label, patch) => {
    const rows = [seeded(patch)];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    expect(rows[0]).toEqual(seeded(patch));
    expect(knex.audit).toEqual([]);
  });

  test('writes nothing when the name matches no row or two rows, or a table or column is missing', async () => {
    for (const [rows, options] of [
      [[seeded({ name: 'Something else' })], {}],
      [[seeded(), seeded({ id: 's2' })], {}],
      [[seeded()], { columns: { id: {}, name: {} } }],
      [[seeded()], { tables: ['products_catalog'] }],
    ]) {
      const knex = fakeKnex(rows, options);
      await migration.up(knex);
      expect(rows.map((r) => r.default_rate_per_1000)).toEqual(rows.map(() => '1.5'));
      expect(knex.audit).toEqual([]);
    }
    await expect(migration.up(fakeKnex([], { tables: [] }))).resolves.toBeUndefined();
  });

  test('already corrected (rate NULL, note present): idempotent, no second audit row, no second note', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    const after = { ...rows[0] };
    await migration.up(knex);
    expect(rows[0]).toEqual(after);
    expect(knex.audit).toHaveLength(1);
  });
});

describe('down', () => {
  test('is a documented no-op: the known-wrong 1.5 is never restored', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    const after = JSON.stringify(rows);
    await migration.down(knex);
    expect(JSON.stringify(rows)).toBe(after);
    expect(rows[0].default_rate_per_1000).toBeNull();
  });
});
