const migration = require('../models/migrations/20261125100000_notifications_admin_dedupe_key_idx');

const knexWith = ({ table = true, column = true } = {}) => {
  const raw = jest.fn().mockResolvedValue();
  return {
    raw,
    schema: { hasTable: jest.fn().mockResolvedValue(table), hasColumn: jest.fn().mockResolvedValue(column) },
  };
};

describe('notifications admin dedupe key index migration', () => {
  test('up creates a plain, idempotent partial expression index on the admin dedupe key', async () => {
    const knex = knexWith();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const sql = knex.raw.mock.calls[0][0];
    expect(sql).toBe("CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'");
    expect(sql).not.toMatch(/CONCURRENTLY/); // migrations run inside a transaction
  });
  test('up is a no-op when the table or the column is missing', async () => {
    for (const opts of [{ table: false }, { column: false }]) {
      const knex = knexWith(opts);
      await migration.up(knex);
      expect(knex.raw).not.toHaveBeenCalled();
    }
  });
  test('down drops the index if it exists', async () => {
    const knex = knexWith();
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledWith('DROP INDEX IF EXISTS notifications_admin_dedupe_key_idx');
  });
});

const hashMigration = require('../models/migrations/20261125110000_notifications_admin_dedupe_key_hash_idx');

describe('notifications admin dedupe key hash index migration', () => {
  test('up swaps the B-tree for a hash index (no entry-size limit on long keys)', async () => {
    const knex = knexWith();
    await hashMigration.up(knex);
    const sqls = knex.raw.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual([
      'DROP INDEX IF EXISTS notifications_admin_dedupe_key_idx',
      "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_hash_idx ON notifications USING hash ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
    ]);
    expect(sqls.join(' ')).not.toMatch(/CONCURRENTLY/);
  });
  test('up is a no-op when the table or the column is missing', async () => {
    for (const opts of [{ table: false }, { column: false }]) {
      const knex = knexWith(opts);
      await hashMigration.up(knex);
      expect(knex.raw).not.toHaveBeenCalled();
    }
  });
  test('down drops the hash index and restores the B-tree', async () => {
    const knex = knexWith();
    await hashMigration.down(knex);
    expect(knex.raw.mock.calls.map((c) => c[0])).toEqual([
      'DROP INDEX IF EXISTS notifications_admin_dedupe_key_hash_idx',
      "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
    ]);
  });
});

const rollbackSafe = require('../models/migrations/20261125120000_notifications_admin_dedupe_key_rollback_safe');

describe('notifications admin dedupe key rollback-safe migration', () => {
  test('up does nothing', async () => {
    const knex = knexWith();
    await rollbackSafe.up(knex);
    expect(knex.raw).not.toHaveBeenCalled();
  });
  test('down leaves a size-unlimited hash index under the B-tree name, so the next down skips the rebuild', async () => {
    const knex = knexWith();
    await rollbackSafe.down(knex);
    expect(knex.raw.mock.calls.map((c) => c[0])).toEqual([
      "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications USING hash ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
    ]);
  });
});
