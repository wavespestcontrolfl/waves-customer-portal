exports.up = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasPrefs && !(await knex.schema.hasColumn('notification_prefs', 'appointment_notify_primary'))) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.boolean('appointment_notify_primary').defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasPrefs && await knex.schema.hasColumn('notification_prefs', 'appointment_notify_primary')) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.dropColumn('appointment_notify_primary');
    });
  }
};
