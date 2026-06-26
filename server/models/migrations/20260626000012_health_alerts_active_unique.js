/**
 * Partial unique index guaranteeing at most one ACTIVE (new/acknowledged)
 * customer_health_alerts row per (customer_id, alert_type) — scoped to ONLY the
 * rule-based alert types produced by health-alerts.generateAlerts.
 *
 * health-alerts.generateAlerts dedupes with a SELECT-then-INSERT, which races:
 * two concurrent rescores for the same customer (e.g. two inbound SMS webhooks
 * under the event-driven path) can both pass the existence check and insert
 * duplicate alert rows into the admin health inbox. This index + the 23505
 * swallow in generateAlerts makes that create atomically idempotent.
 *
 * It is deliberately scoped to RULE_TYPES: other paths (stripe.js,
 * billing-cron, stripe-webhook) insert one-off operational alerts that may
 * legitimately have several active rows of the same alert_type per customer
 * (one per incident, keyed by trigger_data), and must NOT be deduped here.
 */
const RULE_TYPES = ['score_drop', 'critical_risk', 'service_gap', 'payment_issue', 'low_engagement', 'satisfaction_drop', 'new_customer_risk'];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_health_alerts'))) return;

  // Demote any pre-existing duplicate active RULE alerts (keep the most recent
  // per customer+type) so the unique index can be created. Scoped to RULE_TYPES
  // so operational/incident alerts are left untouched.
  await knex.raw(`
    UPDATE customer_health_alerts a
    SET status = 'dismissed'
    FROM customer_health_alerts b
    WHERE a.status IN ('new', 'acknowledged')
      AND b.status IN ('new', 'acknowledged')
      AND a.customer_id = b.customer_id
      AND a.alert_type = b.alert_type
      AND a.alert_type = ANY(?)
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.ctid < b.ctid))
  `, [RULE_TYPES]);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_health_alerts_active_rule_uniq
    ON customer_health_alerts (customer_id, alert_type)
    WHERE status IN ('new', 'acknowledged')
      AND alert_type IN ('score_drop', 'critical_risk', 'service_gap', 'payment_issue', 'low_engagement', 'satisfaction_drop', 'new_customer_risk')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_health_alerts_active_rule_uniq');
};
