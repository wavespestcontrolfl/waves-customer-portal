/**
 * Access codes, one list (owner ruling 2026-10-05): the profile's gate,
 * garage and lockbox codes are mirrored into customer_access_codes for a
 * one-home customer, so the two places never disagree.
 *
 * 1. `profile` joins the source types: a row the mirror wrote from the
 *    profile field (decided_by stays null; the profile is its source).
 * 2. access_code_profile_mirror is the sweep's per-customer receipt: the
 *    profile edit time it last saw, whether the customer had exactly one home,
 *    and the canonical hash of each profile code it last mirrored (never the
 *    code), so a field the office later empties is told apart from one that
 *    never had a code. A row per customer, removed with the customer.
 *
 * Down removes the mirrored rows (the profile field still holds each value)
 * before the old check comes back, then drops the receipt table.
 */

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_source_type_check');
  await knex.raw(`ALTER TABLE customer_access_codes ADD CONSTRAINT customer_access_codes_source_type_check
    CHECK (source_type IN ('sms', 'call', 'email', 'staff', 'profile'))`);
  if (!(await knex.schema.hasTable('access_code_profile_mirror'))) {
    await knex.raw(`
      CREATE TABLE access_code_profile_mirror (
        customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        profile_updated_at timestamptz,
        one_home boolean NOT NULL DEFAULT false,
        hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
        mirrored_at timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw('CREATE INDEX access_code_profile_mirror_checked_idx ON access_code_profile_mirror (mirrored_at)');
  }
};

exports.down = async function down(knex) {
  await knex.raw("DELETE FROM customer_access_codes WHERE source_type = 'profile'");
  await knex.raw('ALTER TABLE customer_access_codes DROP CONSTRAINT IF EXISTS customer_access_codes_source_type_check');
  await knex.raw(`ALTER TABLE customer_access_codes ADD CONSTRAINT customer_access_codes_source_type_check
    CHECK (source_type IN ('sms', 'call', 'email', 'staff'))`);
  await knex.schema.dropTableIfExists('access_code_profile_mirror');
};
