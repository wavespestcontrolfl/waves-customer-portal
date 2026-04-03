/**
 * Migration 048 — Customer Self-Scheduling
 *
 * After accepting an estimate, customers can pick their own appointment
 * from zone-based availability slots.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('service_zones', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('zone_name').notNullable();
    t.specificType('cities', 'text[]');
    t.float('center_lat');
    t.float('center_lng');
    t.integer('drive_buffer_minutes').defaultTo(15);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('tech_schedule_blocks', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').references('id').inTable('technicians').onDelete('CASCADE');
    t.date('date').notNullable();
    t.time('start_time').notNullable();
    t.time('end_time').notNullable();
    t.uuid('service_zone_id').references('id').inTable('service_zones');
    t.string('block_type').defaultTo('available'); // available, blocked, lunch
    t.string('notes');
    t.timestamps(true, true);
    t.index(['technician_id', 'date']);
    t.index(['service_zone_id', 'date']);
  });

  await knex.schema.createTable('self_booked_appointments', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('estimate_id');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.uuid('service_zone_id').references('id').inTable('service_zones');
    t.date('date').notNullable();
    t.time('start_time').notNullable();
    t.time('end_time').notNullable();
    t.integer('duration_minutes').defaultTo(60);
    t.string('status').defaultTo('confirmed'); // confirmed, rescheduled, cancelled, completed
    t.text('customer_notes');
    t.string('confirmation_code').unique();
    t.boolean('reminder_sent').defaultTo(false);
    t.boolean('synced_to_schedule').defaultTo(false);
    t.timestamps(true, true);
    t.index(['date', 'service_zone_id']);
    t.index('customer_id');
    t.index('estimate_id');
  });

  await knex.schema.createTable('booking_config', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('advance_days_min').defaultTo(1);
    t.integer('advance_days_max').defaultTo(14);
    t.time('day_start').defaultTo('08:00');
    t.time('day_end').defaultTo('17:00');
    t.time('lunch_start').defaultTo('12:00');
    t.time('lunch_end').defaultTo('13:00');
    t.integer('slot_duration_minutes').defaultTo(60);
    t.integer('buffer_minutes').defaultTo(15);
    t.integer('max_self_books_per_day').defaultTo(3);
    t.boolean('enabled').defaultTo(true);
    t.timestamps(true, true);
  });

  // Add source column to scheduled_services
  await knex.schema.alterTable('scheduled_services', t => {
    t.string('source').defaultTo('admin'); // admin, self_booked
    t.uuid('self_booking_id');
  });

  // Seed zones
  await knex('service_zones').insert([
    { zone_name: 'Bradenton / Parrish', cities: '{Bradenton,Parrish,Palmetto,Ellenton}', center_lat: 27.4989, center_lng: -82.5748, drive_buffer_minutes: 15 },
    { zone_name: 'Sarasota / Lakewood Ranch', cities: '{Sarasota,"Lakewood Ranch","University Park",Fruitville}', center_lat: 27.3364, center_lng: -82.5307, drive_buffer_minutes: 15 },
    { zone_name: 'Venice / North Port', cities: '{Venice,"North Port",Nokomis,Osprey}', center_lat: 27.0998, center_lng: -82.4543, drive_buffer_minutes: 20 },
    { zone_name: 'Port Charlotte', cities: '{"Port Charlotte","Punta Gorda",Murdock}', center_lat: 26.9756, center_lng: -82.0912, drive_buffer_minutes: 20 },
  ]);

  // Seed default booking config
  await knex('booking_config').insert({
    advance_days_min: 1, advance_days_max: 14,
    day_start: '08:00', day_end: '17:00',
    lunch_start: '12:00', lunch_end: '13:00',
    slot_duration_minutes: 60, buffer_minutes: 15,
    max_self_books_per_day: 3, enabled: true,
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', t => {
    t.dropColumn('source');
    t.dropColumn('self_booking_id');
  });
  await knex.schema.dropTableIfExists('self_booked_appointments');
  await knex.schema.dropTableIfExists('tech_schedule_blocks');
  await knex.schema.dropTableIfExists('booking_config');
  await knex.schema.dropTableIfExists('service_zones');
};
