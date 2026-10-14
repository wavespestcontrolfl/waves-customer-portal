/**
 * Access codes (PR 2a follow-up, before any production use): one text yields
 * one row per kind, value AND directions. A corrected text that keeps the code
 * but adds directions ("press 2 first") is new content and must reach review;
 * the first index (20261004110000, frozen) ignored directions and dropped it.
 */

exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_access_codes_source_uniq');
  await knex.raw(
    'CREATE UNIQUE INDEX customer_access_codes_source_uniq '
    + "ON customer_access_codes (customer_id, source_type, source_id, kind, value_hash, md5(coalesce(instructions, ''))) "
    + 'WHERE source_id IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_access_codes_source_uniq');
  await knex.raw(
    'CREATE UNIQUE INDEX customer_access_codes_source_uniq '
    + 'ON customer_access_codes (customer_id, source_type, source_id, kind, value_hash) WHERE source_id IS NOT NULL',
  );
};
