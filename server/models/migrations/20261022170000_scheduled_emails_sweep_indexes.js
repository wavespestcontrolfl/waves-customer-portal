/**
 * Partial indexes for the scheduled-email sweeps and list, so their cost
 * follows the live rows, not the ever-growing sent/cancelled history:
 *  - settleStaleClaims: status = 'sending' AND claimed_at < ...
 *  - raiseMissedAlerts and the Scheduled list: the unresolved statuses, and
 *    cancelled rows no tab has confirmed restoring.
 * (scheduled_emails_due_idx already covers the claim query on 'scheduled'.)
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX scheduled_emails_sending_claim_idx ON scheduled_emails (claimed_at) WHERE status = 'sending'`);
  await knex.raw(`CREATE INDEX scheduled_emails_open_idx ON scheduled_emails (send_at)
    WHERE status IN ('scheduled', 'sending', 'failed', 'outcome_unknown') OR (status = 'cancelled' AND restored_at IS NULL)`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS scheduled_emails_open_idx');
  await knex.raw('DROP INDEX IF EXISTS scheduled_emails_sending_claim_idx');
};
