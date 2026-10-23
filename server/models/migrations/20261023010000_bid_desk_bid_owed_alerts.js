/**
 * Bid Desk, PR 2 review fix (Codex #6489 r1): a notification owed on a bid with no email (a SAM.gov notice).
 *
 * Email bids record an owed bell on their bid_opportunity_emails row (alert_kind / alerted_at). A SAM.gov bid has no
 * email row, so the owed bell lives on the bid itself and the same 15-minute sweep (deliverOwedAlerts) delivers it:
 *
 * bid_opportunities.owed_alert_kind  'new' (a new bid) | 'addendum' (SAM.gov posted a different deadline); NULL = none
 * bid_opportunities.owed_alert_key   the admin-alert dedupe key the bell rings under
 *
 * down() drops only what up() added.
 */
const BIDS = 'bid_opportunities';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(BIDS, 'owed_alert_kind'))) {
    await knex.schema.alterTable(BIDS, (t) => {
      t.string('owed_alert_kind', 12).nullable();
      t.text('owed_alert_key').nullable();
    });
    await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_owed_alert_kind_check CHECK (owed_alert_kind IS NULL OR owed_alert_kind IN ('new', 'addendum'))`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS bid_opportunities_owed_alert ON ${BIDS} (updated_at) WHERE owed_alert_kind IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS bid_opportunities_owed_alert');
  if (await knex.schema.hasColumn(BIDS, 'owed_alert_kind')) {
    await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_owed_alert_kind_check`);
    await knex.schema.alterTable(BIDS, (t) => {
      t.dropColumn('owed_alert_kind');
      t.dropColumn('owed_alert_key');
    });
  }
};
