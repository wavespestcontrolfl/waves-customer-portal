/**
 * The LESCO Crosscheck Plus catalog row's service-line tags gain mosquito and termite. Migration 20261119010000 made it the
 * default product of the mosquito services and of Slab Pre-Treat Termite Service; its pest and lawn uses are tagged already
 * (production's row: ["pest","lawn"], read 2026-11-18; 20261119010200 tags a repo-built row the same). Inventory shows the
 * tags, and the admin protocol product search filters by them.
 *
 * A row keeps every tag it has, an office selection included, and gains the missing ones after them. An untagged row is left
 * alone: with no tags the lawn picker goes by the category, and 20261119010200 tags a repo-built row first. The write is
 * guarded by the value read, so a concurrent edit is never overwritten. One audit_log row per catalog row written, with before
 * and after. With no audit_log table or no service_lines column nothing is written. Down is a documented no-op (waves-db: a
 * data fill never reverts on rollback); the audit rows keep every before value.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261119010300_crosscheck_service_line_tags';
const CROSSCHECK = 'LESCO Crosscheck Plus';
const ADDED_LINES = ['mosquito', 'termite'];

// pg hands jsonb back parsed; a json string is read the same way. Anything else is not a tag list.
function tagList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function audit(knex, row, before, after) {
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:tags`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before: { service_lines: before }, after: { service_lines: after } },
    critical: true,
    trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'service_lines'))) return;
  const rows = await knex('products_catalog').where({ name: CROSSCHECK }).select('id', 'name', 'service_lines');
  for (const row of rows) {
    const before = tagList(row.service_lines);
    if (!before) continue;
    const after = [...before, ...ADDED_LINES.filter((line) => !before.includes(line))];
    if (after.length === before.length) continue;
    const updated = await knex('products_catalog').where({ id: row.id, service_lines: JSON.stringify(before) })
      .update({ service_lines: JSON.stringify(after), updated_at: knex.fn.now() });
    if (updated) await audit(knex, row, before, after);
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
