/**
 * newsletter_subscribers.reader_confirmed_at / reader_confirmed_email: proof that the
 * READER clicked the confirm link, and for which address.
 *
 * confirmed_at and confirmation_sent_at are not that proof. A trusted add (admin, quote
 * wizard, call pipeline) promotes a pending row to active and stamps confirmed_at with no
 * click, and the email fanout moves an active row to a corrected address and keeps both
 * stamps. Waves Pest Insider's "A tool we'd use" block carries an Amazon link, which
 * Amazon allows only to readers who opted in (owner 2026-11-22), so it needs evidence
 * written by the reader's click alone and bound to the address:
 *   - reader_confirmed_at     timestamptz, set by confirmByToken and confirmResignupToken
 *                             (newsletter-subscribers.js) and by nothing else;
 *   - reader_confirmed_email  the row's address, lowercased, at that click.
 *
 * NO BACKFILL, on purpose: history cannot tell a reader's click from a trusted add (the
 * Beehiiv import rows and every trusted add carry confirmed_at too). Every row starts
 * with both NULL, so no reader has the proof the day this ships; a reader gains it by
 * confirming through a link from then on.
 *
 * Additive and idempotent (hasColumn guards). down drops both columns.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (!(await knex.schema.hasColumn('newsletter_subscribers', 'reader_confirmed_at'))) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.timestamp('reader_confirmed_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('newsletter_subscribers', 'reader_confirmed_email'))) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.text('reader_confirmed_email').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  for (const column of ['reader_confirmed_at', 'reader_confirmed_email']) {
    if (await knex.schema.hasColumn('newsletter_subscribers', column)) {
      await knex.schema.alterTable('newsletter_subscribers', (t) => { t.dropColumn(column); });
    }
  }
};
