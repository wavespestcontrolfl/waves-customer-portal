/**
 * The admin bell list pages by keyset on (created_at DESC, id DESC) over the
 * open admin rows (recipient_type = 'admin', done_at IS NULL): the first page
 * and every "Load more" cursor predicate `(created_at, id) < (?, ?)` read this
 * order. A partial index in exactly that order lets Postgres walk it and stop
 * at the page limit instead of sorting every open admin row.
 *
 * Plain index (not CONCURRENTLY): migrations run inside a transaction
 * pre-deploy, same reasoning as call_log_metadata_lead_id_index. Created
 * IF NOT EXISTS so a re-run is a no-op. The done_at guard keeps the build
 * a no-op on a database that has not run 20261001001500 yet.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS notifications_admin_open_keyset_idx ON notifications (recipient_type, created_at DESC, id DESC) WHERE done_at IS NULL',
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_open_keyset_idx');
};
