/**
 * Email agent hands-off upgrade — three columns on emails:
 *
 *   - list_unsubscribe: parseMessage has extracted the List-Unsubscribe
 *     header since the email portal shipped, but upsertEmail had no column
 *     to store it — so autoUnsubscribe's primary method (the RFC 8058
 *     one-click POST) read undefined and never fired. Persisting it makes
 *     the existing newsletter unsubscribe real and powers the new
 *     legit-bulk unsubscribe on the spam path.
 *   - quarantined_at: spam now gets a 24h quarantine window (label, out of
 *     inbox) instead of an instant trash — the sweep trashes rows whose
 *     quarantined_at has aged past the window.
 *   - draft_gmail_id: the Gmail draft the auto-drafter created for a
 *     customer_request/complaint, so a re-classification can't mint a
 *     second draft on the same email.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (!(await knex.schema.hasColumn('emails', 'list_unsubscribe'))) {
    await knex.schema.alterTable('emails', (t) => t.text('list_unsubscribe'));
  }
  if (!(await knex.schema.hasColumn('emails', 'quarantined_at'))) {
    await knex.schema.alterTable('emails', (t) => t.timestamp('quarantined_at', { useTz: true }));
  }
  if (!(await knex.schema.hasColumn('emails', 'draft_gmail_id'))) {
    await knex.schema.alterTable('emails', (t) => t.text('draft_gmail_id'));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (await knex.schema.hasColumn('emails', 'draft_gmail_id')) {
    await knex.schema.alterTable('emails', (t) => t.dropColumn('draft_gmail_id'));
  }
  if (await knex.schema.hasColumn('emails', 'quarantined_at')) {
    await knex.schema.alterTable('emails', (t) => t.dropColumn('quarantined_at'));
  }
  if (await knex.schema.hasColumn('emails', 'list_unsubscribe')) {
    await knex.schema.alterTable('emails', (t) => t.dropColumn('list_unsubscribe'));
  }
};
