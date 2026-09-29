// The activity timeline reads email_messages by owner (recipient_type + recipient_id).
// This migration adds the composite index for that lookup: idempotent, guarded on
// the table, plain (transactional) CREATE INDEX like the other email_messages indexes.
const migration = require('../models/migrations/20260929140000_email_messages_recipient_owner_index');

function fakeKnex({ hasTable = true } = {}) {
  const sql = [];
  return {
    sql,
    schema: { hasTable: async () => hasTable },
    raw: async (q) => { sql.push(q); },
  };
}

test('up creates the (recipient_type, recipient_id) index idempotently and not concurrently', async () => {
  const k = fakeKnex();
  await migration.up(k);
  expect(k.sql).toHaveLength(1);
  expect(k.sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS email_messages_recipient_owner_idx/);
  expect(k.sql[0]).toMatch(/ON email_messages \(recipient_type, recipient_id\)/);
  expect(k.sql[0]).not.toMatch(/CONCURRENTLY/);
  expect(migration.config?.transaction).not.toBe(false);
});

test('up is a no-op when the table is absent; down drops the index if present', async () => {
  const none = fakeKnex({ hasTable: false });
  await migration.up(none);
  expect(none.sql).toEqual([]);
  const k = fakeKnex();
  await migration.down(k);
  expect(k.sql[0]).toMatch(/DROP INDEX IF EXISTS email_messages_recipient_owner_idx/);
});
