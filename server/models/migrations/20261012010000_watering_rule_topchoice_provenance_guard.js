// Topchoice watering rule: 20261009200000 moved its provenance from 'label' to
// 'owner' on ANY label-sourced water-in rule (codex P1 #6259). That is right
// only for the rule 20261009100000 seeded: its own note says the 0.25 inch
// within 24 hours is the program default, not label text. A rule an admin
// edited or re-verified in between (another amount, deadline, note or
// verification) kept mode 'water_in' and source 'label' and was rewritten too.
// That file is frozen (it was pushed), so this one puts such a rule back.
//
// The evidence is 20261009200000's own audit row: it holds the rule as read
// (`before`) and as written (`after`). When `before` is not the seeded rule,
// key for key, and the row still holds `after` (compare-and-set: an edit made
// since is left alone), the row gets `before` back. One audit row each.
// A database with no audit_log has no such evidence and is left as it is.
const { isDeepStrictEqual } = require('util');
const { recordAuditEvent } = require('../../services/audit-log');
const { WATERING_RULE: SEEDED_RULE } = require('./20261009100000_lawn_v13_fire_ant_granule');

const MIGRATION = '20261012010000_watering_rule_topchoice_provenance_guard';
const REWRITE_ACTION = 'migration:20261009200000_watering_rule_preemergent_label_window:source_owner';

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The rule to put back, or null when the rewrite stands: only the seeded rule
// was a program default recorded as label text.
function ruleToRestore(metadata) {
  const before = metadata && metadata.before;
  const after = metadata && metadata.after;
  if (!isPlainObject(before) || !isPlainObject(after)) return null;
  return isDeepStrictEqual(before, SEEDED_RULE) ? null : { before, after };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;

  const rewrites = await knex('audit_log')
    .where({ action: REWRITE_ACTION, resource_type: 'products_catalog' })
    .select('resource_id', 'metadata');
  for (const rewrite of rewrites) {
    const restore = ruleToRestore(parseJson(rewrite.metadata));
    if (!restore) continue;
    const updated = await knex('products_catalog')
      .whereRaw('id::text = ?', [String(rewrite.resource_id)])
      .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(restore.after)])
      .update({ post_application_watering: JSON.stringify(restore.before), updated_at: knex.fn.now() });
    if (!updated) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:restore_edited_rule`,
      resource_type: 'products_catalog',
      resource_id: String(rewrite.resource_id),
      metadata: { migration: MIGRATION, before: restore.after, after: restore.before },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration never reverts
// on rollback). The audit rows keep every before value.
exports.down = async function down() {};

exports.SEEDED_RULE = SEEDED_RULE;
exports.REWRITE_ACTION = REWRITE_ACTION;
exports.ruleToRestore = ruleToRestore;
