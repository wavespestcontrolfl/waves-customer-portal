/**
 * Supersedes two earlier scheduled_emails migrations (pushed, so frozen):
 *  - restore_key (20261022160000) is unused since Cancel send hands the text
 *    back once (restored_at set in the cancel UPDATE): the column is dropped.
 *  - The Scheduled list reads cancelled rows by cancelled_at (newest, last
 *    30 days); 20261022170000's open index does not cover them, so this one
 *    does.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.dropColumn('restore_key');
  });
  await knex.raw(`CREATE INDEX scheduled_emails_cancelled_idx ON scheduled_emails (cancelled_at DESC)
    WHERE status = 'cancelled' AND to_address <> ''`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS scheduled_emails_cancelled_idx');
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.string('restore_key', 64);
  });
};
