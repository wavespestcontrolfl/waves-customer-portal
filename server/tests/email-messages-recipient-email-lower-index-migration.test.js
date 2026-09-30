// The activity timeline matches unclaimed mail by LOWER(TRIM(recipient_email_snapshot)).
// This expression index keeps that arm of the OR indexable (the plain snapshot
// index cannot serve it): idempotent, guarded on the table, plain transactional CREATE INDEX.
const migration = require('../models/migrations/20260929150000_email_messages_recipient_email_lower_index');

function fakeKnex({ hasTable = true } = {}) {
  const sql = [];
  return { sql, schema: { hasTable: async () => hasTable }, raw: async (q) => { sql.push(q); } };
}

test('up creates the LOWER(TRIM(recipient_email_snapshot)) expression index idempotently and not concurrently', async () => {
  const k = fakeKnex();
  await migration.up(k);
  expect(k.sql).toHaveLength(1);
  expect(k.sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS email_messages_recipient_email_lower_idx/);
  expect(k.sql[0]).toMatch(/ON email_messages \(LOWER\(TRIM\(recipient_email_snapshot\)\)\)/);
  expect(k.sql[0]).not.toMatch(/CONCURRENTLY/);
  expect(migration.config?.transaction).not.toBe(false);
});

test('up is a no-op when the table is absent; down drops the index if present', async () => {
  const none = fakeKnex({ hasTable: false });
  await migration.up(none);
  expect(none.sql).toEqual([]);
  const k = fakeKnex();
  await migration.down(k);
  expect(k.sql[0]).toMatch(/DROP INDEX IF EXISTS email_messages_recipient_email_lower_idx/);
});
