/**
 * Waves Pest Control — Customer Portal Database Schema
 * 
 * Tables:
 *   customers          — customer profiles, WaveGuard tier, property details
 *   service_records    — completed service history with tech notes
 *   service_products   — products applied per service visit
 *   service_photos     — before/after photos per service
 *   scheduled_services — upcoming appointments
 *   payments           — payment history (synced from Square)
 *   payment_methods    — stored cards (Square customer/card IDs)
 *   notification_prefs — per-customer SMS notification preferences
 *   verification_codes — OTP codes for phone-based login
 *   technicians        — tech roster
 */

exports.up = async function (knex) {
  // ---- Technicians ----
  await knex.schema.createTable('technicians', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 100).notNullable();
    t.string('phone', 20);
    t.string('email', 150);
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---- Customers ----
  await knex.schema.createTable('customers', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('first_name', 50).notNullable();
    t.string('last_name', 50).notNullable();
    t.string('email', 150).unique();
    t.string('phone', 20).notNullable().unique();
    t.string('password_hash', 255); // optional — can use phone OTP only
    t.string('address_line1', 200).notNullable();
    t.string('address_line2', 100);
    t.string('city', 50).notNullable();
    t.string('state', 2).defaultTo('FL');
    t.string('zip', 10).notNullable();

    // Property details
    t.string('lawn_type', 50); // 'St. Augustine Full Sun', 'St. Augustine Shade', 'Bermuda/Zoysia', 'Bahia'
    t.integer('property_sqft'); // treated lawn area
    t.integer('lot_sqft'); // total lot
    t.integer('bed_sqft'); // ornamental bed area
    t.integer('linear_ft_perimeter'); // for termite trenching
    t.integer('palm_count').defaultTo(0);
    t.string('canopy_type', 30); // 'heavy_oak', 'moderate', 'open'

    // WaveGuard tier
    t.enu('waveguard_tier', ['Bronze', 'Silver', 'Gold', 'Platinum']).defaultTo('Bronze');
    t.decimal('monthly_rate', 10, 2);
    t.date('member_since');

    // Square integration
    t.string('square_customer_id', 100);

    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---- Service Records ----
  await knex.schema.createTable('service_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.date('service_date').notNullable();
    t.string('service_type', 100).notNullable();
    // e.g. 'Lawn Care Visit #3', 'Quarterly Pest Control', 'WaveGuard Mosquito Treatment'
    t.enu('status', ['scheduled', 'in_progress', 'completed', 'cancelled']).defaultTo('completed');
    t.text('technician_notes');
    t.decimal('soil_temp', 5, 1); // °F reading if taken
    t.decimal('thatch_measurement', 4, 2); // inches
    t.decimal('soil_ph', 3, 1);
    t.string('soil_moisture', 20); // 'adequate', 'dry', 'saturated'
    t.jsonb('field_flags'); // e.g. { "FIELD_VERIFY": true, "chinch_check": "clear" }
    t.timestamps(true, true);

    t.index(['customer_id', 'service_date']);
  });

  // ---- Products Applied per Service ----
  await knex.schema.createTable('service_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
    t.string('product_name', 150).notNullable();
    t.string('product_category', 50); // 'herbicide', 'fungicide', 'insecticide', 'fertilizer', 'IGR'
    t.string('active_ingredient', 100);
    t.string('moa_group', 30); // mode of action group for rotation tracking
    t.decimal('application_rate', 8, 3);
    t.string('rate_unit', 20); // 'oz/1000sqft', 'lb/acre', etc.
    t.decimal('total_amount', 8, 3);
    t.string('amount_unit', 20);
    t.text('notes');
    t.timestamps(true, true);
  });

  // ---- Service Photos ----
  await knex.schema.createTable('service_photos', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
    t.enu('photo_type', ['before', 'after', 'issue', 'progress']).notNullable();
    t.string('s3_key', 300).notNullable();
    t.string('s3_url', 500);
    t.string('caption', 200);
    t.integer('sort_order').defaultTo(0);
    t.timestamps(true, true);
  });

  // ---- Scheduled Services (upcoming) ----
  await knex.schema.createTable('scheduled_services', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.date('scheduled_date').notNullable();
    t.time('window_start'); // e.g. '08:00'
    t.time('window_end'); // e.g. '10:00'
    t.string('service_type', 100).notNullable();
    t.enu('status', ['pending', 'confirmed', 'rescheduled', 'cancelled', 'completed']).defaultTo('pending');
    t.text('notes');
    t.boolean('customer_confirmed').defaultTo(false);
    t.timestamp('confirmed_at');
    t.timestamps(true, true);

    t.index(['customer_id', 'scheduled_date']);
  });

  // ---- Payment Methods (Square card references) ----
  await knex.schema.createTable('payment_methods', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('square_card_id', 100).notNullable();
    t.string('card_brand', 20); // 'VISA', 'MASTERCARD', etc.
    t.string('last_four', 4);
    t.string('exp_month', 2);
    t.string('exp_year', 4);
    t.boolean('is_default').defaultTo(false);
    t.boolean('autopay_enabled').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---- Payments ----
  await knex.schema.createTable('payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('payment_method_id').references('id').inTable('payment_methods');
    t.string('square_payment_id', 100);
    t.string('square_invoice_id', 100);
    t.date('payment_date').notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.enu('status', ['upcoming', 'processing', 'paid', 'failed', 'refunded']).defaultTo('upcoming');
    t.string('description', 200);
    t.jsonb('metadata'); // any extra Square response data
    t.timestamps(true, true);

    t.index(['customer_id', 'payment_date']);
  });

  // ---- Notification Preferences ----
  await knex.schema.createTable('notification_prefs', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');
    t.boolean('service_reminder_24h').defaultTo(true);
    t.boolean('tech_en_route').defaultTo(true);
    t.boolean('service_completed').defaultTo(true);
    t.boolean('billing_reminder').defaultTo(false);
    t.boolean('seasonal_tips').defaultTo(true);
    t.boolean('sms_enabled').defaultTo(true);
    t.boolean('email_enabled').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---- Phone Verification (OTP login) ----
  await knex.schema.createTable('verification_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('phone', 20).notNullable();
    t.string('code', 10).notNullable();
    t.timestamp('expires_at').notNullable();
    t.boolean('used').defaultTo(false);
    t.timestamps(true, true);

    t.index(['phone', 'code']);
  });
};

exports.down = async function (knex) {
  const tables = [
    'verification_codes',
    'notification_prefs',
    'payments',
    'payment_methods',
    'scheduled_services',
    'service_photos',
    'service_products',
    'service_records',
    'customers',
    'technicians',
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};
