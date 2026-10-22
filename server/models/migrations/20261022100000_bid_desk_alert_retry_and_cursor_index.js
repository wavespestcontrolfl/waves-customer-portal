/**
 * Bid Desk (GATE_BID_DESK), review fixes on PR #6406.
 *
 * bid_opportunity_emails.alert_kind / alerted_at: a bid is filed in its own transaction and the bell is delivered
 * after it commits. alert_kind ('new' | 'addendum') marks an email whose notification is owed; alerted_at is set
 * once it is delivered (or found moot). Each intake tick retries the owed ones, so a notification outage never
 * loses the bid record.
 *
 * emails (created_at, id): the intake cursor reads and orders by this pair every 15 minutes.
 */
const LINKS = 'bid_opportunity_emails';

exports.up = async function up(knex) {
  const hasKind = await knex.schema.hasColumn(LINKS, 'alert_kind');
  if (!hasKind) {
    await knex.schema.alterTable(LINKS, (t) => {
      t.string('alert_kind', 12).nullable();
      t.timestamp('alerted_at', { useTz: true }).nullable();
    });
    await knex.raw(`ALTER TABLE ${LINKS} ADD CONSTRAINT bid_opportunity_emails_alert_kind_check CHECK (alert_kind IS NULL OR alert_kind IN ('new', 'addendum'))`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS bid_opportunity_emails_alert_owed ON ${LINKS} (created_at) WHERE alert_kind IS NOT NULL AND alerted_at IS NULL`);
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS emails_created_at_id ON emails (created_at, id)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS emails_created_at_id');
  await knex.raw('DROP INDEX IF EXISTS bid_opportunity_emails_alert_owed');
  if (await knex.schema.hasColumn(LINKS, 'alert_kind')) {
    await knex.raw(`ALTER TABLE ${LINKS} DROP CONSTRAINT IF EXISTS bid_opportunity_emails_alert_kind_check`);
    await knex.schema.alterTable(LINKS, (t) => {
      t.dropColumn('alert_kind');
      t.dropColumn('alerted_at');
    });
  }
};
