// The migration for customer_email_change_requests (20261126190000): one open row per customer, down drops the table.
const migration = require('../models/migrations/20261126190000_customer_email_change_requests');

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

test('up creates the table, the attempts check and the one-open-request-per-customer index', async () => {
  const { knex, calls } = fakeKnex();
  await migration.up(knex);
  expect(calls).toContainEqual(['createTable', 'customer_email_change_requests']);
  const cols = calls.filter((c) => c[0] === 'col').map((c) => c[2]);
  expect(cols).toEqual(expect.arrayContaining(['id', 'customer_id', 'new_email', 'code_hash', 'attempts', 'expires_at', 'consumed_at', 'sent_at', 'created_at', 'updated_at']));
  const sql = calls.filter((c) => c[0] === 'raw').map((c) => c[1]).join('\n');
  expect(sql).toMatch(/CHECK \(attempts >= 0\)/);
  expect(sql).toMatch(/CREATE UNIQUE INDEX customer_email_change_requests_open_uidx ON customer_email_change_requests \(customer_id\) WHERE consumed_at IS NULL/);
});

test('up is a no-op when the table already exists', async () => {
  const { knex, calls } = fakeKnex({ exists: true });
  await migration.up(knex);
  expect(calls).toEqual([]);
});

test('down drops only this table', async () => {
  const { knex, calls } = fakeKnex();
  await migration.down(knex);
  expect(calls).toEqual([['drop', 'customer_email_change_requests']]);
});
