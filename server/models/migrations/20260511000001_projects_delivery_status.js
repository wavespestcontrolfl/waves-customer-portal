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
    UPDATE projects
    SET delivery_status = CASE
      WHEN status IN ('sent', 'closed') THEN 'sent'
      WHEN last_delivery_at IS NOT NULL THEN 'failed'
      ELSE 'not_sent'
    END
    WHERE delivery_status IS NULL OR delivery_status = 'not_sent'
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
