/**
 * Clean up two kinds of phantom rows in google_reviews that inflated the
 * "No Portal Reply" queue and the per-location star breakdowns:
 *
 * 1. Places-fallback duplicates of GBP-linked reviews. The Places sample
 *    sync keys its synthetic google_review_id on the Places `time` field,
 *    which moves when a reviewer EDITS their review — so an edited review
 *    came back under a new id and was inserted as a second row. Concretely:
 *    Jackie Lopez (parrish) edited her replied-to 5-star on 2026-05-16 and
 *    the portal grew a duplicate that sat in the needs-reply queue with a
 *    stale [DRAFT], while her real (GBP-linked, replied) row was fine.
 *    The sync-side fix lands with this migration; this deletes the rows the
 *    old behavior already created. Match rule mirrors the sync fix: Google
 *    allows one review per account per listing, so a places_* row whose
 *    (location_id, reviewer_name) collides with a GBP-linked row is the
 *    same review twice. Rows referenced by review_incentive_payouts are
 *    skipped rather than re-pointed — none exist today, this is a guard.
 *
 * 2. Orphaned _stats rows whose google_review_id no longer matches
 *    `places_stats_<location_id>` (the key the stats sync upserts by).
 *    A `places_stats_lakewood-ranch` row from before the bradenton id
 *    rename can never be updated again, but the reviews endpoint still
 *    reads it — feeding a permanently-stale syncedAt into the
 *    googleStatsComplete freshness check.
 *
 * down() is a no-op: both row classes are unreproducible sync artifacts
 * (the duplicate's content lives on in the canonical GBP row), and
 * restoring them would just re-corrupt the stats.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) {
    return;
  }

  // 1. places_* duplicates of GBP-linked reviews
  const dupes = await knex('google_reviews as dup')
    .where('dup.google_review_id', 'like', 'places\\_%')
    .whereNull('dup.gbp_review_name')
    .where('dup.reviewer_name', '!=', '_stats')
    // Distinct people can both surface as "Anonymous" — name collision is
    // only a same-review signal for real display names.
    .whereRaw("LOWER(dup.reviewer_name) != 'anonymous'")
    .whereExists(function () {
      this.select(1)
        .from('google_reviews as canon')
        .whereRaw('canon.location_id = dup.location_id')
        .whereRaw('LOWER(canon.reviewer_name) = LOWER(dup.reviewer_name)')
        .whereRaw('canon.id != dup.id')
        .whereNotNull('canon.gbp_review_name');
    })
    .select('dup.id', 'dup.location_id', 'dup.reviewer_name');

  let deleted = 0;
  for (const row of dupes) {
    const payout = await knex('review_incentive_payouts')
      .where({ google_review_id: row.id })
      .first();
    if (payout) {
      // eslint-disable-next-line no-console
      console.log(`[review_dup_row_cleanup] SKIPPED dup ${row.id} (${row.reviewer_name} @ ${row.location_id}) — has incentive payout`);
      continue;
    }
    await knex('google_reviews').where({ id: row.id }).del();
    deleted++;
    // eslint-disable-next-line no-console
    console.log(`[review_dup_row_cleanup] deleted duplicate review ${row.id} (${row.reviewer_name} @ ${row.location_id})`);
  }

  // 2. _stats rows the sync can no longer reach
  const staleStats = await knex('google_reviews')
    .where({ reviewer_name: '_stats' })
    .whereRaw("google_review_id != 'places_stats_' || location_id")
    .del();

  // eslint-disable-next-line no-console
  console.log(`[review_dup_row_cleanup] deleted ${deleted} duplicate review row(s), ${staleStats} orphaned _stats row(s)`);
};

exports.down = async function down() {
  // Intentional no-op — see header comment.
};
