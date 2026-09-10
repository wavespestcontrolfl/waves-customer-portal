/**
 * Appointment texts per SAVED PROPERTY (app property scope, PR 3 of 4 —
 * docs/multi-property-model.md "App property scope").
 *
 * `property_notification_prefs` — one row per customer_properties row, the
 * five appointment toggles plus "send these to me too". Every toggle is
 * NULLABLE: NULL = not chosen, resolved at read time from the ruling-R1
 * default (own_home / family_home / unrecorded inherit the customer's
 * notification_prefs row; rental_owned / managed_for_client start OFF —
 * the 2026-09-06 "rentals default off" ruling). No backfill on purpose: an
 * absent row IS the default. The PRIMARY property never gets a row — it keeps
 * reading the customer's notification_prefs row byte-for-byte, so single-home
 * customers and every sender path they touch are untouched.
 *
 * `property_text_decisions` — the ruling-R5 shadow log. While
 * GATE_APP_PROPERTY_TEXTS is off, each sender seam that resolves a non-primary
 * saved property records what the property rule WOULD decide next to what the
 * customer row DID decide, with zero change to sends. One row per resolution;
 * `agreed` is the review column (see the docs section for the read-only SELECT).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;

  if (!(await knex.schema.hasTable('property_notification_prefs'))) {
    await knex.schema.createTable('property_notification_prefs', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('property_id').notNullable().unique().references('id').inTable('customer_properties').onDelete('CASCADE');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.boolean('appointment_confirmation');
      t.boolean('service_reminder_72h');
      t.boolean('service_reminder_24h');
      t.boolean('tech_en_route');
      t.boolean('tech_arrived');
      t.boolean('appointment_notify_primary');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['customer_id'], 'property_notification_prefs_customer_idx');
    });
  }

  if (!(await knex.schema.hasTable('property_text_decisions'))) {
    await knex.schema.createTable('property_text_decisions', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('property_id').notNullable().references('id').inTable('customer_properties').onDelete('CASCADE');
      t.uuid('scheduled_service_id');
      // Which sender seam resolved it (reminders / en_route / arrived /
      // email_recipients / bell / consent).
      t.string('source', 40).notNullable();
      t.string('relationship', 30);
      t.jsonb('customer_decisions').notNullable();
      t.jsonb('property_decisions').notNullable();
      t.boolean('agreed').notNullable();
      t.boolean('enforced').notNullable().defaultTo(false);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['created_at'], 'property_text_decisions_created_idx');
      t.index(['property_id'], 'property_text_decisions_property_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('property_text_decisions')) {
    await knex.schema.dropTable('property_text_decisions');
  }
  if (await knex.schema.hasTable('property_notification_prefs')) {
    await knex.schema.dropTable('property_notification_prefs');
  }
};
