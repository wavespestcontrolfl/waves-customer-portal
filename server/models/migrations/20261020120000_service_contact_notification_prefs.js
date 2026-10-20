/**
 * Per-contact notification choices (contact login, GATE_CONTACT_LOGIN).
 *
 * `service_contact_notification_prefs` — one row per (customer, on-location
 * contact PHONE). Keyed by the last-10 phone key rather than the slot number
 * because the three `customers.service_contact*` slots are compacted on every
 * contact rewrite (a removed slot 1 shifts slot 2 down); the phone is the
 * identity `recipient_optin` already uses, so a contact keeps their choices
 * across a reorder and loses them only when the holder removes their number
 * (the holder's contact save prunes the row).
 *
 * Every toggle and channel is NULLABLE: NULL = no choice, the account's own
 * setting applies. A stored value only ever NARROWS what the account sends —
 * a purpose the holder turned off stays off (owner ruling 2026-10-20). No
 * backfill on purpose: an absent row IS today's behavior.
 *
 * Channel values: 'sms' = texts only, 'email' = email only, 'both' / NULL =
 * whatever the account sends. No 'push': push subscriptions are keyed by
 * customer, so a contact device is not subscribed in this lane.
 *
 * `consent_attested_at`: when the contact ticked the in-app text-consent
 * statement. It stands in for the YES reply on a pending / undelivered
 * recipient_optin ask only, never over a STOP (declined) row.
 */

const CHANNEL_COLUMNS = [
  'appointment_confirmation_channel',
  'service_reminder_72h_channel',
  'service_reminder_24h_channel',
  'en_route_channel',
  'tech_arrived_channel',
  'service_complete_channel',
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_contact_notification_prefs')) return;
  await knex.schema.createTable('service_contact_notification_prefs', (t) => {
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('phone_key', 10).notNullable();
    t.boolean('appointment_confirmation');
    t.boolean('service_reminder_72h');
    t.boolean('service_reminder_24h');
    t.boolean('tech_en_route');
    t.boolean('tech_arrived');
    t.boolean('service_completed');
    for (const col of CHANNEL_COLUMNS) t.string(col, 10);
    t.boolean('sms_enabled');
    t.boolean('email_enabled');
    t.timestamp('consent_attested_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['customer_id', 'phone_key']);
  });
  for (const col of CHANNEL_COLUMNS) {
    await knex.raw(
      `ALTER TABLE service_contact_notification_prefs ADD CONSTRAINT service_contact_notification_prefs_${col}_check CHECK (${col} IS NULL OR ${col} IN ('sms', 'email', 'both'))`,
    );
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('service_contact_notification_prefs')) {
    await knex.schema.dropTable('service_contact_notification_prefs');
  }
};
