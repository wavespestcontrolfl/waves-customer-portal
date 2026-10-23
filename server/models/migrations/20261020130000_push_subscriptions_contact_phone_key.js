/**
 * push_subscriptions.contact_phone_key — which PERSON a customer device row
 * belongs to (contact login, GATE_CONTACT_LOGIN). NULL = the account
 * holder's device (every existing row). A value is the last-10 phone key of
 * the on-location contact whose session registered the device — the same
 * key as service_contact_notification_prefs.phone_key and the session's
 * contactKey claim.
 *
 * The sender (services/push-notifications.js sendToCustomer) excludes
 * contact-stamped rows by default and includes them only for appointment
 * and report purposes, subject to that contact's own choices, so a
 * contact's phone never shows the holder's billing. The device-token
 * unique index is unchanged: a device belongs to one person at a time, and
 * the subscribe upsert re-stamps the column on every registration.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('push_subscriptions')
    && !(await knex.schema.hasColumn('push_subscriptions', 'contact_phone_key'))) {
    await knex.schema.alterTable('push_subscriptions', (t) => {
      t.string('contact_phone_key', 10);
      t.index(['customer_id', 'contact_phone_key'], 'push_subscriptions_contact_phone_key_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('push_subscriptions')
    && await knex.schema.hasColumn('push_subscriptions', 'contact_phone_key')) {
    await knex.schema.alterTable('push_subscriptions', (t) => {
      t.dropIndex(['customer_id', 'contact_phone_key'], 'push_subscriptions_contact_phone_key_idx');
      t.dropColumn('contact_phone_key');
    });
  }
};
