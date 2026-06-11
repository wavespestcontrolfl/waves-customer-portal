/**
 * Additional on-location contacts (slots 2 and 3).
 *
 * Graduates the single service-contact MVP (20260422000002) to up to three
 * contacts per customer/property. The original `service_contact_*` columns
 * remain slot 1 — every legacy single-beneficiary consumer (review requests,
 * project emails, estimate identity) keeps reading them unchanged. Slots are
 * kept compacted by the write paths (no empty slot before a filled one), so
 * "first contact" stays a stable concept.
 *
 * Columns over a child table is deliberate: the cap is a product decision
 * (max 3), every sender already has the customer row loaded, and the SMS /
 * email fan-out helpers in services/customer-contact.js stay synchronous.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('service_contact2_name', 100);
    t.string('service_contact2_phone', 20);
    t.string('service_contact2_email', 150);
    t.string('service_contact3_name', 100);
    t.string('service_contact3_phone', 20);
    t.string('service_contact3_email', 150);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('service_contact2_name');
    t.dropColumn('service_contact2_phone');
    t.dropColumn('service_contact2_email');
    t.dropColumn('service_contact3_name');
    t.dropColumn('service_contact3_phone');
    t.dropColumn('service_contact3_email');
  });
};
