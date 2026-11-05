/**
 * Migration — explicit-choice markers for the five routed notice channels
 *
 * GATE_APP_FIRST_ANY_DEVICE (owner 2026-11-04): a customer with the phone app
 * gets the routed notices in the app instead of a text, and "only the customer
 * can change back to text, if they prefer". The channel columns were seeded
 * with 'sms', so a stored 'sms' cannot be told apart from a deliberate Text
 * choice. These booleans record explicitness going FORWARD, like
 * 20260829000001_reminder_72h_channel_explicit (72 hour reminder) and
 * 20261024210000_confirmation_channel_explicit (booking confirmation): the
 * notifications route stamps one true on any customer write of that channel,
 * and the app-first routing treats a stored 'sms' as a veto only when the
 * stamp is true.
 *
 * Default false is the historical truth (no existing row is a provable
 * explicit choice), not a behavior toggle. Additive and idempotent.
 */
const COLUMNS = [
  'service_reminder_24h_channel_explicit',
  'en_route_channel_explicit',
  'tech_arrived_channel_explicit',
  'service_complete_channel_explicit',
  'payment_receipt_channel_explicit',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('notification_prefs', column)) continue;
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.boolean(column).notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('notification_prefs', column))) continue;
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.dropColumn(column);
    });
  }
};
