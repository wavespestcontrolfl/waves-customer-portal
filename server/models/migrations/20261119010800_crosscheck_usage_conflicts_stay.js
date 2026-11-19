/**
 * A usage row the swap's migrations removed comes back unless it repeats the cost of a LESCO Crosscheck Plus row its service type
 * holds. Three of them remove a row by service type alone: 20261119010000 (a Talak row where Crosscheck already costs the service
 * type), 20261119010400 (the same for Talstar P and Bifen I/T) and 20261119010600 (a second moved Talak row on one service type).
 * Two rows with the same amount, unit and rate per 1,000 sq ft count the bifenthrin twice, so one goes. Two rows with different
 * amounts give no evidence which one is right, and the margin check summed both before the swap, so both stay and the office
 * settles them.
 *
 * Those files are pushed, so they cannot change. Their removals (their audit events, less any they rolled back) are taken in the
 * order they ran. A removed row goes back on Crosscheck (owner 2026-11-18: every link follows it) while its id is free and no
 * Crosscheck row of its service type (one it holds, or one put back before it) has the same amount, unit and rate. The Crosscheck
 * rows compared with are read FOR UPDATE. Each row put back gets an audit_log event, and its service type is logged for the office.
 * Nothing is done without exactly one Crosscheck catalog row or without audit_log. Production has one Talak usage row and no
 * removal (read 2026-11-19), so nothing changes.
 *
 * down() deletes a row it put back while every column still holds what up() wrote and its own product still exists, and appends a
 * :rollback event (audit_log is append-only); the removing migration's down() then puts the row back as it was. A row the office
 * changed since (its cost, notes or is_primary), or one whose own product is gone (no down() could put it back), stays on
 * Crosscheck.
 */
const MIGRATION = '20261119010800_crosscheck_usage_conflicts_stay';
const LOG = '[crosscheck-usage-conflicts-stay]';
const ACTION = `migration:${MIGRATION}:usage`;
const ROLLBACK_ACTION = `${ACTION}:rollback`;
const CROSSCHECK = 'LESCO Crosscheck Plus';
// The usage actions of the migrations that remove a row by service type alone, in the order they run.
const REMOVERS = [
  'migration:20261119010000_house_bifenthrin_crosscheck:usage',
  'migration:20261119010400_legacy_bifenthrin_links:usage',
  'migration:20261119010600_crosscheck_usage_one_per_type:usage',
];
const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
const amountOf = (value) => (value == null || value === '' ? null : Number(value));
const unitOf = (value) => (value == null ? null : String(value).trim().toLowerCase());
const costingKey = (row) => JSON.stringify([amountOf(row.usage_amount), unitOf(row.usage_unit), amountOf(row.usage_per_1000sf)]);

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Critical, so a lost event fails the migration instead of leaving a row put back that down() cannot see.
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

// The removals still in effect, as { action, event, row }: migration by migration, and by row id within one.
async function pendingRemovals(knex) {
  const removals = [];
  for (const action of REMOVERS) {
    const own = [];
    for (const event of await pendingEvents(knex, action)) {
      const { kind, row } = asObject(event.metadata);
      if (kind === 'removed' && row && row.id && row.service_type != null) own.push({ action, event, row });
    }
    removals.push(...own.sort((a, b) => String(a.row.id).localeCompare(String(b.row.id))));
  }
  return removals;
}

async function restoreRemoval(knex, crosscheck, costs, { action, event, row }) {
  if (costs.has(costingKey(row))) return;
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return;
  const restored = { ...row, product_id: crosscheck.id };
  await knex('service_product_usage').insert(restored);
  costs.add(costingKey(row));
  await writeAudit(knex, ACTION, row.id, {
    kind: 'restored', service_type: row.service_type, from_action: action, from_audit_id: String(event.id),
    product_before: String(row.product_id), row: restored,
  });
  console.log(`${LOG} service type "${row.service_type}": usage row ${row.id} costs ${CROSSCHECK} differently from the rows kept; both stay for the office to settle`);
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['audit_log', 'service_product_usage', 'products_catalog']))) return;
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const removals = await pendingRemovals(knex);
  if (!removals.length) return;
  // Locked until the migration commits, so the costs each decision compares with cannot change under it.
  const held = await knex('service_product_usage').where({ product_id: named[0].id }).select('*').forUpdate();
  const costs = new Map();
  const costsOf = (serviceType) => {
    if (!costs.has(serviceType)) costs.set(serviceType, new Set());
    return costs.get(serviceType);
  };
  for (const row of held) costsOf(row.service_type).add(costingKey(row));
  for (const removal of removals) await restoreRemoval(knex, named[0], costsOf(removal.row.service_type), removal);
};

// The row as up() wrote it, column by column, so an edit since to any of them (its cost, notes or is_primary) keeps it. A NULL
// matches only NULL.
function writtenRow(knex, row) {
  let query = knex('service_product_usage');
  for (const [column, value] of Object.entries(row)) query = value == null ? query.whereNull(column) : query.where({ [column]: value });
  return query;
}

async function productExists(knex, id) {
  return Boolean(id) && Boolean(await knex('products_catalog').where({ id }).first('id'));
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['audit_log', 'service_product_usage', 'products_catalog']))) return;
  for (const event of await pendingEvents(knex, ACTION)) {
    const { row, product_before: productBefore } = asObject(event.metadata);
    if (row && row.id && await productExists(knex, productBefore) && await writtenRow(knex, row).del()) {
      await writeAudit(knex, ROLLBACK_ACTION, event.resource_id, { from_audit_id: String(event.id) });
    } else {
      console.log(`${LOG} usage row ${event.resource_id} is no longer as up() wrote it, or its own product is gone: kept on ${CROSSCHECK}`);
    }
  }
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.ROLLBACK_ACTION = ROLLBACK_ACTION;
exports.REMOVERS = REMOVERS;
