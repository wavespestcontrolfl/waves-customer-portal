/**
 * customers.last_seen_at — the last time the customer used the logged-in
 * portal or the mobile app.
 *
 * Stamped (throttled, fire-and-forget) from the customer auth middleware
 * behind GATE_PORTAL_ACTIVITY (server/services/customer-activity.js). Nullable
 * with no default: a customer who has never been seen since the gate went on
 * reads NULL, never a made-up date. No backfill and no index — the column is
 * a display/sort signal on a small table, and a NULL-only add is a metadata
 * change that does not rewrite the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('customers', 'last_seen_at')) return;
  await knex.schema.alterTable('customers', (t) => {
    t.timestamp('last_seen_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('customers', 'last_seen_at'))) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('last_seen_at');
  });
};
