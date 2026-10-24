// Text-thread lead reader (GATE_SMS_LEAD_EXTRACTION, services/sms-lead-extraction.js): one row per
// read of an unknown sender's text thread, keyed by the newest inbound text the read covered. The
// unique key makes a read happen once per thread state across instances; a new text from the same
// number is a new state and may be read again (it fills the lead the earlier read made). status:
// running | lead_created | lead_updated | not_lead | known_customer | existing_lead | spam_screen | failed.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_lead_extractions')) return;
  await knex.schema.createTable('sms_lead_extractions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('phone_last10', 10).notNullable();
    t.uuid('through_sms_log_id').notNullable();
    t.timestamp('through_at').notNullable();
    t.string('status', 20).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.string('kind', 40);
    t.decimal('confidence', 4, 3);
    t.uuid('lead_id');
    t.jsonb('extracted');
    t.string('error', 200);
    t.timestamps(true, true);
    t.unique(['phone_last10', 'through_sms_log_id']);
    t.index(['phone_last10', 'through_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_lead_extractions');
};
