/**
 * Add 'Commercial' to the waveguard_tier allowed values.
 *
 * Commercial auto-priced recurring plans (commercial lawn / tree & shrub) are
 * flat and are NOT a WaveGuard membership, but an accepted estimate still sets
 * the customer's monthly_rate. Storing NULL for them lets the membership
 * predicates (isMembershipCustomerRow / hasMembership / resolveActiveTierName)
 * fall back to "monthly_rate > 0 ⇒ member", rendering them as Bronze. A distinct
 * 'Commercial' tier — added to each predicate's NON_MEMBERSHIP set — keeps them
 * correctly non-member while remaining a valid, meaningful tier label.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_waveguard_tier_check');
  await knex.raw(`
    ALTER TABLE customers ADD CONSTRAINT customers_waveguard_tier_check
    CHECK (waveguard_tier IN ('Bronze', 'Silver', 'Gold', 'Platinum', 'One-Time', 'Commercial'))
  `);
};

exports.down = async (knex) => {
  // Re-collapse any 'Commercial' rows to NULL before restoring the tighter
  // constraint so the down migration can't fail on an out-of-range value.
  await knex('customers').where({ waveguard_tier: 'Commercial' }).update({ waveguard_tier: null });
  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_waveguard_tier_check');
  await knex.raw(`
    ALTER TABLE customers ADD CONSTRAINT customers_waveguard_tier_check
    CHECK (waveguard_tier IN ('Bronze', 'Silver', 'Gold', 'Platinum', 'One-Time'))
  `);
};
