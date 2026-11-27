// Two product groups for the mix safety table, and the rules that need them (GitHub Codex round 1, 2026-11-27; the
// earlier mix safety migrations are pushed and frozen).
//
// 1. The group_b CHECK list gains 'spray_fertilizer' (a fertilizer that goes in a spray tank: liquid or soluble, not a
//    dry spreader granule) and 'miticide'. services/product-mix-rules.js places products in them.
// 2. The Reliant caution of 20261127190000 quotes "Jar test and small plant test before a mix with foliar fertilizer."
//    (tree-shrub-field-guide.json), so it moves from group 'fertilizer' to 'spray_fertilizer': a spreader granule no
//    longer asks for a jar test. Moved only while the row holds 20261127190000's values and Reliant has no
//    spray_fertilizer row yet.
// 3. Sequestar + group 'miticide' caution, quoting the field guide's Sequestar card: "Never tank-mix with oil. The label
//    also bars mixing it with miticides in foliar sprays on trees." Inserted only when Sequestar has no miticide row.
// Each row write has one critical audit_log event. down() reverses each row only while it holds this migration's
// values, then restores the old CHECK list; it refuses while another row uses a new group.

const MIGRATION = '20261127200000_mix_rules_spray_fert_miticide';
const LOG = '[20261127200000]';
const CHECK_NAME = 'product_mix_rules_group_check';
// The list of 20261127143000, then the two new groups.
const GROUPS_BEFORE = Object.freeze(['any', 'fertilizer', 'surfactant', 'oil', 'copper', 'pyrethroid', 'neonic', 'granular', 'herbicide', 'insecticide', 'fungicide']);
const NEW_GROUPS = Object.freeze(['spray_fertilizer', 'miticide']);
const GROUPS = Object.freeze([...GROUPS_BEFORE, ...NEW_GROUPS]);
// The seed's own name lists (20261127143000): exact names in order, then the first as a prefix.
const RELIANT = ['Reliant Systemic Fungicide', 'Reliant'];
const SEQUESTAR = ['Sequestar 6% Fe EDDHA Soluble Micronutrient', 'Sequestar 6% Fe EDDHA'];
// The row exactly as 20261127190000 wrote it.
const RELIANT_RULE = Object.freeze({
  verdict: 'caution',
  reason: 'Jar test and plant test first.',
  source: 'server/config/tree-shrub-field-guide.json Reliant Systemic Fungicide limits: '
    + '"Do not tank mix with copper. Jar test and small plant test before a mix with foliar fertilizer."',
  jar_test_required: true,
});
const SEQUESTAR_RULE = Object.freeze({
  group_b: 'miticide',
  verdict: 'caution',
  reason: 'Label: no miticide with Sequestar in a foliar spray on trees.',
  source: 'server/config/tree-shrub-field-guide.json Sequestar 6% Fe EDDHA limits: '
    + '"Never tank-mix with oil. The label also bars mixing it with miticides in foliar sprays on trees."',
  jar_test_required: false,
});

const quoted = (list) => list.map((g) => `'${g}'`).join(', ');

async function setGroupCheck(knex, list) {
  await knex.raw(`ALTER TABLE product_mix_rules DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT ${CHECK_NAME} CHECK (group_b IS NULL OR group_b IN (${quoted(list)}))`);
}

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

async function record(knex, step, id, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of an unrecorded change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: 'product_mix_rules', resource_id: String(id),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

async function canWriteRows(knex) {
  for (const table of ['products_catalog', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function moveReliant(knex, from, to, step) {
  const reliant = await findProduct(knex, RELIANT);
  if (!reliant) return;
  if (await knex('product_mix_rules').where({ product_a_id: reliant.id, group_b: to }).first()) {
    console.log(`${LOG} ${step}: ${reliant.name} already has a ${to} rule, kept`);
    return;
  }
  const moved = await knex('product_mix_rules').where({ product_a_id: reliant.id, group_b: from, active: true, ...RELIANT_RULE })
    .update({ group_b: to, updated_at: knex.fn.now(), version: knex.raw('version + 1') }).returning('id');
  if (!moved.length) return;
  await record(knex, `${step}:reliant`, (moved[0] && moved[0].id) || moved[0], { product_a: reliant.name, before: { group_b: from }, after: { group_b: to } });
  console.log(`${LOG} ${step}: ${reliant.name} + ${from} -> ${to}`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  await setGroupCheck(knex, GROUPS);
  if (!(await canWriteRows(knex))) return;
  await moveReliant(knex, 'fertilizer', 'spray_fertilizer', 'up');
  const sequestar = await findProduct(knex, SEQUESTAR);
  if (!sequestar) {
    console.log(`${LOG} skipped: ${SEQUESTAR[0]} is not in the catalog`);
    return;
  }
  // ON CONFLICT DO NOTHING on the one-per-group index: an existing row (an admin's own) is left alone.
  const { rows } = await knex.raw(
    `INSERT INTO product_mix_rules (product_a_id, group_b, verdict, reason, source, jar_test_required, active)
     VALUES (?, ?, ?, ?, ?, ?, true)
     ON CONFLICT (product_a_id, group_b) WHERE group_b IS NOT NULL DO NOTHING
     RETURNING id`,
    [sequestar.id, SEQUESTAR_RULE.group_b, SEQUESTAR_RULE.verdict, SEQUESTAR_RULE.reason, SEQUESTAR_RULE.source, SEQUESTAR_RULE.jar_test_required],
  );
  if (!rows.length) return;
  await record(knex, 'up:sequestar', rows[0].id, { product_a: sequestar.name, group_b: SEQUESTAR_RULE.group_b, verdict: SEQUESTAR_RULE.verdict });
  console.log(`${LOG} up: ${sequestar.name} + miticide group = caution`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  if (await canWriteRows(knex)) {
    const sequestar = await findProduct(knex, SEQUESTAR);
    if (sequestar) {
      const removed = await knex('product_mix_rules').where({ product_a_id: sequestar.id, ...SEQUESTAR_RULE, active: true, version: 1 }).del().returning('id');
      if (removed.length) await record(knex, 'down:sequestar', (removed[0] && removed[0].id) || removed[0], { product_a: sequestar.name, group_b: SEQUESTAR_RULE.group_b });
    }
    await moveReliant(knex, 'spray_fertilizer', 'fertilizer', 'down');
  }
  const left = await knex('product_mix_rules').whereIn('group_b', NEW_GROUPS).count('* as n');
  if (Number(left[0].n) > 0) throw new Error(`${LOG} down: ${left[0].n} rule(s) still use ${NEW_GROUPS.join(' or ')}. Edit or remove them first.`);
  await setGroupCheck(knex, GROUPS_BEFORE);
};

exports._MIGRATION = MIGRATION;
exports._GROUPS = GROUPS;
exports._GROUPS_BEFORE = GROUPS_BEFORE;
exports._RELIANT_RULE = RELIANT_RULE;
exports._SEQUESTAR_RULE = SEQUESTAR_RULE;
