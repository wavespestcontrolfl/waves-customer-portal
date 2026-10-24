/**
 * Access codes from inbound emails (owner 2026-10-24, dark behind
 * GATE_ACCESS_CODES_EMAILS): a code an email states is filed `found` like one
 * from a text or a call. An email from an address with no customer record is
 * filed unlinked, and the row keeps the sender's ADDRESS in its own column
 * (`sender_email`, lower case, null on every other row), the way an unlinked text
 * keeps the sender's phone in `sender_phone`. The office links it to a customer
 * before it can be accepted.
 *
 * - The owner check (20261006120000, frozen) required a sender phone on every
 *   unlinked row; it now accepts a sender phone OR a sender email.
 * - The unlinked-source key (also frozen) names sender_phone, which is null on
 *   an email row, and NULLs never collide, so a second partial unique index
 *   covers the unlinked email rows (the same email, kind, value and directions).
 *   It leaves the sender out of the key, so a corrected address never collides
 *   with the row it updates.
 *
 * source_type 'email' is already allowed on customer_access_codes (the table's
 * own check) and on data_hygiene_source_extractions (20260929010000), so
 * nothing else changes. Additive and dark: nothing writes sender_email until the
 * gate is on. down() deletes the unlinked email rows (the old check cannot hold
 * them), restores the old check and drops the column.
 */

const EMAIL_INDEX = 'customer_access_codes_unlinked_email_source_uniq';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_access_codes'))) return;
  await knex.raw('ALTER TABLE customer_access_codes ADD COLUMN IF NOT EXISTS sender_email text');
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_owner_check');
  await knex.raw(`ALTER TABLE customer_access_codes ADD CONSTRAINT customer_access_codes_owner_check CHECK (
    customer_id IS NOT NULL OR (status IN ('found', 'dismissed') AND (
      nullif(btrim(coalesce(sender_phone, '')), '') IS NOT NULL OR nullif(btrim(coalesce(sender_email, '')), '') IS NOT NULL)))`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${EMAIL_INDEX} `
    + "ON customer_access_codes (source_type, source_id, kind, value_hash, md5(coalesce(instructions, ''))) "
    + 'WHERE customer_id IS NULL AND source_id IS NOT NULL AND sender_email IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_access_codes'))) return;
  await knex.raw(`DROP INDEX IF EXISTS ${EMAIL_INDEX}`);
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_owner_check');
  await knex.raw("DELETE FROM customer_access_codes WHERE customer_id IS NULL AND nullif(btrim(coalesce(sender_phone, '')), '') IS NULL");
  await knex.raw(`ALTER TABLE customer_access_codes ADD CONSTRAINT customer_access_codes_owner_check CHECK (
    customer_id IS NOT NULL OR (status IN ('found', 'dismissed') AND nullif(btrim(coalesce(sender_phone, '')), '') IS NOT NULL))`);
  await knex.raw('ALTER TABLE customer_access_codes DROP COLUMN IF EXISTS sender_email');
};
