/**
 * ach_failure_log.stripe_event_id — dedupe ACH failure logging on the Stripe
 * EVENT identity instead of the PaymentIntent alone. The same invoice/PI is
 * legitimately re-attempted after a failure (same-PI reattempts are an
 * expected flow), and each real bank failure emits a distinct event that
 * must count toward the needs_verification/suspended escalation thresholds;
 * only true webhook re-deliveries of the SAME event may be skipped.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ach_failure_log'))) return;
  if (await knex.schema.hasColumn('ach_failure_log', 'stripe_event_id')) return;
  await knex.schema.alterTable('ach_failure_log', (t) => {
    t.string('stripe_event_id', 255);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ach_failure_log'))) return;
  if (!(await knex.schema.hasColumn('ach_failure_log', 'stripe_event_id'))) return;
  await knex.schema.alterTable('ach_failure_log', (t) => {
    t.dropColumn('stripe_event_id');
  });
};
