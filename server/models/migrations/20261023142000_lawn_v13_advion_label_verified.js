/**
 * Lawn protocol v13, Advion Insect Granule: stamp the label as read (owner 2026-10-23). A follow-up to 20261023140000, which is frozen.
 *
 * Why. 20261023140000 inserted the catalog row from the EPA-accepted label (EPA Reg. No. 100-1483, accepted 2019-12-19) but left
 * `label_verified_at` empty. The job card and the tank sheet withhold the amount of a product whose label was never verified, so the 3 lb
 * rate would not have shown. The label was read for that row (rates, yearly maximum, irrigation advice), so the stamp is true.
 *
 * up(): finds the row 20261023140000 inserted (its catalog audit row names the id) and sets `label_verified_at` on it ONLY while that
 * column is still empty. A row that is missing, or already stamped (by staff or another migration), is left exactly as it is. Nothing
 * else on the row changes. One audit row records the stamp.
 *
 * down(): clears `label_verified_at` back to empty ONLY while it still holds the value up() wrote, then removes its audit row. A stamp that
 * staff changed since is kept.
 */

const crypto = require('crypto');
const catalogMigration = require('./20261023140000_lawn_v13_advion_insect_granule');

const ACTION = 'v13_advion_label_verified';
const ACTOR = 'migration 20261023142000';
const MIGRATION = '20261023142000_lawn_v13_advion_label_verified';
// The same instant 20261023140000 puts in the watering rule's verified_at.
const VERIFIED_AT = '2026-10-23T00:00:00.000Z';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// The id of the catalog row 20261023140000 inserted, else null.
async function insertedAdvionId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: catalogMigration.CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return String(productId);
  }
  return null;
}

async function hasAll(knex) {
  return (await knex.schema.hasTable('products_catalog')) && (await knex.schema.hasTable('lawn_protocol_audit_log'))
    && (await knex.schema.hasColumn('products_catalog', 'label_verified_at'));
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (await knex('lawn_protocol_audit_log').where({ action: ACTION }).first('id')) return; // already stamped by this migration
  const productId = await insertedAdvionId(knex);
  if (!productId) return;
  const row = await knex('products_catalog').where({ id: productId }).first('id', 'label_verified_at');
  if (!row || row.label_verified_at != null) return;
  const stamped = await knex('products_catalog').where({ id: productId }).whereNull('label_verified_at')
    .update({ label_verified_at: VERIFIED_AT, updated_at: knex.fn.now() });
  if (!stamped) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['label_verified_at']),
    before_snapshot: JSON.stringify({ productId, label_verified_at: null }),
    after_snapshot: JSON.stringify({ productId, label_verified_at: VERIFIED_AT }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { productId, label_verified_at: written } = asObject(log.after_snapshot);
    const row = productId ? await knex('products_catalog').where({ id: productId }).first('id', 'label_verified_at') : null;
    if (row && row.label_verified_at != null && new Date(row.label_verified_at).getTime() === new Date(written).getTime()) {
      await knex('products_catalog').where({ id: productId }).update({ label_verified_at: null, updated_at: knex.fn.now() });
    } else if (row) {
      console.log('[lawn-v13-advion-label-verified] stamp kept: it is no longer the value this migration wrote');
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.VERIFIED_AT = VERIFIED_AT;
