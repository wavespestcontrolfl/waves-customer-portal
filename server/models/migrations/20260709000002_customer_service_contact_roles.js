/**
 * Service-contact slot ROLES — the call pipeline extracts a role for each
 * secondary contact (home_buyer, tenant, landlord, property_manager, ...) and
 * previously discarded it at the slot write, leaving slot POSITION (arrival
 * order) as the only signal downstream senders had. Recording the role makes
 * role-aware recipient selection possible later (e.g. "send the WDO report to
 * the buyer") without changing any current sender semantics.
 *
 * Additive only: three nullable varchars mirroring the existing
 * service_contact{,2,3}_{name,phone,email} triplets.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('service_contact_role', 30);
    t.string('service_contact2_role', 30);
    t.string('service_contact3_role', 30);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('service_contact_role');
    t.dropColumn('service_contact2_role');
    t.dropColumn('service_contact3_role');
  });
};
