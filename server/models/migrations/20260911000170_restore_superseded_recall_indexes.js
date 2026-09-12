// Rollback completeness for the recall indexes, as a NEW file because
// 20260911000150 has already run on the PR preview database (.claude/skills/
// waves-db/SKILL.md §4).
//
// 20260911000150's up() dropped the send-time indexes 20260911000140 created
// and replaced them with promised-window ones, but its down() removed only
// the replacements — rolling back that one migration alone left a schema
// supporting neither lookup (codex P2, PR #4403 round 20). This migration's
// own down() restores the send-time pair, so unwinding the stack from here
// always lands on a schema that serves whichever implementation is current.
exports.up = async function up() {
  // Nothing to do forward: 20260911000150 already built the current shape.
};

exports.down = async function down(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS messaging_audit_recent_appointment_idx
    ON messaging_audit_log (sent_at)
    WHERE appointment_id IS NOT NULL OR metadata->>'scheduled_service_id' IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customer_interactions_email_recent_idx
    ON customer_interactions (created_at) WHERE interaction_type = 'email_outbound'`);
};
