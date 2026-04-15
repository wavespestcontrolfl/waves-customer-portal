/**
 * Geofence auto-timers — Bouncie GPS → time tracking integration.
 *
 * 1. customers: add latitude / longitude (referenced by bouncie-mileage but never migrated)
 * 2. technicians: add bouncie_imei (maps a Bouncie device to a tech)
 * 3. geofence_events: audit log of every ENTER/EXIT event processed
 * 4. tech_notifications: in-app reminder queue for the tech PWA
 * 5. system_settings: generic key/value store used for geofence config
 */
exports.up = async function (knex) {
  // 1. customers.latitude / longitude
  const custHasLat = await knex.schema.hasColumn('customers', 'latitude');
  const custHasLng = await knex.schema.hasColumn('customers', 'longitude');
  if (!custHasLat || !custHasLng) {
    await knex.schema.alterTable('customers', (t) => {
      if (!custHasLat) t.decimal('latitude', 10, 7);
      if (!custHasLng) t.decimal('longitude', 10, 7);
    });
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_customers_lat_lng ON customers(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
    );
  }

  // 2. technicians.bouncie_imei
  if (!(await knex.schema.hasColumn('technicians', 'bouncie_imei'))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.string('bouncie_imei', 50);
      t.string('bouncie_vin', 50);
      t.string('vehicle_name', 100);
    });
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_bouncie_imei ON technicians(bouncie_imei) WHERE bouncie_imei IS NOT NULL`
    );
  }

  // 3. geofence_events
  if (!(await knex.schema.hasTable('geofence_events'))) {
    await knex.schema.createTable('geofence_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('bouncie_imei', 50).notNullable();
      t.uuid('technician_id');
      t.string('event_type', 10).notNullable(); // ENTER / EXIT
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
      t.uuid('matched_customer_id');
      t.uuid('matched_job_id');
      t.string('action_taken', 50); // timer_started, timer_stopped, reminder_sent, no_customer_match, ignored_duplicate, unknown_vehicle, no_active_timer, timer_already_running, geocoding_failed, dismissed
      t.uuid('time_entry_id');
      t.jsonb('raw_payload');
      t.timestamp('event_timestamp').notNullable();
      t.timestamp('processed_at').defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.index(['technician_id', 'event_timestamp']);
      t.index('bouncie_imei');
      t.index('matched_customer_id');
      t.index('action_taken');
    });
  }

  // 4. tech_notifications
  if (!(await knex.schema.hasTable('tech_notifications'))) {
    await knex.schema.createTable('tech_notifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable();
      t.string('type', 50).notNullable(); // geofence_arrival_reminder, geofence_timer_started, geofence_timer_stopped, etc.
      t.text('message');
      t.jsonb('payload');
      t.boolean('read').notNullable().defaultTo(false);
      t.timestamp('dismissed_at');
      t.timestamps(true, true);
      t.index(['technician_id', 'read', 'created_at']);
    });
  }

  // 5. system_settings (generic key/value — used for geofence config + future use)
  if (!(await knex.schema.hasTable('system_settings'))) {
    await knex.schema.createTable('system_settings', (t) => {
      t.string('key', 100).primary();
      t.text('value');
      t.string('category', 50);
      t.text('description');
      t.timestamps(true, true);
    });
    // Seed geofence defaults
    await knex('system_settings').insert([
      { key: 'geofence.mode', value: 'reminder', category: 'geofence', description: 'automatic | reminder' },
      { key: 'geofence.radius_meters', value: '200', category: 'geofence', description: 'Match radius in meters' },
      { key: 'geofence.cooldown_minutes', value: '15', category: 'geofence', description: 'Duplicate-event cooldown window' },
      { key: 'geofence.auto_complete_on_exit', value: 'false', category: 'geofence', description: 'Advance service tracking to Complete on EXIT' },
    ]);
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('system_settings');
  await knex.schema.dropTableIfExists('tech_notifications');
  await knex.schema.dropTableIfExists('geofence_events');
  if (await knex.schema.hasColumn('technicians', 'bouncie_imei')) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('bouncie_imei');
      t.dropColumn('bouncie_vin');
      t.dropColumn('vehicle_name');
    });
  }
  // Keep customers.latitude/longitude — other code depends on it
};
