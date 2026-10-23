/**
 * Bid Desk, PR 2 review fix (Codex #6489 r2): whether SAM.gov still lists a notice as active.
 *
 * bid_opportunities.source_active  the notice's `active` flag as last read from SAM.gov (true / false); NULL for email
 *                                  bids. A notice that turns inactive flags its open bid for review once (reminders
 *                                  pause), compared with this column so an unchanged archived notice never re-flags.
 *
 * Existing sam_gov rows were filed active. down() drops the column.
 */
const BIDS = 'bid_opportunities';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(BIDS, 'source_active'))) {
    await knex.schema.alterTable(BIDS, (t) => {
      t.boolean('source_active').nullable();
    });
  }
  await knex(BIDS).where({ source: 'sam_gov' }).whereNull('source_active').update({ source_active: true });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(BIDS, 'source_active')) {
    await knex.schema.alterTable(BIDS, (t) => t.dropColumn('source_active'));
  }
};
