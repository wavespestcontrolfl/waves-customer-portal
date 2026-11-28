/**
 * Drop redundant partial index notifications_admin_open_idx.
 *
 * notifications_admin_open_keyset_idx (20261001006000) covers
 * (recipient_type, created_at DESC, id DESC) WHERE done_at IS NULL,
 * which is a strict superset of notifications_admin_open_idx
 * ((recipient_type, created_at DESC) WHERE done_at IS NULL).
 * Dropping the prefix duplicate removes redundant index write overhead
 * on every notifications insert and done_at update.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  const superset = await knex.raw(
    `SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'notifications'
        AND indexname = 'notifications_admin_open_keyset_idx'`,
  );
  if (!superset?.rows?.length) return;
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_open_idx');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notifications_admin_open_idx
      ON notifications (recipient_type, created_at DESC)
      WHERE done_at IS NULL
  `);
};
