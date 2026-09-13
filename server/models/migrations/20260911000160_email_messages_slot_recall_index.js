// no-show-detector.js's candidate recall now also reads email_messages
// directly — the durable row loadPromiseEvents falls back to when the
// best-effort interaction insert failed — matched on the slot its
// idempotency key encodes (codex P1, PR #4403 round 20). Index that
// expression so the recall stays a bounded range scan; partial on the
// per-service key shape, which is the only one carrying a slot.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_slot_recall_idx
    ON email_messages (((split_part(idempotency_key, ':', 3))::bigint))
    WHERE split_part(idempotency_key, ':', 3) ~ '^[0-9]+$'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_slot_recall_idx');
};
