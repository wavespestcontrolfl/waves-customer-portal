exports.up = async function (knex) {
  const hasCustomers = await knex.schema.hasTable('customers');
  if (!hasCustomers) return;

  const hasPropertyPrefs = await knex.schema.hasTable('property_preferences');
  if (hasPropertyPrefs) {
    await knex.raw(`
      INSERT INTO property_preferences (customer_id, created_at, updated_at)
      SELECT c.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM customers c
      LEFT JOIN property_preferences pp ON pp.customer_id = c.id
      WHERE pp.customer_id IS NULL
    `);
  }

  const hasNotificationPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasNotificationPrefs) {
    await knex.raw(`
      INSERT INTO notification_prefs (customer_id, service_reminder_24h, tech_en_route, service_completed, billing_reminder, seasonal_tips, sms_enabled, email_enabled, created_at, updated_at)
      SELECT c.id, true, true, true, false, true, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM customers c
      LEFT JOIN notification_prefs np ON np.customer_id = c.id
      WHERE np.customer_id IS NULL
    `);
  }
};

exports.down = async function () {
  // Data backfill only. Do not delete preference rows on rollback.
};
