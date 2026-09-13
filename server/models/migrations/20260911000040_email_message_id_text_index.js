// no-show-detector.js's email promise-evidence read joins email_messages on
// the STABLE primary key carried in customer_interactions.metadata (the
// provider id is cleared/replaced by every transactional retry claim, so a
// provider-id join loses the row's live delivery state — codex P1, PR #4403).
// The JSON side is text and email_messages.id is uuid, so the join predicate
// is `em.id::text = (ci.metadata->>'email_message_id')`; casting the JSON
// value to uuid instead would throw on any malformed legacy value. A cast on
// the indexed column disables the primary key index, so index the expression
// the join actually uses — the sweep runs this read every 5 minutes per
// candidate once GATE_NOSHOW_DETECTOR is on, and without this it is a
// sequential scan of all message history each time.
//
// Separate file from 20260911000030 for the same reason that one is separate
// from 20260911000020: knex tracks migrations by filename, so editing a file
// the PR preview database has already run is a silent no-op.
exports.up = async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS email_messages_id_text_idx ON email_messages ((id::text))');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_id_text_idx');
};
