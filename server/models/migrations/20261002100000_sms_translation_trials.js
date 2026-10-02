/**
 * sms_translation_trials — test answers to customer texts written in another
 * language (owner 2026-10-02: "it should answer all foreign languages"). The
 * customer's text is translated to English, the normal drafter answers it with
 * every English check, and the reply is translated back to the customer's
 * language and double-checked. Nothing here is ever sent: the rows are for the
 * owner to read before sending is built. Written only behind
 * GATE_SMS_ANY_LANGUAGE_TRIAL (services/sms-translation.js).
 */

const TABLE = 'sms_translation_trials';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.uuid('sms_log_id').unique();
    t.uuid('customer_id');
    // language name as the model reported it ("Spanish"), and its ISO 639-1 code
    t.string('language', 60);
    t.string('language_code', 12);
    t.text('inbound_original').notNullable();
    t.text('inbound_english');
    t.text('reply_english');
    t.text('reply_translated');
    t.text('back_translation');
    // 'ready' = every check passed; 'held' = a check failed (hold_reason says which); 'skipped' = nothing to answer
    t.string('verdict', 20).notNullable();
    t.string('hold_reason', 80);
    // { converged, passes, token_parity: { missing, added }, meaning: { same, differences } }
    t.jsonb('checks');
    t.string('model', 120);
    t.string('prompt_version', 80);
    t.text('facts_block');
    t.integer('trial_ms');
    t.timestamps(true, true);
    t.index(['created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
