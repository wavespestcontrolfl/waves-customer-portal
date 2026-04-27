/**
 * Sole writer for dispatch_alerts. Inserts a new alert row and emits
 * dispatch:alert to the dispatch:admins room *after* the transaction
 * commits — never before, never inside.
 *
 * Same atomicity + trx-optional + post-commit-emit pattern as
 * services/tech-status.js#upsertTechStatus and
 * services/job-status.js#transitionJobStatus. If the caller passes
 * their own trx, this function uses it for the insert and chains
 * the emit on trx.executionPromise. If no trx is passed, this
 * function creates one, commits, and emits inline.
 *
 * Why not just db.insert + emit? Because future generators will
 * trigger alerts inline with status transitions — e.g.,
 * "transitionJobStatus to 'completed' AND if no photo uploaded,
 * createAlert(missed_photo)". Both writes need to land atomically
 * or neither lands. Taking trx as an optional parameter today
 * means the call site stays clean tomorrow.
 *
 * dispatch:admins is the staff room (admin + technician). Customers
 * never join it and never receive alerts — these are dispatcher
 * coordination signals, not customer-facing notifications.
 *
 * No PII boundary equivalent to customer:job_update because the
 * channel is admin-only end-to-end. Generators are still expected
 * to keep payload reasonable (no pricing internals, no chemical
 * lots — those belong on detail-view fetches), but no enforcement
 * lives in this module. The dispatcher UI consuming the channel
 * is the client; payload shape is type-specific.
 *
 * Resolution (POST /api/admin/alerts/:id/resolve, future PR) is NOT
 * in this module's scope. When it lands, it will likely use a
 * separate event channel (dispatch:alert_resolved) so the right-pane
 * can clean up cards in real time across multiple connected
 * dispatchers. For now this module is create-only.
 */
const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');

const EVENT = 'dispatch:alert';
const EVENT_RESOLVED = 'dispatch:alert_resolved';
const ROOM = 'dispatch:admins';

const VALID_SEVERITIES = ['info', 'warn', 'critical'];

/**
 * Create a dispatch alert and broadcast it to dispatch:admins.
 *
 * @param {object} args
 * @param {string} args.type           required, free-form string. No
 *                                      DB-side CHECK — generators add
 *                                      new types as needed; the
 *                                      frontend renders by type with
 *                                      a generic fallback.
 * @param {string} [args.severity]     'info' | 'warn' | 'critical'.
 *                                      Defaults to 'info'. CHECK on
 *                                      the column rejects anything
 *                                      else.
 * @param {string} [args.techId]       optional, technicians.id the
 *                                      alert is scoped to
 * @param {string} [args.jobId]        optional, scheduled_services.id
 *                                      the alert is scoped to
 * @param {object} [args.payload]      optional, type-specific JSONB.
 *                                      Stored as-is; frontend reads
 *                                      per type.
 * @param {object} [args.trx]          optional Knex transaction; same
 *                                      semantics as transitionJobStatus
 *                                      — caller's trx + deferred emit,
 *                                      or owned trx + inline emit.
 * @returns {Promise<object>} the inserted row (id, type, severity,
 *                             tech_id, job_id, payload, created_at,
 *                             resolved_at, resolved_by)
 */
async function createAlert({ type, severity, techId, jobId, payload, trx } = {}) {
  if (!type) {
    throw new Error('createAlert: type is required');
  }
  const sev = severity || 'info';
  if (!VALID_SEVERITIES.includes(sev)) {
    // Pre-flight check matches the CHECK constraint so the caller
    // gets a clean JS error rather than a Postgres error string.
    throw new Error(`createAlert: invalid severity '${sev}' (expected one of ${VALID_SEVERITIES.join(', ')})`);
  }

  async function doWrite(t) {
    const [row] = await t('dispatch_alerts')
      .insert({
        type,
        severity: sev,
        tech_id: techId || null,
        job_id: jobId || null,
        payload: payload ? JSON.stringify(payload) : null,
      })
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);
    return row;
  }

  if (trx) {
    const row = await doWrite(trx);
    if (trx.executionPromise) {
      trx.executionPromise.then(() => emitAlert(row)).catch(() => {
        // Outer rollback. Caller sees the rejection; we suppress
        // the emit so a phantom alert never reaches dispatch:admins.
      });
    } else {
      logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting inline (test harness?)');
      emitAlert(row);
    }
    return row;
  }

  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrite(innerTrx);
  });
  // trx committed by here.
  emitAlert(captured);
  return captured;
}

function emitAlert(row) {
  const io = getIo();
  if (!io) {
    logger.warn('[dispatch-alerts] io not initialized; skipping broadcast');
    return;
  }
  io.to(ROOM).emit(EVENT, row);
}

/**
 * Mark an alert resolved and broadcast dispatch:alert_resolved.
 *
 * Idempotent at the DB layer: the UPDATE has `WHERE resolved_at IS NULL`,
 * so a second concurrent resolve from a different dispatcher is a no-op
 * — the second caller gets `null` back and no second broadcast fires.
 * Caller's route layer treats null as "not found OR already resolved"
 * and disambiguates with a follow-up SELECT (see admin-dispatch.js).
 *
 * Same trx-or-not + post-commit emit pattern as createAlert. Future
 * auto-resolve paths (e.g., transitionJobStatus to on_site clearing
 * tech_late alerts for that job) can pass their own trx; this module
 * doesn't emit until the outer trx commits.
 *
 * @param {object} args
 * @param {string} args.id           required, dispatch_alerts.id
 * @param {string} [args.resolvedBy] optional, technicians.id of the
 *                                   actor who resolved. Stored on the
 *                                   row for audit; not in the broadcast
 *                                   payload (other dispatchers don't
 *                                   need it for the cache eviction).
 * @param {object} [args.trx]        optional Knex transaction.
 * @returns {Promise<object|null>}   the resolved row, or null if no
 *                                   row matched (already resolved or
 *                                   id doesn't exist).
 */
async function resolveAlert({ id, resolvedBy, trx } = {}) {
  if (!id) {
    throw new Error('resolveAlert: id is required');
  }

  async function doWrite(t) {
    const rows = await t('dispatch_alerts')
      .where({ id })
      .whereNull('resolved_at')
      .update({
        resolved_at: t.fn.now(),
        resolved_by: resolvedBy || null,
      })
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);
    return rows[0] || null;
  }

  if (trx) {
    const row = await doWrite(trx);
    if (!row) return null;
    if (trx.executionPromise) {
      trx.executionPromise.then(() => emitResolved(row)).catch(() => {
        // Outer rollback. Suppress emit so cards don't disappear from
        // dispatcher screens on a write that didn't actually commit.
      });
    } else {
      logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting inline (test harness?)');
      emitResolved(row);
    }
    return row;
  }

  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrite(innerTrx);
  });
  if (!captured) return null;
  emitResolved(captured);
  return captured;
}

// Resolved broadcast payload is intentionally narrow: just the id and
// the audit fields. Cards have already been hydrated with full data
// on the open broadcast — receivers only need to know "drop this id."
function emitResolved(row) {
  const io = getIo();
  if (!io) {
    logger.warn('[dispatch-alerts] io not initialized; skipping resolve broadcast');
    return;
  }
  io.to(ROOM).emit(EVENT_RESOLVED, {
    id: row.id,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
  });
}

module.exports = {
  createAlert,
  resolveAlert,
  EVENT,
  EVENT_RESOLVED,
  ROOM,
  VALID_SEVERITIES,
};
