// The 20260930000001 seed stamped verified_at with the migration run time.
// That file has already run on the preview database, so it is frozen; this
// migration pins the seeded rows to the date the labels were actually read
// (2026-09-29) so a later preview, restore or fresh environment never claims a
// later verification date, and completion product facts freeze the true one.
const VERIFIED_BY = 'label-check-2026-09-29';
const VERIFIED_AT = '2026-09-29T00:00:00.000Z';

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('products_catalog', 'post_application_watering');
  if (!hasColumn) return;
  await knex.raw(
    `UPDATE products_catalog
        SET post_application_watering = jsonb_set(post_application_watering, '{verified_at}', to_jsonb(?::text), true)
      WHERE post_application_watering->>'verified_by' = ?
        AND post_application_watering->>'verified_at' IS DISTINCT FROM ?`,
    [VERIFIED_AT, VERIFIED_BY, VERIFIED_AT],
  );
};

// The original run-time stamp is not recoverable; leave the pinned date.
exports.down = async function down() {};
