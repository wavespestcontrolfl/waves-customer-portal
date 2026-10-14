/**
 * Lawn protocol v13 matrix adds: the Advion catalog default rate on the resolved catalog row.
 *
 * 186000 moved the catalog default from 0.034 to the label's 0.0344 lb per 1,000 sq ft, but looked the
 * row up by the exact canonical name. 189500 (pushed and frozen) filled the other facts on a row found
 * only through its alias, not the rate. Here the row is resolved the way 180000 resolved it (normalized
 * name, then alias) and:
 *   - an empty rate unit becomes 'lb';
 *   - an empty default rate, or the old 0.034, becomes 0.0344, only when the unit is (now) lb.
 * A rate in another unit, or any other value, is left alone: it is someone's own number.
 *
 * down() restores a field only while it still holds the value written here, and not at all while a
 * scheduled visit or a completion references a v13 protocol.
 */
const crypto = require('crypto');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');

const ACTION = 'v13_matrix_advion_catalog_rate';
const ACTOR = 'migration 20261007189700';
const MIGRATION = '20261007189700_lawn_v13_matrix_advion_catalog_rate';
const OLD_RATE = 0.034;
const RATE = 0.0344;
const UNIT = 'lb';

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';
const isRate = (value, rate) => value != null && Math.abs(Number(value) - rate) < 1e-9;
const isLb = (value) => ['lb', 'lbs'].includes(normalize(value));

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Exact catalog name (active rows first), else an exact alias: the lookup 180000 used.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

const REQUIRED = ['products_catalog', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const id = await resolveProductId(knex, matrix.ADVION);
  if (!id) return;
  const row = await knex('products_catalog').where({ id }).first('id', 'name', 'default_rate_per_1000', 'rate_unit');
  if (!row) return;
  const fields = {};
  if (isEmpty(row.rate_unit)) fields.rate_unit = { before: row.rate_unit ?? null, after: UNIT };
  const lb = isEmpty(row.rate_unit) || isLb(row.rate_unit);
  if (lb && (isEmpty(row.default_rate_per_1000) || isRate(row.default_rate_per_1000, OLD_RATE))) {
    fields.default_rate_per_1000 = { before: row.default_rate_per_1000 ?? null, after: RATE };
  }
  if (!Object.keys(fields).length) return;
  const update = Object.fromEntries(Object.entries(fields).map(([column, change]) => [column, change.after]));
  await knex('products_catalog').where({ id }).update({ ...update, updated_at: knex.fn.now() });
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(Object.keys(fields)),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ id, name: row.name, fields }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  if (await anyV13ProtocolReferenced(knex)) {
    console.log('[lawn-v13-matrix-advion-catalog-rate] a visit or completion references 2026.10-v13: the catalog rate stays');
    return;
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    const row = after.id ? await knex('products_catalog').where({ id: after.id }).first('id', 'default_rate_per_1000', 'rate_unit') : null;
    const update = {};
    for (const [column, change] of Object.entries(after.fields || {})) {
      const same = column === 'rate_unit' ? row && row.rate_unit === change.after : row && isRate(row[column], change.after);
      if (same) update[column] = change.before;
    }
    if (Object.keys(update).length) await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.RATE = RATE;
exports.UNIT = UNIT;
