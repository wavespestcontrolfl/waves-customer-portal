exports.up = async function (knex) {
  // Allow waveguard_tier to be null — not all customers are on a plan
  await knex.raw(`ALTER TABLE customers ALTER COLUMN waveguard_tier DROP DEFAULT`);
  await knex.raw(`ALTER TABLE customers ALTER COLUMN waveguard_tier DROP NOT NULL`);

  // Clear Bronze from customers who have no recurring services (no monthly_rate set)
  await knex.raw(`
    UPDATE customers SET waveguard_tier = NULL
    WHERE waveguard_tier = 'Bronze'
    AND (monthly_rate IS NULL OR monthly_rate = 0)
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE customers ALTER COLUMN waveguard_tier SET DEFAULT 'Bronze'`);
  await knex.raw(`UPDATE customers SET waveguard_tier = 'Bronze' WHERE waveguard_tier IS NULL`);
};
