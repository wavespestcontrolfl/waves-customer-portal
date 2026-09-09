/** Record the additive catalog policies seeded by 000010, which has already
 * run in development. No service defaults or appointment windows change. */
const ACTION = 'service_catalog.scheduling_policy_seed';
const ROLLBACK_ACTION = 'service_catalog.scheduling_policy_seed_rollback';
const TAG = 'migration:20260909000020';
const { recordAuditEvent } = require('../../services/audit-log');

exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('services') || !await knex.schema.hasTable('audit_log')) return;
  if (!await knex.schema.hasColumn('services', 'scheduling_duration_policy')) return;
  const rows = await knex('services').whereRaw("scheduling_duration_policy->>'source' = ?", ['owner_2026_09_09'])
    .whereNotExists(function alreadyAudited() {
      this.select(knex.raw('1')).from('audit_log').whereRaw('audit_log.resource_id = services.id')
        .where({ action: ACTION }).whereRaw("metadata->>'migration' = ?", [TAG]);
    }).select('id', 'scheduling_duration_policy');
  for (const row of rows) {
    await recordAuditEvent({ actor_type: 'system', action: ACTION,
      resource_type: 'service', resource_id: row.id,
      metadata: { migration: TAG, changed_fields: ['scheduling_duration_policy'],
        policy: row.scheduling_duration_policy, default_gate: 'off' }, critical: true, trx: knex });
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('audit_log')) return;
  // Audit history is append-only. This migration never owns the policy
  // itself, so rollback records its disposition without changing catalog data.
  const rows = await knex('audit_log').where({ action: ACTION })
    .whereRaw("metadata->>'migration' = ?", [TAG]).select('resource_id');
  for (const row of rows) {
    const recorded = await knex('audit_log').where({ action: ROLLBACK_ACTION, resource_id: row.resource_id })
      .whereRaw("metadata->>'migration' = ?", [TAG]).first('id');
    if (recorded) continue;
    await recordAuditEvent({ actor_type: 'system', action: ROLLBACK_ACTION,
      resource_type: 'service', resource_id: row.resource_id,
      metadata: { migration: TAG, policy_preserved: true }, critical: true, trx: knex });
  }
};
