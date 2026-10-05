/**
 * Access codes: keeps 20261005090000 reversible after writes (that file is
 * frozen). Rolling back restores the narrower source key, which one text can
 * then violate (an accepted code plus a corrected text that added
 * directions). This down runs first and leaves one row per narrow key: the
 * office-decided row when there is one, else the newest. No up change.
 */

exports.up = async function up() {};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM customer_access_codes a
    USING (
      SELECT id, row_number() OVER (
        PARTITION BY customer_id, source_type, source_id, kind, value_hash
        ORDER BY (status <> 'found') DESC, updated_at DESC, id DESC) AS rn
      FROM customer_access_codes WHERE source_id IS NOT NULL
    ) ranked
    WHERE a.id = ranked.id AND ranked.rn > 1`);
};
