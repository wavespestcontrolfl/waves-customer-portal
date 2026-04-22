/**
 * Persist the AI-generated review draft on the review_requests row so we can
 * audit variation across customers and iterate on the prompt over time.
 *
 *   generated_review_text — the draft body Claude returned (≤ ~500 chars)
 *   generated_at          — when it was generated; null until first
 *                           generate-review call
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('review_requests', (t) => {
    t.text('generated_review_text');
    t.timestamp('generated_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('review_requests', (t) => {
    t.dropColumn('generated_review_text');
    t.dropColumn('generated_at');
  });
};
