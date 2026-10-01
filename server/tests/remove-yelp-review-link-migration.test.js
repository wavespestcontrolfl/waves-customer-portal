/**
 * 20260929230000 — deletes the seeded Yelp write-a-review link-library row
 * by url and nothing else; down() restores it exactly as the link_library
 * migration seeded it. Fake-knex, the convention of the sibling migration tests.
 */
const migration = require('../models/migrations/20260929230000_remove_yelp_review_link');
const seed = require('../models/migrations/20260831000001_link_library');

function fakeKnex({ hasTable = true, rows = [] } = {}) {
  const inserts = [];
  const builder = () => {
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      del: jest.fn(async () => {
        const keep = rows.filter((r) => !Object.entries(whereArg).every(([k, v]) => r[k] === v));
        const n = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return n;
      }),
      insert(row) {
        return {
          onConflict: (col) => ({
            ignore: async () => {
              inserts.push(row);
              if (!rows.some((r) => r[col] === row[col])) rows.push({ ...row });
            },
          }),
        };
      },
    };
    return q;
  };
  const knex = jest.fn(builder);
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return { knex, rows, inserts };
}

const seededYelp = seed.SEED_ROWS.find((r) => r.name === 'Yelp — write a review');

test('the migration constant is byte-identical to the row the link_library migration seeded', () => {
  expect(seededYelp).toBeDefined();
  expect(migration.YELP_ROW).toEqual(seededYelp);
});

test('up deletes only the Yelp row (matched on url), even if renamed; other reviews rows stay', async () => {
  const fb = seed.SEED_ROWS.find((r) => r.name === 'Facebook — write a review');
  const { knex, rows } = fakeKnex({ rows: [{ ...seededYelp, name: 'renamed by an operator' }, { ...fb }, { name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol' }] });
  await migration.up(knex);
  expect(rows.map((r) => r.url)).toEqual([fb.url, 'https://youtube.com/@wavespestcontrol']);
});

test('up is a no-op when the table or the row is missing', async () => {
  const missingTable = fakeKnex({ hasTable: false });
  await migration.up(missingTable.knex);
  expect(missingTable.knex).not.toHaveBeenCalled();
  const noRow = fakeKnex({ rows: [{ name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol' }] });
  await migration.up(noRow.knex);
  expect(noRow.rows).toHaveLength(1);
});

test('down re-inserts the seeded row once (idempotent), and skips a missing table', async () => {
  const t = fakeKnex({ rows: [] });
  await migration.down(t.knex);
  await migration.down(t.knex);
  expect(t.rows).toEqual([seededYelp]);
  const missing = fakeKnex({ hasTable: false });
  await migration.down(missing.knex);
  expect(missing.knex).not.toHaveBeenCalled();
});
