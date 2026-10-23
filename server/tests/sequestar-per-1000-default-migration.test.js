/**
 * 20261023010000 clears the wrong 1.5 oz per 1,000 sq ft prefill on the Sequestar catalog row. It touches one row only
 * while that row still reads exactly as seeded, and its rollback puts the rate back only while the row is as it wrote it.
 */
const migration = require('../models/migrations/20261023010000_sequestar_clear_wrong_per_1000_default');

const COLUMNS = { id: {}, name: {}, active: {}, default_rate_per_1000: {}, rate_unit: {}, label_source_note: {}, updated_at: {} };

function fakeKnex(rows, { columns = COLUMNS, hasTable = true } = {}) {
  const knex = (table) => {
    expect(table).toBe('products_catalog');
    const preds = [];
    const q = {
      columnInfo: async () => columns,
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      select() { return Promise.resolve(rows.filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r }))); },
      async update(patch) { for (const r of rows.filter((x) => preds.every((p) => p(x)))) Object.assign(r, patch); },
    };
    return q;
  };
  knex.schema = { hasTable: async () => hasTable };
  knex.fn = { now: () => 'now' };
  return knex;
}

const seeded = (extra = {}) => ({ id: 's1', name: migration.NAME, active: true, default_rate_per_1000: '1.5', rate_unit: 'oz', label_source_note: null, ...extra });

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

describe('up', () => {
  test('clears the 1.5 oz prefill and records why, keeping an earlier note', async () => {
    const rows = [seeded({ label_source_note: 'Earlier note.' }), { id: 'other', name: 'Snapshot 2.5TG', active: true, default_rate_per_1000: 2.3, rate_unit: 'lb', label_source_note: null }];
    await migration.up(fakeKnex(rows));
    expect(rows[0].default_rate_per_1000).toBeNull();
    expect(rows[0].label_source_note).toBe(`Earlier note. | ${migration.NOTE}`);
    expect(rows[1].default_rate_per_1000).toBe(2.3);
  });

  test('a note-less row gets just the new note', async () => {
    const rows = [seeded()];
    await migration.up(fakeKnex(rows));
    expect(rows[0].label_source_note).toBe(migration.NOTE);
  });

  test.each([
    ['a staff-edited rate', { default_rate_per_1000: 6 }],
    ['a staff-edited unit', { rate_unit: 'lb' }],
    ['an inactive row', { active: false }],
  ])('writes nothing for %s', async (_label, patch) => {
    const rows = [seeded(patch)];
    await migration.up(fakeKnex(rows));
    expect(rows[0]).toEqual(seeded(patch));
  });

  test('writes nothing when the name matches no row or two rows, or the table or a column is missing', async () => {
    const none = [seeded({ name: 'Something else' })];
    await migration.up(fakeKnex(none));
    expect(none[0].default_rate_per_1000).toBe('1.5');
    const two = [seeded(), seeded({ id: 's2' })];
    await migration.up(fakeKnex(two));
    expect(two.map((r) => r.default_rate_per_1000)).toEqual(['1.5', '1.5']);
    const noColumn = [seeded()];
    await migration.up(fakeKnex(noColumn, { columns: { id: {}, name: {} } }));
    expect(noColumn[0].default_rate_per_1000).toBe('1.5');
    await expect(migration.up(fakeKnex([], { hasTable: false }))).resolves.toBeUndefined();
  });

  test('running twice changes nothing the second time', async () => {
    const rows = [seeded()];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    const after = { ...rows[0] };
    await migration.up(knex);
    expect(rows[0]).toEqual(after);
  });
});

describe('down', () => {
  test('puts the rate back and strips only its own note', async () => {
    const withNote = [seeded({ label_source_note: 'Earlier note.' })];
    const knex = fakeKnex(withNote);
    await migration.up(knex);
    await migration.down(knex);
    expect(withNote[0]).toMatchObject({ default_rate_per_1000: 1.5, label_source_note: 'Earlier note.' });
    const bare = [seeded()];
    const bareKnex = fakeKnex(bare);
    await migration.up(bareKnex);
    await migration.down(bareKnex);
    expect(bare[0]).toMatchObject({ default_rate_per_1000: 1.5, label_source_note: null });
  });

  test('does nothing when staff set a rate or edited the note after up()', async () => {
    const rate = [seeded()];
    const rateKnex = fakeKnex(rate);
    await migration.up(rateKnex);
    rate[0].default_rate_per_1000 = 4;
    await migration.down(rateKnex);
    expect(rate[0].default_rate_per_1000).toBe(4);
    const note = [seeded()];
    const noteKnex = fakeKnex(note);
    await migration.up(noteKnex);
    note[0].label_source_note += ' Staff addition.';
    await migration.down(noteKnex);
    expect(note[0].default_rate_per_1000).toBeNull();
    expect(note[0].label_source_note).toContain('Staff addition.');
  });

  test('does nothing on a row that up() never changed', async () => {
    const rows = [seeded({ default_rate_per_1000: null })];
    await migration.down(fakeKnex(rows));
    expect(rows[0].default_rate_per_1000).toBeNull();
    expect(rows[0].label_source_note).toBeNull();
  });
});
