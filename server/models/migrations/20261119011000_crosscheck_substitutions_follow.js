/**
 * An approved product substitution on an open lawn visit follows the swap to LESCO Crosscheck Plus. The plan applies a substitution
 * to the line whose product it is keyed on (waveguard-plan-engine getAppointmentSubstitutions: original_product_id), and after the
 * swap a line that named Atticus Talak 7.9 F, Talstar P or Bifen I/T resolves to Crosscheck (the recipe text, and the protocol rows
 * and links that 20261119010000 and 20261119010400 move). A substitution keyed on one of those products would stop applying, and
 * the plan would not say so.
 *
 * Each active substitution on a visit still open (pending, confirmed, en route or on site) that is keyed on one of them is keyed on
 * Crosscheck; its substitute, rate, reason and approval stay. One whose substitute is Crosscheck keeps its approved rate this way.
 * A visit holds one substitution per original product (uniq_lawn_protocol_substitution_service_original): a visit that already has
 * one keyed on Crosscheck keeps it, and where two would be keyed on Crosscheck the first (Talak, then Talstar P, then Bifen I/T;
 * then by id) is. The others stay as they are, and the visit is logged for the office. A closed visit keeps its record. The rows
 * are read FOR UPDATE and each write is guarded by the product it replaces. One audit_log event per row. Nothing is done without
 * exactly one Crosscheck catalog row or without audit_log. Production has no substitution rows (read 2026-11-19), so nothing
 * changes.
 *
 * down() keys a row back on its old product while it is still keyed on Crosscheck, the old product exists and the visit has no
 * other row keyed on it, and appends a :rollback event (audit_log is append-only). A row it cannot key back stays, and is logged.
 */
const MIGRATION = '20261119011000_crosscheck_substitutions_follow';
const LOG = '[crosscheck-substitutions-follow]';
const ACTION = `migration:${MIGRATION}:substitution`;
const ROLLBACK_ACTION = `${ACTION}:rollback`;
const TABLE = 'lawn_protocol_product_substitutions';
const CROSSCHECK = 'LESCO Crosscheck Plus';
// The products the swap moves to Crosscheck (20261119010000 TALAK_NAMES, 20261119010400 LEGACY_NAMES), first to last.
const REPLACED = ['Atticus Talak 7.9 F', 'Atticus Talak', 'Talstar P', 'Bifen I/T'];
// The visit statuses a plan is still used in (scheduled_services_status_check).
const OPEN_VISIT = ['pending', 'confirmed', 'en_route', 'on_site'];

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Critical, so a lost event fails the migration instead of leaving a re-keyed row that down() cannot see.
async function writeAudit(knex, action, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: TABLE, resource_id: String(resourceId),
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

// The visits among these rows' visits that are still open.
async function openVisits(knex, rows) {
  const ids = [...new Set(rows.map((row) => String(row.scheduled_service_id)))];
  const open = ids.length ? await knex('scheduled_services').whereIn('id', ids).whereIn('status', OPEN_VISIT).select('id') : [];
  return new Set(open.map((visit) => String(visit.id)));
}

async function keyOnCrosscheck(knex, row, crosscheck) {
  const changed = await knex(TABLE).where({ id: row.id, original_product_id: row.original_product_id, active: true })
    .update({ original_product_id: crosscheck.id });
  if (!changed) return false;
  await writeAudit(knex, ACTION, row.id, {
    scheduled_service_id: String(row.scheduled_service_id), from: String(row.original_product_id), to: String(crosscheck.id),
    substitute: String(row.substitute_product_id),
  });
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', TABLE, 'scheduled_services']))) return;
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const crosscheck = named[0];
  const replaced = await knex('products_catalog').whereIn('name', REPLACED).select('id', 'name');
  if (!replaced.length) return;
  const rank = new Map(replaced.map((product) => [String(product.id), REPLACED.indexOf(product.name)]));
  // Locked until the migration commits, so each row is keyed as it was read.
  const rows = await knex(TABLE).whereIn('original_product_id', [...rank.keys(), String(crosscheck.id)])
    .select('id', 'scheduled_service_id', 'original_product_id', 'substitute_product_id', 'active').forUpdate();
  const open = await openVisits(knex, rows);
  const rankOf = (row) => rank.get(String(row.original_product_id));
  const keyed = new Set(rows.filter((row) => rankOf(row) === undefined).map((row) => String(row.scheduled_service_id)));
  const movable = rows.filter((row) => row.active && rankOf(row) !== undefined && open.has(String(row.scheduled_service_id)))
    .sort((a, b) => rankOf(a) - rankOf(b) || String(a.id).localeCompare(String(b.id)));
  for (const row of movable) {
    const visit = String(row.scheduled_service_id);
    if (keyed.has(visit)) {
      console.log(`${LOG} visit ${visit}: substitution ${row.id} stays keyed on its old product; the visit has one keyed on ${CROSSCHECK}`);
    } else if (await keyOnCrosscheck(knex, row, crosscheck)) {
      keyed.add(visit);
    }
  }
};

async function keyBack(knex, event) {
  const { scheduled_service_id: visit, from, to } = asObject(event.metadata);
  if (!visit || !from || !to) return false;
  if (!(await knex('products_catalog').where({ id: from }).first('id'))) return false;
  if (await knex(TABLE).where({ scheduled_service_id: visit, original_product_id: from }).first('id')) return false;
  return Boolean(await knex(TABLE).where({ id: event.resource_id, original_product_id: to }).update({ original_product_id: from }));
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', TABLE]))) return;
  for (const event of await pendingEvents(knex, ACTION)) {
    if (await keyBack(knex, event)) {
      await writeAudit(knex, ROLLBACK_ACTION, event.resource_id, { from_audit_id: String(event.id) });
    } else {
      console.log(`${LOG} substitution ${event.resource_id} is no longer keyed on ${CROSSCHECK}, or its old product is gone or keyed again on its visit: kept`);
    }
  }
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.ROLLBACK_ACTION = ROLLBACK_ACTION;
exports.REPLACED = REPLACED;
exports.OPEN_VISIT = OPEN_VISIT;
