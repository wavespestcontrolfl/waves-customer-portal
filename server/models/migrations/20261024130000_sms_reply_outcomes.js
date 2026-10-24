// Customer reaction after each Waves text reply (GATE_SMS_REPLY_OUTCOMES, services/sms-reply-outcomes.js).
// One row per outbound reply (reply_sms_log_id is unique, so a reply is measured once across
// instances). The row says what the customer did next, not what the reply said: no message text
// is stored. status: computed | not_a_reply (an outbound of a reply type with no customer text
// before it, kept so the sweep does not pick it again). Measurement only: nothing here sends,
// changes or holds a message.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_reply_outcomes')) return;
  await knex.schema.createTable('sms_reply_outcomes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('reply_sms_log_id').notNullable();
    t.uuid('replied_to_sms_log_id');
    t.uuid('customer_id');
    t.string('phone_last10', 10).notNullable();
    // sms_log.message_type of the reply: manual | ai_approved | ai_revised | ai_autosent | ai_gratitude
    t.string('reply_source', 64).notNullable();
    t.timestamp('reply_at').notNullable();
    // AI draft behind the reply (sms_log.metadata.draft_id, or agent_decisions.entity_id for an auto-send)
    t.uuid('draft_id');
    t.string('prompt_version', 60);
    t.string('status', 20).notNullable().defaultTo('computed');
    t.timestamp('first_inbound_at');
    t.integer('first_inbound_seconds');
    t.boolean('confused').notNullable().defaultTo(false);
    t.string('confusion_reason', 24); // confusion_phrase | repeat
    t.boolean('opted_out').notNullable().defaultTo(false);
    t.boolean('called_back').notNullable().defaultTo(false);
    t.boolean('positive_close').notNullable().defaultTo(false);
    t.boolean('silent').notNullable().defaultTo(false);
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);
    t.unique(['reply_sms_log_id']);
    t.index(['reply_at']);
    t.index(['prompt_version', 'reply_source']);
    t.index(['customer_id']);
  });
  await knex.raw(
    "ALTER TABLE sms_reply_outcomes ADD CONSTRAINT sms_reply_outcomes_status_check CHECK (status IN ('computed','not_a_reply'))"
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_reply_outcomes');
};
