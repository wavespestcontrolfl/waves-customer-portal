// Missed-call bell (owner ruling 2026-08-28): the durable sweep re-offers
// unanswered customer calls from the last 24h that carry no
// metadata.missed_call_settled_at. Every call that predates the feature
// lacks it, so the first deploy would ring a burst of stale bells for calls
// already handled by hand. Settle the pre-rollout window (mirrors
// 20260828000040/42 for the email lane).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'metadata'))) return;
  await knex('call_log')
    .where({ direction: 'inbound' })
    .where('created_at', '>', knex.raw("now() - interval '48 hours'"))
    .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
    .update({
      metadata: knex.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('missed_call_settled_at', ?::text, 'missed_call_settled_reason', 'pre_rollout')", [new Date().toISOString()]),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'metadata'))) return;
  await knex('call_log')
    .whereRaw("metadata->>'missed_call_settled_reason' = 'pre_rollout'")
    .update({ metadata: knex.raw("metadata - 'missed_call_settled_at' - 'missed_call_settled_reason'") });
};
