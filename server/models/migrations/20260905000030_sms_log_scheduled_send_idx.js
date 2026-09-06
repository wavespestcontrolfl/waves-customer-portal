/**
 * Scheduled-send lookup index for the agent-control run index (S3, Codex r8).
 *
 * The decisions adapter anchors a scheduled decision's active span on the
 * sms_log row queued for it (status 'scheduled' / 'sending', linked through
 * metadata.agent_decision_id or metadata.parked_decision_ids). Queued sends
 * are a handful of rows at any time, so a partial index over exactly that
 * status set turns the correlated lookup into a probe of that handful
 * instead of a scan of the whole SMS history. Additive, IF NOT EXISTS.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_log'))) return;
  await knex.raw("CREATE INDEX IF NOT EXISTS sms_log_scheduled_send_idx ON sms_log (scheduled_for) WHERE status IN ('scheduled', 'sending')");
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS sms_log_scheduled_send_idx');
};
