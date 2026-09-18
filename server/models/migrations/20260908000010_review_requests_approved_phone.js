/**
 * review_requests.approved_phone — the recipient an operator-confirmed card
 * approved for this ask (codex #4156 r3 P1).
 *
 * An Intelligence Bar send pins its recipient (expectedPhone) for the
 * in-process attempt; the 3-day rule can now hold that same row for up to
 * 72 hours, after which processScheduled re-sends it with no pin. Persisting
 * the approved number lets every retry of a pinned row re-apply the drift
 * check, so a recipient changed during the hold is refused, never texted.
 * Nullable — every existing row is null and stays unpinned.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;
  if (await knex.schema.hasColumn('review_requests', 'approved_phone')) return;
  await knex.schema.alterTable('review_requests', (t) => {
    t.string('approved_phone', 32);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;
  if (!(await knex.schema.hasColumn('review_requests', 'approved_phone'))) return;
  await knex.schema.alterTable('review_requests', (t) => {
    t.dropColumn('approved_phone');
  });
};
