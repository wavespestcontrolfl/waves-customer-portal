/**
 * Drop the UNIQUE constraint on customers.email so multiple customers can
 * share an email address (spouses, shared household/business addresses).
 * A non-unique index is kept so inbound-email lookups stay fast.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_unique`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customers_email_index ON customers (email)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS customers_email_index`);
  await knex.raw(`ALTER TABLE customers ADD CONSTRAINT customers_email_unique UNIQUE (email)`);
};
