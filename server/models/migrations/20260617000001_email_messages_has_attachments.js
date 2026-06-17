/**
 * Track whether an email send carried attachments.
 *
 * Tracked template sends (invoice PDFs, service-report PDFs) include binary
 * attachments that are NOT persisted in the email_messages snapshot (only
 * subject/html/text are). The bounce-recovery replay can faithfully reproduce
 * the body but not the attachment, so it must skip auto-recovery for
 * attachment-bearing messages and route them to manual recovery instead. This
 * flag lets the recovery path detect that case without storing the binaries.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.boolean('has_attachments').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.dropColumn('has_attachments');
  });
};
