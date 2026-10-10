/**
 * Lawn protocol v13 matrix adds, Codex round 6 (PR #6116). Migrations 20261007180000 to 20261007185000 are
 * pushed and frozen; this one fixes their data. Every write is guarded and put back by down().
 *
 *   1. Advion rate. 180000 wrote the rate as 0.034 lb per 1,000 sq ft (1.5 lb per acre, rounded down);
 *      181000 verified the label figure, 0.0344 (1.5 / 43.56). The catalog default rate and both staged
 *      Advion rows (April and October, every track) now carry 0.0344, each only where it still holds 0.034.
 *      The recipe line says 0.0344 too.
 *
 * The plan engine change shipped with this migration (no data here): a recipe line of the visit's own step
 * whose staged row is not a default of its window is not selected. 185000 clears the July 0-0-50 default
 * where 180000 left the July window in its scout form, and the plan used to plan the potash anyway because
 * it selects from the recipe, not from default_in_plan.
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds_round6';
const CATALOG_ACTION = 'v13_matrix_adds_round6_catalog';
const ACTOR = 'migration 20261007186000';
const MIGRATION = '20261007186000_lawn_v13_matrix_adds_round6';
const OLD_RATE = 0.034;
const NEW_RATE = 0.0344;

const isRate = (value, rate) => value != null && Math.abs(Number(value) - rate) < 1e-9;

async function advionRows(knex, protocolId) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId, 'p.product_name': matrix.ADVION })
    .select('p.id', 'p.rate_per_1000');
}

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const rows = (await advionRows(knex, protocol.id)).filter((row) => isRate(row.rate_per_1000, OLD_RATE));
    for (const row of rows) await knex('lawn_protocol_products').where({ id: row.id }).update({ rate_per_1000: NEW_RATE, updated_at: knex.fn.now() });
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['rate_per_1000']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rowIds: rows.map((row) => row.id) }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
  const advion = await knex('products_catalog').where({ name: matrix.ADVION }).first('id', 'default_rate_per_1000');
  if (!advion || !isRate(advion.default_rate_per_1000, OLD_RATE)) return;
  await knex('products_catalog').where({ id: advion.id }).update({ default_rate_per_1000: NEW_RATE, updated_at: knex.fn.now() });
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['default_rate_per_1000']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId: advion.id }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

function parse(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const id of parse(log.after_snapshot).rowIds || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first('rate_per_1000');
      if (row && isRate(row.rate_per_1000, NEW_RATE)) await knex('lawn_protocol_products').where({ id }).update({ rate_per_1000: OLD_RATE, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    const { productId } = parse(log.after_snapshot);
    const row = productId ? await knex('products_catalog').where({ id: productId }).first('default_rate_per_1000') : null;
    if (row && isRate(row.default_rate_per_1000, NEW_RATE)) await knex('products_catalog').where({ id: productId }).update({ default_rate_per_1000: OLD_RATE, updated_at: knex.fn.now() });
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.OLD_RATE = OLD_RATE;
exports.NEW_RATE = NEW_RATE;
