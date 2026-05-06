exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const columns = [
    ['appointment_confirmation', (t) => t.boolean('appointment_confirmation').defaultTo(true)],
    ['service_reminder_72h', (t) => t.boolean('service_reminder_72h').defaultTo(true)],
  ];

  for (const [column, builder] of columns) {
    const exists = await knex.schema.hasColumn('notification_prefs', column);
    if (!exists) {
      await knex.schema.alterTable('notification_prefs', builder);
    }
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  for (const column of ['service_reminder_72h', 'appointment_confirmation']) {
    const exists = await knex.schema.hasColumn('notification_prefs', column);
    if (exists) {
      await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn(column));
    }
  }
};
