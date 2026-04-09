/**
 * Migration: iCal Appointments Archive
 *
 * Stores raw appointment data imported from Square Appointments .ics calendar exports.
 * Also adds ical_uid to scheduled_services for deduplication.
 */
exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('ical_appointments'))) {
    await knex.schema.createTable('ical_appointments', t => {
      t.increments('id').primary();
      t.string('ical_uid', 200).unique();
      t.string('customer_name', 200);
      t.string('phone', 30);
      t.string('email', 200);
      t.text('address');
      t.string('service_type', 200);
      t.integer('duration_minutes');
      t.decimal('price', 10, 2);
      t.timestamp('scheduled_date');
      t.timestamp('scheduled_end');
      t.string('status', 20);
      t.string('ical_status', 20);
      t.string('source_calendar', 50);
      t.uuid('matched_customer_id');
      t.uuid('scheduled_service_id');
      t.timestamp('imported_at').defaultTo(knex.fn.now());
      t.index('scheduled_date');
      t.index('matched_customer_id');
      t.index('phone');
      t.index('email');
    });
  }

  // Add ical_uid to scheduled_services for dedup
  if (await knex.schema.hasTable('scheduled_services')) {
    const has = await knex.schema.hasColumn('scheduled_services', 'ical_uid');
    if (!has) {
      await knex.schema.alterTable('scheduled_services', t => {
        t.string('ical_uid', 200);
        t.index('ical_uid');
      });
    }
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('ical_appointments');
  if (await knex.schema.hasTable('scheduled_services')) {
    const has = await knex.schema.hasColumn('scheduled_services', 'ical_uid');
    if (has) {
      await knex.schema.alterTable('scheduled_services', t => {
        t.dropColumn('ical_uid');
      });
    }
  }
};
