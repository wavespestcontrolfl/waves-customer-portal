/**
 * Last server-observed review-link click. redirected_at is an atomic
 * FIRST-click claim (review-gate stamps it only through WHERE redirected_at
 * IS NULL) and deliberately never moves; repeat clicks previously updated
 * google_review_clicked / open_count without any timestamp. The click
 * auto-link correlates a click against a review's post time, so a customer
 * who opened the link days ago and tapped it again right before posting
 * needs the LATEST click on record (GH codex #3483 r1 P2).
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'last_redirected_at');
  if (!has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.timestamp('last_redirected_at');
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'last_redirected_at');
  if (has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.dropColumn('last_redirected_at');
    });
  }
};
