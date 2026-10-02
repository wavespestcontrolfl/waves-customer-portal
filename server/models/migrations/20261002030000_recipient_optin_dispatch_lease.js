/**
 * recipient_optin.dispatch_lease_at — the in-flight marker for an on-site
 * (visit-bound) opt-in ask (#5467). Dispatch takes it before the visit check
 * and the provider call so a newer booking cannot rebind the row and only one
 * claim sends. It is kept apart from dispatched_at, which stays the proof the
 * provider accepted the ask (a YES only confirms a dispatched row). A lease
 * older than 10 minutes is stale (the process died); the recovery sweep
 * reconciles against sms_log and retries. Additive and nullable; no backfill.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('recipient_optin', 'dispatch_lease_at'))) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.timestamp('dispatch_lease_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('recipient_optin', 'dispatch_lease_at')) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.dropColumn('dispatch_lease_at');
    });
  }
};
