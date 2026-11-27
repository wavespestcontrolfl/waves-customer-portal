// Two follow-ups to the mix safety table (pre-push audit, 2026-11-27; both earlier migrations are pushed and frozen).
//
// 1. product_mix_rules.version (integer, NOT NULL, default 1). Every write adds 1 (services/product-mix-rules.js), and
//    an edit or a remove names the version its screen loaded: a different version is a 409. An exact counter, so two
//    writes close together can never pass for one.
// 2. The Certainty + LESCO 90/10 caution fix of 20261127160000 found products by exact name only, while the seed
//    (20261127143000) also took a unique case-insensitive name prefix. When either name resolves only by prefix, this
//    makes the same change here: ok / "Both go in the Celsius weed mix." -> caution / "Card leaves both out in February
//    and June to September". When both resolve by exact name, 20261127160000 already covered the row and this skips it.
//    The row is locked and written only while it holds the seeded values (an admin edit wins, a second run changes
//    nothing); one critical audit_log event. down() reverses that row the same way, then drops the version column.

const MIGRATION = '20261127170000_product_mix_rules_version_and_prefix';
const LOG = '[20261127170000]';
// The seed's own name lists (20261127143000): exact names in order, then the first as a prefix.
const CERTAINTY = ['Certainty Turf Herbicide'];
const NIS = ['LESCO 90/10 Nonionic Surfactant'];
const BEFORE = Object.freeze({ verdict: 'ok', reason: 'Both go in the Celsius weed mix.' });
const AFTER = Object.freeze({ verdict: 'caution', reason: 'Card leaves both out in February and June to September' });

// Same matching as the seed: an exact active name, else exactly one active name starting with the first entry.
async function findProduct(knex, names) {
  for (const name of names) {
    const rows = await knex('products_catalog').where({ name, active: true }).select('id', 'name');
    if (rows.length === 1) return { ...rows[0], byPrefix: false };
  }
  const rows = await knex('products_catalog').where('name', 'ilike', `${names[0].replace(/[%_\\]/g, '\\$&')}%`)
    .andWhere({ active: true }).select('id', 'name');
  return rows.length === 1 ? { ...rows[0], byPrefix: true } : null;
}

async function move(knex, from, to, step) {
  for (const table of ['products_catalog', 'product_mix_rules', 'audit_log']) if (!(await knex.schema.hasTable(table))) return;
  const certainty = await findProduct(knex, CERTAINTY);
  const nis = await findProduct(knex, NIS);
  if (!certainty || !nis) return;
  if (!certainty.byPrefix && !nis.byPrefix) return; // 20261127160000 handles exact names
  const [a, b] = [String(certainty.id), String(nis.id)].sort();
  const row = await knex('product_mix_rules').where({ product_a_id: a, product_b_id: b }).forUpdate().first();
  if (!row) return;
  const patch = { verdict: to.verdict, reason: to.reason, updated_at: knex.fn.now() };
  if (await knex.schema.hasColumn('product_mix_rules', 'version')) patch.version = knex.raw('version + 1');
  const wrote = await knex('product_mix_rules').where({ id: row.id, verdict: from.verdict, reason: from.reason }).update(patch);
  if (!wrote) {
    console.log(`${LOG} ${step}: the row holds ${row.verdict} / "${row.reason}", kept`);
    return;
  }
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of an unrecorded change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: 'product_mix_rules', resource_id: String(row.id),
    metadata: { migration: MIGRATION, products: [certainty.name, nis.name], before: from, after: to },
    critical: true, trx: knex,
  });
  console.log(`${LOG} ${step}: ${certainty.name} + ${nis.name} ${from.verdict} -> ${to.verdict}`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  if (!(await knex.schema.hasColumn('product_mix_rules', 'version'))) {
    await knex.schema.alterTable('product_mix_rules', (t) => { t.integer('version').notNullable().defaultTo(1); });
  }
  await move(knex, BEFORE, AFTER, 'up');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_mix_rules'))) return;
  await move(knex, AFTER, BEFORE, 'down');
  if (await knex.schema.hasColumn('product_mix_rules', 'version')) {
    await knex.schema.alterTable('product_mix_rules', (t) => { t.dropColumn('version'); });
  }
};

exports._MIGRATION = MIGRATION;
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
