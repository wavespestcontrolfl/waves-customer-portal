// Celsius WG + surfactant: the 90°F label limit, and every catalog surfactant (pre-push audit, 2026-11-27; the
// earlier mix safety migrations are pushed and frozen).
//
// 1. The seeded Celsius WG + LESCO 90/10 caution (20261127143000) gains the job sheet's heat line (services/
//    lawn-weed-mix.js, SURFACTANT_CHECK_NOTE): "Leave the surfactant out if it is 90°F or hotter." Written only while
//    the row holds the seeded reason (an admin edit wins, a second run changes nothing).
// 2. A Celsius WG + group 'surfactant' caution with the same seasonal + 90°F reason, so a surfactant other than
//    LESCO 90/10 gets the same answer. Inserted only when Celsius WG has no surfactant group row yet.
// Each write has one critical audit_log event. down() reverses each one only while the row holds this migration's
// values. 'surfactant' is already in the group_b CHECK list (20261127143000), so no constraint change.

const MIGRATION = '20261127180000_celsius_surfactant_heat';
const LOG = '[20261127180000]';
// The seed's own name lists (20261127143000): exact names in order, then the first as a prefix.
const CELSIUS = ['Celsius WG'];
const NIS = ['LESCO 90/10 Nonionic Surfactant'];
const LAWN = 'server/config/lawn-protocol-v13.json';
const HEAT = 'Leave the surfactant out if it is 90°F or hotter.';
const PAIR_BEFORE = 'Approved weed mix. In February and June to September, spray Celsius alone: no surfactant.';
const PAIR_AFTER = `${PAIR_BEFORE} ${HEAT}`;
const GROUP_RULE = Object.freeze({
  group_b: 'surfactant',
  verdict: 'caution',
  reason: `In February and June to September, spray Celsius alone: no surfactant. ${HEAT}`,
  source: `${LAWN}: "In February and from June through September the weed spot is Celsius alone: no Certainty and no surfactant."; `
    + 'server/services/lawn-weed-mix.js: "Celsius WG label: no adjuvant at 90 F air temperature or above"',
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

async function ready(knex) {
  for (const table of ['products_catalog', 'product_mix_rules', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function rewordPair(knex, celsius, from, to, step) {
  const nis = await findProduct(knex, NIS);
  if (!nis || String(nis.id) === String(celsius.id)) return;
  const [a, b] = [String(celsius.id), String(nis.id)].sort();
  const row = await knex('product_mix_rules').where({ product_a_id: a, product_b_id: b }).forUpdate().first();
  if (!row) return;
  const wrote = await knex('product_mix_rules').where({ id: row.id, reason: from })
    .update({ reason: to, updated_at: knex.fn.now(), version: knex.raw('version + 1') });
  if (!wrote) {
    console.log(`${LOG} ${step}: ${celsius.name} + ${nis.name} holds "${row.reason}", kept`);
    return;
  }
  await record(knex, `${step}:pair`, row.id, { products: [celsius.name, nis.name], before: { reason: from }, after: { reason: to } });
  console.log(`${LOG} ${step}: ${celsius.name} + ${nis.name} reason updated`);
}

exports.up = async function up(knex) {
  if (!(await ready(knex))) return;
  const celsius = await findProduct(knex, CELSIUS);
  if (!celsius) {
    console.log(`${LOG} skipped: ${CELSIUS[0]} is not in the catalog`);
    return;
  }
  await rewordPair(knex, celsius, PAIR_BEFORE, PAIR_AFTER, 'up');
  // ON CONFLICT DO NOTHING on the one-per-group index: an existing row (an admin's own) is left alone.
  const { rows } = await knex.raw(
    `INSERT INTO product_mix_rules (product_a_id, group_b, verdict, reason, source, jar_test_required, active)
     VALUES (?, ?, ?, ?, ?, false, true)
     ON CONFLICT (product_a_id, group_b) WHERE group_b IS NOT NULL DO NOTHING
     RETURNING id`,
    [celsius.id, GROUP_RULE.group_b, GROUP_RULE.verdict, GROUP_RULE.reason, GROUP_RULE.source],
  );
  if (!rows.length) {
    console.log(`${LOG} up: ${celsius.name} + surfactant group already has a rule, kept`);
    return;
  }
  await record(knex, 'up:group', rows[0].id, { product_a: celsius.name, group_b: GROUP_RULE.group_b, verdict: GROUP_RULE.verdict });
  console.log(`${LOG} up: ${celsius.name} + surfactant group = caution`);
};

exports.down = async function down(knex) {
  if (!(await ready(knex))) return;
  const celsius = await findProduct(knex, CELSIUS);
  if (!celsius) return;
  await rewordPair(knex, celsius, PAIR_AFTER, PAIR_BEFORE, 'down');
  // Only the row exactly as this migration wrote it; an edited or removed row stays.
  const removed = await knex('product_mix_rules')
    .where({ product_a_id: celsius.id, group_b: GROUP_RULE.group_b, verdict: GROUP_RULE.verdict, reason: GROUP_RULE.reason, source: GROUP_RULE.source, active: true, version: 1 })
    .del().returning('id');
  if (removed.length) await record(knex, 'down:group', (removed[0] && removed[0].id) || removed[0], { product_a: celsius.name, group_b: GROUP_RULE.group_b });
};

exports._MIGRATION = MIGRATION;
exports._HEAT = HEAT;
exports._PAIR_BEFORE = PAIR_BEFORE;
exports._PAIR_AFTER = PAIR_AFTER;
exports._GROUP_RULE = GROUP_RULE;
