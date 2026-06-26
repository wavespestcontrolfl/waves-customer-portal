/**
 * Atomic claim column for the event-driven live churn alert.
 *
 * event-rescore.js sends the owner an SMS the moment a customer crosses into
 * critical. Two near-simultaneous inbound texts could otherwise both observe
 * the pre-critical state and both alert. `critical_alert_sent_at` makes the
 * crossing a single atomic claim:
 *   UPDATE ... SET critical_alert_sent_at = now()
 *   WHERE churn_risk = 'critical' AND critical_alert_sent_at IS NULL
 * — exactly one concurrent caller gets a non-zero rowcount and sends. The
 * canonical scorer (customer-health.js) clears it whenever the customer is not
 * critical, so a later re-entry into critical can claim and alert again.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_health_scores'))) return;
  if (!(await knex.schema.hasColumn('customer_health_scores', 'critical_alert_sent_at'))) {
    await knex.schema.alterTable('customer_health_scores', t => {
      t.timestamp('critical_alert_sent_at');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('customer_health_scores', 'critical_alert_sent_at')) {
    await knex.schema.alterTable('customer_health_scores', t => {
      t.dropColumn('critical_alert_sent_at');
    });
  }
};
