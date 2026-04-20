/**
 * Backfill review_requests.service_record_id on environments where the
 * column is missing.
 *
 * Why this exists: the original 20260401000083_review_requests migration
 * had two branches — (a) fresh create, and (b) "table already exists from
 * old review-gate system → ALTER in missing columns". Branch (b) listed
 * every new column except service_record_id, so any prod DB that took
 * the ALTER path (ours did) ended up without the FK, and every
 * ReviewRequestService.create() call since has been throwing
 * "column 'service_record_id' does not exist" after successful payments.
 *
 * Safe on both environments: guarded by hasColumn, so a freshly-seeded
 * DB (which got the column via branch (a)) is a no-op.
 */

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('review_requests');
  if (!hasTable) return;

  const hasCol = await knex.schema.hasColumn('review_requests', 'service_record_id');
  if (hasCol) return;

  await knex.schema.alterTable('review_requests', (t) => {
    t.uuid('service_record_id')
      .references('id')
      .inTable('service_records')
      .onDelete('SET NULL');
    t.index('service_record_id');
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('review_requests');
  if (!hasTable) return;

  const hasCol = await knex.schema.hasColumn('review_requests', 'service_record_id');
  if (!hasCol) return;

  await knex.schema.alterTable('review_requests', (t) => {
    t.dropColumn('service_record_id');
  });
};
