/**
 * Access codes (PR 2c, owner ruling 2026-10-05): "save all codes, regardless
 * if they are or are not a customer", and a visitor pass is filed to the
 * neighborhood directory like a gate code.
 *
 * - customer_id becomes nullable: a code texted from a number with no customer
 *   record is filed `found` with the sender's phone (`sender_phone`, null on a
 *   linked row), for the office to link to a customer. `suggested_customer_id`
 *   holds the one customer whose address the text names, when there is exactly
 *   one. An unlinked row is only ever waiting (`found`) or turned down
 *   (`dismissed`); the check keeps it from being activated before a link.
 * - The source key (20261005090000 and its rollback files, frozen) names
 *   customer_id, and NULLs never collide, so a second partial unique index
 *   covers the unlinked rows (the same text, kind, value and directions).
 * - neighborhood_access_id: the directory row an accepted pass created, so
 *   retiring the code retires exactly that row and no other. A plain id, not a
 *   foreign key: the directory's own migration drops its table on rollback and
 *   must not be blocked by this table (a missing row is simply not retired).
 *
 * Dark behind GATE_ACCESS_CODES_SECTION like the table itself. down() deletes
 * the unlinked rows first (they cannot exist without the nullable column),
 * then restores the NOT NULL.
 */

const UNLINKED_INDEX = 'customer_access_codes_unlinked_source_uniq';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_access_codes'))) return;
  await knex.raw('ALTER TABLE customer_access_codes ALTER COLUMN customer_id DROP NOT NULL');
  await knex.raw('ALTER TABLE customer_access_codes ADD COLUMN IF NOT EXISTS sender_phone text');
  await knex.raw('ALTER TABLE customer_access_codes ADD COLUMN IF NOT EXISTS suggested_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL');
  await knex.raw('ALTER TABLE customer_access_codes ADD COLUMN IF NOT EXISTS neighborhood_access_id uuid');
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_owner_check');
  await knex.raw(`ALTER TABLE customer_access_codes ADD CONSTRAINT customer_access_codes_owner_check CHECK (
    customer_id IS NOT NULL OR (status IN ('found', 'dismissed') AND nullif(btrim(coalesce(sender_phone, '')), '') IS NOT NULL))`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${UNLINKED_INDEX} `
    + "ON customer_access_codes (sender_phone, source_type, source_id, kind, value_hash, md5(coalesce(instructions, ''))) "
    + 'WHERE customer_id IS NULL AND source_id IS NOT NULL',
  );
  await knex.raw('CREATE INDEX IF NOT EXISTS customer_access_codes_suggested_idx ON customer_access_codes (suggested_customer_id) WHERE suggested_customer_id IS NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_access_codes'))) return;
  await knex.raw('DROP INDEX IF EXISTS customer_access_codes_suggested_idx');
  await knex.raw(`DROP INDEX IF EXISTS ${UNLINKED_INDEX}`);
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_owner_check');
  await knex.raw('DELETE FROM customer_access_codes WHERE customer_id IS NULL');
  await knex.raw('ALTER TABLE customer_access_codes DROP COLUMN IF EXISTS neighborhood_access_id');
  await knex.raw('ALTER TABLE customer_access_codes DROP COLUMN IF EXISTS suggested_customer_id');
  await knex.raw('ALTER TABLE customer_access_codes DROP COLUMN IF EXISTS sender_phone');
  await knex.raw('ALTER TABLE customer_access_codes ALTER COLUMN customer_id SET NOT NULL');
};
