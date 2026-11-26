/**
 * Makes rollback of the dedupe key index migrations safe for long keys.
 * 20261125110000 (frozen once pushed) swapped a B-tree index for a hash index, and its
 * `down` re-creates the B-tree with CREATE INDEX IF NOT EXISTS. A B-tree entry is
 * limited to about 2.7 kB, so once a longer key is stored that rebuild would fail and
 * block the rollback. This file's `down` runs first in a rollback and leaves a hash
 * index (no size limit) under the B-tree's name, so 110000's IF NOT EXISTS skips the
 * rebuild; 20261125100000's `down` then drops it. The end state is unindexed, which is
 * safe: the index only speeds up lookups. `up` does nothing.
 */
exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'metadata'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications USING hash ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
  );
};
