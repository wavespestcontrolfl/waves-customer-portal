// Certainty + LESCO 90/10 surfactant was seeded "ok" by 20261127143000_product_mix_rules (frozen once pushed). The card
// it cites (server/config/lawn-protocol-v13.json) puts both in the Celsius weed mix and leaves both out in February and
// June to September ("In February and from June through September the weed spot is Celsius alone: no Certainty and no
// surfactant."), so a year-round Yes was wrong. This makes the row "caution" with that reason (pre-push audit,
// 2026-11-27).
//
// The row is locked (FOR UPDATE) and written only while it still holds the seeded values: the checked values are in
// the UPDATE's own WHERE, so an admin edit made first wins and a second run changes nothing. One critical audit_log
// event records the before and after. down() reverses it the same way (only while the row holds this migration's
// values), with its own audit event.

const MIGRATION = '20261127160000_product_mix_rules_certainty_nis_caution';
const LOG = '[20261127160000]';
const CERTAINTY = 'Certainty Turf Herbicide';
const NIS = 'LESCO 90/10 Nonionic Surfactant';
const BEFORE = Object.freeze({ verdict: 'ok', reason: 'Both go in the Celsius weed mix.' });
const AFTER = Object.freeze({ verdict: 'caution', reason: 'Card leaves both out in February and June to September' });

async function pairRow(knex) {
  for (const table of ['products_catalog', 'product_mix_rules', 'audit_log']) if (!(await knex.schema.hasTable(table))) return null;
  const products = await knex('products_catalog').whereIn('name', [CERTAINTY, NIS]).andWhere({ active: true }).select('id', 'name');
  const certainty = products.filter((p) => p.name === CERTAINTY);
  const nis = products.filter((p) => p.name === NIS);
  if (certainty.length !== 1 || nis.length !== 1) {
    console.log(`${LOG} ${certainty.length} "${CERTAINTY}" and ${nis.length} "${NIS}" active row(s): nothing changed`);
    return null;
  }
  const [a, b] = [String(certainty[0].id), String(nis[0].id)].sort();
  return knex('product_mix_rules').where({ product_a_id: a, product_b_id: b }).forUpdate().first();
}

async function move(knex, from, to, step) {
  const row = await pairRow(knex);
  if (!row) return;
  const wrote = await knex('product_mix_rules')
    .where({ id: row.id, verdict: from.verdict, reason: from.reason })
    .update({ verdict: to.verdict, reason: to.reason, updated_at: knex.fn.now() });
  if (!wrote) {
    console.log(`${LOG} ${step}: the row holds ${row.verdict} / "${row.reason}", kept`);
    return;
  }
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of an unrecorded change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: 'product_mix_rules', resource_id: String(row.id),
    metadata: { migration: MIGRATION, products: [CERTAINTY, NIS], before: from, after: to },
    critical: true, trx: knex,
  });
  console.log(`${LOG} ${step}: ${from.verdict} -> ${to.verdict}`);
}

exports.up = async function up(knex) { await move(knex, BEFORE, AFTER, 'up'); };
exports.down = async function down(knex) { await move(knex, AFTER, BEFORE, 'down'); };

exports._MIGRATION = MIGRATION;
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
