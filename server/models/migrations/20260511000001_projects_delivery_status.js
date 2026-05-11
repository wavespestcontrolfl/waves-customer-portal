/**
 * Track customer delivery separately from the public report token/status.
 *
 * `status = sent` should mean at least one customer notification channel
 * succeeded. `delivery_status` records the most recent attempt, including
 * failures where a report link was generated but no customer channel worked.
 */

exports.up = async function (knex) {
  const hasDeliveryStatus = await knex.schema.hasColumn('projects', 'delivery_status');
  if (!hasDeliveryStatus) {
    await knex.schema.alterTable('projects', (t) => {
      t.string('delivery_status', 30).notNullable().defaultTo('not_sent');
      t.index('delivery_status');
    });
  }

  await knex.raw(`
    WITH delivery AS (
      SELECT
        id,
        COALESCE(delivery_channels ? 'sms', false) AS has_sms,
        COALESCE(delivery_channels ? 'email', false) AS has_email,
        COALESCE(delivery_channels->'sms'->>'ok', 'false') = 'true' AS sms_ok,
        COALESCE(delivery_channels->'email'->>'ok', 'false') = 'true' AS email_ok
      FROM projects
    )
    UPDATE projects p
    SET delivery_status = CASE
      WHEN (d.sms_ok OR d.email_ok)
        AND ((d.has_sms AND NOT d.sms_ok) OR (d.has_email AND NOT d.email_ok))
        THEN 'partial'
      WHEN d.sms_ok OR d.email_ok THEN 'sent'
      WHEN d.has_sms OR d.has_email OR p.last_delivery_at IS NOT NULL THEN 'failed'
      WHEN p.status IN ('sent', 'closed') THEN 'sent'
      ELSE 'not_sent'
    END
    FROM delivery d
    WHERE p.id = d.id
      AND (p.delivery_status IS NULL OR p.delivery_status = 'not_sent')
  `);
};

exports.down = async function (knex) {
  const hasDeliveryStatus = await knex.schema.hasColumn('projects', 'delivery_status');
  if (hasDeliveryStatus) {
    await knex.schema.alterTable('projects', (t) => {
      t.dropColumn('delivery_status');
    });
  }
};
