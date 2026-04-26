/**
 * Customer-level "already left a Google review" flag, set manually by a CSR
 * from the Customer 360 toggle. When true, the review-request cron skips the
 * customer entirely — no initial request, no 48h followup.
 *
 * Background: ~170 historical customers already left Google reviews through
 * channels we can't reliably auto-match (different name on GBP, review left
 * via the spoke sites, etc). The toggle gives the office a one-click way to
 * stop bothering them.
 */
exports.up = async function (knex) {
  const hasFlag = await knex.schema.hasColumn('customers', 'has_left_google_review');
  if (!hasFlag) {
    await knex.schema.alterTable('customers', (t) => {
      t.boolean('has_left_google_review').notNullable().defaultTo(false);
      t.timestamp('review_marked_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function (knex) {
  const hasFlag = await knex.schema.hasColumn('customers', 'has_left_google_review');
  if (hasFlag) {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('has_left_google_review');
      t.dropColumn('review_marked_at');
    });
  }
};
