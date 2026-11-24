/**
 * Text-to-book replies (mailer step 2d-3, GATE_MAIL_HOME_TEXT_BOOK): one claim row per reply attempt.
 *
 * services/mail/home-text-to-book.js inserts one under a per-key advisory lock only when no row for the same sender, office
 * line and home is under 24 hours old, and commits it BEFORE the provider call. A sent or uncertain reply keeps its row; a
 * provable non-send deletes it. The key is the home's prospect id, not the text it was sent in: link wrapping can rewrite
 * the link in sms_log.message_body, so the sms_log body cannot witness "already replied". No address, no slug and no full
 * phone is stored (last 10 digits of the sender and of the office line, as the other claim tables keep phones).
 *
 * Idempotent both ways. down() drops the table.
 */
const TABLE = 'mail_home_text_replies';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('phone_digits', 10).notNullable();
    t.string('line_digits', 10).notNullable();
    t.uuid('prospect_id').notNullable().references('id').inTable('mail_prospects').onDelete('CASCADE');
    t.timestamp('claimed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['phone_digits', 'line_digits', 'prospect_id', 'claimed_at'], 'mail_home_text_replies_key_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
