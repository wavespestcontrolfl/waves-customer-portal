exports.up = async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_reminder_claim_offset
    ON customer_contract_events (contract_id, ((metadata->>'reminderOffsetDays')))
    WHERE event_type = 'reminder_claimed'
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS uniq_document_reminder_claim_offset');
};
