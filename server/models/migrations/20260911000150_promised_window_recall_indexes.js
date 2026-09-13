// no-show-detector.js recalls candidates by the PROMISED WINDOW, not by how
// recently the notice was sent: a confirmation for a visit booked months ahead
// is the only communication that visit may ever get, and a send-time cutoff
// dropped exactly the long-lead-confirmation-plus-uncommunicated-move case the
// promise-based candidate path exists for (codex P1, PR #4403 round 19).
// These index the rendered slot each evidence table carries, so the recall
// stays a bounded range scan.
//
// Supersedes the send-time indexes 20260911000140 added, which nothing reads
// any more; that file has already run on the preview database, so it is left
// alone and its indexes are dropped here.
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_recent_appointment_idx');
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_email_recent_idx');
  await knex.raw(`CREATE INDEX IF NOT EXISTS messaging_audit_rendered_slot_idx
    ON messaging_audit_log (((metadata->>'rendered_slot_ms')::bigint))
    WHERE metadata->>'rendered_slot_ms' IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customer_interactions_rendered_slot_idx
    ON customer_interactions (((metadata->>'rendered_slot_ms')::bigint))
    WHERE interaction_type = 'email_outbound' AND metadata->>'rendered_slot_ms' IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS audit_log_promised_start_idx
    ON audit_log ((metadata->>'start_at'))
    WHERE action = 'visit_window_promised'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS audit_log_promised_start_idx');
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_rendered_slot_idx');
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_rendered_slot_idx');
};
