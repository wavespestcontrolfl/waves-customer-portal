'use strict';

/**
 * Corrects two benefit lines of membership.tier_upgraded (owner-approved
 * 2026-10-08, Codex #6122 r1). 20261008100000 is pushed, so it is frozen and
 * this migration supersedes its copy:
 *   - the recurring line no longer lists services: which services take the
 *     tier percentage is pricing configuration (rodent bait can leave it);
 *   - the one-time line no longer gives examples and says "most": the
 *     pricing engine keeps some one-time services (a roach clean-out among
 *     them) out of the recurring-customer perk.
 *
 * Rewrites the active version only while it still holds exactly the blocks
 * 20261008100000 seeded, so an operator's edit is never overwritten. The
 * template has not been sent: its sender is dark (GATE_IB_TIER_UPGRADE_EMAIL).
 * down() is a documented NO-OP: it would put back copy that is untrue.
 */

const seeded = require('./20261008100000_membership_tier_upgraded_email_template')._private;

const BENEFIT_LINES = [
  '{{recurring_discount_pct}}% off each recurring service in your plan that qualifies for WaveGuard pricing',
  "{{one_time_discount_pct}}% off most one-time services, because you're a recurring customer",
  '{{palm_credit_line}}',
];
const BLOCKS = seeded.TEMPLATE.blocks.map((block) => (block.type === 'list' ? { ...block, items: BENEFIT_LINES } : block));

const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  const template = await knex('email_templates').where({ template_key: seeded.KEY }).first();
  if (!template?.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version || JSON.stringify(parse(version.blocks)) !== JSON.stringify(seeded.TEMPLATE.blocks)) return; // edited: leave it
  await knex('email_template_versions').where({ id: version.id }).update({ blocks: JSON.stringify(BLOCKS), updated_at: new Date() });
  // audit_log is append-only and written through services/audit-log.js.
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.copy_corrected',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: seeded.KEY, versionId: version.id, migration: '20261008110000_membership_tier_upgraded_copy_fix' },
      trx: knex,
      critical: true,
    });
  }
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports._private = { BLOCKS, BENEFIT_LINES };
