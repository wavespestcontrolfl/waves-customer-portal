/**
 * Access codes: makes rollback of the source-key change safe in any batch
 * order (20261005090000 and 20261005100000 are frozen). Rolled back first as
 * the newest file, this down keeps one row per narrow source key, ranking an
 * active row first, then any other office decision, then the newest, and
 * restores the narrow index in the same step. The older downs then find no
 * variant to delete. Up re-applies the wider key.
 */

const NARROW = 'CREATE UNIQUE INDEX customer_access_codes_source_uniq '
  + 'ON customer_access_codes (customer_id, source_type, source_id, kind, value_hash) WHERE source_id IS NOT NULL';
const WIDE = 'CREATE UNIQUE INDEX customer_access_codes_source_uniq '
  + "ON customer_access_codes (customer_id, source_type, source_id, kind, value_hash, md5(coalesce(instructions, ''))) "
  + 'WHERE source_id IS NOT NULL';

exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_access_codes_source_uniq');
  await knex.raw(WIDE);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM customer_access_codes a
    USING (
      SELECT id, row_number() OVER (
        PARTITION BY customer_id, source_type, source_id, kind, value_hash
        ORDER BY (status = 'active') DESC, (status <> 'found') DESC, updated_at DESC, created_at DESC, id DESC) AS rn
      FROM customer_access_codes WHERE source_id IS NOT NULL
    ) ranked
    WHERE a.id = ranked.id AND ranked.rn > 1`);
  await knex.raw('DROP INDEX IF EXISTS customer_access_codes_source_uniq');
  await knex.raw(NARROW);
};
