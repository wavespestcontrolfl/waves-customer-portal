/**
 * Lawn protocol v13, field rules follow-up (Codex round 1 on #6098). Migration
 * 20261007150000 is pushed and frozen; this one adds what it needs.
 *
 * 1. Dismiss procurement. 150000 retires the staged Dismiss rows ("use up the
 *    jug, do not reorder"), but the product could still be bought: with
 *    auto_reorder_enabled the daily sweep (procurement/auto-reorder.js) raises a
 *    restock request when stock runs low. Each exact-name "Dismiss 64 oz" catalog
 *    row with auto_reorder_enabled true gets it switched off, and every still-open
 *    request the sweep itself created ('auto_reorder' source, status 'open', no
 *    automatic order already out) is cancelled the way the dispatcher cancels one
 *    the catalog no longer authorizes (order-dispatch cancelAtClaim: the sweep's
 *    bell and any parked ledger bell are withdrawn, status 'cancelled'). Manual and
 *    forecast requests, ordered requests and requests with an order already out
 *    are left alone. The product stays active, so stock on hand can still be
 *    recorded and used.
 * 2. Safety gates of referenced protocols. 150000.down() removes
 *    northPortProductWindow and delayWateringOrMowingHours from every v13
 *    protocol, referenced or not; its file is frozen, so it cannot be guarded
 *    there. Rollback runs this migration's down() first, and down() takes those
 *    keys out of 150000's audit rows for every protocol a visit or a completion
 *    references (the same reference test 20261005120000 and 20261005160000 apply),
 *    so 150000.down() then leaves them in place. A rollback never drops safety
 *    data from a protocol still in use. Rolling back past 150000 without this
 *    migration's down() (for example by editing knex_migrations by hand) removes
 *    the keys from referenced protocols too.
 * 3. North Port April: the recipe text now says April has no fertilizer and no
 *    Nutra-TECH there (city fact sheet, pending city confirmation). The staged
 *    April window has no Nutra-TECH row, so no data changes for it: the
 *    24-0-11 and 18-0-10 rows keep their N-ban behavior (nitrogen_blackout).
 *
 * Idempotent. One lawn_protocol_audit_log row per product it changed (action
 * 'v13_field_rules_followup') holds what was written; down() restores
 * auto_reorder_enabled only while it still reads false (an owner who switched it
 * back on since keeps that choice) and never reopens a cancelled request.
 */

const MIGRATION = '20261007155000_lawn_v13_field_rules_followup';
const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_field_rules_followup';
const FIELD_RULES_ACTION = 'v13_field_rules';
const DISMISS = 'Dismiss 64 oz';
const SOURCE = 'auto_reorder';
const CANCEL_REASON = 'dismiss_retired';

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

const hasTables = async (knex, tables) => (await Promise.all(tables.map((table) => knex.schema.hasTable(table)))).every(Boolean);

// Open requests the sweep created for the product, with no automatic order already out.
async function cancellableRequests(knex, dispatch, productId) {
  if (await dispatch.findLiveAutoOrder(knex, productId)) return [];
  return knex('product_restock_requests').where({ product_id: productId, status: 'open', source: SOURCE }).forUpdate();
}

async function cancelRequests(knex, dispatch, product, requests) {
  const cancelled = [];
  for (const request of requests) {
    await dispatch.cancelAtClaim(knex, { request, product, m: parse(request.metadata, {}), ineligible: CANCEL_REASON });
    cancelled.push(request.id);
  }
  return cancelled;
}

async function retireDismissProcurement(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'lawn_protocol_audit_log'])) || !(await knex.schema.hasColumn('products_catalog', 'auto_reorder_enabled'))) return;
  const products = await knex('products_catalog').where({ name: DISMISS, auto_reorder_enabled: true }).forUpdate().select('id', 'name');
  const restockTable = await knex.schema.hasTable('product_restock_requests');
  const dispatch = restockTable ? require('../../services/procurement/order-dispatch') : null;
  for (const product of products) {
    await knex('products_catalog').where({ id: product.id }).update({ auto_reorder_enabled: false, updated_at: knex.fn.now() });
    const requests = restockTable ? await cancellableRequests(knex, dispatch, product.id) : [];
    const cancelledRequestIds = await cancelRequests(knex, dispatch, product, requests);
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007155000',
      entity_type: 'catalog',
      entity_id: product.id,
      action: ACTION,
      changed_fields: JSON.stringify(['auto_reorder_enabled', 'product_restock_requests']),
      before_snapshot: JSON.stringify({ autoReorderEnabled: true }),
      after_snapshot: JSON.stringify({ autoReorderEnabled: false, cancelledRequestIds }),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
}

exports.up = async function up(knex) {
  await retireDismissProcurement(knex);
};

// The same reference test the earlier v13 migrations apply, per protocol.
async function isReferenced(knex, protocol) {
  if ((await knex.schema.hasTable('scheduled_services'))
    && await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  return Boolean(await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id'));
}

// 150000.down() removes what its audit rows name, so a referenced protocol's rows name nothing.
async function protectReferencedGates(knex) {
  const logs = await knex('lawn_protocol_audit_log as a')
    .join('lawn_protocols as l', 'a.lawn_protocol_id', 'l.id')
    .where({ 'a.action': FIELD_RULES_ACTION, 'l.version': V13_VERSION })
    .select('a.id', 'a.after_snapshot', 'l.id as protocol_id', 'l.protocol_key');
  for (const log of logs) {
    if (!(await isReferenced(knex, { id: log.protocol_id, protocol_key: log.protocol_key }))) continue;
    const after = parse(log.after_snapshot, {});
    if (!Object.keys(after.gates || {}).length) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, gates: {}, protectedGates: after.gates }) });
  }
}

async function restoreProcurement(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'entity_id', 'after_snapshot');
  for (const log of logs) {
    if (parse(log.after_snapshot, {}).autoReorderEnabled === false) {
      await knex('products_catalog').where({ id: log.entity_id, auto_reorder_enabled: false }).update({ auto_reorder_enabled: true, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['lawn_protocols', 'lawn_protocol_audit_log']))) return;
  await protectReferencedGates(knex);
  if (await hasTables(knex, ['products_catalog'])) await restoreProcurement(knex);
};

exports.DISMISS = DISMISS;
