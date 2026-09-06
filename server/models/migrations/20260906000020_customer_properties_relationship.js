/**
 * customer_properties.relationship — how the CUSTOMER relates to each of
 * their service addresses (own home / rental they own / family member's
 * home / managed for a client). Owner decision 2026-09-06: model "family"
 * as a relationship field rather than a seventh occupancy value, so
 * occupancy_type keeps describing the property and this column describes
 * the payer's tie to it. Vocabulary: server/constants/property-relationships.js.
 *
 * Additive + nullable. Backfill ONLY from evidence that establishes the
 * customer's relationship — customers.contact_role='property_manager' →
 * managed_for_client on every property of that profile (the manager's
 * "primary" is a client's address, never their residence; see
 * constants/contact-roles.js). occupancy_type is deliberately NOT used:
 * migration 20260629000001 defaulted it to owner_occupied broadly and the
 * call pipeline infers it, so it says how the property is used, not whether
 * THIS customer owns it (a tenant's or a family member's owner-occupied
 * home would read as own_home). Everything else stays NULL for the office
 * to set.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'relationship'))) {
    await knex.schema.alterTable('customer_properties', (t) => {
      t.string('relationship', 30);
    });
    await knex.raw(
      'ALTER TABLE customer_properties ADD CONSTRAINT customer_properties_relationship_check '
      + "CHECK (relationship IS NULL OR relationship IN ('own_home', 'rental_owned', 'family_home', 'managed_for_client'))",
    );
    if (await knex.schema.hasColumn('customers', 'contact_role')) {
      await knex.raw(
        "UPDATE customer_properties cp SET relationship = 'managed_for_client' "
        + "FROM customers c WHERE c.id = cp.customer_id AND c.contact_role = 'property_manager'",
      );
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (await knex.schema.hasColumn('customer_properties', 'relationship')) {
    await knex.raw('ALTER TABLE customer_properties DROP CONSTRAINT IF EXISTS customer_properties_relationship_check');
    await knex.schema.alterTable('customer_properties', (t) => {
      t.dropColumn('relationship');
    });
  }
};
