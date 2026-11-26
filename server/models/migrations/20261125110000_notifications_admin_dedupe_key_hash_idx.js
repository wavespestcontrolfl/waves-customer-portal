/**
 * Supersedes 20261125100000 (frozen once pushed). That B-tree index stored the
 * full dedupe key, and a B-tree entry is limited to about 2.7 kB. Some keys are
 * built from a list of ids (first-application-sibling-split.js joins every
 * diverging sibling id), so a large enough group could make an alert insert fail.
 * A hash index stores only the key's hash, has no entry-size limit, and serves the
 * equality probes (notifyAdmin's dedupe probe, the plan price bell closer).
 * Longest admin key on 2026-11-25: 842 bytes, so the B-tree build itself is safe.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'metadata'))) return;
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_dedupe_key_idx');
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_hash_idx ON notifications USING hash ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_dedupe_key_hash_idx');
  if (!(await knex.schema.hasTable('notifications'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
  );
};
