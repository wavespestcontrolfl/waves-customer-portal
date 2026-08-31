/**
 * review_requests.claimed_at — the composer send seam's pre-provider claim
 * stamp (services/review-request.js claimInlineForSend / releaseInlineClaim).
 *
 * The claim is a conditional UPDATE pending→sending; this column records
 * WHEN, so a claim orphaned by a crash can be told apart from a live one
 * (stale after 10 minutes) and reconciled against sms_log / the provider.
 * A dedicated column because production review_requests was created by
 * 20260401000068 WITHOUT updated_at, and the compat migration never adds
 * timestamps to an existing table.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'claimed_at');
  if (!has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.timestamp('claimed_at');
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'claimed_at');
  if (has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.dropColumn('claimed_at');
    });
  }
};
