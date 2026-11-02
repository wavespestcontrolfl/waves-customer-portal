// Spam tag for SMS senders (owner 2026-11-02, "mark spam, no alerts, never
// remove customer texts"), dark behind GATE_SMS_SPAM_TAG.
//
//   sms_spam_senders  one row per phone the office tagged as spam from the
//                     Messages inbox. Unlike blocked_numbers (whose rows make
//                     the Twilio webhook drop a number's texts before anything
//                     is logged), a row here drops nothing: the webhook keeps
//                     and shows every text and only stamps it with a manual
//                     spam verdict, marked read, with no alert, lead or
//                     auto-reply (services/sms-spam-tag.js).
//
//   phone      E.164, as the block route stores it (utils/phone.js
//              normalizePhone). Lookups match by phone identity (a NANP
//              number by its last 10 digits, any other country code by its
//              full digits), so a stored format difference cannot hide a row.
//   marked_by  the admin user who tagged it; no foreign key, so removing a
//              user never blocks and never silently deletes a tag.
//   source     where the tag came from; 'inbox' for the Messages button.
//
// No data is written here; the table starts empty.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_spam_senders')) return;
  await knex.schema.createTable('sms_spam_senders', (t) => {
    t.string('phone', 20).primary();
    t.uuid('marked_by').nullable();
    t.timestamp('marked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('reason').nullable();
    t.string('source', 24).notNullable().defaultTo('inbox');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_spam_senders');
};
