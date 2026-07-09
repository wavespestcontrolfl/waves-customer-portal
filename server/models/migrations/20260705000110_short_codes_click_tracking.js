/**
 * Outbound-comms click tracking, part A.
 *
 * short_codes today keeps only an aggregate click_count + last_click_* on the
 * code row — enough for "did anyone open this", useless for "who clicked WHICH
 * link WHEN" (the signal the clicked-but-didn't-book action queue needs).
 *
 * 1. short_codes gains message-linkage columns so a minted link can say what
 *    outbound message it rode on and which lead it belongs to:
 *      lead_id      — leads back-pointer (customer_id already exists; lead-only
 *                     prospects such as voicemail text-backs had no linkage)
 *      channel      — 'sms' | 'email' | ... (which channel the link went out on)
 *      purpose      — fine-grained mint reason ('estimate_followup_viewed',
 *                     'estimate_send', 'voicemail_quote', 'click_followup', ...)
 *                     — kind stays the coarse classifier
 *      message_ref  — loose 'table:id' pointer to the message row that carried
 *                     the link (e.g. 'message_drafts:<uuid>'), nullable
 *
 * 2. short_code_clicks — one row per HUMAN click (the /l/:code route already
 *    filters bot/preview/scanner UAs before telemetry; see
 *    routes/public-shortlinks.js). click_count on short_codes stays as the
 *    cheap cached aggregate and still gets bumped. ip_hash is a sha256 of the
 *    client IP — enough to distinguish distinct clickers, no raw IP stored.
 */

exports.up = async function up(knex) {
  const cols = await knex('short_codes').columnInfo();
  await knex.schema.alterTable('short_codes', (t) => {
    if (!cols.lead_id) {
      t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
      t.index(['lead_id']);
    }
    if (!cols.channel) t.string('channel', 20);
    if (!cols.purpose) t.string('purpose', 40);
    if (!cols.message_ref) t.string('message_ref', 60);
  });

  if (!(await knex.schema.hasTable('short_code_clicks'))) {
    await knex.schema.createTable('short_code_clicks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('short_code_id').notNullable()
        .references('id').inTable('short_codes').onDelete('CASCADE');
      t.timestamp('clicked_at').notNullable().defaultTo(knex.fn.now());
      // sha256 hex of the client IP — never the raw IP.
      t.string('ip_hash', 64);
      t.text('user_agent');
      t.boolean('is_bot').notNullable().defaultTo(false);
      t.index(['short_code_id']);
      t.index(['clicked_at']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('short_code_clicks');
  const cols = await knex('short_codes').columnInfo();
  await knex.schema.alterTable('short_codes', (t) => {
    if (cols.lead_id) t.dropColumn('lead_id');
    if (cols.channel) t.dropColumn('channel');
    if (cols.purpose) t.dropColumn('purpose');
    if (cols.message_ref) t.dropColumn('message_ref');
  });
};
