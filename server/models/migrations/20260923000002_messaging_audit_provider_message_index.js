// Needs-response SMS state joins accepted provider sends back to their audit
// metadata (notably messaging_audit_log.metadata.draft_id). The audit table did not
// previously index provider_message_id, which would make the 30-second badge
// poll scan the complete audit history once per SMS event.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('messaging_audit_log')) return;
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS messaging_audit_provider_message_id_idx
      ON messaging_audit_log (provider_message_id)
      WHERE provider_message_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('messaging_audit_log')) return;
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_provider_message_id_idx');
};
