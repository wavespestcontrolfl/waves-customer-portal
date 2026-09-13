// no-show-detector.js's email promise-evidence join links interactions
// written before metadata.email_message_id existed through the immutable
// email_messages.idempotency_key, matched on its
// `<event_type>:<scheduled_service_id>:` prefix. The table's existing unique
// index on that column cannot serve a LIKE 'prefix%' search unless the
// database collation is C, so add the pattern-ops index that can — otherwise
// the five-minute sweep falls back to a sequential scan of message history.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_idempotency_prefix_idx
    ON email_messages (idempotency_key varchar_pattern_ops) WHERE idempotency_key IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_idempotency_prefix_idx');
};
