/**
 * A usage row that 20261119010600 removed comes back unless it repeats a row its service type keeps. That migration keeps the row
 * with the lowest id among the Talak rows 20261119010000 moved onto one service type and removes the others whole. Two rows with the
 * same amount, unit and rate per 1,000 sq ft count the bifenthrin twice, so one of them goes. Two rows with different amounts give no
 * evidence which one is right, and the margin checks summed both before the swap, so both stay and the office settles them.
 *
 * 20261119010600 is pushed, so it cannot change. For each of its removals (its audit events, less any it has rolled back), in id
 * order per service type, the removed row goes back while no row of that service type it knows of (the kept row, or a row put back
 * before it) has the same amount, unit and rate, its id is free and its product exists. Each one put back gets 20261119010600's
 * :rollback event (so that migration's down() does not insert it a second time) and this migration's own event, and the service
 * type is logged for the office. The kept rows are read FOR UPDATE. Nothing is done without audit_log. Production has one Talak
 * usage row (read 2026-11-19), so nothing changes. down() is a documented no-op: the rows it put back are rows the office entered,
 * and the swap's own down() returns them to Talak.
 */
const MIGRATION = '20261119010800_crosscheck_usage_conflicts_stay';
const LOG = '[crosscheck-usage-conflicts-stay]';
const ONE_PER_TYPE = 'migration:20261119010600_crosscheck_usage_one_per_type:usage';
const ONE_PER_TYPE_ROLLBACK = `${ONE_PER_TYPE}:rollback`;
const ACTION = `migration:${MIGRATION}:usage`;

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
// What a usage row costs: its amount, unit and rate per 1,000 sq ft (pg hands decimals back as strings).
const amountOf = (value) => (value == null || value === '' ? null : Number(value));
const costingKey = (row) => JSON.stringify([
  amountOf(row.usage_amount),
  row.usage_unit == null ? null : String(row.usage_unit).trim().toLowerCase(),
  amountOf(row.usage_per_1000sf),
]);

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Critical, so a lost event fails the migration instead of leaving a row put back with no record.
async function writeAudit(knex, action, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: 'service_product_usage', resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

// 20261119010600's removals that no rollback event names yet, as { event, row, kept, serviceType }, grouped by service type.
async function pendingRemovals(knex) {
  const events = await knex('audit_log').where({ action: ONE_PER_TYPE }).select('id', 'resource_id', 'metadata');
  const rollbacks = await knex('audit_log').where({ action: ONE_PER_TYPE_ROLLBACK }).select('metadata');
  const reversed = new Set(rollbacks.map((row) => String(asObject(row.metadata).from_audit_id)));
  const byType = new Map();
  for (const event of events) {
    const { kind, row, kept, service_type: serviceType } = asObject(event.metadata);
    if (reversed.has(String(event.id)) || kind !== 'removed' || !row || !row.id) continue;
    if (!byType.has(serviceType)) byType.set(serviceType, []);
    byType.get(serviceType).push({ event, row, kept });
  }
  for (const removals of byType.values()) removals.sort((a, b) => String(a.row.id).localeCompare(String(b.row.id)));
  return byType;
}

async function canInsert(knex, row) {
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return false;
  return Boolean(row.product_id) && Boolean(await knex('products_catalog').where({ id: row.product_id }).first('id'));
}

async function restoreConflicts(knex, serviceType, removals) {
  const keptIds = [...new Set(removals.map((removal) => removal.kept).filter(Boolean))];
  // Locked until the migration commits, so the cost each decision compares with cannot change under it.
  const present = keptIds.length ? await knex('service_product_usage').whereIn('id', keptIds).select('*').forUpdate() : [];
  const costs = new Set(present.map(costingKey));
  for (const { event, row, kept } of removals) {
    if (costs.has(costingKey(row)) || !(await canInsert(knex, row))) continue;
    await knex('service_product_usage').insert(row);
    costs.add(costingKey(row));
    await writeAudit(knex, ONE_PER_TYPE_ROLLBACK, row.id, { from_audit_id: String(event.id) });
    await writeAudit(knex, ACTION, row.id, { kind: 'restored', service_type: serviceType, kept: kept ? String(kept) : null });
    console.log(`${LOG} service type "${serviceType}": usage rows ${kept} and ${row.id} cost LESCO Crosscheck Plus differently; both kept for the office to settle`);
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['audit_log', 'service_product_usage', 'products_catalog']))) return;
  for (const [serviceType, removals] of await pendingRemovals(knex)) await restoreConflicts(knex, serviceType, removals);
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
