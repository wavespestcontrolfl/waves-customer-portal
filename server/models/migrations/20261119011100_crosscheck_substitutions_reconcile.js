/**
 * Every approved substitution the plan can still use follows the swap to LESCO Crosscheck Plus. 20261119011000 keyed the active
 * substitutions on Crosscheck for pending, confirmed, en route and on-site visits only. A visit parked at rescheduled is rebooked on
 * the same scheduled_services row, and a cancelled, skipped or no-show visit can return to a live status on it (job-status: a
 * compensated cancel or a re-arm), so their substitutions must follow too. And an inactive row keyed on Crosscheck held the visit's
 * one Crosscheck key (uniq_lawn_protocol_substitution_service_original), though the plan reads only active rows
 * (getAppointmentSubstitutions), so the active approval stayed keyed on the old product and stopped applying.
 *
 * 20261119011000 is pushed, so it cannot change. For each visit that is not completed (a completed visit keeps its record), with an
 * active substitution keyed on Atticus Talak 7.9 F, Talstar P or Bifen I/T:
 *   - an active row keyed on Crosscheck stays the visit's Crosscheck substitution; the others stay as they are, and are logged;
 *   - an inactive row keyed on Crosscheck, which the plan never reads, goes whole into its audit event and is deleted;
 *   - then the first active row (Talak, then Talstar P, then Bifen I/T; then by id) is keyed on Crosscheck, with its substitute,
 *     rate, reason and approval; any other stays as it is, and is logged.
 * A substitution whose substitute is one of those products stays: it is the office's own choice for that visit. The rows are read
 * FOR UPDATE and each write is guarded by what it replaces. One audit_log event per write. Nothing is done without exactly one
 * Crosscheck catalog row or without audit_log. Production has no substitution rows (read 2026-11-19), so nothing changes.
 *
 * down() first keys each row back on its old product (while it is still keyed on Crosscheck, the old product exists and the visit
 * has no other row keyed on it), then puts each deleted row back while its id and its visit's Crosscheck key are free and its
 * visit and products exist (an approver deleted since is NULL, as the foreign key's ON DELETE SET NULL would have left it), and
 * appends a :rollback event for each (audit_log is append-only). A row it cannot restore stays as it is, and is logged.
 */
const MIGRATION = '20261119011100_crosscheck_substitutions_reconcile';
const LOG = '[crosscheck-substitutions-reconcile]';
const ACTION = `migration:${MIGRATION}:substitution`;
const ROLLBACK_ACTION = `${ACTION}:rollback`;
const TABLE = 'lawn_protocol_product_substitutions';
const CROSSCHECK = 'LESCO Crosscheck Plus';
// The products the swap moves to Crosscheck (20261119010000 TALAK_NAMES, 20261119010400 LEGACY_NAMES), first to last.
const REPLACED = ['Atticus Talak 7.9 F', 'Atticus Talak', 'Talstar P', 'Bifen I/T'];

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

// Critical, so a lost event fails the migration instead of leaving a write that down() cannot see.
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

// The rows of each visit that is not completed, by visit id in order.
async function liveVisitRows(knex, rows) {
  const ids = [...new Set(rows.map((row) => String(row.scheduled_service_id)))];
  const visits = ids.length ? await knex('scheduled_services').whereIn('id', ids).select('id', 'status') : [];
  const live = new Set(visits.filter((visit) => visit.status !== 'completed').map((visit) => String(visit.id)));
  const byVisit = new Map();
  for (const row of rows) {
    const visit = String(row.scheduled_service_id);
    if (!live.has(visit)) continue;
    if (!byVisit.has(visit)) byVisit.set(visit, []);
    byVisit.get(visit).push(row);
  }
  return [...byVisit].sort(([a], [b]) => a.localeCompare(b));
}

async function removeInactive(knex, row, crosscheck) {
  const removed = await knex(TABLE).where({ id: row.id, original_product_id: crosscheck.id, active: false }).del();
  if (!removed) return false;
  await writeAudit(knex, ACTION, row.id, { kind: 'removed', scheduled_service_id: String(row.scheduled_service_id), row: snapshotRow(row) });
  return true;
}

async function keyOnCrosscheck(knex, row, crosscheck) {
  const changed = await knex(TABLE).where({ id: row.id, original_product_id: row.original_product_id, active: true })
    .update({ original_product_id: crosscheck.id });
  if (!changed) return false;
  await writeAudit(knex, ACTION, row.id, {
    kind: 'keyed', scheduled_service_id: String(row.scheduled_service_id), from: String(row.original_product_id),
    to: String(crosscheck.id), substitute: String(row.substitute_product_id),
  });
  return true;
}

const stays = (visit, rows) => {
  for (const row of rows) console.log(`${LOG} visit ${visit}: substitution ${row.id} stays keyed on its old product; the visit has one keyed on ${CROSSCHECK}`);
};

async function reconcileVisit(knex, visit, rows, rankOf, crosscheck) {
  const movable = rows.filter((row) => row.active && rankOf(row) !== undefined)
    .sort((a, b) => rankOf(a) - rankOf(b) || String(a.id).localeCompare(String(b.id)));
  if (!movable.length) return;
  const held = rows.find((row) => rankOf(row) === undefined); // one per visit and original product
  if (held && (held.active || !(await removeInactive(knex, held, crosscheck)))) {
    stays(visit, movable);
    return;
  }
  const [first, ...rest] = movable;
  if (await keyOnCrosscheck(knex, first, crosscheck)) stays(visit, rest);
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
  const rankOf = (row) => rank.get(String(row.original_product_id));
  // Locked until the migration commits, so each write holds what it was decided on, and a deleted row's event holds it whole.
  const rows = await knex(TABLE).whereIn('original_product_id', [...rank.keys(), String(crosscheck.id)]).select('*').forUpdate();
  for (const [visit, visitRows] of await liveVisitRows(knex, rows)) await reconcileVisit(knex, visit, visitRows, rankOf, crosscheck);
};

async function exists(knex, table, id) {
  return id != null && Boolean(await knex(table).where({ id }).first('id'));
}

async function keyBack(knex, { scheduled_service_id: visit, from, to }, id) {
  if (!visit || !from || !to || !(await exists(knex, 'products_catalog', from))) return false;
  if (await knex(TABLE).where({ scheduled_service_id: visit, original_product_id: from }).first('id')) return false;
  return Boolean(await knex(TABLE).where({ id, original_product_id: to }).update({ original_product_id: from }));
}

async function putBack(knex, { row }) {
  if (!row || !row.id || await exists(knex, TABLE, row.id)) return false;
  if (await knex(TABLE).where({ scheduled_service_id: row.scheduled_service_id, original_product_id: row.original_product_id }).first('id')) return false;
  if (!(await exists(knex, 'scheduled_services', row.scheduled_service_id))) return false;
  for (const product of [row.original_product_id, row.substitute_product_id]) if (!(await exists(knex, 'products_catalog', product))) return false;
  const approver = row.approved_by != null && await knex.schema.hasTable('technicians') && await exists(knex, 'technicians', row.approved_by);
  await knex(TABLE).insert({ ...row, approved_by: approver ? row.approved_by : null, metadata: JSON.stringify(row.metadata ?? {}) });
  return true;
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', TABLE, 'scheduled_services']))) return;
  const events = await pendingEvents(knex, ACTION);
  // Key-backs first: each frees the Crosscheck key that a deleted row needs to come back.
  for (const kind of ['keyed', 'removed']) {
    for (const event of events.filter((e) => asObject(e.metadata).kind === kind)) {
      const metadata = asObject(event.metadata);
      if (await (kind === 'keyed' ? keyBack(knex, metadata, event.resource_id) : putBack(knex, metadata))) {
        await writeAudit(knex, ROLLBACK_ACTION, event.resource_id, { from_audit_id: String(event.id) });
      } else {
        console.log(`${LOG} substitution ${event.resource_id} cannot go back as it was (it changed since, or its key, visit or product is gone or taken): kept`);
      }
    }
  }
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.ROLLBACK_ACTION = ROLLBACK_ACTION;
exports.REPLACED = REPLACED;
