/**
 * 20260903000030_vendor_orders — the Sticker Mule seed reuses ONLY a
 * code-25 row that is Sticker Mule; a stranger holding code 25 (the earlier
 * vendor-code guidance allowed 25 as the next appended code) is a collision
 * the migration refuses — adapterKeyFor would read that row as the Sticker
 * Mule adapter (Codex r31 P1).
 */
const migration = require('../models/migrations/20260903000030_vendor_orders');

function fakeKnex({ codeRow = null, nameRow = null } = {}) {
  const updates = []; const inserts = [];
  const knex = (table) => {
    const q = {}; let where = null;
    q.where = (w) => { where = w; return q; };
    q.whereRaw = () => q;
    q.whereNull = () => q;
    q.first = async () => {
      if (table !== 'vendors') return null;
      return where && where.code === 25 ? codeRow : nameRow;
    };
    q.update = async (row) => { updates.push({ table, where, row }); return 1; };
    q.insert = (row) => ({ returning: async () => { inserts.push(row); return [{ id: 'vend-new', ...row }]; } });
    return q;
  };
  knex.raw = (sql) => sql;
  knex.schema = { hasTable: async () => true, hasColumn: async () => true, createTable: async () => {} };
  return { knex, updates, inserts };
}

test('a code-25 row that is not Sticker Mule is a collision: the migration throws and points nothing at it', async () => {
  const f = fakeKnex({ codeRow: { id: 'vend-x', name: 'Do My Own', code: 25, website: 'https://www.domyown.com' } });
  await expect(migration.up(f.knex)).rejects.toThrow(/"Do My Own".*already holds code 25.*Sticker Mule adapter.*vendor-codes\.md/);
  expect(f.updates).toEqual([]);
  expect(f.inserts).toEqual([]);
});

test('the code-25 row is reused when it is Sticker Mule — by name, or by website after an admin rename', async () => {
  const byName = fakeKnex({ codeRow: { id: 'vend-sm', name: 'sticker mule', code: 25, website: null } });
  await migration.up(byName.knex);
  expect(byName.inserts).toEqual([]);
  expect(byName.updates).toEqual([{ table: 'products_catalog', where: null, row: { auto_reorder_vendor_id: 'vend-sm' } }]);
  const renamed = fakeKnex({ codeRow: { id: 'vend-sm', name: 'Sticker Mule (yard signs)', code: 25, website: 'https://www.stickermule.com/account' } });
  await migration.up(renamed.knex);
  expect(renamed.inserts).toEqual([]);
  expect(renamed.updates).toEqual([{ table: 'products_catalog', where: null, row: { auto_reorder_vendor_id: 'vend-sm' } }]);
});

test('no code-25 row: the seed inserts Sticker Mule with code 25', async () => {
  const f = fakeKnex();
  await migration.up(f.knex);
  expect(f.inserts).toEqual([expect.objectContaining({ name: 'Sticker Mule', code: 25 })]);
});
