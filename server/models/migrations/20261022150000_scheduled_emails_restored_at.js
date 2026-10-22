/**
 * scheduled_emails.restored_at — set when the browser confirms that a
 * cancelled email's text is back in the composer (POST
 * /api/admin/email/scheduled/:id/restored). The Scheduled list keeps a
 * cancelled row for a day only while restored_at is null, so a cancel whose
 * answer was lost can still be recovered, but a restored draft cannot be
 * opened a second time and sent twice.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.timestamp('restored_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('scheduled_emails', (t) => {
    t.dropColumn('restored_at');
  });
};
