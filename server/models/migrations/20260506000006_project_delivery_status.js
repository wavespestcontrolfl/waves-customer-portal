/**
 * Persist the last customer-delivery attempt for Projects reports so admin can
 * see SMS/email outcomes after a reload and can audit resend attempts.
 */

exports.up = async function (knex) {
  const hasDeliveryChannels = await knex.schema.hasColumn('projects', 'delivery_channels');
  const hasLastDeliveryAt = await knex.schema.hasColumn('projects', 'last_delivery_at');

  if (!hasDeliveryChannels || !hasLastDeliveryAt) {
    await knex.schema.alterTable('projects', (t) => {
      if (!hasDeliveryChannels) t.jsonb('delivery_channels');
      if (!hasLastDeliveryAt) t.timestamp('last_delivery_at');
    });
  }
};

exports.down = async function (knex) {
  const hasDeliveryChannels = await knex.schema.hasColumn('projects', 'delivery_channels');
  const hasLastDeliveryAt = await knex.schema.hasColumn('projects', 'last_delivery_at');

  if (hasDeliveryChannels || hasLastDeliveryAt) {
    await knex.schema.alterTable('projects', (t) => {
      if (hasDeliveryChannels) t.dropColumn('delivery_channels');
      if (hasLastDeliveryAt) t.dropColumn('last_delivery_at');
    });
  }
};
