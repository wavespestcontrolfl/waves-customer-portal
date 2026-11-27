// TriTek's fertilizer prohibition, scoped to NPK, and a rollback chain that runs (pre-push audit, 2026-11-27;
// 20261127210000 is pushed, so this supersedes it instead of editing it).
//
// 1. The group_b CHECK list gains 'npk_spray_fertilizer': a sprayed fertilizer with N, P or K on file (catalog analysis
//    or an N-P-K grade in the name). The TriTek card says "NPK foliar fertilizer", so an iron-only micronutrient is not
//    in it (services/product-mix-rules.js places products).
// 2. The TriTek + spray_fertilizer Never of 20261127210000 moves to npk_spray_fertilizer, only while the row holds that
//    migration's values and TriTek has no npk_spray_fertilizer row yet. One critical audit_log event.
// down() moves the row back the same way (an untouched row back to version 1, see moveTritek) and refuses while an ACTIVE rule uses npk_spray_fertilizer. A removed
// (inactive) rule on npk_spray_fertilizer, or on 20261127210000's groups (sulfur, captan, carbaryl, dimethoate), is
// archived: its whole row goes to a critical audit_log event, then the row is deleted. 20261127210000's down() restores
// its CHECK list NOT VALID and would keep such a row, which 20261127200000's validated CHECK then refuses; archiving
// here first lets the whole chain roll back, and the history stays in audit_log.

const MIGRATION = '20261127220000_tritek_npk_scope';
const LOG = '[20261127220000]';
const CHECK_NAME = 'product_mix_rules_group_check';
// The list of 20261127210000, then the new group.
const GROUPS_BEFORE = Object.freeze(['any', 'fertilizer', 'surfactant', 'oil', 'copper', 'pyrethroid', 'neonic', 'granular', 'herbicide', 'insecticide', 'fungicide', 'spray_fertilizer', 'miticide', 'sulfur', 'captan', 'carbaryl', 'dimethoate']);
const NEW_GROUP = 'npk_spray_fertilizer';
const GROUPS = Object.freeze([...GROUPS_BEFORE, NEW_GROUP]);
// Groups whose removed rules down() archives: this migration's and 20261127210000's.
const ARCHIVE_GROUPS = Object.freeze([NEW_GROUP, 'sulfur', 'captan', 'carbaryl', 'dimethoate']);
// The seed's own name list (20261127143000): exact names in order, then the first as a prefix.
const TRITEK = ['TriTek Spray Oil Emulsion (OMRI)', 'TriTek Spray Oil Emulsion'];
// The row exactly as 20261127210000 wrote it (its group aside).
const CARD_LINE = 'Do not mix with NPK foliar fertilizer, sulfur, captan, carbaryl, or dimethoate; check the full incompatibility and timing directions.';
const TRITEK_RULE = Object.freeze({
  verdict: 'never',
  reason: 'Do not mix TriTek with NPK foliar fertilizer.',
  source: `server/config/tree-shrub-field-guide.json TriTek 1% limits: "${CARD_LINE}"`,
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

async function moveTritek(knex, from, to, step) {
  const tritek = await findProduct(knex, TRITEK);
  if (!tritek) return;
  if (await knex('product_mix_rules').where({ product_a_id: tritek.id, group_b: to }).first()) {
    console.log(`${LOG} ${step}: ${tritek.name} already has a ${to} rule, kept`);
    return;
  }
  const match = { product_a_id: tritek.id, group_b: from, active: true, ...TRITEK_RULE };
  // down(): a row nobody touched since up() (version 2: 20261127210000 wrote 1, up() added 1) goes back exactly as it
  // was, version 1, so 20261127210000's down() (version 1 only) still removes its own seed. A row an admin edited keeps
  // counting up and stays theirs.
  let moved = step === 'down'
    ? await knex('product_mix_rules').where({ ...match, version: 2 }).update({ group_b: to, updated_at: knex.fn.now(), version: 1 }).returning('id')
    : [];
  if (!moved.length) {
    moved = await knex('product_mix_rules').where(match)
      .update({ group_b: to, updated_at: knex.fn.now(), version: knex.raw('version + 1') }).returning('id');
  }
  if (!moved.length) return;
  await record(knex, `${step}:tritek`, (moved[0] && moved[0].id) || moved[0], { product_a: tritek.name, before: { group_b: from }, after: { group_b: to } });
  console.log(`${LOG} ${step}: ${tritek.name} + ${from} -> ${to}`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  await setGroupCheck(knex, GROUPS);
  if (!(await canWriteRows(knex))) return;
  await moveTritek(knex, 'spray_fertilizer', NEW_GROUP, 'up');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  if (await canWriteRows(knex)) await moveTritek(knex, NEW_GROUP, 'spray_fertilizer', 'down');
  const left = await knex('product_mix_rules').where({ group_b: NEW_GROUP, active: true }).count('* as n');
  if (Number(left[0].n) > 0) throw new Error(`${LOG} down: ${left[0].n} active rule(s) still use ${NEW_GROUP}. Remove them first.`);
  const removedRules = await knex('product_mix_rules').whereIn('group_b', ARCHIVE_GROUPS).andWhere({ active: false });
  if (removedRules.length && !(await knex.schema.hasTable('audit_log'))) throw new Error(`${LOG} down: audit_log is missing; removed rules cannot be archived.`);
  for (const row of removedRules) {
    await record(knex, 'down:archive', row.id, { archived_row: row });
    await knex('product_mix_rules').where({ id: row.id, active: false }).del();
  }
  await setGroupCheck(knex, GROUPS_BEFORE);
};

exports._MIGRATION = MIGRATION;
exports._GROUPS = GROUPS;
exports._GROUPS_BEFORE = GROUPS_BEFORE;
exports._TRITEK_RULE = TRITEK_RULE;
exports._CARD_LINE = CARD_LINE;
