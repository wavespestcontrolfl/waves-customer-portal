// The migration for home_notes (20261127134200): one note per customer, body 1..2100, down drops the table.
const migration = require('../models/migrations/20261127134200_home_notes');

function fakeKnex({ exists = false } = {}) {
  const calls = [];
  const col = () => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : (...a) => { calls.push(['col', p, ...a]); return col(); }) });
  const knex = {
    raw: (sql) => { calls.push(['raw', sql]); return sql; },
    fn: { now: () => 'NOW' },
    schema: {
      hasTable: async () => exists,
      createTable: async (name, cb) => { calls.push(['createTable', name]); cb(col()); },
      dropTableIfExists: async (name) => { calls.push(['drop', name]); },
    },
  };
  return { knex, calls };
}

test('up creates the table, the body and role checks, and the one-note-per-customer key', async () => {
  const { knex, calls } = fakeKnex();
  await migration.up(knex);
  expect(calls).toContainEqual(['createTable', 'home_notes']);
  const cols = calls.filter((c) => c[0] === 'col').map((c) => c[2]);
  expect(cols).toEqual(expect.arrayContaining(['id', 'customer_id', 'body', 'revision', 'updated_by_type', 'updated_by_id', 'created_at', 'updated_at']));
  const sql = calls.filter((c) => c[0] === 'raw').map((c) => c[1]).join('\n');
  expect(sql).toMatch(/CHECK \(length\(body\) BETWEEN 1 AND 2100\)/);
  expect(sql).toMatch(/updated_by_type IN \('technician', 'admin'\)/);
  expect(sql).toMatch(/CHECK \(revision >= 1\)/);
  expect(calls).toContainEqual(['col', 'defaultTo', 1]);
  expect(cols).not.toContain('property_id');
  // customer_id: not null, unique, cascading foreign key to customers.
  const customerCol = calls.filter((c) => c[0] === 'col').map((c) => c[1]);
  expect(customerCol).toEqual(expect.arrayContaining(['unique', 'references', 'inTable', 'onDelete']));
  expect(calls).toContainEqual(['col', 'onDelete', 'CASCADE']);
});

test('up is a no-op when the table already exists', async () => {
  const { knex, calls } = fakeKnex({ exists: true });
  await migration.up(knex);
  expect(calls).toEqual([]);
});

test('down drops only this table', async () => {
  const { knex, calls } = fakeKnex();
  await migration.down(knex);
  expect(calls).toEqual([['drop', 'home_notes']]);
});
