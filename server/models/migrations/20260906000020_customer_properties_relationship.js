/**
 * customer_properties.relationship — how the CUSTOMER relates to each of
 * their service addresses (own home / rental they own / family member's
 * home / managed for a client). Owner decision 2026-09-06: model "family"
 * as a relationship field rather than a seventh occupancy value, so
 * occupancy_type keeps describing the property and this column describes
 * the payer's tie to it. Vocabulary: server/constants/property-relationships.js.
 *
 * Additive + nullable. Backfill only the unambiguous legacy rows:
 *   owner_occupied      → own_home
 *   rental_investment   → rental_owned
 *   any property of a customers.contact_role='property_manager' profile
 *                       → managed_for_client (overrides the two above — the
 *                         manager's "primary" is a client's address, never
 *                         their residence; see constants/contact-roles.js)
 * Everything else (seasonal / vacant / commercial / unknown) stays NULL for
 * the office to set.
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
    await knex.raw("UPDATE customer_properties SET relationship = 'own_home' WHERE relationship IS NULL AND occupancy_type = 'owner_occupied'");
    await knex.raw("UPDATE customer_properties SET relationship = 'rental_owned' WHERE relationship IS NULL AND occupancy_type = 'rental_investment'");
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
