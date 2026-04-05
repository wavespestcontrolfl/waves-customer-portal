/**
 * Migration 056 — GBP (Google Business Profile) Management
 *
 * Tables for tracking location profile data, detecting changes,
 * and managing notification preferences.
 */
exports.up = async function (knex) {
  // Enable uuid extension if not already enabled
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // Approved snapshot of each GBP location's profile data
  await knex.schema.createTable('gbp_locations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('location_id', 30).unique().notNullable();
    t.string('business_name', 200);
    t.text('description');
    t.text('address');
    t.string('phone', 30);
    t.jsonb('additional_phones').defaultTo('[]');
    t.string('website_url', 500);
    t.string('primary_category', 200);
    t.jsonb('additional_categories').defaultTo('[]');
    t.jsonb('regular_hours');
    t.jsonb('special_hours').defaultTo('[]');
    t.jsonb('services').defaultTo('[]');
    t.jsonb('attributes').defaultTo('{}');
    t.string('store_code', 50);
    t.date('opening_date');
    t.jsonb('service_areas').defaultTo('[]');
    t.boolean('hide_address').defaultTo(false);
    t.string('logo_url', 500);
    t.string('cover_photo_url', 500);
    t.jsonb('photos').defaultTo('[]');
    t.timestamp('last_synced_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Change detection log
  await knex.schema.createTable('gbp_updates', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('location_id', 30).notNullable();
    t.string('field_name', 100).notNullable();
    t.text('old_value');
    t.text('new_value');
    t.string('source', 30).notNullable(); // 'google', 'owner', 'suggestion', 'system'
    t.string('status', 20).defaultTo('pending'); // 'pending', 'approved', 'rejected'
    t.string('reviewed_by', 100);
    t.timestamp('reviewed_at');
    t.timestamp('detected_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('location_id');
    t.index('status');
    t.index('detected_at');
  });

  // Per-user notification preferences
  await knex.schema.createTable('gbp_notification_prefs', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('user_email', 200).notNullable();
    t.string('frequency', 20).defaultTo('daily'); // 'realtime', 'daily', 'weekly', 'monthly'
    t.jsonb('field_filters').defaultTo('[]');
    t.boolean('enabled').defaultTo(true);
    t.timestamp('last_sent_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('user_email');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('gbp_notification_prefs');
  await knex.schema.dropTableIfExists('gbp_updates');
  await knex.schema.dropTableIfExists('gbp_locations');
};
