/**
 * Service contact on customer record.
 *
 * Bill-payer ≠ service-beneficiary is common enough to justify a first-class
 * slot (landlord/tenant, adult-child/elderly-parent, HOA/resident,
 * business-owner/on-site-manager, mother-pays-for-son).
 *
 * Touches that care about the *beneficiary* (appointment reminders,
 * post-service SMS, review requests) route to the service contact when
 * present. Touches that care about the *payer* (invoices, autopay notices,
 * payment-failed alerts) stay on the primary phone/email.
 *
 * This is the two-column MVP; a future migration may graduate to a proper
 * `customer_contacts` table with roles if more than one secondary contact
 * becomes necessary. These columns are forward-compatible (we can mirror
 * them into `customer_contacts` later).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('service_contact_name', 100);
    t.string('service_contact_phone', 20);
    t.string('service_contact_email', 150);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('service_contact_name');
    t.dropColumn('service_contact_phone');
    t.dropColumn('service_contact_email');
  });
};
