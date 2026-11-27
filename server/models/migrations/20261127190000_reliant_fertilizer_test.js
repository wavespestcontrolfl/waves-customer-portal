// Reliant + fertilizer: jar test and plant test first (pre-push audit, 2026-11-27; the earlier mix safety migrations
// are pushed and frozen).
//
// The tree and shrub field guide's Reliant card (server/config/tree-shrub-field-guide.json, Reliant Systemic Fungicide,
// limits) says: "Do not tank mix with copper. Jar test and small plant test before a mix with foliar fertilizer." The
// seed (20261127143000) has only the copper half. This adds a Reliant + group 'fertilizer' caution with
// jar_test_required, inserted only when Reliant has no fertilizer group row yet (an admin's own row is left alone).
// One critical audit_log event. down() removes the row only while it holds this migration's values.

const MIGRATION = '20261127190000_reliant_fertilizer_test';
const LOG = '[20261127190000]';
// The seed's own name list (20261127143000): exact names in order, then the first as a prefix.
const RELIANT = ['Reliant Systemic Fungicide', 'Reliant'];
const RULE = Object.freeze({
  group_b: 'fertilizer',
  verdict: 'caution',
  reason: 'Jar test and plant test first.',
  source: 'server/config/tree-shrub-field-guide.json Reliant Systemic Fungicide limits: '
    + '"Do not tank mix with copper. Jar test and small plant test before a mix with foliar fertilizer."',
  jar_test_required: true,
});

// Same matching as the seed: an exact active name, else exactly one active name starting with the first entry.
async function findProduct(knex, names) {
  for (const name of names) {
    const rows = await knex('products_catalog').where({ name, active: true }).select('id', 'name');
    if (rows.length === 1) return rows[0];
  }
  const rows = await knex('products_catalog').where('name', 'ilike', `${names[0].replace(/[%_\\]/g, '\\$&')}%`)
    .andWhere({ active: true }).select('id', 'name');
  return rows.length === 1 ? rows[0] : null;
}

async function ready(knex) {
  for (const table of ['products_catalog', 'product_mix_rules', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function record(knex, step, id, product) {
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of an unrecorded change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: 'product_mix_rules', resource_id: String(id),
    metadata: { migration: MIGRATION, product_a: product.name, group_b: RULE.group_b, verdict: RULE.verdict },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await ready(knex))) return;
  const reliant = await findProduct(knex, RELIANT);
  if (!reliant) {
    console.log(`${LOG} skipped: ${RELIANT[0]} is not in the catalog`);
    return;
  }
  const { rows } = await knex.raw(
    `INSERT INTO product_mix_rules (product_a_id, group_b, verdict, reason, source, jar_test_required, active)
     VALUES (?, ?, ?, ?, ?, ?, true)
     ON CONFLICT (product_a_id, group_b) WHERE group_b IS NOT NULL DO NOTHING
     RETURNING id`,
    [reliant.id, RULE.group_b, RULE.verdict, RULE.reason, RULE.source, RULE.jar_test_required],
  );
  if (!rows.length) {
    console.log(`${LOG} up: ${reliant.name} + fertilizer group already has a rule, kept`);
    return;
  }
  await record(knex, 'up', rows[0].id, reliant);
  console.log(`${LOG} up: ${reliant.name} + fertilizer group = caution, jar test`);
};

exports.down = async function down(knex) {
  if (!(await ready(knex))) return;
  const reliant = await findProduct(knex, RELIANT);
  if (!reliant) return;
  const removed = await knex('product_mix_rules')
    .where({ product_a_id: reliant.id, ...RULE, active: true, version: 1 })
    .del().returning('id');
  if (removed.length) await record(knex, 'down', (removed[0] && removed[0].id) || removed[0], reliant);
};

exports._MIGRATION = MIGRATION;
exports._RULE = RULE;
