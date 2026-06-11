/**
 * Clean up two kinds of phantom rows in google_reviews that inflated the
 * "No Portal Reply" queue and the per-location star breakdowns:
 *
 * 1. ONE verified Places-fallback duplicate of a GBP-linked review.
 *    The Places sample sync keys its synthetic google_review_id on the
 *    Places `time` field, which moves when a reviewer EDITS their review —
 *    so an edited review came back under a new id and was inserted as a
 *    second row. Jackie Lopez (parrish) edited her replied-to 5-star on
 *    2026-05-16 and the portal grew a duplicate that sat in the needs-reply
 *    queue with a stale [DRAFT], while her real (GBP-linked, replied) row
 *    was fine. The sync-side dedup fix lands with this migration.
 *
 *    The delete is pinned to the exact row id rather than a generic
 *    (location, reviewer_name) collision predicate: display names are not
 *    unique across Google accounts, so a name-only rule could destroy a
 *    legitimate same-name review (the same reason the sync path refuses to
 *    name-merge un-linked Places rows). This specific row was manually
 *    verified against the public Parrish listing on 2026-06-11: Google
 *    shows exactly ONE Jackie Lopez review there — "Edited 3 weeks ago",
 *    owner-replied — and the portal held two rows for it. The unlinked
 *    places_* row is the pre-edit artifact. Guards double-check identity
 *    at run time and skip (loudly) if the data has drifted or the row is
 *    referenced by review_incentive_payouts.
 *
 * 2. Orphaned _stats rows whose google_review_id no longer matches
 *    `places_stats_<location_id>` (the key the stats sync upserts by).
 *    A `places_stats_lakewood-ranch` row from before the bradenton id
 *    rename can never be updated again, but the reviews endpoint still
 *    reads it — feeding a permanently-stale syncedAt into the
 *    googleStatsComplete freshness check. This rule is mechanical (the
 *    sync provably cannot reach these rows again) so it stays generic.
 *
 * down() restores the deleted duplicate from a full snapshot; the _stats
 * rows are unreproducible sync artifacts and stay deleted.
 */

// Full snapshot of the duplicate row as captured from prod on 2026-06-11,
// used for identity guards in up() and restoration in down().
const DUP_ROW = {
  id: '55e2f920-1ad8-401c-a235-cf213107e01c',
  google_review_id: 'places_ChIJM32aQRIlw4gRr7goqhbAVpw_1778961032',
  gbp_review_name: null,
  location_id: 'parrish',
  reviewer_name: 'Jackie Lopez',
  reviewer_photo_url: 'https://lh3.googleusercontent.com/a-/ALV-UjXLNNpBE2oien8mE-OH2bALStoRzyZTPQ9CGJrx35B-_kRnGYVS=s128-c0x00000000-cc-rp-mo',
  star_rating: 5,
  review_text: 'Professional, thorough, and very informative. They took the time to explain everything clearly and made the inspection process easy and stress-free. Highly recommend!',
  review_reply: '[DRAFT] Hi Jackie, thank you for the wonderful review. We are glad the inspection felt clear, thorough, and stress-free, and we appreciate you recognizing the time our team took to explain everything.\n\nThat kind of communication is a big part of how we approach pest control for local homeowners. Thank you for recommending Waves Pest Control.\n\nThe Waves Pest Control Parrish Team',
  reply_updated_at: null,
  review_created_at: '2026-05-16T19:50:32+00:00',
  customer_id: '6a627863-5e96-44e0-8986-0facf8f18fcc',
  dismissed: false,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) {
    return;
  }

  // 1. The verified duplicate — identity guards beyond the primary key so a
  //    drifted row is skipped rather than deleted.
  const row = await knex('google_reviews')
    .where({
      id: DUP_ROW.id,
      google_review_id: DUP_ROW.google_review_id,
      location_id: DUP_ROW.location_id,
      reviewer_name: DUP_ROW.reviewer_name,
    })
    .whereNull('gbp_review_name')
    .first();
  if (!row) {
    // eslint-disable-next-line no-console
    console.log('[review_dup_row_cleanup] duplicate row not found or drifted — skipping delete');
  } else {
    const payout = await knex('review_incentive_payouts')
      .where({ google_review_id: row.id })
      .first();
    if (payout) {
      // eslint-disable-next-line no-console
      console.log(`[review_dup_row_cleanup] SKIPPED dup ${row.id} — referenced by incentive payout ${payout.id}`);
    } else {
      await knex('google_reviews').where({ id: row.id }).del();
      // eslint-disable-next-line no-console
      console.log(`[review_dup_row_cleanup] deleted duplicate review ${row.id} @ ${row.location_id}`);
    }
  }

  // 2. _stats rows the sync can no longer reach
  const staleStats = await knex('google_reviews')
    .where({ reviewer_name: '_stats' })
    .whereRaw("google_review_id != 'places_stats_' || location_id")
    .del();

  // eslint-disable-next-line no-console
  console.log(`[review_dup_row_cleanup] deleted ${staleStats} orphaned _stats row(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) {
    return;
  }
  const exists = await knex('google_reviews').where({ id: DUP_ROW.id }).first();
  if (!exists) {
    await knex('google_reviews').insert({ ...DUP_ROW, synced_at: knex.fn.now() });
  }
};
