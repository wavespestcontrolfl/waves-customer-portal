// Additive, nullable, idempotent, guarded on the table: the columns are provenance only.
const migration = require('../models/migrations/20260930010000_email_messages_lead_estimate_links');

function fakeKnex({ hasTable = true, columns = [] } = {}) {
  const cols = new Set(columns);
  const log = { sql: [], added: [], dropped: [] };
  const knex = {
    log,
    schema: {
      hasTable: async () => hasTable,
      hasColumn: async (_t, c) => cols.has(c),
      alterTable: async (_t, cb) => {
        cb({
          uuid: (c) => { log.added.push(c); cols.add(c); return { nullable: () => {} }; },
          dropColumn: (c) => { log.dropped.push(c); cols.delete(c); },
        });
      },
    },
    raw: async (q) => { log.sql.push(q); },
  };
  return knex;
}

test('up adds nullable lead_id / estimate_id and partial, non-concurrent indexes', async () => {
  const k = fakeKnex();
  await migration.up(k);
  expect(k.log.added).toEqual(['lead_id', 'estimate_id']);
  expect(k.log.sql).toHaveLength(2);
  expect(k.log.sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS email_messages_lead_id_idx ON email_messages \(lead_id\) WHERE lead_id IS NOT NULL/);
  expect(k.log.sql[1]).toMatch(/email_messages_estimate_id_idx ON email_messages \(estimate_id\) WHERE estimate_id IS NOT NULL/);
  expect(k.log.sql.join(' ')).not.toMatch(/CONCURRENTLY|FOREIGN|REFERENCES/i);
  expect(migration.config?.transaction).not.toBe(false);
});

test('up is idempotent when the columns exist and a no-op without the table', async () => {
  const again = fakeKnex({ columns: ['lead_id', 'estimate_id'] });
  await migration.up(again);
  expect(again.log.added).toEqual([]);
  const none = fakeKnex({ hasTable: false });
  await migration.up(none);
  expect(none.log.added).toEqual([]);
  expect(none.log.sql).toEqual([]);
});

test('down drops the indexes and both columns only when present', async () => {
  const k = fakeKnex({ columns: ['lead_id', 'estimate_id'] });
  await migration.down(k);
  expect(k.log.sql.join(' ')).toMatch(/DROP INDEX IF EXISTS email_messages_lead_id_idx/);
  expect(k.log.dropped).toEqual(['lead_id', 'estimate_id']);
  const none = fakeKnex({ hasTable: false });
  await migration.down(none);
  expect(none.log.dropped).toEqual([]);
});
