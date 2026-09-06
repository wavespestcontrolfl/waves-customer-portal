/**
 * The ONE way to seed a new customer's per-customer default rows
 * (property_preferences + notification_prefs). Every customer-creation
 * path calls this — a customer without these rows is unreachable (the
 * consent validator hard-fails a missing notification_prefs row) and
 * invisible to the property/irrigation surfaces.
 *
 * Marketing-grade flags seed as NULL ("never asked"), overriding the
 * column defaults: marketing senders infer opted_in consent from
 * seasonal_tips/marketing_offers === true with the row's timestamps as
 * capturedAt, so a system-seeded true would fabricate TCPA consent.
 * Opt-out checks everywhere test === false, so NULL leaves transactional
 * behavior untouched.
 *
 * Secondary profiles (an "Additional property" / rental on an account —
 * customers.is_primary_profile !== true with an account_id) seed their five
 * appointment texts OFF (owner ruling 2026-09-06: only the primary
 * residence is live by default; the owner switches a rental on from the
 * Visits tab). appointment_notify_primary is untouched — when a rental IS
 * switched on, the account holder still gets the copy (owner ruling
 * 2026-07-24). The row is looked up here rather than passed in so every
 * creation path gets the rule without knowing about it.
 *
 * onConflict-ignore on the customer_id unique indexes: never overwrites
 * an existing row (a real opt-out's row always exists), safe to call on
 * pre-existing customers, race-safe. Accepts a knex handle or trx.
 */
const SECONDARY_PROFILE_APPOINTMENT_TEXTS_OFF = Object.freeze({
  appointment_confirmation: false,
  service_reminder_72h: false,
  service_reminder_24h: false,
  tech_en_route: false,
  tech_arrived: false,
});

async function isSecondaryProfileRow(dbc, customerId) {
  const row = await dbc('customers').where({ id: customerId }).first('is_primary_profile', 'account_id');
  // The canonical classifier (customer-contact.js): anything other than
  // is_primary_profile === true on an account-linked row is secondary — a
  // NULL flag counts (codex P2). Lazy require: customer-contact pulls in the
  // db module and this helper is loaded by every creation path.
  const { isSecondaryProfile } = require('./customer-contact');
  return isSecondaryProfile(row);
}

async function createDefaultCustomerRows(dbc, customerId) {
  await dbc('property_preferences')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
  const secondary = await isSecondaryProfileRow(dbc, customerId);
  await dbc('notification_prefs')
    .insert({
      customer_id: customerId,
      seasonal_tips: null,
      marketing_offers: null,
      ...(secondary ? SECONDARY_PROFILE_APPOINTMENT_TEXTS_OFF : {}),
    })
    .onConflict('customer_id')
    .ignore();
}

module.exports = { createDefaultCustomerRows, SECONDARY_PROFILE_APPOINTMENT_TEXTS_OFF };
