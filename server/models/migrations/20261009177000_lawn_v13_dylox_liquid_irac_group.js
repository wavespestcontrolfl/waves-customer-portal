/**
 * Lawn protocol v13: the liquid Dylox gets the same typed insecticide group as the granular Dylox (Codex round 1 on #6238).
 * 20261009176000 is pushed and frozen, so this lives in its own migration.
 *
 * Why. 20261009176000 writes irac_group '1B' on Dylox 6.2 G Granular Insecticide. The catalog's other trichlorfon product,
 * Dylox 420 SL T&O Insecticide, holds the group only in the older free-text column (moa_group 'Group 1B'); its irac_group is
 * empty. waveguard-approval-engine compares a product's value against the SAME typed column of the earlier application's
 * catalog row, so a granular Dylox visit after a liquid Dylox visit (or the reverse) was not seen as a Group 1B repeat.
 *
 * What this writes. irac_group '1B' on Dylox 420 SL T&O Insecticide, ONLY where the column is empty (null, '' or blanks), by
 * one guarded UPDATE, so a value an administrator wrote is never overwritten. moa_group is left as it is: the catalog already
 * has rows with both columns filled (Talstar P 'Group 3A' + '3A', Acelepryn Xtra). The row is resolved by exact catalog name,
 * else exact alias (active rows first); a row that cannot be resolved is skipped with a log line.
 *
 * Idempotent: a second run finds the group filled and writes nothing. One 'v13_dylox_liquid_irac_group' audit row records it.
 *
 * down() IS A NO-OP FOR THE CATALOG VALUE, for the reason 20261009176000 states: an administrator can write the same code after
 * up() ran, and equality cannot prove who owns it. down() deletes only this migration's own audit row.
 */

const crypto = require('crypto');

const ACTION = 'v13_dylox_liquid_irac_group';
const ACTOR = 'migration 20261009177000';
const MIGRATION = '20261009177000_lawn_v13_dylox_liquid_irac_group';
const GROUP = { name: 'Dylox 420 SL T&O Insecticide', column: 'irac_group', value: '1B' };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  if (!(GROUP.column in (await knex('products_catalog').columnInfo()))) return;
  const productId = await resolveProductId(knex, GROUP.name);
  if (!productId) {
    console.log(`[lawn-v13-dylox-liquid-group] ${GROUP.name} not found in the catalog: ${GROUP.column} not written`);
    return;
  }
  // One atomic statement: the emptiness is judged by the same UPDATE that writes, so nothing is overwritten.
  const count = await knex('products_catalog').where({ id: productId })
    .where(function empty() { this.whereNull(GROUP.column).orWhereRaw('btrim(??) = \'\'', [GROUP.column]); })
    .update({ [GROUP.column]: GROUP.value, updated_at: knex.fn.now() });
  if (!count) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['groups']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ changes: [{ productId, ...GROUP }] }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// No catalog value is touched (see the header); only this migration's own audit row goes.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  await knex('lawn_protocol_audit_log').where({ action: ACTION }).del();
};

exports.ACTION = ACTION;
exports.GROUP = GROUP;
