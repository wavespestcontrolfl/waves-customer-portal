/**
 * Mark 13 reviews as replied — these were responded to directly on Google
 * (not via the portal), so the portal "No Portal Reply" queue was showing
 * them as still needing a reply. Setting review_reply collapses them into
 * the "responded" bucket so stats reflect reality (170 of 172 replied).
 *
 * Match by (reviewer_name, location_id) — google_review_id isn't reliably
 * populated for older rows, but the name+location pair is unique here.
 *
 * down() restores NULL so rollback puts them back in the queue.
 */

const REPLIED_VIA_GOOGLE = 'Replied via Google directly';

const REVIEWS = [
  { name: 'Jackie Lopez', location: 'parrish' },
  { name: 'Manuel Fruto', location: 'parrish' },
  { name: 'Will Bobbitt', location: 'sarasota' },
  { name: 'Marvin Massenburg', location: 'sarasota' },
  { name: 'Frances Droege', location: 'parrish' },
  { name: 'Becky Kelly', location: 'parrish' },
  { name: 'George N', location: 'lakewood-ranch' },
  { name: 'david serrano', location: 'lakewood-ranch' },
  { name: 'Marie DiStefano', location: 'lakewood-ranch' },
  { name: 'courtney jnbaptiste', location: 'sarasota' },
  { name: 'Victoria Afanasiev', location: 'sarasota' },
  { name: 'Jack Lavin', location: 'sarasota' },
  { name: 'Madison Moburg', location: 'lakewood-ranch' },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) {
    return;
  }
  let updated = 0;
  for (const r of REVIEWS) {
    const count = await knex('google_reviews')
      .whereRaw('LOWER(reviewer_name) = LOWER(?)', [r.name])
      .where({ location_id: r.location })
      .whereNull('review_reply')
      .update({
        review_reply: REPLIED_VIA_GOOGLE,
        reply_updated_at: knex.fn.now(),
      });
    updated += count;
  }
  // eslint-disable-next-line no-console
  console.log(`[mark_externally_replied_reviews] updated ${updated} row(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) {
    return;
  }
  for (const r of REVIEWS) {
    await knex('google_reviews')
      .whereRaw('LOWER(reviewer_name) = LOWER(?)', [r.name])
      .where({ location_id: r.location })
      .where({ review_reply: REPLIED_VIA_GOOGLE })
      .update({ review_reply: null, reply_updated_at: null });
  }
};
