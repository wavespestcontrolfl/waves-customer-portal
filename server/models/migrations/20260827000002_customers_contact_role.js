// customers.contact_role — who the CONTACT on this profile is relative to the
// serviced properties: 'owner' | 'property_manager' | 'tenant' (NULL = not
// recorded; readers treat NULL as owner, the residential majority).
//
// Born from a property-management account (2026-08-27) whose four serviced
// rentals all live under one customer profile: customer_properties requires
// exactly ONE primary per customer and mirrors it into customers.address_*,
// so the "primary" row is the DEFAULT SERVICE ADDRESS — not a residence.
// Nothing on the profile said "this contact doesn't live here"; the primary's
// label was the only hint. This column records the payer/occupant
// relationship explicitly. Enforced in the app (constants/contact-roles.js),
// not as a DB enum, so adding a role never needs an ALTER.

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('customers', 'contact_role');
  if (has) return;
  await knex.schema.alterTable('customers', (t) => {
    t.string('contact_role', 30).nullable();
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('customers', 'contact_role');
  if (!has) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('contact_role');
  });
};
