/**
 * Each service type keeps one LESCO Crosscheck Plus usage row from the swap. Migration 20261119010000 moves every Talak
 * service_product_usage row to Crosscheck and drops a Talak row only where Crosscheck already costs that service type, so two Talak rows
 * on one service type both move, and the margin checks would count the bifenthrin twice. 20261119010400 already keeps one row a service
 * type for the older bifenthrin names; this does the same for the Talak rows.
 *
 * Among the rows 20261119010000 moved (its audit events, less any it has rolled back) that are still on Crosscheck, a service type with
 * more than one keeps the row with the lowest id; each other one is removed, whole, into its audit event. A Crosscheck row the swap did
 * not move is never touched. The rows are read FOR UPDATE and each delete is guarded by the product the row holds. Nothing is done
 * without exactly one Crosscheck catalog row or without audit_log. down() puts a removed row back while its id is free and its product
 * exists, and appends a :rollback event (audit_log is append-only); 20261119010000's down() then moves it back to Talak. Production has
 * one Talak usage row (read 2026-11-19), so production does not change.
 */
const MIGRATION = '20261119010600_crosscheck_usage_one_per_type';
const LOG = '[crosscheck-usage-one-per-type]';
const SWAP_USAGE = 'migration:20261119010000_house_bifenthrin_crosscheck:usage';
const ACTION = `migration:${MIGRATION}:usage`;
const ROLLBACK_ACTION = `${ACTION}:rollback`;
const CROSSCHECK = 'LESCO Crosscheck Plus';

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
// A JSON-safe copy of a row (dates as ISO strings), so down() can insert it back exactly.
const snapshotRow = (row) => JSON.parse(JSON.stringify(row));

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Critical, so a lost event fails the migration instead of leaving a removal down() cannot see.
async function writeAudit(knex, action, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: 'service_product_usage', resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

// The up() events of `action` that no rollback event names yet.
async function pendingEvents(knex, action) {
  const events = await knex('audit_log').where({ action }).select('id', 'resource_id', 'metadata');
  const rollbacks = await knex('audit_log').where({ action: `${action}:rollback` }).select('metadata');
  const reversed = new Set(rollbacks.map((row) => String(asObject(row.metadata).from_audit_id)));
  return events.filter((event) => !reversed.has(String(event.id)));
}

// The ids of the usage rows 20261119010000 moved to Crosscheck and has not moved back.
async function swapMovedIds(knex, crosscheck) {
  const moved = (await pendingEvents(knex, SWAP_USAGE)).filter((event) => {
    const { kind, to } = asObject(event.metadata);
    return kind === 'moved' && String(to) === String(crosscheck.id);
  });
  return moved.map((event) => String(event.resource_id));
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', 'service_product_usage']))) return;
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const crosscheck = named[0];
  const movedIds = await swapMovedIds(knex, crosscheck);
  if (movedIds.length < 2) return;
  // Locked until the migration commits, so the audit event holds the row as it was deleted.
  const rows = await knex('service_product_usage').whereIn('id', movedIds).where({ product_id: crosscheck.id }).select('*').forUpdate();
  const byType = new Map();
  for (const row of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!byType.has(row.service_type)) byType.set(row.service_type, []);
    byType.get(row.service_type).push(row);
  }
  for (const [serviceType, typeRows] of byType) {
    const [kept, ...extra] = typeRows;
    for (const row of extra) {
      const removed = await knex('service_product_usage').where({ id: row.id, product_id: crosscheck.id }).del();
      if (removed) await writeAudit(knex, ACTION, row.id, { kind: 'removed', service_type: serviceType, kept: String(kept.id), row: snapshotRow(row) });
    }
  }
};

async function productExists(knex, id) {
  return Boolean(id) && Boolean(await knex('products_catalog').where({ id }).first('id'));
}

// Back only while nothing took its id and its product still exists (the foreign key needs it).
async function restoreRow(knex, row) {
  if (!row || !row.id) return false;
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return false;
  if (!(await productExists(knex, row.product_id))) return false;
  await knex('service_product_usage').insert(row);
  return true;
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['audit_log', 'service_product_usage']))) return;
  for (const event of await pendingEvents(knex, ACTION)) {
    if (await restoreRow(knex, asObject(event.metadata).row)) {
      await writeAudit(knex, ROLLBACK_ACTION, event.resource_id, { from_audit_id: String(event.id) });
    } else {
      console.log(`${LOG} usage row ${event.resource_id} cannot go back (its id is taken or its product is gone): kept out`);
    }
  }
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.ROLLBACK_ACTION = ROLLBACK_ACTION;
