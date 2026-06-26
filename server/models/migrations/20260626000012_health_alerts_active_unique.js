/**
 * Partial unique index guaranteeing at most one ACTIVE (new/acknowledged)
 * customer_health_alerts row per (customer_id, alert_type).
 *
 * health-alerts.generateAlerts dedupes with a SELECT-then-INSERT, which races:
 * two concurrent rescores for the same customer (e.g. two inbound SMS webhooks
 * under the event-driven path) can both pass the existence check and insert
 * duplicate critical_risk alert rows into the admin health inbox. This index +
 * the 23505 swallow in generateAlerts makes the create atomically idempotent.
 * A resolved/dismissed alert is outside the predicate, so a fresh episode can
 * still raise a new alert.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_health_alerts'))) return;

  // Demote any pre-existing duplicate active alerts (keep the most recent per
  // customer+type) so the unique index can be created.
  await knex.raw(`
    UPDATE customer_health_alerts a
    SET status = 'dismissed'
    FROM customer_health_alerts b
    WHERE a.status IN ('new', 'acknowledged')
      AND b.status IN ('new', 'acknowledged')
      AND a.customer_id = b.customer_id
      AND a.alert_type = b.alert_type
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.ctid < b.ctid))
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_health_alerts_active_uniq
    ON customer_health_alerts (customer_id, alert_type)
    WHERE status IN ('new', 'acknowledged')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_health_alerts_active_uniq');
};
