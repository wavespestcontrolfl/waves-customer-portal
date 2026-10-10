/**
 * Lawn protocol v13: three empty chemical groups in the catalog (owner 2026-10-09). Replaces the group half of the earlier cut
 * (20261009175000, re-cut after Codex review of #6233); nothing else is written, and no staged protocol row is touched.
 *
 * Each row is resolved by exact catalog name, else exact alias (active rows first); a row that cannot be resolved is skipped with a log
 * line. A group column is filled ONLY where it is empty (null, '' or blanks), by ONE guarded UPDATE
 * (WHERE id = ? AND (col IS NULL OR btrim(col) = '')), so a value an administrator writes between the read and the write is never overwritten.
 *   Gravex 20 EW (myclobutanil)                                  frac_group '3'   label EPA 91234-283: "MYCLOBUTANIL GROUP 3 FUNGICIDE"
 *   Dylox 6.2 G Granular Insecticide (trichlorfon)               irac_group '1B'  organophosphate
 *   LESCO Dimension 0.21% 18-0-10 ... MOP ... (dithiopyr)        hrac_group '3'   Dimension 2EW label: "a Group 3 herbicide"
 *
 * Column and format. waveguard-approval-engine productGroups() reads moa_group, frac_group, irac_group, hrac_group (and
 * hrac_group_secondary), and the repeat check compares the product's value against the same typed column of the earlier application's catalog
 * row. Every typed column the program's rows already use holds the bare code: Velista frac_group '7' (20260629000001), Headway '3 + 11'
 * (20261007183000), Stonewall hrac_group '3', Acelepryn irac_group '28+3A' (20260430000010). So the bare code goes in the typed column of the
 * label's own system. moa_group (the older free-text "Group 3A" column) is not written: productGroups would read the same group twice and a
 * repeat would raise two findings. Effect: the rotation check now sees these products' groups (a repeat is the existing advisory finding).
 *
 * Idempotent: a second run finds the groups filled and writes nothing. One 'v13_three_groups' audit row records what was filled.
 *
 * down() IS A NO-OP FOR THE CATALOG VALUES, on purpose. up() preserves every value an administrator wrote, and an administrator can confirm or write
 * the very same code after up() ran; equality of the value cannot prove who owns it, so a rollback that cleared a matching value could erase an
 * administrator's data. The groups stay filled (each is a label fact). down() deletes only this migration's own audit row.
 */

const crypto = require('crypto');

const ACTION = 'v13_three_groups';
const ACTOR = 'migration 20261009176000';
const MIGRATION = '20261009176000_lawn_v13_three_chemical_groups';

const GROUPS = [
  { name: 'Gravex 20 EW', column: 'frac_group', value: '3' },
  { name: 'Dylox 6.2 G Granular Insecticide', column: 'irac_group', value: '1B' },
  { name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', column: 'hrac_group', value: '3' },
];

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
  const columns = await knex('products_catalog').columnInfo();
  const changes = [];
  for (const group of GROUPS) {
    if (!(group.column in columns)) continue;
    const productId = await resolveProductId(knex, group.name);
    if (!productId) {
      console.log(`[lawn-v13-three-groups] ${group.name} not found in the catalog: ${group.column} not written`);
      continue;
    }
    // One atomic statement: the emptiness is judged by the same UPDATE that writes, so nothing is overwritten.
    const count = await knex('products_catalog').where({ id: productId })
      .where(function empty() { this.whereNull(group.column).orWhereRaw('btrim(??) = \'\'', [group.column]); })
      .update({ [group.column]: group.value, updated_at: knex.fn.now() });
    if (count) changes.push({ productId, name: group.name, column: group.column, value: group.value });
  }
  if (!changes.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['groups']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ changes }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// No catalog value is touched (see the header); only this migration's own audit row goes.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  await knex('lawn_protocol_audit_log').where({ action: ACTION }).del();
};

exports.ACTION = ACTION;
exports.GROUPS = GROUPS;
