/**
 * 20261010220000: the catalog's Roundup QuikPro SC row carries all three active ingredients (Codex round 40 on #6135).
 * The compliance ledger copies this column onto every application record.
 */
const migration = require('../models/migrations/20261010220000_roundup_quikpro_sc_active_ingredients');

function fakeKnex(rows, { table = true, column = true } = {}) {
  const knex = () => {
    let pick = () => true;
    const q = {
      whereRaw: (_sql, [name]) => { pick = (row) => String(row.name).trim().toLowerCase() === name; return q; },
      where: ({ id }) => { pick = (row) => row.id === id; return q; },
      select: async () => rows.filter(pick).map((row) => ({ ...row })),
      update: async (patch) => { rows.filter(pick).forEach((row) => Object.assign(row, patch)); },
    };
    return q;
  };
  knex.schema = { hasTable: async () => table, hasColumn: async () => column };
  return knex;
}

describe('Roundup QuikPro SC active ingredients', () => {
  test('a row that still says Glyphosate (or nothing) is corrected; an edited row and other products are left', async () => {
    const rows = [
      { id: 1, name: 'Roundup QuikPro SC', active_ingredient: 'Glyphosate' },
      { id: 2, name: ' roundup quikpro sc ', active_ingredient: null },
      { id: 3, name: 'Roundup QuikPro SC', active_ingredient: 'Glyphosate 48.7% + Diquat 0.73% + Indaziflam 0.36%' },
      { id: 4, name: 'Roundup Pro Concentrate', active_ingredient: 'Glyphosate' },
    ];
    await migration.up(fakeKnex(rows));
    expect(rows.map((row) => row.active_ingredient)).toEqual([
      migration.CORRECT, migration.CORRECT, 'Glyphosate 48.7% + Diquat 0.73% + Indaziflam 0.36%', 'Glyphosate',
    ]);
    // idempotent, and the rollback never restores the wrong list
    await migration.up(fakeKnex(rows));
    await migration.down();
    expect(rows[0].active_ingredient).toBe('Glyphosate + Diquat + Indaziflam');
  });

  test('the value is the one in pricing.csv; a missing table or column skips', async () => {
    const csv = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'pricing.csv'), 'utf8');
    expect(csv).toContain(`Roundup QuikPro SC,${migration.CORRECT},`);
    const rows = [{ id: 1, name: 'Roundup QuikPro SC', active_ingredient: 'Glyphosate' }];
    await migration.up(fakeKnex(rows, { table: false }));
    await migration.up(fakeKnex(rows, { column: false }));
    expect(rows[0].active_ingredient).toBe('Glyphosate');
  });
});
