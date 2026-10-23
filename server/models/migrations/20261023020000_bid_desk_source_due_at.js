/**
 * Bid Desk, PR 2 review fix (pre-push audit on #6489): the deadline SAM.gov last showed for a notice.
 *
 * bid_opportunities.source_due_at  the latest response deadline read from the source (SAM.gov). A republished notice
 *                                  is compared with THIS, not with due_at, so a date the operator typed or confirmed
 *                                  is never re-flagged by an unchanged notice. NULL for email bids.
 *
 * Existing sam_gov rows take their current due_at. down() drops the column.
 */
const BIDS = 'bid_opportunities';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(BIDS, 'source_due_at'))) {
    await knex.schema.alterTable(BIDS, (t) => {
      t.timestamp('source_due_at', { useTz: true }).nullable();
    });
  }
  await knex(BIDS).where({ source: 'sam_gov' }).whereNull('source_due_at').update({ source_due_at: knex.ref('due_at') });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(BIDS, 'source_due_at')) {
    await knex.schema.alterTable(BIDS, (t) => t.dropColumn('source_due_at'));
  }
};
