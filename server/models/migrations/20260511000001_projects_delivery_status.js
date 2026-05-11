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
        COALESCE(delivery_channels ? 'sms', false) AS has_sms_key,
        COALESCE(delivery_channels ? 'email', false) AS has_email_key,
        COALESCE(delivery_channels->'sms'->>'ok', 'false') = 'true' AS sms_channel_ok,
        COALESCE(delivery_channels->'email'->>'ok', 'false') = 'true' AS email_channel_ok,
        LOWER(COALESCE(delivery_channels->'sms'->>'error', '')) = 'no phone on file' AS sms_missing_contact,
        LOWER(COALESCE(delivery_channels->'email'->>'error', '')) = 'no email on file' AS email_missing_contact
      FROM projects
    ),
    status_eval AS (
      SELECT
        id,
        has_sms_key AND NOT sms_missing_contact AS sms_available,
        has_email_key AND NOT email_missing_contact AS email_available,
        sms_channel_ok AS sms_ok,
        email_channel_ok AS email_ok
      FROM delivery
    )
    UPDATE projects p
    SET delivery_status = CASE
      WHEN (s.sms_ok OR s.email_ok)
        AND ((s.sms_available AND NOT s.sms_ok) OR (s.email_available AND NOT s.email_ok))
        THEN 'partial'
      WHEN s.sms_ok OR s.email_ok THEN 'sent'
      WHEN s.sms_available OR s.email_available OR p.last_delivery_at IS NOT NULL THEN 'failed'
      ELSE 'not_sent'
    END
    FROM status_eval s
    WHERE p.id = s.id
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
