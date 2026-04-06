exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('appointment_reminders');
  if (!hasTable) {
    await knex.schema.createTable('appointment_reminders', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id').references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.timestamp('appointment_time').notNullable();
      t.string('service_type', 100);
      t.boolean('confirmation_sent').defaultTo(false);
      t.timestamp('confirmation_sent_at');
      t.boolean('reminder_72h_sent').defaultTo(false);
      t.timestamp('reminder_72h_sent_at');
      t.boolean('reminder_24h_sent').defaultTo(false);
      t.timestamp('reminder_24h_sent_at');
      t.string('source', 30).notNullable();
      t.boolean('cancelled').defaultTo(false);
      t.timestamps(true, true);
    });

    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.unique('scheduled_service_id');
    });
  }

  // Add line_type column to customers if not present
  const custCols = await knex.raw(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'"
  );
  const colNames = custCols.rows.map((r) => r.column_name);
  if (!colNames.includes('line_type')) {
    await knex.schema.alterTable('customers', (t) => {
      t.string('line_type', 20);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('appointment_reminders');
  try {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('line_type');
    });
  } catch { /* ignore */ }
};
