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
 * onConflict-ignore on the customer_id unique indexes: never overwrites
 * an existing row (a real opt-out's row always exists), safe to call on
 * pre-existing customers, race-safe. Accepts a knex handle or trx.
 */
async function createDefaultCustomerRows(dbc, customerId) {
  await dbc('property_preferences')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
  await dbc('notification_prefs')
    .insert({ customer_id: customerId, seasonal_tips: null, marketing_offers: null })
    .onConflict('customer_id')
    .ignore();
}

module.exports = { createDefaultCustomerRows };
