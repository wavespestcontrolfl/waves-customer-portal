/**
 * Add 'One-Time' to the waveguard_tier allowed values.
 * Knex t.enu() creates a CHECK constraint, so we drop and recreate it.
 */
exports.up = async (knex) => {
  // Drop the existing check constraint (Knex names it "customers_waveguard_tier_check")
  await knex.raw(`
    ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_waveguard_tier_check
  `);
  // Recreate with One-Time included
  await knex.raw(`
    ALTER TABLE customers ADD CONSTRAINT customers_waveguard_tier_check
    CHECK (waveguard_tier IN ('Bronze', 'Silver', 'Gold', 'Platinum', 'One-Time'))
  `);
};

exports.down = async (knex) => {
  await knex.raw(`ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_waveguard_tier_check`);
  await knex.raw(`
    ALTER TABLE customers ADD CONSTRAINT customers_waveguard_tier_check
    CHECK (waveguard_tier IN ('Bronze', 'Silver', 'Gold', 'Platinum'))
  `);
};
