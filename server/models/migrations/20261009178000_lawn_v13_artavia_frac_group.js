/**
 * Lawn protocol v13: Artavia gets its typed fungicide group (Codex round 2 on #6238).
 *
 * Why. The v13 recipe says the app warns on the second Artavia application for Pythium. The rotation check
 * (waveguard-approval-engine) reads a product's groups from the catalog row. 20261005130000 creates Artavia 2 SC (Azoxy)
 * with no group at all, so on a database built from the migrations a second Artavia application raised no warning.
 * (Production holds the older free-text moa_group 'Group 11' on the row, and frac_group empty.) Artavia is azoxystrobin:
 * FRAC Group 11 (label EPA Reg. No. 91234-74). Headway already holds frac_group '3 + 11', so with this value an Artavia
 * application and a Headway application are also seen as the same Group 11 in either order.
 *
 * What this writes. frac_group '11' on Artavia 2 SC (Azoxy), ONLY where the column is empty (null, '' or blanks), by one
 * guarded UPDATE, so a value an administrator wrote is never overwritten. moa_group is left as it is; the engine reports
 * one finding when both columns name the same group. The row is resolved by exact catalog name, else exact alias (active
 * rows first); a row that cannot be resolved is skipped with a log line.
 *
 * Idempotent: a second run finds the group filled and writes nothing. One 'v13_artavia_frac_group' audit row records it.
 *
 * down() IS A NO-OP FOR THE CATALOG VALUE, for the reason 20261009176000 states: an administrator can write the same code after
 * up() ran, and equality cannot prove who owns it. down() deletes only this migration's own audit row.
 */

const crypto = require('crypto');

const ACTION = 'v13_artavia_frac_group';
const ACTOR = 'migration 20261009178000';
const MIGRATION = '20261009178000_lawn_v13_artavia_frac_group';
const GROUP = { name: 'Artavia 2 SC (Azoxy)', column: 'frac_group', value: '11' };

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
    console.log(`[lawn-v13-artavia-frac-group] ${GROUP.name} not found in the catalog: ${GROUP.column} not written`);
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
