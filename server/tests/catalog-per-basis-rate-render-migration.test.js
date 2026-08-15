/**
 * Regression tests for 20260816000010_catalog_per_basis_rate_render:
 * rollback must never delete a PREEXISTING catalog value that merely equals
 * the backfill value (codex finding on PR #3419). Ownership is recorded in
 * the "[wrote: ...]" provenance segment; down() reverts only those fields.
 *
 * Runs against a tiny in-memory fake of the knex surface the migration
 * uses (hasTable / whereRaw().first() / where().update()) — no DATABASE_URL
 * needed, and CI's real migrate:latest still exercises the SQL itself.
 */

const path = require('path');
const migration = require(path.join(
  __dirname, '..', 'models', 'migrations', '20260816000010_catalog_per_basis_rate_render.js',
));
const { DATA, appendedNote, ownedFields } = migration._test;

function fakeKnex(rows) {
  const byLowerName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const knex = (table) => {
    if (table !== 'products_catalog') throw new Error(`unexpected table ${table}`);
    return {
      whereRaw(_sql, [name]) {
        const row = byLowerName.get(String(name).toLowerCase());
        return { first: async () => (row ? { ...row } : undefined) };
      },
      where(cond) {
        return {
          update: async (updates) => {
            const row = rows.find((r) => r.id === cond.id);
            if (!row) return 0;
            Object.assign(row, updates);
            byLowerName.set(row.name.toLowerCase(), row);
            return 1;
          },
        };
      },
    };
  };
  knex.schema = { hasTable: async () => true, hasColumn: async () => true };
  return knex;
}

const GEL = DATA.find((d) => d.name === 'Advion Ant Bait Gel');
const PER1K = DATA.find((d) => d.name === 'Gravex 20 EW');

function baseRow(overrides) {
  return {
    id: 'row-1',
    default_rate: null,
    default_unit: null,
    default_rate_per_1000: null,
    min_label_rate_per_1000: null,
    max_label_rate_per_1000: null,
    rate_unit: null,
    application_method: null,
    label_source_note: null,
    label_verified_at: null,
    label_verified_by: null,
    ...overrides,
  };
}

describe('ownedFields marker parsing', () => {
  test('round-trips the fields up() wrote', () => {
    const note = appendedNote(GEL.note, ['default_rate', 'default_unit']);
    expect(ownedFields(note, GEL.note)).toEqual(['default_rate', 'default_unit']);
    expect(ownedFields(`earlier batch note | ${note}`, GEL.note)).toEqual([
      'default_rate', 'default_unit',
    ]);
  });

  test('returns null when the row carries no segment for this entry', () => {
    expect(ownedFields(null, GEL.note)).toBeNull();
    expect(ownedFields('some other batch note', GEL.note)).toBeNull();
    // A different entry's segment must not be claimed.
    expect(ownedFields(appendedNote('other note', ['default_rate']), GEL.note)).toBeNull();
  });
});

describe('up() fill-only + provenance', () => {
  test('fills an empty row and records exactly what it wrote', async () => {
    const rows = [baseRow({ name: GEL.name })];
    await migration.up(fakeKnex(rows));
    expect(rows[0].default_rate).toBe(GEL.rate);
    expect(rows[0].default_unit).toBe(GEL.unit);
    expect(ownedFields(rows[0].label_source_note, GEL.note)).toEqual([
      'default_rate', 'default_unit',
    ]);
    expect(rows[0].label_verified_by).toBe('rate-render-backfill-2026-08-14');
  });

  test('row with a preexisting rate is left entirely alone (atomic pair)', async () => {
    const rows = [baseRow({ name: GEL.name, default_rate: '0.3' })];
    await migration.up(fakeKnex(rows));
    expect(rows[0].default_rate).toBe('0.3'); // admin value wins
    // Pairing an admin rate with our unit would mislabel it — no write.
    expect(rows[0].default_unit).toBeNull();
    expect(rows[0].label_source_note).toBeNull();
    expect(rows[0].label_verified_by).toBeNull();
  });

  test('unit-only placeholder ("oz" with no rate) is replaced by the label pair', async () => {
    const rows = [baseRow({ name: GEL.name, default_unit: 'oz' })];
    await migration.up(fakeKnex(rows));
    expect(rows[0].default_rate).toBe(GEL.rate);
    expect(rows[0].default_unit).toBe(GEL.unit);
    expect(ownedFields(rows[0].label_source_note, GEL.note)).toEqual([
      'default_rate', 'default_unit',
    ]);
  });

  test('injection entries fill application_method only where empty', async () => {
    const INJ = DATA.find((d) => d.name === 'Arborjet Propizol Injectable Fungicide');
    const empty = baseRow({ id: 'row-inj', name: INJ.name });
    const preset = baseRow({ id: 'row-set', name: 'Arborjet Ima-Jet 10', application_method: 'soil_drench' });
    const rows = [empty, preset];
    await migration.up(fakeKnex(rows));
    expect(empty.application_method).toBe('trunk_injection');
    expect(preset.application_method).toBe('soil_drench'); // admin value wins
  });

  test('fully populated row is untouched — no note, no stamp', async () => {
    const rows = [baseRow({
      name: GEL.name,
      default_rate: GEL.rate, // preexisting value that EQUALS the backfill value
      default_unit: GEL.unit,
      label_source_note: 'prior batch note',
    })];
    await migration.up(fakeKnex(rows));
    expect(rows[0].label_source_note).toBe('prior batch note');
    expect(rows[0].label_verified_by).toBeNull();
  });
});

describe('down() reverts only migration-owned fields', () => {
  test('full up() then down() is symmetric on an empty row', async () => {
    const rows = [baseRow({ name: GEL.name })];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    await migration.down(knex);
    expect(rows[0].default_rate).toBeNull();
    expect(rows[0].default_unit).toBeNull();
    expect(rows[0].label_source_note).toBeNull();
    expect(rows[0].label_verified_by).toBeNull();
  });

  test('preexisting values equal to the backfill values SURVIVE rollback', async () => {
    const rows = [baseRow({
      name: GEL.name,
      default_rate: GEL.rate,
      default_unit: GEL.unit,
      label_source_note: 'prior batch note',
    })];
    const knex = fakeKnex(rows);
    await migration.up(knex); // writes nothing (fill-only), no marker
    await migration.down(knex);
    expect(rows[0].default_rate).toBe(GEL.rate);
    expect(rows[0].default_unit).toBe(GEL.unit);
    expect(rows[0].label_source_note).toBe('prior batch note');
  });

  test('partial write reverts only the written field, keeps the admin value', async () => {
    const rows = [baseRow({ name: GEL.name, default_rate: '0.3' })];
    const knex = fakeKnex(rows);
    await migration.up(knex); // writes default_unit only
    await migration.down(knex);
    expect(rows[0].default_rate).toBe('0.3');
    expect(rows[0].default_unit).toBeNull();
    expect(rows[0].label_source_note).toBeNull();
  });

  test('admin edit AFTER up() survives rollback; the note segment still lifts', async () => {
    const rows = [baseRow({ name: GEL.name })];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    rows[0].default_rate = '0.75'; // admin changed the prefill afterwards
    await migration.down(knex);
    expect(rows[0].default_rate).toBe('0.75');
    expect(rows[0].default_unit).toBeNull(); // unchanged field still reverts
    expect(rows[0].label_source_note).toBeNull();
  });

  test('per-1000 entry: up()/down() symmetric, earlier batch note preserved', async () => {
    const rows = [baseRow({ name: PER1K.name, label_source_note: 'earlier note' })];
    const knex = fakeKnex(rows);
    await migration.up(knex);
    expect(rows[0].default_rate_per_1000).toBe(1.2);
    expect(rows[0].rate_unit).toBe('fl_oz');
    await migration.down(knex);
    expect(rows[0].default_rate_per_1000).toBeNull();
    expect(rows[0].min_label_rate_per_1000).toBeNull();
    expect(rows[0].max_label_rate_per_1000).toBeNull();
    expect(rows[0].rate_unit).toBeNull();
    expect(rows[0].label_source_note).toBe('earlier note');
  });
});
