exports.up = async function (knex) {
  const hasCustomers = await knex.schema.hasTable('customers');
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasCustomers && hasPrefs) {
    await knex.raw(`
      INSERT INTO notification_prefs (customer_id, service_reminder_24h, tech_en_route, service_completed, billing_reminder, seasonal_tips, sms_enabled, email_enabled, created_at, updated_at)
      SELECT c.id, true, true, true, false, true, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM customers c
      LEFT JOIN notification_prefs np ON np.customer_id = c.id
      WHERE np.customer_id IS NULL
    `);
  }
};

exports.down = async function (knex) {
  // Data backfill only. Do not delete notification_prefs rows on rollback.
};
