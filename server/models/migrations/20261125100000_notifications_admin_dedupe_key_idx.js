/**
 * Admin notifications are found by their dedupe key: notifyAdmin's dedupe probe
 * (WHERE recipient_type = 'admin' AND metadata->>'dedupeKey' = ?) on every keyed
 * write, and the plan price bell closer (series-price-guards.js), which runs once
 * per inserted series occurrence while the series lock is held. Nothing indexed
 * that expression (the table's indexes are the primary key, the recipient/read
 * index, created_at and the admin keyset indexes), so each lookup scanned every
 * admin row. A partial expression index on exactly that predicate lets Postgres
 * go straight to the key.
 *
 * Plain index (not CONCURRENTLY): migrations run inside a transaction
 * pre-deploy, same reasoning as notifications_admin_open_keyset_idx, and the
 * table is small (about 10 thousand admin rows). IF NOT EXISTS makes a re-run a
 * no-op.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'metadata'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS notifications_admin_dedupe_key_idx ON notifications ((metadata->>'dedupeKey')) WHERE recipient_type = 'admin'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_dedupe_key_idx');
};
