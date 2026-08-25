/**
 * Partial indexes for the click-correlation window scan (GH codex #3483 r9):
 * findLikelyReviewers filters on google_review_clicked = true with OR-range
 * predicates over redirected_at / last_redirected_at, and the end-of-sync
 * retro sweep runs it per unlinked review — without these, every hourly sync
 * seq-scans review_requests as outreach history grows. Two partial indexes
 * let PostgreSQL BitmapOr the OR-range.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS review_requests_clicked_redirected_at_idx
      ON review_requests (redirected_at)
      WHERE google_review_clicked IS TRUE
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS review_requests_clicked_last_redirected_at_idx
      ON review_requests (last_redirected_at)
      WHERE google_review_clicked IS TRUE
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS review_requests_clicked_redirected_at_idx');
  await knex.raw('DROP INDEX IF EXISTS review_requests_clicked_last_redirected_at_idx');
};
