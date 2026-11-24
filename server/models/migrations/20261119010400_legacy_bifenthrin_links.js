/**
 * Links to the two older bifenthrin products, Talstar P and Bifen I/T, move to LESCO Crosscheck Plus, the house bifenthrin
 * (owner 2026-11-18: "all linked services follow it"). Migration 20261119010000 moved every link to Atticus Talak. On a
 * repo-built database the older seeds link these two instead: the lawn protocol curative rows of 20260529000003 (Talstar P)
 * and 20260630000002 (Bifen I/T), and the mosquito_monthly and mosquito_event defaults and the Essential Barrier usage row of
 * 20260507000004 (Bifen I/T). Production has none of them (read 2026-11-18), so production does not change.
 *
 * 1. lawn_protocol_products: a row on a catalog row named Talstar P or Bifen I/T, or a row with no product under one of those
 *    names, takes the Crosscheck link and name; nothing else on the row changes. One lawn_protocol_audit_log row per protocol.
 * 2. services.default_products: either name becomes LESCO Crosscheck Plus in place, or is dropped where Crosscheck is listed.
 * 3. service_product_usage: a row on either product moves to Crosscheck; where Crosscheck already costs that service type, the
 *    row is removed, whole, into its audit event, so the cost counts once.
 * The rows steps 1 and 3 decide on are read FOR UPDATE, and every write is guarded by the value it replaces. Nothing is done
 * without exactly one Crosscheck catalog row or without audit_log. down() restores only what up() wrote and still holds,
 * appends :rollback events (audit_log is append-only), and returns a link to its old product only while that product exists.
 */
const MIGRATION = '20261119010400_legacy_bifenthrin_links';
const LOG = '[legacy-bifenthrin-links]';
const ACTOR = 'migration 20261119010400';
const LAWN_ACTION = 'legacy_bifenthrin_crosscheck'; // lawn_protocol_audit_log.action is varchar(40)
const STEPS = { services: 'services', usage: 'usage' };
const actionFor = (step) => `migration:${MIGRATION}:${step}`;
const rollbackActionFor = (step) => `${actionFor(step)}:rollback`;

const CROSSCHECK = 'LESCO Crosscheck Plus';
const LEGACY_NAMES = ['Talstar P', 'Bifen I/T'];
const PROTOCOL_COLUMNS = ['id', 'product_id', 'product_name', 'lawn_protocol_window_id'];

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
// A JSON-safe copy of a row (dates as ISO strings), so down() can insert it back exactly.
const snapshotRow = (row) => JSON.parse(JSON.stringify(row));
const idText = (id) => (id == null ? null : String(id));

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Critical, so a lost event fails the migration instead of leaving a change down() cannot see.
async function writeAudit(knex, action, resourceType, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: resourceType, resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

// ── up ───────────────────────────────────────────────────────────────────────

// Locked until the migration commits, so each audit snapshot is the row its update changed.
async function readProtocolRows(knex, legacyIds) {
  const linked = legacyIds.length
    ? await knex('lawn_protocol_products').whereIn('product_id', legacyIds).select(PROTOCOL_COLUMNS).forUpdate() : [];
  const unlinked = await knex('lawn_protocol_products').whereNull('product_id').whereIn('product_name', LEGACY_NAMES)
    .select(PROTOCOL_COLUMNS).forUpdate();
  return [...linked, ...unlinked];
}

async function writeProtocolAudit(knex, byProtocol, crosscheck) {
  for (const { protocolId, rows: moved } of byProtocol.values()) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocolId || crosscheck.id,
      action: LAWN_ACTION,
      changed_fields: JSON.stringify(['product_id', 'product_name']),
      before_snapshot: JSON.stringify({ rows: moved }),
      after_snapshot: JSON.stringify({ rows: moved.map((row) => ({ rowId: row.rowId, product_id: String(crosscheck.id), product_name: CROSSCHECK })) }),
      metadata: JSON.stringify({ migration: MIGRATION, to: CROSSCHECK }),
    });
  }
}

async function moveProtocolRows(knex, legacyIds, crosscheck) {
  const rows = await readProtocolRows(knex, legacyIds);
  if (!rows.length) return;
  const windows = await knex('lawn_protocol_windows').whereIn('id', rows.map((row) => row.lawn_protocol_window_id).filter(Boolean)).select('id', 'lawn_protocol_id');
  const protocolOfWindow = new Map(windows.map((window) => [String(window.id), window.lawn_protocol_id]));
  const byProtocol = new Map();
  for (const row of rows) {
    const changed = await knex('lawn_protocol_products').where({ id: row.id, product_id: row.product_id, product_name: row.product_name })
      .update({ product_id: crosscheck.id, product_name: CROSSCHECK });
    if (!changed) continue;
    const protocolId = protocolOfWindow.get(String(row.lawn_protocol_window_id)) || null;
    const key = protocolId || 'none';
    if (!byProtocol.has(key)) byProtocol.set(key, { protocolId, rows: [] });
    byProtocol.get(key).rows.push({ rowId: row.id, product_id: idText(row.product_id), product_name: row.product_name });
  }
  await writeProtocolAudit(knex, byProtocol, crosscheck);
}

// Each older name becomes Crosscheck in place; once Crosscheck is listed (before or by this), a further older name is dropped.
function replaceLegacy(before) {
  const legacy = new Set(LEGACY_NAMES);
  let placed = before.includes(CROSSCHECK);
  const after = [];
  for (const item of before) {
    if (!legacy.has(item)) after.push(item);
    else if (!placed) { after.push(CROSSCHECK); placed = true; }
  }
  return after;
}

async function swapServiceDefaults(knex) {
  if (!(await knex.schema.hasColumn('services', 'default_products'))) return;
  const services = await knex('services').select('id', 'name', 'default_products');
  for (const service of services) {
    const before = asArray(service.default_products);
    if (!before || !before.some((item) => LEGACY_NAMES.includes(item))) continue;
    const after = replaceLegacy(before);
    // Guarded by the array it replaces (jsonb equality), so an edit made since the read is never overwritten.
    const changed = await knex('services').where({ id: service.id, default_products: JSON.stringify(before) })
      .update({ default_products: JSON.stringify(after) });
    if (changed) await writeAudit(knex, actionFor(STEPS.services), 'services', service.id, { service: service.name, before, after });
  }
}

async function moveUsageRow(knex, row, crosscheck, mapsCrosscheck) {
  const action = actionFor(STEPS.usage);
  const guarded = () => knex('service_product_usage').where({ id: row.id, product_id: row.product_id });
  if (mapsCrosscheck.has(row.service_type)) {
    // Crosscheck already costs this service type, so the older row would count the same bifenthrin a second time.
    if (await guarded().del()) await writeAudit(knex, action, 'service_product_usage', row.id, { kind: 'removed', service_type: row.service_type, row: snapshotRow(row) });
    return;
  }
  if (await guarded().update({ product_id: crosscheck.id })) {
    mapsCrosscheck.add(row.service_type);
    await writeAudit(knex, action, 'service_product_usage', row.id, { kind: 'moved', service_type: row.service_type, from: String(row.product_id), to: String(crosscheck.id) });
  }
}

// Read FOR UPDATE: the rows stay locked until the migration commits, so an office edit cannot land between the read that
// decides a row is a duplicate and the delete, and the audit event holds the row as it was deleted.
async function moveUsageRows(knex, legacyIds, crosscheck) {
  if (!legacyIds.length) return;
  const rows = await knex('service_product_usage').whereIn('product_id', [...legacyIds, crosscheck.id]).select('*').forUpdate();
  const isCrosscheck = (row) => String(row.product_id) === String(crosscheck.id);
  const mapsCrosscheck = new Set(rows.filter(isCrosscheck).map((row) => row.service_type));
  for (const row of rows) {
    if (!isCrosscheck(row)) await moveUsageRow(knex, row, crosscheck, mapsCrosscheck);
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id', 'name');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const crosscheck = named[0];
  const legacy = await knex('products_catalog').whereIn('name', LEGACY_NAMES).select('id', 'name');
  const legacyIds = legacy.map((row) => row.id).filter((id) => String(id) !== String(crosscheck.id));
  if (await hasTables(knex, ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocol_audit_log'])) await moveProtocolRows(knex, legacyIds, crosscheck);
  if (await knex.schema.hasTable('services')) await swapServiceDefaults(knex);
  if (await knex.schema.hasTable('service_product_usage')) await moveUsageRows(knex, legacyIds, crosscheck);
};

// ── down ─────────────────────────────────────────────────────────────────────

// A link goes back to its old product only while that product exists (the foreign key would otherwise fail the rollback).
async function productExists(knex, id) {
  return Boolean(id) && Boolean(await knex('products_catalog').where({ id }).first('id'));
}

async function restoreProtocolRow(knex, old, written) {
  if (!old || (old.product_id != null && !(await productExists(knex, old.product_id)))) return 0;
  return knex('lawn_protocol_products')
    .where({ id: written.rowId, product_id: written.product_id, product_name: written.product_name })
    .update({ product_id: old.product_id, product_name: old.product_name });
}

async function restoreProtocolRows(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: LAWN_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const before = new Map((asObject(log.before_snapshot).rows || []).map((row) => [String(row.rowId), row]));
    let kept = 0;
    for (const written of asObject(log.after_snapshot).rows || []) {
      if (await restoreProtocolRow(knex, before.get(String(written.rowId)), written)) continue;
      kept += 1;
      console.log(`${LOG} protocol row ${written.rowId} is no longer as written: kept`);
    }
    if (!kept) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

// The up() events of a step that no rollback event names yet. audit_log is append-only: down() never deletes an event.
async function pendingEvents(knex, step) {
  const events = await knex('audit_log').where({ action: actionFor(step) }).select('id', 'resource_id', 'metadata');
  const rollbacks = await knex('audit_log').where({ action: rollbackActionFor(step) }).select('metadata');
  const reversed = new Set(rollbacks.map((row) => String(asObject(row.metadata).from_audit_id)));
  return events.filter((event) => !reversed.has(String(event.id)));
}

async function recordRollback(knex, step, event, resourceType) {
  await writeAudit(knex, rollbackActionFor(step), resourceType, event.resource_id, { from_audit_id: String(event.id) });
}

const keptLog = (what) => console.log(`${LOG} ${what} no longer holds what up() wrote: kept`);

async function restoreServices(knex) {
  for (const event of await pendingEvents(knex, STEPS.services)) {
    const { before, after } = asObject(event.metadata);
    if (!Array.isArray(before) || !Array.isArray(after)) continue;
    const restored = await knex('services').where({ id: event.resource_id, default_products: JSON.stringify(after) })
      .update({ default_products: JSON.stringify(before) });
    if (restored) await recordRollback(knex, STEPS.services, event, 'services');
    else keptLog(`service ${event.resource_id} default_products`);
  }
}

async function restoreUsageRow(knex, event) {
  const { kind, from, to, row } = asObject(event.metadata);
  if (kind === 'moved' && from && to && await productExists(knex, from)) {
    return knex('service_product_usage').where({ id: event.resource_id, product_id: to }).update({ product_id: from });
  }
  if (kind !== 'removed' || !row || !row.id) return 0;
  // Back only while nothing took its id and its product still exists (the foreign key needs it).
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return 0;
  if (!(await productExists(knex, row.product_id))) return 0;
  await knex('service_product_usage').insert(row);
  return 1;
}

async function restoreUsage(knex) {
  for (const event of await pendingEvents(knex, STEPS.usage)) {
    if (await restoreUsageRow(knex, event)) await recordRollback(knex, STEPS.usage, event, 'service_product_usage');
    else keptLog(`usage row ${event.resource_id}`);
  }
}

exports.down = async function down(knex) {
  if (await hasTables(knex, ['lawn_protocol_products', 'lawn_protocol_audit_log'])) await restoreProtocolRows(knex);
  if (!(await knex.schema.hasTable('audit_log'))) return;
  if (await knex.schema.hasTable('services')) await restoreServices(knex);
  if (await knex.schema.hasTable('service_product_usage')) await restoreUsage(knex);
};

exports.MIGRATION = MIGRATION;
exports.LAWN_ACTION = LAWN_ACTION;
exports.actionFor = actionFor;
exports.rollbackActionFor = rollbackActionFor;
exports.STEPS = STEPS;
