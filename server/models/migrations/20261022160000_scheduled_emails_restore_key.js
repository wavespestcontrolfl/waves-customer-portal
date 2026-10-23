/**
 * scheduled_emails.restore_key — the browser tab that took a cancelled
 * email's text back. POST /api/admin/email/scheduled/:id/cancel sends a key
 * the tab keeps in sessionStorage; the first cancel stores it in the same
 * UPDATE that cancels the row. A repeat with the same key (a lost answer)
 * gets the draft again; any other key gets 409, so two tabs or two admins can
 * never both receive the same text and send it twice.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.string('restore_key', 64);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.dropColumn('restore_key');
  });
};
