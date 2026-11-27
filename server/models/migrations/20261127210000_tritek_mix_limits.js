// TriTek's tank prohibitions in the mix safety table (pre-push audit, 2026-11-27; every earlier mix safety migration is
// on main and frozen).
//
// The field guide's TriTek card (server/config/tree-shrub-field-guide.json, products.tritek limits) says: "Do not mix
// with NPK foliar fertilizer, sulfur, captan, carbaryl, or dimethoate; check the full incompatibility and timing
// directions." The seed has only TriTek + pyrethroid. This adds:
// 1. group_b CHECK list + 'sulfur', 'captan', 'carbaryl', 'dimethoate' (services/product-mix-rules.js places a product
//    in each by its active ingredient);
// 2. TriTek + spray_fertilizer and TriTek + each of the four = never, each quoting the card line. A row is inserted only
//    when TriTek has no rule for that group yet (an admin's own row is left alone). One critical audit_log event each.
// down() deletes each row only while it holds this migration's values, refuses while an ACTIVE rule still uses a new
// group, and restores the old CHECK list NOT VALID, so a removed (inactive) rule's history stays in the table.

const MIGRATION = '20261127210000_tritek_mix_limits';
const LOG = '[20261127210000]';
const CHECK_NAME = 'product_mix_rules_group_check';
// The list of 20261127200000, then the four new groups.
const GROUPS_BEFORE = Object.freeze(['any', 'fertilizer', 'surfactant', 'oil', 'copper', 'pyrethroid', 'neonic', 'granular', 'herbicide', 'insecticide', 'fungicide', 'spray_fertilizer', 'miticide']);
const NEW_GROUPS = Object.freeze(['sulfur', 'captan', 'carbaryl', 'dimethoate']);
const GROUPS = Object.freeze([...GROUPS_BEFORE, ...NEW_GROUPS]);
// The seed's own name list (20261127143000): exact names in order, then the first as a prefix.
const TRITEK = ['TriTek Spray Oil Emulsion (OMRI)', 'TriTek Spray Oil Emulsion'];
const CARD_LINE = 'Do not mix with NPK foliar fertilizer, sulfur, captan, carbaryl, or dimethoate; check the full incompatibility and timing directions.';
const SOURCE = `server/config/tree-shrub-field-guide.json TriTek 1% limits: "${CARD_LINE}"`;
const RULES = Object.freeze([
  { group_b: 'spray_fertilizer', reason: 'Do not mix TriTek with NPK foliar fertilizer.' },
  { group_b: 'sulfur', reason: 'Do not mix TriTek with sulfur.' },
  { group_b: 'captan', reason: 'Do not mix TriTek with captan.' },
  { group_b: 'carbaryl', reason: 'Do not mix TriTek with carbaryl.' },
  { group_b: 'dimethoate', reason: 'Do not mix TriTek with dimethoate.' },
].map((rule) => Object.freeze({ ...rule, verdict: 'never', source: SOURCE, jar_test_required: false })));

const quoted = (list) => list.map((g) => `'${g}'`).join(', ');

async function setGroupCheck(knex, list, { notValid = false } = {}) {
  await knex.raw(`ALTER TABLE product_mix_rules DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT ${CHECK_NAME} CHECK (group_b IS NULL OR group_b IN (${quoted(list)}))${notValid ? ' NOT VALID' : ''}`);
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  await setGroupCheck(knex, GROUPS);
  if (!(await canWriteRows(knex))) return;
  const tritek = await findProduct(knex, TRITEK);
  if (!tritek) {
    console.log(`${LOG} skipped: ${TRITEK[0]} is not in the catalog`);
    return;
  }
  for (const rule of RULES) {
    // ON CONFLICT DO NOTHING on the one-per-group index: an existing row (an admin's own) is left alone.
    const { rows } = await knex.raw(
      `INSERT INTO product_mix_rules (product_a_id, group_b, verdict, reason, source, jar_test_required, active)
       VALUES (?, ?, ?, ?, ?, ?, true)
       ON CONFLICT (product_a_id, group_b) WHERE group_b IS NOT NULL DO NOTHING
       RETURNING id`,
      [tritek.id, rule.group_b, rule.verdict, rule.reason, rule.source, rule.jar_test_required],
    );
    if (!rows.length) continue;
    await record(knex, 'up', rows[0].id, { product_a: tritek.name, group_b: rule.group_b, verdict: rule.verdict });
    console.log(`${LOG} up: ${tritek.name} + ${rule.group_b} = never`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  if (await canWriteRows(knex)) {
    const tritek = await findProduct(knex, TRITEK);
    for (const rule of tritek ? RULES : []) {
      const removed = await knex('product_mix_rules').where({ product_a_id: tritek.id, ...rule, active: true, version: 1 }).del().returning('id');
      if (removed.length) await record(knex, 'down', (removed[0] && removed[0].id) || removed[0], { product_a: tritek.name, group_b: rule.group_b });
    }
  }
  const left = await knex('product_mix_rules').whereIn('group_b', NEW_GROUPS).andWhere({ active: true }).count('* as n');
  if (Number(left[0].n) > 0) throw new Error(`${LOG} down: ${left[0].n} active rule(s) still use ${NEW_GROUPS.join(', ')}. Remove them first.`);
  // NOT VALID: a removed rule on a new group keeps its row (and history); only new writes must use the old list.
  await setGroupCheck(knex, GROUPS_BEFORE, { notValid: true });
};

exports._MIGRATION = MIGRATION;
exports._GROUPS = GROUPS;
exports._GROUPS_BEFORE = GROUPS_BEFORE;
exports._RULES = RULES;
exports._CARD_LINE = CARD_LINE;
