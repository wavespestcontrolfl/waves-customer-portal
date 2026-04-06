exports.up = async function (knex) {
  // Add billing preferences to notification_prefs
  const hasNotifPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasNotifPrefs) {
    const hasBillingEmail = await knex.schema.hasColumn('notification_prefs', 'billing_email');
    if (!hasBillingEmail) {
      await knex.schema.alterTable('notification_prefs', (table) => {
        table.string('billing_email', 200).nullable();
      });
    }
    const hasPaymentSms = await knex.schema.hasColumn('notification_prefs', 'payment_confirmation_sms');
    if (!hasPaymentSms) {
      await knex.schema.alterTable('notification_prefs', (table) => {
        table.boolean('payment_confirmation_sms').defaultTo(true);
      });
    }
  }

  // Add account_credits to customers
  const hasCustomers = await knex.schema.hasTable('customers');
  if (hasCustomers) {
    const hasCredits = await knex.schema.hasColumn('customers', 'account_credits');
    if (!hasCredits) {
      await knex.schema.alterTable('customers', (table) => {
        table.decimal('account_credits', 10, 2).defaultTo(0);
      });
    }
  }
};

exports.down = async function (knex) {
  const hasNotifPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasNotifPrefs) {
    const hasBillingEmail = await knex.schema.hasColumn('notification_prefs', 'billing_email');
    if (hasBillingEmail) {
      await knex.schema.alterTable('notification_prefs', (table) => {
        table.dropColumn('billing_email');
      });
    }
    const hasPaymentSms = await knex.schema.hasColumn('notification_prefs', 'payment_confirmation_sms');
    if (hasPaymentSms) {
      await knex.schema.alterTable('notification_prefs', (table) => {
        table.dropColumn('payment_confirmation_sms');
      });
    }
  }

  const hasCustomers = await knex.schema.hasTable('customers');
  if (hasCustomers) {
    const hasCredits = await knex.schema.hasColumn('customers', 'account_credits');
    if (hasCredits) {
      await knex.schema.alterTable('customers', (table) => {
        table.dropColumn('account_credits');
      });
    }
  }
};
