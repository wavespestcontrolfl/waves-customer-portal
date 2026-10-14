/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: prodiamine yearly caps at the
 * label's own annual maximum (Codex round 3 on #5998). Migration 20261006140000 is
 * pushed and frozen; it derived each cap from the 1.5 lb ai/acre label cap and the
 * product's strength, which rounds a little ABOVE the annual maximum the catalog already
 * holds for two products (65 WDG 0.8476 vs the label's 0.83 oz, 4FL 1.1019 vs 1.1 fl oz).
 *
 * What the catalog column means. products_catalog.max_label_rate_per_1000 is the label's
 * maximum, as the label-rate backfill (20260712100000, 20260528000031) read it:
 *   - Prodiamine 65 WDG: 0.83 oz, the top of the label's warm-season ANNUAL range
 *     (0.36-0.83 oz per 1,000 sq ft).
 *   - LESCO Stonewall 4FL: 1.1 fl oz, the label's maximum PER CALENDAR YEAR.
 *   - The Stonewall granulars (0.43%, 0-0-7): the stored figure, where there is one (5.34 lb
 *     on 0-0-7), is the label's PER-APPLICATION maximum (233 lb/acre); the annual maximum is
 *     349 lb/acre = 8.01 lb per 1,000 sq ft, which the derived 8.0082 already sits under.
 * So this migration applies the stored figure as the annual cap for the first two products
 * only, and leaves the granulars on the derived value. Used: min(derived, stored), where
 * the stored value is in the cap row's own unit; a product with no stored value, or one
 * higher than the derived cap, keeps what it has.
 *
 * Idempotent. One audit row records each change (before and after); down() puts back the
 * derived value only where the cap still holds the value written here, then deletes the row.
 */
const crypto = require('crypto');

const ACTION = 'v13_prodiamine_cap_label_max';
// Products whose stored max_label_rate_per_1000 is an ANNUAL maximum (see above).
const ANNUAL_MAX_PRODUCTS = [
  'Prodiamine 65 WDG',
  'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide',
];

const unitKey = (value) => String(value || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
const round4 = (value) => Math.round(Number(value) * 10000) / 10000;

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const caps = await knex('product_limits as pl')
    .join('products_catalog as pc', 'pl.product_id', 'pc.id')
    .where({ 'pl.match_type': 'active_ingredient', 'pl.match_value': 'prodiamine', 'pl.limit_type': 'annual_max_rate' })
    .whereIn('pc.name', ANNUAL_MAX_PRODUCTS)
    .select('pl.id', 'pl.limit_value', 'pl.limit_unit', 'pc.max_label_rate_per_1000', 'pc.rate_unit');
  const changes = {};
  for (const cap of caps) {
    const stored = round4(cap.max_label_rate_per_1000);
    const capUnit = String(cap.limit_unit || '').split('/')[0];
    // The stored figure is in the catalog's rate unit: it must be the cap row's unit.
    if (!(stored > 0) || unitKey(cap.rate_unit) !== unitKey(capUnit) || !(stored < Number(cap.limit_value))) continue;
    changes[cap.id] = { before: Number(cap.limit_value), after: stored };
    await knex('product_limits').where({ id: cap.id }).update({ limit_value: stored, updated_at: knex.fn.now() });
  }
  if (!Object.keys(changes).length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261006170000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['limit_value']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ changes }),
    metadata: JSON.stringify({ migration: '20261006170000_lawn_v13_prodiamine_cap_label_max' }),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    for (const [capId, change] of Object.entries(asObject(log.after_snapshot).changes || {})) {
      const row = await knex('product_limits').where({ id: capId }).first('limit_value');
      if (row && Number(row.limit_value) === Number(change.after)) {
        await knex('product_limits').where({ id: capId }).update({ limit_value: change.before });
      }
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ANNUAL_MAX_PRODUCTS = ANNUAL_MAX_PRODUCTS;
