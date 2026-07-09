/**
 * scheduled_services property linkage — closes the 2026-07-08 call-pipeline
 * audit's #1 structural gap: an appointment carried no record of WHICH
 * property the visit is for, so dispatch/tech rendered the customer's primary
 * mirror address (`customers.address_line1`) for every visit — a booking for
 * a customer's RENTAL displayed (and dispatched to) their home.
 *
 * Two additive pieces:
 *  - `property_id` — FK to customer_properties when the booked address
 *    resolves to a known property (nullable; SET NULL on property deletion so
 *    a property cleanup never cascades into schedule history).
 *  - `service_address_*` — a denormalized stamp of the address the visit was
 *    actually booked for (AV-corrected when the call pipeline booked it).
 *    Denormalized ON PURPOSE: the stamp is what was agreed at booking time
 *    and must survive later edits/merges of property rows.
 *
 * Readers COALESCE(scheduled_services.service_address_*, customers.address_*)
 * so unstamped legacy rows keep today's behavior exactly.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.uuid('property_id').references('id').inTable('customer_properties').onDelete('SET NULL');
    t.string('service_address_line1', 200);
    t.string('service_address_line2', 100);
    t.string('service_address_city', 50);
    t.string('service_address_state', 2);
    t.string('service_address_zip', 10);
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_scheduled_services_property_id ON scheduled_services (property_id) WHERE property_id IS NOT NULL');
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_property_id');
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('property_id');
    t.dropColumn('service_address_line1');
    t.dropColumn('service_address_line2');
    t.dropColumn('service_address_city');
    t.dropColumn('service_address_state');
    t.dropColumn('service_address_zip');
  });
};
